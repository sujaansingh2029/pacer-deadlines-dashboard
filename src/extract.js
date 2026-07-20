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
  /\b(?:response|reply|objection|opposition|answer|brief|hearing|conference|deadline|due|continued|trial|status|motion|claim|confirmation|341|meeting|notice|serve|filed|file)\b.{0,160}?\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}/gi,
  /\b(?:response|reply|objection|opposition|answer|brief|hearing|conference|deadline|due|continued|trial|status|motion|claim|confirmation|341|meeting|notice|serve|filed|file)\b.{0,160}?\b\d{1,2}\/\d{1,2}\/\d{2,4}/gi,
  /\b(?:no later than|on or before|by|due on|set for|scheduled for)\b.{0,120}?\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}/gi,
  /\b(?:no later than|on or before|by|due on|set for|scheduled for)\b.{0,120}?\b\d{1,2}\/\d{1,2}\/\d{2,4}/gi
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

export async function analyzeDocument(document) {
  const text = String(document.text || "").trim();
  if (!text) {
    return {
      documentType: "Manual review required",
      summary: "The document was saved, but the system could not read enough text to summarize it.",
      needsManualReview: true
    };
  }

  if (config.openaiApiKey) {
    try {
      return await analyzeDocumentWithOpenAI(document, text);
    } catch (error) {
      console.warn("OpenAI document analysis failed; falling back to heuristic summary:", error.message);
    }
  }

  return analyzeDocumentHeuristically(document, text);
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
          "Extract structured data from PACER/CM-ECF court notice emails and any attached/read document text. Return strict JSON. Be exhaustive about dates attorneys may need: response deadlines, objection deadlines, hearing dates, trial dates, status conferences, 341 meetings, claim deadlines, confirmation hearings, service/filing due dates, and dates hidden in docket text or document text. Do not invent dates. If a date may matter but the legal meaning is unclear, include it with confidence needs_review and quote the source."
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
            bodyText: email.bodyText.slice(0, 50000)
          }
        })
      }
    ]
  });
  return normalizeExtraction(JSON.parse(response.choices[0].message.content));
}

async function analyzeDocumentWithOpenAI(document, text) {
  const client = new OpenAI({ apiKey: config.openaiApiKey });
  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Analyze a court filing or court notice document for a law office dashboard. Return strict JSON. Identify what kind of document it is and give a concise practical summary. Do not invent deadlines; if deadlines or hearing dates appear, mention that they must be verified."
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedShape: {
            documentType: "short label such as Order, Notice, Motion, Certificate of Service, Proof of Claim, Hearing Notice, Payment Change, Other",
            summary: "2-4 short sentences about what this document says and why it matters",
            needsManualReview: "boolean"
          },
          filename: document.filename,
          mimeType: document.mimeType,
          text: text.slice(0, 30000)
        })
      }
    ]
  });
  return normalizeDocumentAnalysis(JSON.parse(response.choices[0].message.content));
}

function analyzeDocumentHeuristically(document, text) {
  const lower = `${document.filename || ""}\n${text}`.toLowerCase();
  let documentType = "Court document";
  if (lower.includes("order")) documentType = "Order";
  else if (lower.includes("notice of hearing") || lower.includes("hearing")) documentType = "Hearing notice";
  else if (lower.includes("motion")) documentType = "Motion";
  else if (lower.includes("proof of claim")) documentType = "Proof of claim";
  else if (lower.includes("certificate of service")) documentType = "Certificate of service";
  else if (lower.includes("notice of mortgage payment change")) documentType = "Payment change notice";

  return {
    documentType,
    summary: truncateSentence(text),
    needsManualReview: false
  };
}

function normalizeDocumentAnalysis(value) {
  return {
    documentType: value.documentType || "Court document",
    summary: value.summary || "Saved and read, but no short summary was produced.",
    needsManualReview: Boolean(value.needsManualReview)
  };
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

function truncateSentence(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900) || "Saved and read, but no readable summary was produced.";
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
