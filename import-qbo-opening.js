#!/usr/bin/env node
/**
 * Import a QBO Balance Sheet CSV export as a single Beancount opening-balance
 * transaction. Run this once when migrating from QBO.
 *
 * Usage (from entity repo root):
 *   node pipeline/import-qbo-opening.js <balance-sheet.csv> [--date YYYY-MM-DD] [--map account-map.json]
 *
 * Output:
 *   opening.beancount   — single transaction + open directives for all accounts
 *
 * Account mapping:
 *   By default, QBO account names are converted to Beancount style automatically.
 *   Supply --map <file> with a JSON object to override specific names, e.g.:
 *   {
 *     "Mercury Checking (1399)": "Assets:Bank:Mercury",
 *     "Chase Ink Business":      "Liabilities:CreditCard:ChaseInk"
 *   }
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { ENTITY_ROOT } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : def;
}

const csvArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!csvArg) {
  console.error("Usage: node pipeline/import-qbo-opening.js <balance-sheet.csv>");
  process.exit(1);
}

const csvPath  = resolve(csvArg);
const mapPath  = arg("--map", null);
const dateFlag = arg("--date", null);

// ── Load optional account map ─────────────────────────────────────────────────

const userMap = mapPath ? JSON.parse(readFileSync(mapPath, "utf8")) : {};

// ── Default QBO → Beancount name conversions ──────────────────────────────────
// Keys are substrings (case-insensitive) matched against the QBO account name.
// Override or extend with --map.

const DEFAULT_RULES = [
  // Assets
  [/mercury.*checking|checking.*mercury/i,   "Assets:Bank:Mercury"],
  [/mercury.*savings|savings.*mercury/i,     "Assets:Bank:MercurySavings"],
  [/chase.*checking|checking.*chase/i,       "Assets:Bank:Chase"],
  [/ramp/i,                                  "Assets:Bank:RAMP"],
  [/advance.*shareholder|shareholder.*advance/i, "Assets:Receivable:AdvancesToShareholder"],
  [/prepaid/i,                               "Assets:Prepaid"],
  [/tax.*receivable|receivable.*tax/i,       "Assets:Receivable:Taxes"],
  [/accounts receivable/i,                   "Assets:AccountsReceivable"],
  [/uncategorized asset/i,                   "Assets:Uncategorized"],
  // Liabilities
  [/brex/i,                                  "Liabilities:CreditCard:Brex"],
  [/chase ink|ink.*chase/i,                  "Liabilities:CreditCard:ChaseInk"],
  [/chase.*credit|credit.*chase/i,           "Liabilities:CreditCard:Chase"],
  [/payable.*shareholder|shareholder.*payable/i, "Liabilities:Payable:Shareholder"],
  [/employer.*benefit|benefit.*liabil/i,     "Liabilities:Payroll:Benefits"],
  [/payroll liabil/i,                        "Liabilities:Payroll"],
  [/ppp loan/i,                              "Liabilities:Loans:PPP"],
  [/accounts payable/i,                      "Liabilities:AccountsPayable"],
  [/deferred revenue/i,                      "Liabilities:DeferredRevenue"],
  [/sales tax/i,                             "Liabilities:SalesTax"],
  // Equity
  [/common stock/i,                          "Equity:CommonStock"],
  [/preferred stock/i,                       "Equity:PreferredStock"],
  [/safe\b/i,                                "Equity:SAFE"],
  [/owner.*investment|investment.*owner/i,   "Equity:OwnersInvestment"],
  [/retained earnings/i,                     "Equity:RetainedEarnings"],
  [/net income/i,                            "Equity:RetainedEarnings"],  // folded in
];

function toBeancountAccount(qboName, sectionPrefix) {
  // Explicit user override takes priority
  if (userMap[qboName]) return userMap[qboName];

  // Try default rules
  for (const [pattern, acct] of DEFAULT_RULES) {
    if (pattern.test(qboName)) return acct;
  }

  // Auto-generate from QBO name + section prefix
  const clean = qboName
    .replace(/\s*\(.*?\)/g, "")   // strip "(1399)" account numbers
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

  return `${sectionPrefix}:${clean}`;
}

// ── Parse the QBO Balance Sheet CSV ──────────────────────────────────────────

const lines = readFileSync(csvPath, "utf8").split("\n");

// Extract date from header line 3: "As of December 31, 2024"
let asOfDate = dateFlag;
if (!asOfDate) {
  for (const line of lines.slice(0, 10)) {
    const m = line.match(/As of (.+?),?\s*["']?\s*$/i);
    if (m) {
      const d = new Date(m[1].replace(/['"]/g, "").trim());
      if (!isNaN(d)) {
        asOfDate = d.toISOString().slice(0, 10);
        break;
      }
    }
  }
  asOfDate = asOfDate || new Date().toISOString().slice(0, 10);
}

// Section detection
const SECTION_PREFIXES = {
  "assets":    "Assets",
  "liabilities": "Liabilities",
  "equity":    "Equity",
};

let currentPrefix = "Assets";
const entries = [];  // { qboName, beancountAccount, amount }

function parseAmount(raw) {
  if (!raw) return null;
  const clean = raw.replace(/[$,"']/g, "").trim();
  if (clean === "" || clean === "0.00" || clean === "0") return null;
  return parseFloat(clean);
}

// Skip the first 4 header lines (report title, entity name, date, blank)
// and the trailing footer line (Accrual Basis ... timestamp)
const dataLines = lines.slice(4).filter(
  (l) => !/accrual basis/i.test(l)
);

for (const rawLine of dataLines) {
  const line = rawLine.replace(/^\s*"|"\s*$/g, "").trim();
  if (!line) continue;

  const commaIdx = rawLine.indexOf(",");
  if (commaIdx === -1) continue;
  const label = rawLine.slice(0, commaIdx).replace(/^"|"$/g, "").trim();
  const value = rawLine.slice(commaIdx + 1).replace(/^"|"$/g, "").trim();

  if (!label) continue;

  // Skip the column-header row and section separators
  if (
    label === "Distribution account" ||
    label === "Liabilities and Equity"
  ) continue;

  // Section detection
  const lower = label.toLowerCase();
  if (SECTION_PREFIXES[lower]) {
    currentPrefix = SECTION_PREFIXES[lower];
    continue;
  }

  // Skip sub-section headers and totals (no dollar amount, or "Total for...")
  if (lower.startsWith("total") || lower.startsWith("current ") ||
      lower.startsWith("long-term") || lower.startsWith("other current") ||
      lower === "bank accounts" || lower === "credit cards") continue;

  // Skip zero-value accounts
  const amount = parseAmount(value);
  if (amount === null) continue;

  const acct = toBeancountAccount(label, currentPrefix);
  entries.push({ qboName: label, beancountAccount: acct, amount });
}

// ── Merge duplicate accounts (e.g. Retained Earnings + Net Income both → Equity:RetainedEarnings)

const merged = new Map();
for (const e of entries) {
  const existing = merged.get(e.beancountAccount);
  if (existing) {
    existing.amount += e.amount;
    existing.qboName += ` + ${e.qboName}`;
  } else {
    merged.set(e.beancountAccount, { ...e });
  }
}

const finalEntries = [...merged.values()].filter((e) => Math.abs(e.amount) > 0.005);

// ── Compute signs for Beancount ───────────────────────────────────────────────
// QBO balance sheet shows all values as positive magnitudes.
// In Beancount: assets are positive, liabilities & equity are negative.

function beancountAmount(acct, qboAmount) {
  if (acct.startsWith("Assets")) return qboAmount;
  return -qboAmount;   // Liabilities and Equity are credits (negative in Beancount)
}

// ── Verify it balances ────────────────────────────────────────────────────────

const total = finalEntries.reduce(
  (sum, e) => sum + beancountAmount(e.beancountAccount, e.amount),
  0
);

if (Math.abs(total) > 0.02) {
  console.warn(`⚠️  Opening entry does not balance — residual: $${total.toFixed(2)}`);
  console.warn("   Check for missing accounts or sign errors.");
} else {
  console.log(`✓  Balanced (residual: $${total.toFixed(2)})`);
}

// ── Generate opening.beancount ────────────────────────────────────────────────
// Note: open directives are NOT emitted here — they belong in main.beancount.
// Add any new accounts discovered here to main.beancount manually.

const txnLines = finalEntries.map((e) => {
  const bAmt = beancountAmount(e.beancountAccount, e.amount);
  const sign = bAmt < 0 ? "-" : " ";
  const abs  = Math.abs(bAmt).toFixed(2);
  const pad  = e.beancountAccount.padEnd(45);
  return `  ${pad} ${sign}${abs} USD  ; QBO: ${e.qboName}`;
});

console.log("\nAccounts used in opening entry (ensure all are open in main.beancount):");
finalEntries.forEach((e) => console.log(`  ${e.beancountAccount}`));

const out = `; Opening balances imported from QBO Balance Sheet as of ${asOfDate}
; Generated by pipeline/import-qbo-opening.js — do not edit by hand.
; Source: ${csvPath.split("/").pop()}
; All accounts must be opened in main.beancount.

; ── Opening balance entry ────────────────────────────────────────────────────

${asOfDate} * "Opening balances — migrated from QBO"
${txnLines.join("\n")}
`;

const outPath = resolve(ENTITY_ROOT, "opening.beancount");
writeFileSync(outPath, out, "utf8");
console.log(`Generated: ${outPath}`);
console.log("");
console.log("\nNext steps:");
console.log("  1. Review opening.beancount — check account names and amounts");
console.log("  2. If any account names are wrong, add --map account-map.json to override");
console.log("  3. Ensure all accounts listed above are opened in main.beancount");
console.log(`  4. Confirm 'include "opening.beancount"' is in main.beancount`);
