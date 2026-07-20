import { moveOldOpenItemsToHistory, pool } from "./db.js";
import { config } from "./config.js";
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

    const auditIds = await listCourtNoticeMessages(gmail, { lookbackDays: 365, maxMessages: 5000 });
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
    await backfillBlockedDocumentSummaries();
    await backfillDocumentAnalysis();
    const historyMove = await moveOldOpenItemsToHistory();

    await pool.query("update mailboxes set last_sync_at = now(), updated_at = now() where email = $1", [mailbox.email]);
    const historyNote = historyMove.totalMoved ? ` Moved ${historyMove.totalMoved} old item(s) to history.` : "";
    const summary = `Reviewed ${scanned} message(s), found ${notices} court notice(s), extracted ${deadlineCount} deadline(s), saved/read ${documentCount} document(s).${historyNote}`;
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
        or read_status = 'notice_read_pdf_blocked'
      )
    order by updated_at asc nulls first, created_at asc
    limit 1000
  `);

  let repaired = 0;
  for (const row of result.rows) {
    const doc = await refreshDocumentFromSource(row.id);
    if (doc?.content && !String(doc?.read_status || "").startsWith("download_error:") && doc?.read_status !== "notice_read_pdf_blocked") repaired += 1;
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

async function backfillBlockedDocumentSummaries() {
  const result = await pool.query(`
    select doc.id, doc.filename, doc.source_url, e.body_text
    from documents doc
    left join emails e on e.gmail_id = doc.gmail_id
    where (doc.read_status like 'download_error:%' or doc.read_status = 'notice_read_pdf_blocked')
      and (
        doc.document_summary is null
        or doc.document_summary like 'PACER did not release the PDF%'
        or doc.document_summary like 'The system found a document link%'
      )
    order by doc.created_at desc
    limit 150
  `);

  for (const row of result.rows) {
    const context = contextForBlockedLink(row.body_text, row.source_url, row.filename);
    const summary = summarizeLinkedDocumentNotice(context);
    if (!summary) continue;
    await pool.query(
      "update documents set document_type = 'PACER PDF upload needed', document_summary = $1, extracted_text = coalesce(extracted_text, $1), read_status = 'notice_read_pdf_blocked', updated_at = now() where id = $2",
      [summary, row.id]
    );
  }
}

export async function refreshDocumentFromSource(documentId) {
  const result = await pool.query(
    `select doc.id, doc.filename, doc.source_url, e.body_text
     from documents doc
     left join emails e on e.gmail_id = doc.gmail_id
     where doc.id = $1 and doc.source_type = 'ecf_link' and doc.source_url is not null`,
    [documentId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const downloaded = await downloadLinkedDocument({
    url: row.source_url,
    filename: row.filename || "ECF document.pdf"
  });
  const extracted = await readDocumentText(downloaded);
  const fallbackSummary = summarizeLinkedDocumentNotice(contextForBlockedLink(row.body_text, row.source_url, row.filename));
  const status = linkedDocumentStatus(downloaded.status, extracted.status, fallbackSummary);
  const analysis = await analyzeSavedDocument(downloaded.filename, downloaded.mimeType, { ...extracted, status }, fallbackSummary);
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
         review_status = case when $6 = 'read' then 'open' else review_status end,
         archived_at = case when $6 = 'read' then null else archived_at end,
         updated_at = now()
     where id = $9
     returning filename, mime_type, content, read_status, document_type, document_summary`,
    [
      downloaded.filename,
      downloaded.mimeType,
      downloaded.size,
      downloaded.content,
      extracted.text || fallbackSummary,
      status,
      analysis.documentType,
      analysis.summary,
      row.id
    ]
  );
  return updated.rows[0] || null;
}

