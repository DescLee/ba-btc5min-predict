export const defaultStrategy = {
  name: '尾盘价差策略', windowSeconds: 30, minRemainingSeconds: 5,
  minDeltaUsd: 30, maxPrice: .85, amount: 5, maxPerRound: 1,
  direction: 'FOLLOW', decisionMode: 'RULES', custom: false
};
export function validateStrategy(input) {
  const s = { ...defaultStrategy, ...input };
  const fields = { windowSeconds: [2, 300], minRemainingSeconds: [2, 60], minDeltaUsd: [0, 10000], maxPrice: [.01, .99], amount: [.01, 100000], maxPerRound: [1, 10] };
  for (const [k, [min, max]] of Object.entries(fields)) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k]) || s[k] < min || s[k] > max) throw new Error(`策略参数 ${k} 无效`);
  }
  if (!Number.isInteger(s.maxPerRound) || s.minRemainingSeconds >= s.windowSeconds) throw new Error('交易次数须为整数，最晚提交余量须小于交易窗口');
  if (!['FOLLOW', 'UP', 'DOWN'].includes(s.direction) || !['RULES', 'JEV'].includes(s.decisionMode)) throw new Error('策略方向或决策方式无效');
  if (typeof s.custom !== 'boolean') throw new Error('自定义策略开关无效');
  return { ...Object.fromEntries(Object.keys(defaultStrategy).map(k => [k, s[k]])), name: String(s.name).slice(0, 60) };
}
export function evaluateStrategy(snapshot, strategy, risk, now = Date.now()) {
  const skip = reason => ({ action: 'SKIP', reason });
  if (!snapshot) return skip('等待行情');
  const remaining = (snapshot.endDate - now) / 1000;
  if (remaining <= strategy.minRemainingSeconds) return skip('已进入禁止提交的尾部时间');
  if (remaining > strategy.windowSeconds) return skip(`等待最后 ${strategy.windowSeconds} 秒窗口`);
  if (now - snapshot.updatedAt > risk.maxDataAge || now - snapshot.priceUpdatedAt > risk.maxDataAge) return skip('行情已过期');
  if (!Number.isFinite(snapshot.price) || !Number.isFinite(snapshot.targetPrice)) return skip('目标价或参考价缺失');
  if (risk.roundCount >= strategy.maxPerRound) return skip('本期交易次数已达上限');
  if (risk.dailySpent + strategy.amount > risk.maxDaily || strategy.amount > risk.maxOrder) return skip('金额超过交易额度');
  const delta = snapshot.price - snapshot.targetPrice;
  if (Math.abs(delta) < strategy.minDeltaUsd || delta === 0) return skip('价格差值尚未达到阈值');
  const direction = delta > 0 ? 'UP' : 'DOWN';
  if (strategy.direction !== 'FOLLOW' && strategy.direction !== direction) return skip('当前价差方向不符合指定方向');
  const outcome = snapshot.outcomes[direction];
  if (!outcome || outcome.tradingStatus !== 'OPEN') return skip('该方向已停止交易');
  if (!(outcome.ask > 0 && outcome.ask <= strategy.maxPrice)) return skip('买入价格超过上限或无卖盘');
  return { action: `BUY_${direction}`, reason: `剩余 ${remaining.toFixed(1)} 秒，价差 ${delta.toFixed(2)} USD，买价 ${outcome.ask.toFixed(2)}`, direction };
}
export function decisionState(snapshot, strategy, risk, now = Date.now()) {
  const history = snapshot.history || [];
  const changes = {};
  for (const seconds of [5, 15, 30, 60]) {
    const point = [...history].reverse().find(p => p.at <= now - seconds * 1000);
    changes[`${seconds}s`] = point ? snapshot.price - point.price : null;
  }
  const recent = history.filter(p => p.at >= now - 60000).map(p => p.price);
  return {
    market: { id: snapshot.id, title: snapshot.title, startDate: snapshot.startDate, endDate: snapshot.endDate, targetPrice: snapshot.targetPrice, rules: snapshot.rules, priceSource: snapshot.priceSource, priceVerified: snapshot.priceVerified },
    timing: { at: now, remainingSeconds: (snapshot.endDate - now) / 1000, marketAgeMs: now - snapshot.updatedAt, priceAgeMs: now - snapshot.priceUpdatedAt },
    btc: { price: snapshot.price, deltaUsd: Number.isFinite(snapshot.targetPrice) ? snapshot.price - snapshot.targetPrice : null, deltaPercent: Number.isFinite(snapshot.targetPrice) && snapshot.targetPrice > 0 ? (snapshot.price / snapshot.targetPrice - 1) * 100 : null, changes, range60s: recent.length ? Math.max(...recent) - Math.min(...recent) : null },
    outcomes: snapshot.outcomes, feeRateBps: snapshot.feeRateBps, strategy, risk
  };
}
