// collectors/data-collector-orderly.js
import DataCollectorBase, { parseAllowedPairs } from './data-collector-base.js';
import fetch from 'node-fetch';

const HOURS_MS = h => h * 60 * 60 * 1000;

/* ----------- ENV ----------- */
const ORD_BASE_URL = process.env.ORDERLY_BASE_URL || 'https://api.orderly.org';
const ORD_FUNDING_URL = `${ORD_BASE_URL}/v1/public/funding_rates`;               // all markets
const ORD_OI_URL      = `${ORD_BASE_URL}/v1/public/market_info/traders_open_interests`;
const ORD_INFO_URL    = `${ORD_BASE_URL}/v1/public/info`;                        // symbols + funding_period

const ORD_TIMEOUT_MS  = Number(process.env.ORDERLY_TIMEOUT_MS || 7000);
const ORD_RETRIES     = Number(process.env.ORDERLY_RETRIES || 2);
const ORD_RETRY_BASE  = Number(process.env.ORDERLY_RETRY_BASE_MS || 500);
const ORD_INFO_TTL_MS = Number(process.env.ORDERLY_INFO_CACHE_TTL_MS || 600_000); // 10 min

// si plusieurs quotes existent un jour: priorité
const QUOTE_PRIORITY = (process.env.ORDERLY_QUOTE_PRIORITY || 'USDC,USD,USDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

/* ----------- utils ----------- */
const toNum = (x, f = 0) => { const n = Number(x); return Number.isFinite(n) ? n : f; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { retries = ORD_RETRIES, baseMs = ORD_RETRY_BASE, factor = 2, label = 'op' } = {}) {
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

function splitPerm(sym) {
  // "PERP_BTC_USDC" -> ["PERP","BTC","USDC"]
  const S = String(sym || '').toUpperCase();
  if (!S) return [];
  return S.split('_');
}
function baseFromSymbol(sym) {
  const p = splitPerm(sym);
  return p[1] || '';
}
function quoteFromSymbol(sym) {
  const p = splitPerm(sym);
  return p[2] || '';
}
function quoteRank(sym) {
  const q = quoteFromSymbol(sym);
  const i = QUOTE_PRIORITY.indexOf(q);
  return i === -1 ? 0 : (QUOTE_PRIORITY.length - i); // plus haut = mieux
}

/* ----------- collector ----------- */
export default class OrderlyCollector extends DataCollectorBase {
  constructor(walletPath, options = {}) {
    super('orderly', walletPath);
    this.allowedPairs = parseAllowedPairs(options.allowedPairs || this.pairs, 'ALLOWED_PAIRS');
    this._infoCache = { ts: 0, bySymbol: null }; // funding_period etc.
  }

  async _fetch(url, { query, timeoutMs = ORD_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const q = query ? `?${new URLSearchParams(query).toString()}` : '';
      const res = await fetch(url + q, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally { clearTimeout(t); }
  }

  async _getFundingAll() {
    // /v1/public/funding_rates → est_funding_rate, last_funding_rate, next_funding_time
    const json = await withRetry(() => this._fetch(ORD_FUNDING_URL), { label: 'orderly funding_rates' });
    const rows = json?.data?.rows;
    return Array.isArray(rows) ? rows : [];
  }

  async _getOpenInterests() {
    const json = await withRetry(() => this._fetch(ORD_OI_URL), { label: 'orderly open_interests' });
    const rows = json?.data?.rows;
    const map = new Map();
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const sym = String(r?.symbol || '').toUpperCase();
        const long_oi  = toNum(r?.long_oi, NaN);
        const short_oi = toNum(r?.short_oi, NaN);
        map.set(sym, { long_oi, short_oi });
      }
    }
    return map;
  }

  async _getInfoCache() {
    const now = Date.now();
    if (this._infoCache.bySymbol && (now - this._infoCache.ts) < ORD_INFO_TTL_MS) {
      return this._infoCache.bySymbol;
    }
    const json = await withRetry(() => this._fetch(ORD_INFO_URL), { label: 'orderly info' });
    const rows = json?.data?.rows;
    const bySymbol = {};
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const sym = String(r?.symbol || '').toUpperCase();
        if (!sym) continue;
        bySymbol[sym] = {
          funding_period: toNum(r?.funding_period, 8),
          cap_funding: toNum(r?.cap_funding, 0.000375),
          floor_funding: toNum(r?.floor_funding, -0.000375),
        };
      }
    }
    this._infoCache = { ts: now, bySymbol };
    return bySymbol;
  }

  // dédup par base : choisir la meilleure quote selon QUOTE_PRIORITY
  _selectWinners(fundingRows) {
    const grouped = new Map(); // base -> bestRow
    for (const row of fundingRows) {
      const sym = String(row?.symbol || '').toUpperCase(); // PERP_BTC_USDC
      const base = baseFromSymbol(sym);
      if (!base || !this.allowedPairs.has(base)) continue;

      const score = quoteRank(sym);
      const cur = grouped.get(base);
      if (!cur || score > cur._score) {
        grouped.set(base, { ...row, _score: score });
      }
    }
    // -> [{ pair:'BTC', row, symbol }]
    return Array.from(grouped.entries()).map(([pair, r]) => ({ pair, row: r, symbol: String(r.symbol).toUpperCase() }));
  }

  async collectAndSend() {
    console.log('[Orderly] Récupération des marchés…');
    const [fundRows, oiBySym, infoBySym] = await Promise.all([
      this._getFundingAll(),
      this._getOpenInterests(),
      this._getInfoCache(),
    ]);

    const items = this._selectWinners(fundRows);
    if (items.length === 0) {
      console.log('[Orderly] Aucune paire autorisée trouvée.');
      return;
    }

    let sent = 0;
    for (const { pair, row, symbol } of items) {
      // funding: on préfère est_funding_rate, sinon last_funding_rate
      const funding_rate = toNum(row?.est_funding_rate, toNum(row?.last_funding_rate, 0));
      const next_funding = toNum(row?.next_funding_time, Date.now());
      const oi = oiBySym.get(symbol) || {};
      const longOI  = toNum(oi.long_oi, NaN);
      const shortOI = toNum(oi.short_oi, NaN);

      const liquidity = {
        long:  Number.isFinite(longOI)  ? longOI  : 1_000_000,
        short: Number.isFinite(shortOI) ? shortOI : 1_000_000,
      };

      // Pas de maker/taker publics par symbole dans ces endpoints; on met par défaut 0.02% / 0.05% (à ajuster si nécessaire)
      const fees = { maker: 0.0002, taker: 0.0005 };

      // (optionnel) on pourrait utiliser infoBySym[symbol]?.funding_period pour un fallback du nextFunding
      try {
        console.log(`Checking ${pair} funding rate on Orderly...`);
        await this.sendToAOS(pair, { funding_rate, next_funding, liquidity, fees });
        sent += 1;
      } catch (e) {
        console.error(`[Orderly] Échec envoi ${pair}:`, e?.message || e);
      }
    }

    console.log(`[Orderly] ${sent} mise(s) à jour envoyée(s) (dédupliquées par pair).`);
  }

  // compat: collecte “par paire”
  async collectFundingData(pair) {
    const [fundRows, oiBySym, infoBySym] = await Promise.all([
      this._getFundingAll(),
      this._getOpenInterests(),
      this._getInfoCache(),
    ]);
    const base = String(pair).toUpperCase();
    const winners = this._selectWinners(fundRows.filter(r => baseFromSymbol(r?.symbol) === base));
    if (winners.length === 0) throw new Error(`[Orderly] Market introuvable pour ${pair}`);

    const { row, symbol } = winners[0];
    const funding_rate = toNum(row?.est_funding_rate, toNum(row?.last_funding_rate, 0));
    const next_funding = toNum(row?.next_funding_time, Date.now());
    const oi = oiBySym.get(symbol) || {};
    const longOI  = toNum(oi.long_oi, NaN);
    const shortOI = toNum(oi.short_oi, NaN);

    return {
      funding_rate,
      next_funding,
      liquidity: {
        long:  Number.isFinite(longOI)  ? longOI  : 1_000_000,
        short: Number.isFinite(shortOI) ? shortOI : 1_000_000,
      },
      fees: { maker: 0.0002, taker: 0.0005 },
      // meta: infoBySym[symbol] || {}
    };
  }
}
