# PACER Deadlines Agent

A Render-ready dashboard that connects to a Gmail inbox, reviews new incoming email, identifies PACER / CM-ECF court notices, extracts case activity and deadline signals, and shows a live active-case dashboard.

## What It Does

- Connects to Gmail with read-only OAuth.
- Scans all new incoming messages since the last run.
- Classifies court/PACER/CM-ECF notices.
- Extracts case name, court, case number, docket text, filed date, response/objection/hearing/deadline dates, document numbers, and source email metadata.
- Stores messages, cases, docket activity, and deadlines in Postgres.
- Serves a dashboard at `/`.
- Runs on Render at 9 AM, 12 PM, and 3 PM Eastern during daylight saving time via the included cron service.
- Can use PACER credentials to retry ECF document links that return a court login page, then save and read the released PDF/text when PACER allows access.

Deadline extraction is assistive only. Every legal deadline should be checked against the docket and governing rules before anyone relies on it.

## Local Setup

1. Create a Google OAuth web client in Google Cloud.
2. Add this redirect URI:

   `http://localhost:3000/oauth2callback`

3. Copy `.env.example` to `.env` and fill in credentials.
4. Install and run:

   ```bash
   npm install
   npm start
   ```

5. Open `http://localhost:3000` and click **Connect Gmail**.

## Render Setup

1. Push this repo to GitHub.
2. In Render, create a Blueprint from `render.yaml`.
3. Set environment variables:

   - `APP_BASE_URL`: your Render web service URL, for example `https://pacer-deadlines-dashboard.onrender.com`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `OPENAI_API_KEY`
   - `DASHBOARD_PASSWORD`
   - `PACER_USERNAME`
   - `PACER_PASSWORD`
   - `PACER_CLIENT_CODE` optional, if your PACER account requires one
   - `PACER_LOGIN_URL` optional, defaults to `https://pacer.login.uscourts.gov/csologin/login.jsf`
   - `PACER_AUTH_COOKIE` optional fallback for a PACER session cookie
   - `PACER_USERNAME_FIELD`, `PACER_PASSWORD_FIELD`, and `PACER_CLIENT_CODE_FIELD` optional overrides if PACER changes its login form

4. In Google Cloud OAuth settings, add this redirect URI:

   `https://YOUR-RENDER-URL/oauth2callback`

5. Visit the Render app URL and connect the Gmail inbox that receives PACER/CM-ECF notices.

The dashboard is public unless `DASHBOARD_PASSWORD` is set, so set it before connecting a real mailbox.

Do not put PACER credentials in the repo or send them in chat. Store them only as Render secret environment variables on both the web service and the cron service. PACER may charge fees, and some court links still require MFA, fee confirmation, a client-code screen, or manual download if the free-look link has already been used or expired.

## Schedule Note

Render cron schedules use UTC. The included schedule is `0 * * * *`, which runs every hour.

## Manual Sync

After connecting Gmail, trigger a sync from the dashboard or run:

```bash
npm run sync
```
