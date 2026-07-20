import { pool } from "./db.js";
import { analyzeDocument, extractNotice, looksLikeCourtNotice } from "./extract.js";
import { gmailForRefreshToken, listCourtNoticeMessages, listIncomingMessages, readMessage } from "./gmail.js";

export async function syncMailbox(mailbox) {
  const run = await pool.query(
    "insert into sync_runs (mailbox_email) values ($1) returning id, started_at",
    [mailbox.email]
  );
  const runId = run.rows[0].id;

  try {
    const gmail = gmailForRefreshToken(mailbox.refresh_token);
    const afterUnix = mailbox.last_sync_at
      ? Math.floor(new Date(mailbox.last_sync_at).getTime() / 1000)
      : null;
    const ids = await listIncomingMessages(gmail, afterUnix);

    let scanned = 0;
    let notices = 0;
    let deadlineCount = 0;
    let documentCount = 0;
    const processedIds = new Set();

    for (const id of ids.reverse()) {
      const result = await processMessage(gmail, id, mailbox.email, { force: false });
      processedIds.add(id);
      scanned += result.scanned;
      notices += result.notices;
      deadlineCount += result.deadlineCount;
      documentCount += result.documentCount;
    }

    const auditIds = await listCourtNoticeMessages(gmail, { lookbackDays: 180, maxMessages: 1200 });
    for (const id of auditIds.reverse()) {
      if (processedIds.has(id)) continue;
      const result = await processMessage(gmail, id, mailbox.email, { force: true });
      scanned += result.scanned;
      notices += result.notices;
      deadlineCount += result.deadlineCount;
      documentCount += result.documentCount;
    }

    documentCount += await backfillMissingDocuments(gmail);
    await repairHtmlDocumentReads();
    documentCount += await repairHtmlLinkedDocuments();
    await backfillDocumentAnalysis();

    await pool.query("update mailboxes set last_sync_at = now(), updated_at = now() where email = $1", [mailbox.email]);
    const summary = `Reviewed ${scanned} message(s), found ${notices} court notice(s), extracted ${deadlineCount} deadline(s), saved/read ${documentCount} document(s).`;
    await pool.query(
      "update sync_runs set finished_at = now(), scanned_count = $1, notice_count = $2, deadline_count = $3, document_count = $4, summary = $5 where id = $6",
      [scanned, notices, deadlineCount, documentCount, summary, runId]
    );
    return { scanned, notices, deadlineCount, documentCount, summary };
  } catch (error) {
    await pool.query("update sync_runs set finished_at = now(), error = $1 where id = $2", [error.stack || error.message, runId]);
    throw error;
  }
}

async function processMessage(gmail, id, mailboxEmail, options = {}) {
  const exists = await pool.query("select 1 from emails where gmail_id = $1", [id]);
  if (exists.rowCount && !options.force) {
    return { scanned: 0, notices: 0, deadlineCount: 0, documentCount: 0 };
  }

  const email = await readMessage(gmail, id);
  const isNotice = looksLikeCourtNotice(email);
  await saveEmailRecord(email, mailboxEmail, isNotice);
  if (!isNotice) {
    return { scanned: 1, notices: 0, deadlineCount: 0, documentCount: 0 };
  }

  const initialExtraction = await extractNotice(email);
  let saved = await replaceExtraction(email, initialExtraction);
  let documentCount = await saveDocuments(saved.caseId, email);

  const documentText = await loadDocumentTextForEmail(email.id);
  if (documentText) {
    const extractionWithDocuments = await extractNotice({
      ...email,
      bodyText: `${email.bodyText}\n\n--- SAVED AND READ DOCUMENT TEXT ---\n${documentText}`
    });
    saved = await replaceExtraction(email, extractionWithDocuments);
    await pool.query(
      "update documents set case_id = $1, updated_at = now() where gmail_id = $2 and source_type <> 'manual_upload'",
      [saved.caseId, email.id]
    );
  }

  return {
    scanned: 1,
    notices: 1,
    deadlineCount: saved.deadlineCount,
    documentCount
  };
}

async function saveEmailRecord(email, mailboxEmail, isNotice) {
  await pool.query(
    `insert into emails
      (gmail_id, thread_id, mailbox_email, from_header, to_header, subject, snippet, received_at, body_text, is_court_notice)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (gmail_id) do update set
       thread_id = excluded.thread_id,
       mailbox_email = excluded.mailbox_email,
       from_header = excluded.from_header,
       to_header = excluded.to_header,
       subject = excluded.subject,
       snippet = excluded.snippet,
       received_at = excluded.received_at,
       body_text = excluded.body_text,
       is_court_notice = excluded.is_court_notice`,
    [
      email.id,
      email.threadId,
      mailboxEmail,
      email.from,
      email.to,
      email.subject,
      email.snippet,
      email.receivedAt,
      email.bodyText,
      isNotice
    ]
  );
}

