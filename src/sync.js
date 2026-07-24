import { getAppSetting, moveOldOpenItemsToHistory, pool, setAppSetting } from "./db.js";
import { config } from "./config.js";
import { analyzeDocument, extractNotice, looksLikeCourtNotice, parseDate } from "./extract.js";
import { gmailForRefreshToken, listCourtNoticeMessages, listIncomingMessages, readMessage } from "./gmail.js";

export async function syncMailbox(mailbox) {
  const syncLock = await acquireSyncLock();
  if (!syncLock.locked) {
    const summary = "Another mailbox sync is already running. Skipped this run to avoid database locks.";
    return { scanned: 0, notices: 0, deadlineCount: 0, documentCount: 0, summary };
  }

  let runId = null;

  try {
    const run = await pool.query(
      "insert into sync_runs (mailbox_email) values ($1) returning id, started_at",
      [mailbox.email]
    );
    runId = run.rows[0].id;

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
    await rereadSavedDocuments();
    await repairHtmlDocumentReads();
    documentCount += await repairHtmlLinkedDocuments();
    await backfillBlockedDocumentSummaries();
    await backfillDocumentAnalysis();
    const documentDeadlineCount = await backfillDeadlinesFromReadDocuments();
    deadlineCount += documentDeadlineCount;
    await normalizeExistingDeadlineDates();
    const historyMove = await moveOldOpenItemsToHistory();
    const documentStats = await pool.query(`
      select
        count(*) as total_documents,
        count(*) filter (where read_status = 'read' or read_status = 'notice_details_read_pdf_blocked') as analyzed_documents,
        count(*) filter (where read_status like 'download_error:%' or read_status in ('notice_read_pdf_blocked', 'notice_details_read_pdf_blocked')) as pending_documents
      from documents
    `);

    await pool.query("update mailboxes set last_sync_at = now(), updated_at = now() where email = $1", [mailbox.email]);
    const historyNote = historyMove.totalMoved ? ` Moved ${historyMove.totalMoved} old item(s) to history.` : "";
    const documentDeadlineNote = documentDeadlineCount ? ` Found ${documentDeadlineCount} additional deadline/date item(s) inside saved documents.` : "";
    const docStats = documentStats.rows[0] || {};
    const pendingNote = Number(docStats.pending_documents || 0)
      ? ` ${Number(docStats.pending_documents)} PACER PDF(s) are still blocked by the court/PACER response.`
      : "";
    const summary = `Reviewed ${scanned} message(s), found ${notices} court notice(s), extracted ${deadlineCount} deadline(s), updated ${documentCount} document(s). ${Number(docStats.analyzed_documents || 0)} of ${Number(docStats.total_documents || 0)} saved document(s) were fully readable.${documentDeadlineNote}${pendingNote}${historyNote}`;
    await pool.query(
      "update sync_runs set finished_at = now(), scanned_count = $1, notice_count = $2, deadline_count = $3, document_count = $4, summary = $5 where id = $6",
      [scanned, notices, deadlineCount, documentCount, summary, runId]
    );
    return { scanned, notices, deadlineCount, documentCount, summary };
  } catch (error) {
    if (runId) {
      await pool.query("update sync_runs set finished_at = now(), error = $1 where id = $2", [error.stack || error.message, runId]);
    }
    throw error;
  } finally {
    await syncLock.release();
  }
}

