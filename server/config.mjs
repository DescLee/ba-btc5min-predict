export function readConfig(env = process.env) {
  function number(name, fallback, min, max) {
    const n = Number(env[name] ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} 配置无效`);
    return n;
  }
  const mode = env.MODE || 'demo';
  const btcPriceMode = env.BTC_PRICE_MODE || 'live';
  if (!['live', 'simulated'].includes(btcPriceMode)) throw new Error('BTC_PRICE_MODE 必须是 live 或 simulated');
  if (!['demo', 'live'].includes(mode)) throw new Error('MODE 必须是 demo 或 live');
  const fundingSource = env.FUNDING_SOURCE || 'MPC';
  const accountType = env.ACCOUNT_TYPE || 'SPOT';
  if (!['MPC', 'CEX'].includes(fundingSource) || !['SPOT', 'FUNDING'].includes(accountType)) throw new Error('资金来源或账户类型配置无效');
  return {
    mode, btcPriceMode, port: number('PORT', 4317, 1024, 65535),
    apiKey: env.BINANCE_API_KEY || '', apiSecret: env.BINANCE_API_SECRET || '',
    walletAddress: env.BINANCE_WALLET_ADDRESS || '', walletId: env.BINANCE_WALLET_ID || '',
    fundingSource, accountType, liveEnabled: env.LIVE_TRADING_ENABLED === 'true',
    rulesVerified: env.MARKET_RULES_VERIFIED === 'true', priceSource: env.SETTLEMENT_PRICE_SOURCE || 'UNVERIFIED',
    maxOrder: number('MAX_ORDER_USDT', 20, 1, 100000), maxDaily: number('MAX_DAILY_USDT', 100, 1, 1000000),
    minRemaining: number('MIN_REMAINING_SECONDS', 5, 2, 60), maxDataAge: number('MAX_DATA_AGE_MS', 5000, 500, 30000),
    pollMs: number('POLL_INTERVAL_MS', 2500, 1500, 30000),
    jevCommand: env.JEV_COMMAND || 'jev', jevTimeout: number('JEV_TIMEOUT_MS', 2000, 200, 10000),
    jevConfidence: number('JEV_MIN_CONFIDENCE', .8, .5, 1)
  };
}
