from __future__ import annotations

import csv
import html
import io
import json
import math
import os
import re
import statistics
import tempfile
import urllib.parse
from email.utils import parsedate_to_datetime
from dataclasses import dataclass
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterable

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).parent.resolve()
OUTPUT_DIR = ROOT / "outputs"
UPLOAD_DIR = ROOT / "work" / "uploads"
OUTPUT_DIR.mkdir(exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_TEXT_CHARS = 24000
USER_AGENT = "DD-Brief-Generator/0.3 Advanced Local Preview"
SEC_USER_AGENT = os.getenv("SEC_USER_AGENT", "DD-Brief-Generator/0.4 local diligence research contact@example.com")
CHAT_CONTEXT_LIMIT = 42000
CHAT_STATE: dict[str, object] = {
    "company": "",
    "brief": "",
    "sources": [],
    "figures": [],
}
SCREENER_STATE: dict[str, object] = {
    "country": "",
    "rows": [],
}

COUNTRY_MARKET_UNIVERSES: dict[str, list[str]] = {
    "United States": ["PG", "KO", "PEP", "WMT", "COST", "PM", "MO", "MDLZ", "CL", "KMB", "EL", "TGT"],
    "Japan": ["2914.T", "2502.T", "2503.T", "2802.T", "4452.T", "4911.T", "3382.T", "8267.T", "2269.T"],
    "United Kingdom": ["ULVR.L", "DGE.L", "TSCO.L", "SBRY.L", "BATS.L", "IMB.L", "ABF.L", "CPG.L"],
    "Canada": ["L.TO", "MRU.TO", "EMP-A.TO", "ATD.TO", "WN.TO", "SAP.TO", "PBH.TO"],
    "Australia": ["WOW.AX", "COL.AX", "WES.AX", "TWE.AX", "A2M.AX", "EDV.AX"],
    "Germany": ["BEI.DE", "HEN3.DE", "HEN.DE", "BOSS.DE", "ZAL.DE"],
    "France": ["OR.PA", "RI.PA", "BN.PA", "MC.PA", "RMS.PA", "CA.PA"],
    "India": ["HINDUNILVR.NS", "ITC.NS", "NESTLEIND.NS", "BRITANNIA.NS", "DABUR.NS", "MARICO.NS", "DMART.NS"],
    "South Korea": ["005380.KS", "051900.KS", "090430.KS", "004370.KS", "097950.KS"],
    "Hong Kong": ["0291.HK", "0322.HK", "0688.HK", "1044.HK", "1929.HK", "2319.HK"],
}

WESTERN_BENCHMARKS = ["SPY", "QQQ", "VGK"]


@dataclass
class Source:
    label: str
    url: str
    text: str


@dataclass
class SECCompany:
    cik: str
    ticker: str
    title: str


@dataclass
class Figure:
    value: str
    context: str
    source_label: str
    source_url: str
    confidence: str
    category: str
    quality_note: str


@dataclass
class StockPoint:
    date: datetime
    close: float


@dataclass
class StockSeries:
    ticker: str
    currency: str
    points: list[StockPoint]
    source_url: str
    name: str = ""
    exchange: str = ""
    quote_type: str = ""
    market_region: str = ""
    regular_market_price: float | None = None
    previous_close: float | None = None
    day_low: float | None = None
    day_high: float | None = None
    fifty_two_week_low: float | None = None
    fifty_two_week_high: float | None = None
    market_cap: float | None = None
    trailing_pe: float | None = None
    forward_pe: float | None = None
    price_to_book: float | None = None
    dividend_yield_pct: float | None = None
    beta: float | None = None
    average_volume: float | None = None
    shares_outstanding: float | None = None
    sector: str = ""
    industry: str = ""
    country: str = ""
    website: str = ""
    employees: int | None = None
    business_summary: str = ""


@dataclass
class MarketNews:
    title: str
    publisher: str
    link: str
    published: datetime | None
    summary: str = ""


@dataclass
class MoveCatalyst:
    label: str
    date: datetime
    move_pct: float
    explanation: str
    headlines: list[MarketNews]


@dataclass
class StockMetrics:
    ticker: str
    currency: str
    latest_price: float
    start_price: float
    high_price: float
    low_price: float
    total_return_pct: float
    cagr_pct: float
    volatility_pct: float
    sharpe_like: float
    max_drawdown_pct: float
    current_drawdown_pct: float
    best_week_pct: float
    worst_week_pct: float
    positive_week_pct: float
    weeks: int
    trend_label: str
    ma_40: float
    annual_returns: dict[int, float]


@dataclass
class GrowthScenario:
    label: str
    annual_rate_pct: float
    projected_prices: dict[int, float]
    projected_returns: dict[int, float]


@dataclass
class MarketAnalysis:
    target: StockSeries
    target_metrics: StockMetrics
    benchmark: StockSeries | None
    peers: list[StockSeries]
    peer_metrics: list[StockMetrics]
    market_news: list[MarketNews]
    move_catalysts: list[MoveCatalyst]
    symbol_note: str
    international_note: str
    disclosure_links: list[tuple[str, str]]
    price_chart_path: str
    indexed_chart_path: str
    drawdown_chart_path: str
    annual_chart_path: str
    forecast_chart_path: str
    scenarios: list[GrowthScenario]
    source_note: str


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def md_cell(value: object, limit: int = 420) -> str:
    text = clean_text(str(value if value is not None else ""))
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text.replace("|", " / ")


def html_page(body: str) -> bytes:
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Advanced DD Brief Generator</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>{body}</body>
</html>""".encode("utf-8")


def fetch_website(company: str, website: str) -> Source:
    if not website:
        return Source("Company website", "", "")
    url = website.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    try:
        response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=14, allow_redirects=True)
        response.raise_for_status()
    except Exception as exc:
        return Source("Company website", url, f"Website fetch failed: {exc}")

    soup = BeautifulSoup(response.text, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.decompose()
    title = clean_text(soup.title.string if soup.title else company)
    meta = ""
    meta_tag = soup.find("meta", attrs={"name": "description"})
    if meta_tag and meta_tag.get("content"):
        meta = clean_text(meta_tag["content"])
    text = clean_text(soup.get_text(" "))
    combined = clean_text(f"{title}. {meta}. {text}")[:MAX_TEXT_CHARS]
    return Source("Company website", response.url, combined)


def fetch_sec_company_search(company: str) -> Source:
    query = urllib.parse.quote(company)
    url = f"https://www.sec.gov/edgar/search/#/q={query}"
    return Source(
        "SEC EDGAR search",
        url,
        f"Use the SEC EDGAR company search for public filings related to {company}. Private companies often have no result.",
    )


def sec_headers() -> dict[str, str]:
    return {
        "User-Agent": SEC_USER_AGENT,
        "Accept-Encoding": "gzip, deflate",
        "Accept": "application/json,text/html,application/xhtml+xml",
    }


def normalize_company_name(value: str) -> str:
    lowered = re.sub(r"[^a-z0-9 ]+", " ", (value or "").lower())
    lowered = re.sub(
        r"\b(incorporated|inc|corp|corporation|company|co|ltd|limited|plc|class a|class b|common stock|the)\b",
        " ",
        lowered,
    )
    return clean_text(lowered)


def fetch_json(url: str) -> object | None:
    try:
        response = requests.get(url, headers=sec_headers(), timeout=14)
        response.raise_for_status()
        return response.json()
    except Exception:
        return None


def lookup_sec_company(company: str, ticker: str = "") -> SECCompany | None:
    data = fetch_json("https://www.sec.gov/files/company_tickers.json")
    if not isinstance(data, dict):
        return None

    rows = []
    for item in data.values():
        if isinstance(item, dict):
            rows.append(item)

    ticker_clean = clean_text(ticker).upper().replace(" ", "")
    if ticker_clean:
        for row in rows:
            if clean_text(str(row.get("ticker", ""))).upper() == ticker_clean:
                cik = str(row.get("cik_str", "")).zfill(10)
                return SECCompany(cik=cik, ticker=ticker_clean, title=clean_text(str(row.get("title", ""))))

    target = normalize_company_name(company)
    if not target:
        return None
    best: tuple[int, dict[str, object]] | None = None
    target_words = set(target.split())
    for row in rows:
        title = clean_text(str(row.get("title", "")))
        normalized = normalize_company_name(title)
        if not normalized:
            continue
        score = 0
        if normalized == target:
            score = 100
        elif normalized.startswith(target) or target.startswith(normalized):
            score = 80
        else:
            overlap = len(target_words & set(normalized.split()))
            score = overlap * 20
        if score and (best is None or score > best[0]):
            best = (score, row)
    if not best or best[0] < 40:
        return None
    row = best[1]
    return SECCompany(
        cik=str(row.get("cik_str", "")).zfill(10),
        ticker=clean_text(str(row.get("ticker", ""))).upper(),
        title=clean_text(str(row.get("title", ""))),
    )


def filing_url(cik: str, accession: str, primary_document: str) -> str:
    accession_clean = accession.replace("-", "")
    cik_int = str(int(cik))
    return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_clean}/{primary_document}"


def extract_sec_sections(html_text: str) -> str:
    soup = BeautifulSoup(html_text, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "ix:header"]):
        tag.decompose()
    text = clean_text(soup.get_text(" "))
    sentences = re.split(r"(?<=[.!?])\s+", text)
    section_terms = [
        "consolidated statements of operations", "consolidated statement of operations",
        "consolidated statements of income", "consolidated statement of income",
        "consolidated balance sheets", "consolidated balance sheet",
        "consolidated statements of cash flows", "consolidated statement of cash flows",
        "management's discussion and analysis", "results of operations", "liquidity and capital resources",
        "revenue", "net sales", "gross margin", "operating income", "net income", "cash and cash equivalents",
        "total assets", "total liabilities", "long-term debt", "free cash flow", "capital expenditures",
    ]
    hits: list[str] = []
    seen: set[str] = set()
    for sentence in sentences:
        sentence = clean_text(sentence)
        lowered = sentence.lower()
        if len(sentence) < 35 or len(sentence) > 520:
            continue
        if not any(term in lowered for term in section_terms):
            continue
        signature = sentence[:160].lower()
        if signature in seen:
            continue
        seen.add(signature)
        hits.append(sentence)
        if len(hits) >= 120:
            break
    return clean_text(" ".join(hits))[:MAX_TEXT_CHARS]


def fetch_quarterly_sec_filings(company: str, ticker: str = "", limit: int = 4) -> tuple[SECCompany | None, list[Source]]:
    match = lookup_sec_company(company, ticker)
    if not match:
        return None, [
            Source(
                "SEC quarterly filing lookup",
                f"https://www.sec.gov/edgar/search/#/q={urllib.parse.quote(company)}",
                f"No SEC company match was found for {company}. If this is a public company, enter the exact ticker to pull quarterly 10-Q filings.",
            )
        ]

    submissions_url = f"https://data.sec.gov/submissions/CIK{match.cik}.json"
    submissions = fetch_json(submissions_url)
    if not isinstance(submissions, dict):
        return match, [
            Source(
                "SEC quarterly filing lookup",
                submissions_url,
                f"SEC company match found for {match.title} ({match.ticker}, CIK {match.cik}), but recent filings could not be pulled.",
            )
        ]

    recent = submissions.get("filings", {}).get("recent", {}) if isinstance(submissions.get("filings"), dict) else {}
    forms = recent.get("form", []) if isinstance(recent, dict) else []
    accessions = recent.get("accessionNumber", []) if isinstance(recent, dict) else []
    primary_docs = recent.get("primaryDocument", []) if isinstance(recent, dict) else []
    filing_dates = recent.get("filingDate", []) if isinstance(recent, dict) else []

    sources: list[Source] = []
    for form, accession, primary_doc, filing_date in zip(forms, accessions, primary_docs, filing_dates):
        if form != "10-Q":
            continue
        url = filing_url(match.cik, str(accession), str(primary_doc))
        try:
            response = requests.get(url, headers=sec_headers(), timeout=16)
            response.raise_for_status()
            excerpt = extract_sec_sections(response.text)
        except Exception as exc:
            excerpt = f"Form 10-Q filing for {match.title} filed {filing_date} was located, but text extraction failed: {exc}"
        if excerpt:
            text = (
                f"SEC filing source. Form 10-Q for {match.title} ({match.ticker}), CIK {match.cik}, filed {filing_date}. "
                f"{excerpt}"
            )
            sources.append(Source(f"SEC Form 10-Q: {match.ticker} filed {filing_date}", url, text[:MAX_TEXT_CHARS]))
        if len(sources) >= limit:
            break

    if not sources:
        sources.append(
            Source(
                "SEC quarterly filing lookup",
                f"https://www.sec.gov/edgar/browse/?CIK={match.cik}",
                f"SEC company match found for {match.title} ({match.ticker}, CIK {match.cik}), but no recent Form 10-Q filings were found. The company may be foreign, newly public, inactive, or may file different forms.",
            )
        )
    return match, sources


def extract_pdf_text(raw: bytes, filename: str) -> str:
    try:
        import pypdf  # type: ignore

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(raw)
            tmp_path = Path(tmp.name)
        try:
            reader = pypdf.PdfReader(str(tmp_path))
            pages = []
            for index, page in enumerate(reader.pages, start=1):
                pages.append(f"[Page {index}] {page.extract_text() or ''}")
            return clean_text("\n".join(pages))
        finally:
            tmp_path.unlink(missing_ok=True)
    except Exception:
        return (
            f"Uploaded PDF '{filename}' was received, but PDF text extraction failed in this runtime. "
            "Install pypdf or paste PDF text into the notes box."
        )


def csv_to_text(raw: bytes, filename: str) -> str:
    try:
        decoded = raw.decode("utf-8-sig", errors="replace")
        reader = csv.reader(io.StringIO(decoded))
        rows = list(reader)[:80]
        if not rows:
            return ""
        lines = [f"CSV file {filename} detected. First rows:"]
        for row in rows:
            lines.append(" | ".join(cell.strip() for cell in row[:16]))
        return clean_text("\n".join(lines))
    except Exception:
        return raw.decode("utf-8", errors="replace")


def parse_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], list[tuple[str, bytes]]]:
    match = re.search(r"boundary=(.+)", content_type)
    if not match:
        return {}, []
    boundary = match.group(1).strip().strip('"').encode()
    fields: dict[str, str] = {}
    files: list[tuple[str, bytes]] = []
    delimiter = b"--" + boundary
    for part in body.split(delimiter):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        header_blob, _, payload = part.partition(b"\r\n\r\n")
        headers = header_blob.decode("utf-8", errors="ignore")
        payload = payload.rstrip(b"\r\n")
        name_match = re.search(r'name="([^"]+)"', headers)
        if not name_match:
            continue
        filename_match = re.search(r'filename="([^"]*)"', headers)
        name = name_match.group(1)
        if filename_match and filename_match.group(1):
            files.append((filename_match.group(1), payload))
        else:
            fields[name] = payload.decode("utf-8", errors="replace")
    return fields, files


def source_from_upload(filename: str, raw: bytes) -> Source:
    safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", filename or "upload")
    saved = UPLOAD_DIR / f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{safe_name}"
    saved.write_bytes(raw)
    suffix = saved.suffix.lower()
    if suffix == ".pdf":
        text = extract_pdf_text(raw, filename)
    elif suffix == ".csv":
        text = csv_to_text(raw, filename)
    else:
        text = raw.decode("utf-8", errors="replace")
    return Source(f"Uploaded document: {filename}", str(saved), clean_text(text)[:MAX_TEXT_CHARS])


FIGURE_RE = re.compile(
    r"(?<![\w.])(?:\$|USD\s*)?\d[\d,]*(?:\.\d+)?\s*(?:billion|million|thousand|employees|customers|users|ARR|MRR|revenue|EBITDA|EBIT|gross margin|net income|cash|debt|%|x|mm|bn|m|k)?",
    re.IGNORECASE,
)

FINANCIAL_METRIC_KEYWORDS = {
    "revenue", "sales", "gross margin", "ebitda", "operating income", "net income", "cash", "debt", "assets",
    "liabilities", "free cash flow", "fcf", "capex", "funding", "valuation", "runway", "burn",
}
OPERATING_METRIC_KEYWORDS = {
    "arr", "mrr", "bookings", "churn", "customers", "customer", "users", "contract", "contracts", "backlog",
    "pipeline", "retention", "net retention", "gross retention", "renewal", "renewals", "ltv", "cac",
}
NUMERIC_ALLOW_KEYWORDS = FINANCIAL_METRIC_KEYWORDS | OPERATING_METRIC_KEYWORDS
NOISE_KEYWORDS = {
    "privacy", "privacy policy", "terms", "terms of use", "terms and conditions", "sitemap", "site map",
    "copyright", "phone", "call", "support", "trade in", "cash back", "learn more", "apply now", "promo",
    "promotion", "legal", "footer", "navigation", "cookie", "cookies", "item", "product", "model", "iphone",
    "macbook", "refund", "zip", "address", "episode", "listen", "watch now", "all rights reserved", "store",
    "tel", "fax", "contact", "menu", "accessibility", "apple card", "daily cash", "credit when",
}
BUSINESS_TEXT_NOISE_KEYWORDS = {
    word for word in NOISE_KEYWORDS
    if word not in {"product", "item", "model"}
}
TRANSACTION_KEYWORDS = {
    "acquisition", "acquire", "acquired", "merger", "merge", "joint venture", "partnership", "strategic alliance",
    "divestiture", "divested", "sale of", "sold", "spin-off", "spinoff", "restructuring", "buyback", "repurchase",
    "share repurchase", "dividend", "special dividend", "capital raise", "offering", "debt offering", "bond",
    "loan", "credit facility", "investment", "contract", "backlog", "order", "supply agreement", "settlement",
    "tender offer", "takeover", "privatization",
}
SEC_OR_FINANCIAL_SOURCE_HINTS = {
    "form 10-k", "form 10-q", "s-1", "sec filing", "consolidated statements", "balance sheet", "income statement",
    "statement of operations", "cash flow", "audited", "unaudited", "gaap", "fiscal year", "fiscal quarter",
}


def has_any_phrase(text: str, phrases: Iterable[str]) -> bool:
    lowered = text.lower()
    return any(phrase in lowered for phrase in phrases)


def classify_numeric_claim(context: str) -> str:
    lowered = context.lower()
    if has_any_phrase(lowered, NOISE_KEYWORDS):
        return "Rejected page noise"
    if has_any_phrase(lowered, FINANCIAL_METRIC_KEYWORDS):
        if has_any_phrase(lowered, SEC_OR_FINANCIAL_SOURCE_HINTS) or re.search(r"\b(20\d{2}|19\d{2}|q[1-4]|fy)\b", lowered):
            return "Verified financial metric"
        return "Unverified number"
    if has_any_phrase(lowered, OPERATING_METRIC_KEYWORDS):
        return "Possible operating metric"
    return "Unverified number"


def source_supports_verified_financials(source: Source) -> bool:
    label = source.label.lower()
    text = source.text.lower()
    if label.startswith("uploaded document") or label.startswith("pasted analyst") or label.startswith("sec form 10-q"):
        return True
    return has_any_phrase(text, SEC_OR_FINANCIAL_SOURCE_HINTS)


def classify_figure(value: str, context: str, source: Source) -> tuple[str, str]:
    lowered = context.lower()
    value_clean = value.replace(",", "").strip()
    if re.fullmatch(r"20\d{2}|19\d{2}", value_clean) and not has_any_phrase(lowered, NUMERIC_ALLOW_KEYWORDS):
        return "Rejected page noise", "Looks like a standalone year, not a diligence metric."

    category = classify_numeric_claim(context)
    if category == "Verified financial metric" and not source_supports_verified_financials(source):
        category = "Unverified number"

    if category == "Verified financial metric":
        return category, "Financial context appears in user-provided material, filing text, or another diligence-grade source."
    if category == "Possible operating metric":
        return category, "Operating context exists, but confirm definition, period, and source before relying on it."
    if category == "Rejected page noise":
        return category, "Context looks like footer, legal, contact, navigation, product, or promotional page text."
    return category, "No sufficient financial or operating context near this number."


def extract_figures(sources: list[Source]) -> list[Figure]:
    figures: list[Figure] = []
    seen: set[tuple[str, str]] = set()
    for source in sources:
        for match in FIGURE_RE.finditer(source.text):
            value = clean_text(match.group(0))
            if len(value) < 2:
                continue
            sentence_start = max(source.text.rfind(".", 0, match.start()), source.text.rfind("!", 0, match.start()), source.text.rfind("?", 0, match.start()))
            sentence_start = 0 if sentence_start < 0 else sentence_start + 1
            sentence_ends = [pos for pos in (source.text.find(".", match.end()), source.text.find("!", match.end()), source.text.find("?", match.end())) if pos >= 0]
            sentence_end = min(sentence_ends) + 1 if sentence_ends else min(len(source.text), match.end() + 160)
            context = clean_text(source.text[sentence_start:sentence_end])
            key = (value.lower(), context[:130].lower())
            if key in seen:
                continue
            seen.add(key)
            category, quality_note = classify_figure(value, context, source)
            figures.append(
                Figure(
                    value=value,
                    context=context,
                    source_label=source.label,
                    source_url=source.url,
                    confidence="Sourced, needs human verification",
                    category=category,
                    quality_note=quality_note,
                )
            )
            if len(figures) >= 60:
                return figures
    return figures


def bullets_from_text(text: str, keywords: list[str], limit: int = 6) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+", text)
    hits = []
    seen = set()
    for sentence in sentences:
        lowered = sentence.lower()
        if any(word in lowered for word in keywords):
            sentence = clean_text(sentence)
            signature = sentence[:90].lower()
            if 45 <= len(sentence) <= 320 and signature not in seen:
                seen.add(signature)
                hits.append(sentence)
        if len(hits) >= limit:
            break
    return hits


def clean_business_sentences(sources: list[Source], limit: int = 6) -> list[str]:
    allowed = [
        "platform", "software", "service", "services", "product", "products", "company", "business", "customers",
        "mission", "solution", "solutions", "manufactures", "sells", "offers", "operates", "segments", "brands",
        "retail", "automotive", "financial services", "semiconductor", "industrial", "consumer", "healthcare",
    ]
    hits: list[str] = []
    seen: set[str] = set()
    for source in sources:
        if source.label != "Company website" and not source.label.startswith("Pasted"):
            continue
        for sentence in re.split(r"(?<=[.!?])\s+", source.text):
            sentence = clean_text(sentence)
            lowered = sentence.lower()
            if len(sentence) < 45 or len(sentence) > 280:
                continue
            if has_any_phrase(lowered, BUSINESS_TEXT_NOISE_KEYWORDS):
                continue
            if has_any_phrase(lowered, TRANSACTION_KEYWORDS):
                continue
            if re.search(r"\b(?:\+?\d[\d\s().-]{7,}|20\d{2}|19\d{2})\b", sentence):
                continue
            if not any(word in lowered for word in allowed):
                continue
            signature = sentence[:100].lower()
            if signature in seen:
                continue
            seen.add(signature)
            hits.append(sentence)
            if len(hits) >= limit:
                return hits
    return hits


def company_profile_bullets(sources: list[Source], market: MarketAnalysis | None, limit: int = 10) -> list[str]:
    bullets: list[str] = []
    if market and market.target.business_summary:
        summary = market.target.business_summary
        for sentence in re.split(r"(?<=[.!?])\s+", summary):
            sentence = clean_text(sentence)
            if 45 <= len(sentence) <= 420:
                bullets.append(f"{sentence} Source: Yahoo Finance profile.")
            if len(bullets) >= 4:
                break
    if market:
        details = []
        if market.target.sector:
            details.append(f"sector: {market.target.sector}")
        if market.target.industry:
            details.append(f"industry: {market.target.industry}")
        if market.target.country:
            details.append(f"country: {market.target.country}")
        if market.target.employees:
            details.append(f"employees: {market.target.employees:,}")
        if details:
            bullets.append(f"Yahoo profile metadata: {', '.join(details)}.")
    for item in clean_business_sentences(sources, limit=limit):
        bullets.append(f"{item} Source: company website / provided text.")
        if len(bullets) >= limit:
            break
    return bullets[:limit]


def transaction_bullets(sources: list[Source], market: MarketAnalysis | None, limit: int = 12) -> list[str]:
    bullets: list[str] = []
    seen: set[str] = set()

    def add(text: str, source_label: str) -> None:
        text = clean_text(text)
        if len(text) < 45 or len(text) > 460:
            return
        lowered = text.lower()
        if not any(term in lowered for term in TRANSACTION_KEYWORDS):
            return
        sig = text[:140].lower()
        if sig in seen:
            return
        seen.add(sig)
        bullets.append(f"{text} Source: {source_label}.")

    if market:
        for item in market.market_news:
            add(item.title, item.publisher or "Yahoo Finance news")
            if item.summary:
                add(item.summary, item.publisher or "Yahoo Finance news")
            if len(bullets) >= limit:
                return bullets[:limit]

    for source in sources:
        for sentence in re.split(r"(?<=[.!?])\s+", source.text):
            add(sentence, source.label)
            if len(bullets) >= limit:
                return bullets[:limit]
    return bullets[:limit]


def financial_snapshot_figures(figures: list[Figure]) -> list[Figure]:
    return [
        fig for fig in figures
        if fig.category == "Verified financial metric"
        and not fig.source_label.lower().startswith("company website")
    ]


def operating_figures(figures: list[Figure]) -> list[Figure]:
    return [fig for fig in figures if fig.category == "Possible operating metric"]


def has_pasted_notes(sources: list[Source]) -> bool:
    return any(source.label.startswith("Pasted") for source in sources)


def has_website_source(sources: list[Source]) -> bool:
    return any(source.label == "Company website" and source.text for source in sources)


def sec_quarterly_sources(sources: list[Source]) -> list[Source]:
    return [source for source in sources if source.label.startswith("SEC Form 10-Q")]


def has_sec_quarterly_sources(sources: list[Source]) -> bool:
    return bool(sec_quarterly_sources(sources))


def sec_filing_readout(sources: list[Source], limit: int = 6) -> list[str]:
    items: list[str] = []
    terms = [
        "revenue", "net sales", "gross margin", "operating income", "net income", "cash and cash equivalents",
        "total assets", "total liabilities", "debt", "liquidity", "capital resources", "cash flow",
    ]
    for source in sec_quarterly_sources(sources):
        for sentence in re.split(r"(?<=[.!?])\s+", source.text):
            sentence = clean_text(sentence)
            lowered = sentence.lower()
            if 55 <= len(sentence) <= 360 and any(term in lowered for term in terms):
                items.append(f"{sentence} Source: {source.label}.")
                break
        if len(items) >= limit:
            break
    return items


def detect_legal_or_regulatory_language(sources: list[Source]) -> bool:
    corpus = " ".join(source.text.lower() for source in sources)
    relevant_terms = ["litigation", "regulatory", "subpoena", "consent order", "investigation", "compliance", "material adverse", "data breach", "sanction"]
    return any(term in corpus for term in relevant_terms)


def detect_conflicting_numbers(figures: list[Figure]) -> bool:
    by_metric: dict[str, set[str]] = {}
    metric_terms = list(NUMERIC_ALLOW_KEYWORDS)
    for fig in figures:
        if fig.category not in {"Verified financial metric", "Possible operating metric"}:
            continue
        lowered = fig.context.lower()
        metric = next((term for term in metric_terms if term in lowered), "")
        if not metric:
            continue
        normalized_value = re.sub(r"\s+", " ", fig.value.lower().replace(",", ""))
        by_metric.setdefault(metric, set()).add(normalized_value)
    return any(len(values) > 1 for values in by_metric.values())


def period_return(points: list[StockPoint], years: int) -> float | None:
    if not points:
        return None
    cutoff_days = years * 365
    latest = points[-1]
    candidates = [p for p in points if (latest.date - p.date).days >= cutoff_days]
    if not candidates:
        return None
    start = candidates[-1]
    if not start.close:
        return None
    return (latest.close / start.close - 1) * 100


def money(value: float, currency: str = "USD") -> str:
    return f"{currency} {value:,.2f}"


def pct(value: float) -> str:
    return f"{value:+.1f}%"


def raw_yahoo_value(value: object) -> object:
    if isinstance(value, dict):
        if "raw" in value:
            return value["raw"]
        if "fmt" in value:
            return value["fmt"]
    return value


def yahoo_float(value: object) -> float | None:
    raw = raw_yahoo_value(value)
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        cleaned = raw.replace(",", "").replace("%", "").strip()
        try:
            return float(cleaned)
        except Exception:
            return None
    return None


def yahoo_int(value: object) -> int | None:
    num = yahoo_float(value)
    return int(num) if num is not None else None


def compact_money(value: float | None, currency: str = "") -> str:
    if value is None:
        return "Not available"
    sign = "-" if value < 0 else ""
    amount = abs(value)
    if amount >= 1_000_000_000_000:
        text = f"{sign}{amount / 1_000_000_000_000:.2f}T"
    elif amount >= 1_000_000_000:
        text = f"{sign}{amount / 1_000_000_000:.2f}B"
    elif amount >= 1_000_000:
        text = f"{sign}{amount / 1_000_000:.2f}M"
    elif amount >= 1_000:
        text = f"{sign}{amount / 1_000:.2f}K"
    else:
        text = f"{value:,.2f}"
    return f"{currency} {text}".strip()


def fmt_number(value: float | int | None) -> str:
    if value is None:
        return "Not available"
    return f"{value:,.0f}" if float(value).is_integer() else f"{value:,.2f}"


def fmt_ratio(value: float | None) -> str:
    return "Not available" if value is None else f"{value:.2f}x"


def fmt_pct_plain(value: float | None) -> str:
    return "Not available" if value is None else f"{value:.2f}%"


def fetch_yahoo_quote_data(symbol: str) -> dict[str, object]:
    encoded = urllib.parse.quote(symbol)
    data: dict[str, object] = {}
    quote_url = f"https://query1.finance.yahoo.com/v7/finance/quote?symbols={encoded}"
    try:
        response = requests.get(quote_url, headers={"User-Agent": USER_AGENT}, timeout=14)
        response.raise_for_status()
        results = response.json().get("quoteResponse", {}).get("result", [])
        if results and isinstance(results[0], dict):
            data.update(results[0])
    except Exception:
        pass

    modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile"
    summary_url = f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{encoded}?modules={modules}"
    try:
        response = requests.get(summary_url, headers={"User-Agent": USER_AGENT}, timeout=14)
        response.raise_for_status()
        results = response.json().get("quoteSummary", {}).get("result", [])
        if results and isinstance(results[0], dict):
            for module_data in results[0].values():
                if isinstance(module_data, dict):
                    data.update(module_data)
    except Exception:
        pass
    return data


def yahoo_search(query: str, quotes_count: int = 8, news_count: int = 8) -> dict[str, object]:
    query = clean_text(query)
    if not query:
        return {}
    url = (
        "https://query2.finance.yahoo.com/v1/finance/search?"
        + urllib.parse.urlencode({"q": query, "quotesCount": quotes_count, "newsCount": news_count})
    )
    try:
        response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=14)
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def resolve_market_symbol(company: str, ticker: str = "") -> tuple[str, str]:
    raw = clean_text(ticker or company)
    if not raw:
        return "", "No company or ticker was available for market lookup."
    direct = clean_text(ticker).upper().replace(" ", "")
    if direct and re.fullmatch(r"[A-Z0-9.^=\-]{1,18}(?:\.[A-Z]{1,4})?", direct):
        return direct, f"Using entered market symbol {direct}."

    data = yahoo_search(raw, quotes_count=12, news_count=0)
    quotes = data.get("quotes", []) if isinstance(data, dict) else []
    if not isinstance(quotes, list):
        return "", f"Yahoo Finance symbol search did not return a match for {raw}."

    allowed_types = {"EQUITY", "ETF", "INDEX", "MUTUALFUND"}
    best: tuple[int, dict[str, object]] | None = None
    target = normalize_company_name(company or raw)
    for quote in quotes:
        if not isinstance(quote, dict):
            continue
        symbol = clean_text(str(quote.get("symbol", ""))).upper()
        quote_type = clean_text(str(quote.get("quoteType", ""))).upper()
        short_name = clean_text(str(quote.get("shortname", "") or quote.get("longname", "")))
        if not symbol or quote_type not in allowed_types:
            continue
        normalized_name = normalize_company_name(short_name)
        score = 10
        if target and normalized_name == target:
            score += 80
        elif target and (normalized_name.startswith(target) or target.startswith(normalized_name)):
            score += 55
        elif target:
            score += len(set(target.split()) & set(normalized_name.split())) * 15
        if quote.get("isYahooFinance"):
            score += 5
        if quote_type == "EQUITY":
            score += 8
        if best is None or score > best[0]:
            best = (score, quote)

    if not best:
        return "", f"Yahoo Finance symbol search did not return an equity, ETF, fund, or index match for {raw}."
    quote = best[1]
    symbol = clean_text(str(quote.get("symbol", ""))).upper()
    name = clean_text(str(quote.get("shortname", "") or quote.get("longname", "") or symbol))
    exchange = clean_text(str(quote.get("exchDisp", "") or quote.get("exchange", "")))
    note = f"Resolved {raw} to {symbol}"
    if name:
        note += f" ({name})"
    if exchange:
        note += f" on {exchange}"
    note += " using Yahoo Finance global symbol search."
    return symbol, note


def yahoo_search_quote(symbol: str, company: str = "") -> dict[str, object]:
    data = yahoo_search(symbol or company, quotes_count=12, news_count=0)
    quotes = data.get("quotes", []) if isinstance(data, dict) else []
    if not isinstance(quotes, list):
        return {}
    symbol_upper = clean_text(symbol).upper()
    for quote in quotes:
        if isinstance(quote, dict) and clean_text(str(quote.get("symbol", ""))).upper() == symbol_upper:
            return quote
    for quote in quotes:
        if isinstance(quote, dict) and quote.get("quoteType"):
            return quote
    return {}


def market_disclosure_links(series: StockSeries, company: str) -> list[tuple[str, str]]:
    symbol = series.ticker.upper()
    exchange = (series.exchange or "").lower()
    country = (series.country or "").lower()
    query = urllib.parse.quote(company or series.name or series.ticker)
    links: list[tuple[str, str]] = [
        ("Yahoo Finance quote page", series.source_url),
    ]
    if series.website:
        links.append(("Company website / investor relations starting point", series.website))

    def add(label: str, url: str) -> None:
        if url and all(existing_url != url for _, existing_url in links):
            links.append((label, url))

    if "." not in symbol and (country in {"united states", "usa", "us"} or not country):
        add("SEC EDGAR company search", f"https://www.sec.gov/edgar/search/#/q={query}")
    if symbol.endswith(".T") or "tokyo" in exchange or "jpx" in exchange:
        add("Japan EDINET disclosure search", f"https://disclosure2.edinet-fsa.go.jp/WEEK0010.aspx")
        add("JPX listed company search", "https://www.jpx.co.jp/english/listing/co-search/index.html")
    if symbol.endswith(".L") or "london" in exchange:
        add("London Stock Exchange issuer search", f"https://www.londonstockexchange.com/search?query={query}")
        add("UK Companies House search", f"https://find-and-update.company-information.service.gov.uk/search?q={query}")
    if symbol.endswith(".TO") or symbol.endswith(".V") or "toronto" in exchange or country == "canada":
        add("SEDAR+ Canadian filings search", "https://www.sedarplus.ca/")
        add("TMX issuer search", f"https://money.tmx.com/en/search?query={query}")
    if symbol.endswith(".AX") or "australian" in exchange or country == "australia":
        add("ASX announcements search", f"https://www.asx.com.au/markets/company/{urllib.parse.quote(symbol.split('.')[0])}")
    if symbol.endswith(".KS") or symbol.endswith(".KQ") or "korea" in exchange:
        add("Korea DART disclosure search", "https://englishdart.fss.or.kr/")
        add("KRX listed company search", "https://global.krx.co.kr/")
    if symbol.endswith(".HK") or "hong kong" in exchange:
        add("HKEXnews issuer disclosures", "https://www.hkexnews.hk/index.htm")
    if symbol.endswith(".SS") or symbol.endswith(".SZ") or "shanghai" in exchange or "shenzhen" in exchange:
        add("Shanghai Stock Exchange disclosures", "https://english.sse.com.cn/")
        add("Shenzhen Stock Exchange disclosures", "https://www.szse.cn/English/")
    if symbol.endswith(".NS") or symbol.endswith(".BO") or country == "india":
        add("NSE company filings", "https://www.nseindia.com/companies-listing/corporate-filings-announcements")
        add("BSE corporate announcements", "https://www.bseindia.com/corporates/ann.html")
    if symbol.endswith(".PA") or symbol.endswith(".AS") or symbol.endswith(".BR") or symbol.endswith(".DE") or symbol.endswith(".F") or "euronext" in exchange:
        add("Euronext issuer search", f"https://live.euronext.com/en/search_instruments/{query}")
    if symbol.endswith(".SW") or country == "switzerland":
        add("SIX Swiss Exchange issuer search", "https://www.six-group.com/en/products-services/the-swiss-stock-exchange/market-data/shares.html")
    if symbol.endswith(".SA") or country == "brazil":
        add("CVM Brazil filings search", "https://www.gov.br/cvm/pt-br")
        add("B3 listed companies", "https://www.b3.com.br/en_us/products-and-services/trading/equities/listed-companies.htm")
    return links[:10]


def fetch_stock_series(ticker: str, years: int = 5) -> StockSeries | None:
    ticker = clean_text(ticker).upper().replace(" ", "")
    if not ticker or not re.fullmatch(r"[A-Z0-9.^=\-]{1,18}(?:\.[A-Z]{1,4})?", ticker):
        return None
    years = min(max(int(years or 5), 1), 10)
    encoded = urllib.parse.quote(ticker)
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?range={years}y&interval=1wk&events=history"
    try:
        response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=14)
        response.raise_for_status()
        result = response.json()["chart"]["result"][0]
        timestamps = result.get("timestamp", [])
        quote = result.get("indicators", {}).get("quote", [{}])[0]
        closes = quote.get("close", [])
        volumes = quote.get("volume", [])
        meta = result.get("meta", {})
    except Exception:
        return None
    points: list[StockPoint] = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        points.append(StockPoint(datetime.fromtimestamp(int(ts)), float(close)))
    points.sort(key=lambda p: p.date)
    if len(points) < 12:
        return None
    search_quote = yahoo_search_quote(ticker)
    quote_data = fetch_yahoo_quote_data(ticker)
    for key, value in search_quote.items():
        quote_data.setdefault(key, value)
    dividend_yield = yahoo_float(quote_data.get("dividendYield"))
    if dividend_yield is not None and dividend_yield < 1:
        dividend_yield *= 100
    latest_close = points[-1].close if points else None
    prior_close = points[-2].close if len(points) >= 2 else None
    last_52_points = points[-52:] if len(points) >= 52 else points
    derived_52_low = min((p.close for p in last_52_points), default=None)
    derived_52_high = max((p.close for p in last_52_points), default=None)
    valid_volumes = [float(v) for v in volumes[-52:] if isinstance(v, (int, float)) and v > 0]
    derived_avg_volume = sum(valid_volumes) / len(valid_volumes) if valid_volumes else None
    return StockSeries(
        ticker=ticker,
        currency=clean_text(str(quote_data.get("currency") or meta.get("currency", "USD"))),
        points=points,
        source_url=f"https://finance.yahoo.com/quote/{encoded}",
        name=clean_text(str(quote_data.get("longName") or quote_data.get("shortName") or meta.get("longName", "") or meta.get("shortName", ""))),
        exchange=clean_text(str(quote_data.get("fullExchangeName") or quote_data.get("exchDisp") or quote_data.get("exchange") or meta.get("exchangeName", "") or meta.get("fullExchangeName", ""))),
        quote_type=clean_text(str(quote_data.get("quoteType") or quote_data.get("typeDisp") or "")),
        market_region=clean_text(str(quote_data.get("region", ""))),
        regular_market_price=yahoo_float(quote_data.get("regularMarketPrice")) or yahoo_float(quote_data.get("currentPrice")) or latest_close,
        previous_close=yahoo_float(quote_data.get("regularMarketPreviousClose") or quote_data.get("previousClose")) or prior_close,
        day_low=yahoo_float(quote_data.get("regularMarketDayLow") or quote_data.get("dayLow")),
        day_high=yahoo_float(quote_data.get("regularMarketDayHigh") or quote_data.get("dayHigh")),
        fifty_two_week_low=yahoo_float(quote_data.get("fiftyTwoWeekLow")) or derived_52_low,
        fifty_two_week_high=yahoo_float(quote_data.get("fiftyTwoWeekHigh")) or derived_52_high,
        market_cap=yahoo_float(quote_data.get("marketCap")),
        trailing_pe=yahoo_float(quote_data.get("trailingPE")),
        forward_pe=yahoo_float(quote_data.get("forwardPE")),
        price_to_book=yahoo_float(quote_data.get("priceToBook")),
        dividend_yield_pct=dividend_yield,
        beta=yahoo_float(quote_data.get("beta")),
        average_volume=yahoo_float(quote_data.get("averageDailyVolume3Month") or quote_data.get("averageVolume")) or derived_avg_volume,
        shares_outstanding=yahoo_float(quote_data.get("sharesOutstanding")),
        sector=clean_text(str(quote_data.get("sector", ""))),
        industry=clean_text(str(quote_data.get("industry", ""))),
        country=clean_text(str(quote_data.get("country", ""))),
        website=clean_text(str(quote_data.get("website", ""))),
        employees=yahoo_int(quote_data.get("fullTimeEmployees")),
        business_summary=clean_text(str(quote_data.get("longBusinessSummary", "")))[:1200],
    )


def fetch_market_news(symbol: str, company: str, limit: int = 12) -> list[MarketNews]:
    news: list[MarketNews] = []
    seen: set[str] = set()

    def add_item(title: str, publisher: str, link: str, published: datetime | None, summary: str = "") -> None:
        title_clean = clean_text(title)
        link_clean = clean_text(link)
        if not title_clean:
            return
        key = (title_clean[:120] + link_clean).lower()
        if key in seen:
            return
        seen.add(key)
        news.append(MarketNews(title=title_clean, publisher=clean_text(publisher), link=link_clean, published=published, summary=clean_text(summary)))

    data = yahoo_search(symbol or company, quotes_count=0, news_count=limit)
    for item in data.get("news", []) if isinstance(data, dict) else []:
        if not isinstance(item, dict):
            continue
        published = None
        ts = item.get("providerPublishTime")
        if isinstance(ts, (int, float)):
            published = datetime.fromtimestamp(ts)
        add_item(
            str(item.get("title", "")),
            str(item.get("publisher", "")),
            str(item.get("link", "")),
            published,
            str(item.get("summary", "")),
        )

    if len(news) < limit and symbol:
        rss_url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={urllib.parse.quote(symbol)}&region=US&lang=en-US"
        try:
            response = requests.get(rss_url, headers={"User-Agent": USER_AGENT}, timeout=14)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "xml")
            for item in soup.find_all("item"):
                published = None
                pub_date = clean_text(item.pubDate.get_text(" ") if item.pubDate else "")
                if pub_date:
                    try:
                        published = parsedate_to_datetime(pub_date).replace(tzinfo=None)
                    except Exception:
                        published = None
                add_item(
                    item.title.get_text(" ") if item.title else "",
                    "Yahoo Finance RSS",
                    item.link.get_text(" ") if item.link else "",
                    published,
                    item.description.get_text(" ") if item.description else "",
                )
                if len(news) >= limit:
                    break
        except Exception:
            pass
    target_terms = {term for term in normalize_company_name(company).split() if len(term) >= 4}
    symbol_root = (symbol or "").split(".")[0].replace("^", "").lower()
    if symbol_root and not symbol_root.isdigit() and len(symbol_root) >= 3:
        target_terms.add(symbol_root)
    if target_terms:
        relevant = [
            item for item in news
            if any(term in f"{item.title} {item.summary}".lower() for term in target_terms)
        ]
        return relevant[:limit]
    return news[:limit]


def explain_large_moves(series: StockSeries, news: list[MarketNews], limit: int = 4) -> list[MoveCatalyst]:
    returns = weekly_returns(series.points)
    if not returns:
        return []
    stdev = statistics.stdev(returns) if len(returns) > 2 else 0.0
    threshold = max(0.08, stdev * 1.75)
    moves = []
    for index, ret in enumerate(returns, start=1):
        if abs(ret) >= threshold:
            moves.append((abs(ret), ret, series.points[index].date))
    moves.sort(reverse=True, key=lambda item: item[0])
    catalysts: list[MoveCatalyst] = []
    for _, ret, date in moves[:limit]:
        nearby = []
        for item in news:
            if item.published and abs((item.published - date).days) <= 14:
                nearby.append(item)
        if not nearby:
            nearby = news[:3]
        direction = "rose sharply" if ret > 0 else "dropped sharply"
        if nearby:
            headline_text = "; ".join(item.title for item in nearby[:3])
            explanation = (
                f"{series.ticker} {direction} {pct(ret * 100)} in the week ending {date.strftime('%Y-%m-%d')}. "
                f"Nearby/current news that may explain the move includes: {headline_text}. "
                "Treat this as a catalyst hypothesis, not confirmed causation."
            )
        else:
            explanation = (
                f"{series.ticker} {direction} {pct(ret * 100)} in the week ending {date.strftime('%Y-%m-%d')}, "
                "but the news search did not return headlines to support a catalyst read."
            )
        catalysts.append(MoveCatalyst(label=f"{series.ticker} {direction}", date=date, move_pct=ret * 100, explanation=explanation, headlines=nearby[:3]))
    return catalysts


def weekly_returns(points: list[StockPoint]) -> list[float]:
    returns = []
    for prior, now in zip(points, points[1:]):
        if prior.close:
            returns.append(now.close / prior.close - 1)
    return returns


def max_drawdown(points: list[StockPoint]) -> tuple[float, float]:
    peak = points[0].close
    worst = 0.0
    current = 0.0
    for point in points:
        peak = max(peak, point.close)
        current = point.close / peak - 1 if peak else 0.0
        worst = min(worst, current)
    return worst * 100, current * 100


def compute_metrics(series: StockSeries) -> StockMetrics:
    points = series.points
    current = points[-1].close
    start = points[0].close
    total_return = (current / start - 1) * 100 if start else 0.0
    days = max((points[-1].date - points[0].date).days, 1)
    cagr = ((current / start) ** (365 / days) - 1) * 100 if start else 0.0
    returns = weekly_returns(points)
    volatility = statistics.stdev(returns) * math.sqrt(52) * 100 if len(returns) > 2 else 0.0
    sharpe_like = (cagr / volatility) if volatility else 0.0
    worst_dd, curr_dd = max_drawdown(points)
    positives = [r for r in returns if r > 0]
    positive_week_pct = len(positives) / len(returns) * 100 if returns else 0.0
    best_week = max(returns) * 100 if returns else 0.0
    worst_week = min(returns) * 100 if returns else 0.0
    by_year: dict[int, list[StockPoint]] = {}
    for p in points:
        by_year.setdefault(p.date.year, []).append(p)
    annual_returns: dict[int, float] = {}
    for year, year_points in sorted(by_year.items()):
        if len(year_points) >= 2 and year_points[0].close:
            annual_returns[year] = (year_points[-1].close / year_points[0].close - 1) * 100
    last_40 = points[-40:] if len(points) >= 40 else points
    ma_40 = sum(p.close for p in last_40) / len(last_40)
    if current > ma_40 * 1.08:
        trend = "Strong uptrend: price is well above the roughly 40-week moving average."
    elif current > ma_40 * 1.03:
        trend = "Moderate uptrend: price is above the roughly 40-week moving average."
    elif current < ma_40 * 0.92:
        trend = "Strong downtrend: price is well below the roughly 40-week moving average."
    elif current < ma_40 * 0.97:
        trend = "Moderate downtrend: price is below the roughly 40-week moving average."
    else:
        trend = "Sideways / mixed: price is close to the roughly 40-week moving average."
    return StockMetrics(
        ticker=series.ticker,
        currency=series.currency,
        latest_price=current,
        start_price=start,
        high_price=max(p.close for p in points),
        low_price=min(p.close for p in points),
        total_return_pct=total_return,
        cagr_pct=cagr,
        volatility_pct=volatility,
        sharpe_like=sharpe_like,
        max_drawdown_pct=worst_dd,
        current_drawdown_pct=curr_dd,
        best_week_pct=best_week,
        worst_week_pct=worst_week,
        positive_week_pct=positive_week_pct,
        weeks=len(points),
        trend_label=trend,
        ma_40=ma_40,
        annual_returns=annual_returns,
    )


def indexed_points(series: StockSeries) -> list[tuple[datetime, float]]:
    first = series.points[0].close or 1
    return [(p.date, p.close / first * 100) for p in series.points]


def drawdown_points(series: StockSeries) -> list[tuple[datetime, float]]:
    peak = series.points[0].close
    out = []
    for p in series.points:
        peak = max(peak, p.close)
        out.append((p.date, (p.close / peak - 1) * 100 if peak else 0.0))
    return out


def svg_polyline(points: list[tuple[datetime, float]], width: int, height: int, left: int, right: int, top: int, bottom: int, low: float, high: float) -> str:
    if not points:
        return ""
    span = high - low or 1
    step = (width - left - right) / max(len(points) - 1, 1)
    coords = []
    for i, (_, value) in enumerate(points):
        x = left + i * step
        y = top + (high - value) / span * (height - top - bottom)
        coords.append(f"{x:.1f},{y:.1f}")
    return " ".join(coords)


def clamp_rate(rate_pct: float) -> float:
    # Guardrail so volatility math does not create impossible below-zero prices.
    return max(rate_pct, -90.0)


def build_growth_scenarios(metrics: StockMetrics) -> list[GrowthScenario]:
    # Historical-trend scenario math. This is not a prediction.
    # Base case uses pulled-period CAGR. Bear/bull flex around that using volatility.
    scenario_rates = [
        ("Bear case", clamp_rate(metrics.cagr_pct - 0.50 * metrics.volatility_pct)),
        ("Base trend", clamp_rate(metrics.cagr_pct)),
        ("Bull case", clamp_rate(metrics.cagr_pct + 0.50 * metrics.volatility_pct)),
    ]
    horizons = [1, 3, 5, 10]
    scenarios: list[GrowthScenario] = []
    for label, annual_rate in scenario_rates:
        prices: dict[int, float] = {}
        returns: dict[int, float] = {}
        factor = 1 + annual_rate / 100
        for years in horizons:
            projected_price = metrics.latest_price * (factor ** years) if factor > 0 else 0.0
            prices[years] = projected_price
            returns[years] = (projected_price / metrics.latest_price - 1) * 100 if metrics.latest_price else 0.0
        scenarios.append(GrowthScenario(label=label, annual_rate_pct=annual_rate, projected_prices=prices, projected_returns=returns))
    return scenarios


def scenario_read(metrics: StockMetrics, scenarios: list[GrowthScenario]) -> str:
    bear = next((s for s in scenarios if s.label == "Bear case"), None)
    base = next((s for s in scenarios if s.label == "Base trend"), None)
    bull = next((s for s in scenarios if s.label == "Bull case"), None)
    if not (bear and base and bull):
        return "Scenario model unavailable."
    return (
        f"Using the stock's pulled history, the 1-year trend range is about "
        f"{pct(bear.projected_returns[1])} to {pct(bull.projected_returns[1])}, "
        f"with the base trend at {pct(base.projected_returns[1])}. "
        f"The 5-year historical-trend range is about {pct(bear.projected_returns[5])} to {pct(bull.projected_returns[5])}. "
        f"The 10-year historical-trend stress range is about {pct(bear.projected_returns[10])} to {pct(bull.projected_returns[10])}. "
        f"This is not a prediction; it is a stress-test based on past CAGR and volatility."
    )


def make_forecast_svg(metrics: StockMetrics, scenarios: list[GrowthScenario], path: Path, title: str) -> None:
    width, height = 980, 390
    left, right, top, bottom = 70, 190, 44, 52
    years = [0, 1, 3, 5, 10]
    palette = ["#8a4a2f", "#146c5f", "#1f5e9d"]
    series_values = []
    for scenario in scenarios:
        rate = 1 + scenario.annual_rate_pct / 100
        vals = [metrics.latest_price * (rate ** year) if rate > 0 else 0.0 for year in years]
        series_values.append((scenario, vals))
    all_values = [v for _, vals in series_values for v in vals] + [metrics.latest_price]
    low, high = min(all_values), max(all_values)
    if low == high:
        high = low + 1
    plot_w = width - left - right
    plot_h = height - top - bottom

    def x_for(i: int) -> float:
        return left + i / (len(years) - 1) * plot_w

    def y_for(v: float) -> float:
        return top + (high - v) / (high - low) * plot_h

    lines = []
    legends = []
    for idx, (scenario, vals) in enumerate(series_values):
        color = palette[idx % len(palette)]
        coords = " ".join(f"{x_for(i):.1f},{y_for(v):.1f}" for i, v in enumerate(vals))
        lines.append(f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>')
        y = top + 25 + idx * 26
        legends.append(f'<rect x="{width-right+25}" y="{y-10}" width="14" height="4" fill="{color}"/><text x="{width-right+46}" y="{y}" font-family="Arial" font-size="13" fill="#16211f">{html.escape(scenario.label)} ({scenario.annual_rate_pct:+.1f}%/yr)</text>')
    x_labels = "".join(f'<text x="{x_for(i):.1f}" y="{height-18}" text-anchor="middle" font-family="Arial" font-size="12" fill="#5e6c68">+{year}Y</text>' for i, year in enumerate(years))
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="{left}" y="26" font-family="Arial" font-size="18" font-weight="700" fill="#16211f">{html.escape(title)}</text>
  <line x1="{left}" y1="{height-bottom}" x2="{width-right}" y2="{height-bottom}" stroke="#d8dfdc"/>
  <line x1="{left}" y1="{top}" x2="{left}" y2="{height-bottom}" stroke="#d8dfdc"/>
  <text x="8" y="{top+6}" font-family="Arial" font-size="12" fill="#5e6c68">{high:,.0f}</text>
  <text x="8" y="{height-bottom}" font-family="Arial" font-size="12" fill="#5e6c68">{low:,.0f}</text>
  <text x="{left}" y="{height-34}" font-family="Arial" font-size="12" fill="#5e6c68">Projected years from latest close</text>
  {x_labels}
  {''.join(lines)}
  {''.join(legends)}
</svg>"""
    path.write_text(svg, encoding="utf-8")


def make_line_svg(series: StockSeries, path: Path, title: str, y_label: str) -> None:
    width, height = 980, 360
    left, right, top, bottom = 62, 28, 44, 48
    values = [p.close for p in series.points]
    low, high = min(values), max(values)
    coords = svg_polyline([(p.date, p.close) for p in series.points], width, height, left, right, top, bottom, low, high)
    first_date = series.points[0].date.strftime("%Y")
    last_date = series.points[-1].date.strftime("%Y")
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="{left}" y="26" font-family="Arial" font-size="18" font-weight="700" fill="#16211f">{html.escape(title)}</text>
  <line x1="{left}" y1="{height-bottom}" x2="{width-right}" y2="{height-bottom}" stroke="#d8dfdc"/>
  <line x1="{left}" y1="{top}" x2="{left}" y2="{height-bottom}" stroke="#d8dfdc"/>
  <text x="8" y="{top+6}" font-family="Arial" font-size="12" fill="#5e6c68">{high:,.0f}</text>
  <text x="8" y="{height-bottom}" font-family="Arial" font-size="12" fill="#5e6c68">{low:,.0f}</text>
  <text x="{left}" y="{height-14}" font-family="Arial" font-size="12" fill="#5e6c68">{first_date}</text>
  <text x="{width-right-34}" y="{height-14}" font-family="Arial" font-size="12" fill="#5e6c68">{last_date}</text>
  <text x="{left}" y="{height-30}" font-family="Arial" font-size="12" fill="#5e6c68">{html.escape(y_label)}</text>
  <polyline points="{coords}" fill="none" stroke="#146c5f" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
</svg>"""
    path.write_text(svg, encoding="utf-8")


def make_multi_index_svg(series_list: list[StockSeries], path: Path, title: str) -> None:
    width, height = 980, 390
    left, right, top, bottom = 62, 190, 44, 48
    indexed = [(s, indexed_points(s)) for s in series_list]
    all_values = [v for _, pts in indexed for _, v in pts]
    low, high = (min(all_values), max(all_values)) if all_values else (0, 1)
    palette = ["#146c5f", "#7a4d9a", "#b45f06", "#1f5e9d", "#7a7a22", "#8b2f4a"]
    polylines = []
    legends = []
    for idx, (series, pts) in enumerate(indexed[:6]):
        color = palette[idx % len(palette)]
        coords = svg_polyline(pts, width, height, left, right, top, bottom, low, high)
        polylines.append(f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>')
        y = top + 25 + idx * 23
        legends.append(f'<rect x="{width-right+25}" y="{y-10}" width="14" height="4" fill="{color}"/><text x="{width-right+46}" y="{y}" font-family="Arial" font-size="13" fill="#16211f">{html.escape(series.ticker)}</text>')
    first_date = series_list[0].points[0].date.strftime("%Y") if series_list else ""
    last_date = series_list[0].points[-1].date.strftime("%Y") if series_list else ""
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="{left}" y="26" font-family="Arial" font-size="18" font-weight="700" fill="#16211f">{html.escape(title)}</text>
  <line x1="{left}" y1="{height-bottom}" x2="{width-right}" y2="{height-bottom}" stroke="#d8dfdc"/>
  <line x1="{left}" y1="{top}" x2="{left}" y2="{height-bottom}" stroke="#d8dfdc"/>
  <text x="8" y="{top+6}" font-family="Arial" font-size="12" fill="#5e6c68">{high:,.0f}</text>
  <text x="8" y="{height-bottom}" font-family="Arial" font-size="12" fill="#5e6c68">{low:,.0f}</text>
  <text x="{left}" y="{height-14}" font-family="Arial" font-size="12" fill="#5e6c68">{first_date}</text>
  <text x="{width-right-34}" y="{height-14}" font-family="Arial" font-size="12" fill="#5e6c68">{last_date}</text>
  <text x="{left}" y="{height-30}" font-family="Arial" font-size="12" fill="#5e6c68">Indexed to 100 at start</text>
  {''.join(polylines)}
  {''.join(legends)}
</svg>"""
    path.write_text(svg, encoding="utf-8")


def make_drawdown_svg(series: StockSeries, path: Path, title: str) -> None:
    width, height = 980, 330
    left, right, top, bottom = 62, 28, 44, 48
    pts = drawdown_points(series)
    low = min(v for _, v in pts) if pts else -1
    high = 0.0
    coords = svg_polyline(pts, width, height, left, right, top, bottom, low, high)
    first_date = series.points[0].date.strftime("%Y")
    last_date = series.points[-1].date.strftime("%Y")
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="{left}" y="26" font-family="Arial" font-size="18" font-weight="700" fill="#16211f">{html.escape(title)}</text>
  <line x1="{left}" y1="{top}" x2="{width-right}" y2="{top}" stroke="#d8dfdc"/>
  <line x1="{left}" y1="{height-bottom}" x2="{width-right}" y2="{height-bottom}" stroke="#d8dfdc"/>
  <line x1="{left}" y1="{top}" x2="{left}" y2="{height-bottom}" stroke="#d8dfdc"/>
  <text x="8" y="{top+6}" font-family="Arial" font-size="12" fill="#5e6c68">0%</text>
  <text x="8" y="{height-bottom}" font-family="Arial" font-size="12" fill="#5e6c68">{low:.0f}%</text>
  <text x="{left}" y="{height-14}" font-family="Arial" font-size="12" fill="#5e6c68">{first_date}</text>
  <text x="{width-right-34}" y="{height-14}" font-family="Arial" font-size="12" fill="#5e6c68">{last_date}</text>
  <polyline points="{coords}" fill="none" stroke="#8a4a2f" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
</svg>"""
    path.write_text(svg, encoding="utf-8")


def make_bar_svg(values: dict[int, float], path: Path, title: str) -> None:
    width, height = 980, 360
    left, right, top, bottom = 62, 28, 44, 62
    items = list(values.items())[-8:]
    if not items:
        path.write_text("", encoding="utf-8")
        return
    max_abs = max(abs(v) for _, v in items) or 1
    zero_y = top + (height - top - bottom) / 2
    bar_gap = 18
    bar_width = (width - left - right - bar_gap * (len(items) - 1)) / len(items)
    scale = (height - top - bottom) / 2 / max_abs
    bars = []
    for index, (year, value) in enumerate(items):
        x = left + index * (bar_width + bar_gap)
        bar_h = abs(value) * scale
        y = zero_y - bar_h if value >= 0 else zero_y
        bars.append(f"""
  <rect x="{x:.1f}" y="{y:.1f}" width="{bar_width:.1f}" height="{bar_h:.1f}" fill="#146c5f" opacity="0.86"/>
  <text x="{x + bar_width/2:.1f}" y="{height-28}" text-anchor="middle" font-family="Arial" font-size="12" fill="#5e6c68">{year}</text>
  <text x="{x + bar_width/2:.1f}" y="{y-7 if value >= 0 else y+bar_h+16:.1f}" text-anchor="middle" font-family="Arial" font-size="12" fill="#16211f">{value:+.0f}%</text>""")
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="{left}" y="26" font-family="Arial" font-size="18" font-weight="700" fill="#16211f">{html.escape(title)}</text>
  <line x1="{left}" y1="{zero_y:.1f}" x2="{width-right}" y2="{zero_y:.1f}" stroke="#d8dfdc"/>
  {''.join(bars)}
</svg>"""
    path.write_text(svg, encoding="utf-8")


def fetch_market_analysis(company: str, ticker: str, peer_tickers: str, benchmark_ticker: str, years: int) -> MarketAnalysis | None:
    resolved_symbol, symbol_note = resolve_market_symbol(company, ticker)
    target = fetch_stock_series(resolved_symbol, years) if resolved_symbol else None
    if not target:
        return None
    likely_non_us = (
        "." in target.ticker
        or (target.country and target.country.lower() not in {"united states", "usa", "us"})
        or (target.currency and target.currency.upper() not in {"USD", "USX"})
    )
    if likely_non_us:
        international_note = (
            "This appears to be a non-U.S. or cross-market listing, so the app uses Yahoo Finance for quote, exchange, "
            "currency, valuation, trading-range, profile, performance, peer, benchmark, and news-catalyst data. "
            "SEC 10-Q data is only expected when the company has U.S. SEC reporting obligations."
        )
    else:
        international_note = (
            "This appears to be a U.S. market listing. The app combines SEC filing pulls when available with Yahoo Finance market data."
        )
    target_metrics = compute_metrics(target)
    peer_list = []
    seen = {target.ticker}
    for raw in re.split(r"[,\s]+", peer_tickers or ""):
        raw = raw.strip().upper()
        if raw and raw not in seen:
            seen.add(raw)
            series = fetch_stock_series(raw, years)
            if series:
                peer_list.append(series)
        if len(peer_list) >= 4:
            break
    benchmark = None
    if benchmark_ticker:
        benchmark_symbol, _ = resolve_market_symbol("", benchmark_ticker)
        benchmark = fetch_stock_series(benchmark_symbol or benchmark_ticker, years)
    peer_metrics = [compute_metrics(s) for s in peer_list]
    market_news = fetch_market_news(target.ticker, company)
    move_catalysts = explain_large_moves(target, market_news)
    disclosure_links = market_disclosure_links(target, company)
    safe = re.sub(r"[^A-Z0-9_.-]+", "_", target.ticker)
    price_chart = OUTPUT_DIR / f"{safe}_price.svg"
    indexed_chart = OUTPUT_DIR / f"{safe}_indexed_compare.svg"
    drawdown_chart = OUTPUT_DIR / f"{safe}_drawdown.svg"
    annual_chart = OUTPUT_DIR / f"{safe}_annual_returns.svg"
    forecast_chart = OUTPUT_DIR / f"{safe}_growth_loss_scenarios.svg"
    scenarios = build_growth_scenarios(target_metrics)
    make_line_svg(target, price_chart, f"{target.ticker} weekly closing price", "Close")
    compare_series = [target] + peer_list + ([benchmark] if benchmark else [])
    make_multi_index_svg(compare_series, indexed_chart, f"Indexed performance comparison")
    make_drawdown_svg(target, drawdown_chart, f"{target.ticker} drawdown from prior high")
    make_bar_svg(target_metrics.annual_returns, annual_chart, f"{target.ticker} annual returns")
    make_forecast_svg(target_metrics, scenarios, forecast_chart, f"{target.ticker} potential growth / loss scenarios")
    return MarketAnalysis(
        target=target,
        target_metrics=target_metrics,
        benchmark=benchmark,
        peers=peer_list,
        peer_metrics=peer_metrics,
        market_news=market_news,
        move_catalysts=move_catalysts,
        symbol_note=symbol_note,
        international_note=international_note,
        disclosure_links=disclosure_links,
        price_chart_path=f"/outputs/{price_chart.name}",
        indexed_chart_path=f"/outputs/{indexed_chart.name}",
        drawdown_chart_path=f"/outputs/{drawdown_chart.name}",
        annual_chart_path=f"/outputs/{annual_chart.name}",
        forecast_chart_path=f"/outputs/{forecast_chart.name}",
        scenarios=scenarios,
        source_note="Yahoo Finance chart API. Market data is unaudited public market data and should be checked before investment use.",
    )


def make_figure_table(figures: list[Figure], category_filter: str | None = None, limit: int = 20) -> str:
    rows = []
    selected = figures
    if category_filter:
        selected = [fig for fig in figures if fig.category == category_filter]
    for index, fig in enumerate(selected[:limit], start=1):
        source = f"[{md_cell(fig.source_label)}]({fig.source_url})" if fig.source_url.startswith("http") else md_cell(fig.source_label)
        rows.append(
            f"| F{index} | {md_cell(fig.value, 80)} | {md_cell(fig.category, 100)} | {md_cell(fig.context, 460)} | {source} | {md_cell(fig.quality_note, 220)} |"
        )
    return "\n".join(rows) or "| - | Not disclosed | - | No source-backed figure found | - | - |"


def bullet_block(items: list[str], fallback: str) -> str:
    if not items:
        return f"- {fallback}"
    return "\n".join(f"- {item}" for item in items)


def yahoo_detail_rows(series: StockSeries) -> str:
    rows = [
        ("Company / instrument", series.name or series.ticker),
        ("Yahoo symbol", series.ticker),
        ("Quote type", series.quote_type or "Not available"),
        ("Exchange", series.exchange or "Not available"),
        ("Country", series.country or "Not available"),
        ("Currency", series.currency or "Not available"),
        ("Sector", series.sector or "Not available"),
        ("Industry", series.industry or "Not available"),
        ("Latest Yahoo quote", money(series.regular_market_price, series.currency) if series.regular_market_price is not None else "Not available"),
        ("Previous close", money(series.previous_close, series.currency) if series.previous_close is not None else "Not available"),
        ("Day range", f"{money(series.day_low, series.currency)} to {money(series.day_high, series.currency)}" if series.day_low is not None and series.day_high is not None else "Not available"),
        ("52-week range", f"{money(series.fifty_two_week_low, series.currency)} to {money(series.fifty_two_week_high, series.currency)}" if series.fifty_two_week_low is not None and series.fifty_two_week_high is not None else "Not available"),
        ("Market capitalization", compact_money(series.market_cap, series.currency)),
        ("Trailing P/E", fmt_ratio(series.trailing_pe)),
        ("Forward P/E", fmt_ratio(series.forward_pe)),
        ("Price / book", fmt_ratio(series.price_to_book)),
        ("Dividend yield", fmt_pct_plain(series.dividend_yield_pct)),
        ("Beta", fmt_ratio(series.beta).replace("x", "")),
        ("Average volume", fmt_number(series.average_volume)),
        ("Shares outstanding", fmt_number(series.shares_outstanding)),
        ("Employees", fmt_number(series.employees)),
        ("Website", f"[{md_cell(series.website, 80)}]({series.website})" if series.website.startswith("http") else (series.website or "Not available")),
    ]
    return "\n".join(f"| {md_cell(label, 120)} | {md_cell(value, 260)} |" for label, value in rows)


def trading_snapshot_rows(series: StockSeries) -> str:
    move_from_prev = None
    if series.regular_market_price is not None and series.previous_close:
        move_from_prev = (series.regular_market_price / series.previous_close - 1) * 100
    rows = [
        ("Currently trading at", money(series.regular_market_price, series.currency) if series.regular_market_price is not None else "Not available"),
        ("Currency", series.currency or "Not available"),
        ("Exchange", series.exchange or "Not available"),
        ("Instrument type", series.quote_type or "Not available"),
        ("Previous close", money(series.previous_close, series.currency) if series.previous_close is not None else "Not available"),
        ("Move vs previous close", pct(move_from_prev) if move_from_prev is not None else "Not available"),
        ("Day range", f"{money(series.day_low, series.currency)} to {money(series.day_high, series.currency)}" if series.day_low is not None and series.day_high is not None else "Not available"),
        ("52-week range", f"{money(series.fifty_two_week_low, series.currency)} to {money(series.fifty_two_week_high, series.currency)}" if series.fifty_two_week_low is not None and series.fifty_two_week_high is not None else "Not available"),
        ("Average volume", fmt_number(series.average_volume)),
        ("Market cap", compact_money(series.market_cap, series.currency)),
        ("Sector / industry", f"{series.sector or 'Not available'} / {series.industry or 'Not available'}"),
    ]
    return "\n".join(f"| {md_cell(label, 120)} | {md_cell(value, 240)} |" for label, value in rows)


def disclosure_link_rows(links: list[tuple[str, str]]) -> str:
    if not links:
        return "| - | No public disclosure links were identified. | - |"
    rows = []
    for label, url in links:
        rows.append(f"| {md_cell(label, 180)} | [{md_cell(url, 90)}]({url}) |")
    return "\n".join(rows)


def median(values: list[float]) -> float | None:
    clean = sorted(v for v in values if v is not None and v > 0)
    if not clean:
        return None
    mid = len(clean) // 2
    if len(clean) % 2:
        return clean[mid]
    return (clean[mid - 1] + clean[mid]) / 2


def standalone_pe_read(pe: float | None) -> str:
    if pe is None or pe <= 0:
        return "P/E not available or not meaningful; company may be loss-making or Yahoo did not disclose the field."
    if pe < 12:
        return "Low P/E: potentially inexpensive, but check whether earnings are cyclical, declining, or unusually high."
    if pe <= 25:
        return "Moderate P/E: valuation is not obviously stretched on earnings alone."
    if pe <= 40:
        return "High P/E: investors are paying a premium for growth, quality, scarcity, or margin expansion."
    return "Very high P/E: potentially overvalued unless growth, margins, and durability strongly support the premium."


def standalone_pb_read(pb: float | None, industry: str = "") -> str:
    if pb is None or pb <= 0:
        return "P/B not available or not meaningful from Yahoo."
    lowered = industry.lower()
    asset_heavy = any(term in lowered for term in ["bank", "insurance", "reit", "real estate", "utility", "industrial", "auto", "manufacturer"])
    if pb < 1:
        return "Below book value: can signal cheap assets, distress, weak returns, or balance-sheet skepticism."
    if pb <= 3:
        return "Moderate P/B: generally not stretched, especially for asset-heavy businesses." if asset_heavy else "Moderate P/B: not obviously stretched, but less decisive for asset-light companies."
    if pb <= 8:
        return "High P/B: market is assigning a premium to returns, brand, growth, or intangible assets."
    return "Very high P/B: potentially overvalued unless return on equity, margins, and growth are exceptional."


def valuation_assessment(market: MarketAnalysis | None) -> list[str]:
    if not market:
        return ["No market valuation data was available."]
    target = market.target
    peer_pe = [peer.trailing_pe for peer in market.peers if peer.trailing_pe and peer.trailing_pe > 0]
    peer_pb = [peer.price_to_book for peer in market.peers if peer.price_to_book and peer.price_to_book > 0]
    peer_pe_median = median(peer_pe)
    peer_pb_median = median(peer_pb)
    bullets = [
        f"P/E read: {fmt_ratio(target.trailing_pe)}. {standalone_pe_read(target.trailing_pe)}",
        f"P/B read: {fmt_ratio(target.price_to_book)}. {standalone_pb_read(target.price_to_book, target.industry)}",
    ]
    if peer_pe_median:
        premium = ((target.trailing_pe / peer_pe_median - 1) * 100) if target.trailing_pe else None
        if premium is not None:
            bullets.append(f"Peer P/E comparison: target P/E is {pct(premium)} versus peer median P/E of {peer_pe_median:.2f}x.")
    else:
        bullets.append("Peer P/E comparison: peer P/E data was not available from Yahoo; add peer tickers to improve this read.")
    if peer_pb_median:
        premium = ((target.price_to_book / peer_pb_median - 1) * 100) if target.price_to_book else None
        if premium is not None:
            bullets.append(f"Peer P/B comparison: target P/B is {pct(premium)} versus peer median P/B of {peer_pb_median:.2f}x.")
    else:
        bullets.append("Peer P/B comparison: peer P/B data was not available from Yahoo; add peer tickers to improve this read.")

    overvaluation_signals = 0
    if target.trailing_pe and target.trailing_pe > 30:
        overvaluation_signals += 1
    if target.price_to_book and target.price_to_book > 5:
        overvaluation_signals += 1
    if peer_pe_median and target.trailing_pe and target.trailing_pe > peer_pe_median * 1.3:
        overvaluation_signals += 1
    if peer_pb_median and target.price_to_book and target.price_to_book > peer_pb_median * 1.3:
        overvaluation_signals += 1
    if market.target_metrics.cagr_pct < 0 and (target.trailing_pe and target.trailing_pe > 20):
        overvaluation_signals += 1

    if overvaluation_signals >= 3:
        conclusion = "Valuation conclusion: potentially overvalued on available Yahoo P/E/P/B and market-performance evidence. Confirm with growth, margins, ROE, and forward guidance before relying on this."
    elif overvaluation_signals == 2:
        conclusion = "Valuation conclusion: valuation looks demanding, but not enough evidence to call it clearly overvalued without peer/growth/margin confirmation."
    elif overvaluation_signals == 1:
        conclusion = "Valuation conclusion: one valuation warning is present; treat as a diligence question rather than a firm overvaluation call."
    else:
        conclusion = "Valuation conclusion: available P/E/P/B data does not show obvious overvaluation, but missing data or weak future growth could change that."
    bullets.append(conclusion)
    bullets.append("Important caveat: P/E and P/B are incomplete by themselves. For banks/insurers, P/B and ROE matter more; for software/asset-light companies, P/B can look high without proving overvaluation; for cyclical companies, low P/E can be a value trap near peak earnings.")
    return bullets


def valuation_rows(market: MarketAnalysis) -> str:
    target = market.target
    peer_pe_median = median([peer.trailing_pe for peer in market.peers if peer.trailing_pe and peer.trailing_pe > 0])
    peer_pb_median = median([peer.price_to_book for peer in market.peers if peer.price_to_book and peer.price_to_book > 0])
    rows = [
        ("Trailing P/E", fmt_ratio(target.trailing_pe), f"Peer median: {peer_pe_median:.2f}x" if peer_pe_median else "Peer median unavailable"),
        ("Forward P/E", fmt_ratio(target.forward_pe), "Forward estimate from Yahoo when available"),
        ("Price / book", fmt_ratio(target.price_to_book), f"Peer median: {peer_pb_median:.2f}x" if peer_pb_median else "Peer median unavailable"),
        ("Market cap", compact_money(target.market_cap, target.currency), "Yahoo Finance market capitalization"),
        ("Dividend yield", fmt_pct_plain(target.dividend_yield_pct), "Yield can support valuation if payout is sustainable"),
        ("Beta", fmt_ratio(target.beta).replace("x", ""), "Higher beta usually means higher equity-risk discount needed"),
    ]
    return "\n".join(f"| {md_cell(label, 120)} | {md_cell(value, 120)} | {md_cell(note, 260)} |" for label, value, note in rows)


def liquidity_value(series: StockSeries) -> float | None:
    if series.regular_market_price is None or series.average_volume is None:
        return None
    return series.regular_market_price * series.average_volume


def is_consumable_stock(series: StockSeries) -> bool:
    text = f"{series.sector} {series.industry} {series.business_summary}".lower()
    terms = [
        "consumer defensive", "consumer cyclical", "food", "beverage", "tobacco", "household", "personal",
        "grocery", "retail", "apparel", "luxury", "automotive", "restaurant", "staples", "cosmetics",
    ]
    return any(term in text for term in terms)


def overvaluation_score(series: StockSeries, metrics: StockMetrics, spy_metrics: StockMetrics | None) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    if series.trailing_pe and series.trailing_pe > 30:
        score += 2
        reasons.append(f"high trailing P/E of {series.trailing_pe:.2f}x")
    elif series.trailing_pe and series.trailing_pe > 22:
        score += 1
        reasons.append(f"elevated trailing P/E of {series.trailing_pe:.2f}x")
    if series.price_to_book and series.price_to_book > 6:
        score += 2
        reasons.append(f"high P/B of {series.price_to_book:.2f}x")
    elif series.price_to_book and series.price_to_book > 3.5:
        score += 1
        reasons.append(f"elevated P/B of {series.price_to_book:.2f}x")
    if metrics.cagr_pct < 0:
        score += 1
        reasons.append(f"negative pulled-period CAGR of {pct(metrics.cagr_pct)}")
    if metrics.max_drawdown_pct <= -35:
        score += 1
        reasons.append(f"major max drawdown of {metrics.max_drawdown_pct:.1f}%")
    if metrics.volatility_pct >= 30:
        score += 1
        reasons.append(f"high annualized volatility of {metrics.volatility_pct:.1f}%")
    if spy_metrics and metrics.total_return_pct < spy_metrics.total_return_pct:
        score += 1
        reasons.append(f"underperformed SPY by {spy_metrics.total_return_pct - metrics.total_return_pct:.1f} percentage points over the pulled period")
    if not reasons:
        reasons.append("no strong overvaluation signal from Yahoo P/E/P/B and market data")
    return score, reasons


def shortability_read(series: StockSeries) -> str:
    liq = liquidity_value(series)
    if liq is None:
        return "Liquidity unknown; verify borrow availability and trading volume with broker."
    if liq >= 100_000_000:
        return "Very liquid by Yahoo price x volume screen; likely easier to trade, but borrow availability still must be checked."
    if liq >= 25_000_000:
        return "Moderately liquid by Yahoo price x volume screen; check spreads, local market hours, and borrow."
    return "Lower liquidity by Yahoo price x volume screen; may be harder or costly to short."


def run_country_screener(country: str, years: int = 3) -> list[dict[str, object]]:
    country = country if country in COUNTRY_MARKET_UNIVERSES else ""
    if not country:
        return []
    spy = fetch_stock_series("SPY", years)
    spy_metrics = compute_metrics(spy) if spy else None
    rows: list[dict[str, object]] = []
    for symbol in COUNTRY_MARKET_UNIVERSES[country]:
        series = fetch_stock_series(symbol, years)
        if not series:
            continue
        metrics = compute_metrics(series)
        if not is_consumable_stock(series):
            # Keep very liquid retailers/consumer names even when Yahoo sector text is sparse.
            summary_text = f"{series.name} {series.industry}".lower()
            if not any(term in summary_text for term in ["retail", "food", "beverage", "consumer", "auto", "apparel", "tobacco", "grocery"]):
                continue
        has_pe_pb = bool(series.trailing_pe and series.trailing_pe > 0 and series.price_to_book and series.price_to_book > 0)
        if has_pe_pb:
            score, reasons = overvaluation_score(series, metrics, spy_metrics)
        else:
            score, reasons = 0, ["P/E and/or P/B unavailable from Yahoo public data; cannot rank as overvalued without licensed fundamentals."]
        rows.append(
            {
                "Country": country,
                "Ticker": series.ticker,
                "Name": series.name or series.ticker,
                "Exchange": series.exchange,
                "Currency": series.currency,
                "Sector": series.sector,
                "Industry": series.industry,
                "Price": series.regular_market_price,
                "Market Cap": series.market_cap,
                "Avg Volume": series.average_volume,
                "Liquidity Value": liquidity_value(series),
                "Trailing PE": series.trailing_pe,
                "Forward PE": series.forward_pe,
                "Price To Book": series.price_to_book,
                "P/E and P/B Available": "Yes" if has_pe_pb else "No",
                "Dividend Yield %": series.dividend_yield_pct,
                "Beta": series.beta,
                "1Y Return %": period_return(series.points, 1),
                "3Y Return %": period_return(series.points, 3),
                "CAGR %": metrics.cagr_pct,
                "Volatility %": metrics.volatility_pct,
                "Max Drawdown %": metrics.max_drawdown_pct,
                "SPY Comparison": f"{metrics.total_return_pct - spy_metrics.total_return_pct:+.1f} pp vs SPY" if spy_metrics else "SPY unavailable",
                "Overvaluation Score": score,
                "Overvaluation Reasons": "; ".join(reasons),
                "Shortability / Liquidity Read": shortability_read(series),
                "Western Market Comparison": "Compared to SPY as U.S. western-market benchmark; add QQQ/VGK manually for deeper cross-market work.",
                "S&P Global Placeholder": "Requires licensed S&P Global Market Intelligence / Capital IQ / Compustat access; not scraped by this app.",
                "Yahoo URL": series.source_url,
            }
        )
    rows.sort(key=lambda row: (float(row.get("Overvaluation Score") or 0), float(row.get("Liquidity Value") or 0)), reverse=True)
    SCREENER_STATE["country"] = country
    SCREENER_STATE["rows"] = rows
    return rows


def screener_rows_markdown(rows: list[dict[str, object]], limit: int = 12) -> str:
    if not rows:
        return "| - | No screened stocks found. Select a country with a supported liquid consumer universe. | - | - | - | - | - |"
    out = []
    for row in rows[:limit]:
        out.append(
            f"| {md_cell(row.get('Ticker'), 80)} | {md_cell(row.get('Name'), 160)} | {fmt_ratio(yahoo_float(row.get('Trailing PE')))} | {fmt_ratio(yahoo_float(row.get('Price To Book')))} | {compact_money(yahoo_float(row.get('Liquidity Value')), str(row.get('Currency') or ''))} | {md_cell(row.get('P/E and P/B Available'), 40)} | {md_cell(row.get('Overvaluation Score'), 40)} | {md_cell(row.get('Overvaluation Reasons'), 320)} |"
        )
    return "\n".join(out)


def screener_section(country: str, rows: list[dict[str, object]]) -> str:
    if not country:
        return ""
    return f"""
## Country Overvaluation / Short Candidate Screener: {country}
This screen focuses on liquid consumer/consumables stocks and requires both P/E and P/B to rank a stock. It uses Yahoo Finance public fields by default. S&P Global Market Intelligence, Capital IQ, and Compustat data are licensed datasets, so this app does not scrape them or invent S&P values.

Western-market comparison: SPY is used as the default U.S. benchmark. For a fuller western comparison, review SPY, QQQ, and VGK against local market benchmarks.

Excel export: [Download screener workbook](/download_screener.xlsx)

| Ticker | Company | P/E | P/B | Liquidity Value | P/E + P/B? | Overvaluation Score | Why Flagged |
| --- | --- | --- | --- | --- | --- | --- | --- |
{screener_rows_markdown(rows)}
"""


def screener_workbook_bytes(rows: list[dict[str, object]], country: str) -> bytes:
    try:
        from openpyxl import Workbook  # type: ignore
        from openpyxl.styles import Font, PatternFill
        from openpyxl.utils import get_column_letter
    except Exception as exc:
        csv_lines = ["Openpyxl unavailable; install requirements.txt. Error: " + str(exc)]
        return "\n".join(csv_lines).encode("utf-8")
    wb = Workbook()
    ws = wb.active
    ws.title = "Overvaluation Screener"
    headers = list(rows[0].keys()) if rows else [
        "Country", "Ticker", "Name", "Exchange", "Currency", "Sector", "Industry", "Price", "Market Cap",
        "Avg Volume", "Liquidity Value", "Trailing PE", "Forward PE", "Price To Book", "Dividend Yield %",
        "Beta", "1Y Return %", "3Y Return %", "CAGR %", "Volatility %", "Max Drawdown %",
        "SPY Comparison", "Overvaluation Score", "Overvaluation Reasons", "Shortability / Liquidity Read",
        "Western Market Comparison", "S&P Global Placeholder", "Yahoo URL",
    ]
    ws.append(headers)
    for row in rows:
        ws.append([row.get(header, "") for header in headers])
    header_fill = PatternFill("solid", fgColor="DDEFE9")
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = header_fill
    for col_idx, header in enumerate(headers, start=1):
        ws.column_dimensions[get_column_letter(col_idx)].width = min(max(len(str(header)) + 4, 14), 42)
    note = wb.create_sheet("Notes")
    note.append(["Country", country or "Not selected"])
    note.append(["Data source", "Yahoo Finance public endpoints by default"])
    note.append(["S&P Global", "Licensed source. Add your own S&P Global / Capital IQ / Compustat export or API integration if you have rights."])
    note.append(["Shortability", "Liquidity is an approximation using price x average volume. Borrow availability, fees, locates, market hours, and local rules must be verified with broker."])
    note.append(["Not investment advice", "Educational screener only."])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def parse_amount(value: str, default: float = 1000.0) -> float:
    cleaned = re.sub(r"[^0-9.]", "", value or "")
    try:
        amount = float(cleaned)
    except Exception:
        amount = default
    return min(max(amount, 0.0), 1_000_000_000.0)


def future_value(amount: float, return_pct: float) -> float:
    return amount * (1 + return_pct / 100)


def investment_simulator_rows(market: MarketAnalysis | None, amount: float) -> str:
    if not market:
        return "| - | No public ticker was available, so the simulator could not calculate historical-trend outcomes. | - | - | - | - |"
    rows = []
    horizons = [1, 3, 5, 10]
    for scenario in market.scenarios:
        values = []
        for years in horizons:
            ret = scenario.projected_returns.get(years)
            values.append(f"{money(future_value(amount, ret), market.target.currency)} ({pct(ret)})" if ret is not None else "Not available")
        rows.append(f"| {md_cell(scenario.label)} | {pct(scenario.annual_rate_pct)} | {' | '.join(values)} |")
    return "\n".join(rows)


def monthly_allocation(market: MarketAnalysis | None, monthly_amount: float = 1000.0) -> list[tuple[str, float, str]]:
    if not market:
        return [
            ("Cash / wait for ticker data", monthly_amount, "No market data was available, so the model cannot allocate to the target."),
        ]
    target_weight = 0.50
    benchmark_weight = 0.35
    cash_weight = 0.15
    m = market.target_metrics
    valuation_text = " ".join(valuation_assessment(market)).lower()
    if "potentially overvalued" in valuation_text:
        target_weight -= 0.25
        cash_weight += 0.15
        benchmark_weight += 0.10
    elif "demanding" in valuation_text:
        target_weight -= 0.15
        cash_weight += 0.10
        benchmark_weight += 0.05
    elif "does not show obvious overvaluation" in valuation_text:
        target_weight += 0.10
        benchmark_weight -= 0.05
        cash_weight -= 0.05
    if m.volatility_pct >= 35 or m.max_drawdown_pct <= -40:
        target_weight -= 0.15
        cash_weight += 0.10
        benchmark_weight += 0.05
    if m.cagr_pct < 0:
        target_weight -= 0.10
        cash_weight += 0.05
        benchmark_weight += 0.05
    if market.benchmark:
        target_1y = period_return(market.target.points, 1)
        benchmark_1y = period_return(market.benchmark.points, 1)
        if target_1y is not None and benchmark_1y is not None and target_1y < benchmark_1y:
            target_weight -= 0.10
            benchmark_weight += 0.10
    target_weight = min(max(target_weight, 0.10), 0.75)
    benchmark_weight = min(max(benchmark_weight, 0.10), 0.75)
    cash_weight = max(cash_weight, 0.05)
    total = target_weight + benchmark_weight + cash_weight
    target_weight, benchmark_weight, cash_weight = target_weight / total, benchmark_weight / total, cash_weight / total
    benchmark_label = market.benchmark.ticker if market.benchmark else "broad benchmark ETF / index fund"
    return [
        (market.target.ticker, monthly_amount * target_weight, "Target stock sleeve based on valuation, trend, volatility, and drawdown screen."),
        (benchmark_label, monthly_amount * benchmark_weight, "Diversifier/core market sleeve to reduce single-stock risk."),
        ("Cash / watchlist reserve", monthly_amount * cash_weight, "Reserve for volatility, better entry points, or missing diligence confirmation."),
    ]


def monthly_allocation_rows(market: MarketAnalysis | None, monthly_amount: float = 1000.0) -> str:
    rows = []
    for label, amount, reason in monthly_allocation(market, monthly_amount):
        rows.append(f"| {md_cell(label, 120)} | {money(amount, market.target.currency if market else 'USD')} | {md_cell(reason, 360)} |")
    return "\n".join(rows)


def monthly_allocation_read(market: MarketAnalysis | None, monthly_amount: float = 1000.0) -> str:
    if not market:
        return "No ticker data was available, so the sample monthly allocation keeps the amount in cash/watchlist until market data is provided."
    allocation = monthly_allocation(market, monthly_amount)
    target = allocation[0]
    return (
        f"For an educational {money(monthly_amount, market.target.currency)} monthly model, the screen allocates "
        f"{money(target[1], market.target.currency)} to {target[0]} and diversifies the rest based on valuation, volatility, drawdown, and benchmark evidence. "
        "This is not personalized investment advice."
    )


def market_section(market: MarketAnalysis | None, investment_amount: float = 1000.0) -> str:
    if not market:
        return """
## Market & Competitors
No public ticker was provided, so market performance could not be analyzed.
"""
    m = market.target_metrics
    returns = {
        "1-year return": period_return(market.target.points, 1),
        "3-year return": period_return(market.target.points, 3),
        "5-year return": period_return(market.target.points, 5),
    }
    benchmark_read = "No benchmark comparison was available."
    benchmark_row = ""
    if market.benchmark:
        bm = compute_metrics(market.benchmark)
        target_1y = returns["1-year return"]
        benchmark_1y = period_return(market.benchmark.points, 1)
        if target_1y is not None and benchmark_1y is not None:
            benchmark_read = f"{market.target.ticker} {'outperformed' if target_1y >= benchmark_1y else 'underperformed'} {market.benchmark.ticker} by {abs(target_1y - benchmark_1y):.1f} percentage points over the last year."
        else:
            benchmark_read = f"Benchmark {market.benchmark.ticker} was pulled, but a full 1-year comparison was not available."
        benchmark_row = f"| Benchmark: {md_cell(bm.ticker)} | {pct(bm.total_return_pct)} | {pct(bm.cagr_pct)} | {bm.volatility_pct:.1f}% | {bm.max_drawdown_pct:.1f}% | {bm.sharpe_like:.2f} |"
    annual_rows = "\n".join(f"| {year} | {pct(ret)} |" for year, ret in sorted(m.annual_returns.items())[-8:])
    peer_rows = "\n".join(
        f"| Peer: {md_cell(cm.ticker)} | {pct(cm.total_return_pct)} | {pct(cm.cagr_pct)} | {cm.volatility_pct:.1f}% | {cm.max_drawdown_pct:.1f}% | {cm.sharpe_like:.2f} |"
        for cm in market.peer_metrics
    ) or "| - | No peer tickers were provided or peer data could not be pulled. | - | - | - | - |"
    scenario_rows = "\n".join(
        f"| {md_cell(s.label)} | {pct(s.annual_rate_pct)} | {money(s.projected_prices[1], m.currency)} | {pct(s.projected_returns[1])} | {money(s.projected_prices[3], m.currency)} | {pct(s.projected_returns[3])} | {money(s.projected_prices[5], m.currency)} | {pct(s.projected_returns[5])} | {money(s.projected_prices[10], m.currency)} | {pct(s.projected_returns[10])} |"
        for s in market.scenarios
    )
    news_rows = "\n".join(
        f"| {md_cell(item.published.strftime('%Y-%m-%d') if item.published else 'Date not available', 80)} | {md_cell(item.title, 260)} | {md_cell(item.publisher or 'Source not available', 120)} | {f'[Link]({item.link})' if item.link.startswith('http') else '-'} |"
        for item in market.market_news[:8]
    ) or "| - | No recent market news headlines were returned. | - | - |"
    catalyst_block = bullet_block(
        [catalyst.explanation for catalyst in market.move_catalysts],
        "No unusually large weekly move was detected in the pulled period, or news search did not return enough context for a catalyst read.",
    )
    valuation_block = bullet_block(valuation_assessment(market), "Valuation data was not available.")
    return f"""
## Market & Competitors: {market.target.ticker}
Data note: {market.source_note} Source: [Yahoo Finance]({market.target.source_url}).

Symbol resolution: {market.symbol_note}

International / Yahoo note: {market.international_note}

Trend summary: {m.trend_label} {benchmark_read} Potential upside/downside should be framed against annualized volatility of {m.volatility_pct:.1f}% and historical max drawdown of {m.max_drawdown_pct:.1f}%.

![{market.target.ticker} price trend]({market.price_chart_path})

### Trading Snapshot
This is the current / latest available Yahoo Finance trading picture for the public instrument.

| Field | Value |
| --- | --- |
{trading_snapshot_rows(market.target)}

### Yahoo Finance Company & Quote Details
For non-U.S. listings, this section uses Yahoo Finance as the primary market-data source because SEC filings may not exist.

| Field | Yahoo Finance Data |
| --- | --- |
{yahoo_detail_rows(market.target)}

{f"Business summary from Yahoo Finance: {market.target.business_summary}" if market.target.business_summary else "Business summary from Yahoo Finance: Not available."}

### Public Disclosure Search Pack
Use these links to verify local exchange filings, annual/interim reports, announcements, and issuer disclosures. The app cannot guarantee every market has a free machine-readable filings API, so it provides the best public disclosure starting points by listing/exchange.

| Source | Link |
| --- | --- |
{disclosure_link_rows(market.disclosure_links)}

### Valuation Read: P/E, P/B, And Overvaluation Check
This is a valuation screen, not investment advice. It uses Yahoo Finance fields where available and compares against peers when peer tickers are entered.

| Metric | Value | Read |
| --- | --- | --- |
{valuation_rows(market)}

{valuation_block}

| Metric | Value |
| --- | --- |
| Latest weekly close | {money(m.latest_price, m.currency)} |
| 1-year return | {pct(returns["1-year return"]) if returns["1-year return"] is not None else "Not available from pulled history"} |
| 3-year return | {pct(returns["3-year return"]) if returns["3-year return"] is not None else "Not available from pulled history"} |
| 5-year return | {pct(returns["5-year return"]) if returns["5-year return"] is not None else "Not available from pulled history"} |
| Starting weekly close in pulled period | {money(m.start_price, m.currency)} |
| High weekly close | {money(m.high_price, m.currency)} |
| Low weekly close | {money(m.low_price, m.currency)} |
| Total return | {pct(m.total_return_pct)} |
| CAGR / annualized return | {pct(m.cagr_pct)} |
| Annualized volatility estimate | {m.volatility_pct:.1f}% |
| Sharpe-like return/risk ratio | {m.sharpe_like:.2f} |
| Max drawdown | {m.max_drawdown_pct:.1f}% |
| Current drawdown from high | {m.current_drawdown_pct:.1f}% |
| Best week | {pct(m.best_week_pct)} |
| Worst week | {pct(m.worst_week_pct)} |
| Positive week rate | {m.positive_week_pct:.1f}% |
| 40-week moving average | {money(m.ma_40, m.currency)} |
| Trend read | {m.trend_label} |

### Investment Simulator
Educational model only. This does not know your objectives, taxes, liquidity needs, time horizon, or risk tolerance. It uses historical CAGR and volatility stress cases from Yahoo price history, so it is not a prediction.

Starting amount entered: {money(investment_amount, m.currency)}

| Scenario | Annual rate used | 1Y value | 3Y value | 5Y value | 10Y value |
| --- | --- | --- | --- | --- | --- |
{investment_simulator_rows(market, investment_amount)}

### Sample $1,000 Monthly Allocation
This is a rule-based example for the current month, not a personal recommendation. It shifts money away from the target when valuation looks stretched, volatility/drawdown is high, or the stock underperforms the benchmark.

{monthly_allocation_read(market, 1000.0)}

| Sleeve | Amount | Why |
| --- | --- | --- |
{monthly_allocation_rows(market, 1000.0)}

![Indexed performance comparison]({market.indexed_chart_path})

| Comparable | Total Return | CAGR | Volatility | Max Drawdown | Return/Risk |
| --- | --- | --- | --- | --- | --- |
| Target: {md_cell(m.ticker)} | {pct(m.total_return_pct)} | {pct(m.cagr_pct)} | {m.volatility_pct:.1f}% | {m.max_drawdown_pct:.1f}% | {m.sharpe_like:.2f} |
{benchmark_row}
{peer_rows}

![Potential growth / loss scenarios]({market.forecast_chart_path})

### Potential Growth / Loss Scenarios
These are not predictions. They are simple historical-trend stress cases based on the pulled period's CAGR and volatility.

{scenario_read(m, market.scenarios)}

| Scenario | Annual rate used | 1Y price | 1Y gain/loss | 3Y price | 3Y gain/loss | 5Y price | 5Y gain/loss | 10Y price | 10Y gain/loss |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
{scenario_rows}

![{market.target.ticker} drawdown]({market.drawdown_chart_path})

![{market.target.ticker} annual returns]({market.annual_chart_path})

| Year | Return |
| --- | --- |
{annual_rows}

### News & Large-Move Catalyst Review
This section searches market news and uses it to form hypotheses for large price moves. It is not proof of causation; verify against filings, earnings releases, management commentary, and full articles.

{catalyst_block}

| Date | Headline | Publisher | Link |
| --- | --- | --- | --- |
{news_rows}
"""


def quality_score(
    figures: list[Figure],
    market: MarketAnalysis | None,
    uploaded_count: int,
    pasted_notes: bool,
    peer_tickers: str,
    benchmark_ticker: str,
    website_only: bool,
    sec_quarterly_count: int = 0,
) -> tuple[int, str]:
    score = 10
    verified_count = len(financial_snapshot_figures(figures))
    possible_operating_count = len(operating_figures(figures))
    if sec_quarterly_count:
        score += min(16 + sec_quarterly_count * 6, 34)
    if market:
        score += 18
    if uploaded_count:
        score += min(12 + uploaded_count * 8, 28)
    if pasted_notes:
        score += 12
    if verified_count:
        score += min(verified_count * 7, 28)
    if possible_operating_count:
        score += min(possible_operating_count * 3, 10)
    if peer_tickers:
        score += 7
    if benchmark_ticker:
        score += 5
    if website_only:
        score -= 18
    score = min(score, 100)
    if score >= 75:
        label = "strong source packet for a first-pass diligence brief"
    elif score >= 50:
        label = "usable first-pass packet with meaningful gaps"
    else:
        label = "thin source packet; add financial statements, SEC excerpts, deck text, or analyst notes"
    return score, label


def build_risk_flags(sources: list[Source], figures: list[Figure], market: MarketAnalysis | None, uploaded_count: int) -> list[str]:
    flags: list[str] = []
    verified = financial_snapshot_figures(figures)
    corpus = " ".join(fig.context.lower() for fig in verified + operating_figures(figures))
    if not verified:
        flags.append("Missing financials: no verified revenue, margin, cash, debt, or cash-flow data was found.")
    if "customer" not in corpus and "customers" not in corpus and "concentration" not in corpus:
        flags.append("Customer concentration unknown: current source packet does not disclose top-customer exposure.")
    if "margin" not in corpus and "ebitda" not in corpus and "operating income" not in corpus:
        flags.append("No margin data: gross margin, EBITDA, or operating income is not disclosed based on current source packet.")
    if "cash" not in corpus and "debt" not in corpus:
        flags.append("No debt/cash data: liquidity, leverage, runway, and debt maturity risk cannot be assessed.")
    if uploaded_count == 0 and not has_pasted_notes(sources) and not has_sec_quarterly_sources(sources):
        flags.append("Weak source quality: current packet relies primarily on website text rather than diligence materials.")
    if market:
        m = market.target_metrics
        if m.volatility_pct >= 35:
            flags.append(f"High volatility: {market.target.ticker} annualized volatility is {m.volatility_pct:.1f}%.")
        if m.max_drawdown_pct <= -35:
            flags.append(f"Major drawdown: {market.target.ticker} experienced a {m.max_drawdown_pct:.1f}% max drawdown in the pulled period.")
        if market.benchmark:
            target_1y = period_return(market.target.points, 1)
            benchmark_1y = period_return(market.benchmark.points, 1)
            if target_1y is not None and benchmark_1y is not None and target_1y < benchmark_1y:
                flags.append(f"Underperformance vs benchmark: {market.target.ticker} trailed {market.benchmark.ticker} by {benchmark_1y - target_1y:.1f} percentage points over the last year.")
    if detect_legal_or_regulatory_language(sources):
        flags.append("Legal/regulatory language found: review litigation, compliance, data security, and regulatory disclosures for materiality.")
    if detect_conflicting_numbers(figures):
        flags.append("Conflicting numbers in uploaded/pasted materials: reconcile duplicate metric references before relying on them.")
    return flags


def sec_driver_sentences(sources: list[Source], limit: int = 10) -> list[str]:
    driver_terms = [
        "decrease", "decreased", "decline", "declined", "lower", "down", "increase", "increased", "higher", "growth",
        "primarily due", "driven by", "offset by", "because", "resulted from", "attributable to", "quarter", "three months",
        "six months", "nine months", "revenue", "sales", "gross margin", "operating income", "net income", "cash flow",
    ]
    items: list[str] = []
    seen: set[str] = set()
    for source in sec_quarterly_sources(sources):
        for sentence in re.split(r"(?<=[.!?])\s+", source.text):
            sentence = clean_text(sentence)
            lowered = sentence.lower()
            if len(sentence) < 45 or len(sentence) > 520:
                continue
            if not any(term in lowered for term in driver_terms):
                continue
            signature = sentence[:150].lower()
            if signature in seen:
                continue
            seen.add(signature)
            items.append(f"{sentence} Source: {source.label}.")
            if len(items) >= limit:
                return items
    return items


def verified_fact_bullets(figures: list[Figure], limit: int = 10) -> list[str]:
    facts = []
    for fig in financial_snapshot_figures(figures)[:limit]:
        facts.append(f"{fig.value}: {fig.context} Source: {fig.source_label}.")
    return facts


def market_summary_bullets(market: MarketAnalysis | None) -> list[str]:
    if not market:
        return ["No public ticker was provided or resolved, so market performance, volatility, drawdown, peer comparison, and catalyst analysis could not be completed."]
    m = market.target_metrics
    returns = {
        "1-year": period_return(market.target.points, 1),
        "3-year": period_return(market.target.points, 3),
        "5-year": period_return(market.target.points, 5),
    }
    bullets = [
        f"{market.target.ticker} trades in {market.target.currency} on {market.target.exchange or 'an exchange not disclosed by Yahoo'}; Yahoo resolved it as {market.target.name or market.target.ticker}.",
        f"Latest weekly close was {money(m.latest_price, m.currency)}; pulled-period total return was {pct(m.total_return_pct)}, CAGR was {pct(m.cagr_pct)}, annualized volatility was {m.volatility_pct:.1f}%, and max drawdown was {m.max_drawdown_pct:.1f}%.",
        f"Return windows: 1-year {pct(returns['1-year']) if returns['1-year'] is not None else 'not available'}, 3-year {pct(returns['3-year']) if returns['3-year'] is not None else 'not available'}, 5-year {pct(returns['5-year']) if returns['5-year'] is not None else 'not available'}.",
        f"Trend read: {m.trend_label}",
    ]
    if market.benchmark:
        benchmark_1y = period_return(market.benchmark.points, 1)
        target_1y = returns["1-year"]
        if benchmark_1y is not None and target_1y is not None:
            bullets.append(f"Benchmark comparison: {market.target.ticker} {'outperformed' if target_1y >= benchmark_1y else 'underperformed'} {market.benchmark.ticker} by {abs(target_1y - benchmark_1y):.1f} percentage points over the last year.")
    if market.target.fifty_two_week_low is not None and market.target.fifty_two_week_high is not None:
        bullets.append(f"Yahoo 52-week / derived range: {money(market.target.fifty_two_week_low, market.target.currency)} to {money(market.target.fifty_two_week_high, market.target.currency)}.")
    if market.target.market_cap is not None or market.target.trailing_pe is not None or market.target.dividend_yield_pct is not None:
        bullets.append(
            f"Yahoo valuation snapshot: market cap {compact_money(market.target.market_cap, market.target.currency)}, trailing P/E {fmt_ratio(market.target.trailing_pe)}, dividend yield {fmt_pct_plain(market.target.dividend_yield_pct)}."
        )
    bullets.extend(valuation_assessment(market)[:4])
    return bullets


def catalyst_summary_bullets(market: MarketAnalysis | None) -> list[str]:
    if not market:
        return ["No market data was available, so the app could not explain stock drops or spikes."]
    if not market.move_catalysts:
        return ["No unusually large weekly move was detected, or relevant headlines were not available. Do not infer a catalyst without more evidence."]
    bullets = [catalyst.explanation for catalyst in market.move_catalysts]
    if not market.market_news:
        bullets.append("Relevant Yahoo headline search returned no company-specific headlines, so large-move explanations should be treated as price-action observations rather than confirmed causes.")
    return bullets


def build_deep_summary(
    company: str,
    sources: list[Source],
    figures: list[Figure],
    market: MarketAnalysis | None,
    risk_flags: list[str],
    sec_summary: str,
    verified_summary: str,
    operating_summary: str,
    profile_items: list[str] | None = None,
    transaction_items: list[str] | None = None,
    investment_amount: float = 1000.0,
) -> str:
    verified_facts = verified_fact_bullets(figures)
    sec_drivers = sec_driver_sentences(sources)
    market_bullets = market_summary_bullets(market)
    catalysts = catalyst_summary_bullets(market)
    profile_items = profile_items or company_profile_bullets(sources, market)
    transaction_items = transaction_items or transaction_bullets(sources, market)
    missing_items = [
        "Revenue by segment/geography and quarter-over-quarter bridge",
        "Gross margin, operating margin, EBITDA, cash flow, cash balance, and debt bridge",
        "Management explanation for any quarter-over-quarter weakness",
        "Customer concentration and churn / retention",
        "Full earnings call transcript, investor presentation, and latest annual report",
    ]
    conclusion = (
        f"The current packet for {company} is strong enough for an initial read when SEC/Yahoo data is available, "
        "but not enough for a final investment decision unless the missing diligence items are resolved."
    )
    all_learned = [
        f"Business/products learned: {profile_items[0]}" if profile_items else "Business/products learned: not disclosed based on current source packet.",
        f"Major transactions/corporate actions learned: {transaction_items[0]}" if transaction_items else "Major transactions/corporate actions learned: none found in the current source packet.",
        f"Verified financials learned: {verified_facts[0]}" if verified_facts else "Verified financials learned: no verified financial metrics were extracted.",
        f"Quarterly drivers learned: {sec_drivers[0]}" if sec_drivers else "Quarterly drivers learned: no source-backed explanation for quarterly increases/decreases was found.",
        f"Market performance learned: {market_bullets[0]}" if market_bullets else "Market performance learned: no public market signal was available.",
        f"Valuation learned: {valuation_assessment(market)[-2]}" if market else "Valuation learned: no P/E or P/B market valuation data was available.",
        f"Investment simulator learned: {monthly_allocation_read(market, 1000.0)}" if market else "Investment simulator learned: no ticker data was available, so no modeled stock allocation was produced.",
        f"Stock move/catalyst learned: {catalysts[0]}" if catalysts else "Stock move/catalyst learned: no source-backed catalyst was available.",
        f"Primary risk learned: {risk_flags[0]}" if risk_flags else "Primary risk learned: no automated red flags were found, but analyst review is still required.",
    ]
    return f"""
## Summary: Everything You Need To Know

### All Information Learned In This Run
{bullet_block(all_learned, 'No summary facts were available from the current source packet.')}

### Bottom Line
- {conclusion}
- Source position: {sec_summary} {verified_summary} {operating_summary}
- The app separates confirmed source-backed facts from market-data signals and from catalyst hypotheses. Any statement about why a stock dropped or rose should be treated as a hypothesis unless it is supported by filings, earnings releases, transcripts, or multiple relevant headlines.

### What Is Verified
{bullet_block(verified_facts, 'No verified financial metrics were extracted. Not disclosed based on current source packet.')}

### What The Company Does / Products Sold
{bullet_block(profile_items, 'Product and business model details were not disclosed based on current source packet. Add an investor presentation, annual report, or clean website/company profile text.')}

### Major Transactions / Corporate Actions
{bullet_block(transaction_items, 'No major acquisitions, divestitures, buybacks, dividends, debt offerings, capital raises, restructurings, major contracts, or partnerships were found in the current source packet.')}

### Quarterly / Operating Drivers
These are the filing-backed or source-backed lines most relevant to why quarters may be up or down.

{bullet_block(sec_drivers, 'No source-backed quarter-over-quarter drivers were found. Upload/paste the latest earnings release, 10-Q/6-K/annual report, or transcript to explain why the quarter was down or up.')}

### Stock Performance And Market Signal
{bullet_block(market_bullets, 'No public market signal was available.')}

### Valuation / Overvaluation Read
{bullet_block(valuation_assessment(market), 'No P/E, P/B, or peer valuation data was available.')}

### Investment Simulator / Monthly Allocation
- Starting amount modeled: {money(investment_amount, market.target.currency if market else 'USD')}.
- {monthly_allocation_read(market, 1000.0)}
- The simulator is educational only; it uses historical trend stress cases and cannot account for your personal finances, taxes, time horizon, liquidity needs, or risk tolerance.

### Why The Stock Dropped Or Rose
{bullet_block(catalysts, 'No catalyst explanation was available.')}

### Biggest Risks And Open Questions
{bullet_block(risk_flags, 'No automated red flags were found, but analyst review is still required.')}

### What Is Still Missing
{bullet_block([f'Not disclosed based on current source packet: {item}.' for item in missing_items], 'No missing items were identified.')}

### Next Analyst Actions
- Read the most recent earnings release and call transcript to confirm management's explanation for revenue, margin, and guidance changes.
- Reconcile Yahoo price moves against earnings dates, guidance changes, analyst revisions, regulatory events, macro moves, and sector/peer performance.
- For non-U.S. companies, pull the local annual/interim report or exchange filing because SEC 10-Q data may not exist.
- Verify every key number against primary sources before using this as an investment memo.
"""


def make_fallback_brief(
    company: str,
    website: str,
    strategy: str,
    sources: list[Source],
    figures: list[Figure],
    market: MarketAnalysis | None,
    uploaded_count: int,
    peer_tickers: str,
    benchmark_ticker: str,
    sec_company: SECCompany | None = None,
    investment_amount: float = 1000.0,
) -> str:
    corpus = "\n".join(source.text for source in sources)
    overview = clean_business_sentences(sources)
    verified_financials = financial_snapshot_figures(figures)
    possible_operating = operating_figures(figures)
    financial_table = make_figure_table(verified_financials, None, 22)
    operating_table = make_figure_table(possible_operating, None, 14)
    review_table = make_figure_table(figures, None, 40)
    source_rows = "\n".join(f"- {source.label}: {source.url if source.url else 'provided input'}" for source in sources)
    profile_items = company_profile_bullets(sources, market)
    transaction_items = transaction_bullets(sources, market)
    pasted_notes = has_pasted_notes(sources)
    sec_sources = sec_quarterly_sources(sources)
    sec_count = len(sec_sources)
    website_only = has_website_source(sources) and not uploaded_count and not pasted_notes and market is None and not sec_count
    score, score_label = quality_score(figures, market, uploaded_count, pasted_notes, peer_tickers, benchmark_ticker, website_only, sec_count)
    risk_flags = build_risk_flags(sources, figures, market, uploaded_count)
    verified_summary = "Verified financial metrics were found in diligence-grade source material." if verified_financials else "No verified financial data was found."
    operating_summary = "Possible operating metrics were identified for analyst review." if possible_operating else "No reliable operating metrics were disclosed based on current source packet."
    sec_summary = (
        f"SEC quarterly filings pulled: {sec_count} recent Form 10-Q filing(s) for {sec_company.title} ({sec_company.ticker}, CIK {sec_company.cik})."
        if sec_company and sec_count
        else "SEC quarterly filings: no recent Form 10-Q packet was pulled for this company."
    )
    sec_readout_items = sec_filing_readout(sources)
    market_summary = ""
    if market:
        tm = market.target_metrics
        market_summary = f" Public market data for {market.target.ticker} shows {pct(tm.total_return_pct)} total return, {pct(tm.cagr_pct)} CAGR, {tm.volatility_pct:.1f}% estimated annualized volatility, and {tm.max_drawdown_pct:.1f}% max drawdown over the pulled period."
    deep_summary = build_deep_summary(company, sources, figures, market, risk_flags, sec_summary, verified_summary, operating_summary, profile_items, transaction_items, investment_amount)

    return f"""# Advanced Due-Diligence Brief: {company}

Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}
Target website: {website or 'Not provided'}
Strategy lens: {strategy}

## Executive Readout
- Source quality score: {score}/100 — {score_label}.
- Source quality: {'website-only packet; low diligence reliability' if website_only else 'mixed source packet; rely on tables below for what is actually supported'}.
- SEC packet: {sec_summary}
- Verified information: {verified_summary} {operating_summary}
- Missing information: revenue, margins, EBITDA, cash balance, debt, runway, funding, and customer concentration remain "Not disclosed based on current source packet" unless shown in the verified table below.
- Public market performance: {f'{market.target.ticker} market data was pulled and analyzed below.' if market else 'No public ticker was provided, so market performance could not be analyzed.'}
- Biggest diligence risks: {('; '.join(risk_flags[:3]) + '.') if risk_flags else 'No major automated red flags were found, but analyst review is still required.'}
- Clear next steps: upload financial statements, paste SEC filing excerpts, add a pitch deck, provide peer tickers, and reconcile any management-provided metrics against source documents.

## Business Overview
Website text was used only for company description, products, services, and basic positioning. Footer, legal, privacy, phone, product-promo, and navigation text was filtered out.

{bullet_block(overview, 'Business description is not disclosed based on current source packet. Add a clean company description, pitch deck text, or management notes to complete this section.')}

## Products & Business Model
This section explains what the company does, what it sells, and how Yahoo/company/public-source text describes the business.

{bullet_block(profile_items, 'Product and business model details were not disclosed based on current source packet. Add an annual report, investor presentation, or company profile text.')}

## Major Transactions / Corporate Actions
This section searches filings, public-source text, uploaded materials, pasted notes, and Yahoo headlines for acquisitions, mergers, divestitures, capital raises, debt, buybacks, dividends, restructuring, major contracts, and partnerships.

{bullet_block(transaction_items, 'No major transactions or corporate actions were found in the current source packet.')}

## Financial Snapshot
{'' if verified_financials else 'No verified financial data was found. Upload financial statements, SEC filings, or paste financial excerpts to complete this section.'}

### Quarterly SEC Filing Readout
{bullet_block(sec_readout_items, 'No quarterly SEC filing financial readout was available. If this company is public, enter the exact ticker or paste the latest 10-Q excerpt.')}

### Verified Financial Metrics
| ID | Figure | Classification | Source context | Source | Analyst note |
| --- | --- | --- | --- | --- | --- |
{financial_table}

### Possible Operating Metrics
These items have operating context but still require confirmation of definition, period, and source.

| ID | Figure | Classification | Source context | Source | Analyst note |
| --- | --- | --- | --- | --- | --- |
{operating_table}

{market_section(market, investment_amount)}

## Risk / Red Flags
{bullet_block(risk_flags, 'No automated red flags were found. Continue analyst review for source quality, omitted financials, customer concentration, legal exposure, and metric definitions.')}

## Advanced Diligence Workplan
| Area | What to Request | Why It Matters |
| --- | --- | --- |
| Financials | Monthly P&L, balance sheet, cash flow, revenue detail, and debt schedule | Confirms whether the story is supported by actual operating performance. |
| Revenue Quality | Customer cohort, retention, churn, pipeline, bookings, and contract renewal schedule | Separates recurring, sticky revenue from one-time or fragile revenue. |
| Customers | Top customer list, concentration, signed contracts, NPS or satisfaction data | Tests whether growth depends on a few relationships. |
| Product | Product roadmap, uptime, support tickets, usage data, security reports | Checks scalability and hidden technical risk. |
| Legal / Compliance | Litigation, regulatory correspondence, IP ownership, privacy/security policies | Finds risks that do not appear on the website. |
| Public Market Lens | Compare returns, volatility, drawdowns, and peer performance | Shows how public investors are pricing the company relative to alternatives. |

## Extracted Numeric Claims Review
This is a review queue, not a financial statement. The classifier only treats numbers as financial or operating candidates when nearby context contains diligence-relevant terms, and it rejects website footer, phone, legal, privacy, product, promo, and navigation noise.

| ID | Figure | Classification | Source context | Source | Analyst note |
| --- | --- | --- | --- | --- | --- |
{review_table}

## Analyst Follow-Up Questions
- What revenue, gross margin, EBITDA, cash burn, cash balance, debt, and net retention figures can management source from financial statements?
- Which customers account for the largest share of revenue, and what contract terms govern renewal, termination, exclusivity, and churn?
- Which numbers in the deck are audited, system-generated, management-estimated, or forward-looking?
- Who are the closest competitors, and where does the target win or lose on price, product depth, distribution, and switching costs?
- If this is a public company, how do stock performance, drawdowns, and volatility compare with revenue growth and margin performance?
- For a {strategy.lower()} lens, what would break the investment thesis in the first 100 days after close?

{deep_summary}

## Sources Used
{source_rows}
"""


def make_llm_brief(
    company: str,
    website: str,
    strategy: str,
    sources: list[Source],
    figures: list[Figure],
    market: MarketAnalysis | None,
    uploaded_count: int,
    peer_tickers: str,
    benchmark_ticker: str,
    sec_company: SECCompany | None = None,
    investment_amount: float = 1000.0,
) -> str | None:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None
    try:
        from openai import OpenAI  # type: ignore
    except Exception:
        return None
    source_packet = [{"label": s.label, "url": s.url, "text": s.text[:7000]} for s in sources]
    figure_packet = [
        {"id": f"F{i}", "value": f.value, "category": f.category, "context": f.context, "source": f.source_label, "url": f.source_url}
        for i, f in enumerate(figures, start=1)
    ]
    market_packet = None
    if market:
        tm = market.target_metrics
        benchmark_packet = None
        if market.benchmark:
            bm = compute_metrics(market.benchmark)
            benchmark_packet = {
                "ticker": market.benchmark.ticker,
                "total_return_pct": bm.total_return_pct,
                "cagr_pct": bm.cagr_pct,
                "volatility_pct": bm.volatility_pct,
                "max_drawdown_pct": bm.max_drawdown_pct,
                "one_year_return_pct": period_return(market.benchmark.points, 1),
            }
        market_packet = {
            "ticker": market.target.ticker,
            "latest_price": tm.latest_price,
            "one_year_return_pct": period_return(market.target.points, 1),
            "three_year_return_pct": period_return(market.target.points, 3),
            "five_year_return_pct": period_return(market.target.points, 5),
            "total_return_pct": tm.total_return_pct,
            "cagr_pct": tm.cagr_pct,
            "volatility_pct": tm.volatility_pct,
            "max_drawdown_pct": tm.max_drawdown_pct,
            "current_drawdown_pct": tm.current_drawdown_pct,
            "trend_label": tm.trend_label,
            "benchmark": benchmark_packet,
            "peers": [{"ticker": p.ticker, "total_return_pct": p.total_return_pct, "cagr_pct": p.cagr_pct, "volatility_pct": p.volatility_pct} for p in market.peer_metrics],
            "symbol_note": market.symbol_note,
            "international_note": market.international_note,
            "yahoo_quote_details": {
                "name": market.target.name,
                "symbol": market.target.ticker,
                "quote_type": market.target.quote_type,
                "exchange": market.target.exchange,
                "country": market.target.country,
                "currency": market.target.currency,
                "sector": market.target.sector,
                "industry": market.target.industry,
                "regular_market_price": market.target.regular_market_price,
                "previous_close": market.target.previous_close,
                "day_low": market.target.day_low,
                "day_high": market.target.day_high,
                "fifty_two_week_low": market.target.fifty_two_week_low,
                "fifty_two_week_high": market.target.fifty_two_week_high,
                "market_cap": market.target.market_cap,
                "trailing_pe": market.target.trailing_pe,
                "forward_pe": market.target.forward_pe,
                "price_to_book": market.target.price_to_book,
                "dividend_yield_pct": market.target.dividend_yield_pct,
                "beta": market.target.beta,
                "average_volume": market.target.average_volume,
                "shares_outstanding": market.target.shares_outstanding,
                "employees": market.target.employees,
                "website": market.target.website,
                "business_summary": market.target.business_summary,
            },
            "valuation_assessment": valuation_assessment(market),
            "investment_simulator": {
                "starting_amount": investment_amount,
                "currency": market.target.currency,
                "scenario_rows_markdown": investment_simulator_rows(market, investment_amount),
                "sample_monthly_allocation_1000": [
                    {"sleeve": label, "amount": amount, "reason": reason}
                    for label, amount, reason in monthly_allocation(market, 1000.0)
                ],
                "allocation_read": monthly_allocation_read(market, 1000.0),
            },
            "public_disclosure_links": [
                {"source": label, "url": url}
                for label, url in market.disclosure_links
            ],
            "recent_news": [
                {
                    "title": item.title,
                    "publisher": item.publisher,
                    "published": item.published.isoformat() if item.published else None,
                    "link": item.link,
                }
                for item in market.market_news[:10]
            ],
            "large_move_catalysts": [
                {
                    "date": catalyst.date.isoformat(),
                    "move_pct": catalyst.move_pct,
                    "explanation": catalyst.explanation,
                    "headlines": [item.title for item in catalyst.headlines],
                }
                for catalyst in market.move_catalysts
            ],
            "growth_loss_scenarios": [
                {
                    "label": scenario.label,
                    "annual_rate_pct": scenario.annual_rate_pct,
                    "projected_returns": scenario.projected_returns,
                    "projected_prices": scenario.projected_prices,
                }
                for scenario in market.scenarios
            ],
        }
    pasted_notes = has_pasted_notes(sources)
    sec_sources = sec_quarterly_sources(sources)
    website_only = has_website_source(sources) and not uploaded_count and not pasted_notes and market is None and not sec_sources
    score, score_label = quality_score(figures, market, uploaded_count, pasted_notes, peer_tickers, benchmark_ticker, website_only, len(sec_sources))
    risk_flags = build_risk_flags(sources, figures, market, uploaded_count)
    profile_items = company_profile_bullets(sources, market)
    transaction_items = transaction_bullets(sources, market)
    sec_packet = {
        "matched_company": None if not sec_company else {
            "title": sec_company.title,
            "ticker": sec_company.ticker,
            "cik": sec_company.cik,
        },
        "quarterly_filings_pulled": [
            {"label": source.label, "url": source.url, "excerpt": source.text[:5000]}
            for source in sec_sources
        ],
    }
    prompt = f"""
Create an advanced preliminary pre-investment due-diligence brief for {company}.
Website: {website}
Strategy lens: {strategy}
Source quality score: {score}/100 — {score_label}

Hard rules:
- Do not invent facts or numbers.
- Every numeric business claim must cite one of the provided figure IDs like [F3] or the market data packet.
- Use only figures categorized as "Verified financial metric" for the Financial Snapshot.
- Do not use company website numbers in the Financial Snapshot.
- Prefer recent SEC Form 10-Q filing excerpts for Financial Snapshot and Executive Readout when SEC data is available.
- If no verified financial metrics exist, write exactly: "No verified financial data was found. Upload financial statements, SEC filings, or paste financial excerpts to complete this section."
- Business Overview may use website text only for company description, products, services, and basic positioning.
- Do not include phone numbers, footer text, privacy policy text, Apple Card legal text, promo text, or navigation text in Business Overview.
- Market & Competitors must use market data if a ticker exists. If no ticker exists, write exactly: "No public ticker was provided, so market performance could not be analyzed."
- Risk / Red Flags must focus on missing financials, customer concentration unknown, no margin data, no debt/cash data, weak source quality, volatility, drawdown, benchmark underperformance, legal/regulatory language, or conflicting numbers.
- If data is missing, say "Not disclosed based on current source packet."
- Executive Readout must summarize source quality, verified information, missing information, market performance if any, biggest diligence risks, and clear next steps.
- Include a very detailed final section titled "Summary: Everything You Need To Know".
- The first subsection inside that final summary must be "All Information Learned In This Run" and must recap, in one place, every important thing learned about the company: what it does, products/services, major transactions, verified financials, quarterly drivers, market performance, why the stock moved, risks, missing information, and next actions.
- Include a "Valuation / Overvaluation Read" that discusses P/E, forward P/E, P/B, market cap, dividend yield, peer medians if available, and whether the stock looks cheap, fairly valued, expensive, or potentially overvalued.
- Never call a stock definitively overvalued based only on P/E or P/B. Explain the evidence, caveats, sector context, missing data, and what would confirm or disprove the valuation concern.
- Include an "Investment Simulator" section showing the entered starting amount across bear/base/bull 1-year, 3-year, 5-year, and 10-year outcomes. Say clearly this is educational, uses historical trend stress cases, and is not a prediction.
- Include a "Sample $1,000 Monthly Allocation" section showing how the rule-based model would split $1,000 this month between target stock, benchmark/core ETF, and cash/watchlist reserve. Say clearly it is not personalized investment advice.
- Include dedicated sections for "Products & Business Model" and "Major Transactions / Corporate Actions".
- In those sections, explain what products/services the company sells, what the company does, major business segments, and any public-source evidence of acquisitions, mergers, divestitures, capital raises, debt, buybacks, dividends, restructuring, major contracts, or partnerships.
- In the final summary, explain all available evidence on: verified financials, products/services, major transactions, quarterly performance, why quarters may be down or up, why the stock dropped or rose, drawdown, volatility, benchmark/peer performance, relevant news catalysts, risks, missing information, and exact next diligence actions.
- Do not claim a causal reason for a stock move unless the source packet, SEC filing, earnings release text, or relevant news headlines support it. If the app only has price action, call it a hypothesis and say what evidence is still needed.
- For non-U.S. companies, rely on Yahoo Finance market/profile data and clearly state when SEC 10-Q filings are not expected or were not found.
- Keep it investor-style and practical.

Market data, if available:
{json.dumps(market_packet, indent=2)}

Automated risk flags:
{json.dumps(risk_flags, indent=2)}

Products / business model findings:
{json.dumps(profile_items, indent=2)}

Major transactions / corporate actions findings:
{json.dumps(transaction_items, indent=2)}

SEC quarterly filing packet:
{json.dumps(sec_packet, indent=2)}

Figures:
{json.dumps(figure_packet, indent=2)}

Sources:
{json.dumps(source_packet, indent=2)}
"""
    client = OpenAI(api_key=api_key)
    response = client.responses.create(model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"), input=prompt)
    generated = response.output_text
    return generated + "\n\n" + market_section(market, investment_amount)


def build_brief(fields: dict[str, str], files: list[tuple[str, bytes]]) -> str:
    company = clean_text(fields.get("company", "")) or "Target Company"
    website = clean_text(fields.get("website", ""))
    ticker = clean_text(fields.get("ticker", ""))
    peer_tickers = clean_text(fields.get("peers", ""))
    benchmark_ticker = clean_text(fields.get("benchmark", "SPY"))
    investment_amount = parse_amount(fields.get("investment_amount", "1000"), 1000.0)
    screener_country = clean_text(fields.get("screener_country", ""))
    years_raw = clean_text(fields.get("years", "5")) or "5"
    try:
        years = min(max(int(years_raw), 1), 10)
    except Exception:
        years = 5
    strategy = clean_text(fields.get("strategy", "Venture & Growth"))
    pasted = clean_text(fields.get("notes", ""))

    sec_company, sec_sources = fetch_quarterly_sec_filings(company, ticker)
    resolved_ticker = ticker or (sec_company.ticker if sec_company and sec_company.ticker else "")

    sources = [fetch_website(company, website)]
    sources.extend(sec_sources)
    sources.append(fetch_sec_company_search(company))
    if pasted:
        sources.append(Source("Pasted analyst notes / articles", "provided by user", pasted[:MAX_TEXT_CHARS]))
    upload_sources = []
    for filename, raw in files:
        if raw:
            upload_sources.append(source_from_upload(filename, raw))
    sources.extend(upload_sources)

    figures = extract_figures(sources)
    market_lookup_value = resolved_ticker or company
    market = fetch_market_analysis(company, market_lookup_value, peer_tickers, benchmark_ticker, years) if market_lookup_value else None
    screener_rows = run_country_screener(screener_country, min(max(years, 3), 10)) if screener_country else []
    brief = make_llm_brief(company, website, strategy, sources, figures, market, len(upload_sources), peer_tickers, benchmark_ticker, sec_company, investment_amount)
    if not brief:
        brief = make_fallback_brief(company, website, strategy, sources, figures, market, len(upload_sources), peer_tickers, benchmark_ticker, sec_company, investment_amount)
    if screener_country:
        brief += "\n\n" + screener_section(screener_country, screener_rows)
    CHAT_STATE["company"] = company
    CHAT_STATE["brief"] = brief
    CHAT_STATE["sources"] = sources
    CHAT_STATE["figures"] = figures
    (OUTPUT_DIR / "latest_brief.md").write_text(brief, encoding="utf-8")
    return brief


def source_packet_for_chat(sources: list[Source]) -> str:
    chunks = []
    for source in sources:
        chunks.append(f"Source: {source.label}\nURL: {source.url or 'provided input'}\nText: {source.text[:6000]}")
    return "\n\n".join(chunks)[:CHAT_CONTEXT_LIMIT]


def local_chat_answer(question: str, brief: str, sources: object, note: str = "") -> str:
    corpus_parts = [brief]
    if isinstance(sources, list):
        corpus_parts.extend(f"{source.label}: {source.text}" for source in sources if isinstance(source, Source))
    sentences = []
    for sentence in re.split(r"(?<=[.!?])\s+", clean_text(" ".join(corpus_parts))):
        if 45 <= len(sentence) <= 420:
            sentences.append(sentence)
    terms = [term for term in re.findall(r"[A-Za-z0-9$%.-]+", question.lower()) if len(term) > 2]
    scored: list[tuple[int, str]] = []
    for sentence in sentences:
        lowered = sentence.lower()
        score = sum(1 for term in terms if term in lowered)
        if score:
            scored.append((score, sentence))
    scored.sort(key=lambda item: item[0], reverse=True)
    prefix = f"{note} " if note else ""
    if not scored:
        return prefix + "I could not find support for that in the current brief/source packet. Not disclosed based on current source packet."
    top = []
    seen: set[str] = set()
    for _, sentence in scored:
        signature = sentence[:120].lower()
        if signature in seen:
            continue
        seen.add(signature)
        top.append(sentence)
        if len(top) >= 4:
            break
    return prefix + "Local source-search answer: " + " ".join(top)


def answer_chat_question(question: str) -> str:
    question = clean_text(question)
    if not question:
        return "Ask a question about the generated brief, SEC filings, market data, risks, or missing diligence items."

    company = str(CHAT_STATE.get("company") or "the target company")
    brief = str(CHAT_STATE.get("brief") or "")
    sources = CHAT_STATE.get("sources") or []
    if not brief:
        return "Generate a DD brief first, then I can answer questions from that brief and its source packet."

    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        try:
            from openai import OpenAI  # type: ignore

            prompt = f"""
You are a diligence Q&A assistant for {company}.
Answer the user's question using only the generated brief and source packet below.
If the answer is not supported, say what is not disclosed based on the current source packet.
Be concise, cite the source label when useful, and call out uncertainty.

Question:
{question}

Generated brief:
{brief[:18000]}

Source packet:
{source_packet_for_chat(sources if isinstance(sources, list) else [])}
"""
            client = OpenAI(api_key=api_key)
            response = client.responses.create(model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"), input=prompt)
            return clean_text(response.output_text)
        except ImportError:
            return local_chat_answer(
                question,
                brief,
                sources,
                "OpenAI is configured, but the Python package is not installed. Run `python3 -m pip install -r requirements.txt` to enable AI chat.",
            )
        except Exception as exc:
            return local_chat_answer(question, brief, sources, f"AI chat failed ({exc}).")

    return local_chat_answer(question, brief, sources, "Set OPENAI_API_KEY in your hosting platform environment variables to enable fuller AI chat.")


def convert_inline(text: str) -> str:
    escaped = html.escape(text)
    escaped = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2" target="_blank" rel="noreferrer">\1</a>', escaped)
    escaped = re.sub(r"\[([^\]]+)\]\((/[^)]+)\)", r'<a href="\2" target="_blank" rel="noreferrer">\1</a>', escaped)
    return escaped


def split_md_row(row: str) -> list[str]:
    text = row.strip().strip("|")
    return [cell.strip() for cell in text.split("|")]


def markdown_table_to_html(rows: list[str]) -> str:
    raw_rows = [split_md_row(row) for row in rows]
    if not raw_rows:
        return ""
    has_header = len(raw_rows) > 1 and all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in raw_rows[1])
    max_cols = max(len(r) for r in raw_rows)
    parsed = []
    for row in raw_rows:
        if len(row) < max_cols:
            row = row + [""] * (max_cols - len(row))
        parsed.append([convert_inline(cell) for cell in row[:max_cols]])
    html_rows = []
    start = 0
    if has_header:
        html_rows.append("<thead><tr>" + "".join(f"<th>{cell}</th>" for cell in parsed[0]) + "</tr></thead>")
        start = 2
    body = ["<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in parsed[start:]]
    return '<div class="table-wrap"><table>' + "".join(html_rows) + "<tbody>" + "".join(body) + "</tbody></table></div>"


def render_markdown(md: str) -> str:
    lines = md.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue
        if stripped.startswith("|"):
            table_lines = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                table_lines.append(lines[i])
                i += 1
            out.append(markdown_table_to_html(table_lines))
            continue
        if stripped.startswith("# "):
            out.append(f"<h1>{convert_inline(stripped[2:])}</h1>")
        elif stripped.startswith("## "):
            title = stripped[3:]
            anchor = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
            out.append(f'<h2 id="{html.escape(anchor)}">{convert_inline(title)}</h2>')
        elif stripped.startswith("### "):
            out.append(f"<h3>{convert_inline(stripped[4:])}</h3>")
        elif stripped.startswith("!["):
            match = re.match(r"!\[([^\]]*)\]\(([^)]+)\)", stripped)
            if match:
                alt, src = html.escape(match.group(1)), html.escape(match.group(2))
                out.append(f'<img class="chart" src="{src}" alt="{alt}">')
            else:
                out.append(f"<p>{convert_inline(stripped)}</p>")
        elif stripped.startswith("- "):
            items = []
            while i < len(lines) and lines[i].strip().startswith("- "):
                items.append(f"<li>{convert_inline(lines[i].strip()[2:])}</li>")
                i += 1
            out.append("<ul>" + "".join(items) + "</ul>")
            continue
        else:
            out.append(f"<p>{convert_inline(stripped)}</p>")
        i += 1
    return "\n".join(out)


def chat_panel() -> str:
    return """
<section class="chat-panel">
  <div class="chat-head">
    <div>
      <p class="eyebrow">Brief Q&A</p>
      <h2>Ask questions about this DD brief</h2>
    </div>
  </div>
  <div id="chat-log" class="chat-log">
    <div class="chat-message assistant">Ask about revenue, margins, SEC filing support, market performance, red flags, missing diligence, or next steps.</div>
  </div>
  <form id="chat-form" class="chat-form">
    <label class="sr-only" for="chat-question">Question</label>
    <input id="chat-question" name="question" placeholder="Ask a question about the brief..." autocomplete="off">
    <button type="submit">Ask</button>
  </form>
  <script>
    const chatForm = document.getElementById("chat-form");
    const chatInput = document.getElementById("chat-question");
    const chatLog = document.getElementById("chat-log");
    function addChatMessage(role, text) {
      const item = document.createElement("div");
      item.className = "chat-message " + role;
      item.textContent = text;
      chatLog.appendChild(item);
      chatLog.scrollTop = chatLog.scrollHeight;
    }
    chatForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const question = chatInput.value.trim();
      if (!question) return;
      addChatMessage("user", question);
      chatInput.value = "";
      const thinking = document.createElement("div");
      thinking.className = "chat-message assistant";
      thinking.textContent = "Thinking...";
      chatLog.appendChild(thinking);
      chatLog.scrollTop = chatLog.scrollHeight;
      try {
        const response = await fetch("/chat", {
          method: "POST",
          headers: {"Content-Type": "application/x-www-form-urlencoded"},
          body: new URLSearchParams({question})
        });
        const data = await response.json();
        thinking.textContent = data.answer || "No answer returned.";
      } catch (error) {
        thinking.textContent = "Chat request failed. Check the server terminal and try again.";
      }
      chatLog.scrollTop = chatLog.scrollHeight;
    });
  </script>
</section>
"""


def result_shell(brief: str) -> str:
    sections = [
        ("executive-readout", "Executive"),
        ("products-business-model", "Products"),
        ("major-transactions-corporate-actions", "Transactions"),
        ("financial-snapshot", "Financials"),
        ("market-competitors", "Market"),
        ("risk-red-flags", "Risks"),
        ("summary-everything-you-need-to-know", "Summary"),
    ]
    links = "".join(f'<a href="#{anchor}">{label}</a>' for anchor, label in sections)
    return f"""
<main class="result-shell">
  <aside class="result-nav">
    <p class="eyebrow">Brief Map</p>
    <nav>{links}</nav>
    <a class="ghost full" href="/download">Download markdown</a>
  </aside>
  <div class="result-main">
    <section class="brief">{render_markdown(brief)}</section>
    {chat_panel()}
  </div>
</main>
"""


FORM = """
<main class="app-shell">
  <aside class="app-sidebar">
    <div class="brand-mark">DD</div>
    <nav>
      <a href="#brief-builder">Brief Builder</a>
      <a href="#market-engine">Market Engine</a>
      <a href="#source-stack">Source Stack</a>
      <a href="#deployment">Deployment</a>
    </nav>
  </aside>
  <section class="app-main">
    <header class="app-header">
      <div>
        <p class="eyebrow">Advanced diligence app</p>
        <h1>Investment DD Workbench</h1>
        <p class="subhead">Build source-backed briefs with SEC filings, global Yahoo market data, valuation screens, investment simulation, news catalysts, and AI Q&A.</p>
      </div>
      <a class="ghost" href="/download">Download latest markdown</a>
    </header>

    <section class="metric-strip" id="market-engine">
      <div><strong>SEC + global markets</strong><span>10-Q, Yahoo, regulator links</span></div>
      <div><strong>Valuation screen</strong><span>P/E, P/B, peer medians</span></div>
      <div><strong>Simulator</strong><span>1Y, 3Y, 5Y, 10Y outcomes</span></div>
      <div><strong>Brief Q&A</strong><span>AI when API key is set</span></div>
    </section>

    <form class="panel builder-panel" id="brief-builder" action="/generate" method="post" enctype="multipart/form-data">
      <div class="panel-head">
        <div>
          <p class="eyebrow">Run Setup</p>
          <h2>Company, Market, And Source Inputs</h2>
        </div>
        <button type="submit">Generate Advanced DD Brief</button>
      </div>
      <div class="grid">
        <label>Company name
          <input name="company" required placeholder="e.g. Apple">
        </label>
        <label>Website
          <input name="website" required placeholder="https://apple.com">
        </label>
        <label>Public stock ticker
          <input name="ticker" placeholder="Optional, e.g. AAPL, 7203.T, TSCO.L, SHOP.TO, BHP.AX">
        </label>
        <label>Peer tickers
          <input name="peers" placeholder="e.g. MSFT, GOOGL, META">
        </label>
        <label>Benchmark ticker
          <input name="benchmark" value="SPY" placeholder="e.g. SPY, QQQ, ^N225">
        </label>
        <label>Investment simulator amount
          <input name="investment_amount" value="1000" placeholder="e.g. 1000 or 25000">
        </label>
        <label>Country overvaluation screener
          <select name="screener_country">
            <option value="">Skip screener</option>
            <option>United States</option>
            <option>Japan</option>
            <option>United Kingdom</option>
            <option>Canada</option>
            <option>Australia</option>
            <option>Germany</option>
            <option>France</option>
            <option>India</option>
            <option>South Korea</option>
            <option>Hong Kong</option>
          </select>
        </label>
        <label>Market period
          <select name="years">
            <option value="1">1 year</option>
            <option value="3">3 years</option>
            <option value="5" selected>5 years</option>
            <option value="10">10 years</option>
          </select>
        </label>
        <label>Strategy lens
          <select name="strategy">
            <option>Venture & Growth</option>
            <option>Private Equity / Roll-Up</option>
            <option>Public Equity Review</option>
            <option>Distressed / Special Situations</option>
            <option>Real Assets</option>
            <option>Funds & Co-Investments</option>
            <option>Civic Engagement</option>
          </select>
        </label>
        <label>Pitch deck / financials
          <input name="document" type="file" accept=".txt,.md,.csv,.pdf">
        </label>
      </div>
      <label>Paste notes, article text, deck text, SEC filing excerpt, or financials
        <textarea name="notes" rows="10" placeholder="Paste real financial excerpts here. The app will extract numeric claims, classify them, and keep source context attached."></textarea>
      </label>
    </form>

    <section class="feature-grid" id="source-stack">
      <div><strong>Public Disclosures</strong><span>SEC, EDINET, JPX, LSE, SEDAR+, ASX, DART, HKEX and more starting links.</span></div>
      <div><strong>Market Explainer</strong><span>Drawdown, return windows, volatility, benchmark and peer comparison, plus catalyst hypotheses.</span></div>
      <div><strong>Business Map</strong><span>Products, business model, transactions, corporate actions, source quality, and missing diligence.</span></div>
    </section>

    <section class="rules" id="deployment">
      <strong>Deployment note:</strong> for hosted AI chat, set <code>OPENAI_API_KEY</code> in your hosting platform environment variables. The app uses no-key Yahoo Finance public endpoints for global market data where available and adds exchange/regulator disclosure links for international issuers.
    </section>
  </section>
</main>
"""


CSS = """
:root {
  color-scheme: light;
  --ink: #16211f;
  --muted: #5e6c68;
  --line: #d8dfdc;
  --paper: #f7faf8;
  --panel: #ffffff;
  --accent: #146c5f;
  --accent-2: #8a4a2f;
  --soft: #eef5f2;
  --nav: #102421;
  --warning: #8a4a2f;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: #f3f7f5;
  color: var(--ink);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.app-shell { min-height: 100vh; display: grid; grid-template-columns: 250px minmax(0, 1fr); }
.app-sidebar {
  background: var(--nav);
  color: #fff;
  min-height: 100vh;
  padding: 24px 18px;
  position: sticky;
  top: 0;
  align-self: start;
}
.brand-mark {
  align-items: center;
  background: #e8f4ef;
  border-radius: 12px;
  color: var(--accent);
  display: inline-flex;
  font-weight: 900;
  height: 46px;
  justify-content: center;
  margin-bottom: 24px;
  width: 46px;
}
.app-sidebar nav { display: grid; gap: 8px; }
.app-sidebar a {
  border-radius: 10px;
  color: rgba(255,255,255,.82);
  font-weight: 800;
  padding: 10px 12px;
  text-decoration: none;
}
.app-sidebar a:hover { background: rgba(255,255,255,.10); color: #fff; }
.app-main { min-width: 0; padding: 28px; }
.app-header {
  align-items: end;
  display: flex;
  gap: 24px;
  justify-content: space-between;
  margin: 0 auto 18px;
  max-width: 1260px;
}
.eyebrow { color: var(--accent-2); font-size: 13px; font-weight: 800; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .04em; }
h1 { font-size: 38px; line-height: 1.05; margin: 0; letter-spacing: -0.03em; }
.subhead { color: var(--muted); margin: 8px 0 0; }
h2 { font-size: 22px; margin-top: 34px; padding-top: 22px; border-top: 1px solid var(--line); }
h3 { font-size: 17px; margin-top: 22px; }
.panel, .brief, .rules, .chat-panel, .metric-strip, .feature-grid > div {
  background: rgba(255,255,255,.94);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 18px 50px rgba(32, 46, 42, 0.08);
}
.panel, .metric-strip, .feature-grid, .rules { margin-left: auto; margin-right: auto; max-width: 1260px; }
.panel { padding: 22px; }
.panel-head { align-items: end; display: flex; gap: 16px; justify-content: space-between; margin-bottom: 16px; }
.panel-head h2 { border: 0; margin: 0; padding: 0; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
label { display: grid; gap: 7px; color: var(--muted); font-weight: 700; }
input, select, textarea {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 13px;
  color: var(--ink);
  background: #fff;
  font: inherit;
  outline: none;
}
input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(20,108,95,.10); }
textarea { resize: vertical; margin-top: 16px; }
button, .ghost {
  appearance: none;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 18px;
  margin-top: 16px;
  font-weight: 800;
  text-decoration: none;
}
button:hover { filter: brightness(.96); }
.ghost { background: transparent; color: var(--accent); margin: 0; }
.ghost.full { justify-content: center; margin-top: 16px; width: 100%; }
.metric-strip {
  display: grid;
  gap: 0;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 18px;
  overflow: hidden;
}
.metric-strip > div { border-right: 1px solid var(--line); padding: 16px; }
.metric-strip > div:last-child { border-right: 0; }
.metric-strip strong, .feature-grid strong { display: block; font-size: 15px; margin-bottom: 4px; }
.metric-strip span, .feature-grid span { color: var(--muted); display: block; font-size: 13px; }
.feature-grid { display: grid; gap: 16px; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 18px; }
.feature-grid > div { padding: 16px; }
.rules { color: var(--muted); margin-top: 18px; padding: 15px 18px; }
.result-shell {
  display: grid;
  gap: 18px;
  grid-template-columns: 220px minmax(0, 1fr);
  margin: 22px auto 52px;
  max-width: 1480px;
  padding: 0 22px;
}
.result-nav {
  align-self: start;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 18px 50px rgba(32, 46, 42, 0.08);
  padding: 16px;
  position: sticky;
  top: 18px;
}
.result-nav nav { display: grid; gap: 6px; }
.result-nav a {
  border-radius: 8px;
  color: var(--ink);
  font-weight: 800;
  padding: 8px 10px;
  text-decoration: none;
}
.result-nav a:hover { background: var(--soft); color: var(--accent); }
.result-main { min-width: 0; }
.brief { margin: 0 0 24px; padding: 28px; overflow-x: auto; }
.brief h1:first-child { border-bottom: 1px solid var(--line); padding-bottom: 18px; }
.chat-panel { margin: 22px 0 52px; padding: 22px; }
.chat-head { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 14px; }
.chat-head h2 { border: 0; margin: 0; padding: 0; }
.chat-log {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fbfdfc;
  min-height: 160px;
  max-height: 380px;
  overflow-y: auto;
  padding: 14px;
}
.chat-message {
  border: 1px solid var(--line);
  border-radius: 8px;
  margin: 0 0 10px;
  max-width: 86%;
  padding: 10px 12px;
  white-space: pre-wrap;
}
.chat-message.assistant { background: #fff; color: var(--ink); }
.chat-message.user { background: var(--accent); border-color: var(--accent); color: #fff; margin-left: auto; }
.chat-form { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; margin-top: 12px; }
.chat-form input { min-height: 44px; }
.chat-form button { margin-top: 0; }
.sr-only { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
.table-wrap { width: 100%; overflow-x: auto; margin: 12px 0 22px; border: 1px solid var(--line); border-radius: 8px; }
.brief table { border-collapse: collapse; width: 100%; min-width: 780px; font-size: 14px; background: #fff; }
.brief th { background: var(--soft); color: #233330; text-align: left; font-weight: 900; }
.brief th, .brief td { border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); padding: 10px; vertical-align: top; }
.brief tr:last-child td { border-bottom: 0; }
.brief li { margin-bottom: 6px; }
.brief p { margin: 10px 0; }
.chart { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; margin: 16px 0 22px; background: white; box-shadow: 0 10px 30px rgba(32,46,42,.05); }
a { color: var(--accent); }
code { background: var(--soft); border-radius: 6px; padding: 2px 5px; }
@media (max-width: 780px) {
  .app-shell { grid-template-columns: 1fr; }
  .app-sidebar { min-height: auto; position: static; }
  .app-sidebar nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .app-main { padding: 20px 14px; }
  .app-header, .panel-head { align-items: start; flex-direction: column; }
  .metric-strip, .feature-grid, .result-shell { grid-template-columns: 1fr; }
  .result-nav { position: static; }
  .grid { grid-template-columns: 1fr; }
  .chat-form { grid-template-columns: 1fr; }
  .chat-message { max-width: 100%; }
  h1 { font-size: 29px; }
}
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/static/styles.css":
            self.send_response(200)
            self.send_header("Content-Type", "text/css")
            self.end_headers()
            self.wfile.write(CSS.encode("utf-8"))
            return
        if self.path.startswith("/outputs/"):
            name = Path(urllib.parse.unquote(self.path.split("/outputs/", 1)[1])).name
            file_path = OUTPUT_DIR / name
            if not file_path.exists():
                self.send_error(404, "Output file not found")
                return
            content_type = "image/svg+xml" if file_path.suffix.lower() == ".svg" else "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.end_headers()
            self.wfile.write(file_path.read_bytes())
            return
        if self.path == "/download":
            path = OUTPUT_DIR / "latest_brief.md"
            if not path.exists():
                self.send_error(404, "No brief generated yet")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="advanced_dd_brief.md"')
            self.end_headers()
            self.wfile.write(path.read_bytes())
            return
        if self.path == "/download_screener.xlsx":
            rows = SCREENER_STATE.get("rows", [])
            country = str(SCREENER_STATE.get("country") or "country_screener")
            if not isinstance(rows, list):
                rows = []
            payload = screener_workbook_bytes(rows, country)
            is_xlsx = payload[:2] == b"PK"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" if is_xlsx else "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="country_overvaluation_screener.xlsx"' if is_xlsx else 'attachment; filename="country_overvaluation_screener.csv"')
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html_page(FORM))

    def do_POST(self) -> None:
        if self.path == "/chat":
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8", errors="replace")
            fields = urllib.parse.parse_qs(body)
            question = fields.get("question", [""])[0]
            try:
                answer = answer_chat_question(question)
                payload = json.dumps({"answer": answer}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except Exception as exc:
                payload = json.dumps({"answer": f"Chat failed: {exc}"}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            return

        if self.path != "/generate":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        content_type = self.headers.get("Content-Type", "")
        body = self.rfile.read(length)
        fields, files = parse_multipart(content_type, body)
        try:
            brief = build_brief(fields, files)
            body_html = FORM + result_shell(brief)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html_page(body_html))
        except Exception as exc:
            self.send_error(500, f"Brief generation failed: {exc}")


def main() -> None:
    port = int(os.getenv("PORT", "8501"))
    host = os.getenv("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print("Advanced DD Brief Generator running locally")
    print(f"Open this on your computer only: http://{host}:{port}")
    print("Press Control+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
