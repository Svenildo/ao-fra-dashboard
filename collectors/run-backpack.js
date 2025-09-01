// collectors/run-backpack.js
import BackpackCollector from './data-collector-backpack.js';

const walletPath = process.env.WALLET_PATH || '../my-wallet.json';
const baseIntervalMs = Number(process.env.COLLECT_INTERVAL_MS || 300_000);
const jitterMs = Number(process.env.JITTER_MS || 0);

let stopped = false;
let isRunning = false;
let inFlight = null;

console.log('⏳ Collecte Backpack démarrée...');

function nextDelay() {
  if (jitterMs <= 0) return baseIntervalMs;
  const delta = Math.floor((Math.random() * 2 - 1) * jitterMs);
  return Math.max(1000, baseIntervalMs + delta);
}

async function once() {
  if (isRunning) {
    console.warn('⏸️ Run déjà en cours, on saute ce tick pour éviter le chevauchement.');
    return;
  }
  isRunning = true;
  try {
    const collector = new BackpackCollector(walletPath);
    inFlight = collector.collectAndSend();
    await inFlight;
    console.log('✅ Collecte Backpack terminée');
  } catch (err) {
    console.error('❌ Erreur durant la collecte Backpack:', err?.message || err);
  } finally {
    isRunning = false;
    inFlight = null;
  }
}

async function loop() {
  while (!stopped) {
    await once();
    if (stopped) break;
    await new Promise((r) => setTimeout(r, nextDelay()));
  }
}

loop();

async function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  console.log(`\n🛑 Reçu ${signal}. Arrêt en cours…`);
  try { if (inFlight) await inFlight; } catch {}
  console.log('👋 Backpack runner stoppé proprement.');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
