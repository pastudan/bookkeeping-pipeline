#!/usr/bin/env node
/**
 * Generate a partner capital & distributions HTML report.
 *
 * Requires Docker. Uses the yegle/fava image (already in docker-compose.yml).
 *
 * Usage:
 *   node scripts/partner-report.js
 *   node scripts/partner-report.js --output custom.html
 */

import { execSync } from "child_process";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { resolve, dirname, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ is inside pipeline/ which is a submodule inside the entity root
const ENTITY_ROOT = resolve(__dirname, "../..");

// Load entity metadata
const entity = JSON.parse(readFileSync(resolve(ENTITY_ROOT, "entity.json"), "utf8"));

// ── CLI args ──────────────────────────────────────────────────────────────────

function arg(flag, defaultVal) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultVal;
}

const ledgerPath = resolve(arg("--ledger", `${ENTITY_ROOT}/main.beancount`));
const outputPath = resolve(arg("--output", `${ENTITY_ROOT}/reports/partner-report.html`));
const entityName = entity.name;

if (!existsSync(ledgerPath)) {
  console.error(`Ledger not found: ${ledgerPath}`);
  process.exit(1);
}

const containerLedger = `/bean/${relative(ENTITY_ROOT, ledgerPath).replace(/\\/g, "/")}`;

// ── Load Mercury notes lookup ─────────────────────────────────────────────────

const txnsJsonPath = resolve(ENTITY_ROOT, "data/transactions.json");
const mercuryNotes = new Map(); // mercury-<uuid> → note string

// { note, dashboardLink } keyed by "mercury-<uuid>"
const mercuryData = new Map();

if (existsSync(txnsJsonPath)) {
  const txns = JSON.parse(readFileSync(txnsJsonPath, "utf8"));
  for (const t of txns) {
    if (t.mercury?.dashboardLink || t.mercury?.note) {
      mercuryData.set(`mercury-${t.id}`, {
        note: t.mercury.note || null,
        url: t.mercury.dashboardLink || null,
      });
    }
  }
}

// ── Query helpers ─────────────────────────────────────────────────────────────

function beanquery(query) {
  try {
    return execSync(
      `docker run --rm --entrypoint python3 -v "${ENTITY_ROOT}:/bean" yegle/fava:latest -m beanquery -f csv "${containerLedger}" "${query}"`,
      { encoding: "utf8" },
    );
  } catch (err) {
    console.error("beanquery failed:", err.message);
    process.exit(1);
  }
}

function parseCSV(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const fields = [];
    let cur = "", inQuote = false;
    for (const ch of line) {
      if (ch === '"') inQuote = !inQuote;
      else if (ch === "," && !inQuote) { fields.push(cur); cur = ""; }
      else cur += ch;
    }
    fields.push(cur);
    return Object.fromEntries(headers.map((h, i) => [h, (fields[i] || "").trim()]));
  });
}

