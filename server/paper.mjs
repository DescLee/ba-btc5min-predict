import { randomUUID } from 'node:crypto';

export const paperDefaults = { strategyMode: 'DELTA', touchWindowSeconds: 90, touchPrice: .98, amount: 1, windowSeconds: 10, minDeltaUsd: 0, fallbackEnabled: false, fallbackWindowSeconds: 5, fallbackMinDeltaUsd: 0, maxPrice: .99, slippageBps: 1000, latencyMs: 500 };
export function validatePaperSettings(input = {}) {
  const result = { ...paperDefaults, ...input };
  if (!['DELTA', 'TOUCH_LIMIT'].includes(result.strategyMode)) throw new Error('模拟策略类型无效');
  for (const [key, min, max] of [['touchWindowSeconds', 2, 300], ['touchPrice', .01, .99], ['fallbackWindowSeconds', 2, 299], ['fallbackMinDeltaUsd', 0, 1000000], ['windowSeconds', 2, 300], ['minDeltaUsd', 0, 1000000], ['amount', .01, 1000], ['maxPrice', .01, .99], ['slippageBps', 0, 10000], ['latencyMs', 0, 3000]]) {
    if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < min || result[key] > max) throw new Error(`模拟参数 ${key} 无效`);
  }
  if (typeof result.fallbackEnabled !== 'boolean') throw new Error('兜底开关无效');
  if (!Number.isInteger(result.fallbackWindowSeconds) || result.fallbackEnabled && result.fallbackWindowSeconds >= result.windowSeconds) throw new Error('兜底入场秒数必须为整数且小于主策略入场秒数');
  if (!Number.isInteger(result.touchWindowSeconds)) throw new Error('触达窗口必须为整数秒');
  if (Math.abs(result.touchPrice * 100 - Math.round(result.touchPrice * 100)) > 1e-8) throw new Error('触达价格最多两位小数');
  if (!Number.isInteger(result.windowSeconds)) throw new Error('入场窗口必须为整数秒');
  if (!Number.isInteger(result.slippageBps) || !Number.isInteger(result.latencyMs)) throw new Error('滑点和延迟必须为整数');
  return Object.fromEntries(Object.keys(paperDefaults).map(key => [key, result[key]]));
}
export const paperFeeModel = 'PREDICT_FUN_TAKER_V1';
export function calculatePaperFee(fills, feeRateBps) {
  if (!Array.isArray(fills) || !fills.length || !Number.isFinite(feeRateBps) || feeRateBps < 0 || feeRateBps > 10000) throw new Error('手续费计算参数无效');
  return fills.reduce((sum, fill) => {
    if (!Number.isFinite(fill.price) || fill.price <= 0 || fill.price >= 1 || !Number.isFinite(fill.shares) || fill.shares <= 0) throw new Error('手续费成交档位无效');
    return sum + feeRateBps / 10000 * Math.min(fill.price, 1 - fill.price) * fill.shares;
  }, 0);
}
export function applyPaperFee(record) {
  if (record.vendor !== 'PREDICT_FUN') throw new Error('未支持该服务商手续费模型');
  record.fee = calculatePaperFee(record.fills, record.feeRateBps);
  record.totalCost = record.amount + record.fee;
  record.feeModel = paperFeeModel;
  if (record.status === 'SETTLED') record.pnl = record.payout - record.totalCost;
}
export function simulateFill(book, amount, priceCap) {
  const fail = (code, reason) => ({ filled: false, code, reason });
  if (book.tradingStatus !== 'OPEN') return fail('MARKET_CLOSED', '市场已停止接受交易');
  const levels = (book.asks || []).map(l => ({ price: Number(l.price), size: Number(l.size) }))
    .filter(l => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0).sort((a, b) => a.price - b.price);
  if (!levels.length) return fail('NO_ASKS', '无可用卖盘，可能涨停或流动性枯竭');
  if (levels[0].price >= 1) return fail('PRICE_LIMIT', '报价达到 1，涨停方向无法买入');
  if (levels[0].price > priceCap) return fail('PRICE_CAP', '执行时价格超过最高买入价或滑点容忍');
  let remaining = amount, shares = 0; const fills = [];
  for (const level of levels) {
    if (level.price > priceCap || level.price >= 1) break;
    const cost = Math.min(remaining, level.price * level.size);
    if (cost <= 0) continue;
    const qty = cost / level.price; shares += qty; remaining -= cost;
    fills.push({ price: level.price, shares: qty, cost });
    if (remaining < 1e-8) break;
  }
  if (remaining > 1e-8) return fail('INSUFFICIENT_DEPTH', '价格上限内卖盘不足，FOK 模拟订单整笔未成交');
  return { filled: true, shares, averagePrice: Number((amount / shares).toPrecision(15)), fills };
}
export function officialSettlement(topic, record) {
  if (String(topic.marketTopicId) !== record.marketTopicId || Number(topic.endDate) !== record.endDate) throw new Error('结算响应场次不匹配');
  const endPrice = Number(topic.variantData?.endPrice);
  const startPrice = Number(topic.variantData?.startPrice);
  if (topic.status !== 'RESOLVED' || topic.variantData?.endPrice == null || !Number.isFinite(endPrice) || endPrice <= 0) return null;
  if (!Number.isFinite(startPrice) || startPrice !== record.targetPrice) throw new Error('官方目标价变化，等待人工核对');
  const result = endPrice > startPrice ? 'UP' : endPrice < startPrice ? 'DOWN' : 'DRAW';
  const winners = (topic.markets || []).flatMap(m => (m.outcomes || []).filter(o => o.winner === true).map(o => String(o.name).toUpperCase())).filter(n => ['UP', 'DOWN'].includes(n));
  if (result !== 'DRAW' && winners.length && !winners.includes(result)) throw new Error('官方价格和胜负标志冲突，等待核对');
  return { result, endPrice, payoutPerShare: result === 'DRAW' ? .5 : result === record.direction ? 1 : 0, source: 'BINANCE_PREDICTION_API', priceFeedProvider: topic.variantData.priceFeedProvider };
}
export function paperStats(records) {
  const settled = records.filter(r => r.status === 'SETTLED');
  const filled = records.filter(r => ['FILLED', 'SETTLED'].includes(r.status));
  const attempts = records.filter(r => r.status !== 'SKIPPED');
  const completeAttempts = attempts.filter(r => r.status !== 'PENDING');
  const wins = settled.filter(r => r.result === r.direction).length;
  return { total: records.length, attempts: attempts.length, filled: filled.length, pending: records.filter(r => ['PENDING', 'FILLED'].includes(r.status)).length,
    failures: records.filter(r => r.status === 'FAILED').length, skipped: records.filter(r => r.status === 'SKIPPED').length,
    settled: settled.length, wins, losses: settled.filter(r => r.result !== 'DRAW' && r.result !== r.direction).length,
    draws: settled.filter(r => r.result === 'DRAW').length,
    winRate: settled.length ? wins / settled.length : null,
    fillRate: completeAttempts.length ? filled.length / completeAttempts.length : null,
    profitable: settled.filter(r => r.pnl > 1e-8).length, losing: settled.filter(r => r.pnl < -1e-8).length,
    breakeven: settled.filter(r => Math.abs(r.pnl) <= 1e-8).length,
    profitAmount: settled.filter(r => r.pnl > 0).reduce((sum, r) => sum + r.pnl, 0),
    lossAmount: settled.filter(r => r.pnl < 0).reduce((sum, r) => sum - r.pnl, 0),
    netPnl: settled.reduce((sum, r) => sum + r.pnl, 0),
    totalCost: filled.reduce((sum, r) => sum + r.totalCost, 0) };
}

