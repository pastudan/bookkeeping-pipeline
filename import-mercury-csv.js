#!/usr/bin/env node
/**
 * Import Mercury transactions from the paired CSV exports (NetSuite + QuickBooks)
 * that were downloaded when the Mercury account was still open.
 *
 * NetSuite CSV  (netsuite-YYYY-MM-DD--YYYY-MM-DD.csv):
 *   Date (MM/DD/YYYY), Payer/Payee Name, Transaction Id, Transaction Type,
 *   Amount, Memo, NS Internal Customer Id, NS Customer Name, Invoice Number(s)
 *
 * QuickBooks CSV (quickbooks-export-p-tech-YYYY-MM-DD--YYYY-MM-DD.csv):
 *   Date (UTC), Description, Amount, Source Account, Bank Description,
 *   Reference, Note, Last Four Digits, Name On Card, Mercury Category,
 *   Category, GL Code, Timestamp, Original Currency, Check Number, Tags
 *
 * The two files are joined by (date, amount) to reconstruct the full Mercury
 * transaction record.  The NetSuite Transaction Id UUID becomes the canonical
 * transaction id, keeping it compatible with the rest of the pipeline.
 *
 * Usage (from entity repo root):
 *   node pipeline/import-mercury-csv.js                  # process all pairs
 *   node pipeline/import-mercury-csv.js --dry-run        # preview only
 *   node pipeline/import-mercury-csv.js --no-archive     # skip CSV archiving
 */

import { readdirSync, readFileSync, mkdirSync, renameSync, existsSync } from "fs";
import { resolve, join, basename } from "path";
import { paths, loadJSON, saveTransactions, ENTITY_ROOT } from "./config.js";

const dryRun    = process.argv.includes("--dry-run");
const noArchive = process.argv.includes("--no-archive");

const ARCHIVE_DIR = join(ENTITY_ROOT, "csv-archive", "mercury");

// ── CSV parser ────────────────────────────────────────────────────────────────

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

// ── Date normalisation ────────────────────────────────────────────────────────

