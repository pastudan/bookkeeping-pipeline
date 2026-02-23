import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// config.js lives at <entity-root>/pipeline/config.js
// Entity root is always the parent of the pipeline directory (submodule).
export const PIPELINE_DIR = __dirname;
export const ENTITY_ROOT  = resolve(PIPELINE_DIR, "..");

// Load .env from entity root (contains all keys: Mercury + Google)
dotenv.config({ path: join(ENTITY_ROOT, ".env") });

// Entity metadata (name, EIN, description, partners, etc.)
const entityJsonPath = join(ENTITY_ROOT, "entity.json");
export const entity = JSON.parse(readFileSync(entityJsonPath, "utf8"));

export const DATA_DIR        = join(ENTITY_ROOT, "data");
export const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// Mercury
export const MERCURY_API_BASE  = "https://api.mercury.com/api/v1";
export const MERCURY_API_TOKEN  = process.env.MERCURY_API_TOKEN;
export const MERCURY_ACCOUNT_ID = process.env.MERCURY_ACCOUNT_ID;

// Gemini
export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const FLASH_MODEL = "gemini-3-flash-preview";
const PRO_MODEL   = "gemini-3.1-pro-preview";

let _genai;
function getGenAI() {
  if (!_genai) {
    if (!GOOGLE_API_KEY) {
      throw new Error(
        "GOOGLE_API_KEY not set in .env — get one at https://aistudio.google.com/apikey"
      );
    }
    _genai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
  }
  return _genai;
}

export async function callFlash(prompt, { imageBase64, imageMimeType, jsonMode = true } = {}) {
  const ai = getGenAI();
  const contents = [];

  if (imageBase64) {
    contents.push({
      inlineData: { mimeType: imageMimeType, data: imageBase64 },
    });
  }
  contents.push({ text: prompt });

  const config = { temperature: 0.3 };
  if (jsonMode) {
    config.responseMimeType = "application/json";
  }

  const response = await ai.models.generateContent({
    model: FLASH_MODEL,
    contents,
    config,
  });

  const text = response.text;
  return jsonMode ? JSON.parse(text) : text;
}

export async function callPro(prompt, { jsonMode = true } = {}) {
  const ai = getGenAI();

  const config = { temperature: 0.3 };
  if (jsonMode) {
    config.responseMimeType = "application/json";
  }

  const response = await ai.models.generateContent({
    model: PRO_MODEL,
    contents: [{ text: prompt }],
    config,
  });

  const text = response.text;
  return jsonMode ? JSON.parse(text) : text;
}

// File paths — all resolved from entity root
export const paths = {
  transactions:    join(DATA_DIR, "transactions.json"),
  chartOfAccounts: join(DATA_DIR, "chart-of-accounts.json"),
  mainBeancount:   join(ENTITY_ROOT, "main.beancount"),
  reports:         join(ENTITY_ROOT, "reports"),
};

// Atomic write: write to .tmp then rename so concurrent readers never see a
// partial file.
export function saveTransactions(data) {
  const tmp = paths.transactions + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, paths.transactions);
}

export function loadJSON(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function loadText(path) {
  return readFileSync(path, "utf-8");
}

// Parse --year flag, default current year
export function parseYear() {
  const idx = process.argv.indexOf("--year");
  if (idx !== -1 && process.argv[idx + 1]) {
    return parseInt(process.argv[idx + 1], 10);
  }
  return new Date().getFullYear();
}
