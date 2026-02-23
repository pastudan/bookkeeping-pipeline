import "dotenv/config";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  MERCURY_API_BASE,
  MERCURY_API_TOKEN,
  MERCURY_ACCOUNT_ID,
  paths,
  loadJSON,
  parseYear,
  ENTITY_ROOT,
} from "./config.js";

// IRS de minimis threshold — receipts required at or above this amount.
const RECEIPT_THRESHOLD = 75;

// ── Mercury cards ─────────────────────────────────────────────────────────────

async function fetchCards() {
  const res = await fetch(
    `${MERCURY_API_BASE}/account/${MERCURY_ACCOUNT_ID}/cards`,
    {
      headers: {
        Authorization: `Bearer ${MERCURY_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
  if (!res.ok) {
    console.warn(`  Warning: could not fetch cards (${res.status}). Card IDs will be used instead.`);
    return [];
  }
  const data = await res.json();
  return data.cards || [];
}

// cardId → { label: "Cardholder Name (·1234)", firstName: "FirstName" }
function buildCardMap(cards) {
  const map = new Map();
  for (const card of cards) {
    const name = card.nameOnCard || `Card ${card.lastFourDigits || card.cardId.slice(-4)}`;
    const last4 = card.lastFourDigits ? ` (·${card.lastFourDigits})` : "";
    map.set(card.cardId, {
      label: `${name}${last4}`,
      firstName: name.split(" ")[0],
    });
  }
  return map;
}

// ── Receipt / threshold checks ────────────────────────────────────────────────

function hasReceipt(txn) {
  if (txn.receipt) return true;
  if ((txn.mercury?.attachments || []).some((a) => a.attachmentType === "receipt")) return true;
  return false;
}

function isExpenseAboveThreshold(txn) {
  const m = txn.mercury;
  if (!m) return false;
  if (m.kind !== "debitCardTransaction") return false;
  if (m.amount >= 0) return false; // income or zero-dollar
  if (Math.abs(m.amount) < RECEIPT_THRESHOLD) return false;
  return true;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtDate(isoStr) {
  return isoStr ? isoStr.split("T")[0] : "—";
}

function fmtAmount(amount) {
  return `$${Math.abs(amount).toFixed(2)}`;
}

// ── Markdown builder ──────────────────────────────────────────────────────────

function buildMarkdown(byCard, cardMap, year, totalMissing) {
  const today = new Date().toISOString().split("T")[0];
  const lines = [];

  lines.push(`# Missing Receipts — ${year}`);
  lines.push(
    `*Generated ${today} · IRS threshold: $${RECEIPT_THRESHOLD} · ` +
    `Debit card transactions only*`
  );
  lines.push("");
  lines.push(
    `**${totalMissing} transaction${totalMissing !== 1 ? "s" : ""} ` +
    `require${totalMissing === 1 ? "s" : ""} receipts**`
  );
  lines.push("");

  // ── Summary ──
  lines.push("## Summary");
  lines.push("");

  // Sort by number of missing receipts descending, then alphabetically
  const sorted = [...byCard.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
  );

  for (const [cardId, txns] of sorted) {
    const { label } = cardMap.get(cardId) || { label: `Card ${cardId.slice(0, 8)}` };
    const total = txns.length;

    // Merchant breakdown for the summary line
    const merchantCounts = {};
    for (const txn of txns) {
      const m = txn.mercury?.counterpartyName || txn.mercury?.bankDescription || "Unknown";
      merchantCounts[m] = (merchantCounts[m] || 0) + 1;
    }
    const merchantSummary = Object.entries(merchantCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${n === total ? "" : `${n}× `}${name}`)
      .join(", ");

    lines.push(
      `- **${label}**: ${total} transaction${total !== 1 ? "s" : ""} — ${merchantSummary}`
    );
  }

  // Cardholders with zero missing receipts (cards known from Mercury but not in results)
  for (const [cardId, info] of cardMap.entries()) {
    if (!byCard.has(cardId)) {
      lines.push(`- **${info.label}**: 0 transactions ✓`);
    }
  }

  lines.push("");

  // ── Full list ──
  lines.push("## Full List");
  lines.push("");

  for (const [cardId, txns] of sorted) {
    const { label } = cardMap.get(cardId) || { label: `Card ${cardId.slice(0, 8)}` };

    lines.push(`### ${label}`);
    lines.push("");
    lines.push("| Date | Merchant | Amount | Note | Mercury |");
    lines.push("|------|----------|-------:|------|---------|");

    const sortedTxns = [...txns].sort((a, b) =>
      (b.mercury?.postedAt || "").localeCompare(a.mercury?.postedAt || "")
    );

    for (const txn of sortedTxns) {
      const m = txn.mercury;
      const date = fmtDate(m?.postedAt || m?.createdAt);
      const merchant = m?.counterpartyName || m?.bankDescription || "Unknown";
      const amount = fmtAmount(m?.amount || 0);
      const note = m?.note ? m.note : "—";
      const link = m?.dashboardLink ? `[↗](${m.dashboardLink})` : "—";
      lines.push(`| ${date} | ${merchant} | ${amount} | ${note} | ${link} |`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const year = parseYear();
  console.log(`Missing receipts report — ${year} (threshold: $${RECEIPT_THRESHOLD})`);

  // Fetch card → cardholder map from Mercury
  console.log("Fetching cards from Mercury ...");
  const cards = await fetchCards();
  const cardMap = buildCardMap(cards);
  console.log(`  ${cardMap.size} card(s) loaded`);
  for (const [id, { label }] of cardMap.entries()) {
    console.log(`    ${id} → ${label}`);
  }

  // Load and filter transactions
  const allTxns = loadJSON(paths.transactions);
  const yearTxns = allTxns.filter((t) => {
    const date = t.mercury?.postedAt || t.mercury?.createdAt || "";
    return date.startsWith(String(year));
  });
  console.log(`\n${yearTxns.length} transactions in ${year}`);

  const missing = yearTxns.filter(
    (t) => isExpenseAboveThreshold(t) && !hasReceipt(t)
  );
  console.log(`${missing.length} missing receipts (≥$${RECEIPT_THRESHOLD}, debit card only)`);

  // Group by card
  const byCard = new Map();
  for (const txn of missing) {
    const cardId = txn.mercury?.details?.debitCardInfo?.id || "unknown";
    if (!byCard.has(cardId)) byCard.set(cardId, []);
    byCard.get(cardId).push(txn);
  }

  // Console summary
  console.log("\nSummary:");
  for (const [cardId, txns] of [...byCard.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )) {
    const { label } = cardMap.get(cardId) || { label: `Card ${cardId.slice(0, 8)}` };
    console.log(`  ${label}: ${txns.length} transaction(s)`);
  }
  for (const [cardId, info] of cardMap.entries()) {
    if (!byCard.has(cardId)) {
      console.log(`  ${info.label}: 0 transactions ✓`);
    }
  }

  // Write markdown
  const markdown = buildMarkdown(byCard, cardMap, year, missing.length);
  const outPath = join(ENTITY_ROOT, `missing-receipts-${year}.md`);
  writeFileSync(outPath, markdown);
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
