// collectors/data-collector-extended.js
import DataCollectorBase, { parseAllowedPairs } from './data-collector-base.js';
import fetch from 'node-fetch';

const HOURS_8_MS = 8 * 60 * 60 * 1000;

// ENV
const EXT_BASE_URL  = process.env.EXTENDED_BASE_URL || 'https://api.extended.exchange';
const EXT_TIMEOUT_MS = Number(process.env.EXTENDED_TIMEOUT_MS || 7000);
const EXT_RETRIES    = Number(process.env.EXTENDED_RETRIES || 2);
const EXT_RETRY_BASE = Number(process.env.EXTENDED_RETRY_BASE_MS || 500);
const EXT_MKT_CACHE_TTL_MS = Number(process.env.EXTENDED_MARKETS_CACHE_TTL_MS || 60_000); // 60s

const UA = process.env.USER_AGENT || 'ao-funding-collector/1.0 (+github:your-org)';

const toNum = (x, f = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : f;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { retries = EXT_RETRIES, baseMs = EXT_RETRY_BASE, factor = 2, label = 'op' } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (i === retries) break;
      const d = baseMs * Math.pow(factor, i);
      console.warn(`[retry] ${label} failed (${i + 1}/${retries + 1}): ${e?.message || e}. wait ${d}ms`);
      await sleep(d);
    }
  }
  throw last;
}

export default class ExtendedCollector extends DataCollectorBase {
  constructor(walletPath, options = {}) {
    super('extended', walletPath);
    this.allowedPairs = parseAllowedPairs(options.allowedPairs || this.pairs, 'ALLOWED_PAIRS');
    this._cache = { ts: 0, markets: null };
  }

  _baseFromName(name) {
    // ex "BTC-USD" -> "BTC"
    return String(name || '').toUpperCase().split('-')[0] || '';
  }

  async _fetchMarkets() {
    const now = Date.now();
    if (this._cache.markets && (now - this._cache.ts) < EXT_MKT_CACHE_TTL_MS) {
      return this._cache.markets;
    }
    const url = `${EXT_BASE_URL}/api/v1/info/markets`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), EXT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': UA },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
      }
      const json = await res.json();
      const data = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
      this._cache = { ts: now, markets: data };
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  async collectAndSend() {
    console.log('[Extended] Récupération des marchés…');
    const markets = await withRetry(() => this._fetchMarkets(), { label: 'extended markets' });

    let sent = 0;
    for (const m of markets) {
      const name = String(m?.name || '').toUpperCase();     // ex "BTC-USD"
      const pair = this._baseFromName(name);
      if (!pair || !this.allowedPairs.has(pair)) continue;

      // docs montrent marketStats: { fundingRate, nextFundingRate(?), openInterest, ... }
      const s = m?.marketStats || {};
      const rawRate = s?.fundingRate ?? m?.fundingRate;
      let funding_rate = toNum(rawRate, 0);

      // next funding time: doc exemple montre un entier (probablement secondes). On normalise en ms.
      let nf = s?.nextFundingRate ?? s?.nextFundingTime ?? m?.nextFundingTime;
      nf = toNum(nf, 0);
      if (nf > 0 && nf < 1e12) nf *= 1000;
      const next_funding = nf > 0 ? nf : (Date.now() + HOURS_8_MS);

      const oi = toNum(s?.openInterest ?? m?.openInterest, NaN);
      const liquidity = {
        long:  Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
        short: Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
      };

      const fees = { maker: 0.0002, taker: 0.0005 }; // pas d’endpoint public fees par marché dans cette doc

      try {
        console.log(`Checking ${pair} funding rate on Extended...`);
        await this.sendToAOS(pair, { funding_rate, next_funding, liquidity, fees });
        sent += 1;
      } catch (e) {
        console.error(`[Extended] Échec envoi ${pair}:`, e?.message || e);
      }
    }

    console.log(`[Extended] ${sent} mise(s) à jour envoyée(s).`);
  }

  // compat: version “par paire”
  async collectFundingData(pair) {
    const markets = await withRetry(() => this._fetchMarkets(), { label: 'extended markets' });
    const want = String(pair).toUpperCase();
    const m = markets.find(x => this._baseFromName(x?.name) === want);
    if (!m) throw new Error(`[Extended] Market introuvable pour ${want}`);

    const s = m?.marketStats || {};
    const rawRate = s?.fundingRate ?? m?.fundingRate;
    let funding_rate = toNum(rawRate, 0);

    let nf = s?.nextFundingRate ?? s?.nextFundingTime ?? m?.nextFundingTime;
    nf = toNum(nf, 0);
    if (nf > 0 && nf < 1e12) nf *= 1000;
    const next_funding = nf > 0 ? nf : (Date.now() + HOURS_8_MS);

    const oi = toNum(s?.openInterest ?? m?.openInterest, NaN);
    const liquidity = {
      long:  Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
      short: Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
    };
    const fees = { maker: 0.0002, taker: 0.0005 };

    return { funding_rate, next_funding, liquidity, fees };
  }
}
