import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
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

  const [deadlines, events, runs] = await Promise.all([
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
      select de.*, c.case_name, c.court, c.case_number, e.subject
      from docket_events de
      join cases c on c.id = de.case_id
      join emails e on e.gmail_id = de.gmail_id
      order by de.source_received_at desc nulls last, de.created_at desc
      limit 50
    `),
    pool.query("select * from sync_runs order by started_at desc limit 5")
  ]);

  res.send(layout("PACER Deadlines Dashboard", dashboardHtml({ mailbox, deadlines: deadlines.rows, events: events.rows, runs: runs.rows })));
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
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f8fb; color: #172033; }
    header { background: #ffffff; border-bottom: 1px solid #dfe4ee; padding: 20px 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin: 0; letter-spacing: 0; }
    h2 { font-size: 16px; margin: 24px 0 12px; }
    .muted { color: #667085; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    .panel { background: #fff; border: 1px solid #dfe4ee; border-radius: 8px; padding: 16px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dfe4ee; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #edf0f6; vertical-align: top; font-size: 14px; }
    th { background: #f0f3f8; color: #344054; font-weight: 700; }
    tr:last-child td { border-bottom: 0; }
    a.button, button { background: #155eef; color: white; border: 0; border-radius: 6px; padding: 10px 14px; text-decoration: none; font-weight: 700; cursor: pointer; }
    .warning { border-left: 4px solid #b54708; background: #fff7ed; padding: 12px 14px; border-radius: 6px; }
    .tag { display: inline-block; background: #e7f0ff; color: #1849a9; border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 700; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="muted">Court notice monitoring for active cases</div>
    </div>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function setupHtml(missing) {
  return `<div class="warning">Missing required environment variables: ${missing.map(escapeHtml).join(", ")}.</div>`;
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
    <h2>Sign in</h2>
    ${hasError ? `<div class="warning">Wrong password.</div>` : ""}
    <form method="post" action="/login">
      <p><input name="password" type="password" placeholder="Dashboard password" style="box-sizing:border-box;width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:6px"></p>
      <button type="submit">Open Dashboard</button>
    </form>
  </div>`;
}

function dashboardHtml({ mailbox, deadlines, events, runs }) {
  return `
    <div class="grid">
      <div class="panel"><strong>Mailbox</strong><br><span class="muted">${escapeHtml(mailbox.email)}</span></div>
      <div class="panel"><strong>Last Sync</strong><br><span class="muted">${formatDate(mailbox.last_sync_at) || "Not synced yet"}</span></div>
      <div class="panel">
        <form method="post" action="/sync-now"><button type="submit">Sync Now</button></form>
      </div>
    </div>
    <div class="warning" style="margin-top:16px">Deadlines are extracted from email notices and must be verified against the docket and applicable rules.</div>
    <h2>Next Deadlines</h2>
    ${table(
      ["Due", "Case", "Deadline", "Confidence", "Source"],
      deadlines.map((d) => [
        formatDate(d.due_at) || escapeHtml(d.date_text || "Needs review"),
        caseLabel(d),
        escapeHtml(d.label),
        `<span class="tag">${escapeHtml(d.confidence)}</span>`,
        escapeHtml(d.subject || "")
      ])
    )}
    <h2>Recent Docket Activity</h2>
    ${table(
      ["Received", "Case", "Event", "Summary"],
      events.map((e) => [
        formatDate(e.source_received_at),
        caseLabel(e),
        escapeHtml(e.event_title || e.subject || "Court notice"),
        escapeHtml(e.summary || "")
      ])
    )}
    <h2>Recent Sync Runs</h2>
    ${table(
      ["Started", "Scanned", "Notices", "Deadlines", "Summary"],
      runs.map((r) => [
        formatDate(r.started_at),
        String(r.scanned_count),
        String(r.notice_count),
        String(r.deadline_count),
        escapeHtml(r.error || r.summary || "")
      ])
    )}
  `;
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
