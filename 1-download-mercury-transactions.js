import { existsSync } from "fs";
import {
  MERCURY_API_BASE,
  MERCURY_API_TOKEN,
  MERCURY_ACCOUNT_ID,
  paths,
  loadJSON,
  saveTransactions,
} from "./config.js";

if (!MERCURY_API_TOKEN || !MERCURY_ACCOUNT_ID) {
  console.error("MERCURY_API_TOKEN and MERCURY_ACCOUNT_ID must be set in .env");
  process.exit(1);
}

// Support multiple account IDs (comma-separated in MERCURY_ACCOUNT_ID)
const ACCOUNT_IDS = MERCURY_ACCOUNT_ID.split(",").map((s) => s.trim()).filter(Boolean);

const START_DATE = "2000-01-01";

function today() {
  return new Date().toISOString().split("T")[0];
}

async function fetchPage(accountId, limit, offset, start, end) {
  const url =
    `${MERCURY_API_BASE}/account/${accountId}/transactions` +
    `?limit=${limit}&offset=${offset}&start=${start}&end=${end}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${MERCURY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) throw new Error(`Mercury API ${res.status}: ${res.statusText}`);

  const data = await res.json();
  return { transactions: data.transactions || [], total: data.total ?? null };
}

async function fetchAll(accountId, start, end) {
  const limit = 500;
  let offset = 0;
  const all = [];

  while (true) {
    const { transactions, total } = await fetchPage(accountId, limit, offset, start, end);
    if (transactions.length === 0) break;

    all.push(...transactions);

    const pct = total != null ? ` (${all.length}/${total})` : "";
    console.log(`  fetched ${transactions.length}${pct}`);

    if (transactions.length < limit) break;
    offset += limit;
  }

  return all;
}

async function main() {
  const end = today();
  console.log(`Fetching all transactions from ${START_DATE} to ${end} ...`);
  console.log(`Accounts: ${ACCOUNT_IDS.join(", ")}`);

  const allFetched = [];
  for (const accountId of ACCOUNT_IDS) {
    console.log(`\nAccount ${accountId}:`);
    const fetched = await fetchAll(accountId, START_DATE, end);
    console.log(`  ${fetched.length} transactions`);
    allFetched.push(...fetched);
  }

  const fetched = allFetched;
  console.log(`\nFetched ${fetched.length} transactions total across ${ACCOUNT_IDS.length} account(s)`);

  // Load existing records to preserve receipt / ocr / bookkeeping namespaces.
  const existing = new Map();
  if (existsSync(paths.transactions)) {
    for (const record of loadJSON(paths.transactions)) {
      if (record.id) existing.set(record.id, record);
    }
    console.log(`Loaded ${existing.size} existing records`);
  }

  // Upsert: always overwrite the mercury namespace (picks up updated notes /
  // attachments), but keep any other namespaces intact.
  let newCount = 0;
  const merged = new Map(existing);
  for (const txn of fetched) {
    const { id, ...mercuryFields } = txn;
    const prior = merged.get(id);
    if (!prior) newCount++;
    merged.set(id, {
      id,
      mercury: mercuryFields,
      ...(prior?.receipt  !== undefined && { receipt:     prior.receipt }),
      ...(prior?.ocr      !== undefined && { ocr:         prior.ocr }),
      ...(prior?.bookkeeping !== undefined && { bookkeeping: prior.bookkeeping }),
    });
  }

  const sorted = [...merged.values()].sort((a, b) => {
    const da = a.mercury?.postedAt || a.mercury?.createdAt || "";
    const db = b.mercury?.postedAt || b.mercury?.createdAt || "";
    return db.localeCompare(da);
  });

  console.log(`Result: ${newCount} new, ${fetched.length - newCount} updated, ${sorted.length} total`);
  saveTransactions(sorted);
  console.log(`Wrote ${paths.transactions}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
