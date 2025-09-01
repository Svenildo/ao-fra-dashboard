// collectors/data-collector-aevo.js
import DataCollectorBase, { parseAllowedPairs } from './data-collector-base.js';
import fetch from 'node-fetch';

const ONE_HOUR_MS = 60 * 60 * 1000;

// ENV
const AEVO_BASE_URL   = process.env.AEVO_BASE_URL || 'https://api.aevo.xyz';
const AEVO_TIMEOUT_MS = Number(process.env.AEVO_TIMEOUT_MS || 7000);
const AEVO_RETRIES    = Number(process.env.AEVO_RETRIES || 2);
const AEVO_RETRY_BASE = Number(process.env.AEVO_RETRY_BASE_MS || 500);
const AEVO_CACHE_TTL  = Number(process.env.AEVO_MARKETS_CACHE_TTL_MS || 60_000);
const AEVO_DEBUG      = /^(1|true)$/i.test(process.env.AEVO_DEBUG || '0');
const AEVO_MAX_CONC   = Number(process.env.AEVO_MAX_CONCURRENCY || 3); // appels /funding en parallèle

const toNum = (x, f = 0) => { const n = Number(x); return Number.isFinite(n) ? n : f; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { retries = AEVO_RETRIES, baseMs = AEVO_RETRY_BASE, factor = 2, label = 'op' } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e; if (i === retries) break;
      const d = baseMs * Math.pow(factor, i);
      console.warn(`[retry] ${label} failed (${i+1}/${retries+1}): ${e?.message || e}. wait ${d}ms`);
      await sleep(d);
    }
  }
  throw last;
}

function baseFromInstrumentName(s) {
  // "BTC-PERP", "ETH-PERP"
  const S = String(s || '').toUpperCase();
  if (!S) return '';
  if (S.includes('-')) return S.split('-')[0];
  if (S.includes('_')) return S.split('_')[0];
  return S.replace(/PERP.*$/,'').replace(/[^A-Z]/g,'').slice(0,4);
}

export default class AevoCollector extends DataCollectorBase {
  constructor(walletPath, options = {}) {
    super('aevo', walletPath);
    this.allowedPairs = parseAllowedPairs(options.allowedPairs || this.pairs, 'ALLOWED_PAIRS');
    this._cache = { ts: 0, markets: null };
  }

  async _fetchJson(url) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), AEVO_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally { clearTimeout(t); }
  }

  async _getMarkets() {
    const now = Date.now();
    if (this._cache.markets && (now - this._cache.ts) < AEVO_CACHE_TTL) return this._cache.markets;

    // /markets returns instruments; schema has `instrument_name`
    const url = `${AEVO_BASE_URL}/markets`;
    const json = await withRetry(() => this._fetchJson(url), { label: 'aevo markets' });

    let arr = [];
    if (Array.isArray(json)) arr = json;
    else if (Array.isArray(json?.markets)) arr = json.markets;
    else if (Array.isArray(json?.data)) arr = json.data;

    // normalize -> [{ instrument_name, ... }]
    const instruments = arr
      .map(x => ({
        instrument_name: String(x?.instrument_name || x?.instrument || x?.symbol || x?.name || '').toUpperCase(),
        type: String(x?.type || x?.product_type || '').toLowerCase()
      }))
      .filter(o => o.instrument_name);

    if (AEVO_DEBUG) {
      const sample = instruments.slice(0, 8).map(i => i.instrument_name);
      console.log('[Aevo][debug] instruments sample:', sample);
    }

    this._cache = { ts: now, markets: instruments };
    return instruments;
  }

  async _getFunding(instrument_name) {
    const url = `${AEVO_BASE_URL}/funding?instrument_name=${encodeURIComponent(instrument_name)}`;
    const json = await withRetry(() => this._fetchJson(url), { label: `aevo funding ${instrument_name}` });
    // Docs: /funding returns current funding for the instrument. (no example fields shown) 
    // Common fields seen: { instrument_name, funding_rate, timestamp }
    const rate = toNum(json?.funding_rate ?? json?.fundingRate ?? json?.data?.funding_rate ?? json?.data?.fundingRate, 0);
    // If a timestamp exists, it's usually in ns or ms; we only need next_funding = now + 1h (Aevo funds hourly).
    return { funding_rate: rate, next_funding: Date.now() + ONE_HOUR_MS };
  }

  async _runPool(tasks, maxConc = AEVO_MAX_CONC) {
    const results = [];
    let i = 0, active = 0;
    return await new Promise((resolve) => {
      const kick = () => {
        while (active < maxConc && i < tasks.length) {
          const idx = i++; active++;
          tasks[idx]().then(
            (r) => { results[idx] = r; },
            (e) => { results[idx] = { error: e }; }
          ).finally(() => { active--; if (i === tasks.length && active === 0) resolve(results); else kick(); });
        }
      };
      kick();
    });
  }

  async collectAndSend() {
    console.log('[Aevo] Récupération des marchés…');
    const instruments = await this._getMarkets();

    // garder seulement les PERP et celles autorisées
    const perps = instruments.filter(i => /PERP/i.test(i.instrument_name));
    const targets = perps
      .map(i => ({ instrument_name: i.instrument_name, pair: baseFromInstrumentName(i.instrument_name) }))
      .filter(x => x.pair && this.allowedPairs.has(x.pair));

    if (targets.length === 0) {
      if (AEVO_DEBUG) console.log('[Aevo][debug] aucune instrument_name matché avec allowedPairs:', Array.from(this.allowedPairs));
      console.log('[Aevo] 0 mise(s) à jour envoyée(s).');
      return;
    }

    // fetch funding en parallèle limité
    const tasks = targets.map(({ instrument_name, pair }) => async () => {
      try {
        const f = await this._getFunding(instrument_name);
        return { pair, ...f };
      } catch (e) {
        return { pair, error: e };
      }
    });
    const results = await this._runPool(tasks, AEVO_MAX_CONC);

    let sent = 0;
    for (const r of results) {
      if (r?.error) {
        console.error(`[Aevo] Funding err ${r.pair}:`, r.error?.message || r.error);
        continue;
      }
      const liquidity = { long: 1_000_000, short: 1_000_000 }; // pas d’OI public ici; fallback neutre
      const fees = { maker: 0.0005, taker: 0.0008 }; // spec ETH perp doc (indicatif) :contentReference[oaicite:1]{index=1}
      try {
        console.log(`Checking ${r.pair} funding rate on Aevo...`);
        await this.sendToAOS(r.pair, { funding_rate: r.funding_rate, next_funding: r.next_funding, liquidity, fees });
        sent += 1;
      } catch (e) {
        console.error(`[Aevo] Échec envoi ${r.pair}:`, e?.message || e);
      }
    }

    console.log(`[Aevo] ${sent} mise(s) à jour envoyée(s).`);
  }

  async collectFundingData(pair) {
    const instruments = await this._getMarkets();
    const want = String(pair).toUpperCase();
    const inst = instruments.find(i => baseFromInstrumentName(i.instrument_name) === want && /PERP/i.test(i.instrument_name));
    if (!inst) throw new Error(`[Aevo] Instrument introuvable pour ${want}`);
    const f = await this._getFunding(inst.instrument_name);
    return {
      funding_rate: f.funding_rate,
      next_funding: f.next_funding,
      liquidity: { long: 1_000_000, short: 1_000_000 },
      fees: { maker: 0.0005, taker: 0.0008 }
    };
  }
}
