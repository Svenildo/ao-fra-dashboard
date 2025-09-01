AO Funding Collector – dYdX and other DEXes
===========================================

This system collects funding rate data from decentralized exchanges (DEXes) like dYdX,
then sends structured messages to AO processes using the aoconnect protocol.

It uses a modular architecture per DEX (dYdX, Hyperliquid, Paradex, etc.) with shared logic.

Project Structure
-----------------

collectors/
├── data-collector-dydx.js        # Collector class for dYdX
├── data-collector-base.js        # Shared base class for all DEX collectors
├── run-dydx.js                   # Runner for the dYdX collector
├── ecosystem.config.cjs          # PM2 process manager config for all DEX collectors

Setup Instructions
------------------

1. Install Node.js dependencies:

   npm install node-fetch@3 dotenv@16 @permaweb/aoconnect@0.0.32

2. Install PM2 globally (if not already):

   npm install -g pm2

3. Set up your environment file (.env):

   Create a .env file in the collectors/ folder with variables like:

     WALLET_PATH=../my-wallet.json
     ALLOWED_PAIRS=BTC,ETH,SOL
     ANALYSIS_BTC_PROCESS=your_process_id_here
     ANALYSIS_ETH_PROCESS=your_process_id_here
     ...

   Example optional variables:

     SKIP_UNCHANGED=1
     PERSIST_LAST_STATE=1
     DRY_RUN=0
     SCHEMA=funding.v1

Running with PM2
----------------

1. Run a single collector manually (e.g. dYdX):

   pm2 start run-dydx.js --name funding-dydx

2. Or launch all collectors using the shared config:

   pm2 start ecosystem.config.cjs

   This will launch all configured collectors (dydx, hyperliquid, paradex, etc.)

3. Monitor logs:

   pm2 logs funding-dydx
   pm2 logs

4. To stop:

   pm2 stop funding-dydx
   pm2 delete funding-dydx

5. Save PM2 config for auto-restart on reboot:

   pm2 save
   pm2 startup

Environment Configuration
-------------------------

Each collector uses:

  - WALLET_PATH: path to your AO wallet (JSON key)
  - ALLOWED_PAIRS: which token pairs to track
  - ANALYSIS_<PAIR>_PROCESS: AO process ID per token

Optional tuning parameters:

  - COLLECT_INTERVAL_MS: base interval between data collections (default: 300000)
  - JITTER_MS: adds randomness to avoid synchronized loads
  - SKIP_UNCHANGED=1: don't resend if data hasn't changed
  - PERSIST_LAST_STATE=1: cache the last data sent
  - DRY_RUN=1: simulate sending (no actual submission)

Suggestions for Improvement
---------------------------

- Add automatic retry reporting
- Store metrics to a database or Prometheus
- Add test suite for each collector
- Integrate email or Discord alerts on failure