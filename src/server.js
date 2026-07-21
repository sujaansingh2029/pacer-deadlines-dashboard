import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import multer from "multer";
import OpenAI from "openai";
import { assertRequiredConfig, config } from "./config.js";
import { initDb, moveOldOpenItemsToHistory, pool, upsertMailbox, getPrimaryMailbox } from "./db.js";
import { analyzeDocument, extractNotice } from "./extract.js";
import { authUrl, exchangeCode } from "./gmail.js";
import { readDocumentText, refreshDocumentFromSource, retryBlockedDocuments, syncMailbox } from "./sync.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser(config.sessionSecret));

app.get("/login", (req, res) => {
  res.send(layout("Dashboard Login", loginHtml(req.query.error)));
});

app.post("/login", (req, res) => {
  if (!config.dashboardPassword || req.body.password === config.dashboardPassword) {
    res.cookie("dashboard_session", sessionToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: config.appBaseUrl.startsWith("https://"),
      signed: true,
      maxAge: 1000 * 60 * 60 * 12
    });
    return res.redirect("/");
  }
  res.redirect("/login?error=1");
});

app.use((req, res, next) => {
  if (!config.dashboardPassword) return next();
  if (req.path === "/login" || req.path === "/api/sync") return next();
  if (req.signedCookies.dashboard_session === sessionToken()) return next();
  return res.redirect("/login");
});

app.get("/", async (_req, res) => {
  const missing = assertRequiredConfig();
  if (missing.length) return res.send(layout("Setup Required", setupHtml(missing)));

  const mailbox = await getPrimaryMailbox();
  if (!mailbox) return res.send(layout("Connect Gmail", connectHtml()));

  await moveOldOpenItemsToHistory();

  const [deadlines, dueToday, dueTomorrow, overdue, needsReview, events, cases, documents, notices, manualReview, blockedDocuments, historyItems, runs, stats] = await Promise.all([
    pool.query(`
      select d.*, c.case_name, c.court, c.case_number, e.subject, e.received_at
      from deadlines d
      join cases c on c.id = d.case_id
      left join emails e on e.gmail_id = d.gmail_id
      where d.status = 'open'
      order by d.due_at nulls last, d.created_at desc
      limit 50
    `),
    deadlineWindowQuery(0, 1),
    deadlineWindowQuery(1, 2),
    pool.query(`
      select d.*, c.case_name, c.court, c.case_number, e.subject, e.received_at
      from deadlines d
      join cases c on c.id = d.case_id
      left join emails e on e.gmail_id = d.gmail_id
      where d.status = 'open'
        and d.due_at is not null
        and d.due_at < (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York')
      order by d.due_at asc
      limit 25
    `),
    pool.query(`
      select d.*, c.case_name, c.court, c.case_number, e.subject, e.received_at
      from deadlines d
      join cases c on c.id = d.case_id
      left join emails e on e.gmail_id = d.gmail_id
      where d.status = 'open'
        and d.due_at is null
      order by d.created_at desc
      limit 25
    `),
    pool.query(`
      select de.*, c.case_name, c.court, c.case_number, e.subject, e.received_at
      from docket_events de
      join cases c on c.id = de.case_id
      join emails e on e.gmail_id = de.gmail_id
      where de.status = 'open'
      order by de.source_received_at desc nulls last, de.created_at desc
      limit 50
    `),
    pool.query(`
      select
        c.*,
        min(d.due_at) filter (where d.status = 'open' and d.due_at is not null) as next_deadline_at,
        count(distinct d.id) filter (where d.status = 'open') as open_deadline_count,
        count(distinct de.id) filter (where de.status = 'open') as open_event_count,
        max(coalesce(de.source_received_at, de.created_at)) as latest_activity_at,
        max(e.received_at) as latest_notice_received_at
      from cases c
      left join deadlines d on d.case_id = c.id
      left join docket_events de on de.case_id = c.id
      left join documents doc on doc.case_id = c.id
      left join emails e on e.gmail_id = de.gmail_id or e.gmail_id = d.gmail_id or e.gmail_id = doc.gmail_id
      group by c.id
      order by next_deadline_at nulls last, latest_activity_at desc nulls last
      limit 30
    `),
    pool.query(`
      select doc.id, doc.case_id, doc.filename, doc.mime_type, doc.size_bytes, doc.read_status,
             doc.source_url, doc.source_type, doc.extracted_text, doc.document_type, doc.document_summary,
             doc.created_at, e.subject, e.received_at
      from documents doc
      left join emails e on e.gmail_id = doc.gmail_id
      order by doc.created_at desc
      limit 200
    `),
    pool.query(`
      select e.gmail_id, e.from_header, e.subject, e.received_at, e.is_court_notice,
             count(distinct d.id) filter (where d.status = 'open') as open_deadlines,
             count(distinct de.id) filter (where de.status = 'open') as open_activity,
             count(distinct doc.id) as documents
      from emails e
      left join deadlines d on d.gmail_id = e.gmail_id
      left join docket_events de on de.gmail_id = e.gmail_id
      left join documents doc on doc.gmail_id = e.gmail_id
      where e.is_court_notice = true
      group by e.gmail_id
      order by e.received_at desc nulls last
      limit 75
    `),
    pool.query(`
      select *
      from (
        select 'Email' as item_type, e.gmail_id as item_id, e.subject as title, e.from_header as detail,
               e.received_at,
               'The system did not find a clear case, docket event, or deadline in this court notice. Open the email if this item still matters; otherwise check it off.' as reason
        from emails e
        left join deadlines d on d.gmail_id = e.gmail_id and d.status = 'open'
        left join docket_events de on de.gmail_id = e.gmail_id and de.status = 'open'
        left join cases c on c.id = de.case_id or c.id = d.case_id
        where e.is_court_notice = true
          and coalesce(e.review_status, 'open') = 'open'
          and not (
            lower(coalesce(e.from_header, '')) like '%accounts.google.com%'
            or lower(coalesce(e.subject, '')) like '%security alert%'
            or lower(coalesce(e.subject, '')) like '%new sign-in%'
          )
        group by e.gmail_id
        having count(distinct d.id) = 0
           and (
             count(distinct de.id) = 0
             or count(distinct c.id) filter (where c.case_name is not null or c.case_number is not null) = 0
           )
        union all
        select 'Document' as item_type, doc.id::text as item_id, doc.filename as title,
               coalesce(c.case_name, 'Case pending review') as detail,
               coalesce(e.received_at, doc.created_at) as received_at,
               coalesce(doc.document_summary, doc.read_status, 'Document needs manual review') as reason
        from documents doc
        left join cases c on c.id = doc.case_id
        left join emails e on e.gmail_id = doc.gmail_id
        where coalesce(doc.review_status, 'open') = 'open'
          and (
            doc.read_status like 'read_error:%'
            or doc.read_status = 'stored_unreadable'
            or (doc.document_type = 'Manual review required' and coalesce(doc.read_status, '') not like 'download_error:%')
          )
      ) review_items
      order by review_items.received_at desc nulls last
      limit 75
    `),
    pool.query(`
      select doc.id, doc.filename, doc.read_status, doc.source_url, doc.document_summary,
             coalesce(c.case_name, 'Case pending review') as case_name,
             coalesce(e.received_at, doc.created_at) as received_at
      from documents doc
      left join cases c on c.id = doc.case_id
      left join emails e on e.gmail_id = doc.gmail_id
      where coalesce(doc.review_status, 'open') = 'open'
        and (
          doc.read_status like 'download_error:%'
          or doc.read_status = 'notice_read_pdf_blocked'
        )
      order by coalesce(e.received_at, doc.created_at) desc
      limit 100
    `),
    loadHistoryItems(),
    pool.query("select * from sync_runs order by started_at desc limit 5"),
    pool.query(`
      select
        (select count(*) from deadlines where status = 'open') as open_deadlines,
        (select count(*) from deadlines where status = 'open' and due_at is not null and due_at <= now() + interval '7 days') as due_soon,
        (select count(*) from deadlines where status = 'open' and due_at is not null and due_at >= (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York') and due_at < ((date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York')) as due_today,
        (select count(*) from deadlines where status = 'open' and due_at is not null and due_at >= ((date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York') and due_at < ((date_trunc('day', now() at time zone 'America/New_York') + interval '2 days') at time zone 'America/New_York')) as due_tomorrow,
        (select count(*) from deadlines where status = 'open' and due_at is null) as needs_review,
        (select count(*) from docket_events where status = 'open') as open_events,
        (select count(*) from documents) as documents,
        (select count(*) from documents where read_status = 'read' or length(coalesce(extracted_text, '')) >= 40) as read_documents,
        (select count(*) from documents where read_status <> 'read') as unread_documents,
        ((select count(*) from deadlines where status <> 'open') + (select count(*) from docket_events where status <> 'open') + (select count(*) from emails where coalesce(review_status, 'open') <> 'open') + (select count(*) from documents where coalesce(review_status, 'open') <> 'open')) as history_items
    `)
  ]);

  res.send(layout("PACER Deadlines Dashboard", dashboardHtml({
    mailbox,
    deadlines: deadlines.rows,
    dueToday: dueToday.rows,
    dueTomorrow: dueTomorrow.rows,
    overdue: overdue.rows,
    needsReview: needsReview.rows,
    events: events.rows,
    cases: cases.rows,
    documents: documents.rows,
    notices: notices.rows,
    manualReview: manualReview.rows,
    blockedDocuments: blockedDocuments.rows,
    historyItems: historyItems.rows,
    runs: runs.rows,
    stats: stats.rows[0]
  })));
});

