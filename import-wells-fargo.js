#!/usr/bin/env node
/**
 * Import a Wells Fargo business checking CSV export into transactions.json.
 *
 * Wells Fargo CSV format (no header row):
 *   Date (MM/DD/YYYY), Amount, *, (empty), Description
 *
 * Usage (from entity repo root):
 *   node pipeline/import-wells-fargo.js <export.csv>
 *   node pipeline/import-wells-fargo.js <export.csv> --dry-run
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { paths, loadJSON, saveTransactions } from "./config.js";

const csvArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");

if (!csvArg) {
  console.error("Usage: node pipeline/import-wells-fargo.js <export.csv> [--dry-run]");
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
  return fields.map((f) => f.replace(/^"|"$/g, "").trim());
}

// ── Date helper ───────────────────────────────────────────────────────────────

// MM/DD/YYYY → YYYY-MM-DD
function parseMDY(s) {
  const [m, d, y] = s.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// ── Stable ID generation ──────────────────────────────────────────────────────

function makeId(date, description, amount, seenIds) {
  const datePart = date.replace(/-/g, "");
  const descPart = description.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24).toUpperCase();
  const amtPart  = Math.round(Math.abs(amount) * 100);
  let id = `WF-${datePart}-${descPart}-${amtPart}`;
  let n = 1;
  while (seenIds.has(id)) id = `WF-${datePart}-${descPart}-${amtPart}-${++n}`;
  seenIds.add(id);
  return id;
}

// ── Parse CSV ─────────────────────────────────────────────────────────────────

const lines = readFileSync(csvPath, "utf8")
  .split("\n")
  .map((l) => l.replace(/\\\s*$/, "").trim())  // strip trailing backslash (WF quirk)
  .filter(Boolean);

// ── Load existing transactions ────────────────────────────────────────────────

const existing  = existsSync(paths.transactions) ? loadJSON(paths.transactions) : [];
const existingIds = new Set(existing.map((t) => t.id));
const seenIds     = new Set(existing.map((t) => t.id));

// ── Process rows ──────────────────────────────────────────────────────────────

const newTxns = [];
let dupes = 0, skipped = 0;

for (const line of lines) {
  const fields = splitCSVLine(line);
  if (fields.length < 5) { skipped++; continue; }

  const [rawDate, rawAmount, , , rawDescription] = fields;
  if (!rawDate || !rawAmount || !rawDescription) { skipped++; continue; }
  const description = rawDescription.replace(/\\+/g, "").trim();

  const date   = parseMDY(rawDate);
  const amount = parseFloat(rawAmount);
  if (isNaN(amount)) { skipped++; continue; }

  const id = makeId(date, description, amount, seenIds);
  if (existingIds.has(id)) { dupes++; continue; }

  const postedAt = `${date}T00:00:00.000Z`;

  newTxns.push({
    id,
    source: "wells-fargo",
    wellsFargo: {
      date,
      amount,
      description,
      postedAt,
    },
    receipt:     null,
    bookkeeping: null,
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nWells Fargo CSV import: ${csvPath}`);
console.log(`  ${lines.length} rows total`);
console.log(`  ${skipped} malformed rows skipped`);
console.log(`  ${dupes} already in transactions.json`);
console.log(`  ${newTxns.length} new transactions to import`);

if (newTxns.length > 0) {
  console.log("\nNew transactions (as ordered in CSV):");
  let total = 0;
  for (const t of newTxns) {
    total += t.wellsFargo.amount;
    const amt  = t.wellsFargo.amount.toFixed(2).padStart(11);
    const desc = t.wellsFargo.description.slice(0, 60);
    console.log(`  ${t.wellsFargo.date}  ${amt}  ${desc}`);
  }
  console.log(`\n  Net amount: ${total.toFixed(2)}`);
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

// Sort by date descending, WF transactions after mercury on same day
const merged = [...existing, ...newTxns].sort((a, b) => {
  const da = a.mercury?.postedAt || a.mercury?.createdAt || a.wellsFargo?.postedAt || "";
  const db = b.mercury?.postedAt || b.mercury?.createdAt || b.wellsFargo?.postedAt || "";
  return db.localeCompare(da);
});

saveTransactions(merged);
console.log(`\nWrote ${newTxns.length} new transactions → ${paths.transactions}`);
console.log("Next: node pipeline/5-categorize-transactions.js");