async function replaceExtraction(email, extraction) {
  await pool.query("delete from deadlines where gmail_id = $1 and status = 'open'", [email.id]);
  await pool.query("delete from docket_events where gmail_id = $1 and status = 'open'", [email.id]);
  return await saveExtraction(email, extraction);
}

async function loadDocumentTextForEmail(gmailId) {
  const result = await pool.query(
    `select filename, extracted_text
     from documents
     where gmail_id = $1
       and extracted_text is not null
     order by created_at desc
     limit 10`,
    [gmailId]
  );
  return result.rows
    .map((row) => `Document: ${row.filename}\n${row.extracted_text}`)
    .join("\n\n")
    .slice(0, 60000);
}

async function repairHtmlDocumentReads() {
  const result = await pool.query(`
    select id, filename, mime_type, content
    from documents
    where content is not null
      and mime_type ilike 'text/html%'
      and read_status like 'read_error:%'
    limit 100
  `);

  for (const row of result.rows) {
    const extracted = await readDocumentText({
      filename: row.filename,
      mimeType: row.mime_type,
      content: row.content
    });
    const analysis = await analyzeSavedDocument(row.filename, row.mime_type, extracted);
    await pool.query(
      "update documents set extracted_text = $1, read_status = $2, document_type = $3, document_summary = $4, updated_at = now() where id = $5",
      [extracted.text, extracted.status, analysis.documentType, analysis.summary, row.id]
    );
  }
}

async function repairHtmlLinkedDocuments() {
  const result = await pool.query(`
    select id, filename, source_url
    from documents
    where source_type = 'ecf_link'
      and source_url is not null
      and (
        mime_type ilike 'text/html%'
        or read_status like 'read_error:%'
        or read_status like 'download_error:%'
      )
    limit 100
  `);

  let repaired = 0;
  for (const row of result.rows) {
    const doc = await refreshDocumentFromSource(row.id);
    if (doc?.content && !String(doc?.read_status || "").startsWith("download_error:")) repaired += 1;
  }
  return repaired;
}

async function backfillDocumentAnalysis() {
  const result = await pool.query(`
    select id, filename, mime_type, extracted_text, read_status
    from documents
    where document_summary is null
    order by created_at desc
    limit 150
  `);

  for (const row of result.rows) {
    const analysis = await analyzeSavedDocument(row.filename, row.mime_type, {
      status: row.read_status,
      text: row.extracted_text
    });
    await pool.query(
      "update documents set document_type = $1, document_summary = $2, updated_at = now() where id = $3",
      [analysis.documentType, analysis.summary, row.id]
    );
  }
}

export async function refreshDocumentFromSource(documentId) {
  const result = await pool.query(
    "select id, filename, source_url from documents where id = $1 and source_type = 'ecf_link' and source_url is not null",
    [documentId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const downloaded = await downloadLinkedDocument({
    url: row.source_url,
    filename: row.filename || "ECF document.pdf"
  });
  const extracted = await readDocumentText(downloaded);
  const analysis = await analyzeSavedDocument(downloaded.filename, downloaded.mimeType, extracted);
  const status = downloaded.status === "downloaded" ? extracted.status : downloaded.status;
  const updated = await pool.query(
    `update documents
     set filename = $1,
         mime_type = $2,
         size_bytes = $3,
         content = $4,
         extracted_text = $5,
         read_status = $6,
         document_type = $7,
         document_summary = $8,
         updated_at = now()
     where id = $9
     returning filename, mime_type, content, read_status, document_type, document_summary`,
    [
      downloaded.filename,
      downloaded.mimeType,
      downloaded.size,
      downloaded.content,
      extracted.text,
      status,
      analysis.documentType,
      analysis.summary,
      row.id
    ]
  );
  return updated.rows[0] || null;
}

async function analyzeSavedDocument(filename, mimeType, extracted) {
  const readStatus = String(extracted.status || "");
  if (!extracted.text || readStatus.startsWith("download_error:") || readStatus.startsWith("read_error:") || readStatus === "stored_unreadable") {
    return {
      documentType: "Manual review required",
      summary: readStatus.startsWith("download_error:")
        ? "The system found a document link, but the court did not return a readable file. Open the PACER notice manually and upload the PDF to this case."
        : "The document was saved, but the text could not be read clearly. Open it manually and verify any deadlines or hearing dates."
    };
  }
  return await analyzeDocument({
    filename,
    mimeType,
    text: extracted.text
  });
}

async function backfillMissingDocuments(gmail) {
  const result = await pool.query(`
    select distinct e.gmail_id, de.case_id, e.received_at
    from emails e
    join docket_events de on de.gmail_id = e.gmail_id
    where e.is_court_notice = true
    order by e.received_at desc nulls last
    limit 50
  `);

  let count = 0;
  for (const row of result.rows) {
    const email = await readMessage(gmail, row.gmail_id);
    count += await saveDocuments(row.case_id, email);
  }
  return count;
}

async function saveExtraction(email, extraction) {
  const caseKey = [
    extraction.court || "unknown-court",
    extraction.caseNumber || extraction.caseName || email.threadId
  ]
    .join("::")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 500);

  const caseResult = await pool.query(
    `insert into cases (case_key, case_name, court, case_number, judge, updated_at)
     values ($1,$2,$3,$4,$5,now())
     on conflict (case_key) do update set
       case_name = coalesce(excluded.case_name, cases.case_name),
       court = coalesce(excluded.court, cases.court),
       case_number = coalesce(excluded.case_number, cases.case_number),
       judge = coalesce(excluded.judge, cases.judge),
       updated_at = now()
     returning id`,
    [caseKey, extraction.caseName, extraction.court, extraction.caseNumber, extraction.judge]
  );
  const caseId = caseResult.rows[0].id;

  await pool.query(
    `insert into docket_events
      (case_id, gmail_id, event_title, docket_number, filing_party, filed_at, source_received_at, summary, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      caseId,
      email.id,
      extraction.eventTitle,
      extraction.docketNumber,
      extraction.filingParty,
      extraction.filedAt,
      email.receivedAt,
      extraction.summary,
      extraction
    ]
  );

  for (const deadline of extraction.deadlines) {
    await pool.query(
      `insert into deadlines (case_id, gmail_id, label, due_at, date_text, confidence, source_quote)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        caseId,
        email.id,
        deadline.label || "Deadline needs review",
        deadline.dueAt || null,
        deadline.dateText || null,
        deadline.confidence || "needs_review",
        deadline.sourceQuote || null
      ]
    );
  }

  return { caseId, deadlineCount: extraction.deadlines.length };
}

