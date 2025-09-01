// collectors/data-collector-hyperliquid.js
import DataCollectorBase, { parseAllowedPairs } from './data-collector-base.js';
import fetch from 'node-fetch';

const HOURS_8_MS = 8 * 60 * 60 * 1000;

// ENV knobs (tous optionnels)
const HL_API_URL = process.env.HL_API_URL || 'https://api.hyperliquid.xyz/info';
const HL_TIMEOUT_MS = Number(process.env.HL_TIMEOUT_MS || 7000);
const HL_RETRIES = Number(process.env.HL_RETRIES || 2);
const HL_RETRY_BASE_MS = Number(process.env.HL_RETRY_BASE_MS || 500);
// ⚠️ Par défaut 0 (désactivé) pour ne pas staler les ctxs temps réel.
// Si tu veux réduire la charge, mets p.ex. 30000 (30s) ou 60000 (1min).
const HL_CACHE_TTL_MS = Number(process.env.HL_CACHE_TTL_MS || 0);

function toNum(x, f = 0) { const n = Number(x); return Number.isFinite(n) ? n : f; }

async function withRetry(fn, { retries = HL_RETRIES, baseMs = HL_RETRY_BASE_MS, factor = 2, label = "op" } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i === retries) break;
      const delay = baseMs * Math.pow(factor, i);
      console.warn(`[retry] ${label} failed (${i + 1}/${retries + 1}): ${e?.message || e}. wait ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export default class HyperliquidCollector extends DataCollectorBase {
  constructor(walletPath, options = {}) {
    super('hyperliquid', walletPath);
    // Paires autorisées selon la logique HL (noms simples: BTC, ETH, …)
    this.allowedPairs = parseAllowedPairs(options.allowedPairs || this.pairs, 'ALLOWED_PAIRS');

    // petit cache mémoire de la réponse meta+ctxs (désactivé par défaut)
    this._cache = { ts: 0, names: null, ctxs: null };
  }

  async _postJson(url, body, { timeoutMs = HL_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`[Hyperliquid] ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async fetchMetaAndCtxs() {
    const now = Date.now();
    if (HL_CACHE_TTL_MS > 0 && this._cache.names && (now - this._cache.ts) < HL_CACHE_TTL_MS) {
      return { names: this._cache.names, ctxs: this._cache.ctxs };
    }

    const json = await withRetry(
      () => this._postJson(HL_API_URL, { type: 'metaAndAssetCtxs' }, { timeoutMs: HL_TIMEOUT_MS }),
      { label: "hyperliquid metaAndAssetCtxs" }
    );

    if (!Array.isArray(json) || json.length < 2) {
      throw new Error('[Hyperliquid] Unexpected response shape (expected [meta, assetCtxs])');
    }

    const meta = json[0];
    const ctxs = json[1];

    const names =
      Array.isArray(meta?.universe) ? meta.universe.map(x => x?.name)
      : Array.isArray(meta?.assets) ? meta.assets.map(x => x?.name)
      : [];

    if (!Array.isArray(names) || !Array.isArray(ctxs) || names.length !== ctxs.length) {
      throw new Error('[Hyperliquid] meta and ctxs length mismatch or names missing');
    }

    this._cache = { ts: now, names, ctxs };
    return { names, ctxs };
  }

  _extractFunding(ctx) {
    const f = Number(ctx?.funding);
    return Number.isFinite(f) ? f : 0;
  }
  _extractOpenInterest(ctx) {
    const oi = Number(ctx?.openInterest);
    return Number.isFinite(oi) ? oi : NaN;
  }

  /** Mode dynamique : découvre toutes les paires et n’envoie que celles autorisées/configurées. */
  async collectAndSend() {
    console.log('[Hyperliquid] Récupération des marchés…');
    const { names, ctxs } = await this.fetchMetaAndCtxs();

    let sent = 0;
    for (let i = 0; i < names.length; i++) {
      const symbol = String(names[i] || '').toUpperCase(); // ex: BTC, ETH, SOL…
      const pair = symbol; // même label côté AO
      if (!pair || !this.allowedPairs.has(pair)) continue;

      const ctx = ctxs[i] || {};
      const funding_rate = this._extractFunding(ctx);
      const oi = this._extractOpenInterest(ctx);

      const data = {
        funding_rate,
        next_funding: Date.now() + HOURS_8_MS, // HL publie un funding rolling; simple approx 8h (inchangé)
        liquidity: {
          long: Number.isFinite(oi) ? oi * 0.3 : 1_000_000,
          short: Number.isFinite(oi) ? oi * 0.7 : 1_000_000
        },
        fees: { maker: -0.00005, taker: 0.0003 }
      };

      try {
        console.log(`Checking ${pair} funding rate on Hyperliquid...`);
        await this.sendToAOS(pair, data);
        sent += 1;
      } catch (e) {
        console.error(`[Hyperliquid] Échec envoi ${pair}:`, e?.message || e);
      }
    }

    console.log(`[Hyperliquid] ${sent} mise(s) à jour envoyée(s).`);
  }

  /** Compat: version "par paire" si on l’appelle directement. */
  async collectFundingData(pair) {
    const wanted = String(pair).toUpperCase();
    const { names, ctxs } = await this.fetchMetaAndCtxs();
    const idx = names.findIndex(n => String(n || '').toUpperCase() === wanted);
    if (idx < 0) throw new Error(`[Hyperliquid] Asset introuvable pour ${wanted}`);

    const ctx = ctxs[idx] || {};
    const funding_rate = this._extractFunding(ctx);
    const oi = this._extractOpenInterest(ctx);

    return {
      funding_rate,
      next_funding: Date.now() + HOURS_8_MS,
      liquidity: {
        long: Number.isFinite(oi) ? oi * 0.3 : 1_000_000,
        short: Number.isFinite(oi) ? oi * 0.7 : 1_000_000
      },
      fees: { maker: -0.00005, taker: 0.0003 }
    };
  }
}
