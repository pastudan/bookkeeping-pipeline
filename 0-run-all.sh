#!/usr/bin/env bash
set -euo pipefail

YEAR="${1:-$(date +%Y)}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ENTITY_ROOT="$(cd "$DIR/.." && pwd)"
CHART="$ENTITY_ROOT/data/chart-of-accounts.json"

echo "=== Accounting Pipeline — Year $YEAR ==="
echo "Entity root: $ENTITY_ROOT"
echo ""

# Steps 1–3 and 5–6: always run (each has internal idempotency).
# Step 4 (chart of accounts): interactive + LLM — skip if chart already exists.
#   To regenerate the chart, run step 4 manually:
#     node pipeline/4-generate-chart-of-accounts.js --send

for step in \
  "$DIR/1-download-mercury-transactions.js" \
  "$DIR/2-download-mercury-attachments.js" \
  "$DIR/3-ocr-receipts.js" \
  "$DIR/5-categorize-transactions.js" \
  "$DIR/6-compile-beancount.js"; do

  name="$(basename "$step")"
  echo "──────────────────────────────────────────"
  echo "Running $name ..."
  echo "──────────────────────────────────────────"
  node "$step" --year "$YEAR"
  echo ""
done

# Step 4 skip notice
if [ -f "$CHART" ]; then
  echo "── 4-generate-chart-of-accounts.js ───────"
  echo "Skipped — chart-of-accounts.json already exists."
  echo "Run manually to regenerate: node pipeline/4-generate-chart-of-accounts.js --send"
  echo ""
fi

# Reports
echo "──────────────────────────────────────────"
echo "Generating reports ..."
echo "──────────────────────────────────────────"
node "$DIR/scripts/generate-pnl.js" "$YEAR"
node "$DIR/scripts/partner-report.js"
echo ""

echo "=== Pipeline complete ==="
