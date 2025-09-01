// data-collector-base.js
import { connect, message, createDataItemSigner } from "@permaweb/aoconnect";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// --- Charger .env depuis le même dossier que ce fichier ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

// ---------------------- Utils partagés ----------------------
export function parseAllowedPairs(defaultPairs, envVar = "ALLOWED_PAIRS") {
  const fromEnv = process.env[envVar];
  if (!fromEnv) return new Set((defaultPairs || []).map((s) => String(s).toUpperCase()));
  return new Set(
    String(fromEnv)
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

function getPairs() {
  const raw = process.env.PAIRS?.trim();
  if (!raw) return ["BTC", "ETH", "SOL", "XRP", "BNB"];
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function getProcessIdMap(pairs) {
  const map = {};
  for (const p of pairs) {
    const raw = process.env[`ANALYSIS_${p}_PROCESS`];
    const id = typeof raw === "string" ? raw.trim() : "";
    map[p] = id;
    const looksOk = /^[A-Za-z0-9_-]{40,64}$/.test(id);
    if (!id) {
      console.warn(`[WARN] ANALYSIS_${p}_PROCESS manquant dans .env`);
    } else if (!looksOk) {
      console.warn(`[WARN] ANALYSIS_${p}_PROCESS format suspect (len=${id.length})`);
    }
  }
  return map;
}

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(
  fn,
  {
    retries = toNum(process.env.AOS_RETRIES, 2),
    baseMs = toNum(process.env.AOS_RETRY_BASE_MS, 800),
    factor = 2,
    label = "op",
  } = {}
) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === retries) break;
      const delay = baseMs * Math.pow(factor, i);
      console.warn(`[retry] ${label} failed (${i + 1}/${retries + 1}): ${e?.message || e}. wait ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ------------------- Skip si inchangé (config) -------------------
const SKIP_UNCHANGED = /^(1|true)$/i.test(process.env.SKIP_UNCHANGED || "0");
const FUNDING_ABS_EPS = Number(process.env.FUNDING_ABS_EPS || 0);
const FUNDING_REL_EPS = Number(process.env.FUNDING_REL_EPS || 0);
const NEXT_FUNDING_EPS_MS = Number(process.env.NEXT_FUNDING_EPS_MS || 0);
const MIN_SEND_INTERVAL_MS = Number(process.env.MIN_SEND_INTERVAL_MS || 0);

function almostEqualFunding(a, b) {
  const A = Number(a), B = Number(b);
  if (!Number.isFinite(A) || !Number.isFinite(B)) return false;
  const abs = Math.abs(A - B);
  const rel = Math.max(Math.abs(A), Math.abs(B)) * (Number.isFinite(FUNDING_REL_EPS) ? FUNDING_REL_EPS : 0);
  const eps = Math.max(Number.isFinite(FUNDING_ABS_EPS) ? FUNDING_ABS_EPS : 0, rel);
  return abs <= eps;
}

// ------------------- Persistance (optionnelle) -------------------
const PERSIST_LAST_STATE = /^(1|true)$/i.test(process.env.PERSIST_LAST_STATE || "0");
const LAST_STATE_PATH =
  process.env.LAST_STATE_PATH || path.join(__dirname, ".last-sent.json");

function loadLastState() {
  if (!PERSIST_LAST_STATE) return new Map();
  try {
    const raw = fs.readFileSync(LAST_STATE_PATH, "utf8");
    const obj = JSON.parse(raw);
    // obj: { "dex:PAIR": { ts, funding_rate, next_funding } }
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}
function saveLastState(map) {
  if (!PERSIST_LAST_STATE) return;
  try {
    const obj = Object.fromEntries(map.entries());
    fs.writeFileSync(LAST_STATE_PATH, JSON.stringify(obj), "utf8");
  } catch (e) {
    console.warn("[warn] unable to persist last state:", e?.message || e);
  }
}

// ------------------------- Classe base -------------------------
export default class DataCollectorBase {
  constructor(dexName, walletPath) {
    this.dexName = dexName;
    this.wallet = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    this.signer = createDataItemSigner(this.wallet);

    const connectOpts = {};
    if (process.env.MU_URL) connectOpts.MU_URL = process.env.MU_URL;
    if (process.env.CU_URL) connectOpts.CU_URL = process.env.CU_URL;
    if (process.env.GATEWAY_URL) connectOpts.GATEWAY_URL = process.env.GATEWAY_URL;
    this.ao = connect(connectOpts);

    this.pairs = getPairs();
    this.processIds = getProcessIdMap(this.pairs);

    this.dryRun = /^(1|true)$/i.test(process.env.DRY_RUN || "0");
    this.schema = process.env.SCHEMA?.trim() || "funding.v1";
    this.tagSeconds = /^(1|true)$/i.test(process.env.TAG_SECONDS || "0");
    this.sendSleepMs = Number(process.env.SEND_SLEEP_MS || 0);

    // Mémoire des derniers envois (pour skip) + éventuelle persistance
    this._lastSent = loadLastState();
  }

  async collectAndSend() {
    for (const pair of this.pairs) {
      try {
        console.log(`Checking ${pair} funding rate on ${this.dexName}...`);
        const fundingData = await this.collectFundingData(pair);

        // Normalize
        fundingData.funding_rate = toNum(fundingData.funding_rate, 0);
        fundingData.next_funding = toNum(fundingData.next_funding, Date.now());
        fundingData.liquidity = fundingData.liquidity || {};
        fundingData.fees = fundingData.fees || {};

        await this.sendToAOS(pair, fundingData);
      } catch (error) {
        console.error(`Error collecting ${pair} from ${this.dexName}:`, error?.message || error);
      }
    }
  }

  _shouldSkip(pair, data, nowMs) {
    if (!SKIP_UNCHANGED) return false;
    const key = `${this.dexName}:${pair}`;
    const last = this._lastSent.get(key);
    if (!last) return false;

    if (MIN_SEND_INTERVAL_MS > 0 && nowMs - last.ts < MIN_SEND_INTERVAL_MS) {
      return true;
    }

    const sameRate = almostEqualFunding(data.funding_rate, last.funding_rate);
    const nf = Number(data.next_funding);
    const sameNext =
      Number.isFinite(nf) && Math.abs(nf - last.next_funding) <= NEXT_FUNDING_EPS_MS;

    return sameRate && sameNext;
  }

  _remember(pair, data, nowMs) {
    const key = `${this.dexName}:${pair}`;
    this._lastSent.set(key, {
      ts: nowMs,
      funding_rate: Number(data.funding_rate),
      next_funding: Number(data.next_funding),
    });
  }

  async sendToAOS(pair, data) {
    const processId = this.processIds[pair];
    if (!processId) {
      console.error(`No process ID for ${pair}`);
      return;
    }

    const nowMs = Date.now();
    if (this._shouldSkip(pair, data, nowMs)) {
      console.log(`[skip] ${this.dexName}/${pair} inchangé (rate≈, next_funding≈).`);
      return;
    }

    const nowSec = Math.floor(nowMs / 1000);
    const tsTagValue = this.tagSeconds ? String(nowSec) : String(nowMs);
    const clientMsgId = `${this.dexName}:${pair}:${nowMs}`;

    // Debug payload
    console.log("Data to send:", {
      dex: this.dexName,
      pair,
      rate: data.funding_rate,
      timestamp_ms: nowMs,
    });

    try {
      const tags = [
        { name: "Action", value: "Funding-Update" },
        { name: "Source", value: this.dexName },
        { name: "Pair", value: pair },
        { name: "Rate", value: String(data.funding_rate) },
        { name: "NextFunding", value: String(data.next_funding) }, // ms (compat)
        { name: "Timestamp", value: tsTagValue },                  // ms par défaut, sec si TAG_SECONDS=1
        { name: "Schema", value: this.schema },
        { name: "Client-Message-Id", value: clientMsgId },
      ];

      const body = {
        dex: this.dexName,
        pair,
        funding_rate: data.funding_rate,
        next_funding: data.next_funding,                                 // ms
        next_funding_sec: Math.floor(toNum(data.next_funding, nowMs) / 1000),
        liquidity: data.liquidity,
        fees: data.fees,
        timestamp: nowMs,                                                // ms
        timestamp_sec: nowSec,                                           // sec
        schema: this.schema,
      };

      console.log("Message tags:", tags);

      if (this.dryRun) {
        console.log(`[dry-run] Would send to ${processId}`, { tags, body });
        this._remember(pair, data, nowMs);
        saveLastState(this._lastSent);
        return;
      }

      const messageId = await withRetry(
        () =>
          message({
            process: processId,
            signer: this.signer,
            tags,
            data: JSON.stringify(body),
          }),
        { label: `aos message ${pair}` }
      );

      this._remember(pair, data, nowMs);
      saveLastState(this._lastSent);

      console.log(
        `${pair} rate: ${(data.funding_rate * 100).toFixed(6)}% sent to AOS: ${String(
          messageId
        ).substring(0, 20)}...`
      );

      if (this.sendSleepMs > 0) await sleep(this.sendSleepMs);
      return messageId;
    } catch (error) {
      console.error(`FAILED to send ${pair} data from ${this.dexName}:`, error?.message || error);
      console.error(`Process ID used: ${processId}`);
      console.error("Error details:", error);
    }
  }

  async collectFundingData(_pair) {
    throw new Error("collectFundingData must be implemented");
  }
}
