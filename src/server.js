import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import OpenAI from "openai";
import { assertRequiredConfig, config } from "./config.js";
import { initDb, pool, upsertMailbox, getPrimaryMailbox } from "./db.js";
import { authUrl, exchangeCode } from "./gmail.js";
import { syncMailbox } from "./sync.js";

const app = express();
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

  const [deadlines, needsReview, events, cases, documents, runs, stats] = await Promise.all([
    pool.query(`
      select d.*, c.case_name, c.court, c.case_number, e.subject, e.received_at
      from deadlines d
      join cases c on c.id = d.case_id
      join emails e on e.gmail_id = d.gmail_id
      where d.status = 'open'
      order by d.due_at nulls last, d.created_at desc
      limit 50
    `),
    pool.query(`
      select d.*, c.case_name, c.court, c.case_number, e.subject, e.received_at
      from deadlines d
      join cases c on c.id = d.case_id
      join emails e on e.gmail_id = d.gmail_id
      where d.status = 'open'
        and (d.confidence = 'needs_review' or d.due_at is null)
      order by d.created_at desc
      limit 25
    `),
    pool.query(`
      select de.*, c.case_name, c.court, c.case_number, e.subject
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
        max(coalesce(de.source_received_at, de.created_at)) as latest_activity_at
      from cases c
      left join deadlines d on d.case_id = c.id
      left join docket_events de on de.case_id = c.id
      left join documents doc on doc.case_id = c.id
      group by c.id
      order by next_deadline_at nulls last, latest_activity_at desc nulls last
      limit 30
    `),
    pool.query(`
      select doc.id, doc.case_id, doc.filename, doc.mime_type, doc.size_bytes, doc.read_status,
             doc.source_url, doc.source_type, doc.extracted_text, doc.created_at, e.subject, e.received_at
      from documents doc
      join emails e on e.gmail_id = doc.gmail_id
      order by doc.created_at desc
      limit 200
    `),
    pool.query("select * from sync_runs order by started_at desc limit 5"),
    pool.query(`
      select
        (select count(*) from deadlines where status = 'open') as open_deadlines,
        (select count(*) from deadlines where status = 'open' and due_at is not null and due_at <= now() + interval '7 days') as due_soon,
        (select count(*) from deadlines where status = 'open' and (confidence = 'needs_review' or due_at is null)) as needs_review,
        (select count(*) from docket_events where status = 'open') as open_events,
        (select count(*) from documents) as documents
    `)
  ]);

  res.send(layout("PACER Deadlines Dashboard", dashboardHtml({
    mailbox,
    deadlines: deadlines.rows,
    needsReview: needsReview.rows,
    events: events.rows,
    cases: cases.rows,
    documents: documents.rows,
    runs: runs.rows,
    stats: stats.rows[0]
  })));
});

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