async function saveDocuments(caseId, email) {
  let count = 0;
  for (const attachment of email.attachments || []) {
    const extracted = await readDocumentText(attachment);
    const analysis = await analyzeSavedDocument(attachment.filename || "document", attachment.mimeType, extracted);
    const result = await pool.query(
      `insert into documents
        (case_id, gmail_id, filename, mime_type, size_bytes, source_attachment_id, source_type, content, extracted_text, read_status, document_type, document_summary)
       values ($1,$2,$3,$4,$5,$6,'attachment',$7,$8,$9,$10,$11)
       on conflict (gmail_id, filename, size_bytes) do nothing
       returning id`,
      [
        caseId,
        email.id,
        attachment.filename || "document",
        attachment.mimeType,
        attachment.size || attachment.content?.length || null,
        attachment.attachmentId,
        attachment.content,
        extracted.text,
        extracted.status,
        analysis.documentType,
        analysis.summary
      ]
    );
    if (result.rowCount) count += 1;
  }

  for (const linkedDocument of extractDocumentLinks(email.bodyText).slice(0, 10)) {
    const existing = await pool.query("select 1 from documents where source_url = $1", [linkedDocument.url]);
    if (existing.rowCount) continue;

    const downloaded = await downloadLinkedDocument(linkedDocument);
    const extracted = await readDocumentText(downloaded);
    const analysis = await analyzeSavedDocument(downloaded.filename, downloaded.mimeType, extracted);
    const result = await pool.query(
      `insert into documents
        (case_id, gmail_id, filename, mime_type, size_bytes, source_url, source_type, content, extracted_text, read_status, document_type, document_summary)
       values ($1,$2,$3,$4,$5,$6,'ecf_link',$7,$8,$9,$10,$11)
       on conflict do nothing
       returning id`,
      [
        caseId,
        email.id,
        downloaded.filename,
        downloaded.mimeType,
        downloaded.size,
        linkedDocument.url,
        downloaded.content,
        extracted.text,
        downloaded.status === "downloaded" ? extracted.status : downloaded.status,
        analysis.documentType,
        analysis.summary
      ]
    );
    if (result.rowCount) count += 1;
  }
  return count;
}

