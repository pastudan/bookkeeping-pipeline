#!/usr/bin/env node
/**
 * Reconcile transactions.json ↔ YYYY.beancount
 *
 * Shows differences between what transactions.json says a transaction is
 * categorized as vs what the beancount file actually contains (after manual
 * edits). With --sync it writes the beancount state back into
 * transactions.json so step 6 can regenerate a correct file.
 *
 * Usage:
 *   node pipeline/7-reconcile.js [--year 2025] [--sync]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { paths, loadJSON, ENTITY_ROOT, parseYear } from "./config.js";

const YEAR = parseYear();
const SYNC = process.argv.includes("--sync");

const beancountPath = join(ENTITY_ROOT, `${YEAR}.beancount`);

if (!existsSync(beancountPath)) {
  console.error(`No beancount file found: ${beancountPath}`);
  process.exit(1);
}

// ── Parse YYYY.beancount ──────────────────────────────────────────────────────
//
// Returns Map<mercuryId, { date, narration, account, note }>
// "account" is the first non-Mercury posting leg.

function parseBeancount(content) {
  const result = new Map();
  const lines = content.split("\n");
  let cur = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Transaction header with mercury tag
    const header = line.match(
      /^(\d{4}-\d{2}-\d{2})\s+[!*]\s+"([^"]*)"\s+.*#mercury-([a-f0-9-]+)/
    );
    if (header) {
      cur = { date: header[1], narration: header[2], mercuryId: header[3], note: null, account: null };
      continue;
    }

    if (!cur) continue;

    // Blank line → end of transaction block
    if (line.trim() === "") {
      if (cur.account) result.set(cur.mercuryId, cur);
      cur = null;
      continue;
    }

    // Metadata: note: "..."
    const noteMeta = line.match(/^\s+note:\s+"(.*)"\s*$/);
    if (noteMeta) { cur.note = noteMeta[1]; continue; }

    // Posting: AccountName  [±]amount USD
    // Capture first non-Mercury posting as the categorization account.
    if (cur.account === null) {
      const posting = line.match(/^\s+([\w:]+(?::[\w]+)*)\s+(-?[\d,]+\.\d+)\s+USD/);
      if (posting && posting[1] !== "Assets:Bank:Mercury") {
        cur.account = posting[1];
      }
    }
  }

  // Handle file not ending with blank line
  if (cur?.account) result.set(cur.mercuryId, cur);

  return result;
}

// ── Load data ─────────────────────────────────────────────────────────────────

const beanTxns = parseBeancount(readFileSync(beancountPath, "utf8"));
const jsonTxns = loadJSON(paths.transactions);

console.log(`Parsed ${beanTxns.size} transactions from ${YEAR}.beancount`);
console.log(`Loaded  ${jsonTxns.length} transactions from transactions.json\n`);

// ── Diff ──────────────────────────────────────────────────────────────────────

const diffs = [];

for (const t of jsonTxns) {
  const bean = beanTxns.get(t.id);
  if (!bean) continue; // not in this year's beancount

  const jsonAcct = t.bookkeeping?.account ?? "(none)";
  const beanAcct = bean.account ?? "(none)";
  const jsonNote = t.bookkeeping?.note ?? null;
  const beanNote = bean.note ?? null;

  const acctDiffers = jsonAcct !== beanAcct;
  const noteDiffers = jsonNote !== beanNote;

  if (acctDiffers || noteDiffers) {
    diffs.push({ t, bean, jsonAcct, beanAcct, jsonNote, beanNote, acctDiffers, noteDiffers });
  }
}

if (diffs.length === 0) {
  console.log("✓ No differences found — transactions.json and beancount are in sync.");
  process.exit(0);
}

console.log(`Found ${diffs.length} discrepancies:\n`);

const COL = { date: 10, desc: 28, from: 38, to: 38 };
const header =
  "Date".padEnd(COL.date) + "  " +
  "Description".padEnd(COL.desc) + "  " +
  "transactions.json".padEnd(COL.from) + "  " +
  "beancount (source of truth)";
console.log(header);
console.log("─".repeat(header.length));

for (const { t, bean, jsonAcct, beanAcct, jsonNote, beanNote, acctDiffers, noteDiffers } of diffs) {
  const date = (t.mercury?.postedAt || "").split("T")[0] || "?";
  const desc = (t.mercury?.counterpartyName || t.mercury?.note || "?").slice(0, COL.desc - 1);

  if (acctDiffers) {
    console.log(
      date.padEnd(COL.date) + "  " +
      desc.padEnd(COL.desc) + "  " +
      jsonAcct.padEnd(COL.from) + "  " +
      beanAcct
    );
  }
  if (noteDiffers) {
    const label = "(note)".padEnd(COL.date + 2 + COL.desc + 2);
    console.log(
      label +
      (jsonNote ?? "—").padEnd(COL.from) + "  " +
      (beanNote ?? "—")
    );
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

if (!SYNC) {
  console.log(`\nRun with --sync to write the beancount values back into transactions.json.`);
  process.exit(0);
}

console.log("\nSyncing beancount → transactions.json ...");

let syncCount = 0;
const updated = jsonTxns.map((t) => {
  const bean = beanTxns.get(t.id);
  if (!bean) return t;

  const jsonAcct = t.bookkeeping?.account ?? "(none)";
  const jsonNote = t.bookkeeping?.note ?? null;
  const acctDiffers = jsonAcct !== bean.account;
  const noteDiffers = jsonNote !== (bean.note ?? null);

  if (!acctDiffers && !noteDiffers) return t;

  syncCount++;
  return {
    ...t,
    bookkeeping: {
      ...t.bookkeeping,
      account: bean.account,
      ...(bean.note !== null ? { note: bean.note } : {}),
      // Mark as manually overridden so future LLM re-runs don't clobber this.
      override: true,
    },
  };
});

writeFileSync(paths.transactions, JSON.stringify(updated, null, 2));
console.log(`✓ Updated ${syncCount} entries in transactions.json`);
console.log(`  (marked with override: true — step 5 will skip re-categorizing these)\n`);

// Remind about compile script caveats
console.log("Next steps:");
console.log("  1. Review the changes above look correct");
console.log(`  2. Re-run step 6 to regenerate ${YEAR}.beancount from the updated transactions.json:`);
console.log(`       node pipeline/6-compile-beancount.js ${YEAR}`);
console.log("  Note: step 6 also overwrites main.beancount — any manual account additions");
console.log("  there (e.g. Assets:Receivable:*) should be moved into chart-of-accounts.json first.");