app.get("/documents/:id/download", async (req, res) => {
  const result = await pool.query("select filename, mime_type, content, source_url from documents where id = $1", [req.params.id]);
  const doc = result.rows[0];
  if (!doc) return res.status(404).send("Document not found.");
  if (!doc.content && doc.source_url) return res.redirect(doc.source_url);
  if (!doc.content) return res.status(404).send("Document not downloaded.");

  res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${String(doc.filename || "document").replaceAll('"', "")}"`);
  res.send(doc.content);
});

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
    h1 { font-size: 22px; margin: 0; letter-spacing: 0; }
    h2 { font-size: 15px; margin: 0; letter-spacing: 0; }
    .muted { color: var(--muted); font-size: 13px; }
    .eyebrow { color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
    .toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; min-height: 74px; }
    .metric strong { display: block; font-size: 26px; line-height: 1; margin-top: 8px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
    .stack { display: grid; gap: 16px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
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
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 11px 10px; text-align: left; border-bottom: 1px solid #edf0f5; vertical-align: top; font-size: 13px; }
    th { background: #f8fafc; color: #475467; font-weight: 800; }
    tr:last-child td { border-bottom: 0; }
    a.button, button { background: var(--blue); color: white; border: 0; border-radius: 6px; padding: 9px 12px; text-decoration: none; font-weight: 800; cursor: pointer; font-size: 13px; }
    button.secondary { background: #ffffff; color: var(--blue); border: 1px solid #b8c7e6; }
    .tag { display: inline-block; background: #e7f0ff; color: #1849a9; border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 800; white-space: nowrap; }
    .tag.review { background:#fff1d6; color:#93370d; }
    .tag.high { background:#dcfae6; color:#05603a; }
    .case-title { font-weight: 800; }
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
    .document-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: start; border: 1px solid #edf0f5; border-radius: 8px; padding: 9px; background: #fbfcfe; }
    .document-name { font-weight: 800; overflow-wrap: anywhere; }
    .document-preview { color: var(--muted); font-size: 12px; margin-top: 4px; line-height: 1.35; }
    .document-link { color: var(--blue); font-size: 12px; font-weight: 800; text-decoration: none; white-space: nowrap; }
    .case-deadlines { margin-top: 12px; border-top: 1px solid #edf0f5; padding-top: 10px; display: grid; gap: 8px; }
    .case-deadline-row { display: grid; grid-template-columns: 34px 170px minmax(0,1fr); gap: 10px; align-items: start; border: 1px solid #edf0f5; border-radius: 8px; padding: 9px; background: #ffffff; }
    .case-section-title { font-size: 12px; font-weight: 900; color: #475467; text-transform: uppercase; letter-spacing: .04em; margin: 2px 0; }
    .chat-box { display: grid; gap: 10px; }
    .chat-answer { min-height: 92px; border: 1px solid #e4e7ec; background: #f8fafc; border-radius: 8px; padding: 12px; white-space: pre-wrap; font-size: 13px; line-height: 1.45; }
    .chat-input { box-sizing: border-box; width: 100%; min-height: 82px; resize: vertical; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; font-size: 13px; }
    .quick-prompts { display: flex; flex-wrap: wrap; gap: 8px; }
    .prompt-chip { background: #ffffff; color: #344054; border: 1px solid #d0d5dd; border-radius: 999px; padding: 6px 9px; font-weight: 700; font-size: 12px; }
    .prompt-chip:hover { border-color: var(--blue); color: var(--blue); }
    input[type=password] { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; }
    @media (max-width: 980px) { .layout, .summary, .snapshot { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="muted">Court notice monitoring, active-case deadlines, and attorney review queue</div>
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

function dashboardHtml({ mailbox, deadlines, needsReview, events, cases, documents, runs, stats }) {
  const runSummary = runs[0]?.summary || runs[0]?.error || "No sync has run yet.";
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
          ${simpleCount("Due in 7 days", stats.due_soon)}
          ${simpleCount("Need review", stats.needs_review)}
          ${simpleCount("Open deadlines", stats.open_deadlines)}
        </div>
      </section>
    </div>
    <div class="notice">Deadlines are extracted from email notices and must be verified against the docket and applicable rules before anyone relies on them.</div>
    <div class="layout">
      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <div><h2>What Needs Attention</h2><div class="muted">Review these first, then check them off when handled</div></div>
          </div>
          ${deadlineTable(needsReview.length ? needsReview : deadlines.slice(0, 10), Boolean(needsReview.length))}
        </section>
        <section class="panel">
          <div class="panel-head">
            <div><h2>Upcoming Deadlines</h2><div class="muted">Simple date-ordered list</div></div>
          </div>
          ${deadlineTable(deadlines, false)}
        </section>
        <section class="panel">
          <div class="panel-head">
            <div><h2>Active Cases & Documents</h2><div class="muted">Open a case to see downloaded documents</div></div>
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

async function loadAttorneyContext() {
  const [deadlines, cases, events] = await Promise.all([
    pool.query(`
      select d.id, d.label, d.due_at, d.date_text, d.confidence, d.source_quote,
             c.case_name, c.court, c.case_number, c.judge, e.subject, e.received_at
      from deadlines d
      join cases c on c.id = d.case_id
      join emails e on e.gmail_id = d.gmail_id
      where d.status = 'open'
      order by d.due_at nulls last, d.created_at desc
      limit 75
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
      join emails e on e.gmail_id = de.gmail_id
      where de.status = 'open'
      order by de.source_received_at desc nulls last, de.created_at desc
      limit 75
    `)
  ]);

  const documents = await pool.query(`
    select doc.id, doc.case_id, doc.filename, doc.mime_type, doc.size_bytes, doc.read_status,
           doc.source_url, doc.source_type, left(doc.extracted_text, 2500) as extracted_text, c.case_name, c.court, c.case_number
    from documents doc
    join cases c on c.id = doc.case_id
    order by doc.created_at desc
    limit 100
  `);

  return {
    openDeadlines: deadlines.rows,
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
  const nextDeadline = deadlines.find((d) => d.due_at) || deadlines[0];
  const nextCase = cases.find((c) => c.next_deadline_at) || cases[0];
  const latestEvent = events[0];
  const items = [];

  if (Number(stats.needs_review || 0) > 0) {
    items.push(`${Number(stats.needs_review)} item(s) need attorney review because the date is uncertain or missing.`);
  } else {
    items.push("No extracted deadlines are currently flagged for attorney review.");
  }

  if (nextDeadline) {
    items.push(`Next deadline: ${formatDate(nextDeadline.due_at) || escapeHtml(nextDeadline.date_text || "date needs review")} for ${escapeHtml(nextDeadline.case_name || "Unknown case")} - ${escapeHtml(nextDeadline.label)}.`);
  } else {
    items.push("No open deadlines have been extracted yet.");
  }

  if (nextCase) {
    items.push(`Next active case to watch: ${escapeHtml(nextCase.case_name || "Unknown case")} ${nextCase.next_deadline_at ? `on ${formatDate(nextCase.next_deadline_at)}` : "with no parsed deadline yet"}.`);
  }

  if (latestEvent) {
    items.push(`Latest court activity: ${escapeHtml(latestEvent.event_title || latestEvent.subject || "Court notice")} received ${formatDate(latestEvent.source_received_at)}.`);
  }

  if (Number(stats.documents || 0) > 0) {
    items.push(`${Number(stats.documents)} document(s) have been downloaded and grouped under their cases.`);
  }

  return `<ul class="summary-list">${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function chatPanel() {
  return `
    <div class="chat-box">
      <div class="quick-prompts">
        <button class="prompt-chip" type="button" data-prompt="What are the next 7 days of deadlines?">Next 7 days</button>
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

function deadlineTable(deadlines, compact) {
  if (!deadlines.length) return `<div class="empty">No open items here.</div>`;
  return table(
    ["Done", "Due", "Case", "Deadline", "Confidence", compact ? "Why review" : "Source"],
    deadlines.map((d) => [
      archiveButton(`/deadlines/${d.id}/archive`, "Archive deadline"),
      `<span class="due">${formatDate(d.due_at) || escapeHtml(d.date_text || "Needs review")}</span>`,
      caseLabel(d),
      `<strong>${escapeHtml(d.label)}</strong>${d.source_quote ? `<br><span class="muted">${escapeHtml(d.source_quote)}</span>` : ""}`,
      confidenceTag(d.confidence),
      escapeHtml(compact ? (d.due_at ? "Low confidence" : "Missing parsed date") : (d.subject || ""))
    ])
  );
}

function activityList(events) {
  if (!events.length) return `<div class="empty">No open court activity.</div>`;
  return `<div class="panel-body">${events.map((e) => `
    <div class="activity-card">
      <div>${archiveButton(`/events/${e.id}/archive`, "Archive activity")}</div>
      <div>
        <div class="activity-title">${escapeHtml(e.event_title || e.subject || "Court notice")}</div>
        <div>${caseLabel(e)}</div>
        <div class="muted">${formatDate(e.source_received_at)}${e.docket_number ? ` · Docket ${escapeHtml(e.docket_number)}` : ""}${e.filing_party ? ` · Filed by ${escapeHtml(e.filing_party)}` : ""}</div>
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
        <div class="case-title">${escapeHtml(c.case_name || "Unknown case")}</div>
        <div class="muted">${escapeHtml([c.court, c.case_number].filter(Boolean).join(" | ") || "Court/case number pending")}</div>
        <div class="case-meta">
          ${c.next_deadline_at ? `<span class="tag">Next: ${formatDate(c.next_deadline_at)}</span>` : `<span class="tag review">No parsed deadline</span>`}
          <span class="tag">${Number(c.open_deadline_count || 0)} deadlines</span>
          <span class="tag">${Number(c.open_event_count || 0)} activity</span>
          <span class="tag">${(docsByCase.get(c.id) || []).length} docs</span>
        </div>
      </summary>
      ${c.judge ? `<div class="muted" style="margin-top:8px">Judge: ${escapeHtml(c.judge)}</div>` : ""}
      ${c.latest_activity_at ? `<div class="muted" style="margin-top:4px">Latest activity: ${formatDate(c.latest_activity_at)}</div>` : ""}
      ${caseDeadlineList(deadlinesByCase.get(c.id) || [])}
      ${documentList(docsByCase.get(c.id) || [])}
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
        <div><span class="due">${formatDate(deadline.due_at) || escapeHtml(deadline.date_text || "Needs review")}</span><br>${confidenceTag(deadline.confidence)}</div>
        <div><strong>${escapeHtml(deadline.label)}</strong>${deadline.source_quote ? `<br><span class="muted">${escapeHtml(deadline.source_quote)}</span>` : ""}<br><span class="muted">${escapeHtml(deadline.subject || "")}</span></div>
      </div>
    `).join("")}
  </div>`;
}

function documentList(documents) {
  if (!documents.length) return `<div class="document-list"><div class="case-section-title">Documents</div><div class="muted">No downloaded documents for this case yet.</div></div>`;
  return `<div class="document-list"><div class="case-section-title">Documents</div>${documents.map((doc) => `
    <div class="document-row">
      <div>
        <div class="document-name">${escapeHtml(doc.filename)}</div>
        <div class="muted">${escapeHtml(doc.source_type === "ecf_link" ? "ECF link" : "attachment")} · ${escapeHtml(doc.mime_type || "file")} · ${formatBytes(doc.size_bytes)} · ${escapeHtml(doc.read_status || "pending")}</div>
        ${doc.extracted_text ? `<div class="document-preview">${escapeHtml(doc.extracted_text.slice(0, 320))}${doc.extracted_text.length > 320 ? "..." : ""}</div>` : ""}
      </div>
      <a class="document-link" href="/documents/${doc.id}/download">Download</a>
    </div>
  `).join("")}</div>`;
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
  return `${escapeHtml(row.case_name || "Unknown case")}<br><span class="muted">${escapeHtml([row.court, row.case_number].filter(Boolean).join(" | "))}</span>`;
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
  if (!bytes) return "unknown size";
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
