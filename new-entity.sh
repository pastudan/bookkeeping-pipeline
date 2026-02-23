#!/usr/bin/env bash
# Usage: ./new-entity.sh <dir> <entity-name> <ein> <entity-type> <description>
# Example:
#   ./new-entity.sh ~/code/books-acme \
#     "Acme LLC" "12-3456789" "LLC" \
#     "Brief description of the business"
set -euo pipefail

TARGET="${1:?Usage: new-entity.sh <target-dir> <entity-name> <ein> <entity-type> <description>}"
ENTITY_NAME="${2:?missing entity name}"
EIN="${3:?missing EIN}"
ENTITY_TYPE="${4:?missing entity type}"
DESCRIPTION="${5:?missing description}"

PIPELINE_DIR="$(cd "$(dirname "$0")" && pwd)"
FORMATION_DATE="$(date +%Y-%m-%d)"
SHORT_NAME="$(basename "$TARGET")"

echo "Creating entity repo at: $TARGET"
mkdir -p "$TARGET/data/attachments" "$TARGET/reports"

# entity.json
cat > "$TARGET/entity.json" <<EOF
{
  "name": "$ENTITY_NAME",
  "shortName": "$SHORT_NAME",
  "ein": "$EIN",
  "entityType": "$ENTITY_TYPE",
  "formationDate": "$FORMATION_DATE",
  "description": "$DESCRIPTION",
  "dataSources": ["mercury"]
}
EOF

# .env placeholder
cat > "$TARGET/.env" <<'EOF'
MERCURY_API_TOKEN=
MERCURY_ACCOUNT_ID=
GOOGLE_API_KEY=
EOF

# main.beancount skeleton
cat > "$TARGET/main.beancount" <<EOF
; ${ENTITY_NAME} — Main Ledger
; Hand-maintained: accounts, opening balances, and entity config.
; Transactions are compiled into YYYY.beancount by the pipeline.

option "title" "${ENTITY_NAME}"
option "operating_currency" "USD"

; ── Bank Accounts ──────────────────────────────────────────────────────────────

1900-01-01 open Assets:Bank:Mercury                               USD
  description: "Mercury business checking account"

; ── Equity ────────────────────────────────────────────────────────────────────

1900-01-01 open Equity:Opening                                    USD
  description: "Opening balance equity"

; ── Include compiled transactions ─────────────────────────────────────────────

; include "${FORMATION_DATE:0:4}.beancount"
EOF

# docker-compose.yml
cat > "$TARGET/docker-compose.yml" <<EOF
version: "3.8"

services:
  fava:
    image: yegle/fava:latest
    container_name: ${SHORT_NAME}-fava
    ports:
      - "5050:5000"
    volumes:
      - .:/bean
    command:
      - "--host"
      - "0.0.0.0"
      - "--port"
      - "5000"
      - "/bean/main.beancount"
    restart: unless-stopped
    environment:
      - TZ=America/Los_Angeles
EOF

# .gitignore
cat > "$TARGET/.gitignore" <<'EOF'
# Generated year ledgers (compiled by pipeline step 6)
[0-9][0-9][0-9][0-9].beancount

# Secrets
.env

# Node
node_modules/

# macOS
.DS_Store
EOF

# README
cat > "$TARGET/README.md" <<EOF
# ${ENTITY_NAME} — Books

Accounting ledger powered by [bookkeeping-pipeline](https://github.com/pastudan/bookkeeping-pipeline).

## Setup

\`\`\`bash
git clone --recurse-submodules <this-repo>
cd $(basename "$TARGET")
cp pipeline/.env.example .env   # fill in your API keys
cd pipeline && npm install && cd ..
\`\`\`

## Run

\`\`\`bash
./pipeline/0-run-all.sh 2025
\`\`\`

## View in Fava

\`\`\`bash
./pipeline/scripts/fava.sh
# open http://localhost:5050
\`\`\`
EOF

# Add pipeline as submodule (from the pipeline repo itself)
cd "$TARGET"
git init -b main
git submodule add "$(git -C "$PIPELINE_DIR" remote get-url origin 2>/dev/null || echo 'https://github.com/pastudan/bookkeeping-pipeline.git')" pipeline

echo ""
echo "Entity repo created at: $TARGET"
echo ""
echo "Next steps:"
echo "  1. Edit $TARGET/.env — add your Mercury and Google API keys"
echo "  2. Edit $TARGET/entity.json — review/update entity metadata"
echo "  3. Edit $TARGET/main.beancount — add your chart of accounts"
echo "  4. cd pipeline && npm install"
echo "  5. ./pipeline/0-run-all.sh $(date +%Y)"
