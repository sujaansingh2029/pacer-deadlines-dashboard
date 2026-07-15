import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl?.includes("localhost") ? false : { rejectUnauthorized: false }
});

export async function initDb() {
  await pool.query(`
    create table if not exists mailboxes (
      id serial primary key,
      email text unique not null,
      refresh_token text not null,
      last_history_id text,
      last_sync_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists emails (
      gmail_id text primary key,
      thread_id text,
      mailbox_email text not null,
      from_header text,
      to_header text,
      subject text,
      snippet text,
      received_at timestamptz,
      body_text text,
      is_court_notice boolean not null default false,
      processed_at timestamptz not null default now()
    );

    create table if not exists cases (
      id serial primary key,
      case_key text unique not null,
      case_name text,
      court text,
      case_number text,
      judge text,
      updated_at timestamptz not null default now()
    );

    create table if not exists docket_events (
      id serial primary key,
      case_id integer references cases(id) on delete cascade,
      gmail_id text references emails(gmail_id) on delete cascade,
      event_title text,
      docket_number text,
      filing_party text,
      filed_at timestamptz,
      source_received_at timestamptz,
      summary text,
      status text not null default 'open',
      archived_at timestamptz,
      raw jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists deadlines (
      id serial primary key,
      case_id integer references cases(id) on delete cascade,
      gmail_id text references emails(gmail_id) on delete cascade,
      label text not null,
      due_at timestamptz,
      date_text text,
      confidence text not null default 'needs_review',
      source_quote text,
      status text not null default 'open',
      archived_at timestamptz,
      created_at timestamptz not null default now()
    );

    create table if not exists documents (
      id serial primary key,
      case_id integer references cases(id) on delete cascade,
      gmail_id text references emails(gmail_id) on delete cascade,
      filename text not null,
      mime_type text,
      size_bytes integer,
      source_attachment_id text,
      source_url text,
      source_type text not null default 'attachment',
      content bytea,
      extracted_text text,
      read_status text not null default 'pending',
      created_at timestamptz not null default now(),
      unique (gmail_id, filename, size_bytes)
    );

    create table if not exists sync_runs (
      id serial primary key,
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      mailbox_email text,
      scanned_count integer not null default 0,
      notice_count integer not null default 0,
      deadline_count integer not null default 0,
      document_count integer not null default 0,
      summary text,
      error text
    );
  `);

  await pool.query(`
    alter table docket_events add column if not exists status text not null default 'open';
    alter table docket_events add column if not exists archived_at timestamptz;
    alter table deadlines add column if not exists archived_at timestamptz;
    alter table documents add column if not exists extracted_text text;
    alter table documents add column if not exists read_status text not null default 'pending';
    alter table documents add column if not exists source_url text;
    alter table documents add column if not exists source_type text not null default 'attachment';
    alter table sync_runs add column if not exists document_count integer not null default 0;
    create index if not exists deadlines_status_due_at_idx on deadlines (status, due_at);
    create index if not exists docket_events_status_received_idx on docket_events (status, source_received_at desc);
    create index if not exists documents_case_id_idx on documents (case_id, created_at desc);
    create unique index if not exists documents_source_url_idx on documents (source_url) where source_url is not null;
  `);
}

export async function upsertMailbox(email, refreshToken) {
  await pool.query(
    `insert into mailboxes (email, refresh_token, updated_at)
     values ($1, $2, now())
     on conflict (email) do update set refresh_token = excluded.refresh_token, updated_at = now()`,
    [email, refreshToken]
  );
}

export async function getPrimaryMailbox() {
  const result = await pool.query("select * from mailboxes order by created_at asc limit 1");
  return result.rows[0] || null;
}