export class PaperTrading {
  constructor({ store, client, getSnapshot, getError, now, maxDataAge = 5000, logger = console.info }) {
    this.logger = logger; this.store = store; this.client = client; this.getSnapshot = getSnapshot; this.getError = getError; this.now = now; this.maxDataAge = maxDataAge;
    if (!store.state.paper) store.state.paper = { enabled: true, settings: paperDefaults, records: [] };
    if (!Array.isArray(store.state.paper.records)) throw new Error('模拟交易记录无效，停止启动');
    store.state.paper.settings = validatePaperSettings(store.state.paper.settings);
    for (const record of store.state.paper.records) {
      if (!['FILLED', 'SETTLED'].includes(record.status) || record.feeModel === paperFeeModel) continue;
      record.previousFeeCalculation = { fee: record.fee, totalCost: record.totalCost, pnl: record.pnl, feeModel: record.feeModel };
      applyPaperFee(record);
      record.feeCorrectedAt = this.now(); delete record.archiveVersion;
      for (const event of record.consoleEvents || []) if (event.phase === '本期结果') Object.assign(event, {
        盈利金额USDT: Math.max(0, record.pnl ?? 0), 亏损金额USDT: Math.max(0, -(record.pnl ?? 0)),
        净盈亏USDT: record.pnl ?? 0, 估算费用USDT: record.fee, 手续费模型: paperFeeModel });
    }

    store.state.paper.windows ||= [];
    this.busy = false; this.error = null; this.lastEvent = `等待当前场次最后 ${this.data.settings.strategyMode === 'TOUCH_LIMIT' ? this.data.settings.touchWindowSeconds : this.data.settings.windowSeconds} 秒`; this.nextSettlementCheck = new Map();
  }
  get data() { return this.store.state.paper; }
  publicState() { return { enabled: this.data.enabled, settings: this.data.settings, stats: paperStats(this.data.records),
    records: [...this.data.records].reverse().slice(0, 300), windowEvents: this.data.windows.slice(-300).flatMap(w => (w.consoleEvents || []).map(e => ({ ...e, id: w.id }))), error: this.error, lastEvent: this.lastEvent,
    directory: 'data/paper-trades/', file: 'data/state.json', windowSeconds: this.data.settings.strategyMode === 'TOUCH_LIMIT' ? this.data.settings.touchWindowSeconds : this.data.settings.windowSeconds, priceBasis: '当前参考价（币安现货），非 Chainlink 同源价', feeModel: '官方 Taker：逐档费率 × min(价格, 1−价格) × 份额；无优惠，未计网络费' }; }
  logEvent(record, phase) {
    record.consoleEvents ||= [];
    if (record.consoleEvents.some(event => event.phase === phase)) return;
    const pnl = record.pnl ?? 0;
    const event = { phase, 场次: record.marketTopicId,
      时间: new Date(this.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
      时间戳: this.now(), 判断时间: record.createdAt, 买入时间: record.executedAt ?? null,
      本期结束时间: record.endDate, 结算时间: record.settledAt ?? null, 方向: record.direction === 'UP' ? '买涨' : record.direction === 'DOWN' ? '买跌' : '跳过',
      下注金额USDT: record.amount, 当前参考价格: record.decisionPrice, 目标价格: record.targetPrice,
      买入价格: record.averagePrice ?? record.decisionAsk ?? null,
      价格类型: record.averagePrice !== undefined ? '模拟成交均价' : '判断时卖一报价（未成交）',
      状态: record.status, 原因: record.reason, 价差USD: record.deltaUsd, 当前设置: record.settings,
      剩余秒数: record.remainingSeconds, 是否兜底: record.strategyType === 'FALLBACK' || phase === '兜底入场窗口', 触发策略: record.strategyType ?? null, 挂单限价: record.limitPrice ?? null, 触发卖一价: record.triggerAsk ?? null };
    if (phase === '本期结果') Object.assign(event, {
      操作结果: record.status === 'SETTLED' ? (record.result === 'DRAW' ? '平局' : record.result === record.direction ? '成功' : '失败') : record.status === 'FAILED' ? '失败（未成交）' : '跳过',
      官方方向: record.result ?? null, 官方最终价格: record.finalPrice ?? null,
      盈利金额USDT: Math.max(0, pnl), 亏损金额USDT: Math.max(0, -pnl), 净盈亏USDT: pnl,
      估算费用USDT: record.fee ?? 0, 成交份额: record.shares ?? 0 });
    record.consoleEvents.push(event);
    this.logger(`[模拟交易][${phase}]`, event);
  }
  async reset() {
    if (this.resetting) throw new Error('模拟交易正在归零，请稍候');
    this.resetting = true;
    try {
      // 等待正在执行的tick结束，防止旧盘口响应或结算重新写入已清除的记录。
      while (this.busy) await new Promise(resolve => setTimeout(resolve, 20));
      this.data.resetBeforeEndDate = this.getSnapshot()?.endDate ?? this.now();
      this.data.records = []; this.data.windows = []; this.nextSettlementCheck.clear();
      this.data.resetAt = this.now(); this.error = null;
      await this.store.save(); await this.store.clearPaperArchives();
      this.lastEvent = '模拟记录与统计已归零，当前场次不再交易';
      this.logger('[模拟交易][归零]', { 时间戳: this.data.resetAt, 保留设置: this.data.settings, 运行状态: this.data.enabled });
      return this.publicState();
    } finally { this.resetting = false; }
  }
  async configure(input) {
    if (this.resetting) throw new Error('模拟交易正在归零，请稍候');
    if (typeof input.enabled !== 'boolean') throw new Error('模拟交易开关无效');
    const settings = validatePaperSettings(input.settings || this.data.settings);
    this.data.enabled = input.enabled; this.data.settings = settings;
    if (!input.enabled) {
      for (const r of this.data.records.filter(r => r.status === 'PENDING')) { r.status = 'FAILED'; r.failureCode = 'STOPPED'; r.reason = '执行前已停止模拟交易'; }
    }
    await this.store.save();
    this.lastEvent = input.enabled ? `模拟交易已启动，等待最后 ${settings.strategyMode === 'TOUCH_LIMIT' ? settings.touchWindowSeconds : settings.windowSeconds} 秒` : '模拟交易已停止，已有成交仍会等待官方结算';
    return this.publicState();
  }
  async tick() {
    if (this.busy || this.resetting) return; this.busy = true;
    try {
      await this.finishPending();
      if (this.data.enabled) await this.considerEntry();
      await this.settleAndArchive();
      this.error = null;
    } catch (error) { this.error = error.message; this.lastEvent = `模拟流程受阻：${error.message}`; }
    finally { this.busy = false; }
  }
  async considerEntry() {
    const s = this.getSnapshot(), now = this.now();
    if (!s || s.endDate <= (this.data.resetBeforeEndDate || 0)) return;
    if (this.data.settings.strategyMode === 'TOUCH_LIMIT') return this.considerTouchLimit(s, now);
    const remaining = s.endDate - now;
    const settings = { ...this.data.settings };
    if (remaining <= 1000 || remaining > settings.windowSeconds * 1000 || this.data.records.some(r => r.marketTopicId === s.id)) return;
    let watch = this.data.windows.find(w => w.marketTopicId === s.id);
    if (!watch) { watch = { id: randomUUID(), marketTopicId: s.id, createdAt: now, endDate: s.endDate, status: 'OBSERVING', consoleEvents: [] }; this.data.windows.push(watch); }
    Object.assign(watch, { title: s.title, startDate: s.startDate, remainingSeconds: remaining / 1000, targetPrice: s.targetPrice,
      decisionPrice: s.price, deltaUsd: s.price - s.targetPrice, settings, amount: settings.amount });
    const valid = s.bookSource === 'BINANCE_PREDICTION_API' && s.targetPriceSource === 'BINANCE_PREDICTION_API' && !this.getError() && now - s.updatedAt <= this.maxDataAge && now - s.priceUpdatedAt <= this.maxDataAge && Number.isFinite(s.price) && Number.isFinite(s.targetPrice);
    const mainMatches = valid && watch.deltaUsd !== 0 && Math.abs(watch.deltaUsd) >= settings.minDeltaUsd;
    const fallbackWindow = settings.fallbackEnabled && remaining <= settings.fallbackWindowSeconds * 1000;
    const fallbackMatches = valid && fallbackWindow && watch.deltaUsd !== 0 && Math.abs(watch.deltaUsd) >= settings.fallbackMinDeltaUsd;
    const auditWindow = async (phase, matches) => {
      if (watch.consoleEvents.some(e => e.phase === phase)) return;
      watch.reason = !valid ? '行情无效，不能买入' : matches ? '价差满足入场条件，将检查买入盘口' : '价差未达标或价格相等，继续等待';
      this.logEvent(watch, phase); await this.store.save();
    };
    await auditWindow('主策略入场窗口', mainMatches);
    if (fallbackWindow && !mainMatches) await auditWindow('兜底入场窗口', fallbackMatches);
    if (valid && !mainMatches && !fallbackMatches) {
      this.lastEvent = `主策略价差未满足${fallbackWindow ? '，兜底价差也未满足' : ''}，继续等待；当前价差 ${watch.deltaUsd.toFixed(4)} USD`;
      return;
    }
    const strategyType = mainMatches ? 'PRIMARY' : fallbackMatches ? 'FALLBACK' : 'NONE';
    const record = { id: randomUUID(), marketTopicId: s.id, title: s.title, startDate: s.startDate, endDate: s.endDate,
      createdAt: now, remainingSeconds: remaining / 1000, targetPrice: s.targetPrice, decisionPrice: s.price,
      deltaUsd: s.price - s.targetPrice, decisionPriceSource: s.priceSource, settlementPriceSource: s.settlementPriceSource,
      priceSourceMatchesSettlement: s.priceVerified, strategyType, settings, amount: settings.amount, feeRateBps: s.feeRateBps, status: 'PENDING',
      executeAt: now + settings.latencyMs, mode: 'PAPER', reason: '根据当前参考价相对目标价判断，等待模拟执行延迟' };
    if (!valid) {
      record.status = 'SKIPPED'; record.reason = '行情过期、缺失或接口异常，跳过本期';
    } else if (record.deltaUsd === 0) { record.status = 'SKIPPED'; record.reason = '当前参考价等于目标价，方向不明确'; }
    else {
      record.direction = record.deltaUsd > 0 ? 'UP' : 'DOWN';
      const outcome = s.outcomes[record.direction];
      record.tokenId = outcome?.tokenId; record.outcomeMarketId = outcome?.marketId; record.vendor = s.vendor;
      record.decisionAsk = outcome?.ask; record.decisionBookAt = outcome?.bookAt;
      if (!Number.isFinite(outcome?.ask) || outcome.ask <= 0) { record.status = 'FAILED'; record.failureCode = 'NO_ASKS'; record.reason = '判断方向无卖盘，可能涨停，模拟买入失败'; }
      else if (outcome.ask >= 1 || outcome.ask > settings.maxPrice) { record.status = 'FAILED'; record.failureCode = 'PRICE_CAP'; record.reason = '方向报价涨停或高于买入上限，模拟买入失败'; }
      else if (!Number.isFinite(record.feeRateBps) || record.feeRateBps < 0 || record.feeRateBps > 10000) { record.status = 'SKIPPED'; record.reason = '市场费率缺失，无法计算模拟收益'; }
    }
    this.data.records.push(record);
    this.logEvent(record, '买入判断');
    // 下次 tick 才执行。落盘失败则保留失败记录，禁止形成未保存成交。
    try { await this.store.save(); }
    catch (error) { record.status = 'FAILED'; record.failureCode = 'PERSISTENCE'; record.reason = '决策记录保存失败，未模拟成交'; throw error; }
    this.lastEvent = `${record.direction === 'UP' ? '买涨' : record.direction === 'DOWN' ? '买跌' : '跳过'}：${record.reason}`;
  }
  async considerTouchLimit(s, now) {
    const remaining = s.endDate - now;
    if (remaining <= 1000 || remaining > this.data.settings.touchWindowSeconds * 1000 || this.data.records.some(r => r.marketTopicId === s.id)) return;
    const settings = { ...this.data.settings, windowSeconds: this.data.settings.touchWindowSeconds, minDeltaUsd: 0, fallbackEnabled: false, maxPrice: this.data.settings.touchPrice, slippageBps: 0 };
    let watch = this.data.windows.find(w => w.marketTopicId === s.id);
    if (!watch) { watch = { id: randomUUID(), marketTopicId: s.id, createdAt: now, endDate: s.endDate, status: 'OBSERVING', consoleEvents: [] }; this.data.windows.push(watch); }
    Object.assign(watch, { title: s.title, startDate: s.startDate, remainingSeconds: remaining / 1000, targetPrice: s.targetPrice,
      decisionPrice: s.price, deltaUsd: s.price - s.targetPrice, settings, amount: settings.amount });
    if (!watch.consoleEvents.some(e => e.phase === '限时触达入场窗口')) {
      watch.reason = `进入最后${settings.touchWindowSeconds}秒，等待涨或跌方向有效卖一价达到${settings.touchPrice}`;
      this.logEvent(watch, '限时触达入场窗口'); await this.store.save();
    }
    if (s.bookSource !== 'BINANCE_PREDICTION_API' || s.targetPriceSource !== 'BINANCE_PREDICTION_API' || this.getError() || now - s.updatedAt > this.maxDataAge) return;
    const directions = ['UP', 'DOWN'].filter(direction => {
      const o = s.outcomes[direction]; return o?.tradingStatus === 'OPEN' && Number.isFinite(o.ask) && o.ask >= settings.touchPrice && o.ask < 1 && now - o.bookAt <= this.maxDataAge;
    });
    if (directions.length !== 1) { this.lastEvent = directions.length === 2 ? `两方向同时达到${settings.touchPrice}，盘口冲突，等待` : `等待有效卖一价达到${settings.touchPrice}`; return; }
    const direction = directions[0], outcome = s.outcomes[direction];
    if (!Number.isFinite(s.feeRateBps) || s.feeRateBps < 0 || s.feeRateBps > 10000) return;
    const record = { ...watch, id: randomUUID(), createdAt: now, direction, strategyType: 'TOUCH_LIMIT', orderType: 'LIMIT', limitPrice: settings.touchPrice,
      triggerPrice: settings.touchPrice, triggerAsk: outcome.ask, tokenId: outcome.tokenId, outcomeMarketId: outcome.marketId, vendor: s.vendor,
      decisionAsk: outcome.ask, decisionBookAt: outcome.bookAt, feeRateBps: s.feeRateBps, status: 'PENDING', mode: 'PAPER',
      executeAt: now + settings.latencyMs, placedAt: now, consoleEvents: [], reason: `卖一价达到${settings.touchPrice}，已挂限价${settings.touchPrice}模拟买单，等待整笔成交` };
    this.data.records.push(record); this.logEvent(record, '模拟挂单');
    try { await this.store.save(); }
    catch (error) { record.status = 'FAILED'; record.failureCode = 'PERSISTENCE'; record.reason = '挂单保存失败，未模拟成交'; throw error; }
    this.lastEvent = `${direction === 'UP' ? '买涨' : '买跌'}：${record.reason}`;
  }
  async finishLimit(record) {
    const now = this.now();
    if (now < record.executeAt || now < (record.nextBookCheckAt || 0)) return;
    const fail = (code, reason) => { record.status = 'FAILED'; record.failureCode = code; record.reason = reason; record.cancelledAt = this.now(); };
    const snapshot = this.getSnapshot();
    if (!this.data.enabled) fail('STOPPED', '模拟已停止，限价挂单已撤销');
    else if (now >= record.endDate - 1000 || snapshot?.id !== record.marketTopicId) fail('EXPIRED', '限价挂单到期或场次切换，未成交并撤销');
    else {
      record.nextBookCheckAt = now + 1000;
      try {
        const raw = await this.client.book({ vendor: record.vendor }, { marketId: record.outcomeMarketId, tokenId: record.tokenId });
        const doneAt = this.now();
        if (!this.data.enabled || record.status !== 'PENDING') fail('STOPPED', '查询期间模拟停止，挂单已撤销');
        else if (doneAt >= record.endDate - 1000 || this.getSnapshot()?.id !== record.marketTopicId) fail('EXPIRED', '盘口返回时挂单已到期，未成交');
        else if (String(raw.tokenId) !== record.tokenId || !Number.isFinite(Number(raw.timestamp)) || Math.abs(doneAt - Number(raw.timestamp)) > this.maxDataAge) record.reason = '盘口过期或方向不匹配，挂单继续等待';
        else {
          const fill = simulateFill({ asks: raw.asks, tradingStatus: this.getSnapshot()?.outcomes[record.direction]?.tradingStatus }, record.amount, record.limitPrice);
          record.executionPriceCap = record.limitPrice; record.executionBookAt = Number(raw.timestamp); record.executionAsks = (raw.asks || []).slice(0, 20);
          if (fill.filled) {
            Object.assign(record, { status: 'FILLED', executedAt: doneAt, shares: fill.shares, averagePrice: fill.averagePrice, fills: fill.fills,
              reason: `限价${record.limitPrice}模拟整笔成交，等待官方结算；费用保守按Taker估算` });
            applyPaperFee(record); record.feeAssumption = '盘口穿价模拟，未模拟Maker排队，费用保守按Taker估算';
          } else if (fill.code === 'MARKET_CLOSED') fail('MARKET_CLOSED', '市场关闭，挂单未成交并撤销');
          else record.reason = `限价${record.limitPrice}挂单等待：${fill.reason}`;
        }
      } catch (error) { record.reason = `盘口查询失败，挂单继续等待：${error.message}`; }
    }
    if (record.status !== 'PENDING') this.logEvent(record, record.status === 'FILLED' ? '买入执行' : '挂单撤销');
    await this.store.save(); this.lastEvent = record.reason;
  }
  async finishPending() {
    for (const r of this.data.records.filter(r => r.status === 'PENDING')) {
      if (r.strategyType === 'TOUCH_LIMIT') { await this.finishLimit(r); continue; }
      const now = this.now(); if (now < r.executeAt) continue;
      const fail = (code, reason) => { r.status = 'FAILED'; r.failureCode = code; r.reason = reason; r.executedAt = this.now(); };
      const s = this.getSnapshot();
      if (!this.data.enabled) fail('STOPPED', '模拟交易已停止');
      else if (now >= r.endDate - 1000 || s?.id !== r.marketTopicId) fail('EXPIRED', '执行时场次已切换或进入最后 1 秒，未成交');
      else if (this.getError() || now - s.priceUpdatedAt > this.maxDataAge) fail('STALE_DATA', '执行时行情已过期或接口异常');
      else {
        try {
          // 只重新查询卖盘，不调用 quote / place / wallet。
          const raw = await this.client.book({ vendor: r.vendor }, { marketId: r.outcomeMarketId, tokenId: r.tokenId });
          const doneAt = this.now();
          if (!this.data.enabled || r.status !== 'PENDING') fail('STOPPED', '盘口请求期间模拟交易已停止');
          else if (doneAt >= r.endDate - 1000 || this.getSnapshot()?.id !== r.marketTopicId) fail('EXPIRED', '盘口返回时已经超过本期执行截止时间');
          else if (String(raw.tokenId) !== r.tokenId || !Number.isFinite(Number(raw.timestamp)) || Math.abs(doneAt - Number(raw.timestamp)) > this.maxDataAge) fail('STALE_BOOK', '执行盘口过期或方向不匹配');
          else {
            const cap = Math.min(r.settings.maxPrice, r.decisionAsk * (1 + r.settings.slippageBps / 10000));
            const fill = simulateFill({ asks: raw.asks, tradingStatus: s.outcomes[r.direction].tradingStatus }, r.settings.amount, cap);
            r.executionBookAt = Number(raw.timestamp); r.executionPriceCap = cap; r.executionAsks = raw.asks.slice(0, 20);
            if (!fill.filled) fail(fill.code, fill.reason);
            else {
              r.status = 'FILLED'; r.executedAt = doneAt; r.shares = fill.shares; r.averagePrice = fill.averagePrice;
              r.fills = fill.fills; r.amount = r.settings.amount; applyPaperFee(r);
              r.reason = 'FOK 盘口模拟整笔成交，等待官方结算';
            }
          }
        } catch (error) { fail('BOOK_REQUEST_FAILED', `执行盘口查询失败：${error.message}`); }
      }
      this.logEvent(r, '买入执行');
      await this.store.save(); this.lastEvent = `${r.direction === 'UP' ? '买涨' : '买跌'}：${r.reason}`;
    }
  }
  async settleAndArchive() {
    for (const watch of this.data.windows.filter(w => w.endDate <= this.now() && !this.data.records.some(r => r.marketTopicId === w.marketTopicId))) {
      const record = { ...watch, status: 'SKIPPED', strategyType: 'NONE', mode: 'PAPER', consoleEvents: [],
        reason: watch.settings.strategyMode === 'TOUCH_LIMIT' ? `最后${watch.settings.touchWindowSeconds ?? 90}秒未出现单一方向有效卖一价达到${watch.settings.touchPrice ?? .98}，本期不挂单` : '入场窗口内主策略及已启用的兜底策略均未触发，本期不交易' };
      this.data.records.push(record); await this.store.save();
    }
    const ended = this.data.records.filter(r => r.endDate <= this.now());
    let checked = 0;
    for (const r of ended) {
      if (r.status === 'FILLED' && checked < 3 && this.now() >= (this.nextSettlementCheck.get(r.id) || 0)) {
        checked++; this.nextSettlementCheck.set(r.id, this.now() + 10000);
        try {
          const settlement = officialSettlement(await this.client.detail(r.marketTopicId), r);
          if (settlement) {
            Object.assign(r, { status: 'SETTLED', result: settlement.result, finalPrice: settlement.endPrice,
              payout: r.shares * settlement.payoutPerShare, settledAt: this.now(), settlementSource: settlement.source,
              reason: '已按官方 endPrice 与结算结果完成模拟结算', settlementError: null });
            r.pnl = r.payout - r.totalCost; await this.store.save();
            this.lastEvent = `场次 ${r.marketTopicId} 已结算，净盈亏 ${r.pnl.toFixed(4)} USDT`;
          }
        } catch (error) { r.settlementError = error.message; await this.store.save(); }
      }
      if (['SETTLED', 'FAILED', 'SKIPPED'].includes(r.status)) {
        this.logEvent(r, '本期结果');
      }
      const version = `${r.status}:${r.settledAt || 0}:${r.settlementError || ''}:${r.consoleEvents?.length || 0}`;
      if (r.archiveVersion !== version) {
        await this.store.archivePaper(r);
        r.archiveVersion = version; r.archivedAt = this.now(); await this.store.save();
      }
    }
  }
}
