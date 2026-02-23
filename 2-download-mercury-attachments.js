import { writeFileSync, existsSync } from "fs";
import { join, extname } from "path";
import {
  MERCURY_API_BASE,
  MERCURY_API_TOKEN,
  ATTACHMENTS_DIR,
  paths,
  loadJSON,
  saveTransactions,
  entity,
} from "./config.js";

if (!MERCURY_API_TOKEN) {
  console.error("MERCURY_API_TOKEN must be set in .env");
  process.exit(1);
}

async function fetchTransactionDetails(transactionId) {
  const res = await fetch(`${MERCURY_API_BASE}/transaction/${transactionId}`, {
    headers: {
      Authorization: `Bearer ${MERCURY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Mercury API ${res.status} for ${transactionId}`);
  return res.json();
}

function guessExtension(contentType, fileName) {
  if (fileName) {
    const ext = extname(fileName).toLowerCase();
    if (ext) return ext;
  }
  const map = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/tiff": ".tiff",
  };
  return map[contentType] || ".bin";
}

async function downloadAttachment(attachment, transactionId) {
  const res = await fetch(attachment.url);
  if (!res.ok) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const ext = guessExtension(contentType, attachment.fileName);
  const localPath = join(ATTACHMENTS_DIR, `${transactionId}${ext}`);

  writeFileSync(localPath, buffer);
  return { localPath, contentType, bytes: buffer.length };
}

function renderProgress(i, total, downloaded, skipped, noReceipt, label) {
  const pct = Math.round(((i + 1) / total) * 100);
  const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
  const cols = process.stdout.columns || 120;
  const line = `  [${bar}] ${pct}% (${i + 1}/${total}) ↓${downloaded} skip${skipped} ∅${noReceipt}  ${label}`;
  // Pad to terminal width so previous longer lines are fully overwritten
  process.stdout.write("\r" + line.slice(0, cols).padEnd(cols));
}

async function main() {
  const transactions = loadJSON(paths.transactions);
  const total = transactions.length;
  const openingDate = entity.openingDate || null;
  console.log(`Processing ${total} transactions for attachments ...`);
  if (openingDate) console.log(`  Skipping attachments for transactions before ${openingDate}`);

  const txnMap = new Map(transactions.map((t) => [t.id, t]));

  let downloaded = 0;
  let skipped = 0;
  let noReceipt = 0;
  let errors = 0;

  for (let i = 0; i < total; i++) {
    const txn = transactions[i];
    const id = txn.id;
    const mercury = txn.mercury || {};
    const desc = (mercury.counterpartyName || mercury.note || "Unknown").slice(0, 30);

    // Fast skip — no API call needed:
    //   before openingDate              → not part of our beancount books
    //   receipt === null                → previously checked, no receipt exists
    //   receipt != null + file on disk  → already downloaded
    // Only call Mercury when receipt key is absent (never checked) or the
    // file has been deleted from disk since we recorded it.
    const postedAt = mercury.postedAt || "";
    if (openingDate && postedAt && postedAt < openingDate) {
      // Mark as null so we never check again
      if (txn.receipt === undefined) txnMap.get(id).receipt = null;
      noReceipt++;
      renderProgress(i, total, downloaded, skipped, noReceipt, `∅     ${desc}`);
      continue;
    }
    if (txn.receipt === null) {
      noReceipt++;
      renderProgress(i, total, downloaded, skipped, noReceipt, `∅     ${desc}`);
      continue;
    }
    if (txn.receipt != null && existsSync(txn.receipt.localPath)) {
      skipped++;
      renderProgress(i, total, downloaded, skipped, noReceipt, `skip  ${desc}`);
      continue;
    }

    // Fetch full transaction details to get attachment URLs
    let full;
    try {
      full = await fetchTransactionDetails(id);
    } catch (err) {
      errors++;
      renderProgress(i, total, downloaded, skipped, noReceipt, `err   ${desc}`);
      continue;
    }

    const receipts = (full.attachments || []).filter(
      (a) => a.attachmentType === "receipt"
    );

    if (receipts.length === 0) {
      txnMap.get(id).receipt = null;
      noReceipt++;
      renderProgress(i, total, downloaded, skipped, noReceipt, `∅ new ${desc}`);
      continue;
    }

    const attachment = receipts[0];
    const result = await downloadAttachment(attachment, id);

    if (result) {
      txnMap.get(id).receipt = {
        localPath: result.localPath,
        contentType: result.contentType,
        bytes: result.bytes,
        fileName: attachment.fileName,
      };
      downloaded++;
      renderProgress(i, total, downloaded, skipped, noReceipt, `↓     ${desc}`);
    } else {
      txnMap.get(id).receipt = null;
      errors++;
      renderProgress(i, total, downloaded, skipped, noReceipt, `fail  ${desc}`);
    }

    // Save progress periodically to allow safe resume
    if ((downloaded + noReceipt) % 10 === 0) {
      saveTransactions([...txnMap.values()]);
    }
  }

  // Final save and summary on a fresh line
  saveTransactions([...txnMap.values()]);
  process.stdout.write("\n");

  const withReceipts = [...txnMap.values()].filter((t) => t.receipt != null).length;
  console.log(`Done: ${downloaded} new downloads, ${skipped} skipped (on disk), ${noReceipt} no receipt, ${errors} errors`);
  console.log(`Total receipts on disk: ${withReceipts}`);
  console.log(`Wrote ${paths.transactions}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
