// collectors/run-dydx.js
import DydxCollector from './data-collector-dydx.js';

const walletPath = process.env.WALLET_PATH || '../my-wallet.json';
const baseIntervalMs = Number(process.env.COLLECT_INTERVAL_MS || 300_000); // 5 min par défaut
const jitterMs = Number(process.env.JITTER_MS || 0); // ex: 5000 => ±5s aléatoires

let stopped = false;
let isRunning = false;
let inFlight = null;

console.log('⏳ Collecte dYdX démarrée...');

function nextDelay() {
  if (jitterMs <= 0) return baseIntervalMs;
  const delta = Math.floor((Math.random() * 2 - 1) * jitterMs); // [-jitter, +jitter]
  const d = baseIntervalMs + delta;
  return Math.max(1000, d); // au moins 1s
}

async function once() {
  if (isRunning) {
    console.warn('⏸️ Run déjà en cours, on saute ce tick pour éviter le chevauchement.');
    return;
  }
  isRunning = true;

  try {
    const collector = new DydxCollector(walletPath);
    inFlight = collector.collectAndSend();
    await inFlight;
    console.log('✅ Collecte dYdX terminée');
  } catch (err) {
    console.error('❌ Erreur durant la collecte dYdX:', err?.message || err);
  } finally {
    isRunning = false;
    inFlight = null;
  }
}

async function loop() {
  while (!stopped) {
    await once();
    if (stopped) break;
    const delay = nextDelay();
    await new Promise((r) => setTimeout(r, delay));
  }
}

// Lancer immédiatement une première collecte (comportement identique à avant)
loop();

// Arrêt propre (Ctrl+C / kill)
async function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  console.log(`\n🛑 Reçu ${signal}. Arrêt en cours…`);
  try {
    if (inFlight) await inFlight;
  } catch {
    // ignorer
  } finally {
    console.log('👋 dYdX runner stoppé proprement.');
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));