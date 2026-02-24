#!/usr/bin/env node
/**
 * Import a Mercury all-time transactions CSV export into transactions.json.
 *
 * This handles the full export format Mercury provides when you download
 * the complete transaction history (not the per-month QuickBooks/NetSuite pair).
 *
 * CSV columns:
 *   Date (UTC), Description, Amount, Status, Source Account, Bank Description,
 *   Reference, Note, Last Four Digits, Name On Card, Mercury Category, Category,
 *   GL Code, Timestamp, Original Currency, Check Number, Tags,
 *   Cardholder Email, Tracking ID
 *
 * Skips rows where Status = "Failed".
 *
 * IDs: uses Tracking ID when present; otherwise derives a stable ID from
 * the precise Timestamp + Amount (unique for any real-world transaction).
 *
 * Usage (from entity repo root):
 *   node pipeline/import-mercury-alltime.js <export.csv>
 *   node pipeline/import-mercury-alltime.js <export.csv> --dry-run
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { paths, loadJSON, saveTransactions } from "./config.js";

const csvArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");

if (!csvArg) {
  console.error("Usage: node pipeline/import-mercury-alltime.js <export.csv> [--dry-run]");
  process.exit(1);
}

const csvPath = resolve(csvArg);

// ── CSV parser ────────────────────────────────────────────────────────────────

function splitCSVLine(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === "," && !inQ) { fields.push(cur); cur = ""; }
    else cur += ch;
  }
  fields.push(cur);
  return fields;
}

function parseCSV(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]).map((h) => h.replace(/"/g, "").trim());
  return lines.slice(1).map((line) => {
    const fields = splitCSVLine(line);
    return Object.fromEntries(
      headers.map((h, i) => [h, (fields[i] ?? "").replace(/^"|"$/g, "").trim()])
    );
  });
}

// ── Date / timestamp helpers ──────────────────────────────────────────────────

// "MM-DD-YYYY HH:MM:SS"  →  "YYYY-MM-DDTHH:MM:SS.000Z"
function parseTimestamp(s) {
  if (!s) return null;
  const [datePart, timePart = "00:00:00"] = s.split(" ");
  const [m, d, y] = datePart.split("-");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${timePart}.000Z`;
}

// ── Stable ID generation ──────────────────────────────────────────────────────

// Prefer the Tracking ID (ACH/wire ref); fall back to timestamp-based synthetic ID.
function makeId(row, seenIds) {
  const trackingId = row["Tracking ID"]?.trim();
  if (trackingId) {
    let id = `MERCURY-${trackingId}`;
    let n = 1;
    while (seenIds.has(id)) id = `MERCURY-${trackingId}-${++n}`;
    seenIds.add(id);
    return id;
  }

  // Card / no-tracking-id transactions: use timestamp + amount (precise to second).
  const ts  = (row["Timestamp"] || row["Date (UTC)"]).replace(/[^0-9]/g, "");
  const amt = row["Amount"].replace(/[^0-9]/g, "");
  let id = `MERCURY-${ts}-${amt}`;
  let n = 1;
  while (seenIds.has(id)) id = `MERCURY-${ts}-${amt}-${++n}`;
  seenIds.add(id);
  return id;
}

// ── Derive Mercury-compatible kind / status ───────────────────────────────────

function deriveKind(row) {
  if (row["Last Four Digits"]) return "debitCardTransaction";
  return "externalTransfer";
}

function deriveStatus(amount) {
  return amount >= 0 ? "received" : "sent";
}

// ── Parse CSV ─────────────────────────────────────────────────────────────────

const rows = parseCSV(readFileSync(csvPath, "utf8"));

// ── Load existing transactions ────────────────────────────────────────────────

const existing = existsSync(paths.transactions) ? loadJSON(paths.transactions) : [];
const existingIds = new Set(existing.map((t) => t.id));
const seenIds     = new Set(existing.map((t) => t.id));

// ── Process rows ──────────────────────────────────────────────────────────────

const newTxns = [];
let skippedFailed = 0, dupes = 0;

for (const row of rows) {
  if (!row["Date (UTC)"] || row["Amount"] === "") continue;

  if (row["Status"]?.toLowerCase() === "failed") {
    skippedFailed++;
    continue;
  }

  const amount = parseFloat(row["Amount"]);
  const id     = makeId(row, seenIds);

  if (existingIds.has(id)) { dupes++; continue; }

  const postedAt = parseTimestamp(row["Timestamp"]) ?? parseTimestamp(row["Date (UTC)"]);

  newTxns.push({
    id,
    source: "mercury-csv",
    mercury: {
      amount,
      kind:             deriveKind(row),
      status:           deriveStatus(amount),
      postedAt,
      createdAt:        postedAt,
      description:      row["Description"]      || "",
      bankDescription:  row["Bank Description"] || "",
      note:             row["Note"]             || null,
      reference:        row["Reference"]        || null,
      sourceAccount:    row["Source Account"]   || "",
      lastFourDigits:   row["Last Four Digits"] || null,
      nameOnCard:       row["Name On Card"]     || null,
      mercuryCategory:  row["Mercury Category"] || null,
      originalCurrency: row["Original Currency"] || "USD",
      checkNumber:      row["Check Number"]     || null,
      tags:             row["Tags"]             || null,
      cardholderEmail:  row["Cardholder Email"] || null,
      trackingId:       row["Tracking ID"]      || null,
    },
    receipt:     null,
    bookkeeping: null,
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nMercury all-time CSV import: ${csvPath}`);
console.log(`  ${rows.length} rows total`);
console.log(`  ${skippedFailed} failed transactions skipped`);
console.log(`  ${dupes} already in transactions.json`);
console.log(`  ${newTxns.length} new transactions to import`);

if (newTxns.length > 0) {
  console.log("\nNew transactions (newest first):");
  let totalAmount = 0;
  for (const t of newTxns) {
    totalAmount += t.mercury.amount;
    const amt  = t.mercury.amount.toFixed(2).padStart(11);
    const desc = t.mercury.description.slice(0, 35).padEnd(35);
    const flag = t.mercury.kind === "debitCardTransaction" ? "  [card]" : "";
    console.log(`  ${t.mercury.postedAt.slice(0, 10)}  ${amt}  ${desc}${flag}`);
  }
  console.log(`\n  Net amount: ${totalAmount.toFixed(2)}`);
}

if (dryRun) {
  console.log("\n--dry-run: no changes written.");
  process.exit(0);
}

if (newTxns.length === 0) {
  console.log("\nNothing new to import.");
  process.exit(0);
}

// ── Write ─────────────────────────────────────────────────────────────────────

// Sort merged set by postedAt descending
const merged = [...existing, ...newTxns].sort((a, b) => {
  const da = a.mercury?.postedAt || a.mercury?.createdAt || "";
  const db = b.mercury?.postedAt || b.mercury?.createdAt || "";
  return db.localeCompare(da);
});

saveTransactions(merged);
console.log(`\nWrote ${newTxns.length} new transactions → ${paths.transactions}`);
console.log("Next: node pipeline/5-categorize-transactions.js");
