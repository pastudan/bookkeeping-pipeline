#!/usr/bin/env node
/**
 * Import a Chase credit card CSV export into transactions.json.
 *
 * Chase CSV format (downloaded from chase.com):
 *   Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo
 *
 * Skips: Payment, Reversal rows (already covered by Mercury bank transfers).
 * Auto-categorizes known merchants; leaves others as Expenses:Uncategorized.
 *
 * Usage (from entity repo root):
 *   node pipeline/import-chase.js <chase-export.csv>
 *   node pipeline/import-chase.js <chase-export.csv> --dry-run
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { paths, loadJSON, saveTransactions } from "./config.js";

const csvArg  = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dryRun  = process.argv.includes("--dry-run");

if (!csvArg) {
  console.error("Usage: node pipeline/import-chase.js <chase-export.csv> [--dry-run]");
  process.exit(1);
}

const csvPath = resolve(csvArg);

// ── Auto-categorization rules ────────────────────────────────────────────────
// First match wins.

const RULES = [
  [/amazon web services|aws/i,            "Expenses:COGS:Hosting"],
  [/google.*workspace|gsuite|google.*kube/i, "Expenses:Software"],
  [/monkeybrains/i,                       "Expenses:Office"],
  [/github/i,                             "Expenses:Software"],
  [/digitalocean/i,                       "Expenses:COGS:Hosting"],
  [/linode|akamai/i,                      "Expenses:COGS:Hosting"],
  [/stripe/i,                             "Expenses:COGS:MerchantFees"],
  [/twilio/i,                             "Expenses:Software"],
  [/adobe/i,                              "Expenses:Software"],
  [/notion/i,                             "Expenses:Software"],
  [/slack/i,                              "Expenses:Software"],
  [/dropbox/i,                            "Expenses:Software"],
  [/gusto/i,                              "Expenses:Software"],
  [/late fee|purchase interest charge|annual fee/i, "Expenses:BankFees"],
  [/ups|usps|fedex|shipbob|easypost/i,    "Expenses:COGS:Shipping"],
  [/legal|attorney|law /i,                "Expenses:Legal"],
];

function categorize(description) {
  for (const [pattern, account] of RULES) {
    if (pattern.test(description)) return { account, confidence: "high" };
  }
  return { account: "Expenses:Uncategorized", confidence: "low" };
}

// ── Parse date MM/DD/YYYY → YYYY-MM-DD ───────────────────────────────────────

function parseDate(mmddyyyy) {
  const [m, d, y] = mmddyyyy.split("/");
  return `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
}

// ── Generate stable ID ────────────────────────────────────────────────────────

function makeId(postDate, description, seenIds) {
  const datePart = postDate.replace(/-/g, "");
  const descPart = description.replace(/[^a-zA-Z0-9]/g, "").slice(0, 30);
  let id = `CHASE-${datePart}-${descPart}`;
  // Deduplicate in case same description + date appears twice
  let n = 1;
  while (seenIds.has(id)) { id = `CHASE-${datePart}-${descPart}-${++n}`; }
  seenIds.add(id);
  return id;
}

// ── Parse CSV ─────────────────────────────────────────────────────────────────

const lines = readFileSync(csvPath, "utf8").split("\n").filter(Boolean);
const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));

function parseRow(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { fields.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  fields.push(cur.trim());
  return Object.fromEntries(headers.map((h, i) => [h, (fields[i] || "").replace(/"/g, "").trim()]));
}

const rows = lines.slice(1).map(parseRow);

// ── Load existing transactions ────────────────────────────────────────────────

const transactions = loadJSON(paths.transactions);
const existingIds  = new Set(transactions.map((t) => t.id));
const seenIds      = new Set(transactions.map((t) => t.id));

// ── Process rows ──────────────────────────────────────────────────────────────

const SKIP_TYPES = new Set(["Payment", "Reversal"]);

const newTxns = [];
let skipped = 0, dupes = 0;

for (const row of rows) {
  if (!row["Post Date"] || !row["Description"]) continue;

  // Skip payment and reversal rows — already in Mercury as Chase Ink payments
  if (SKIP_TYPES.has(row["Type"])) { skipped++; continue; }

  const postDate = parseDate(row["Post Date"]);
  const txDate   = parseDate(row["Transaction Date"]);
  const amount   = parseFloat(row["Amount"] || "0");
  const desc     = row["Description"];
  const id       = makeId(postDate, desc, seenIds);

  if (existingIds.has(id)) { dupes++; continue; }

  const { account, confidence } = categorize(desc);

  newTxns.push({
    id,
    source: "chase",
    chase: {
      card:            row["Card"] || "",
      transactionDate: txDate,
      postDate,
      description:     desc,
      category:        row["Category"] || "",
      type:            row["Type"] || "",
      amount,
    },
    receipt:     null,
    bookkeeping: {
      account,
      reasoning:  `Chase Ink card charge — ${desc}`,
      confidence,
      override:   confidence === "high",
    },
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nChase CSV import: ${csvPath}`);
console.log(`  ${rows.length} rows total`);
console.log(`  ${skipped} payment/reversal rows skipped`);
console.log(`  ${dupes} already in transactions.json`);
console.log(`  ${newTxns.length} new transactions to import`);

if (newTxns.length === 0) {
  console.log("\nNothing new to import.");
  process.exit(0);
}

console.log("\nNew transactions:");
let totalNew = 0;
const acctCounts = {};
for (const t of newTxns) {
  const amt = t.chase.amount;
  totalNew += amt;
  acctCounts[t.bookkeeping.account] = (acctCounts[t.bookkeeping.account] || 0) + 1;
  const flag = t.bookkeeping.confidence === "low" ? " ← needs review" : "";
  console.log(`  ${t.chase.postDate}  ${amt.toFixed(2).padStart(9)}  ${t.chase.description.padEnd(32)}  ${t.bookkeeping.account}${flag}`);
}
console.log(`\n  Total amount: ${totalNew.toFixed(2)}`);
console.log("\nBy account:");
for (const [acct, n] of Object.entries(acctCounts).sort()) {
  console.log(`  ${acct.padEnd(40)} ${n}`);
}

if (dryRun) {
  console.log("\n--dry-run: no changes written.");
  process.exit(0);
}

// ── Write ─────────────────────────────────────────────────────────────────────

const merged = [...transactions, ...newTxns];
saveTransactions(merged);
console.log(`\nWrote ${newTxns.length} new transactions → ${paths.transactions}`);
console.log("Next: node pipeline/6-compile-beancount.js <year>");