// MM/DD/YYYY  →  YYYY-MM-DD
function parseMDY(s) {
  const [m, d, y] = s.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// MM-DD-YYYY  →  YYYY-MM-DD
function parseMDYDash(s) {
  const [m, d, y] = s.split("-");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// "MM-DD-YYYY HH:MM:SS"  →  ISO 8601 UTC string
function parseTimestamp(s) {
  if (!s) return null;
  const [datePart, timePart] = s.split(" ");
  const iso = parseMDYDash(datePart);
  return `${iso}T${timePart ?? "00:00:00"}.000Z`;
}

// ── Find CSV pairs in entity root ─────────────────────────────────────────────

function findPairs() {
  const files = readdirSync(ENTITY_ROOT);

  // netsuite-YYYY-MM-DD--YYYY-MM-DD.csv
  const nsFiles = files.filter((f) => /^netsuite-\d{4}-\d{2}-\d{2}--\d{4}-\d{2}-\d{2}\.csv$/.test(f));

  const pairs = [];
  for (const nsFile of nsFiles) {
    // Extract the date range suffix
    const range = nsFile.replace(/^netsuite-/, "").replace(/\.csv$/, "");
    const qbFile = `quickbooks-export-p-tech-${range}.csv`;
    if (files.includes(qbFile)) {
      pairs.push({ ns: join(ENTITY_ROOT, nsFile), qb: join(ENTITY_ROOT, qbFile) });
    } else {
      console.warn(`  ⚠  No matching QuickBooks file for ${nsFile} (expected ${qbFile})`);
    }
  }

  return pairs.sort((a, b) => basename(a.ns).localeCompare(basename(b.ns)));
}

// ── Derive Mercury-compatible fields ─────────────────────────────────────────

function deriveKind(nsType, lastFour) {
  if (lastFour) return "debitCardTransaction";
  if (nsType === "CREDIT") return "externalTransfer";
  return "externalTransfer";
}

function deriveStatus(nsType) {
  return nsType === "CREDIT" ? "received" : "sent";
}

// ── Process a single pair of CSV files ───────────────────────────────────────

function processPair(nsPath, qbPath, existingIds, seenIds) {
  const nsRows = parseCSV(readFileSync(nsPath, "utf8"));
  const qbRows = parseCSV(readFileSync(qbPath, "utf8"));

  // Build a lookup from the QuickBooks rows: key = "YYYY-MM-DD|amount"
  // Multiple rows can share the same date+amount (e.g. two IKEA charges same day).
  // We use a queue so each QB row is consumed at most once.
  const qbByKey = new Map();
  for (const row of qbRows) {
    if (!row["Date (UTC)"] || !row["Amount"]) continue;
    const date = parseMDYDash(row["Date (UTC)"]);
    const key = `${date}|${parseFloat(row["Amount"])}`;
    if (!qbByKey.has(key)) qbByKey.set(key, []);
    qbByKey.get(key).push(row);
  }

  const newTxns = [];
  let dupes = 0, unmatched = 0;

  for (const ns of nsRows) {
    if (!ns["Transaction Id"] || !ns["Date (MM/DD/YYYY)"]) continue;

    const id = ns["Transaction Id"];
    if (existingIds.has(id) || seenIds.has(id)) { dupes++; continue; }

    const date   = parseMDY(ns["Date (MM/DD/YYYY)"]);
    const amount = parseFloat(ns["Amount"] ?? "0");
    const key    = `${date}|${amount}`;

    // Consume the first matching QB row
    const qbQueue = qbByKey.get(key) ?? [];
    const qb      = qbQueue.shift() ?? null;
    if (!qb) unmatched++;

    const kind   = deriveKind(ns["Transaction Type"], qb?.["Last Four Digits"]);
    const status = deriveStatus(ns["Transaction Type"]);
    const note   = qb?.["Note"] || ns["Memo"] || null;
    const postedAt = parseTimestamp(qb?.["Timestamp"]) ?? `${date}T00:00:00.000Z`;

    seenIds.add(id);
    newTxns.push({
      id,
      source: "mercury-csv",
      mercury: {
        amount,
        kind,
        status,
        postedAt,
        createdAt: postedAt,
        description:     qb?.["Description"]      || ns["Payer/Payee Name"] || "",
        counterpartyName: ns["Payer/Payee Name"]   || "",
        bankDescription: qb?.["Bank Description"]  || "",
        note,
        reference:       qb?.["Reference"]         || ns["Memo"] || null,
        sourceAccount:   qb?.["Source Account"]    || "",
        lastFourDigits:  qb?.["Last Four Digits"]  || null,
        nameOnCard:      qb?.["Name On Card"]      || null,
        mercuryCategory: qb?.["Mercury Category"]  || null,
        originalCurrency: qb?.["Original Currency"] || "USD",
        checkNumber:     qb?.["Check Number"]      || null,
        tags:            qb?.["Tags"]              || null,
      },
      receipt:     null,
      bookkeeping: null,
    });
  }

  return { newTxns, dupes, unmatched };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const pairs = findPairs();
if (pairs.length === 0) {
  console.log("No CSV pairs found in entity root. Nothing to import.");
  process.exit(0);
}

console.log(`Found ${pairs.length} CSV pair(s) to process:\n`);

// Load existing transactions
const existing = existsSync(paths.transactions)
  ? loadJSON(paths.transactions)
  : [];
const existingIds = new Set(existing.map((t) => t.id));
const seenIds     = new Set(existing.map((t) => t.id));

const allNew = [];
const processedPairs = [];

for (const { ns, qb } of pairs) {
  const nsName = basename(ns);
  const qbName = basename(qb);
  console.log(`Processing: ${nsName}`);
  console.log(`       and: ${qbName}`);

  const { newTxns, dupes, unmatched } = processPair(ns, qb, existingIds, seenIds);
  console.log(`  ${newTxns.length} new  |  ${dupes} already imported  |  ${unmatched} QB row(s) unmatched`);

  if (newTxns.length > 0) {
    for (const t of newTxns) {
      const flag = t.mercury.kind === "debitCardTransaction" ? "  [card]" : "";
      console.log(
        `  ${t.mercury.postedAt.slice(0, 10)}  ${String(t.mercury.amount).padStart(10)}  ${t.mercury.description.slice(0, 35).padEnd(35)}${flag}`
      );
    }
  }
  console.log();

  allNew.push(...newTxns);
  processedPairs.push({ ns, qb });
}

console.log(`─────────────────────────────────────────────`);
console.log(`Total new transactions: ${allNew.length}`);

if (allNew.length === 0 && !dryRun) {
  console.log("Nothing new to import.");
  if (!noArchive && processedPairs.length > 0) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    for (const { ns, qb } of processedPairs) {
      renameSync(ns, join(ARCHIVE_DIR, basename(ns)));
      renameSync(qb, join(ARCHIVE_DIR, basename(qb)));
      console.log(`Archived ${basename(ns)}`);
      console.log(`Archived ${basename(qb)}`);
    }
  }
  process.exit(0);
}

if (dryRun) {
  console.log("\n--dry-run: no changes written.");
  process.exit(0);
}

// Sort merged set by postedAt descending (same as mercury importer)
const merged = [...existing, ...allNew].sort((a, b) => {
  const da = a.mercury?.postedAt || a.mercury?.createdAt || "";
  const db = b.mercury?.postedAt || b.mercury?.createdAt || "";
  return db.localeCompare(da);
});

saveTransactions(merged);
console.log(`\nWrote ${allNew.length} new transactions → ${paths.transactions}`);

// Archive CSVs
if (!noArchive) {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const { ns, qb } of processedPairs) {
    renameSync(ns, join(ARCHIVE_DIR, basename(ns)));
    renameSync(qb, join(ARCHIVE_DIR, basename(qb)));
    console.log(`Archived → csv-archive/mercury/${basename(ns)}`);
    console.log(`Archived → csv-archive/mercury/${basename(qb)}`);
  }
}

console.log("\nNext: node pipeline/5-categorize-transactions.js");
