// collectors/ecosystem.config.cjs  (CommonJS)
const COMMON = {
  cwd: '.',                      // on est déjà dans collectors/
  exec_mode: 'fork',
  node_args: '--enable-source-maps',
  watch: true,                   // auto-reload sur changement de code
  watch_delay: 500,              // petit debounce
  ignore_watch: [
    'node_modules',
    '*.log',
    '.env',
    '.last-sent.json',
    'logs',
    // optionnel: tous les fichiers générés localement
  ],
  max_restarts: 10,
  restart_delay: 2000,
  max_memory_restart: '300M',
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
  env: { NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    {
      name: 'funding-dydx',
      script: 'run-dydx.js',
      out_file: 'logs/funding-dydx.out.log',
      error_file: 'logs/funding-dydx.err.log',
      env: { ...COMMON.env, COLLECT_INTERVAL_MS: '180000', JITTER_MS: '5000' },
      ...COMMON,
    },
    {
      name: 'funding-hyperliquid',
      script: 'run-hyperliquid.js',
      out_file: 'logs/funding-hyperliquid.out.log',
      error_file: 'logs/funding-hyperliquid.err.log',
      env: { ...COMMON.env, COLLECT_INTERVAL_MS: '180000', JITTER_MS: '5000' },
      ...COMMON,
    },
    {
      name: 'funding-paradex',
      script: 'run-paradex.js',
      out_file: 'logs/funding-paradex.out.log',
      error_file: 'logs/funding-paradex.err.log',
      env: { ...COMMON.env, COLLECT_INTERVAL_MS: '300000', PARADEX_QUOTE_PRIORITY: 'USD,USDC,USDT' },
      ...COMMON,
    },
    {
      name: 'funding-backpack',
      script: 'run-backpack.js',
      out_file: 'logs/funding-backpack.out.log',
      error_file: 'logs/funding-backpack.err.log',
      env: { ...COMMON.env, COLLECT_INTERVAL_MS: '300000' },
      ...COMMON,
    },
    {
      name: 'funding-orderly',
      script: 'run-orderly.js',
      out_file: 'logs/funding-orderly.out.log',
      error_file: 'logs/funding-orderly.err.log',
      env: { ...COMMON.env, COLLECT_INTERVAL_MS: '300000' },
      ...COMMON,
    },
    {
      name: 'funding-extended',
      script: 'run-extended.js',
      out_file: 'logs/funding-extended.out.log',
      error_file: 'logs/funding-extended.err.log',
      env: { ...COMMON.env, COLLECT_INTERVAL_MS: '300000', USER_AGENT: 'ao-funding-collector/1.0' },
      ...COMMON,
    },
    {
      name: 'funding-aevo',
      script: 'run-aevo.js',
      out_file: 'logs/funding-aevo.out.log',
      error_file: 'logs/funding-aevo.err.log',
      env: { ...COMMON.env, COLLECT_INTERVAL_MS: '300000', AEVO_MAX_CONCURRENCY: '3', AEVO_MARKETS_CACHE_TTL_MS: '60000' },
      ...COMMON,
    },
  ],
};