function parseAmount(raw) {
  const m = (raw || "").match(/(-?[\d,]+(?:\.\d+)?)/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : 0;
}

function fmtMoney(v) {
  const abs = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2 });
  return v < 0 ? `($${abs})` : `$${abs}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// camelCase → "Camel Case"
function prettyName(name) {
  return name.replace(/([A-Z])/g, " $1").trim();
}

// ── Run queries ───────────────────────────────────────────────────────────────

console.log("Querying account totals...");
const totalsCSV = beanquery(
  "SELECT account, sum(position) WHERE account ~ '^Equity:Partners:' GROUP BY account ORDER BY account"
);

console.log("Querying individual transactions...");
const txnsCSV = beanquery(
  "SELECT date, narration, account, position, tags WHERE account ~ '^Equity:Partners:' ORDER BY date, account"
);

const totalsRows = parseCSV(totalsCSV);
const txnsRows = parseCSV(txnsCSV);

// ── Process data ──────────────────────────────────────────────────────────────

// Build account total map: { "Equity:Partners:PartnerName:Capital": -amount, ... }
const amtKey = totalsRows[0]
  ? Object.keys(totalsRows[0]).find((k) => k !== "account") || ""
  : "";
const accountTotals = {};
for (const row of totalsRows) {
  accountTotals[row.account] = parseAmount(row[amtKey]);
}

// Extract unique partner names from account paths
const partners = [
  ...new Set(
    Object.keys(accountTotals)
      .filter((a) => a.startsWith("Equity:Partners:"))
      .map((a) => a.split(":")[2])
  ),
].sort();

// Position column name in transaction rows
const posKey = txnsRows[0]
  ? Object.keys(txnsRows[0]).find((k) => k !== "date" && k !== "narration" && k !== "account" && k !== "tags") || "position"
  : "position";

// Extract mercury data for a transaction row via its tags (e.g. "{'mercury-uuid'}")
function getMercuryData(row) {
  const tags = row.tags || "";
  const match = tags.match(/mercury-([a-f0-9-]+)/i);
  if (!match) return null;
  return mercuryData.get(`mercury-${match[1]}`) || null;
}

// Per-partner data
// Capital accounts are credit-normal → beancount stores them as negative → negate for display
// Distribution accounts are debit-normal → beancount stores them as positive (reduces equity)
const partnerData = {};
for (const partner of partners) {
  const capAcct = `Equity:Partners:${partner}:Capital`;
  const distAcct = `Equity:Partners:${partner}:Distributions`;
  partnerData[partner] = {
    capital: -(accountTotals[capAcct] || 0),
    distributions: accountTotals[distAcct] || 0,
    capitalTxns: txnsRows.filter((t) => t.account === capAcct),
    distTxns: txnsRows.filter((t) => t.account === distAcct),
  };
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

// negate=true for capital (stored as credits, need to flip sign for display)
function txnTable(txns, negate) {
  if (!txns.length) {
    return `<tr><td colspan="4" class="muted">No transactions recorded</td></tr>`;
  }
  return txns
    .slice()
    .reverse() // most recent first
    .map((t) => {
      const raw = parseAmount(t[posKey]);
      const amt = negate ? -raw : raw;
      const md = getMercuryData(t);
      const noteText = md?.note ? esc(md.note) : null;
      const display = noteText || `<span class="dash">—</span>`;
      const noteCell = md?.url
        ? `<a class="note-link" href="${esc(md.url)}" target="_blank" rel="noopener">${display}</a>`
        : `<span>${display}</span>`;
      return `<tr>
          <td>${esc(t.date)}</td>
          <td>${esc(t.narration || "—")}</td>
          <td class="note">${noteCell}</td>
          <td class="amt">${fmtMoney(amt)}</td>
        </tr>`;
    })
    .join("\n");
}

function partnerSection(partner) {
  const d = partnerData[partner];
  const name = prettyName(partner);
  const net = d.capital - d.distributions;
  const hasDistributions = d.distTxns.length > 0;

  return `<div class="partner-section">
  <div class="partner-header">
    <span class="pname">${esc(name)}</span>
    <span class="ptotal">${fmtMoney(d.capital)} contributed</span>
  </div>
  <div class="dbody">
    <h3>Capital Contributions</h3>
    <table>
      <thead><tr><th>Date</th><th>Description</th><th>Note</th><th class="amt">Amount</th></tr></thead>
      <tbody>${txnTable(d.capitalTxns, true)}</tbody>
      <tfoot>
        <tr class="foot"><td colspan="3">Total Contributions</td><td class="amt">${fmtMoney(d.capital)}</td></tr>
      </tfoot>
    </table>
    ${hasDistributions ? `
    <h3 style="margin-top:28px">Distributions</h3>
    <table>
      <thead><tr><th>Date</th><th>Description</th><th>Note</th><th class="amt">Amount</th></tr></thead>
      <tbody>${txnTable(d.distTxns, false)}</tbody>
      <tfoot>
        <tr class="foot"><td colspan="3">Total Distributions</td><td class="amt">${fmtMoney(d.distributions)}</td></tr>
        <tr class="net"><td colspan="3">Net Capital (Contributions − Distributions)</td><td class="amt">${fmtMoney(net)}</td></tr>
      </tfoot>
    </table>` : ""}
  </div>
