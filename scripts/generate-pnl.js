#!/usr/bin/env node
/**
 * Generate a GAAP-style indented Profit & Loss HTML report.
 *
 * Requires Docker. Uses the yegle/fava image (already in docker-compose.yml)
 * which has beancount/bean-query pre-installed. No Python needed on the host.
 *
 * Usage:
 *   node scripts/generate-pnl.js               # current year
 *   node scripts/generate-pnl.js 2025           # year ending Dec 31 2025
 *   node scripts/generate-pnl.js --year 2025    # same, explicit flag
 *   node scripts/generate-pnl.js --ledger main.beancount --output custom.html
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

// Load optional accountant notes (pnl-notes.md in entity root)
const notesPath = resolve(ENTITY_ROOT, "pnl-notes.md");
const notesRaw  = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : null;

// Minimal markdown → HTML: ##/# headings, **bold**, bullet lists, blank-line paragraphs
function renderNotes(md) {
  const lines = md.split("\n");
  const out   = [];
  let inList  = false;
  for (const raw of lines) {
    const line = raw
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    if (/^## (.+)/.test(line)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h3>${line.replace(/^## /, "")}</h3>`);
    } else if (/^# (.+)/.test(line)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h2>${line.replace(/^# /, "")}</h2>`);
    } else if (/^- (.+)/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${line.replace(/^- /, "")}</li>`);
    } else if (line.trim() === "") {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push("");
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p>${line}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

// ── CLI args ─────────────────────────────────────────────────────────────────

function arg(flag, defaultVal) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1]
    ? process.argv[idx + 1]
    : defaultVal;
}

const positionalYear = process.argv.slice(2).find((a) => /^\d{4}$/.test(a));
const year = parseInt(arg("--year", positionalYear || String(new Date().getFullYear())), 10);

const ledgerPath = resolve(arg("--ledger", `${ENTITY_ROOT}/main.beancount`));
const outputPath = resolve(arg("--output", `${ENTITY_ROOT}/reports/pnl-gaap-${year}.html`));
const entityName = entity.name;
const periodLabel = arg("--period", `For the Year Ended December 31, ${year}`);

// ── Load transactions.json for Mercury URL / note / reasoning lookup ──────────

const txnsPath = resolve(ENTITY_ROOT, "data/transactions.json");
// Map<mercuryId, { dashboardLink, note, reasoning }>
const mercuryLookup = new Map();
if (existsSync(txnsPath)) {
  const txns = JSON.parse(readFileSync(txnsPath, "utf8"));
  for (const t of txns) {
    mercuryLookup.set(t.id, {
      dashboardLink: t.mercury?.dashboardLink || null,
      note: t.mercury?.note || null,
      reasoning: t.bookkeeping?.reasoning || null,
    });
  }
}

// ── Query beancount ───────────────────────────────────────────────────────────

if (!existsSync(ledgerPath)) {
  console.error(`Ledger file not found: ${ledgerPath}`);
  process.exit(1);
}

const containerLedger = `/bean/${relative(ENTITY_ROOT, ledgerPath).replace(/\\/g, "/")}`;

function runBeanquery(query) {
  try {
    return execSync(
      `docker run --rm --entrypoint python3 -v "${ENTITY_ROOT}:/bean" yegle/fava:latest -m beanquery -f csv "${containerLedger}" "${query}"`,
      { encoding: "utf8" },
    );
  } catch (err) {
    console.error("beanquery via Docker failed:", err.message);
    console.error("Make sure Docker is running.");
    process.exit(1);
  }
}

const totalsQuery = `SELECT account, sum(position) WHERE account ~ '^(Income|Expenses):' AND date >= ${year}-01-01 AND date <= ${year}-12-31 GROUP BY account ORDER BY account;`;
const txnsQuery   = `SELECT date, narration, account, position, tags WHERE account ~ '^(Income|Expenses):' AND date >= ${year}-01-01 AND date <= ${year}-12-31 ORDER BY account, date;`;

const csvTotals = runBeanquery(totalsQuery);
const csvTxns   = runBeanquery(txnsQuery);

// ── Parse CSV ─────────────────────────────────────────────────────────────────

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
  const m = (raw || "").match(/^(-?[\d,]+(?:\.\d+)?)/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : 0;
}

const totalsRows = parseCSV(csvTotals);
const txnsRows   = parseCSV(csvTxns);

// ── Build account tree ────────────────────────────────────────────────────────

function makeNode(name) { return { name, children: {}, amount: 0 }; }

function insertAccount(root, account, amount) {
  const parts = account.split(":").slice(1);
  let node = root;
  for (const part of parts) {
    if (!node.children[part]) node.children[part] = makeNode(part);
    node = node.children[part];
  }
  node.amount += amount;
}

function aggregate(node) {
  let subtotal = node.amount;
  for (const child of Object.values(node.children)) subtotal += aggregate(child);
  node.amount = subtotal;
  return subtotal;
}

const amountKey = totalsRows[0]
  ? Object.keys(totalsRows[0]).find((k) => k !== "account") || ""
  : "";

const incomeRoot  = makeNode("Income");
const expenseRoot = makeNode("Expenses");

for (const row of totalsRows) {
  const account = row.account || "";
  const amount  = parseAmount(row[amountKey] || "");
  if (account.startsWith("Income:"))   insertAccount(incomeRoot,  account, amount);
  else if (account.startsWith("Expenses:")) insertAccount(expenseRoot, account, amount);
}

aggregate(incomeRoot);
aggregate(expenseRoot);

// ── Build transaction map: account → [{date, narration, amount, mercuryId}] ──

const posKey = txnsRows[0]
  ? Object.keys(txnsRows[0]).find((k) => !["date","narration","account","tags"].includes(k)) || "position"
  : "position";

const txnMap = new Map();
for (const row of txnsRows) {
  const acct = row.account || "";
  const amt  = parseAmount(row[posKey] || "");
  // Parse mercury ID from tags field (e.g. "{'mercury-abc123-...'}")
  const tagMatch = (row.tags || "").match(/mercury-([a-f0-9-]+)/i);
  const mercuryId = tagMatch ? tagMatch[1] : null;
  if (!txnMap.has(acct)) txnMap.set(acct, []);
  txnMap.get(acct).push({ date: row.date || "", narration: row.narration || "", amount: amt, mercuryId });
}

function countTxns(node, prefix) {
  let count = txnMap.get(prefix)?.length || 0;
  for (const [key, child] of Object.entries(node.children))
    count += countTxns(child, `${prefix}:${key}`);
  return count;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function prettify(name) {
  return name.replace(/And/g, " & ").replace(/Tax/g, " Tax");
}

function fmtMoney(v) {
  return v < 0
    ? `($${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2 })})`
    : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

function renderTxnDetail(account) {
  const txns = txnMap.get(account);
  if (!txns || txns.length === 0) return "";

  const isIncome = account.startsWith("Income:");
  const rows = txns
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => {
      const amt = isIncome ? -t.amount : t.amount;
      const lookup = t.mercuryId ? mercuryLookup.get(t.mercuryId) : null;
      const url  = lookup?.dashboardLink || null;
      const note = lookup?.note || "";
      const reasoning = lookup?.reasoning || "";

      const descCell = url
        ? `<a class="txn-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(t.narration || "—")}</a>`
        : esc(t.narration || "—");

      const noteCell = note
        ? `<span class="trunc" title="${esc(note)}">${esc(note)}</span>`
        : `<span class="dim">—</span>`;

      const reasonCell = reasoning
        ? `<span class="trunc" title="${esc(reasoning)}">${esc(reasoning)}</span>`
        : `<span class="dim">—</span>`;

      return `<tr class="txn-row">
            <td class="txn-date">${esc(t.date)}</td>
            <td class="txn-narr">${descCell}</td>
            <td class="txn-meta">${noteCell}</td>
            <td class="txn-meta">${reasonCell}</td>
            <td class="txn-amt">${fmtMoney(amt)}</td>
          </tr>`;
    })
    .join("\n");

  return `<tr class="txn-detail" data-for="${esc(account)}" hidden>
      <td colspan="2" class="txn-detail-cell">
        <table class="txn-table">
          <thead><tr>
            <th class="txn-date">Date</th>
            <th class="txn-narr">Description</th>
            <th class="txn-meta">Note</th>
            <th class="txn-meta">Reasoning</th>
            <th class="txn-amt">Amount</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </td>
    </tr>`;
}

function renderRows(node, prefix, depth = 0) {
  const lines = [];
  for (const key of Object.keys(node.children).sort()) {
    const child = node.children[key];
    const fullAccount = `${prefix}:${key}`;
    const label = esc(prettify(child.name));
    const isGroup = Object.keys(child.children).length > 0;

    // All rows at the same depth share the same indentation: (depth+1)*16px.
    // Section-level rows (Income, Expenses, Total Income, Total Expenses) are
    // generated outside renderRows and sit at 0px. Everything inside is indented.
    const px = (depth + 1) * 16;

    const txnCount = countTxns(child, fullAccount);
    const countBadge = txnCount > 0
      ? `<span class="count">${txnCount}</span>`
      : "";

    if (isGroup) {
      lines.push(
        `<tr class="group" data-depth="${depth}"><td class="label" style="padding-left:${px}px">${label}${countBadge}</td><td class="amount"></td></tr>`,
      );
      lines.push(...renderRows(child, fullAccount, depth + 1));
      lines.push(
        `<tr class="subtotal" data-depth="${depth}"><td class="label subtotal-label" style="padding-left:${px}px">Total ${label}</td><td class="amount">${fmtMoney(child.amount)}</td></tr>`,
      );
    } else {
      const hasTxns = (txnMap.get(fullAccount)?.length || 0) > 0;
      const clickAttr = hasTxns ? ` clickable" data-account="${esc(fullAccount)}" data-depth="${depth}` : `" data-depth="${depth}`;
      lines.push(
        `<tr class="line${clickAttr}"><td class="label" style="padding-left:${px}px">${label}${countBadge}</td><td class="amount">${fmtMoney(child.amount)}</td></tr>`,
      );
      if (hasTxns) lines.push(renderTxnDetail(fullAccount));
    }
  }
  return lines;
}

// ── Build HTML ────────────────────────────────────────────────────────────────

const totalIncome   = Math.max(0, -incomeRoot.amount);
const totalExpenses = Math.max(0, expenseRoot.amount);
const netIncome     = totalIncome - totalExpenses;

const incomeRows  = renderRows(incomeRoot,  "Income");
const expenseRows = renderRows(expenseRoot, "Expenses");

const noIncome  = `<tr class="line"><td class="label muted">No income accounts with activity</td><td class="amount"></td></tr>`;
const noExpense = `<tr class="line"><td class="label muted">No expense accounts with activity</td><td class="amount"></td></tr>`;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Profit &amp; Loss Statement</title>
  <style>
    :root { --text:#1f2937; --muted:#6b7280; --line:#d1d5db; --header:#0f172a; --bg:#ffffff; --section:#f8fafc; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:"Avenir Next","Segoe UI",Helvetica,Arial,sans-serif; }
    .report { max-width:980px; margin:32px auto 48px; padding:0 24px; }
    .title { text-align:center; margin-bottom:4px; font-size:28px; font-weight:700; color:var(--header); }
    .subtitle { text-align:center; margin:0; color:var(--muted); }

    /* Controls */
    .controls { display:flex; justify-content:flex-end; margin-top:16px; }
    .controls button { font-size:12px; font-family:inherit; padding:5px 12px; border:1px solid var(--line); border-radius:5px; background:var(--section); color:var(--muted); cursor:pointer; }
    .controls button:hover { background:#e2e8f0; color:var(--text); }

    /* Main table */
    table { width:100%; border-collapse:collapse; margin-top:12px; font-size:14px; }
    th { text-align:left; font-size:12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.08em; padding:10px 8px; border-bottom:1px solid var(--line); }
    th:last-child, td.amount { text-align:right; width:180px; white-space:nowrap; }
    td { padding:7px 8px; vertical-align:middle; }
    .section-row td { background:var(--section); font-weight:700; color:var(--header); border-top:2px solid var(--line); border-bottom:1px solid var(--line); padding:10px 8px; }
    .group td.label { color:#334155; padding-top:10px; }
    .subtotal td { border-top:1px dotted var(--line); font-weight:600; }
    .total td { border-top:2px solid #94a3b8; border-bottom:2px solid #94a3b8; font-weight:700; padding:10px 8px; }
    .net td { border-top:3px double #334155; border-bottom:3px double #334155; font-weight:800; font-size:16px; padding:12px 8px; }
    .muted { color:var(--muted); font-style:italic; }
    .note { margin-top:18px; color:var(--muted); font-size:12px; }

    /* Transaction count badge — hidden until row hover */
    .count { display:inline-block; margin-left:6px; padding:1px 6px; font-size:10px; font-weight:600;
             background:#e2e8f0; color:var(--muted); border-radius:999px; vertical-align:middle;
             opacity:0; transition:opacity .15s; }
    tr:hover .count { opacity:1; }

    /* Clickable leaf rows — highlight full row on hover, pointer cursor */
    tr.clickable { cursor:pointer; }
    tr.clickable:hover td { background:#f1f5f9; }

    /* Transaction detail sub-table */
    .txn-detail-cell { padding:0 0 6px 28px !important; }
    .txn-table { width:100%; font-size:12px; margin:4px 0 6px; border-collapse:collapse; }
    .txn-table th { font-size:10px; padding:4px 6px; color:var(--muted); background:transparent;
                    border-bottom:1px solid #e2e8f0; text-transform:uppercase; letter-spacing:.06em; }
    .txn-table td { padding:3px 6px; border-bottom:1px solid #f8fafc; color:#374151; }
    .txn-table tr:last-child td { border-bottom:none; }
    td.txn-date, th.txn-date { white-space:nowrap; width:84px; }
    td.txn-narr, th.txn-narr { width:22%; }
    td.txn-meta, th.txn-meta { width:28%; }
    td.txn-amt,  th.txn-amt  { text-align:right; width:90px; white-space:nowrap; font-variant-numeric:tabular-nums; }
    /* Truncate long text with ellipsis; full text visible on hover via title */
    .trunc { display:block; max-width:100%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .dim { color:#d1d5db; }
    .txn-link { color:inherit; text-decoration:none; }
    .txn-link:hover { text-decoration:underline; color:#2563eb; }

    /* Collapsed state: hide detail lines and group headers; keep subtotals + section headers */
    table.collapsed tr.group { display:none; }
    table.collapsed tr.line:not([data-depth="0"]) { display:none; }
    table.collapsed tr.txn-detail { display:none; }

    /* Accountant notes */
    .accountant-notes { margin-top:40px; padding-top:24px; border-top:2px solid #e2e8f0; }
    .accountant-notes h2 { font-size:15px; font-weight:700; color:#0f172a; margin:0 0 16px; }
    .accountant-notes h3 { font-size:13px; font-weight:600; color:#334155; margin:20px 0 6px; text-transform:uppercase; letter-spacing:.05em; }
    .accountant-notes p  { font-size:13px; color:#475569; margin:4px 0 10px; line-height:1.6; }
    .accountant-notes ul { font-size:13px; color:#475569; margin:4px 0 10px; padding-left:20px; }
    .accountant-notes li { margin-bottom:4px; line-height:1.6; }
    .accountant-notes strong { color:#1e293b; }

    @media print {
      .no-print { display:none !important; }
      body { font-size:11px; }
      .report { margin:0; padding:0 10px; max-width:100%; }
      table { margin-top:8px; font-size:11px; }
      th { font-size:10px; padding:5px 6px; }
      td { padding:3px 6px; }
      .section-row td { padding:6px; }
      .total td, .net td { padding:5px 6px; }
      .net td { font-size:13px; }
      .title { font-size:20px; }
      .total, .net, .subtotal { page-break-inside:avoid; }
      /* txn-detail rows print only when expanded (hidden attr = display:none naturally) */
      .count { display:none !important; }
    }
  </style>
</head>
<body>
  <main class="report">
    <h1 class="title">${esc(entityName)}</h1>
    <p class="subtitle">Profit &amp; Loss Statement</p>
    <p class="subtitle">${esc(periodLabel)}</p>

    <div class="controls no-print">
      <button id="toggle-btn" onclick="toggleCollapse()">Collapse All</button>
    </div>

    <table id="pnl-table">
      <thead><tr><th>Account</th><th>Amount (USD)</th></tr></thead>
      <tbody>
        <tr class="section-row"><td>Revenue</td><td></td></tr>
        ${incomeRows.length ? incomeRows.join("\n        ") : noIncome}
        <tr class="total"><td>Total Revenue</td><td>${fmtMoney(totalIncome)}</td></tr>

        <tr class="section-row"><td>Operating Expenses</td><td></td></tr>
        ${expenseRows.length ? expenseRows.join("\n        ") : noExpense}
        <tr class="total"><td>Total Operating Expenses</td><td>${fmtMoney(totalExpenses)}</td></tr>

        <tr class="net"><td>Net Income</td><td>${fmtMoney(netIncome)}</td></tr>
      </tbody>
    </table>
    <p class="note">GAAP presentation: revenues less operating expenses = net income. Click any line item to expand individual transactions.</p>

    ${notesRaw ? `<div class="accountant-notes">
      ${renderNotes(notesRaw)}
    </div>` : ""}
  </main>

  <script>
    // 2-state toggle:
    //   "Collapse All" → collapses group rows, hides all txn details
    //   "Expand All"   → uncollapses group rows, opens all txn details
    let collapsed = false;
    function toggleCollapse() {
      collapsed = !collapsed;
      document.getElementById('pnl-table').classList.toggle('collapsed', collapsed);
      document.getElementById('toggle-btn').textContent = collapsed ? 'Expand All' : 'Collapse All';
      if (collapsed) {
        document.querySelectorAll('.txn-detail').forEach(r => { r.hidden = true; });
        document.querySelectorAll('tr.clickable').forEach(r => r.classList.remove('expanded'));
      } else {
        document.querySelectorAll('.txn-detail').forEach(r => { r.hidden = false; });
        document.querySelectorAll('tr.clickable').forEach(r => r.classList.add('expanded'));
      }
    }

    // Click to expand transaction detail
    document.querySelectorAll('tr.clickable').forEach(row => {
      row.addEventListener('click', () => {
        const acct = row.dataset.account;
        const detail = document.querySelector('.txn-detail[data-for="' + acct + '"]');
        if (!detail) return;
        const opening = detail.hidden;
        detail.hidden = !opening;
        row.classList.toggle('expanded', opening);
      });
    });
  </script>
</body>
</html>`;

writeFileSync(outputPath, html, "utf8");
console.log(`Generated: ${outputPath}`);
