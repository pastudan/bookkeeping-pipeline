import { existsSync } from "fs";
import { callFlash, paths, loadJSON, saveTransactions, entity } from "./config.js";

// Merchants with this many or more transactions get a rule hint in the prompt.
const RULE_MIN_COUNT = 3;

// ── Short ID helpers ─────────────────────────────────────────────────────────

// Use the first UUID segment (8 hex chars) as the prompt ID.
// The LLM copies it from context rather than generating it.
function shortId(fullId) {
  return fullId.split("-")[0];
}

// Build shortId → fullId map, checking for collisions at runtime.
function buildIdMap(transactions) {
  const map = new Map();
  for (const t of transactions) {
    const sid = shortId(t.id);
    if (map.has(sid) && map.get(sid) !== t.id) {
      // Collision: fall back to first 12 chars (two segments without the hyphen)
      const longer = t.id.replace(/-/g, "").slice(0, 12);
      console.warn(`Short ID collision for ${sid}, using ${longer} instead`);
      map.set(longer, t.id);
    } else {
      map.set(sid, t.id);
    }
  }
  return map;
}

// ── Merchant rule detection ──────────────────────────────────────────────────

function detectMerchantGroups(transactions) {
  const groups = {};
  for (const t of transactions) {
    const name = t.mercury?.counterpartyName || t.mercury?.note || "Unknown";
    if (!groups[name]) groups[name] = [];
    groups[name].push(t);
  }
  return Object.entries(groups)
    .filter(([, txns]) => txns.length >= RULE_MIN_COUNT)
    .sort((a, b) => b[1].length - a[1].length);
}

function buildMerchantRulesSection(groups, chart) {
  if (groups.length === 0) return "";

  const accountNames = new Set(chart.accounts.map((a) => a.account));

  const lines = groups.map(([name, txns]) => {
    const amounts = [...new Set(txns.map((t) => parseFloat(t.mercury?.amount || 0).toFixed(2)))];
    const amountHint =
      amounts.length <= 3
        ? ` (amounts: ${amounts.join(", ")})`
        : ` (${txns.length} transactions, varied amounts)`;
    return `- ${name}: ${txns.length}x${amountHint}`;
  });

  return `RECURRING MERCHANTS (${groups.length} vendors with ${RULE_MIN_COUNT}+ transactions each):
${lines.join("\n")}

For these recurring vendors, apply consistent categorization. Only deviate if an individual amount looks anomalous.
`;
}

// ── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(remaining, idMap, merchantGroups, chart) {
  const chartAccountsText = chart.accounts
    .map((a) => `  ${a.account} — ${a.description}`)
    .join("\n");

  const merchantRulesSection = buildMerchantRulesSection(merchantGroups, chart);

  // Reverse map: shortId → txn (for the prompt line builder)
  const shortToTxn = new Map();
  for (const [sid, fullId] of idMap) {
    shortToTxn.set(sid, remaining.find((t) => t.id === fullId));
  }

  const txnList = remaining
    .map((t) => {
      const mercury = t.mercury || {};
      const amount = parseFloat(mercury.amount || 0);
      const date = mercury.postedAt ? mercury.postedAt.split("T")[0] : "Unknown";
      const desc = mercury.counterpartyName || "Unknown";
      const sid = shortId(t.id);

      // Mercury note (user-entered memo, often identifies owner/purpose)
      const mercuryNote = mercury.note ? ` [note: "${mercury.note}"]` : "";

      // OCR: summary only (items omitted to save tokens)
      const ocrNote = t.ocr?.summary ? ` | Receipt: ${t.ocr.summary}` : "";

      return `[${sid}] ${date} | ${desc}${mercuryNote} | $${Math.abs(amount).toFixed(2)} ${amount > 0 ? "IN" : "OUT"}${ocrNote}`;
    })
    .join("\n");

  return `You are an expert bookkeeper for ${entity.name} (${entity.entityType}). ${entity.description}. The entity was formed ${entity.formationDate}.

TASK: Categorize each transaction below into one of the APPROVED ACCOUNTS.

APPROVED ACCOUNTS (use ONLY these):
${chartAccountsText}

IMPORTANT RULES:
- Incoming money from partners → Equity:Partners:{Name}:Capital (use names from the approved accounts list)
- Do NOT invent accounts — use only the approved list above

${merchantRulesSection}TRANSACTIONS TO CATEGORIZE (${remaining.length} total):
${txnList}

Respond with a JSON array — one object per transaction, in any order:
[
  {
    "id": "8-char short id from the list above",
    "account": "Account:Name:Here",
    "reasoning": "Brief explanation (1 sentence for recurring vendors)",
    "confidence": "high|medium|low",
    "isCapitalImprovement": false
  }
]`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = !process.argv.includes("--send");

  if (!existsSync(paths.chartOfAccounts)) {
    console.error(`Chart of accounts not found at ${paths.chartOfAccounts}`);
    console.error("Run 4-generate-chart-of-accounts.js first.");
    process.exit(1);
  }

  const transactions = loadJSON(paths.transactions);
  const chart = loadJSON(paths.chartOfAccounts);

  const txnMap = new Map(transactions.map((t) => [t.id, t]));
  // Auto-categorize internal transfers (e.g. Mercury account-to-account sweeps)
  // so the LLM never sees them and they always cancel correctly in the ledger.
  let autoCount = 0;
  for (const t of transactions) {
    if (!t.bookkeeping && t.mercury?.kind === "internalTransfer") {
      t.bookkeeping = {
        account: "Assets:Bank:Mercury",
        reasoning: "Internal Mercury account transfer — auto-categorized",
        override: true,
      };
      autoCount++;
    }
  }
  if (autoCount > 0) {
    saveTransactions(transactions);
    console.log(`Auto-categorized ${autoCount} internal transfer(s) as Assets:Bank:Mercury`);
  }

  const openingDate = entity.openingDate || "1900-01-01";
  const remaining = transactions.filter((t) => {
    if (t.bookkeeping) return false;  // already categorized (includes auto above)
    // Skip transactions before the opening date (covered by QBO/prior system)
    const postedAt = t.mercury?.postedAt || "";
    if (postedAt && postedAt < openingDate) return false;
    return true;
  });
  const alreadyDone = transactions.length - remaining.length;

  console.log(`Transactions: ${remaining.length} to categorize, ${alreadyDone} already done`);
  console.log(`Chart of accounts: ${chart.accounts.length} accounts`);

  if (remaining.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const idMap = buildIdMap(remaining);
  const merchantGroups = detectMerchantGroups(remaining);
  const prompt = buildPrompt(remaining, idMap, merchantGroups, chart);

  const estTokens = Math.round(prompt.length / 4);

  if (dryRun) {
    console.log("\n" + "=".repeat(80));
    console.log("DRY RUN — prompt that would be sent to Gemini Flash:");
    console.log("=".repeat(80) + "\n");
    console.log(prompt);
    console.log("\n" + "=".repeat(80));
    console.log(`Prompt: ${prompt.length} chars (~${estTokens} tokens)`);
    console.log(`Recurring merchant groups detected (${merchantGroups.length}):`);
    for (const [name, txns] of merchantGroups) {
      console.log(`  ${txns.length}x ${name}`);
    }
    console.log('Run with --send to categorize and write transactions.json');
    console.log("=".repeat(80));
    return;
  }

  console.log(`\nSending prompt (~${estTokens} tokens) to Gemini Flash ...`);

  let results;
  try {
    results = await callFlash(prompt);
  } catch (err) {
    console.error(`LLM call failed: ${err.message}`);
    process.exit(1);
  }

  const resultArray = Array.isArray(results)
    ? results
    : results.transactions || results.results || [results];

  let matched = 0;
  let unmatched = 0;

  for (const result of resultArray) {
    const fullId = idMap.get(result.id);
    if (!fullId) {
      console.warn(`  Unknown short ID in response: "${result.id}" — skipping`);
      unmatched++;
      continue;
    }
    const txn = txnMap.get(fullId);
    if (!txn) {
      console.warn(`  Short ID ${result.id} resolved to unknown full ID — skipping`);
      unmatched++;
      continue;
    }
    txn.bookkeeping = {
      account: result.account,
      reasoning: result.reasoning,
      confidence: result.confidence,
      isCapitalImprovement: result.isCapitalImprovement || false,
    };
    matched++;
  }

  console.log(`\nCategorized: ${matched} matched, ${unmatched} unmatched short IDs`);

  const stillMissing = remaining.filter((t) => !txnMap.get(t.id).bookkeeping);
  if (stillMissing.length > 0) {
    console.warn(`${stillMissing.length} transactions not returned by LLM — re-run to retry`);
  }

  saveTransactions([...txnMap.values()]);

  // Summary
  const accounts = {};
  for (const txn of txnMap.values()) {
    if (txn.bookkeeping?.account) {
      accounts[txn.bookkeeping.account] = (accounts[txn.bookkeeping.account] || 0) + 1;
    }
  }
  const total = [...txnMap.values()].filter((t) => t.bookkeeping).length;
  console.log(`\nCategorization summary (${total} transactions):`);
  for (const [acct, count] of Object.entries(accounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${acct}: ${count}`);
  }
  console.log(`\nWrote ${paths.transactions}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
