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

const NON_COURT_PATTERNS = [
  /security alert/i,
  /new sign-in/i,
  /google account/i,
  /accounts\.google\.com/i,
  /no-reply@accounts\.google\.com/i,
  /password reset/i,
  /verification code/i
];

const DEADLINE_PATTERNS = [
  /\b(?:response|reply|objection|opposition|answer|brief|hearing|conference|deadline|due|continued|trial|status|motion|claim|confirmation|341|meeting|notice|serve|service|filed|file|appear|appearance|payment|plan|cure|bar date)\b.{0,220}?\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}/gi,
  /\b(?:response|reply|objection|opposition|answer|brief|hearing|conference|deadline|due|continued|trial|status|motion|claim|confirmation|341|meeting|notice|serve|service|filed|file|appear|appearance|payment|plan|cure|bar date)\b.{0,220}?\b\d{1,2}\/\d{1,2}\/\d{2,4}/gi,
  /\b(?:no later than|not later than|on or before|by|due on|set for|scheduled for|must|shall|required to|ordered to|continued to)\b.{0,180}?\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}/gi,
  /\b(?:no later than|not later than|on or before|by|due on|set for|scheduled for|must|shall|required to|ordered to|continued to)\b.{0,180}?\b\d{1,2}\/\d{1,2}\/\d{2,4}/gi
];

