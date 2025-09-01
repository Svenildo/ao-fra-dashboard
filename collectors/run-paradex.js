// collectors/run-paradex.js
import ParadexCollector from './data-collector-paradex.js';

const walletPath = '../my-wallet.json'; // adapte si besoin
const intervalMs = Number(process.env.COLLECT_INTERVAL_MS || 300_000); // 5 min par défaut

async function main() {
  console.log(`⏳ [Paradex] Collecte démarrée (intervalle=${intervalMs}ms)`);

  const runOnce = async () => {
    try {
      const collector = new ParadexCollector(walletPath);
      await collector.collectAndSend();
      console.log('✅ [Paradex] Cycle terminé');
    } catch (err) {
      console.error('❌ [Paradex] Erreur durant la collecte:', err.message);
    }
  };

  await runOnce();

  if (intervalMs > 0) {
    setInterval(runOnce, intervalMs);
  }
}

main().catch((err) => {
  console.error('🚨 [Paradex] Erreur fatale:', err);
  process.exit(1);
});