function loadHistoryItems() {
  return pool.query(`
      select *
      from (
      select 'Deadline' as item_type,
             d.id::text as item_id,
             d.status,
             d.archived_at,
             d.created_at,
             d.due_at as item_date,
             coalesce(e.received_at, d.created_at) as received_at,
             d.label as title,
             coalesce(c.case_name, 'Case pending review') as case_name,
             coalesce(c.case_number, '') as case_number,
             coalesce(d.source_quote, e.subject, '') as detail
      from deadlines d
      join cases c on c.id = d.case_id
      left join emails e on e.gmail_id = d.gmail_id
      where d.status <> 'open'
      union all
      select 'Activity' as item_type,
             de.id::text as item_id,
             de.status,
             de.archived_at,
             de.created_at,
             coalesce(de.filed_at, de.source_received_at, de.created_at) as item_date,
             coalesce(e.received_at, de.source_received_at, de.created_at) as received_at,
             coalesce(de.event_title, e.subject, 'Court activity') as title,
             coalesce(c.case_name, 'Case pending review') as case_name,
             coalesce(c.case_number, '') as case_number,
             coalesce(de.summary, e.snippet, '') as detail
      from docket_events de
      join cases c on c.id = de.case_id
      left join emails e on e.gmail_id = de.gmail_id
      where de.status <> 'open'
      union all
      select 'Email Review' as item_type,
             e.gmail_id as item_id,
             coalesce(e.review_status, 'history') as status,
             e.archived_at,
             e.processed_at as created_at,
             e.received_at as item_date,
             e.received_at,
             coalesce(e.subject, 'Court notice review') as title,
             'No case assigned' as case_name,
             '' as case_number,
             coalesce(e.from_header, '') as detail
      from emails e
      where e.is_court_notice = true
        and coalesce(e.review_status, 'open') <> 'open'
      union all
      select 'Document' as item_type,
             doc.id::text as item_id,
             coalesce(doc.review_status, 'history') as status,
             doc.archived_at,
             doc.created_at,
             coalesce(e.received_at, doc.created_at) as item_date,
             coalesce(e.received_at, doc.created_at) as received_at,
             doc.filename as title,
             coalesce(c.case_name, 'Case pending review') as case_name,
             coalesce(c.case_number, '') as case_number,
             coalesce(doc.document_summary, doc.read_status, '') as detail
      from documents doc
      left join cases c on c.id = doc.case_id
      left join emails e on e.gmail_id = doc.gmail_id
      where coalesce(doc.review_status, 'open') <> 'open'
    ) history
    order by coalesce(history.archived_at, history.item_date, history.created_at) desc
    limit 150
  `);
}

function deadlineWindowQuery(startDays, endDays) {
  return pool.query(
    `
      select d.*, c.case_name, c.court, c.case_number, e.subject, e.received_at
      from deadlines d
      join cases c on c.id = d.case_id
      left join emails e on e.gmail_id = d.gmail_id
      where d.status = 'open'
        and d.due_at is not null
        and d.due_at >= ((date_trunc('day', now() at time zone 'America/New_York') + ($1::int * interval '1 day')) at time zone 'America/New_York')
        and d.due_at < ((date_trunc('day', now() at time zone 'America/New_York') + ($2::int * interval '1 day')) at time zone 'America/New_York')
      order by d.due_at asc, d.created_at desc
      limit 25
    `,
    [startDays, endDays]
  );
}

app.get("/auth/google", (_req, res) => {
  res.redirect(authUrl());
});

app.get("/oauth2callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing OAuth code.");
  const { email, tokens } = await exchangeCode(code);
  if (!tokens.refresh_token) {
    return res.status(400).send("Google did not return a refresh token. Remove the app from Google Account access and connect again.");
  }
  await upsertMailbox(email, tokens.refresh_token);
  res.redirect("/");
});

app.post("/api/sync", async (req, res) => {
  const provided = req.get("x-cron-secret") || req.query.secret || req.body.secret;
  if (provided !== config.cronSecret) return res.status(401).json({ error: "Unauthorized" });
  const mailbox = await getPrimaryMailbox();
  if (!mailbox) return res.json({ ok: true, summary: "No Gmail mailbox is connected yet." });
  const result = await syncMailbox(mailbox);
  res.json({ ok: true, ...result });
});

app.post("/sync-now", async (_req, res) => {
  const mailbox = await getPrimaryMailbox();
  if (mailbox) await syncMailbox(mailbox);
  res.redirect("/");
});

app.post("/deadlines/:id/archive", async (req, res) => {
  await pool.query("update deadlines set status = 'archived', archived_at = now() where id = $1", [req.params.id]);
  res.redirect(req.get("referer") || "/");
});

app.post("/events/:id/archive", async (req, res) => {
  await pool.query("update docket_events set status = 'archived', archived_at = now() where id = $1", [req.params.id]);
  res.redirect(req.get("referer") || "/");
});

app.post("/emails/:id/archive", async (req, res) => {
  await pool.query("update emails set review_status = 'archived', archived_at = now() where gmail_id = $1", [req.params.id]);
  res.redirect(req.get("referer") || "/");
});

app.post("/documents/:id/archive", async (req, res) => {
  await pool.query("update documents set review_status = 'archived', archived_at = now(), updated_at = now() where id = $1", [req.params.id]);
  res.redirect(req.get("referer") || "/");
});

app.post("/documents/retry-blocked", async (req, res) => {
  await retryBlockedDocuments();
  res.redirect(req.get("referer") || "/");
});

app.post("/cases/:id/documents", upload.single("document"), async (req, res) => {
  const caseId = Number(req.params.id);
  const caseResult = await pool.query("select id, case_name, court, case_number, judge from cases where id = $1", [caseId]);
  if (!caseResult.rowCount) return res.status(404).send("Case not found.");
  if (!req.file?.buffer?.length) return res.status(400).send("Choose a PDF or document to upload.");

  const attachment = {
    filename: req.file.originalname || "Uploaded document.pdf",
    mimeType: req.file.mimetype || "application/octet-stream",
    size: req.file.size,
    content: req.file.buffer
  };
  const extracted = await readDocumentText(attachment);
  const analysis = extracted.text
    ? await analyzeDocument({ filename: attachment.filename, mimeType: attachment.mimeType, text: extracted.text })
    : {
        documentType: "Manual review required",
        summary: "The uploaded file was saved, but the text could not be read clearly. Review the document manually."
      };
  await pool.query(
    `insert into documents
      (case_id, filename, mime_type, size_bytes, source_type, content, extracted_text, read_status, document_type, document_summary)
     values ($1,$2,$3,$4,'manual_upload',$5,$6,$7,$8,$9)`,
    [
      caseId,
      attachment.filename,
      attachment.mimeType,
      attachment.size,
      attachment.content,
      extracted.text,
      extracted.status,
      analysis.documentType,
      analysis.summary
    ]
  );
  if (extracted.text) {
    await saveDeadlinesFromUploadedDocument(caseResult.rows[0], attachment.filename, extracted.text);
  }
  res.redirect(req.get("referer") || "/");
});

async function saveDeadlinesFromUploadedDocument(caseRow, filename, text) {
  const extraction = await extractNotice({
    id: `manual-upload-${caseRow.id}-${Date.now()}`,
    threadId: null,
    from: "Manual document upload",
    to: "",
    subject: `Uploaded document: ${filename}`,
    snippet: `Uploaded document for ${caseRow.case_name || caseRow.case_number || "case"}`,
    receivedAt: new Date().toISOString(),
    bodyText: [
      `Case Name: ${caseRow.case_name || ""}`,
      `Case Number: ${caseRow.case_number || ""}`,
      `Court: ${caseRow.court || ""}`,
      `Judge: ${caseRow.judge || ""}`,
      `Uploaded document filename: ${filename}`,
      "",
      text
    ].join("\n")
  });

  for (const deadline of extraction.deadlines || []) {
    const exists = await pool.query(
      `select 1 from deadlines
       where case_id = $1
         and status = 'open'
         and coalesce(due_at::text, '') = coalesce($2::timestamptz::text, '')
         and left(label, 240) = left($3, 240)
       limit 1`,
      [caseRow.id, deadline.dueAt || null, deadline.label || "Deadline needs review"]
    );
    if (exists.rowCount) continue;
    await pool.query(
      `insert into deadlines (case_id, gmail_id, label, due_at, date_text, confidence, source_quote)
       values ($1,null,$2,$3,$4,$5,$6)`,
      [
        caseRow.id,
        deadline.label || `Possible deadline from uploaded document: ${filename}`,
        deadline.dueAt || null,
        deadline.dateText || null,
        deadline.confidence || "needs_review",
        deadline.sourceQuote || `Uploaded document: ${filename}`
      ]
    );
  }
}

