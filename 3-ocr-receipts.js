import { readFileSync } from "fs";
import { extname } from "path";
import { callFlash, paths, loadJSON, saveTransactions, entity } from "./config.js";

const CONCURRENCY = 12;

function mimeFromPath(filePath) {
  const ext = extname(filePath).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  };
  return map[ext] || "application/octet-stream";
}


function buildOCRPrompt(transaction) {
  const mercury = transaction.mercury || {};
  const amount = parseFloat(mercury.amount || 0);
  const date = mercury.postedAt ? mercury.postedAt.split("T")[0] : "Unknown";
  const merchant = mercury.counterpartyName || mercury.note || "Unknown";

  return `You are a bookkeeping assistant analyzing a receipt image for ${entity.name} (${entity.entityType}).

Transaction context:
- Date: ${date}
- Amount: $${Math.abs(amount).toFixed(2)} ${amount > 0 ? "(INCOMING)" : "(OUTGOING)"}
- Merchant: ${merchant}

Extract all visible information from this receipt:
1. Merchant name (as printed on receipt)
2. All line items with quantities and prices
3. Subtotal, tax, and total
4. Any other relevant text (addresses, phone numbers, order numbers)

Pay special attention to whether items are:
- Capital improvements (adds value, prolongs life, adapts to new use — must depreciate over 39 years)
- Repairs & maintenance (keeps property in condition, fixes deterioration — immediately deductible)

Respond in this JSON format:
{
  "merchant": "merchant name from receipt",
  "items": [
    {"name": "item description", "quantity": 1, "unitPrice": 0.00, "lineTotal": 0.00}
  ],
  "subtotal": 0.00,
  "tax": 0.00,
  "total": 0.00,
  "receiptDate": "YYYY-MM-DD or null if not visible",
  "rawText": "any other notable text from the receipt",
  "summary": "One sentence summary of what was purchased",
  "isCapitalImprovement": false,
  "capitalImprovementReasoning": "Only if isCapitalImprovement is true, explain why"
}`;
}

async function ocrOneReceipt(transaction) {
  const receipt = transaction.receipt;
  const filePath = receipt.localPath;
  const prompt = buildOCRPrompt(transaction);
  const imageBase64 = readFileSync(filePath).toString("base64");
  const mimeType = mimeFromPath(filePath);

  return callFlash(prompt, { imageBase64, imageMimeType: mimeType });
}

async function main() {
  const transactions = loadJSON(paths.transactions);

  const needsOcr = (t) => t.receipt != null && (!t.ocr || t.ocr.error);
  const toProcess = transactions.filter(needsOcr);
  const alreadyDone = transactions.filter((t) => t.ocr && !t.ocr.error).length;

  console.log(
    `OCR: ${toProcess.length} receipts to process (${alreadyDone} already done)`
  );

  // Index all transactions by id for in-memory updates
  const txnMap = new Map(transactions.map((t) => [t.id, t]));

  let done = 0;
  let errors = 0;

  // Semaphore-style pool: keep up to CONCURRENCY requests in-flight at all
  // times. Each completion immediately saves and starts the next item, so
  // no slot ever sits idle waiting for the rest of a batch to finish.
  const queue = [...toProcess];

  async function processOne(txn) {
    const mercury = txn.mercury || {};
    const desc = mercury.counterpartyName || mercury.note || txn.id;

    try {
      const result = await ocrOneReceipt(txn);
      txnMap.get(txn.id).ocr = result;
      done++;
      console.log(`  [${done + errors}/${toProcess.length}] ${desc}: ${result.summary || "OK"}`);
    } catch (err) {
      errors++;
      console.warn(`  [${done + errors}/${toProcess.length}] ${desc}: ERROR — ${err.message}`);
      txnMap.get(txn.id).ocr = { error: err.message };
    }

    // Atomic save on every completion — safe because saveTransactions writes
    // to a .tmp file then renames, so readers never see a partial write.
    saveTransactions([...txnMap.values()]);
  }

  async function worker() {
    while (queue.length > 0) {
      const txn = queue.shift();
      await processOne(txn);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nDone: ${done} succeeded, ${errors} errors`);
  console.log(`Wrote ${paths.transactions}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