async function analyzeSavedDocument(filename, mimeType, extracted, fallbackSummary = null) {
  const readStatus = String(extracted.status || "");
  if (!extracted.text || readStatus === "notice_read_pdf_blocked" || readStatus.startsWith("download_error:") || readStatus.startsWith("read_error:") || readStatus === "stored_unreadable") {
    return {
      documentType: readStatus === "notice_read_pdf_blocked" || readStatus.startsWith("download_error:") ? "PACER PDF upload needed" : "Manual review required",
      summary: readStatus === "notice_read_pdf_blocked" || readStatus.startsWith("download_error:")
        ? (fallbackSummary || "PACER did not release the PDF to the server. Open the document manually from the PACER email or docket, download the PDF, and upload it under this case so the dashboard can read it.")
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

  for (const linkedDocument of extractDocumentLinks(email.bodyText)) {
    const existing = await pool.query("select 1 from documents where source_url = $1", [linkedDocument.url]);
    if (existing.rowCount) continue;

    const downloaded = await downloadLinkedDocument(linkedDocument);
    const extracted = await readDocumentText(downloaded);
    const fallbackSummary = summarizeLinkedDocumentNotice(linkedDocument.context);
    const status = linkedDocumentStatus(downloaded.status, extracted.status, fallbackSummary);
    const analysis = await analyzeSavedDocument(
      downloaded.filename,
      downloaded.mimeType,
      { ...extracted, status },
      fallbackSummary
    );
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
        extracted.text || fallbackSummary,
        status,
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
    const docNumber = context.match(/Document Number:\s*([A-Za-z0-9.-]+)/i)?.[1]?.trim();
    links.push({
      url: rawUrl,
      filename: sanitizeFilename(originalName || (docNumber ? `Document ${docNumber}.pdf` : "ECF document.pdf")),
      context
    });
  }
  return links;
}

function summarizeLinkedDocumentNotice(context) {
  const text = String(context || "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const docDescription = firstContextMatch(text, /Document description:\s*([^]*?)(?:Original filename:|Docket Text:|$)/i);
  const docketText = firstContextMatch(text, /Docket Text:\s*([^]*?)(?:The following document|Document description:|$)/i);
  const documentNumber = firstContextMatch(text, /Document Number:\s*([^\n\r]+)/i);
  const pieces = [];
  if (documentNumber) pieces.push(`Document number: ${documentNumber}.`);
  if (docDescription) pieces.push(`Description from court email: ${docDescription}.`);
  if (docketText) pieces.push(`Docket text from court email: ${docketText}.`);
  pieces.push("The court email was read, but PACER did not release the actual PDF to the server. Upload the PDF under the case if full document review is needed.");
  return pieces.join(" ").slice(0, 1200);
}

function linkedDocumentStatus(downloadStatus, readStatus, fallbackSummary) {
  if (downloadStatus === "downloaded") return readStatus;
  return fallbackSummary ? "notice_read_pdf_blocked" : downloadStatus;
}

function firstContextMatch(text, pattern) {
  const match = text.match(pattern);
  return match?.[1]?.replace(/\s+/g, " ").trim().slice(0, 700) || null;
}

function contextForBlockedLink(bodyText, sourceUrl, filename) {
  const body = String(bodyText || "").replaceAll("&amp;", "&");
  const needles = [sourceUrl, filename].filter(Boolean);
  let index = -1;
  for (const needle of needles) {
    index = body.indexOf(String(needle));
    if (index >= 0) break;
  }
  if (index < 0) return body.slice(0, 2500);
  return body.slice(Math.max(0, index - 1200), Math.min(body.length, index + 1800));
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

async function fetchDocumentUrl(url, fallbackFilename, depth, options = {}) {
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
      return await fetchDocumentUrl(nestedUrl, filename, depth + 1, options);
    }

    if (!options.authenticated) {
      const authenticated = await fetchDocumentUrlWithPacerAuth(url, filename);
      if (authenticated) return authenticated;
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

async function fetchDocumentUrlWithPacerAuth(url, fallbackFilename) {
  if (!config.pacerAuthCookie && (!config.pacerUsername || !config.pacerPassword)) {
    return null;
  }

  const jar = new CookieJar();
  if (config.pacerAuthCookie) {
    jar.addRawCookie(config.pacerAuthCookie);
  }

  if (config.pacerUsername && config.pacerPassword) {
    await loginToPacer(jar);
  }

  return await fetchAuthenticatedDocument(url, fallbackFilename, jar, 0);
}

async function loginToPacer(jar) {
  const loginPage = await fetchWithJar(config.pacerLoginUrl, {
    redirect: "follow",
    headers: {
      "Accept": "text/html,application/xhtml+xml"
    }
  }, jar);
  const html = await loginPage.text();
  const formValues = hiddenFormValues(html);
  const action = htmlFormAction(html, loginPage.url || config.pacerLoginUrl);
  formValues.set(fieldNameFor(html, config.pacerUsernameField, ["loginname", "username", "user"], "loginForm:loginName"), config.pacerUsername);
  formValues.set(fieldNameFor(html, config.pacerPasswordField, ["password", "pass"], "loginForm:password"), config.pacerPassword);

  const clientCodeField = fieldNameFor(html, config.pacerClientCodeField, ["clientcode", "client_code", "client"], null);
  if (clientCodeField && config.pacerClientCode) {
    formValues.set(clientCodeField, config.pacerClientCode);
  }

  await fetchWithJar(action, {
    method: "POST",
    redirect: "follow",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": loginPage.url || config.pacerLoginUrl
    },
    body: formValues.toString()
  }, jar);
}

async function fetchAuthenticatedDocument(url, fallbackFilename, jar, depth) {
  const response = await fetchWithJar(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 PACER Deadlines Dashboard",
      "Accept": "application/pdf,text/html,application/xhtml+xml,application/octet-stream;q=0.9,*/*;q=0.8"
    }
  }, jar);
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
      status: `download_error: PACER login failed with HTTP ${response.status}`
    };
  }

  if (depth < 3 && contentType.includes("html")) {
    const html = content.toString("utf8");
    const nestedUrl = findNestedDocumentUrl(html, response.url || url);
    if (nestedUrl && nestedUrl !== url) {
      return await fetchAuthenticatedDocument(nestedUrl, filename, jar, depth + 1);
    }
    const formTarget = htmlFormAction(html, response.url || url);
    if (shouldSubmitPacerForm(html, formTarget, response.url || url)) {
      const formValues = hiddenFormValues(html);
      const posted = await fetchWithJar(formTarget, {
        method: "POST",
        redirect: "follow",
        headers: {
          "Accept": "application/pdf,text/html,application/xhtml+xml,*/*;q=0.8",
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": response.url || url
        },
        body: formValues.toString()
      }, jar);
      return await responseToDownloaded(posted, filename, jar, depth + 1);
    }
  }

  if (contentType.includes("html")) {
    return {
      filename,
      mimeType: contentType,
      size: content.length,
      content,
      status: "download_error: PACER login did not release the document; manual PDF upload required"
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

async function responseToDownloaded(response, fallbackFilename, jar, depth) {
  const arrayBuffer = await response.arrayBuffer();
  const content = Buffer.from(arrayBuffer);
  const headerContentType = response.headers.get("content-type") || "application/octet-stream";
  const contentType = sniffMimeType(content, headerContentType);
  const disposition = response.headers.get("content-disposition") || "";
  const filename = sanitizeFilename(filenameFromDisposition(disposition) || fallbackFilename);

  if (depth < 3 && contentType.includes("html")) {
    const html = content.toString("utf8");
    const nestedUrl = findNestedDocumentUrl(html, response.url);
    if (nestedUrl) return await fetchAuthenticatedDocument(nestedUrl, filename, jar, depth + 1);
    const formTarget = htmlFormAction(html, response.url);
    if (shouldSubmitPacerForm(html, formTarget, response.url)) {
      const formValues = hiddenFormValues(html);
      const posted = await fetchWithJar(formTarget, {
        method: "POST",
        redirect: "follow",
        headers: {
          "Accept": "application/pdf,text/html,application/xhtml+xml,*/*;q=0.8",
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": response.url
        },
        body: formValues.toString()
      }, jar);
      return await responseToDownloaded(posted, filename, jar, depth + 1);
    }
  }

  return {
    filename,
    mimeType: contentType,
    size: content.length,
    content,
    status: contentType.includes("html")
      ? "download_error: PACER login did not release the document; manual PDF upload required"
      : "downloaded"
  };
}

async function fetchWithJar(url, options, jar) {
  const headers = new Headers(options.headers || {});
  const cookieHeader = jar.header();
  if (cookieHeader) headers.set("Cookie", cookieHeader);
  const response = await fetch(url, { ...options, headers });
  jar.setFromResponse(response);
  return response;
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  addRawCookie(cookieHeader) {
    for (const cookie of String(cookieHeader || "").split(";")) {
      const [name, ...valueParts] = cookie.trim().split("=");
      if (name && valueParts.length) this.cookies.set(name, valueParts.join("="));
    }
  }

  setFromResponse(response) {
    const getSetCookie = response.headers.getSetCookie?.() || [];
    const headers = getSetCookie.length ? getSetCookie : splitSetCookieHeader(response.headers.get("set-cookie"));
    for (const header of headers) {
      const first = String(header || "").split(";")[0];
      const [name, ...valueParts] = first.trim().split("=");
      if (name && valueParts.length) this.cookies.set(name, valueParts.join("="));
    }
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function splitSetCookieHeader(header) {
  if (!header) return [];
  return String(header).split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function htmlFormAction(html, baseUrl) {
  const form = String(html || "").match(/<form\b[^>]*>/i)?.[0];
  const action = form?.match(/\baction=["']?([^"'\s>]+)/i)?.[1];
  if (!action) return baseUrl;
  try {
    return new URL(decodeHtmlAttribute(action), baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

function hiddenFormValues(html) {
  const values = new URLSearchParams();
  const inputPattern = /<input\b[^>]*>/gi;
  for (const match of String(html || "").matchAll(inputPattern)) {
    const input = match[0];
    const name = input.match(/\bname=["']?([^"'\s>]+)/i)?.[1];
    if (!name) continue;
    const type = input.match(/\btype=["']?([^"'\s>]+)/i)?.[1] || "";
    const value = input.match(/\bvalue=["']?([^"'>]*)/i)?.[1] || "";
    if (/hidden|submit/i.test(type) || value) {
      values.set(decodeHtmlAttribute(name), decodeHtmlAttribute(value));
    }
  }
  const buttonPattern = /<button\b[^>]*>/gi;
  for (const match of String(html || "").matchAll(buttonPattern)) {
    const button = match[0];
    const name = button.match(/\bname=["']?([^"'\s>]+)/i)?.[1];
    if (!name) continue;
    const value = button.match(/\bvalue=["']?([^"'>]*)/i)?.[1] || button.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    values.set(decodeHtmlAttribute(name), decodeHtmlAttribute(value));
  }
  return values;
}

function shouldSubmitPacerForm(html, formTarget, currentUrl) {
  const target = String(formTarget || "");
  const current = String(currentUrl || "");
  const text = bufferToText(Buffer.from(String(html || ""), "utf8"), "text/html").toLowerCase();
  const looksLikeDocumentGate =
    /(?:view|download|retrieve|display|continue|accept|submit).{0,80}(?:document|pdf|notice|docket|charge|fee|cost)/i.test(text) ||
    /(?:document|pdf|notice|docket|charge|fee|cost).{0,80}(?:view|download|retrieve|display|continue|accept|submit)/i.test(text) ||
    /(?:receipt|client code|transaction|one free look|free electronic copy|pacer fee|billing)/i.test(text);
  const looksLikeCourtTarget = /(?:doc1|show_doc|view_doc|get_doc|pacer|login|cgi-bin|DktRpt|doc|pdf)/i.test(target || current);
  const mentionsFees = /(?:fee|charge|cost|billing)/i.test(text);
  if (mentionsFees && !config.pacerAutoAcceptFees) return false;
  return looksLikeDocumentGate || (target !== current && looksLikeCourtTarget);
}

function fieldNameFor(html, configuredName, candidates, fallback) {
  if (configuredName) return configuredName;
  const inputs = [...String(html || "").matchAll(/<input\b[^>]*>/gi)].map((match) => match[0]);
  for (const input of inputs) {
    const name = input.match(/\bname=["']?([^"'\s>]+)/i)?.[1];
    const id = input.match(/\bid=["']?([^"'\s>]+)/i)?.[1] || "";
    const haystack = `${name || ""} ${id}`.toLowerCase().replace(/[_:\-.]/g, "");
    if (name && candidates.some((candidate) => haystack.includes(candidate.replace(/[_:\-.]/g, "").toLowerCase()))) {
      return decodeHtmlAttribute(name);
    }
  }
  return fallback;
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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
