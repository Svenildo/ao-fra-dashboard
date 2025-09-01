// collectors/data-collector-backpack.js
import DataCollectorBase, { parseAllowedPairs } from './data-collector-base.js';
import fetch from 'node-fetch';

const HOURS_MS = h => h * 60 * 60 * 1000;

/* -------------------- ENV -------------------- */
const BP_BASE_URL         = process.env.BACKPACK_BASE_URL || 'https://api.backpack.exchange';
const BP_MARKPRICES_URL   = `${BP_BASE_URL}/api/v1/markPrices`;
const BP_OPENINTEREST_URL = `${BP_BASE_URL}/api/v1/openInterest`;
const BP_MARKETS_URL      = `${BP_BASE_URL}/api/v1/markets`; // utilisé en cache si besoin

const BP_TIMEOUT_MS       = Number(process.env.BACKPACK_TIMEOUT_MS || 7000);
const BP_RETRIES          = Number(process.env.BACKPACK_RETRIES || 2);
const BP_RETRY_BASE_MS    = Number(process.env.BACKPACK_RETRY_BASE_MS || 500);
const BP_MKT_CACHE_TTL_MS = Number(process.env.BACKPACK_MARKETS_CACHE_TTL_MS || 600_000); // 10 min

// ordre de préférence des quotes (si plusieurs perps existent pour une même base)
const QUOTE_PRIORITY = (process.env.BACKPACK_QUOTE_PRIORITY || 'USDC,USD,USDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const BP_DEBUG = /^(1|true)$/i.test(process.env.BACKPACK_DEBUG || '0');

/* ------------------ Utils génériques ------------------ */
const toNum = (x, f = 0) => { const n = Number(x); return Number.isFinite(n) ? n : f; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { retries = BP_RETRIES, baseMs = BP_RETRY_BASE_MS, factor = 2, label = 'op' } = {}) {
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

/* ------------------ Parsing symboles ------------------ */
// Supporte "SOL_USDC_PERP" ou "SOL-USDC-PERP"
function splitTokens(sym) {
  const S = String(sym || '').toUpperCase();
  if (!S) return [];
  const parts = S.includes('_') ? S.split('_') : S.split('-');
  return parts.filter(Boolean);
}
function symbolBase(sym) {
  const parts = splitTokens(sym);
  return parts[0] || '';
}
function symbolQuote(sym) {
  const parts = splitTokens(sym);
  // ex: ["SOL","USDC","PERP"] → "USDC"
  if (parts.length >= 2) return parts[1].replace(/PERP$/,'');
  return '';
}
function isPerpSymbol(sym) {
  const S = String(sym || '').toUpperCase();
  return S.endsWith('_PERP') || S.endsWith('-PERP') || S.includes('PERP');
}
function rankByQuote(sym) {
  const q = symbolQuote(sym);
  const i = QUOTE_PRIORITY.indexOf(q);
  return i === -1 ? 0 : (QUOTE_PRIORITY.length - i); // plus haut = mieux
}

/* ------------------ Collector Backpack ------------------ */
export default class BackpackCollector extends DataCollectorBase {
  constructor(walletPath, options = {}) {
    super('backpack', walletPath);
    this.allowedPairs = parseAllowedPairs(options.allowedPairs || this.pairs, 'ALLOWED_PAIRS');
    this._marketsCache = { ts: 0, list: null }; // éventuel cache du /markets
  }

  async _fetch(url, { timeoutMs = BP_TIMEOUT_MS, query } = {}) {
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

  // Optionnel: cache des marchés si tu veux croiser des infos plus tard
  async _getMarkets() {
    const now = Date.now();
    if (this._marketsCache.list && (now - this._marketsCache.ts) < BP_MKT_CACHE_TTL_MS) {
      return this._marketsCache.list;
    }
    const json = await withRetry(() => this._fetch(BP_MARKETS_URL), { label: 'backpack markets' });
    const list = Array.isArray(json) ? json : (Array.isArray(json?.results) ? json.results : []);
    this._marketsCache = { ts: now, list };
    return list;
  }

  async _getMarkPrices() {
    // fundingRate & nextFundingTimestamp (tous les perps)
    const json = await withRetry(() => this._fetch(BP_MARKPRICES_URL), { label: 'backpack markPrices' });
    const arr = Array.isArray(json) ? json : (Array.isArray(json?.results) ? json.results : []);
    const bySymbol = new Map();
    for (const r of arr) {
      const sym = String(r?.symbol || '').toUpperCase();
      if (!sym) continue;
      const fr = toNum(r?.fundingRate, 0);
      let nft = toNum(r?.nextFundingTimestamp, Date.now());
      // seconds → ms si besoin
      if (nft > 0 && nft < 1e12) nft *= 1000;
      bySymbol.set(sym, { funding_rate: fr, next_funding: nft });
    }
    return bySymbol;
  }

  async _getOpenInterest() {
    const json = await withRetry(() => this._fetch(BP_OPENINTEREST_URL), { label: 'backpack openInterest' });
    const arr = Array.isArray(json) ? json : (Array.isArray(json?.results) ? json.results : []);
    const bySymbol = new Map();
    for (const r of arr) {
      const sym = String(r?.symbol || '').toUpperCase();
      const oi = toNum(r?.openInterest, NaN);
      if (sym) bySymbol.set(sym, oi);
    }
    return bySymbol;
  }

  // Dédup par base via markPrices (source canonique des perps)
  _selectWinners(markPricesBySym, oiBySym) {
    const grouped = new Map(); // base -> { symbol, score, oi }
    for (const sym of markPricesBySym.keys()) {
      const SYM = String(sym).toUpperCase();
      if (!isPerpSymbol(SYM)) continue;           // garder uniquement les perps
      const base = symbolBase(SYM);
      if (!base || !this.allowedPairs.has(base)) continue;

      const score = rankByQuote(SYM);
      const oi = toNum(oiBySym.get(SYM), 0);

      const cur = grouped.get(base);
      if (!cur || score > cur.score || (score === cur.score && oi > cur.oi)) {
        grouped.set(base, { symbol: SYM, score, oi });
      }
    }
    return Array.from(grouped.entries()).map(([pair, v]) => ({ pair, symbol: v.symbol }));
  }

  async collectAndSend() {
    console.log('[Backpack] Récupération des marchés…');

    const [markPricesBySym, oiBySym] = await Promise.all([
      this._getMarkPrices(),
      this._getOpenInterest(),
      // this._getMarkets(), // on peut l'appeler si besoin plus tard
    ]);

    const winners = this._selectWinners(markPricesBySym, oiBySym);

    if (winners.length === 0) {
      if (BP_DEBUG) {
        const allowed = Array.from(this.allowedPairs);
        const sample = Array.from(markPricesBySym.keys()).slice(0, 12);
        console.log('[Backpack][debug] allowedPairs =', allowed);
        console.log('[Backpack][debug] sample markPrices symbols =', sample);
        console.log('[Backpack][debug] tip: on cherche BASE_QUOTE_PERP ou BASE-QUOTE-PERP');
      }
      console.log('[Backpack] Aucune paire autorisée trouvée.');
      return;
    }

    let sent = 0;
    for (const { pair, symbol } of winners) {
      const mp = markPricesBySym.get(symbol) || {};
      const oi = toNum(oiBySym.get(symbol), NaN);

      const funding_rate = toNum(mp.funding_rate, 0);
      const next_funding = toNum(mp.next_funding, Date.now());
      const liquidity = {
        long:  Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
        short: Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
      };
      const fees = { maker: 0.0002, taker: 0.0005 }; // générique faute d’endpoint public détaillé

      try {
        console.log(`Checking ${pair} funding rate on Backpack...`);
        await this.sendToAOS(pair, { funding_rate, next_funding, liquidity, fees });
        sent += 1;
      } catch (e) {
        console.error(`[Backpack] Échec envoi ${pair}:`, e?.message || e);
      }
    }

    console.log(`[Backpack] ${sent} mise(s) à jour envoyée(s) (dédupliquées par pair).`);
  }

  // Compat: version "par paire"
  async collectFundingData(pair) {
    const [markPricesBySym, oiBySym] = await Promise.all([
      this._getMarkPrices(),
      this._getOpenInterest(),
    ]);

    const base = String(pair).toUpperCase();

    // Sous-ensemble des symboles de cette base (et perps seulement)
    const sub = new Map(
      Array.from(markPricesBySym.entries())
        .filter(([sym]) => {
          const SYM = String(sym).toUpperCase();
          return isPerpSymbol(SYM) && symbolBase(SYM) === base;
        })
    );

    const winners = this._selectWinners(sub, oiBySym);
    if (winners.length === 0) throw new Error(`[Backpack] Market introuvable pour ${pair}`);

    const symbol = winners[0].symbol;
    const mp = markPricesBySym.get(symbol) || {};
    const oi = toNum(oiBySym.get(symbol), NaN);

    return {
      funding_rate: toNum(mp.funding_rate, 0),
      next_funding: toNum(mp.next_funding, Date.now()),
      liquidity: {
        long:  Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
        short: Number.isFinite(oi) ? oi * 0.5 : 1_000_000,
      },
      fees: { maker: 0.0002, taker: 0.0005 },
    };
  }
}
