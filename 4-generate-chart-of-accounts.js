import { writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";
import { callPro, paths, loadJSON, entity } from "./config.js";

function askUser(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function summarizeTransactions(transactions) {
  const merchants = {};
  let totalIn = 0;
  let totalOut = 0;

  for (const t of transactions) {
    const mercury = t.mercury || {};
    const desc = mercury.counterpartyName || mercury.note || "Unknown";
    const amount = parseFloat(mercury.amount || 0);
    if (!merchants[desc]) {
      merchants[desc] = { count: 0, totalAmount: 0, amounts: [] };
    }
    merchants[desc].count++;
    merchants[desc].totalAmount += Math.abs(amount);
    merchants[desc].amounts.push(amount);

    if (amount > 0) totalIn += amount;
    else totalOut += Math.abs(amount);
  }

  const sorted = Object.entries(merchants)
    .sort((a, b) => b[1].totalAmount - a[1].totalAmount)
    .map(([name, data]) => {
      const avg = data.totalAmount / data.count;
      const direction = data.amounts[0] > 0 ? "IN" : "OUT";
      return `- ${name}: ${data.count}x, total $${data.totalAmount.toFixed(2)}, avg $${avg.toFixed(2)} ${direction}`;
    })
    .join("\n");

  return { sorted, totalIn, totalOut, merchantCount: Object.keys(merchants).length };
}

function buildInitialPrompt(summary, categorizedData, existingChart) {
  let accountDistribution = "";
  if (categorizedData) {
    const accounts = {};
    for (const t of categorizedData) {
      const acct = t.bookkeeping?.account;
      if (acct) accounts[acct] = (accounts[acct] || 0) + 1;
    }
    accountDistribution = `\nPRELIMINARY CATEGORIZATION (account usage so far):\n${Object.entries(accounts)
      .sort((a, b) => b[1] - a[1])
      .map(([acct, count]) => `  ${acct}: ${count} transactions`)
      .join("\n")}`;
  }

  const chartSection = existingChart
    ? `CURRENT CHART OF ACCOUNTS (refine this — add, remove, or adjust as needed):
${existingChart.accounts.map((a) => `  ${a.account} — ${a.description}`).join("\n")}
${existingChart.notes ? `\nNotes from last run: ${existingChart.notes}` : ""}`
    : `CURRENT CHART OF ACCOUNTS: none yet — design from scratch.`;

  return `You are an expert accountant managing the chart of accounts for ${entity.name}.

BUSINESS CONTEXT:
- Entity: ${entity.name} (${entity.entityType})
- Description: ${entity.description}
- EIN: ${entity.ein}, formed ${entity.formationDate} (first year of books)
- Cash basis accounting, files Form 1065 (partnership)

${chartSection}

TRANSACTION SUMMARY (${summary.merchantCount} unique merchants):
Total incoming: $${summary.totalIn.toFixed(2)}
Total outgoing: $${summary.totalOut.toFixed(2)}

Merchants by volume:
${summary.sorted}
${accountDistribution}

TASK: Review and update the chart of accounts for this LLC. Consider:

1. Are all current accounts still needed? Remove any that have no transactions.
2. Should any accounts have sub-account drill-downs? Only add sub-accounts where there are 3+ transactions of a distinct type.
3. Are there any NEW accounts needed based on the transaction data?
4. The critical repair vs. capital improvement distinction — any accounts needed for that?
5. Keep it practical — don't over-engineer for a small LLC.

Respond with JSON:
{
  "accounts": [
    {
      "account": "Assets:Bank:Mercury",
      "description": "Mercury business checking account",
      "isNew": false,
      "reasoning": "Primary bank account"
    }
  ],
  "notes": "Summary of any changes made and why",
  "suggestedChanges": "Anything worth flagging for manual review"
}`;
}

function buildRefinementPrompt(currentChart, feedback) {
  return `You previously proposed this chart of accounts for ${entity.name}:

${JSON.stringify(currentChart, null, 2)}

The user provided this feedback:
"${feedback}"

Please revise the chart of accounts based on the feedback. Keep the same JSON format:
{
  "accounts": [...],
  "notes": "...",
  "suggestedChanges": "..."
}`;
}

function printChart(chart) {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              PROPOSED CHART OF ACCOUNTS                      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Group accounts by top-level category
  const groups = {};
  for (const acct of chart.accounts) {
    const top = acct.account.split(":")[0];
    if (!groups[top]) groups[top] = [];
    groups[top].push(acct);
  }

  for (const [group, accounts] of Object.entries(groups)) {
    console.log(`── ${group} ──`);
    for (const acct of accounts) {
      const marker = acct.isNew ? " [NEW]" : "";
      console.log(`  ${acct.account}${marker}`);
      console.log(`    ${acct.description}`);
    }
    console.log("");
  }

  if (chart.notes) {
    console.log(`Notes: ${chart.notes}\n`);
  }
  if (chart.suggestedChanges) {
    console.log(`Suggested changes: ${chart.suggestedChanges}\n`);
  }
}

async function main() {
  const dryRun = !process.argv.includes("--send");

  const existingChart = existsSync(paths.chartOfAccounts)
    ? loadJSON(paths.chartOfAccounts)
    : null;

  const transactions = loadJSON(paths.transactions);
  const categorizedData = transactions.some((t) => t.bookkeeping) ? transactions : null;

  const summary = summarizeTransactions(transactions);
  console.log(`Analyzing ${transactions.length} transactions across ${summary.merchantCount} merchants ...`);
  if (existingChart) {
    console.log(`Starting from existing chart (${existingChart.accounts.length} accounts)`);
  } else {
    console.log(`No existing chart found — will design from scratch`);
  }

  const prompt = buildInitialPrompt(summary, categorizedData, existingChart);

  if (dryRun) {
    console.log("\n" + "=".repeat(80));
    console.log("DRY RUN — prompt that would be sent to gemini-3.1-pro-preview:");
    console.log("=".repeat(80) + "\n");
    console.log(prompt);
    console.log("\n" + "=".repeat(80));
    console.log(`Prompt length: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);
    console.log('Run with --send to actually call the LLM and write chart-of-accounts.json');
    console.log("=".repeat(80));
    return;
  }

  // Initial chart generation
  console.log("Generating chart of accounts with gemini-3.1-pro-preview ...\n");
  let chart = await callPro(prompt);

  printChart(chart);

  // Interactive refinement loop (up to 2 rounds)
  for (let round = 1; round <= 2; round++) {
    const feedback = await askUser(
      `\nRound ${round}/2 — Enter feedback to refine, or press Enter to accept: `
    );

    if (!feedback) {
      console.log("Chart accepted.");
      break;
    }

    console.log(`\nRefining based on feedback ...`);
    chart = await callPro(buildRefinementPrompt(chart, feedback));
    printChart(chart);
  }

  writeFileSync(paths.chartOfAccounts, JSON.stringify(chart, null, 2));
  console.log(`\nWrote ${paths.chartOfAccounts}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
