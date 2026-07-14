import OpenAI from "openai";
import { config } from "./config.js";

const NOTICE_PATTERNS = [
  /notice of electronic filing/i,
  /\bcm\/ecf\b/i,
  /\bpacer\b/i,
  /uscourts\.gov/i,
  /bankruptcy court/i,
  /district court/i,
  /docket/i
];

const DEADLINE_PATTERNS = [
  /\b(?:response|reply|objection|opposition|answer|brief|hearing|conference|deadline|due)\b.{0,80}?\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}/gi,
  /\b(?:response|reply|objection|opposition|answer|brief|hearing|conference|deadline|due)\b.{0,80}?\b\d{1,2}\/\d{1,2}\/\d{2,4}/gi
];

export function looksLikeCourtNotice(email) {
  const haystack = `${email.from}\n${email.subject}\n${email.snippet}\n${email.bodyText}`;
  return NOTICE_PATTERNS.some((pattern) => pattern.test(haystack));
}

export async function extractNotice(email) {
  if (config.openaiApiKey) {
    try {
      return await extractWithOpenAI(email);
    } catch (error) {
      console.warn("OpenAI extraction failed; falling back to regex:", error.message);
    }
  }
  return extractHeuristically(email);
}

async function extractWithOpenAI(email) {
  const client = new OpenAI({ apiKey: config.openaiApiKey });
  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Extract structured data from PACER/CM-ECF court notice emails. Return strict JSON. Do not invent dates. If unsure, use null and confidence needs_review."
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedShape: {
            isCourtNotice: true,
            caseName: "string|null",
            court: "string|null",
            caseNumber: "string|null",
            judge: "string|null",
            eventTitle: "string|null",
            docketNumber: "string|null",
            filingParty: "string|null",
            filedAt: "ISO date or null",
            summary: "brief plain English summary",
            deadlines: [
              {
                label: "what is due or scheduled",
                dueAt: "ISO date/time or null",
                dateText: "exact date text from source",
                confidence: "high|medium|needs_review",
                sourceQuote: "short source excerpt"
              }
            ]
          },
          email: {
            from: email.from,
            subject: email.subject,
            receivedAt: email.receivedAt,
            snippet: email.snippet,
            bodyText: email.bodyText.slice(0, 12000)
          }
        })
      }
    ]
  });
  return normalizeExtraction(JSON.parse(response.choices[0].message.content));
}

function extractHeuristically(email) {
  const body = `${email.subject}\n${email.bodyText}`;
  const caseNumber = firstMatch(body, /\b(?:case|civil action|bankruptcy|adversary)(?:\s+no\.?|\s+number|\s+#)?[:\s]+([a-z0-9:\-]+(?:-[a-z0-9]+)*)/i);
  const caseName = firstMatch(body, /\b(?:case name|caption)[:\s]+(.+)/i) || firstMatch(email.subject, /(?:re:|in re:)?\s*([^,;]+ v\. [^,;]+)/i);
  const court = firstMatch(body, /(United States (?:Bankruptcy |District )?Court[^\n]*)/i);
  const docketNumber = firstMatch(body, /\b(?:document|doc\.?|docket)\s+(?:no\.?|number|#)?\s*[:#]?\s*(\d+)/i);
  const deadlines = [];

  for (const pattern of DEADLINE_PATTERNS) {
    for (const match of body.matchAll(pattern)) {
      deadlines.push({
        label: match[0].slice(0, 120),
        dueAt: parseDate(match[0]),
        dateText: match[0],
        confidence: "needs_review",
        sourceQuote: match[0]
      });
    }
  }

  return normalizeExtraction({
    isCourtNotice: looksLikeCourtNotice(email),
    caseName,
    court,
    caseNumber,
    judge: firstMatch(body, /\bjudge[:\s]+(.+)/i),
    eventTitle: email.subject,
    docketNumber,
    filingParty: firstMatch(body, /\bfiled by[:\s]+([^\n.]+)/i),
    filedAt: null,
    summary: email.snippet || email.subject,
    deadlines
  });
}

function normalizeExtraction(value) {
  return {
    isCourtNotice: Boolean(value.isCourtNotice),
    caseName: value.caseName || null,
    court: value.court || null,
    caseNumber: value.caseNumber || null,
    judge: value.judge || null,
    eventTitle: value.eventTitle || null,
    docketNumber: value.docketNumber || null,
    filingParty: value.filingParty || null,
    filedAt: value.filedAt || null,
    summary: value.summary || null,
    deadlines: Array.isArray(value.deadlines) ? value.deadlines : []
  };
}

function firstMatch(text, pattern) {
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function parseDate(text) {
  const dateText = firstMatch(text, /((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4})/i)
    || firstMatch(text, /(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (!dateText) return null;
  const parsed = new Date(dateText);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
