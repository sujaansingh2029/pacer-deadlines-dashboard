# Investment DD Workbench

Advanced web app for generating source-backed pre-investment diligence briefs.

## What It Does

- Pulls SEC Form 10-Q filings for U.S. public companies when available.
- Resolves global tickers through Yahoo Finance public endpoints.
- Supports international tickers such as `7203.T`, `TSCO.L`, `SHOP.TO`, and `BHP.AX`.
- Shows trading details, currency, exchange, 52-week range, volume, market cap, P/E, P/B, dividend yield, and beta when available.
- Screens valuation with P/E, forward P/E, P/B, peer medians, sector caveats, and overvaluation warnings.
- Adds a country-based overvaluation screener for liquid consumer/consumables stocks.
- Compares screened stocks against western-market benchmarks such as SPY.
- Exports the country screener to an Excel workbook.
- Includes S&P Global placeholders/source notes without scraping licensed S&P data.
- Builds market charts for price trend, indexed comparison, drawdown, annual returns, and growth/loss scenarios.
- Adds an investment simulator for 1-year, 3-year, 5-year, and 10-year outcomes.
- Adds a sample $1,000 monthly allocation model across target stock, benchmark/core ETF, and cash/watchlist reserve.
- Finds products, business model, major transactions, and corporate actions from source text and public headlines.
- Adds disclosure links for international exchanges and regulators.
- Rejects noisy website numbers such as phone numbers, footer text, product promos, and copyright years.
- Includes a bottom-of-page chatbot that answers questions from the generated brief and source packet.

## Run Locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 server.py
```

Open:

```text
http://127.0.0.1:8501
```

## AI Chat

The app works without an OpenAI key using local source search. For AI-generated brief wording and stronger chatbot answers, set:

```bash
export OPENAI_API_KEY="your_key_here"
python3 server.py
```

Optional:

```bash
export OPENAI_MODEL="gpt-4.1-mini"
```

For Render or another host, set `OPENAI_API_KEY` in environment variables. Do not commit API keys to GitHub.

## Deploy

Upload or push these files:

- `server.py`
- `requirements.txt`
- `Procfile`
- `render.yaml`
- `README.md`

Render uses `render.yaml` and `Procfile` to run the app with `HOST=0.0.0.0`.

## Notes

The investment simulator and allocation model are educational screens only. They are based on historical price trends, valuation signals, volatility, drawdown, and benchmark comparison. They are not predictions and not personalized investment advice.

S&P Global Market Intelligence, Capital IQ, and Compustat are licensed data products. This app does not scrape or redistribute S&P Global data. If you have licensed access, use the Excel export as a template for adding S&P-sourced fields.