</div>`;
}

// ── Summary table ─────────────────────────────────────────────────────────────

const [p1, p2] = partners;
const capitalDiff = p1 && p2
  ? Math.abs(partnerData[p1].capital - partnerData[p2].capital)
  : 0;
const isEqual = capitalDiff < 0.01;

const summaryRows = partners.map((p) => {
  const d = partnerData[p];
  return `<tr>
    <td>${esc(prettyName(p))}</td>
    <td class="amt">${fmtMoney(d.capital)}</td>
    <td class="amt">${d.distributions ? fmtMoney(d.distributions) : "—"}</td>
    <td class="amt">${fmtMoney(d.capital - d.distributions)}</td>
  </tr>`;
}).join("\n");

const statusBadge = isEqual
  ? `<span class="badge ok">✓ Equal</span>`
  : `<span class="badge warn">⚠ Difference: ${fmtMoney(capitalDiff)}</span>`;

// ── Build HTML ────────────────────────────────────────────────────────────────

const generatedDate = new Date().toLocaleDateString("en-US", {
  year: "numeric", month: "long", day: "numeric",
});

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Partner Capital Report — ${esc(entityName)}</title>
  <style>
    :root { --text:#1f2937; --muted:#6b7280; --line:#d1d5db; --header:#0f172a; --bg:#ffffff; --section:#f8fafc; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:"Avenir Next","Segoe UI",Helvetica,Arial,sans-serif; }
    .report { max-width:900px; margin:32px auto 56px; padding:0 24px; }
    .title { text-align:center; margin-bottom:4px; font-size:28px; font-weight:700; color:var(--header); }
    .subtitle { text-align:center; margin:0; color:var(--muted); }
    .datestamp { text-align:center; margin-top:4px; font-size:13px; color:#94a3b8; }

    /* Summary card */
    .card { background:var(--section); border:1px solid var(--line); border-radius:8px; padding:20px 24px; margin:24px 0 20px; }
    .card-title { display:flex; align-items:center; gap:8px; margin:0 0 16px; font-size:13px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.07em; }
    .badge { padding:3px 10px; border-radius:4px; font-size:12px; font-weight:600; }
    .badge.ok { background:#dcfce7; color:#166534; }
    .badge.warn { background:#fef9c3; color:#854d0e; }

    /* Tables */
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th { text-align:left; font-size:11px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.08em; padding:8px; border-bottom:1px solid var(--line); }
    td { padding:7px 8px; border-bottom:1px solid #f1f5f9; vertical-align:top; }
    td:first-child { white-space:nowrap; }
    tr:last-child td { border-bottom:none; }
    .amt { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    th.amt { text-align:right; }
    .foot td { border-top:2px solid var(--line); border-bottom:none; font-weight:700; }
    .net td { border-top:1px dotted var(--line); border-bottom:none; font-weight:700; color:#334155; }
    .muted { color:var(--muted); font-style:italic; }

    @media print {
      body { font-size:11px; }
      .report { margin:0; padding:0 12px; max-width:100%; }
      th { font-size:9px; padding:5px 6px; }
      td { padding:4px 6px; font-size:11px; }
      .card { padding:12px 16px; margin:12px 0 10px; }
      .partner-header { padding:10px 14px; }
      .dbody { padding:12px 14px 16px; }
      .note { font-size:11px; }
      .badge { font-size:10px; }
    }

    /* Partner sections */
    .partner-section { border:1px solid var(--line); border-radius:8px; margin-top:14px; }
    .partner-header { display:flex; justify-content:space-between; align-items:center; padding:15px 20px; background:var(--section); border-radius:8px 8px 0 0; border-bottom:1px solid var(--line); gap:12px; }
    .pname { flex:1; font-size:16px; font-weight:600; }
    .ptotal { font-size:14px; color:#64748b; }
    .dbody { padding:20px 20px 24px; }
    .dbody h3 { margin:0 0 12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); }

    .note { color:var(--muted); font-size:13px; font-style:italic; max-width:280px; }
    .note .dash { color:#cbd5e1; }
    .note-link { color:var(--muted); font-style:italic; text-decoration:none; }
    .note-link:hover { color:#2563eb; text-decoration:underline; }
    .footnote { margin-top:20px; color:var(--muted); font-size:12px; }
  </style>
</head>
<body>
  <main class="report">
    <h1 class="title">${esc(entityName)}</h1>
    <p class="subtitle">Partner Capital Report</p>
    <p class="datestamp">As of ${generatedDate}</p>

    <div class="card">
      <div class="card-title">Summary ${statusBadge}</div>
      <table>
        <thead>
          <tr>
            <th>Partner</th>
            <th class="amt">Contributions</th>
            <th class="amt">Distributions</th>
            <th class="amt">Net Capital</th>
          </tr>
        </thead>
        <tbody>${summaryRows}</tbody>
      </table>
    </div>

    ${partners.map((p) => partnerSection(p)).join("\n    ")}

    <p class="footnote">All amounts in USD. Capital contributions are recorded in each partner's Equity account. Distributions reduce net capital.</p>
  </main>
</body>
</html>`;

writeFileSync(outputPath, html, "utf8");
console.log(`Generated: ${outputPath}`);
