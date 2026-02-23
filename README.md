# bookkeeping-pipeline

Shared accounting pipeline used as a git submodule in entity books repos.

Handles: Mercury transaction download → receipt OCR → LLM categorization → Beancount compilation → HTML reports.

## Usage (from an entity repo)

```bash
./pipeline/0-run-all.sh 2025
```

## Create a new entity repo

```bash
./pipeline/new-entity.sh ~/code/books-mycompany \
  "My Company LLC" "12-3456789" "LLC" \
  "Brief description of the business"
```

## Entity repo layout

```
books-mycompany/
├── pipeline/          ← this repo (git submodule)
├── entity.json        ← name, EIN, description, partners
├── .env               ← MERCURY_API_TOKEN, MERCURY_ACCOUNT_ID, GOOGLE_API_KEY
├── main.beancount     ← hand-maintained accounts & config
├── docker-compose.yml ← Fava viewer
├── data/
│   ├── transactions.json
│   ├── chart-of-accounts.json
│   └── attachments/
└── reports/
    ├── pnl-gaap-YYYY.html
    └── partner-report.html
```

## entity.json schema

```json
{
  "name": "Acme LLC",
  "shortName": "books-acme",
  "ein": "12-3456789",
  "entityType": "LLC",
  "formationDate": "2025-01-01",
  "description": "Brief description of the business and its primary activity",
  "dataSources": ["mercury"],
  "openingDate": "2025-01-01"
}
```

## Pipeline steps

| Script | Description |
|--------|-------------|
| `0-run-all.sh` | Runs all steps in order |
| `1-download-mercury-transactions.js` | Fetch all transactions from Mercury API |
| `2-download-mercury-attachments.js` | Download receipt PDFs/images |
| `3-ocr-receipts.js` | OCR receipts with Gemini Flash |
| `4-generate-chart-of-accounts.js` | LLM-generate chart of accounts (interactive) |
| `5-categorize-transactions.js` | Batch-categorize transactions with Gemini Flash |
| `6-compile-beancount.js` | Compile `YYYY.beancount` from transactions.json |
| `7-reconcile.js` | Reconcile transactions.json vs beancount |
| `7-missing-receipts.js` | Report on transactions missing receipts |
| `scripts/generate-pnl.js` | Generate interactive P&L HTML report |
| `scripts/partner-report.js` | Generate partner capital/distributions report |