const ABSOLUTE_DATE_PATTERN = /\b(?:(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?[,]?\s+)?(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?)?/gi;

const RELATIVE_DEADLINE_PATTERN = /\b(?:within|no later than|not later than|on or before|before|after)\s+\d{1,3}\s+(?:calendar\s+)?(?:business\s+)?days?\b.{0,220}/gi;

export function looksLikeCourtNotice(email) {
  const haystack = `${email.from}\n${email.subject}\n${email.snippet}\n${email.bodyText}`;
  if (NON_COURT_PATTERNS.some((pattern) => pattern.test(haystack))) return false;
  return NOTICE_PATTERNS.some((pattern) => pattern.test(haystack));
}

export async function extractNotice(email) {
  let extraction;
  if (config.openaiApiKey) {
    try {
      extraction = await extractWithOpenAI(email);
      return addSafetyNetDates(email, extraction);
    } catch (error) {
      console.warn("OpenAI extraction failed; falling back to regex:", error.message);
    }
  }
  extraction = extractHeuristically(email);
  return addSafetyNetDates(email, extraction);
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
          "Extract structured data from PACER/CM-ECF court notice emails and any attached/read PDF document text. Return strict JSON. Be exhaustive about dates attorneys may need: response deadlines, objection deadlines, hearing dates, trial dates, status conferences, 341 meetings, claim deadlines, confirmation hearings, service/filing due dates, payment/change/cure dates, and dates hidden in docket text, orders, notices, motions, proofs of claim, certificates, or document text. Treat every date in a filed court PDF as potentially important unless clearly irrelevant. Do not invent dates. If a date may matter but the legal meaning is unclear, include it with confidence needs_review and quote the source."
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
          "Analyze a court filing or court notice document for a law office dashboard. Return strict JSON. Identify what kind of document it is and give a concise practical summary for an attorney or paralegal. Focus on what changed, what needs action, and any due dates, hearing dates, objection dates, response dates, cure/payment dates, service requirements, or follow-up needed. Do not invent deadlines; if dates appear, mention that they must be verified against the docket and rules."
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
        confidence: parseDate(match[0]) ? "medium" : "needs_review",
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

function addSafetyNetDates(email, extraction) {
  const body = `${email.subject}\n${email.snippet || ""}\n${email.bodyText || ""}`;
  const existing = new Set(
    (extraction.deadlines || []).flatMap((deadline) => [
      normalizeDateKey(deadline.dateText || deadline.sourceQuote || deadline.label),
      normalizeDateKey(deadline.dueAt || "")
    ])
  );
  const additions = [];

  for (const match of body.matchAll(ABSOLUTE_DATE_PATTERN)) {
    const context = contextAround(body, match.index, match[0].length);
    if (isNonActionableDateContext(context)) continue;
    const parsedDate = parseDate(match[0]);
    const key = normalizeDateKey(match[0]);
    const parsedKey = normalizeDateKey(parsedDate || "");
    if (!key || existing.has(key) || existing.has(parsedKey)) continue;
    existing.add(key);
    if (parsedKey) existing.add(parsedKey);
    additions.push({
      label: labelForDateContext(context, match[0]),
      dueAt: parsedDate,
      dateText: match[0],
      confidence: parsedDate ? "medium" : "needs_review",
      sourceQuote: context
    });
  }

  for (const match of body.matchAll(RELATIVE_DEADLINE_PATTERN)) {
    const context = contextAround(body, match.index, match[0].length);
    const key = normalizeDateKey(match[0]);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    additions.push({
      label: `Possible relative deadline: ${match[0].slice(0, 100)}`,
      dueAt: null,
      dateText: match[0],
      confidence: "needs_review",
      sourceQuote: context
    });
  }

  return normalizeExtraction({
    ...extraction,
    deadlines: [...(extraction.deadlines || []), ...additions]
  });
}

function labelForDateContext(context, dateText) {
  const lower = context.toLowerCase();
  if (lower.includes("hearing")) return `Hearing date: ${dateText}`;
  if (lower.includes("objection")) return `Objection deadline: ${dateText}`;
  if (lower.includes("response")) return `Response deadline: ${dateText}`;
  if (lower.includes("reply")) return `Reply deadline: ${dateText}`;
  if (lower.includes("conference")) return `Conference date: ${dateText}`;
  if (lower.includes("trial")) return `Trial date: ${dateText}`;
  if (lower.includes("meeting") || lower.includes("341")) return `Meeting date: ${dateText}`;
  if (lower.includes("claim")) return `Claim deadline: ${dateText}`;
  if (lower.includes("payment")) return `Payment date/deadline: ${dateText}`;
  if (lower.includes("plan")) return `Plan deadline: ${dateText}`;
  if (lower.includes("cure")) return `Cure deadline: ${dateText}`;
  if ((lower.includes("serve") || lower.includes("service")) && /\b(?:deadline|due|must|shall|required|ordered|no later|on or before|by)\b/i.test(lower)) return `Service deadline: ${dateText}`;
  if (lower.includes("appear")) return `Appearance/hearing date: ${dateText}`;
  return `Court date/deadline: ${dateText}`;
}

function isNonActionableDateContext(context) {
  const lower = String(context || "").toLowerCase();
  if (/notice of electronic filing/.test(lower) && /\b(?:received|entered|filed)\b/.test(lower)) return true;
  if (/\b(?:entered|filed|received)\s+(?:on|from)\b/.test(lower) && !/\b(?:deadline|due|must|shall|required|ordered|hearing|objection|response|reply|trial|conference|meeting|appearance)\b/.test(lower)) return true;
  if (/\bnotice date\b/.test(lower) && !/\b(?:deadline|due|hearing|objection|response|reply|trial|conference|meeting)\b/.test(lower)) return true;
  if (/electronic document stamp|filenumber|notice will be electronically mailed|bke?cfstamp/i.test(lower)) return true;
  if (/public access users|one free electronic copy|pacer access fees|30-page limit/.test(lower)) return true;
  if (/certificate of service/.test(lower) && !/\b(?:deadline|due|must|shall|required|ordered|no later|on or before)\b/.test(lower)) return true;
  return false;
}

function contextAround(text, index, length) {
  return String(text || "")
    .slice(Math.max(0, index - 180), Math.min(text.length, index + length + 220))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function normalizeDateKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[,.;:]$/g, "")
    .trim();
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

export function parseDate(text) {
  const dateText = firstMatch(text, /((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4})/i)
    || firstMatch(text, /(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (!dateText) return null;
  const dateParts = parseUsDateParts(dateText);
  if (dateParts) {
    const time = parseTimeParts(text);
    const offset = easternOffsetForMonth(dateParts.month);
    const hour = time?.hour ?? 12;
    const minute = time?.minute ?? 0;
    const iso = [
      String(dateParts.year).padStart(4, "0"),
      String(dateParts.month).padStart(2, "0"),
      String(dateParts.day).padStart(2, "0")
    ].join("-") + `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${offset}`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(dateText);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseUsDateParts(dateText) {
  const slash = String(dateText || "").match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (slash) {
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    return { month: Number(slash[1]), day: Number(slash[2]), year };
  }
  const monthNames = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12
  };
  const named = String(dateText || "").match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (!named) return null;
  const month = monthNames[named[1].toLowerCase()];
  if (!month) return null;
  return { month, day: Number(named[2]), year: Number(named[3]) };
}

function parseTimeParts(text) {
  const match = String(text || "").match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?|am|pm)?\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = String(match[3] || "").toLowerCase();
  if (meridiem.startsWith("p") && hour < 12) hour += 12;
  if (meridiem.startsWith("a") && hour === 12) hour = 0;
  return { hour, minute };
}

function easternOffsetForMonth(month) {
  return month >= 3 && month <= 10 ? "-04:00" : "-05:00";
}
