// collectors/data-collector-dydx.js
import DataCollectorBase, { parseAllowedPairs } from './data-collector-base.js';
import fetch from 'node-fetch';

const HOURS_8_MS = 8 * 60 * 60 * 1000;

const DYDX_TIMEOUT_MS = Number(process.env.DYDX_TIMEOUT_MS || 7_000);
const DYDX_RETRIES = Number(process.env.DYDX_RETRIES || 2);
const DYDX_RETRY_BASE_MS = Number(process.env.DYDX_RETRY_BASE_MS || 500);
const DYDX_CACHE_TTL_MS = Number(process.env.DYDX_CACHE_TTL_MS || 600_000); // 10 min

function toNum(x, f = 0){ const n = Number(x); return Number.isFinite(n)?n:f; }

async function withRetry(fn, { retries = DYDX_RETRIES, baseMs = DYDX_RETRY_BASE_MS, factor = 2, label = "op" } = {}) {
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

export default class DydxCollector extends DataCollectorBase {
  constructor(walletPath, options = {}) {
    super('dydx', walletPath);
    this.allowedPairs = parseAllowedPairs(options.allowedPairs || this.pairs, 'ALLOWED_PAIRS');
    this.endpoint = process.env.DYDX_MARKETS_URL || 'https://indexer.dydx.trade/v4/perpetualMarkets';

    // cache mémoire simple
    this._marketsCache = { ts: 0, data: null };
  }

  async _fetchJson(url, { timeoutMs = DYDX_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`[dYdX] ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally { clearTimeout(t); }
  }

  async fetchAllMarkets() {
    const now = Date.now();
    if (this._marketsCache.data && (now - this._marketsCache.ts) < DYDX_CACHE_TTL_MS) {
      return this._marketsCache.data;
    }
    const json = await withRetry(() => this._fetchJson(this.endpoint, { timeoutMs: DYDX_TIMEOUT_MS }), { label: "dydx markets" });
    if (!json || typeof json !== 'object' || typeof json.markets !== 'object') {
      throw new Error('[dYdX] Unexpected markets response shape');
    }
    this._marketsCache = { ts: now, data: json.markets };
    return json.markets;
  }

  _resolveNextFundingMs(market) {
    const t = market?.nextFundingTime ?? market?.nextFunding?.time ?? market?.nextFundingAt ?? null;
    if (t == null) return Date.now() + HOURS_8_MS;
    if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
    if (typeof t === 'string') { const ms = Date.parse(t); return Number.isFinite(ms) ? ms : Date.now() + HOURS_8_MS; }
    return Date.now() + HOURS_8_MS;
  }

  _extractFundingRate(m) {
    const f = (m?.nextFundingRate !== undefined) ? Number(m.nextFundingRate)
            : (m?.fundingRate !== undefined) ? Number(m.fundingRate)
            : NaN;
    return Number.isFinite(f) ? f : 0;
  }

  _extractOpenInterest(m) {
    const oi = Number(m?.openInterest);
    return Number.isFinite(oi) ? oi : NaN;
  }

  async collectAndSend() {
    console.log('[dYdX] Récupération des marchés…');
    const markets = await this.fetchAllMarkets();

    let sent = 0;
    for (const [symbol, m] of Object.entries(markets)) {
      const pair = String(symbol).split('-')[0]?.toUpperCase();
      if (!pair || !this.allowedPairs.has(pair)) continue;

      const funding_rate = this._extractFundingRate(m);
      const next_funding = this._resolveNextFundingMs(m);
      const oi = this._extractOpenInterest(m);

      const liquidity = {
        long: Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
        short: Number.isFinite(oi) ? oi * 0.5 : 1_000_000
      };
      const fees = { maker: 0.0002, taker: 0.0005 };

      try {
        console.log(`Checking ${pair} funding rate on dYdX...`);
        await this.sendToAOS(pair, { funding_rate, next_funding, liquidity, fees });
        sent += 1;
      } catch (e) {
        console.error(`[dYdX] Échec envoi ${pair}:`, e?.message || e);
      }
    }
    console.log(`[dYdX] ${sent} mise(s) à jour envoyée(s).`);
  }

  async collectFundingData(pair) {
    const markets = await this.fetchAllMarkets();
    const key = Object.keys(markets).find(k => k.toUpperCase().startsWith(`${String(pair).toUpperCase()}-`));
    if (!key) throw new Error(`[dYdX] Market introuvable pour ${pair}`);

    const m = markets[key];
    const funding_rate = this._extractFundingRate(m);
    const next_funding = this._resolveNextFundingMs(m);
    const oi = this._extractOpenInterest(m);

    const liquidity = {
      long: Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
      short: Number.isFinite(oi) ? oi * 0.5 : 1_000_000
    };
    const fees = { maker: 0.0002, taker: 0.0005 };

    return { funding_rate, next_funding, liquidity, fees };
  }
}
