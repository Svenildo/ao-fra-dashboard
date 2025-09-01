// collectors/data-collector-paradex.js
import DataCollectorBase, { parseAllowedPairs } from './data-collector-base.js';
import fetch from 'node-fetch';

const HOURS_MS = h => h * 60 * 60 * 1000;

// ---------- ENV / Defaults ----------
const PARADEX_MARKETS_URL  = process.env.PARADEX_MARKETS_URL  || 'https://api.prod.paradex.trade/v1/markets';
const PARADEX_SUMMARY_URL  = process.env.PARADEX_SUMMARY_URL  || 'https://api.prod.paradex.trade/v1/markets/summary';
const PARADEX_TIMEOUT_MS   = Number(process.env.PARADEX_TIMEOUT_MS || 7000);
const PARADEX_RETRIES      = Number(process.env.PARADEX_RETRIES || 2);
const PARADEX_RETRY_BASE_MS= Number(process.env.PARADEX_RETRY_BASE_MS || 500);
const PARADEX_MKT_CACHE_TTL_MS = Number(process.env.PARADEX_MARKETS_CACHE_TTL_MS || 600_000); // 10 min

// Priorité des quotes (ex: USD > USDC > USDT)
const QUOTE_PRIORITY = (process.env.PARADEX_QUOTE_PRIORITY || 'USD,USDC,USDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ---------- Utils ----------
const toNum = (x, f = 0) => { const n = Number(x); return Number.isFinite(n) ? n : f; };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { retries = PARADEX_RETRIES, baseMs = PARADEX_RETRY_BASE_MS, factor = 2, label = "op" } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i === retries) break;
      const delay = baseMs * Math.pow(factor, i);
      console.warn(`[retry] ${label} failed (${i + 1}/${retries + 1}): ${e?.message || e}. wait ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Sélection du meilleur marché pour chaque base (dédup)
function selectBestMarkets(summaries, allowedPairs) {
  const grouped = new Map(); // base -> { row, symbol, oi, quoteScore }
  for (const row of summaries) {
    const symbol = String(row?.symbol || '').toUpperCase();     // ex: BTC-USD-PERP
    const [base, quote] = symbol.split('-');                    // base=BTC, quote=USD
    if (!base || !quote) continue;
    if (!allowedPairs.has(base)) continue;

    const oi = toNum(row?.open_interest, 0);
    const qi = QUOTE_PRIORITY.indexOf(quote);
    const quoteScore = qi === -1 ? 0 : (QUOTE_PRIORITY.length - qi); // plus haut = mieux

    const cur = grouped.get(base);
    if (!cur || quoteScore > cur.quoteScore || (quoteScore === cur.quoteScore && oi > cur.oi)) {
      grouped.set(base, { row, symbol, oi, quoteScore });
    }
  }
  return Array.from(grouped.entries()).map(([pair, { row, symbol }]) => ({ pair, row, symbol }));
}

// ---------- Collector ----------
export default class ParadexCollector extends DataCollectorBase {
  constructor(walletPath, options = {}) {
    super('paradex', walletPath);
    this.allowedPairs = parseAllowedPairs(options.allowedPairs || this.pairs, 'ALLOWED_PAIRS');
    this._staticCache = { ts: 0, bySymbol: null }; // cache du /markets (static)
  }

  async _fetch(url, { timeoutMs = PARADEX_TIMEOUT_MS, method = 'GET', query } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const q = query ? `?${new URLSearchParams(query).toString()}` : '';
      const res = await fetch(url + q, { method, headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally { clearTimeout(t); }
  }

  async _getMarketsStatic() {
    const now = Date.now();
    if (this._staticCache.bySymbol && (now - this._staticCache.ts) < PARADEX_MKT_CACHE_TTL_MS) {
      return this._staticCache.bySymbol;
    }
    const json = await withRetry(() => this._fetch(PARADEX_MARKETS_URL), { label: "paradex markets static" });
    const results = Array.isArray(json?.results) ? json.results : [];
    const bySymbol = {};
    for (const m of results) {
      const sym = String(m?.symbol || m?.chain_details?.symbol || '').toUpperCase();
      if (!sym) continue;
      bySymbol[sym] = {
        funding_period_hours: toNum(m?.funding_period_hours, 8),
        fee_maker: toNum(m?.chain_details?.fee_maker, 0),
        fee_taker: toNum(m?.chain_details?.fee_taker, 0),
      };
    }
    this._staticCache = { ts: now, bySymbol };
    return bySymbol;
  }

  async _getMarketsSummaryAll() {
    const json = await withRetry(
      () => this._fetch(PARADEX_SUMMARY_URL, { query: { market: 'ALL' } }),
      { label: "paradex markets summary ALL" }
    );
    return Array.isArray(json?.results) ? json.results : [];
  }

  _toPairName(symbol) {
    return String(symbol).split('-')[0]?.toUpperCase() || '';
  }

  async collectAndSend() {
    console.log('[Paradex] Récupération des marchés…');
    const [staticBySym, summaries] = await Promise.all([
      this._getMarketsStatic(),
      this._getMarketsSummaryAll(),
    ]);

    // Dédup par base
    const items = selectBestMarkets(summaries, this.allowedPairs);
    if (items.length === 0) {
      console.log('[Paradex] Aucune paire autorisée trouvée.');
      return;
    }

    let sent = 0;
    for (const { pair, row, symbol } of items) {
      const funding_rate   = toNum(row?.funding_rate, 0);
      const future_funding = toNum(row?.future_funding_rate, funding_rate);
      const oi             = toNum(row?.open_interest, NaN);

      const st = staticBySym[symbol] || {};
      const next_funding = Date.now() + HOURS_MS(toNum(st.funding_period_hours, 8));

      const liquidity = {
        long:  Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
        short: Number.isFinite(oi) ? oi * 0.5 : 1_000_000
      };
      const fees = { maker: toNum(st.fee_maker, 0), taker: toNum(st.fee_taker, 0) };

      try {
        console.log(`Checking ${pair} funding rate on Paradex...`);
        await this.sendToAOS(pair, { funding_rate, next_funding, liquidity, fees, future_funding });
        sent += 1;
      } catch (e) {
        console.error(`[Paradex] Échec envoi ${pair}:`, e?.message || e);
      }
    }

    console.log(`[Paradex] ${sent} mise(s) à jour envoyée(s) (dédupliquées par pair).`);
  }

  // Compat: version "par paire"
  async collectFundingData(pair) {
    const [staticBySym, summaries] = await Promise.all([
      this._getMarketsStatic(),
      this._getMarketsSummaryAll(),
    ]);
    const items = selectBestMarkets(summaries, new Set([String(pair).toUpperCase()]));
    if (items.length === 0) throw new Error(`[Paradex] Market introuvable pour ${pair}`);

    const { row, symbol } = items[0];
    const funding_rate   = toNum(row?.funding_rate, 0);
    const future_funding = toNum(row?.future_funding_rate, funding_rate);
    const oi             = toNum(row?.open_interest, NaN);
    const st             = staticBySym[symbol] || {};
    const next_funding   = Date.now() + HOURS_MS(toNum(st.funding_period_hours, 8));

    return {
      funding_rate,
      next_funding,
      liquidity: {
        long:  Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
        short: Number.isFinite(oi) ? oi * 0.5 : 1_000_000
      },
      fees: { maker: toNum(st.fee_maker, 0), taker: toNum(st.fee_taker, 0) },
      future_funding
    };
  }
}
