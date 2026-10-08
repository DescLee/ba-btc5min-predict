// 可信本地代码：编辑此文件，然后在面板启用「自定义代码」。
// 只返回建议；下单、额度、时效和报价检查始终由执行器负责。
// ctx 包含 market / timing / btc / outcomes / strategy / risk。
export function decide(ctx) {
  if (ctx.timing.remainingSeconds > 30 || ctx.timing.remainingSeconds <= 5) return { action: 'SKIP', reason: '不在 5～30 秒窗口' };
  const delta = ctx.btc.deltaUsd;
  if (Math.abs(delta) < ctx.strategy.minDeltaUsd) return { action: 'SKIP', reason: '价差不足' };
  const direction = delta > 0 ? 'UP' : 'DOWN';
  // 例：下跌时若近 5 秒价格明显反弹，则不追跌。
  if (direction === 'DOWN' && ctx.btc.changes['5s'] > 10) return { action: 'SKIP', reason: '短线反弹，跳过追跌' };
  return { action: `BUY_${direction}`, reason: '自定义尾盘价差条件通过' };
}