function extractDocumentLinks(text) {
  const links = [];
  const seen = new Set();
  const body = String(text || "").replaceAll("&amp;", "&");
  const urlPattern = /https?:\/\/[^\s<>"')]+/gi;
  for (const match of body.matchAll(urlPattern)) {
    const rawUrl = match[0].replace(/[.,;]+$/g, "");
    if (!/\/doc1\//i.test(rawUrl)) continue;
    if (seen.has(rawUrl)) continue;
    seen.add(rawUrl);

    const start = Math.max(0, match.index - 800);
    const end = Math.min(body.length, match.index + rawUrl.length + 1200);
    const context = body.slice(start, end);
    const originalName = context.match(/Original filename:\s*([^\n\r]+)/i)?.[1]?.trim();
    const docNumber = context.match(/Document Number:\s*([^\n\r]+)/i)?.[1]?.trim();
    links.push({
      url: rawUrl,
      filename: sanitizeFilename(originalName || (docNumber ? `Document ${docNumber}.pdf` : "ECF document.pdf"))
    });
  }
  return links;
}

async function downloadLinkedDocument(linkedDocument) {
  try {
    return await fetchDocumentUrl(linkedDocument.url, linkedDocument.filename, 0);
  } catch (error) {
    return {
      filename: linkedDocument.filename,
      mimeType: "application/octet-stream",
      size: null,
      content: null,
      status: `download_error: ${error.message}`.slice(0, 200)
    };
  }
}

async function fetchDocumentUrl(url, fallbackFilename, depth) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 PACER Deadlines Dashboard",
      "Accept": "application/pdf,text/html,application/xhtml+xml,application/octet-stream;q=0.9,*/*;q=0.8"
    }
  });
  const arrayBuffer = await response.arrayBuffer();
  const content = Buffer.from(arrayBuffer);
  const headerContentType = response.headers.get("content-type") || "application/octet-stream";
  const contentType = sniffMimeType(content, headerContentType);
  const disposition = response.headers.get("content-disposition") || "";
  const filename = sanitizeFilename(filenameFromDisposition(disposition) || fallbackFilename);

  if (!response.ok) {
    return {
      filename,
      mimeType: contentType,
      size: content.length,
      content,
      status: `download_error: HTTP ${response.status}`
    };
  }

  if (depth < 2 && contentType.includes("html")) {
    const nestedUrl = findNestedDocumentUrl(content.toString("utf8"), response.url || url);
    if (nestedUrl && nestedUrl !== url) {
      return await fetchDocumentUrl(nestedUrl, filename, depth + 1);
    }
    return {
      filename,
      mimeType: contentType,
      size: content.length,
      content,
      status: "download_error: court returned an HTML page instead of the document"
    };
  }

  return {
    filename,
    mimeType: contentType,
    size: content.length,
    content,
    status: "downloaded"
  };
}

function sniffMimeType(content, headerContentType) {
  const prefix = content.subarray(0, 300).toString("utf8").trimStart().toLowerCase();
  if (content.subarray(0, 5).toString("utf8") === "%PDF-") return "application/pdf";
  if (prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.includes("<body")) {
    return "text/html; charset=UTF-8";
  }
  return headerContentType || "application/octet-stream";
}

function findNestedDocumentUrl(html, baseUrl) {
  const candidates = [];
  const pattern = /\b(?:href|src|action)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const resolved = new URL(match[1].replaceAll("&amp;", "&"), baseUrl).toString();
      if (/\/doc1\//i.test(resolved) || /\.pdf(?:[?#]|$)/i.test(resolved) || /pdf_header/i.test(resolved)) {
        candidates.push(resolved);
      }
    } catch {
      // Ignore invalid links in court-generated HTML.
    }
  }
  return candidates.find((candidate) => candidate !== baseUrl) || null;
}

function filenameFromDisposition(disposition) {
  return disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
    ? decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/i)[1])
    : disposition.match(/filename="?([^";]+)"?/i)?.[1];
}

function sanitizeFilename(filename) {
  return String(filename || "document.pdf")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "document.pdf";
}

export async function readDocumentText(attachment) {
  const mimeType = attachment.mimeType || "";
  const filename = attachment.filename || "";
  const content = attachment.content || Buffer.alloc(0);

  try {
    if (content.subarray(0, 5).toString("utf8") === "%PDF-") {
      const pdfParse = (await import("pdf-parse")).default;
      const parsed = await pdfParse(content);
      return { status: "read", text: truncateText(parsed.text) };
    }

    if (mimeType.startsWith("text/") || mimeType.includes("html") || /\.(txt|csv|html?|xml)$/i.test(filename)) {
      return { status: "read", text: truncateText(bufferToText(content, mimeType)) };
    }

    if (mimeType.includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
      const pdfParse = (await import("pdf-parse")).default;
      const parsed = await pdfParse(content);
      return { status: "read", text: truncateText(parsed.text) };
    }

    return { status: "stored_unreadable", text: null };
  } catch (error) {
    return { status: `read_error: ${error.message}`.slice(0, 200), text: null };
  }
}

function bufferToText(buffer, mimeType) {
  const text = buffer.toString("utf8");
  if (mimeType.includes("html")) {
    return text
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]{2,}/g, " ");
  }
  return text;
}

function truncateText(text) {
  return String(text || "").replace(/\r/g, "").trim().slice(0, 100000);
}