app.get("/documents/:id/download", async (req, res) => {
  const doc = await loadDocumentForServing(req.params.id);
  if (!doc) return res.status(404).send("Document not found.");
  if (!isServableDocument(doc)) return res.status(409).send(documentUnavailableHtml(doc, "download"));

  res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${String(doc.filename || "document").replaceAll('"', "")}"`);
  res.send(doc.content);
});

app.get("/documents/:id/view", async (req, res) => {
  const doc = await loadDocumentForServing(req.params.id);
  if (!doc) return res.status(404).send("Document not found.");
  if (!isServableDocument(doc)) return res.status(409).send(documentUnavailableHtml(doc, "view"));

  res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${String(doc.filename || "document").replaceAll('"', "")}"`);
  res.send(doc.content);
});

async function loadDocumentForServing(id) {
  const result = await pool.query(
    "select id, filename, mime_type, content, source_url, source_type, read_status, document_type, document_summary from documents where id = $1",
    [id]
  );
  let doc = result.rows[0];
  if (!doc) return null;

  const needsRepair =
    doc.source_type === "ecf_link" &&
    doc.source_url &&
    (!doc.content ||
      String(doc.mime_type || "").toLowerCase().includes("html") ||
      String(doc.read_status || "").startsWith("read_error:") ||
      String(doc.read_status || "").startsWith("download_error:"));

  if (needsRepair) {
    const repaired = await refreshDocumentFromSource(doc.id);
    if (repaired) doc = { ...doc, ...repaired };
  }

  return doc;
}

function isServableDocument(doc) {
  if (!doc.content) return false;
  const mimeType = String(doc.mime_type || "").toLowerCase();
  if (doc.source_type === "ecf_link" && mimeType.includes("html")) return false;
  return true;
}

function documentUnavailableHtml(doc, action) {
  const title = action === "download" ? "Document is not ready to download" : "Document is not ready to view";
  return layout(
    title,
    `<section class="panel narrow">
      <div class="panel-body">
        <h1>${title}</h1>
        <p>The dashboard read the court email, but PACER has not released the actual PDF to the server yet.</p>
        ${doc.document_summary ? `<p>${escapeHtml(doc.document_summary)}</p>` : ""}
        <p>The app will retry this document automatically during hourly sync. You can also retry it now after confirming the PACER username, password, client code, and fee approval settings in Render.</p>
        <form method="post" action="/documents/retry-blocked" class="inline-action-form"><button type="submit">Retry PACER Fetch</button></form>
        <a class="button secondary" href="/">Back to dashboard</a>
      </div>
    </section>`
  );
}

app.post("/api/chat", async (req, res) => {
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ error: "Ask a question first." });
  if (!config.openaiApiKey) return res.status(400).json({ error: "OPENAI_API_KEY is not configured." });

  try {
    const context = await loadAttorneyContext();
    const client = new OpenAI({ apiKey: config.openaiApiKey });
    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are an assistant for a law office dashboard. Answer only from the provided dashboard data. Be concise, practical, and organized. Always say that extracted court deadlines should be verified against the docket and applicable rules. Do not provide legal advice or invent missing facts."
        },
        {
          role: "user",
          content: JSON.stringify({
            today: new Date().toISOString(),
            timezone: "America/New_York",
            dashboardData: context,
            question
          })
        }
      ]
    });
    res.json({ answer: response.choices[0].message.content });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "The AI chat could not answer right now." });
  }
});

