import { google } from "googleapis";
import { config } from "./config.js";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export function oauthClient() {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    `${config.appBaseUrl}/oauth2callback`
  );
}

export function authUrl() {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });
}

export async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  return { email: profile.data.emailAddress, tokens };
}

export function gmailForRefreshToken(refreshToken) {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: client });
}

export async function listIncomingMessages(gmail, afterUnixSeconds) {
  const after = afterUnixSeconds ? ` after:${afterUnixSeconds}` : " newer_than:30d";
  const q = `in:anywhere -in:spam -in:trash -in:sent -in:drafts${after}`;
  const ids = [];
  let pageToken;

  do {
    const result = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 100,
      pageToken
    });
    for (const message of result.data.messages || []) ids.push(message.id);
    pageToken = result.data.nextPageToken;
  } while (pageToken && ids.length < 500);

  return ids;
}

export async function readMessage(gmail, id) {
  const result = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full"
  });
  const message = result.data;
  const headers = Object.fromEntries(
    (message.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
  );

  return {
    id: message.id,
    threadId: message.threadId,
    historyId: message.historyId,
    from: headers.from || "",
    to: headers.to || "",
    subject: headers.subject || "",
    date: headers.date || "",
    receivedAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    snippet: message.snippet || "",
    bodyText: extractText(message.payload)
  };
}

function extractText(payload) {
  const plainParts = [];
  const htmlParts = [];
  walkParts(payload, plainParts, htmlParts);
  const source = plainParts.length ? plainParts.join("\n\n") : htmlParts.map(htmlToText).join("\n\n");
  return source.replace(/\r/g, "").trim();
}

function walkParts(part, plainParts, htmlParts) {
  if (!part) return;
  if (part.mimeType === "text/plain" && part.body?.data) {
    plainParts.push(Buffer.from(part.body.data, "base64url").toString("utf8"));
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    htmlParts.push(Buffer.from(part.body.data, "base64url").toString("utf8"));
  }
  for (const child of part.parts || []) walkParts(child, plainParts, htmlParts);
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ");
}
