import { pool } from "./db.js";
import { extractNotice, looksLikeCourtNotice } from "./extract.js";
import { gmailForRefreshToken, listIncomingMessages, readMessage } from "./gmail.js";

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

    for (const id of ids.reverse()) {
      const exists = await pool.query("select 1 from emails where gmail_id = $1", [id]);
      if (exists.rowCount) continue;

      const email = await readMessage(gmail, id);
      scanned += 1;
      const isNotice = looksLikeCourtNotice(email);
      let extraction = null;

      if (isNotice) {
        extraction = await extractNotice(email);
        notices += 1;
      }

      await pool.query(
        `insert into emails
          (gmail_id, thread_id, mailbox_email, from_header, to_header, subject, snippet, received_at, body_text, is_court_notice)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (gmail_id) do nothing`,
        [
          email.id,
          email.threadId,
          mailbox.email,
          email.from,
          email.to,
          email.subject,
          email.snippet,
          email.receivedAt,
          email.bodyText,
          isNotice
        ]
      );

      if (isNotice && extraction) {
        const saved = await saveExtraction(email, extraction);
        deadlineCount += saved.deadlineCount;
        documentCount += await saveDocuments(saved.caseId, email);
      }
    }

    documentCount += await backfillMissingDocuments(gmail);

    await pool.query("update mailboxes set last_sync_at = now(), updated_at = now() where email = $1", [mailbox.email]);
    const summary = `Scanned ${scanned} new message(s), found ${notices} court notice(s), extracted ${deadlineCount} deadline(s), downloaded ${documentCount} document(s).`;
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

async function backfillMissingDocuments(gmail) {
  const result = await pool.query(`
    select e.gmail_id, de.case_id
    from emails e
    join docket_events de on de.gmail_id = e.gmail_id
    left join documents doc on doc.gmail_id = e.gmail_id
    where e.is_court_notice = true
      and doc.id is null
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
    const result = await pool.query(
      `insert into documents
        (case_id, gmail_id, filename, mime_type, size_bytes, source_attachment_id, content, extracted_text, read_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
        extracted.status
      ]
    );
    if (result.rowCount) count += 1;
  }
  return count;
}

async function readDocumentText(attachment) {
  const mimeType = attachment.mimeType || "";
  const filename = attachment.filename || "";
  const content = attachment.content || Buffer.alloc(0);

  try {
    if (mimeType.includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
      const pdfParse = (await import("pdf-parse")).default;
      const parsed = await pdfParse(content);
      return { status: "read", text: truncateText(parsed.text) };
    }

    if (mimeType.startsWith("text/") || /\.(txt|csv|html?|xml)$/i.test(filename)) {
      return { status: "read", text: truncateText(bufferToText(content, mimeType)) };
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
