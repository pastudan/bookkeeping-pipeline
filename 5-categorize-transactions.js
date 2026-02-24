import { existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { callFlash, paths, loadJSON, saveTransactions, entity, ENTITY_ROOT } from "./config.js";

// ── Load entity-specific rules ────────────────────────────────────────────────
//
// Rules live in {ENTITY_ROOT}/rules.js (private entity repo), NOT here.
// This keeps counterparty names / PII out of the public pipeline repo.
//
// Each rule shape:
//   match    — regex tested against the transaction description
//   positive — bookkeeping object when amount > 0 (money IN)
//   negative — bookkeeping object when amount < 0 (money OUT)
//   always   — bookkeeping object regardless of direction
//
// First match wins.  Unmatched transactions fall through to the LLM.

const rulesPath = join(ENTITY_ROOT, "rules.js");
let RULES = [];
if (existsSync(rulesPath)) {
  const mod = await import(pathToFileURL(rulesPath).href);
  RULES = mod.rules ?? mod.default ?? [];
  console.log(`Loaded ${RULES.length} rules from ${rulesPath}`);
} else {
  console.warn("No rules.js found in entity root — all transactions will go to LLM.");
  console.warn(`Expected: ${rulesPath}`);
}

// ── Apply rules ───────────────────────────────────────────────────────────────

function descriptionFor(txn) {
  return txn.mercury?.description
    || txn.mercury?.bankDescription
    || txn.wellsFargo?.description
    || "";
}

function applyRules(txn) {
  const desc   = descriptionFor(txn);
  const amount = txn.mercury?.amount ?? txn.wellsFargo?.amount ?? 0;

  for (const rule of RULES) {
    if (!rule.match.test(desc)) continue;

    if (rule.always)                  return rule.always;
    if (amount > 0 && rule.positive)  return rule.positive;
    if (amount < 0 && rule.negative)  return rule.negative;
    // Rule matched description but no handler for this direction — keep looking
  }
  return null;
}

// ── Short ID helpers (for LLM fallback) ──────────────────────────────────────

function shortId(fullId) {
  return fullId.split("-")[0];
}

function buildIdMap(transactions) {
  const map = new Map();
  for (const t of transactions) {
    const sid = shortId(t.id);
    if (map.has(sid) && map.get(sid) !== t.id) {
      const longer = t.id.replace(/-/g, "").slice(0, 12);
      console.warn(`Short ID collision for ${sid}, using ${longer}`);
      map.set(longer, t.id);
    } else {
      map.set(sid, t.id);
    }
  }
  return map;
}

// ── LLM fallback ─────────────────────────────────────────────────────────────

function buildLLMPrompt(remaining, idMap, chart) {
  const chartText = chart.accounts
    .map((a) => `  ${a.account} — ${a.description}`)
    .join("\n");

  const txnList = remaining.map((t) => {
    const amount = t.mercury?.amount ?? t.wellsFargo?.amount ?? 0;
    const date   = (t.mercury?.postedAt || t.wellsFargo?.postedAt || "").slice(0, 10);
    const desc   = descriptionFor(t).slice(0, 60);
    const note   = t.mercury?.note ? ` [note: "${t.mercury.note}"]` : "";
    const sid    = shortId(t.id);
    return `[${sid}] ${date} | ${desc}${note} | $${Math.abs(amount).toFixed(2)} ${amount > 0 ? "IN" : "OUT"}`;
  }).join("\n");

  return `You are an expert bookkeeper for ${entity.name} (${entity.entityType}). ${entity.description}.

TASK: Categorize each transaction below into one of the APPROVED ACCOUNTS.

APPROVED ACCOUNTS (use ONLY these):
${chartText}

TRANSACTIONS TO CATEGORIZE (${remaining.length} total):
${txnList}

Respond with a JSON array — one object per transaction:
[
  {
    "id": "8-char short id from the list above",
    "account": "Account:Name:Here",
    "reasoning": "Brief explanation",
    "confidence": "high|medium|low"
  }
]`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun  = !process.argv.includes("--send");
  const verbose = process.argv.includes("--verbose");

  const transactions = loadJSON(paths.transactions);
  const chart        = existsSync(paths.chartOfAccounts) ? loadJSON(paths.chartOfAccounts) : null;
  const txnMap       = new Map(transactions.map((t) => [t.id, t]));

  // Auto-categorize internal Mercury transfers
  let autoCount = 0;
  for (const t of transactions) {
    if (!t.bookkeeping && t.mercury?.kind === "internalTransfer") {
      t.bookkeeping = { account: "Assets:Bank:Mercury", reasoning: "Internal Mercury transfer — auto", override: true };
      autoCount++;
    }
  }

  // Apply rules to everything without bookkeeping
  let ruleCount = 0;
  const needsLLM = [];

  for (const t of transactions) {
    if (t.bookkeeping) continue;

    const result = applyRules(t);
    if (result) {
      t.bookkeeping = { ...result, override: result.confidence === "high" };
      ruleCount++;
    } else {
      needsLLM.push(t);
    }
  }

  console.log(`Transactions: ${transactions.length} total`);
  console.log(`  ${autoCount} auto-categorized (internal transfers)`);
  console.log(`  ${ruleCount} matched by rules`);
  console.log(`  ${needsLLM.length} need LLM review`);

  if (verbose) {
    console.log("\nRule-categorized summary:");
    const accts = {};
    for (const t of transactions) {
      if (t.bookkeeping && !needsLLM.includes(t)) {
        const a = t.bookkeeping.account;
        accts[a] = (accts[a] || 0) + 1;
      }
    }
    for (const [a, n] of Object.entries(accts).sort((x, y) => y[1] - x[1])) {
      console.log(`    ${n.toString().padStart(3)}  ${a}`);
    }
  }

  if (needsLLM.length > 0) {
    console.log("\nTransactions needing LLM:");
    for (const t of needsLLM) {
      const amount = t.mercury?.amount ?? t.wellsFargo?.amount ?? 0;
      const date   = (t.mercury?.postedAt || t.wellsFargo?.postedAt || "").slice(0, 10);
      const desc   = descriptionFor(t).slice(0, 50);
      console.log(`  ${date}  ${amount.toFixed(2).padStart(10)}  ${desc}`);
    }
  }

  if (dryRun) {
    if (autoCount > 0 || ruleCount > 0) {
      console.log("\n--dry-run: rules applied but NOT written. Pass --send to write.");
    }
    return;
  }

  // Save rule results immediately (LLM call may fail)
  if (autoCount > 0 || ruleCount > 0) {
    saveTransactions([...txnMap.values()]);
    console.log(`\nWrote ${autoCount + ruleCount} rule-categorized transactions.`);
  }

  // LLM pass for remainder
  if (needsLLM.length === 0) {
    console.log("All transactions categorized by rules — no LLM needed.");
    return;
  }

  if (!chart) {
    console.warn(`\n${needsLLM.length} transactions need LLM review but chart of accounts not found.`);
    console.warn("Run 4-generate-chart-of-accounts.js, then re-run with --send.");
    return;
  }

  const idMap  = buildIdMap(needsLLM);
  const prompt = buildLLMPrompt(needsLLM, idMap, chart);
  console.log(`\nSending ${needsLLM.length} transactions to Gemini Flash (~${Math.round(prompt.length / 4)} tokens) ...`);

  let results;
  try {
    results = await callFlash(prompt);
  } catch (err) {
    console.error(`LLM call failed: ${err.message}`);
    process.exit(1);
  }

  const resultArray = Array.isArray(results) ? results : results.transactions || [results];
  let matched = 0, unmatched = 0;

  for (const r of resultArray) {
    const fullId = idMap.get(r.id);
    if (!fullId) { console.warn(`  Unknown short ID: "${r.id}"`); unmatched++; continue; }
    const txn = txnMap.get(fullId);
    if (!txn) { unmatched++; continue; }
    txn.bookkeeping = { account: r.account, reasoning: r.reasoning, confidence: r.confidence };
    matched++;
  }

  console.log(`LLM: ${matched} matched, ${unmatched} unmatched`);

  const stillMissing = needsLLM.filter((t) => !txnMap.get(t.id)?.bookkeeping);
  if (stillMissing.length > 0) {
    console.warn(`${stillMissing.length} transactions still uncategorized — re-run to retry`);
  }

  saveTransactions([...txnMap.values()]);

  // Final summary
  const accts = {};
  for (const t of txnMap.values()) {
    if (t.bookkeeping?.account) accts[t.bookkeeping.account] = (accts[t.bookkeeping.account] || 0) + 1;
  }
  console.log(`\nFinal account breakdown:`);
  for (const [a, n] of Object.entries(accts).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${n.toString().padStart(3)}  ${a}`);
  }
  console.log(`\nWrote ${paths.transactions}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
