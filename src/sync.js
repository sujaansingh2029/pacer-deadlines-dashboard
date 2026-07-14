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
        deadlineCount += await saveExtraction(email, extraction);
      }
    }

    await pool.query("update mailboxes set last_sync_at = now(), updated_at = now() where email = $1", [mailbox.email]);
    const summary = `Scanned ${scanned} new message(s), found ${notices} court notice(s), extracted ${deadlineCount} deadline(s).`;
    await pool.query(
      "update sync_runs set finished_at = now(), scanned_count = $1, notice_count = $2, deadline_count = $3, summary = $4 where id = $5",
      [scanned, notices, deadlineCount, summary, runId]
    );
    return { scanned, notices, deadlineCount, summary };
  } catch (error) {
    await pool.query("update sync_runs set finished_at = now(), error = $1 where id = $2", [error.stack || error.message, runId]);
    throw error;
  }
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

  return extraction.deadlines.length;
}