if (config.databaseUrl) await initDb();
app.listen(config.port, () => {
  console.log(`PACER dashboard listening on ${config.port}`);
});

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --ink:#111827; --muted:#667085; --line:#d9e0ea; --soft:#f6f8fb; --panel:#ffffff; --blue:#175cd3; --green:#067647; --amber:#b54708; --red:#b42318; }
    body { margin: 0; background: var(--soft); color: var(--ink); }
    header { background: #ffffff; border-bottom: 1px solid var(--line); padding: 18px 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; position: sticky; top: 0; z-index: 2; }
    main { max-width: 1360px; margin: 0 auto; padding: 22px; }
    * { overflow-wrap: anywhere; }
    h1 { font-size: 22px; margin: 0; letter-spacing: 0; }
    h2 { font-size: 15px; margin: 0; letter-spacing: 0; }
    .muted { color: var(--muted); font-size: 13px; }
    .eyebrow { color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
    .toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .due-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .due-card { background: #fff; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; min-height: 120px; }
    .due-card.overdue { border-color: #fda29b; }
    .due-card.today { border-color: #f79009; }
    .due-card.tomorrow { border-color: #84caff; }
    .due-card-head { padding: 12px 14px; border-bottom: 1px solid #edf0f5; display: flex; justify-content: space-between; gap: 10px; align-items: center; }
    .due-card-head strong { font-size: 16px; }
    .due-card-count { font-size: 22px; font-weight: 900; }
    .due-item { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 8px; padding: 10px 14px; border-bottom: 1px solid #edf0f5; }
    .due-item:last-child { border-bottom: 0; }
    .due-item-title { font-weight: 850; line-height: 1.25; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; min-height: 74px; }
    .metric strong { display: block; font-size: 26px; line-height: 1; margin-top: 8px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
    .stack { display: grid; gap: 16px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .priority-panel { border-color: #f79009; box-shadow: 0 0 0 1px rgba(247, 144, 9, .14); }
    .priority-panel .panel-head { background: #fffbeb; }
    .start-panel { margin-bottom: 16px; }
    .steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 12px; }
    .step-card { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 10px; align-items: start; border: 1px solid #e4e7ec; border-radius: 8px; padding: 11px; background: #fff; min-height: 76px; }
    .step-card.review { border-color: #fedf89; background: #fffbeb; }
    .step-card.good { border-color: #abefc6; background: #f6fef9; }
    .step-number { width: 26px; height: 26px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; background: #e7f0ff; color: #1849a9; font-weight: 900; }
    .panel-head { padding: 14px 16px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .panel-body { padding: 10px 14px; }
    .notice { border-left: 4px solid var(--amber); background: #fff8eb; padding: 12px 14px; border-radius: 6px; margin-bottom: 16px; color: #713b12; }
    .snapshot { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(260px, .6fr); gap: 14px; margin-bottom: 16px; }
    .summary-list { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
    .summary-list li { line-height: 1.35; }
    .simple-counts { display: grid; gap: 8px; }
    .simple-count { border: 1px solid #e4e7ec; border-radius: 8px; padding: 10px 12px; background: #fff; display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .simple-count strong { font-size: 20px; }
    details.panel summary { list-style: none; cursor: pointer; }
    details.panel summary::-webkit-details-marker { display: none; }
    .section-note { padding: 10px 14px; border-bottom: 1px solid #edf0f5; color: var(--muted); font-size: 13px; }
    .inline-action-form { padding: 10px 14px; border-bottom: 1px solid #edf0f5; margin: 0; }
    .inline-action-form button { padding: 8px 11px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 11px 10px; text-align: left; border-bottom: 1px solid #edf0f5; vertical-align: top; font-size: 13px; }
    th { background: #f8fafc; color: #475467; font-weight: 800; }
    tr:last-child td { border-bottom: 0; }
    a.button, button { background: var(--blue); color: white; border: 0; border-radius: 6px; padding: 9px 12px; text-decoration: none; font-weight: 800; cursor: pointer; font-size: 13px; }
    button.secondary { background: #ffffff; color: var(--blue); border: 1px solid #b8c7e6; }
    .tag { display: inline-block; background: #e7f0ff; color: #1849a9; border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 800; white-space: nowrap; }
    .tag.review { background:#fff1d6; color:#93370d; }
    .tag.high { background:#dcfae6; color:#05603a; }
    .case-title { font-weight: 800; font-size: 15px; line-height: 1.3; }
    .due { font-weight: 800; white-space: nowrap; }
    .empty { padding: 18px; color: var(--muted); }
    .check-form { margin: 0; }
    .check-button { width: 26px; height: 26px; border-radius: 6px; background: #fff; border: 1px solid #98a2b3; color: transparent; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
    .check-button:hover { background: #ecfdf3; border-color: var(--green); color: var(--green); }
    .check-button::after { content: "✓"; font-weight: 900; font-size: 16px; }
    .activity-card { display: grid; grid-template-columns: 34px minmax(0,1fr); gap: 8px; padding: 12px 0; border-bottom: 1px solid #edf0f5; }
    .activity-card:last-child { border-bottom: 0; }
    .activity-title { font-weight: 800; margin-bottom: 4px; }
    .small-list { display: grid; gap: 10px; }
    .case-card { border: 1px solid #e4e7ec; border-radius: 8px; padding: 12px; background: #fff; }
    details.case-card summary { cursor: pointer; list-style: none; }
    details.case-card summary::-webkit-details-marker { display: none; }
    .case-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .document-list { margin-top: 12px; border-top: 1px solid #edf0f5; padding-top: 10px; display: grid; gap: 8px; }
    .document-row { border: 1px solid #edf0f5; border-radius: 8px; padding: 9px; background: #fbfcfe; }
    .document-row-main { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: start; }
    .document-name { font-weight: 800; overflow-wrap: anywhere; }
    .document-preview { color: var(--muted); font-size: 12px; margin-top: 4px; line-height: 1.35; }
    .document-summary { font-size: 13px; margin-top: 5px; line-height: 1.35; }
    .document-link { color: var(--blue); font-size: 12px; font-weight: 800; text-decoration: none; white-space: nowrap; }
    .document-actions { display: flex; gap: 10px; align-items: center; }
    .document-viewer { margin-top: 10px; border-top: 1px solid #edf0f5; padding-top: 10px; }
    .document-viewer summary { cursor: pointer; color: var(--blue); font-weight: 900; font-size: 12px; list-style: none; }
    .document-viewer summary::-webkit-details-marker { display: none; }
    .pdf-frame { width: 100%; height: min(72vh, 760px); border: 1px solid #cbd5e1; border-radius: 8px; background: #ffffff; margin-top: 8px; }
    .document-unavailable { margin-top: 10px; border-top: 1px solid #edf0f5; padding-top: 8px; color: var(--muted); font-size: 12px; }
    .upload-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; border: 1px dashed #b8c7e6; border-radius: 8px; padding: 8px; background: #f8fbff; }
    .upload-form input { max-width: 280px; font-size: 12px; color: var(--muted); }
    .upload-form button { padding: 7px 10px; font-size: 12px; }
    .case-deadlines { margin-top: 12px; border-top: 1px solid #edf0f5; padding-top: 10px; display: grid; gap: 8px; }
    .case-deadline-row { display: grid; grid-template-columns: 34px 170px minmax(0,1fr); gap: 10px; align-items: start; border: 1px solid #edf0f5; border-radius: 8px; padding: 9px; background: #ffffff; }
    .deadline-cards { display: grid; gap: 8px; padding: 10px; }
    .deadline-card { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 12px; align-items: start; border: 1px solid #e4e7ec; border-radius: 8px; padding: 11px; background: #ffffff; }
    .deadline-when { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0; margin-bottom: 4px; }
    .deadline-main { min-width: 0; display: grid; gap: 6px; }
    .deadline-title { font-size: 15px; font-weight: 900; line-height: 1.3; overflow-wrap: anywhere; }
    .deadline-case { font-weight: 800; line-height: 1.3; overflow-wrap: anywhere; }
    .deadline-source { color: var(--muted); font-size: 13px; line-height: 1.38; overflow-wrap: anywhere; max-height: 4.2em; overflow: hidden; }
    .deadline-meta { color: var(--muted); font-size: 12px; line-height: 1.35; }
    .calendar-panel { margin-bottom: 10px; border-bottom: 1px solid #edf0f5; }
    .calendar-days { display: grid; gap: 10px; padding: 12px; }
    .calendar-day { border: 1px solid #e4e7ec; border-radius: 8px; background: #ffffff; overflow: hidden; }
    .calendar-day-head { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 10px 12px; background: #f8fafc; border-bottom: 1px solid #edf0f5; }
    .calendar-date { font-weight: 900; }
    .calendar-items { display: grid; gap: 0; }
    .calendar-item { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; padding: 10px 12px; border-bottom: 1px solid #edf0f5; }
    .calendar-item:last-child { border-bottom: 0; }
    .calendar-time { font-weight: 900; color: #344054; white-space: nowrap; }
    .calendar-title { font-weight: 900; line-height: 1.3; overflow-wrap: anywhere; }
    .calendar-case { color: var(--muted); font-size: 13px; line-height: 1.35; }
    .calendar-kind { display: inline-block; border-radius: 999px; padding: 2px 7px; font-size: 11px; font-weight: 900; background: #e7f0ff; color: #1849a9; margin-left: 6px; vertical-align: middle; }
    .calendar-kind.meeting { background: #dcfae6; color: #05603a; }
    .interactive-calendar { padding: 12px; border-bottom: 1px solid #edf0f5; display: grid; gap: 10px; }
    .calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
    .calendar-weekday { color: var(--muted); font-size: 11px; font-weight: 900; text-align: center; text-transform: uppercase; }
    .calendar-button { min-height: 78px; background: #fff; color: var(--ink); border: 1px solid #e4e7ec; border-radius: 8px; padding: 8px; text-align: left; display: grid; align-content: start; gap: 4px; font-weight: 800; }
    .calendar-button:hover, .calendar-button.active { border-color: var(--blue); box-shadow: 0 0 0 2px rgba(23, 92, 211, .12); }
    .calendar-button.today { background: #eff6ff; border-color: #84caff; }
    .calendar-button.has-items { background: #f6fef9; border-color: #abefc6; }
    .calendar-day-number { font-size: 13px; }
    .calendar-dot-row { display: flex; gap: 3px; flex-wrap: wrap; }
    .calendar-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--blue); }
    .calendar-dot.meeting { background: var(--green); }
    .calendar-selected { border: 1px solid #e4e7ec; border-radius: 8px; background: #fff; overflow: hidden; }
    .calendar-selected-head { padding: 10px 12px; background: #f8fafc; border-bottom: 1px solid #edf0f5; font-weight: 900; }
    .case-section-title { font-size: 12px; font-weight: 900; color: #475467; text-transform: uppercase; letter-spacing: .04em; margin: 2px 0; }
    .chat-box { display: grid; gap: 10px; }
    .chat-answer { min-height: 92px; border: 1px solid #e4e7ec; background: #f8fafc; border-radius: 8px; padding: 12px; white-space: pre-wrap; font-size: 13px; line-height: 1.45; }
    .chat-input { box-sizing: border-box; width: 100%; min-height: 82px; resize: vertical; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; font-size: 13px; }
    .quick-prompts { display: flex; flex-wrap: wrap; gap: 8px; }
    .prompt-chip { background: #ffffff; color: #344054; border: 1px solid #d0d5dd; border-radius: 999px; padding: 6px 9px; font-weight: 700; font-size: 12px; }
    .prompt-chip:hover { border-color: var(--blue); color: var(--blue); }
    input[type=password] { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; }
    @media (max-width: 980px) { .layout, .summary, .snapshot, .steps, .due-strip, .deadline-card, .case-deadline-row, .calendar-item { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } table { table-layout: auto; } .deadline-card { gap: 8px; } .calendar-grid { gap: 4px; } .calendar-button { min-height: 54px; padding: 6px; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="muted">Simple court notice review, deadlines, documents, and active cases</div>
    </div>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function setupHtml(missing) {
  return `<div class="notice">Missing required environment variables: ${missing.map(escapeHtml).join(", ")}.</div>`;
}

function connectHtml() {
  return `<div class="panel">
    <h2>Connect the PACER mailbox</h2>
    <p class="muted">Connect the Gmail inbox that receives PACER and CM/ECF notices. This app requests read-only Gmail access.</p>
    <a class="button" href="/auth/google">Connect Gmail</a>
  </div>`;
}

function loginHtml(hasError) {
  return `<div class="panel" style="max-width:420px">
    <div class="panel-head"><h2>Sign in</h2></div>
    <div class="panel-body">
    ${hasError ? `<div class="notice">Wrong password.</div>` : ""}
    <form method="post" action="/login">
      <p><input name="password" type="password" placeholder="Dashboard password"></p>
      <button type="submit">Open Dashboard</button>
    </form>
    </div>
  </div>`;
}

function dashboardHtml({ mailbox, deadlines, dueToday, dueTomorrow, overdue, needsReview, events, cases, documents, notices, manualReview, blockedDocuments, historyItems, runs, stats }) {
  const runSummary = runs[0]?.summary || runs[0]?.error || "No sync has run yet.";
  const calendarItems = buildCalendarItems(deadlines);
  const meetingItems = calendarItems.filter((item) => item.kind === "Meeting");
  return `
    <div class="toolbar" style="justify-content:space-between;margin-bottom:16px">
      <div>
        <div class="eyebrow">Mailbox</div>
        <div>${escapeHtml(mailbox.email)} <span class="muted">Last sync: ${formatDate(mailbox.last_sync_at) || "Not synced yet"}</span></div>
      </div>
      <form method="post" action="/sync-now"><button type="submit">Sync Now</button></form>
    </div>
    <div class="snapshot">
      <section class="panel">
        <div class="panel-head">
          <div><h2>Today's Summary</h2><div class="muted">${escapeHtml(runSummary)}</div></div>
        </div>
        <div class="panel-body">
          ${summaryList({ deadlines, needsReview, events, cases, stats })}
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>At A Glance</h2></div>
        <div class="panel-body simple-counts">
          ${simpleCount("Due today", stats.due_today)}
          ${simpleCount("Due tomorrow", stats.due_tomorrow)}
          ${simpleCount("Meetings", meetingItems.length)}
          ${simpleCount("Manual review", manualReview.length)}
          ${simpleCount("Blocked PDFs", blockedDocuments.length)}
          ${simpleCount("Due in 7 days", stats.due_soon)}
          ${simpleCount("Needs date", stats.needs_review)}
          ${simpleCount("Open deadlines", stats.open_deadlines)}
          ${simpleCount("Docs analyzed", stats.read_documents)}
          ${simpleCount("History", stats.history_items)}
        </div>
      </section>
    </div>
    ${dueNowPanel({ overdue, dueToday, dueTomorrow })}
    ${meetingPanel(meetingItems)}
    ${startHerePanel({ manualReview, needsReview, deadlines, blockedDocuments })}
    <div class="notice">The dashboard reads court emails every hour, saves anything it can read, and flags what needs a person. Always verify extracted deadlines against the docket and rules before relying on them.</div>
    <div class="layout">
      <div class="stack">
        ${manualReviewSection(manualReview)}
        <details class="panel">
          <summary class="panel-head">
            <div><h2>Needs Date</h2><div class="muted">Items where the system found court activity but could not parse an exact calendar date.</div></div>
            <span class="muted">Open</span>
          </summary>
          ${deadlineTable(needsReview, true)}
        </details>
        <section class="panel">
          <div class="panel-head">
            <div><h2>Deadline Calendar</h2><div class="muted">Date ordered, with the email received date shown for every item.</div></div>
          </div>
          ${calendarPanel(calendarItems)}
          ${deadlineTable(deadlines, false)}
        </section>
        <section class="panel">
          <div class="panel-head">
            <div><h2>Court Notices Reviewed</h2><div class="muted">Every PACER/court email the dashboard reviewed recently.</div></div>
          </div>
          ${noticeTable(notices)}
        </section>
        ${blockedDocumentSection(blockedDocuments)}
        <section class="panel">
          <div class="panel-head">
            <div><h2>Cases & Documents</h2><div class="muted">Open a case for due dates, notices, saved documents, and uploads.</div></div>
          </div>
          <div class="panel-body">${caseCards(cases, documents, deadlines)}</div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <div><h2>Ask AI</h2><div class="muted">Ask plain-English questions about upcoming work</div></div>
          </div>
          <div class="panel-body">${chatPanel()}</div>
        </section>
        <details class="panel">
          <summary class="panel-head"><h2>Recent Court Activity</h2><span class="muted">Open</span></summary>
          <div class="section-note">Check an item when it has been reviewed and handled.</div>
          ${activityList(events)}
        </details>
        <details class="panel" open>
          <summary class="panel-head"><div><h2>History</h2><div class="muted">Checked-off items and anything automatically moved here after 5 days.</div></div><span class="muted">Open</span></summary>
          ${historyTable(historyItems)}
        </details>
        <details class="panel">
          <summary class="panel-head"><h2>Sync History</h2><span class="muted">Open</span></summary>
          ${table(
            ["Started", "Scanned", "Notices", "Deadlines", "Docs", "Summary"],
            runs.map((r) => [
              formatDate(r.started_at),
              String(r.scanned_count),
              String(r.notice_count),
              String(r.deadline_count),
              String(r.document_count || 0),
              escapeHtml(r.error || r.summary || "")
            ])
          )}
        </details>
      </div>
    </div>
  `;
}

function dueNowPanel({ overdue, dueToday, dueTomorrow }) {
  return `<section class="due-strip">
    ${dueBucket("Overdue", overdue, "overdue", "Past due or missed unless already handled")}
    ${dueBucket("Due Today", dueToday, "today", "Handle before the end of today")}
    ${dueBucket("Due Tomorrow", dueTomorrow, "tomorrow", "Prepare now so tomorrow is calm")}
  </section>`;
}

function dueBucket(title, items, tone, emptyText) {
  return `<div class="due-card ${tone}">
    <div class="due-card-head">
      <div><strong>${escapeHtml(title)}</strong><div class="muted">${escapeHtml(emptyText)}</div></div>
      <div class="due-card-count">${items.length}</div>
    </div>
    ${items.length
      ? items.slice(0, 4).map((item) => `<div class="due-item">
          <div>${archiveButton(`/deadlines/${item.id}/archive`, "Archive deadline")}</div>
          <div>
            <div class="due-item-title">${escapeHtml(item.label)}</div>
            <div class="muted">${formatDate(item.due_at)} · ${escapeHtml(item.case_name || "Case pending review")}</div>
            ${item.source_quote ? `<div class="document-preview">${escapeHtml(item.source_quote.slice(0, 220))}</div>` : ""}
          </div>
        </div>`).join("")
      : `<div class="empty">Nothing here.</div>`}
  </div>`;
}

function meetingPanel(items) {
  const upcoming = items.slice(0, 6);
  return `<section class="panel calendar-panel">
    <div class="panel-head">
      <div><h2>Meetings & Hearings</h2><div class="muted">Court appearances, 341 meetings, conferences, hearings, trials, and status dates.</div></div>
      <strong>${items.length}</strong>
    </div>
    ${upcoming.length ? calendarDays(upcoming) : `<div class="empty">No upcoming meetings or hearings found yet.</div>`}
  </section>`;
}

function startHerePanel({ manualReview, needsReview, deadlines, blockedDocuments }) {
  const nextDeadline = deadlines.find((deadline) => deadline.due_at);
  const reviewText = manualReview.length
    ? `${manualReview.length} active item(s). Check off anything already handled.`
    : "Nothing urgent is waiting for manual review.";
  const pdfText = blockedDocuments.length
    ? `${blockedDocuments.length} PDF(s) are blocked by PACER/court response. Click Retry PACER Fetch after checking Render PACER settings.`
    : "All available PDFs are saved or there are no blocked PDFs.";
  return `<section class="panel start-panel">
    <div class="panel-head">
      <div><h2>Start Here</h2><div class="muted">Use this order every time you open the dashboard.</div></div>
    </div>
    <div class="steps">
      ${stepCard("1", "Fix urgent review items", reviewText, manualReview.length ? "review" : "good")}
      ${stepCard("2", "Fix missing dates", needsReview.length ? `${needsReview.length} item(s) need an exact date.` : "No missing dates right now.", needsReview.length ? "normal" : "good")}
      ${stepCard("3", "Look at the next deadline", nextDeadline ? `${formatDate(nextDeadline.due_at) || escapeHtml(nextDeadline.date_text || "Date needs review")} - ${escapeHtml(nextDeadline.case_name || "Case pending review")}` : "No open deadlines found yet.", nextDeadline ? "normal" : "review")}
      ${stepCard("4", "Let PACER fetch PDFs", pdfText, blockedDocuments.length ? "normal" : "good")}
    </div>
  </section>`;
}

function stepCard(number, title, body, tone) {
  return `<div class="step-card ${tone}">
    <div class="step-number">${number}</div>
    <div><strong>${escapeHtml(title)}</strong><div class="muted">${body}</div></div>
  </div>`;
}

function manualReviewSection(items) {
  if (!items.length) return "";
  return `<section class="panel priority-panel">
    <div class="panel-head">
      <div><h2>Manual Review Required</h2><div class="muted">These items could not be safely understood by the system. Review them before relying on the dashboard.</div></div>
    </div>
    ${table(
      ["Done", "Received", "Type", "Item", "Reason"],
      items.map((item) => [
        item.item_type === "Email"
          ? archiveButton(`/emails/${item.item_id}/archive`, "Move email review to history")
          : "",
        `<span class="due">${formatDate(item.received_at) || "Review date pending"}</span>`,
        `<span class="tag review">${escapeHtml(item.item_type)}</span>`,
        `<strong>${escapeHtml(item.title || "Review item")}</strong><br><span class="muted">${escapeHtml(item.detail || "")}</span>`,
        escapeHtml(item.reason || "Review this item manually.")
      ])
    )}
  </section>`;
}

function blockedDocumentSection(documents) {
  if (!documents.length) return "";
  return `<details class="panel">
    <summary class="panel-head">
      <div><h2>PACER PDF Fetch Issues</h2><div class="muted">${documents.length} court document(s) did not return a readable PDF yet.</div></div>
      <span class="muted">Open</span>
    </summary>
    <div class="section-note">${pacerStatusText()} The agent retries these links during each hourly sync. If the reason mentions fees, set PACER_AUTO_ACCEPT_FEES=true in both Render services if you approve PACER charges.</div>
    <form method="post" action="/documents/retry-blocked" class="inline-action-form">
      <button type="submit">Retry PACER Fetch</button>
    </form>
    ${table(
      ["Done", "Received", "Case", "Document", "Status"],
      documents.map((doc) => [
        archiveButton(`/documents/${doc.id}/archive`, "Move document request to history"),
        `<span class="due">${formatDate(doc.received_at) || "Review date pending"}</span>`,
        escapeHtml(doc.case_name || "Case pending review"),
        `<strong>${escapeHtml(doc.filename || "PACER document")}</strong>`,
        `${escapeHtml(doc.read_status || "download pending")}<br><span class="muted">${escapeHtml(doc.document_summary || "PACER has not released the PDF yet. The app will retry automatically on the next sync.")}</span>`
      ])
    )}
  </details>`;
}

function pacerStatusText() {
  const loginConfigured = Boolean(config.pacerUsername && config.pacerPassword);
  const cookieConfigured = Boolean(config.pacerAuthCookie);
  const authText = loginConfigured
    ? "PACER username/password are configured for this running service."
    : cookieConfigured
      ? "PACER auth cookie is configured for this running service."
      : "PACER login is NOT configured for this running service.";
  const feeText = config.pacerAutoAcceptFees
    ? "PACER fee acceptance is enabled."
    : "PACER fee acceptance is off.";
  return `${authText} ${feeText}`;
}

async function loadAttorneyContext() {
  const [deadlines, dueToday, dueTomorrow, overdue, cases, events] = await Promise.all([
    pool.query(`
      select d.id, d.label, d.due_at, d.date_text, d.confidence, d.source_quote,
             c.case_name, c.court, c.case_number, c.judge, e.subject, e.received_at
      from deadlines d
      join cases c on c.id = d.case_id
      left join emails e on e.gmail_id = d.gmail_id
      where d.status = 'open'
      order by d.due_at nulls last, d.created_at desc
      limit 75
    `),
    deadlineWindowQuery(0, 1),
    deadlineWindowQuery(1, 2),
    pool.query(`
      select d.id, d.label, d.due_at, d.date_text, d.confidence, d.source_quote,
             c.case_name, c.court, c.case_number, c.judge, e.subject, e.received_at
      from deadlines d
      join cases c on c.id = d.case_id
      left join emails e on e.gmail_id = d.gmail_id
      where d.status = 'open'
        and d.due_at is not null
        and d.due_at < (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York')
      order by d.due_at asc
      limit 25
    `),
    pool.query(`
      select c.id, c.case_name, c.court, c.case_number, c.judge,
             min(d.due_at) filter (where d.status = 'open' and d.due_at is not null) as next_deadline_at,
             count(distinct d.id) filter (where d.status = 'open') as open_deadline_count,
             count(distinct de.id) filter (where de.status = 'open') as open_event_count,
             max(coalesce(de.source_received_at, de.created_at)) as latest_activity_at
      from cases c
      left join deadlines d on d.case_id = c.id
      left join docket_events de on de.case_id = c.id
      group by c.id
      order by next_deadline_at nulls last, latest_activity_at desc nulls last
      limit 50
    `),
    pool.query(`
      select de.id, de.event_title, de.docket_number, de.filing_party, de.filed_at,
             de.source_received_at, de.summary, c.case_name, c.court, c.case_number, e.subject
      from docket_events de
      join cases c on c.id = de.case_id
      left join emails e on e.gmail_id = de.gmail_id
      where de.status = 'open'
      order by de.source_received_at desc nulls last, de.created_at desc
      limit 75
    `)
  ]);

  const documents = await pool.query(`
    select doc.id, doc.case_id, doc.filename, doc.mime_type, doc.size_bytes, doc.read_status,
           doc.source_url, doc.source_type, doc.document_type, doc.document_summary,
           left(doc.extracted_text, 2500) as extracted_text, c.case_name, c.court, c.case_number
    from documents doc
    join cases c on c.id = doc.case_id
    order by doc.created_at desc
    limit 100
  `);

  const calendarItems = buildCalendarItems(deadlines.rows);
  return {
    openDeadlines: deadlines.rows,
    overdue: overdue.rows,
    dueToday: dueToday.rows,
    dueTomorrow: dueTomorrow.rows,
    calendarItems,
    meetingsAndHearings: calendarItems.filter((item) => item.kind === "Meeting"),
    activeCases: cases.rows,
    recentCourtActivity: events.rows,
    documents: documents.rows
  };
}

function metric(label, value) {
  return `<div class="metric"><div class="eyebrow">${escapeHtml(label)}</div><strong>${Number(value || 0)}</strong></div>`;
}

function simpleCount(label, value) {
  return `<div class="simple-count"><span>${escapeHtml(label)}</span><strong>${Number(value || 0)}</strong></div>`;
}

function summaryList({ deadlines, needsReview, events, cases, stats }) {
  const nextDeadline = deadlines.find((d) => d.due_at);
  const nextMeeting = buildCalendarItems(deadlines).find((item) => item.kind === "Meeting");
  const nextCase = cases.find((c) => c.next_deadline_at) || cases[0];
  const latestEvent = events[0];
  const items = [];

  if (Number(stats.needs_review || 0) > 0) {
    items.push(`${Number(stats.needs_review)} item(s) still need an exact parsed date.`);
  } else {
    items.push("No extracted court items are missing dates.");
  }

  items.push(`${Number(stats.due_today || 0)} item(s) due today and ${Number(stats.due_tomorrow || 0)} item(s) due tomorrow.`);

  if (nextDeadline) {
    items.push(`Next deadline: ${formatDate(nextDeadline.due_at) || escapeHtml(nextDeadline.date_text || "date needs review")} for ${escapeHtml(nextDeadline.case_name || "Case pending review")} - ${escapeHtml(nextDeadline.label)}.`);
  } else {
    items.push("No high-confidence open deadlines have been extracted yet.");
  }

  if (nextMeeting) {
    items.push(`Next meeting/hearing: ${formatDate(nextMeeting.startsAt)} for ${escapeHtml(nextMeeting.caseName || "Case pending review")} - ${escapeHtml(nextMeeting.title)}.`);
  } else {
    items.push("No upcoming meetings or hearings have been extracted yet.");
  }

  if (nextCase) {
    items.push(`Next active case to watch: ${escapeHtml(nextCase.case_name || "Case pending review")} ${nextCase.next_deadline_at ? `on ${formatDate(nextCase.next_deadline_at)}` : "with no parsed deadline yet"}.`);
  }

  if (latestEvent) {
    items.push(`Latest court email received: ${formatDate(latestEvent.received_at || latestEvent.source_received_at) || "Review date pending"} - ${escapeHtml(latestEvent.event_title || latestEvent.subject || "Court notice")}.`);
  }

  if (Number(stats.documents || 0) > 0) {
    items.push(`${Number(stats.read_documents || 0)} of ${Number(stats.documents)} document(s) have readable text or notice detail grouped under their cases.`);
  }

  return `<ul class="summary-list">${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function chatPanel() {
  return `
    <div class="chat-box">
      <div class="quick-prompts">
        <button class="prompt-chip" type="button" data-prompt="What are the next 7 days of deadlines?">Next 7 days</button>
        <button class="prompt-chip" type="button" data-prompt="What meetings or hearings are coming up?">Meetings</button>
        <button class="prompt-chip" type="button" data-prompt="Which cases need attorney review right now?">Needs review</button>
        <button class="prompt-chip" type="button" data-prompt="Summarize upcoming case activity by case.">By case</button>
      </div>
      <textarea id="chat-question" class="chat-input" placeholder="Ask: What do I need to know for upcoming deadlines this week?"></textarea>
      <div class="toolbar">
        <button id="chat-submit" type="button">Ask</button>
        <span id="chat-status" class="muted"></span>
      </div>
      <div id="chat-answer" class="chat-answer muted">Ask a question about upcoming deadlines, active cases, filings, or what needs review.</div>
    </div>
    <script>
      const questionEl = document.getElementById("chat-question");
      const answerEl = document.getElementById("chat-answer");
      const statusEl = document.getElementById("chat-status");
      const submitEl = document.getElementById("chat-submit");
      async function askAi(question) {
        if (!question.trim()) return;
        statusEl.textContent = "Thinking...";
        submitEl.disabled = true;
        answerEl.classList.remove("muted");
        answerEl.textContent = "";
        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question })
          });
          const data = await response.json();
          answerEl.textContent = data.answer || data.error || "No answer returned.";
        } catch (_error) {
          answerEl.textContent = "The AI chat could not answer right now.";
        } finally {
          statusEl.textContent = "";
          submitEl.disabled = false;
        }
      }
      submitEl.addEventListener("click", () => askAi(questionEl.value));
      questionEl.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") askAi(questionEl.value);
      });
      document.querySelectorAll("[data-prompt]").forEach((button) => {
        button.addEventListener("click", () => {
          questionEl.value = button.getAttribute("data-prompt");
          askAi(questionEl.value);
        });
      });
    </script>
  `;
}

function noticeTable(notices) {
  if (!notices.length) return `<div class="empty">No court notices have been reviewed yet. Run Sync Now after connecting Gmail.</div>`;
  return table(
    ["Email Received", "Notice", "What Was Found", "Status"],
    notices.map((notice) => {
      const deadlineCount = Number(notice.open_deadlines || 0);
      const activityCount = Number(notice.open_activity || 0);
      const documentCount = Number(notice.documents || 0);
      const found = [
        `${deadlineCount} deadline${deadlineCount === 1 ? "" : "s"}`,
        `${activityCount} activity item${activityCount === 1 ? "" : "s"}`,
        `${documentCount} document${documentCount === 1 ? "" : "s"}`
      ].join("<br>");
      const status = deadlineCount || activityCount || documentCount
        ? `<span class="tag high">reviewed</span>`
        : `<span class="tag review">review needed</span>`;
      return [
        `<span class="due">${formatDate(notice.received_at) || "Review date pending"}</span>`,
        `<strong>${escapeHtml(notice.subject || "Court notice")}</strong><br><span class="muted">${escapeHtml(notice.from_header || "")}</span>`,
        found,
        status
      ];
    })
  );
}

function historyTable(items) {
  if (!items.length) return `<div class="empty">No history yet. Checked-off items and old unchecked items will appear here.</div>`;
  return table(
    ["Moved", "Type", "Item", "Case", "Status"],
    items.map((item) => [
      `<span class="due">${formatDate(item.archived_at || item.item_date || item.created_at) || "History date pending"}</span><br><span class="muted">Received: ${formatDate(item.received_at) || "pending"}</span>`,
      `<span class="tag">${escapeHtml(item.item_type)}</span>`,
      `<strong>${escapeHtml(item.title || "History item")}</strong>${item.detail ? `<br><span class="muted">${escapeHtml(item.detail).slice(0, 500)}</span>` : ""}`,
      `${escapeHtml(item.case_name || "Case pending review")}<br><span class="muted">${escapeHtml(item.case_number || "")}</span>`,
      historyStatusTag(item.status)
    ])
  );
}

function historyStatusTag(status) {
  if (status === "history_auto") return `<span class="tag review">moved after 5 days</span>`;
  if (status === "archived") return `<span class="tag high">checked off</span>`;
  return `<span class="tag">${escapeHtml(String(status || "history").replaceAll("_", " "))}</span>`;
}

function cleanDeadlineLabel(label) {
  return String(label || "Deadline needs review")
    .replace(/^Possible\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deadlineTable(deadlines, compact) {
  if (!deadlines.length) return `<div class="empty">No open items here.</div>`;
  return `<div class="deadline-cards">${deadlines.map((d) => {
    const reviewReason = compact ? (d.due_at ? "Date parsed" : "No exact due date parsed") : (d.subject || "");
    const label = cleanDeadlineLabel(d.label);
    return `<div class="deadline-card">
      <div>${archiveButton(`/deadlines/${d.id}/archive`, "Archive deadline")}</div>
      <div class="deadline-main">
        <div class="deadline-when">
          <span class="due">${formatDate(d.due_at) || escapeHtml(d.date_text || "Needs date")}</span>
          ${confidenceTag(d.confidence)}
          <span class="deadline-meta">Email received: ${formatDate(d.received_at) || "Review date pending"}</span>
        </div>
        <div class="deadline-title">${escapeHtml(label)}</div>
        <div class="deadline-case">${escapeHtml(d.case_name || "Case pending review")}</div>
        <div class="deadline-meta">${escapeHtml([d.court, d.case_number].filter(Boolean).join(" | "))}</div>
        ${d.source_quote ? `<div class="deadline-source">${escapeHtml(d.source_quote)}</div>` : ""}
        ${reviewReason ? `<div class="deadline-meta">${escapeHtml(reviewReason)}</div>` : ""}
      </div>
    </div>`;
  }).join("")}</div>`;
}

function calendarPanel(items) {
  const upcoming = items.slice(0, 24);
  return `<div class="calendar-panel">
    <div class="section-note">Upcoming calendar, grouped by day. Meetings and hearings are highlighted in green.</div>
    ${interactiveCalendar(items)}
    ${upcoming.length ? calendarDays(upcoming) : `<div class="empty">No dated calendar items found yet.</div>`}
  </div>`;
}

function interactiveCalendar(items) {
  const today = startOfEasternDay(new Date());
  const days = Array.from({ length: 35 }, (_, index) => new Date(today.getTime() + index * 24 * 60 * 60 * 1000));
  const itemsByDay = new Map();
  for (const item of items) {
    const key = calendarDateKey(item.startsAt);
    const list = itemsByDay.get(key) || [];
    list.push(item);
    itemsByDay.set(key, list);
  }
  const initialKey = itemsByDay.has(calendarDateKey(today)) ? calendarDateKey(today) : (items[0] ? calendarDateKey(items[0].startsAt) : calendarDateKey(today));
  const safeItems = items.map((item) => ({
    key: calendarDateKey(item.startsAt),
    time: calendarTimeLabel(item),
    title: item.title,
    kind: item.kind,
    caseName: item.caseName || "Case pending review",
    caseNumber: item.caseNumber || "",
    source: item.source || ""
  }));

  return `<div class="interactive-calendar">
    <div class="calendar-grid">
      ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<div class="calendar-weekday">${day}</div>`).join("")}
      ${days.map((day) => {
        const key = calendarDateKey(day);
        const dayItems = itemsByDay.get(key) || [];
        return `<button class="calendar-button ${key === calendarDateKey(today) ? "today" : ""} ${dayItems.length ? "has-items" : ""} ${key === initialKey ? "active" : ""}" type="button" data-calendar-day="${key}">
          <span class="calendar-day-number">${Number(key.slice(-2))}</span>
          <span class="calendar-dot-row">${dayItems.slice(0, 4).map((item) => `<span class="calendar-dot ${item.kind === "Meeting" ? "meeting" : ""}"></span>`).join("")}</span>
          ${dayItems.length ? `<span class="deadline-meta">${dayItems.length} item${dayItems.length === 1 ? "" : "s"}</span>` : ""}
        </button>`;
      }).join("")}
    </div>
    <div class="calendar-selected">
      <div class="calendar-selected-head" id="calendar-selected-title">${escapeHtml(calendarDateLabel(initialKey))}</div>
      <div id="calendar-selected-items">${calendarSelectedItems((itemsByDay.get(initialKey) || []))}</div>
    </div>
    <script>
      window.calendarItems = ${JSON.stringify(safeItems).replace(/</g, "\\u003c")};
      function renderCalendarDay(key) {
        document.querySelectorAll("[data-calendar-day]").forEach((button) => button.classList.toggle("active", button.dataset.calendarDay === key));
        const title = document.getElementById("calendar-selected-title");
        const target = document.getElementById("calendar-selected-items");
        const items = (window.calendarItems || []).filter((item) => item.key === key);
        title.textContent = new Date(key + "T12:00:00-04:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
        target.innerHTML = items.length ? items.map((item) => '<div class="calendar-item"><div class="calendar-time">' + escapeClient(item.time) + '</div><div><div class="calendar-title">' + escapeClient(item.title) + ' <span class="calendar-kind ' + (item.kind === "Meeting" ? "meeting" : "") + '">' + escapeClient(item.kind) + '</span></div><div class="calendar-case">' + escapeClient(item.caseName) + (item.caseNumber ? ' | ' + escapeClient(item.caseNumber) : '') + '</div>' + (item.source ? '<div class="calendar-case">' + escapeClient(item.source) + '</div>' : '') + '</div></div>').join("") : '<div class="empty">Nothing scheduled for this day.</div>';
      }
      function escapeClient(value) {
        return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
      }
      document.querySelectorAll("[data-calendar-day]").forEach((button) => button.addEventListener("click", () => renderCalendarDay(button.dataset.calendarDay)));
    </script>
  </div>`;
}

function calendarSelectedItems(items) {
  if (!items.length) return `<div class="empty">Nothing scheduled for this day.</div>`;
  return items.map((item) => `
    <div class="calendar-item">
      <div class="calendar-time">${escapeHtml(calendarTimeLabel(item))}</div>
      <div>
        <div class="calendar-title">${escapeHtml(item.title)} <span class="calendar-kind ${item.kind === "Meeting" ? "meeting" : ""}">${escapeHtml(item.kind)}</span></div>
        <div class="calendar-case">${escapeHtml(item.caseName || "Case pending review")}${item.caseNumber ? ` | ${escapeHtml(item.caseNumber)}` : ""}</div>
        ${item.source ? `<div class="calendar-case">${escapeHtml(item.source)}</div>` : ""}
      </div>
    </div>
  `).join("");
}

function calendarDays(items) {
  const groups = new Map();
  for (const item of items) {
    const key = calendarDateLabel(item.startsAt);
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }

  return `<div class="calendar-days">${[...groups.entries()].map(([dateLabel, dayItems]) => `
    <div class="calendar-day">
      <div class="calendar-day-head">
        <div class="calendar-date">${escapeHtml(dateLabel)}</div>
        <div class="muted">${dayItems.length} item${dayItems.length === 1 ? "" : "s"}</div>
      </div>
      <div class="calendar-items">${dayItems.map((item) => `
        <div class="calendar-item">
          <div class="calendar-time">${escapeHtml(calendarTimeLabel(item))}</div>
          <div>
            <div class="calendar-title">${escapeHtml(item.title)} <span class="calendar-kind ${item.kind === "Meeting" ? "meeting" : ""}">${escapeHtml(item.kind)}</span></div>
            <div class="calendar-case">${escapeHtml(item.caseName || "Case pending review")}${item.caseNumber ? ` | ${escapeHtml(item.caseNumber)}` : ""}</div>
            ${item.source ? `<div class="calendar-case">${escapeHtml(item.source)}</div>` : ""}
          </div>
        </div>
      `).join("")}</div>
    </div>
  `).join("")}</div>`;
}

function buildCalendarItems(deadlines) {
  const now = new Date();
  const end = new Date(now.getTime() + 120 * 24 * 60 * 60 * 1000);
  return (deadlines || [])
    .filter((deadline) => deadline.due_at)
    .map((deadline) => ({
      id: deadline.id,
      startsAt: deadline.due_at,
      dateText: deadline.date_text,
      title: deadline.label || "Court date",
      kind: isMeetingLike(deadline) ? "Meeting" : "Deadline",
      caseName: deadline.case_name,
      caseNumber: deadline.case_number,
      source: deadline.subject || deadline.source_quote || ""
    }))
    .filter((item) => {
      const starts = new Date(item.startsAt);
      return starts >= new Date(now.getTime() - 24 * 60 * 60 * 1000) && starts <= end;
    })
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

function isMeetingLike(item) {
  const text = `${item.label || ""}\n${item.source_quote || ""}\n${item.subject || ""}`.toLowerCase();
  return /\b(?:hearing|conference|meeting|341|appearance|appear|trial|status conference|calendar call|courtroom|zoom|telephone conference|video conference)\b/.test(text);
}

function activityList(events) {
  if (!events.length) return `<div class="empty">No open court activity.</div>`;
  return `<div class="panel-body">${events.map((e) => `
    <div class="activity-card">
      <div>${archiveButton(`/events/${e.id}/archive`, "Archive activity")}</div>
      <div>
        <div class="activity-title">${escapeHtml(e.event_title || e.subject || "Court notice")}</div>
        <div>${caseLabel(e)}</div>
        <div class="muted">Email received: ${formatDate(e.received_at || e.source_received_at) || "Review date pending"}${e.docket_number ? ` · Docket ${escapeHtml(e.docket_number)}` : ""}${e.filing_party ? ` · Filed by ${escapeHtml(e.filing_party)}` : ""}</div>
        ${e.summary ? `<div style="margin-top:6px">${escapeHtml(e.summary)}</div>` : ""}
      </div>
    </div>`).join("")}</div>`;
}

function caseCards(cases, documents, deadlines) {
  if (!cases.length) return `<div class="empty">No cases found yet. Run a sync after connecting Gmail.</div>`;
  const docsByCase = new Map();
  for (const doc of documents || []) {
    const list = docsByCase.get(doc.case_id) || [];
    list.push(doc);
    docsByCase.set(doc.case_id, list);
  }
  const deadlinesByCase = new Map();
  for (const deadline of deadlines || []) {
    const list = deadlinesByCase.get(deadline.case_id) || [];
    list.push(deadline);
    deadlinesByCase.set(deadline.case_id, list);
  }

  return `<div class="small-list">${cases.map((c) => `
    <details class="case-card">
      <summary>
        <div class="case-title">${escapeHtml(c.case_name || "Case pending review")}</div>
        <div class="muted">${escapeHtml([c.court, c.case_number].filter(Boolean).join(" | ") || "Court/case number pending")}</div>
        <div class="case-meta">
          ${c.next_deadline_at ? `<span class="tag">Next: ${formatDate(c.next_deadline_at)}</span>` : `<span class="tag review">No parsed deadline</span>`}
          <span class="tag">${Number(c.open_deadline_count || 0)} deadlines</span>
          <span class="tag">${Number(c.open_event_count || 0)} activity</span>
          <span class="tag">${(docsByCase.get(c.id) || []).length} docs</span>
        </div>
      </summary>
      ${c.judge ? `<div class="muted" style="margin-top:8px">Judge: ${escapeHtml(c.judge)}</div>` : ""}
      ${c.latest_notice_received_at ? `<div class="muted" style="margin-top:4px">Latest notice received: ${formatDate(c.latest_notice_received_at)}</div>` : ""}
      ${caseDeadlineList(deadlinesByCase.get(c.id) || [])}
      ${documentList(c.id, docsByCase.get(c.id) || [])}
    </details>
  `).join("")}</div>`;
}

function caseDeadlineList(deadlines) {
  if (!deadlines.length) {
    return `<div class="case-deadlines"><div class="case-section-title">Due Dates</div><div class="muted">No open due dates extracted for this case yet.</div></div>`;
  }

  return `<div class="case-deadlines">
    <div class="case-section-title">Due Dates</div>
    ${deadlines.map((deadline) => `
      <div class="case-deadline-row">
        <div>${archiveButton(`/deadlines/${deadline.id}/archive`, "Archive deadline")}</div>
        <div><span class="due">${formatDate(deadline.due_at) || escapeHtml(deadline.date_text || "Needs review")}</span><br>${confidenceTag(deadline.confidence)}<br><span class="muted">Email: ${formatDate(deadline.received_at) || "Review date pending"}</span></div>
        <div><strong>${escapeHtml(deadline.label)}</strong>${deadline.source_quote ? `<br><span class="muted">${escapeHtml(deadline.source_quote)}</span>` : ""}<br><span class="muted">${escapeHtml(deadline.subject || "")}</span></div>
      </div>
    `).join("")}
  </div>`;
}

function documentList(caseId, documents) {
  const uploadForm = `
    <form class="upload-form" method="post" action="/cases/${caseId}/documents" enctype="multipart/form-data">
      <input type="file" name="document" accept=".pdf,.txt,.html,.htm,.doc,.docx,application/pdf,text/plain,text/html">
      <button type="submit">Upload document</button>
    </form>`;
  if (!documents.length) {
    return `<div class="document-list"><div class="case-section-title">Documents</div><div class="muted">No saved documents for this case yet. The dashboard will save PDFs automatically when PACER releases them.</div>${uploadForm}</div>`;
  }
  return `<div class="document-list"><div class="case-section-title">Documents</div>${uploadForm}${documents.map((doc) => `
    <div class="document-row">
      <div class="document-row-main">
        <div>
          <div class="document-name">${escapeHtml(doc.filename)}</div>
          ${doc.document_type ? `<div><span class="tag">${escapeHtml(doc.document_type)}</span></div>` : ""}
          <div class="muted">${escapeHtml(sourceLabel(doc.source_type))} · ${escapeHtml(doc.mime_type || "file")} · ${formatBytes(doc.size_bytes)} · ${escapeHtml(doc.read_status || "pending")}${doc.received_at ? ` · Email received: ${formatDate(doc.received_at)}` : ""}</div>
          ${doc.document_summary ? `<div class="document-summary">${escapeHtml(doc.document_summary)}</div>` : ""}
          ${doc.extracted_text ? `<div class="document-preview">${escapeHtml(doc.extracted_text.slice(0, 320))}${doc.extracted_text.length > 320 ? "..." : ""}</div>` : ""}
        </div>
        <div class="document-actions">
          <a class="document-link" href="/documents/${doc.id}/view" target="_blank" rel="noopener">Open</a>
          <a class="document-link" href="/documents/${doc.id}/download">Download</a>
        </div>
      </div>
      ${documentInlineViewer(doc)}
    </div>
  `).join("")}</div>`;
}

function documentInlineViewer(doc) {
  if (isInlinePdf(doc)) {
    return `<details class="document-viewer">
      <summary>Preview PDF in dashboard</summary>
      <iframe class="pdf-frame" src="/documents/${doc.id}/view#toolbar=1&navpanes=0" title="${escapeHtml(doc.filename || "PDF document")}"></iframe>
    </details>`;
  }

  if (String(doc.read_status || "") === "read") {
    return `<div class="document-unavailable">This document was read by the system, but it is not a PDF preview. Use Open or Download if you need the original file.</div>`;
  }

  return `<div class="document-unavailable">PDF preview will appear here after the document is downloaded and saved as a PDF.</div>`;
}

function isInlinePdf(doc) {
  const mimeType = String(doc.mime_type || "").toLowerCase();
  const filename = String(doc.filename || "").toLowerCase();
  return String(doc.read_status || "") === "read" && (mimeType.includes("pdf") || filename.endsWith(".pdf"));
}

function sourceLabel(sourceType) {
  if (sourceType === "ecf_link") return "ECF link";
  if (sourceType === "manual_upload") return "uploaded";
  return "attachment";
}

function archiveButton(action, label) {
  return `<form class="check-form" method="post" action="${escapeHtml(action)}"><button class="check-button" type="submit" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></button></form>`;
}

function confidenceTag(confidence) {
  const value = confidence || "needs_review";
  const cls = value === "needs_review" ? " review" : value === "high" ? " high" : "";
  return `<span class="tag${cls}">${escapeHtml(value.replaceAll("_", " "))}</span>`;
}

function table(headers, rows) {
  if (!rows.length) return `<div class="panel muted">Nothing to show yet.</div>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell || ""}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function caseLabel(row) {
  return `${escapeHtml(row.case_name || "Case pending review")}<br><span class="muted">${escapeHtml([row.court, row.case_number].filter(Boolean).join(" | "))}</span>`;
}

function calendarDateLabel(value) {
  if (!value) return "Date pending";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T12:00:00-04:00`)
    : new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function calendarDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function startOfEasternDay(value) {
  const key = calendarDateKey(value);
  return new Date(`${key}T12:00:00-04:00`);
}

function calendarTimeLabel(item) {
  const value = item?.startsAt || item;
  if (!value) return "Time pending";
  if (item?.dateText && !/\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?/i.test(String(item.dateText))) {
    return "Date only";
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "size pending";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sessionToken() {
  return crypto.createHmac("sha256", config.sessionSecret).update(config.dashboardPassword || "open").digest("hex");
}
