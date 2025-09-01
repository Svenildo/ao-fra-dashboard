// collectors/run-orderly.js
import OrderlyCollector from './data-collector-orderly.js';

const walletPath = process.env.WALLET_PATH || '../my-wallet.json';
const baseIntervalMs = Number(process.env.COLLECT_INTERVAL_MS || 300_000);
const jitterMs = Number(process.env.JITTER_MS || 0);

let stopped = false, isRunning = false, inFlight = null;

console.log('⏳ Collecte Orderly démarrée...');

const nextDelay = () => Math.max(1000,
  baseIntervalMs + (jitterMs ? Math.floor((Math.random()*2-1)*jitterMs) : 0)
);

async function once() {
  if (isRunning) { console.warn('⏸️ Run déjà en cours, on saute ce tick.'); return; }
  isRunning = true;
  try {
    const collector = new OrderlyCollector(walletPath);
    inFlight = collector.collectAndSend();
    await inFlight;
    console.log('✅ Collecte Orderly terminée');
  } catch (e) {
    console.error('❌ Erreur durant la collecte Orderly:', e?.message || e);
  } finally {
    isRunning = false; inFlight = null;
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
  console.log('👋 Orderly runner stoppé proprement.');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));