async function acquireSyncLock() {
  const client = await pool.connect();
  try {
    const result = await client.query("select pg_try_advisory_lock(72623391) as locked");
    const locked = Boolean(result.rows[0]?.locked);
    if (!locked) client.release();
    return {
      locked,
      release: async () => {
        if (!locked) return;
        try {
          await client.query("select pg_advisory_unlock(72623391)");
        } finally {
          client.release();
        }
      }
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function retryBlockedDocuments() {
  const repaired = await repairHtmlLinkedDocuments();
  await rereadSavedDocuments();
  await backfillBlockedDocumentSummaries();
  await backfillDocumentAnalysis();
  const deadlineCount = await backfillDeadlinesFromReadDocuments();
  await normalizeExistingDeadlineDates();
  return { repaired, deadlineCount };
}

export async function testPacerConnection(otpCode = "") {
  if (config.pacerAuthCookie && !(config.pacerUsername && config.pacerPassword)) {
    return {
      ok: true,
      summary: "PACER_AUTH_COOKIE is configured. The app can use that cookie for document requests, but username/password login was not tested."
    };
  }
  if (!config.pacerUsername || !config.pacerPassword) {
    return {
      ok: false,
      summary: "PACER username/password are missing in this Render service."
    };
  }

  try {
    const jar = new CookieJar();
    await loginToPacer(jar, { otpCode });
    await savePacerSession(jar);
    return {
      ok: true,
      summary: "PACER username/password login completed and the authenticated session was saved for document requests."
    };
  } catch (error) {
    return {
      ok: false,
      summary: error.message
    };
  }
}

export async function completePacerTwoFactor(otpCode) {
  if (!config.pacerUsername || !config.pacerPassword) {
    return { ok: false, summary: "PACER username/password are missing in Render." };
  }
  if (!String(otpCode || "").trim()) {
    return { ok: false, summary: "Enter the current PACER two-factor code." };
  }

  try {
    const jar = new CookieJar();
    await loginToPacer(jar, { otpCode });
    await savePacerSession(jar);
    const retried = await retryBlockedDocuments();
    const refreshedCount = Number(retried?.repaired || 0);
    return {
      ok: true,
      summary: `PACER 2FA completed. The app saved the PACER session and retried blocked PDFs. ${refreshedCount} document(s) were refreshed.`
    };
  } catch (error) {
    return {
      ok: false,
      summary: error.message
    };
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

async function rereadSavedDocuments() {
  const result = await pool.query(`
    select id, filename, mime_type, content, read_status
    from documents
    where content is not null
      and (
        read_status is null
        or read_status = 'pending'
        or read_status = 'stored_unreadable'
        or read_status like 'read_error:%'
      )
    order by updated_at asc nulls first, created_at asc
    limit 300
  `);

  for (const row of result.rows) {
    const extracted = await readDocumentText({
      filename: row.filename,
      mimeType: row.mime_type,
      content: row.content
    });
    const analysis = await analyzeSavedDocument(row.filename, row.mime_type, extracted);
    await pool.query(
      "update documents set extracted_text = coalesce($1, extracted_text), read_status = $2, document_type = $3, document_summary = $4, updated_at = now() where id = $5",
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
        or read_status = 'notice_details_read_pdf_blocked'
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

async function normalizeExistingDeadlineDates() {
  const result = await pool.query(`
    select id, date_text, source_quote
    from deadlines
    where status = 'open'
      and coalesce(date_text, source_quote) is not null
    order by created_at desc
    limit 2000
  `);

  for (const row of result.rows) {
    const text = row.date_text || row.source_quote || "";
    const parsed = parseDate(text) || parseRelativeDeadlineDate(row.date_text, row.source_quote);
    if (!parsed) continue;
    await pool.query(
      `update deadlines
       set due_at = $1,
           confidence = case when confidence = 'needs_review' then 'medium' else confidence end,
           label = regexp_replace(regexp_replace(label, '^Possible ', '', 'i'), '^Needs exact date:\\s*', '', 'i')
       where id = $2
         and (due_at is distinct from $1::timestamptz or confidence = 'needs_review' or label ~* '^(Possible |Needs exact date:)')`,
      [parsed, row.id]
    );
  }
}

function parseRelativeDeadlineDate(dateText, sourceQuote) {
  const text = `${dateText || ""}\n${sourceQuote || ""}`;
  const amountMatch = text.match(/\b(?:within|no later than|not later than|on or before|before)\s+(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|fourteen|twenty-one|twenty one|thirty)\s+(calendar\s+)?(business\s+)?days?\b/i);
  if (!amountMatch) return null;

  const days = numberWordToNumber(amountMatch[1]);
  if (!days) return null;
  const businessDays = Boolean(amountMatch[3]);
  const lower = text.toLowerCase();
  const triggerPatterns = lower.includes("entry")
    ? [/\bentered\s+on\s+([a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i]
    : [
        /\bserved\s+on\s+([a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i,
        /\bfiled\s+on\s+([a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i,
        /\bentered\s+on\s+([a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i,
        /\breceived\s+on\s+([a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i
      ];

  let triggerDate = null;
  for (const pattern of triggerPatterns) {
    triggerDate = parseDate(text.match(pattern)?.[1] || "");
    if (triggerDate) break;
  }
  if (!triggerDate) return null;

  const due = new Date(triggerDate);
  due.setUTCHours(21, 0, 0, 0);
  let remaining = days;
  while (remaining > 0) {
    due.setUTCDate(due.getUTCDate() + 1);
    if (!businessDays || (due.getUTCDay() !== 0 && due.getUTCDay() !== 6)) {
      remaining -= 1;
    }
  }
  return due.toISOString();
}

function numberWordToNumber(value) {
  const normalized = String(value || "").toLowerCase().replace("-", " ").trim();
  const words = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    fourteen: 14,
    "twenty one": 21,
    thirty: 30
  };
  return Number(normalized) || words[normalized] || null;
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
    where (doc.read_status like 'download_error:%' or doc.read_status in ('notice_read_pdf_blocked', 'notice_details_read_pdf_blocked'))
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
      "update documents set document_type = 'Court email details', document_summary = $1, extracted_text = coalesce(extracted_text, $1), read_status = 'notice_details_read_pdf_blocked', updated_at = now() where id = $2",
      [summary, row.id]
    );
  }
}

async function backfillDeadlinesFromReadDocuments() {
  const result = await pool.query(`
    select doc.id, doc.case_id, doc.gmail_id, doc.filename, doc.extracted_text, doc.document_summary,
           c.case_name, c.court, c.case_number, c.judge,
           e.subject, e.received_at
    from documents doc
    join cases c on c.id = doc.case_id
    left join emails e on e.gmail_id = doc.gmail_id
    where doc.extracted_text is not null
      and length(doc.extracted_text) >= 40
      and (
        doc.read_status = 'read'
        or doc.read_status = 'notice_details_read_pdf_blocked'
        or doc.read_status like 'read:%'
      )
    order by coalesce(doc.updated_at, doc.created_at) desc
    limit 1000
  `);

  let inserted = 0;
  for (const row of result.rows) {
    const extraction = await extractNotice({
      id: row.gmail_id || `document-${row.id}`,
      threadId: null,
      from: "Saved court document",
      to: "",
      subject: `${row.subject || "Saved document"} - ${row.filename}`,
      snippet: row.document_summary || "",
      receivedAt: row.received_at || new Date().toISOString(),
      bodyText: [
        `Case Name: ${row.case_name || ""}`,
        `Case Number: ${row.case_number || ""}`,
        `Court: ${row.court || ""}`,
        `Judge: ${row.judge || ""}`,
        `Document filename: ${row.filename || ""}`,
        row.document_summary ? `Document summary: ${row.document_summary}` : "",
        "",
        "--- FULL SAVED DOCUMENT TEXT ---",
        row.extracted_text
      ].join("\n")
    });
    inserted += await insertMissingDocumentDeadlines(row, extraction.deadlines || []);
  }
  return inserted;
}

async function insertMissingDocumentDeadlines(documentRow, deadlines) {
  let inserted = 0;
  for (const deadline of deadlines) {
    const label = deadline.label || `Possible deadline from ${documentRow.filename}`;
    const sourceQuote = deadline.sourceQuote || `Saved document: ${documentRow.filename}`;
    const exists = await pool.query(
      `select 1
       from deadlines
       where case_id = $1
         and status = 'open'
         and coalesce(gmail_id, '') = coalesce($2, '')
         and coalesce(due_at::text, '') = coalesce($3::timestamptz::text, '')
         and left(label, 220) = left($4, 220)
       limit 1`,
      [documentRow.case_id, documentRow.gmail_id || null, deadline.dueAt || null, label]
    );
    if (exists.rowCount) continue;
    await pool.query(
      `insert into deadlines (case_id, gmail_id, label, due_at, date_text, confidence, source_quote)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        documentRow.case_id,
        documentRow.gmail_id || null,
        label,
        deadline.dueAt || null,
        deadline.dateText || null,
        deadline.confidence || (deadline.dueAt ? "medium" : "needs_review"),
        sourceQuote
      ]
    );
    inserted += 1;
  }
  return inserted;
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
  const fallbackText = blockedPdfFallbackText(row.body_text, row.source_url, row.filename, downloaded.status);
  const status = blockedPdfReadableStatus(downloaded.status, extracted.status, fallbackText);
  const analysis = await analyzeSavedDocument(
    downloaded.filename,
    downloaded.mimeType,
    { text: status === "read" ? extracted.text : fallbackText, status },
    fallbackSummary
  );
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
         review_status = case when $6 in ('read', 'notice_details_read_pdf_blocked') then 'open' else review_status end,
         archived_at = case when $6 in ('read', 'notice_details_read_pdf_blocked') then null else archived_at end,
         updated_at = now()
     where id = $9
     returning filename, mime_type, content, read_status, document_type, document_summary`,
    [
      downloaded.filename,
      downloaded.mimeType,
      downloaded.size,
      downloaded.content,
      status === "read" ? extracted.text : fallbackText,
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
    const downloadReason = readStatus.startsWith("download_error:")
      ? readStatus.replace(/^download_error:\s*/i, "").trim()
      : "";
    return {
      documentType: readStatus === "notice_read_pdf_blocked" || readStatus.startsWith("download_error:") ? "PACER PDF pending" : "Manual review required",
      summary: readStatus === "notice_read_pdf_blocked" || readStatus.startsWith("download_error:")
        ? [downloadReason ? `PACER response: ${downloadReason}.` : "", fallbackSummary || "The dashboard will retry this link automatically during hourly sync and when Retry PACER Fetch is clicked."].filter(Boolean).join(" ")
        : "The document was saved, but the text could not be read clearly. Open it manually and verify any deadlines or hearing dates."
    };
  }
  return await analyzeDocument({
    filename,
    mimeType,
    text: extracted.text
  });
}

function blockedPdfFallbackText(bodyText, sourceUrl, filename, downloadStatus = "") {
  const context = contextForBlockedLink(bodyText, sourceUrl, filename);
  const summary = summarizeLinkedDocumentNotice(context);
  const reason = String(downloadStatus || "").startsWith("download_error:")
    ? String(downloadStatus).replace(/^download_error:\s*/i, "").trim()
    : "";
  return [
    "The PDF itself is not saved yet, but the court email contained these document details.",
    reason ? `PACER/PDF blocker: ${reason}.` : "",
    summary || "",
    "--- COURT EMAIL DOCUMENT DETAILS ---",
    cleanBlockedDocumentContext(context)
  ].filter(Boolean).join("\n").slice(0, 12000);
}

function blockedPdfReadableStatus(downloadStatus, extractedStatus, fallbackText) {
  if (downloadStatus === "downloaded") return extractedStatus;
  return fallbackText ? "notice_details_read_pdf_blocked" : linkedDocumentStatus(downloadStatus, extractedStatus, null);
}

function cleanBlockedDocumentContext(context) {
  return String(context || "")
    .replace(/https?:\/\/\S+/gi, "[ECF link]")
    .replace(/\*\*\*NOTE TO PUBLIC ACCESS USERS\*\*\*[^]*?(?=U\.S\.|United States|Notice of Electronic Filing|Case Name:|Document Number:|Docket Text:|$)/i, "")
    .replace(/Copy the URL address[^]*?(?=Docket Text:|Document description:|The following document|$)/gi, "")
    .replace(/Electronic document Stamp:\s*\[[^\]]+\]/gi, "")
    .replace(/Notice will be electronically mailed to:[^]*$/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
        deadline.confidence || (deadline.dueAt ? "medium" : "needs_review"),
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
    const fallbackText = blockedPdfFallbackText(linkedDocument.context, linkedDocument.url, linkedDocument.filename, downloaded.status);
    const status = blockedPdfReadableStatus(downloaded.status, extracted.status, fallbackText);
    const analysis = await analyzeSavedDocument(
      downloaded.filename,
      downloaded.mimeType,
      { text: status === "read" ? extracted.text : fallbackText, status },
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
        status === "read" ? extracted.text : fallbackText,
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
  const documentUrl = firstContextMatch(text, /Copy the URL address[^:]*:\s*(https?:\/\/\S+)/i);
  const pieces = [];
  if (documentNumber) pieces.push(`Document number: ${documentNumber}.`);
  if (docDescription) pieces.push(`Court description: ${cleanCourtSnippet(docDescription)}.`);
  if (docketText) pieces.push(`Docket text: ${cleanCourtSnippet(docketText)}.`);
  if (documentUrl) pieces.push("The ECF document link was found.");
  pieces.push("PACER returned a web page instead of the PDF. The dashboard will retry this link automatically during hourly sync.");
  return pieces.join(" ").slice(0, 900);
}

function cleanCourtSnippet(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[ECF link]")
    .replace(/Copy the URL address.*?(?:Docket Text:|Document description:|$)/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
}

function linkedDocumentStatus(downloadStatus, readStatus, fallbackSummary) {
  if (downloadStatus === "downloaded") return readStatus;
  return downloadStatus || (fallbackSummary ? "notice_read_pdf_blocked" : "download_error: PACER did not return a readable document");
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
  if (!options.authenticated && depth === 0) {
    const authenticated = await fetchDocumentUrlWithPacerAuth(url, fallbackFilename);
    if (authenticated) return authenticated;
  }

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
      status: pacerCredentialStatus("court returned an HTML page instead of the document")
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
  const storedCookie = await getPacerSessionCookie();
  if (!storedCookie && !config.pacerAuthCookie && (!config.pacerUsername || !config.pacerPassword)) {
    return null;
  }

  const jar = new CookieJar();
  if (storedCookie || config.pacerAuthCookie) {
    jar.addRawCookie(storedCookie || config.pacerAuthCookie);
  }

  let downloaded = await fetchAuthenticatedDocument(url, fallbackFilename, jar, 0);
  if (!pacerDownloadNeedsFreshLogin(downloaded.status) || !(config.pacerUsername && config.pacerPassword)) {
    return downloaded;
  }

  const freshJar = new CookieJar();
  await loginToPacer(freshJar);
  await savePacerSession(freshJar);
  downloaded = await fetchAuthenticatedDocument(url, fallbackFilename, freshJar, 0);
  return downloaded;
}

async function loginToPacer(jar, options = {}) {
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

  const loginResponse = await fetchWithJar(action, {
    method: "POST",
    redirect: "follow",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": loginPage.url || config.pacerLoginUrl
    },
    body: formValues.toString()
  }, jar);
  const loginHtml = await loginResponse.text();
  let text = bufferToText(Buffer.from(loginHtml, "utf8"), "text/html").toLowerCase();
  if (/(?:invalid|incorrect|failed|try again).{0,80}(?:login|password|username)|(?:login|password|username).{0,80}(?:invalid|incorrect|failed)/i.test(text)) {
    throw new Error("PACER login failed; check PACER_USERNAME and PACER_PASSWORD in Render");
  }
  if (pacerPageNeedsTwoFactor(loginHtml)) {
    if (!options.otpCode) throw new Error("PACER is asking for a two-factor code. Open PACER Setup in the dashboard and enter the current code.");
    const otpAction = htmlFormAction(loginHtml, loginResponse.url || action);
    const otpValues = hiddenFormValues(loginHtml);
    const otpField = otpFieldNameFor(loginHtml);
    if (!otpField) throw new Error("PACER asked for two-factor authentication, but the app could not find the code field. Set PACER_OTP_FIELD in Render if this keeps happening.");
    otpValues.set(otpField, String(options.otpCode).trim());
    const otpResponse = await fetchWithJar(otpAction, {
      method: "POST",
      redirect: "follow",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": loginResponse.url || action
      },
      body: otpValues.toString()
    }, jar);
    const otpHtml = await otpResponse.text();
    text = bufferToText(Buffer.from(otpHtml, "utf8"), "text/html").toLowerCase();
    if (pacerPageNeedsTwoFactor(otpHtml) || /(?:invalid|incorrect|expired).{0,80}(?:code|token|otp|verification)/i.test(text)) {
      throw new Error("PACER two-factor code was not accepted. Enter a fresh current code and try again.");
    }
  }
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
      addClientCodeIfNeeded(formValues, html);
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
    const reason = pacerHtmlBlockReason(content.toString("utf8"));
    return {
      filename,
      mimeType: contentType,
      size: content.length,
      content,
      status: reason
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
      addClientCodeIfNeeded(formValues, html);
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
      ? pacerHtmlBlockReason(content.toString("utf8"))
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

function addClientCodeIfNeeded(formValues, html) {
  if (!config.pacerClientCode) return;
  const clientCodeField = fieldNameFor(html, config.pacerClientCodeField, ["clientcode", "client_code", "client"], null);
  if (clientCodeField && !formValues.has(clientCodeField)) {
    formValues.set(clientCodeField, config.pacerClientCode);
  }
}

function pacerCredentialStatus(fallback) {
  if (!config.pacerAuthCookie && (!config.pacerUsername || !config.pacerPassword)) {
    return "download_error: PACER credentials are missing in this Render service";
  }
  return `download_error: ${fallback}`;
}

async function getPacerSessionCookie() {
  return await getAppSetting("pacer_auth_cookie");
}

async function savePacerSession(jar) {
  const cookieHeader = jar.header();
  if (cookieHeader) await setAppSetting("pacer_auth_cookie", cookieHeader);
}

function pacerDownloadNeedsFreshLogin(status) {
  return /login|authenticate|password|username|two-factor|2fa|verification code/i.test(String(status || ""));
}

function pacerPageNeedsTwoFactor(html) {
  const text = bufferToText(Buffer.from(String(html || ""), "utf8"), "text/html").toLowerCase();
  return /two[-\s]?factor|2fa|one[-\s]?time|verification code|authentication code|security code|multi[-\s]?factor|mfa/.test(text);
}

function pacerHtmlBlockReason(html) {
  const text = bufferToText(Buffer.from(String(html || ""), "utf8"), "text/html").toLowerCase();
  if (/two[-\s]?factor|2fa|one[-\s]?time|verification code|authentication code|security code|multi[-\s]?factor|mfa/.test(text)) {
    return "download_error: PACER requires two-factor authentication; open PACER Setup in the dashboard and enter the current code";
  }
  if (/(?:fee|charge|cost|billing|client code|receipt|transaction)/i.test(text) && !config.pacerAutoAcceptFees) {
    return "download_error: PACER requires fee acceptance; set PACER_AUTO_ACCEPT_FEES=true in Render to let the app retrieve billable PDFs";
  }
  if (/(?:login|sign in|password|username)/i.test(text)) {
    return "download_error: PACER login did not authenticate for this court document";
  }
  return "download_error: PACER login did not release the document yet";
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

function otpFieldNameFor(html) {
  if (config.pacerOtpField) return config.pacerOtpField;
  const inputs = [...String(html || "").matchAll(/<input\b[^>]*>/gi)].map((match) => match[0]);
  for (const input of inputs) {
    const name = input.match(/\bname=["']?([^"'\s>]+)/i)?.[1];
    if (!name) continue;
    const type = input.match(/\btype=["']?([^"'\s>]+)/i)?.[1] || "text";
    if (/hidden|submit|button|checkbox|radio/i.test(type)) continue;
    const id = input.match(/\bid=["']?([^"'\s>]+)/i)?.[1] || "";
    const label = input.match(/\b(?:aria-label|placeholder)=["']?([^"'>]+)/i)?.[1] || "";
    const haystack = `${name} ${id} ${label}`.toLowerCase().replace(/[_:\-.]/g, "");
    if (/clientcode/.test(haystack)) continue;
    if (/(otp|mfa|token|verification|authentication|security|onetime|passcode|authcode)/.test(haystack)) {
      return decodeHtmlAttribute(name);
    }
  }
  return null;
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
    const typeHint = sniffMimeType(content, mimeType);
    if (typeHint.includes("html")) {
      const text = bufferToText(content, "text/html");
      const blocker = htmlDocumentBlockerStatus(text);
      if (blocker) return { status: blocker, text: null };
      return { status: "read", text: truncateText(text) };
    }

    if (content.subarray(0, 5).toString("utf8") === "%PDF-") {
      const pdfParse = (await import("pdf-parse")).default;
      const parsed = await pdfParse(content);
      return readablePdfText(parsed.text);
    }

    if (mimeType.startsWith("text/") || /\.(txt|csv|xml)$/i.test(filename)) {
      return { status: "read", text: truncateText(bufferToText(content, mimeType)) };
    }

    if (mimeType.includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
      const pdfParse = (await import("pdf-parse")).default;
      const parsed = await pdfParse(content);
      return readablePdfText(parsed.text);
    }

    return { status: "stored_unreadable", text: null };
  } catch (error) {
    return { status: `read_error: ${error.message}`.slice(0, 200), text: null };
  }
}

function readablePdfText(text) {
  const cleaned = truncateText(text);
  if (cleaned.replace(/\s+/g, "").length < 40) {
    return {
      status: "read_error: PDF has little or no extractable text; OCR is needed",
      text: cleaned || null
    };
  }
  return { status: "read", text: cleaned };
}

function htmlDocumentBlockerStatus(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return null;
  if (/note to public access users|one free electronic copy|pacer access fees|30-page limit/.test(lower)) {
    return "notice_read_pdf_blocked";
  }
  if (/(?:login|sign in|password|username).{0,120}(?:pacer|court|ecf)|(?:pacer|court|ecf).{0,120}(?:login|sign in|password|username)/i.test(lower)) {
    return pacerCredentialStatus("PACER returned a login page instead of the PDF");
  }
  if (/(?:fee|charge|cost|billing|client code|receipt|transaction)/i.test(lower) && !config.pacerAutoAcceptFees) {
    return "download_error: PACER requires fee acceptance; set PACER_AUTO_ACCEPT_FEES=true in Render to let the app retrieve billable PDFs";
  }
  return null;
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
