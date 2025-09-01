// collectors/run-aevo.js
import AevoCollector from './data-collector-aevo.js';

const walletPath = process.env.WALLET_PATH || '../my-wallet.json';
const baseIntervalMs = Number(process.env.COLLECT_INTERVAL_MS || 300_000);
const jitterMs = Number(process.env.JITTER_MS || 0);

let stopped = false, isRunning = false, inFlight = null;

console.log('⏳ Collecte Aevo démarrée...');

function nextDelay() {
  if (jitterMs <= 0) return baseIntervalMs;
  const delta = Math.floor((Math.random() * 2 - 1) * jitterMs);
  return Math.max(1000, baseIntervalMs + delta);
}

async function once() {
  if (isRunning) {
    console.warn('⏸️ Run déjà en cours, on saute ce tick.');
    return;
  }
  isRunning = true;
  try {
    const collector = new AevoCollector(walletPath);
    inFlight = collector.collectAndSend();
    await inFlight;
    console.log('✅ Collecte Aevo terminée');
  } catch (err) {
    console.error('❌ Erreur durant la collecte Aevo:', err?.message || err);
  } finally {
    isRunning = false;
    inFlight = null;
  }
}

(async function loop() {
  while (!stopped) {
    await once();
    if (stopped) break;
    await new Promise(r => setTimeout(r, nextDelay()));
  }
})();

async function shutdown(sig) {
  if (stopped) return;
  stopped = true;
  console.log(`\n🛑 Reçu ${sig}. Arrêt en cours…`);
  try { if (inFlight) await inFlight; } catch {}
  console.log('👋 Aevo runner stoppé proprement.');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));