import { randomUUID } from 'node:crypto';
import { BinanceClient, isBtcFiveMinute, mapOutcomes, toWei, fromWei } from './binance.mjs';
import { defaultStrategy, validateStrategy, evaluateStrategy, decisionState } from './strategy.mjs';
import { runCustom, runJev } from './deciders.mjs';
import { PaperTrading } from './paper.mjs';

const occupied = o => !['FAILED', 'REJECTED'].includes(o.status);
const day = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
export class Engine {
  constructor(config, store, client = new BinanceClient(config)) {
    this.config = config; this.store = store; this.client = client;
    this.snapshot = null; this.history = []; this.error = null; this.account = null; this.accountAt = 0;
    this.strategy = validateStrategy(store.state.strategy || defaultStrategy);
    this.auto = false; this.busy = false; this.refreshBusy = false;
    this.quotes = new Map(); this.decision = { action: 'SKIP', reason: '自动交易已关闭' };
    this.scenario = null; this.lastDecisionAt = 0;
    this.strategyRevision = 0; this.autoRevision = 0;
    this.btc = null; this.btcError = null;
    this.prediction = null; this.targetError = null;
    this.accountError = null; this.accountAttemptAt = 0;
    this.paper = new PaperTrading({ store, client: this.client, getSnapshot: () => this.snapshot?.referenceOnly ? null : this.snapshot, getError: () => this.btcError || this.error,
      now: () => this.now(), maxDataAge: config.maxDataAge });
  }
  now() { return this.config.mode === 'live' ? this.client.now() : Date.now(); }
  risk() {
    const orders = this.store.state.orders.filter(o => o.mode === this.config.mode && occupied(o));
    return { maxDataAge: this.config.maxDataAge, maxDaily: this.config.maxDaily, maxOrder: this.config.maxOrder,
      dailySpent: orders.filter(o => day(o.createdAt) === day(this.now())).reduce((sum, o) => sum + o.reservedAmount, 0),
      roundCount: Math.max(orders.filter(o => o.marketId === this.snapshot?.id).length,
        this.config.mode === 'live' ? (this.account?.positions || []).filter(p => String(p.marketTopicId) === this.snapshot?.id && Number(p.shares) > 0).length : 0),
      unresolvedOrders: orders.filter(o => ['UNKNOWN', 'SUBMITTING'].includes(o.status)).length };
  }
  publicState() {
    return { mode: this.config.mode, btcPriceMode: this.config.btcPriceMode, btc: this.btc, btcError: this.btcError,
      targetStatus: { connected: !!this.prediction, error: this.targetError, source: this.prediction ? 'BINANCE_PREDICTION_API' : null },
      now: this.now(), snapshot: this.snapshot, error: this.btcError ? `真实 BTC 行情获取失败：${this.btcError}；保留上次价格，不切换模拟数据` : this.error, paper: this.paper.publicState(),
      account: this.account, accountAt: this.accountAt, accountError: this.accountError, strategy: this.strategy, auto: this.auto,
      busy: this.busy, decision: this.decision, risk: this.risk(),
      orders: this.store.state.orders.filter(o => o.mode === this.config.mode).slice(-100).reverse(),
      connection: { credentials: !!(this.config.apiKey && this.config.apiSecret), liveEnabled: this.config.liveEnabled,
        rulesVerified: this.config.rulesVerified, priceSource: this.config.priceSource, fundingSource: this.config.fundingSource,
        accountType: this.config.accountType, walletConfigured: !!(this.config.walletAddress && this.config.walletId) }
    };
  }
  async refreshBtc() {
    if (this.btcRefreshPromise) return this.btcRefreshPromise;
    this.btcRefreshPromise = (async () => {
      try {
        this.btc = await this.client.spot(); this.btcError = null;
        if (this.config.mode === 'live' && !this.prediction) this.refreshReferenceSnapshot();
        else if (this.snapshot) {
          this.snapshot.price = this.btc.price; this.snapshot.priceUpdatedAt = this.btc.receivedAt;
          if (this.history.at(-1)?.at !== this.btc.receivedAt) this.history.push({ at: this.btc.receivedAt, price: this.btc.price });
          this.history = this.history.filter(point => point.at >= this.now() - 300000);
          this.snapshot.history = this.history;
        }
        return true;
      } catch (error) { this.btcError = error.message; return false; }
    })().finally(() => { this.btcRefreshPromise = null; });
    return this.btcRefreshPromise;
  }
  async refresh() {
    if (this.refreshBusy) return;
    this.refreshBusy = true;
    try {
      if (this.config.btcPriceMode === 'live' || this.config.mode === 'live') {
        if (!await this.refreshBtc()) throw new Error(`真实 BTC 行情获取失败：${this.btcError}；保留上次价格，不切换模拟数据`);
      }
      if (this.config.mode === 'demo') {
        if (this.config.btcPriceMode === 'live') {
          try { this.prediction = await this.currentPredictionTopic(); this.targetError = null; }
          catch (error) { this.prediction = null; this.targetError = error.message; this.auto = false; }
        }
        this.refreshDemo();
      }
      else await this.refreshLive();
      this.error = null;
    } catch (error) {
      this.error = error.message;
      if (this.config.btcPriceMode === 'live' || this.config.mode === 'live') {
        this.prediction = null; this.targetError = error.message;
        if (this.snapshot) { this.snapshot.targetPrice = null; this.snapshot.targetPriceSource = null; }
        if (this.config.mode === 'live' && this.btc) this.refreshReferenceSnapshot();
        this.auto = false;
      }
    }
    finally { this.refreshBusy = false; }
  }
  refreshReferenceSnapshot() {
    const now = this.now(), spot = this.btc;
    const start = Math.floor(now / 300000) * 300000;
    if (this.snapshot?.startDate !== start) this.history = [];
    if (this.history.at(-1)?.at !== spot.receivedAt) this.history.push({ at: spot.receivedAt, price: spot.price });
    this.history = this.history.filter(point => point.at >= start);
    const closed = direction => ({ direction, tradingStatus: 'CLOSED', ask: null, bid: null, price: null, asks: [], bids: [], bookAt: 0 });
    this.snapshot = { id: `reference-${start}`, referenceOnly: true, title: 'BTC 5分钟内涨或跌', startDate: start, endDate: start + 300000,
      targetPrice: null, targetPriceSource: null, price: spot.price, priceUpdatedAt: spot.receivedAt,
      priceSource: 'BINANCE_SPOT（参考行情）', priceVerified: false, updatedAt: spot.receivedAt, history: this.history,
      rules: '仅展示真实BTC参考行情；官方预测场次未连接，盘口和交易暂停。', outcomes: { UP: closed('UP'), DOWN: closed('DOWN') } };
  }
  refreshDemo() {
    const now = this.now();
    const start = this.prediction ? Number(this.prediction.startDate) : this.scenario?.start ?? Math.floor(now / 300000) * 300000;
    const end = start + 300000;
    if (this.scenario && now >= end) this.scenario = null;
    const realBtc = this.config.btcPriceMode === 'live';
    if (realBtc && !this.btc) throw new Error('等待真实 BTC 行情，未生成模拟价格');
    const target = realBtc ? (this.prediction ? Number(this.prediction.variantData.startPrice) : null) : 83909.30;
    const price = realBtc ? this.btc.price : target + (this.scenario?.delta ?? Math.sin((now - start) / 24000) * 65 + Math.cos((now - start) / 9000) * 12);
    const priceAt = realBtc ? this.btc.receivedAt : now;
    const hasTarget = Number.isFinite(target) && target > 0;
    const up = hasTarget ? Math.min(.94, Math.max(.06, .5 + (price - target) / 180)) : null;
    const outcome = (direction, p) => !hasTarget ? ({ direction, tokenId: `demo-${direction}`, marketId: `demo-${direction}`, tradingStatus: 'CLOSED', price: null, ask: null, bid: null, asks: [], bids: [], bookAt: 0 }) : ({ direction, tokenId: `demo-${direction}`, marketId: `demo-${direction}`,
      tradingStatus: now < end ? 'OPEN' : 'CLOSED', price: p, ask: Math.min(.99, p + .01), bid: Math.max(.01, p - .01),
      bookAt: now, asks: Array.from({ length: 5 }, (_, i) => ({ price: Math.min(.99, p + .01 + i * .01), size: 1000 + i * 230 })),
      bids: Array.from({ length: 5 }, (_, i) => ({ price: Math.max(.01, p - .01 - i * .01), size: 1100 + i * 270 })) });
    if (this.snapshot && this.snapshot.id !== `demo-${start}`) { this.settleDemo(this.snapshot); this.history = []; }
    if (this.history.at(-1)?.at !== priceAt) this.history.push({ at: priceAt, price });
    this.history = this.history.filter(p => p.at >= now - 300000);
    this.snapshot = { id: `demo-${start}`, title: 'BTC 5分钟内涨或跌', startDate: start, endDate: end, targetPrice: target,
      price, updatedAt: now, priceUpdatedAt: priceAt, priceSource: realBtc ? 'BINANCE_SPOT' : 'DEMO', priceVerified: !realBtc, feeRateBps: 200,
      marketTopicId: this.prediction?.marketTopicId ?? null, targetPriceSource: this.prediction ? 'BINANCE_PREDICTION_API' : realBtc ? null : 'DEMO',
      rules: realBtc ? this.prediction ? `${this.prediction.description || '目标价来自当前场次 variantData.startPrice。'} 当前为模拟交易模式，盘口与交易为模拟。` : '真实预测场次未连接，目标价不可用；BTC 现货价格正常展示，交易和价差策略暂停。' : '演示：结束时参考价 ≥ 目标价则涨胜，否则跌胜；费用 2%。仅用于功能验证，不代表真实产品规则或收益。',
      outcomes: { UP: outcome('UP', up), DOWN: outcome('DOWN', up === null ? null : 1 - up) }, history: this.history };
    const balance = 1000 - this.store.state.orders.filter(o => o.mode === 'demo' && occupied(o)).reduce((a, o) => a + o.reservedAmount - (o.payout || 0), 0);
    this.account = { summary: { walletBalance: balance.toFixed(2) }, positions: this.store.state.orders.filter(o => o.mode === 'demo' && o.status === 'FILLED').map(o => ({ marketTopicTitle: o.marketTitle, marketTitle: o.direction, shares: o.shares, totalCost: o.reservedAmount, positionStatus: 'OPEN' })) };
    this.accountAt = now;
  }
  settleDemo(previous) {
    if (!Number.isFinite(previous.targetPrice)) return;
    const winner = previous.price >= previous.targetPrice ? 'UP' : 'DOWN';
    let changed = false;
    for (const order of this.store.state.orders) {
      if (order.mode === 'demo' && order.marketId === previous.id && order.status === 'FILLED') {
        order.status = 'SETTLED'; order.payout = order.direction === winner ? order.shares : 0;
        order.pnl = order.payout - order.reservedAmount; order.settlement = '演示：使用本期最后采样价格'; changed = true;
      }
    }
    if (changed) this.store.save().catch(() => { this.error = '模拟结算保存失败'; });
  }
  async wallet() {
    if (this.walletCache) return this.walletCache;
    const result = await this.client.wallets();
    const wallets = result.wallets || [];
    const selected = this.config.walletAddress ? wallets.find(w => w.walletAddress.toLowerCase() === this.config.walletAddress.toLowerCase()) : wallets.length === 1 ? wallets[0] : null;
    if (!selected) throw new Error('未找到唯一预测钱包，请配置 BINANCE_WALLET_ADDRESS');
    if (this.config.walletId && this.config.walletId !== selected.walletId) throw new Error('配置的钱包 ID 与账户不匹配');
    this.walletCache = selected; return selected;
  }
  async currentPredictionTopic() {
    if (!this.config.apiKey || !this.config.apiSecret) throw new Error('目标价未连接：官方预测市场接口需要 API Key / Secret，请在本地 .env 配置；无需开启真实下单');
    if (!this.timeAt || this.now() - this.timeAt > 60000) { await this.client.syncTime(); this.timeAt = this.now(); }
    let topic = this.rawTopic;
    if (!topic || topic.endDate <= this.now() || this.now() - this.discoveryAt > 15000) {
      const candidates = [];
      // 按结束时间分页，避免错误选到 BTC 一小时或尚未开始的场次。
      for (let offset = 0; offset < 1000; offset += 100) {
        const page = await this.client.markets(offset);
        const topics = page.marketTopics || [];
        candidates.push(...topics.filter(t => isBtcFiveMinute(t) && t.startDate <= this.now() && t.endDate > this.now()));
        if (candidates.length || !page.hasMore || topics.length === 0) break;
      }
      const found = candidates.sort((a, b) => a.endDate - b.endDate)[0];
      if (!found) throw new Error('API 未返回当前可用的 BTC 5分钟场次；不会以其他周期替代');
      topic = await this.client.detail(found.marketTopicId); this.discoveryAt = this.now();
    } else topic = await this.client.detail(topic.marketTopicId);
    if (!isBtcFiveMinute(topic)) throw new Error('场次不是 BTC 5分钟涨跌，已停止使用');
    if (topic.startDate > this.now() || topic.endDate <= this.now()) throw new Error('预测场次已过期或尚未开始');
    const target = Number(topic.variantData?.startPrice);
    if (!Number.isFinite(target) || target <= 0) throw new Error('官方场次目标价缺失，不使用现货或 K线价格替代');
    this.rawTopic = topic;
    return topic;
  }
  async refreshLive() {
    const topic = await this.currentPredictionTopic();
    this.prediction = topic; this.targetError = null;
    const mapped = mapOutcomes(topic);
    const fetched = await Promise.allSettled([this.client.book(topic, mapped.UP), this.client.book(topic, mapped.DOWN)]);
    for (const result of fetched) if (result.status === 'rejected') throw result.reason;
    const [up, down] = fetched.map(r => r.value);
    const spot = this.btc;
    const now = this.now();
    const normalizeBook = (outcome, book) => {
      const normalize = entries => (entries || []).map(e => ({ price: Number(e.price), size: Number(e.size) })).filter(e => Number.isFinite(e.price) && e.price > 0 && e.price < 1 && Number.isFinite(e.size) && e.size > 0);
      const asks = normalize(book.asks).sort((a, b) => a.price - b.price);
      const bids = normalize(book.bids).sort((a, b) => b.price - a.price);
      return { ...outcome, ask: asks[0]?.price ?? null, bid: bids[0]?.price ?? null, asks: asks.slice(0, 10), bids: bids.slice(0, 10), bookAt: Number(book.timestamp) || 0 };
    };
    if (this.snapshot?.id !== String(topic.marketTopicId)) this.history = [];
    this.history.push({ at: spot.receivedAt, price: spot.price }); this.history = this.history.filter(p => p.at >= now - 300000);
    this.rawTopic = topic;
    this.snapshot = { id: String(topic.marketTopicId), title: topic.title, startDate: Number(topic.startDate), endDate: Number(topic.endDate),
      targetPrice: Number(topic.variantData.startPrice), targetPriceSource: 'BINANCE_PREDICTION_API',
      settlementPriceSource: topic.variantData.priceFeedProvider || 'UNKNOWN', bookSource: 'BINANCE_PREDICTION_API', price: spot.price, priceUpdatedAt: spot.receivedAt,
      vendor: topic.vendor,
      updatedAt: Math.min(now, Number(up.timestamp) || 0, Number(down.timestamp) || 0),
      priceSource: 'BINANCE_SPOT（参考行情）', priceTimestampKind: spot.timestampKind,
      priceVerified: this.config.rulesVerified && this.config.priceSource === 'BINANCE_SPOT' && topic.variantData?.priceFeedProvider === 'BINANCE' && topic.variantData?.priceFeedSymbol === 'BTCUSDT',
      feeRateBps: Number(topic.feeRateBps), rules: topic.description || '', history: this.history,
      outcomes: { UP: normalizeBook(mapped.UP, up), DOWN: normalizeBook(mapped.DOWN, down) } };
    if (now - this.accountAttemptAt > (this.accountError ? 30000 : 10000)) {
      this.accountAttemptAt = now;
      try { await this.refreshAccount(); this.accountError = null; }
      catch (error) { this.accountError = error.message; }
    }
  }
  async refreshAccount() {
    const wallet = await this.wallet();
    const results = await Promise.allSettled([this.client.positions(wallet.walletAddress), this.allOrders(wallet.walletAddress)]);
    if (results[0].status === 'fulfilled') { this.account = results[0].value; this.accountAt = this.now(); }
    const errors = results.filter(r => r.status === 'rejected');
    if (errors.length) throw errors[0].reason;
    let changed = false;
    for (const local of this.store.state.orders.filter(o => o.mode === 'live' && o.orderId)) {
      const actual = results[1].value.find(o => String(o.orderId) === local.orderId);
      if (actual) { local.status = actual.status; local.filledAmount = actual.filledUsdtAmount; local.shares = Number(actual.filledShareQty); local.exchange = actual; changed = true; }
    }
    if (changed) await this.store.save();
  }
  async allOrders(address) {
    const orders = [];
    for (const history of [false, true]) {
      for (let offset = 0; offset < 1000; offset += 100) {
        const page = await this.client.orders(address, history, offset);
        orders.push(...(page.orders || []));
        if ((page.orders || []).length < 100 || orders.length >= Number(page.total) && !history) break;
      }
    }
    return orders;
  }
  assertTradable(direction, amount, maxPrice, maxPerRound = 1) {
    const snapshot = this.snapshot; const now = this.now(); const risk = this.risk();
    if (!snapshot || this.error) throw new Error(this.error || '行情尚未就绪');
    if (!Number.isFinite(snapshot.targetPrice)) throw new Error('真实目标价未连接，禁止依据替代价格交易');
    if (this.config.mode === 'live' && !this.config.liveEnabled) throw new Error('真实下单开关未启用；当前为只读接入');
    if (this.config.mode === 'live' && (!this.config.rulesVerified || !snapshot.priceVerified)) throw new Error('尚未验证当前产品规则和结算价格源，禁止真实下单');
    if (!['UP', 'DOWN'].includes(direction)) throw new Error('方向无效');
    toWei(amount);
    if (amount > risk.maxOrder || risk.dailySpent + amount > risk.maxDaily) throw new Error('超过单笔或当日交易额度');
    if (risk.unresolvedOrders) throw new Error('存在结果未知的真实订单，请先在币安核对，禁止重复交易');
    if (risk.roundCount >= maxPerRound) throw new Error('本期交易次数已达上限');
    if ((snapshot.endDate - now) / 1000 <= this.config.minRemaining || snapshot.startDate > now) throw new Error('场次不在允许下单时间内');
    if (now - snapshot.updatedAt > this.config.maxDataAge || now - snapshot.priceUpdatedAt > this.config.maxDataAge) throw new Error('行情已过期，请刷新');
    const outcome = snapshot.outcomes[direction];
    if (!outcome || outcome.tradingStatus !== 'OPEN') throw new Error('交易方向未开放');
    if (!Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice >= 1 || !outcome.ask || outcome.ask > maxPrice) throw new Error('盘口买入价格超过上限或无可用卖盘');
    return outcome;
  }
  async prepareQuote(input, maxPerRound = 1) {
    if (this.busy) throw new Error('正在处理交易，请勿重复操作');
    this.busy = true;
    try { return await this.prepareQuoteUnlocked(input, maxPerRound); } finally { this.busy = false; }
  }
  async prepareQuoteUnlocked(input, maxPerRound) {
    if (input.marketId !== this.snapshot?.id) throw new Error('场次已切换，请重新获取报价');
    const amount = Number(input.amount), maxPrice = Number(input.maxPrice);
    const orderType = input.orderType || 'MARKET';
    if (!['MARKET', 'LIMIT'].includes(orderType)) throw new Error('订单类型无效');
    const slippageBps = Number(input.slippageBps ?? 100);
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500) throw new Error('滑点须在 1～500 基点内');
    const priceLimit = orderType === 'LIMIT' ? Number(input.priceLimit) : null;
    if (orderType === 'LIMIT' && (!Number.isFinite(priceLimit) || priceLimit <= 0 || priceLimit > maxPrice)) throw new Error('限价须大于零且不超过价格上限');
    const outcome = this.assertTradable(input.direction, amount, maxPrice, maxPerRound);
    const snapshot = this.snapshot;
    const id = randomUUID(); let quote;
    if (this.config.mode === 'demo') {
      if (orderType === 'LIMIT' && priceLimit < outcome.ask) throw new Error('演示模式仅模拟立即成交的限价单，请将限价设为不低于当前卖一');
      const fee = amount * .02;
      quote = { quoteId: id, averagePrice: outcome.ask, feeAmount: toWei(fee.toFixed(6)), amountOut: toWei((amount / outcome.ask).toFixed(6)), minReceive: toWei((amount / outcome.ask).toFixed(6)), expireAt: this.now() + 10000, priceImpact: 0 };
    } else {
      const wallet = await this.wallet();
      quote = await this.client.quote({ walletAddress: wallet.walletAddress, tokenId: outcome.tokenId, side: 'BUY', amountIn: toWei(amount), orderType,
        slippageBps, ...(orderType === 'LIMIT' ? { priceLimit } : {}), chainId: this.rawTopic.chainId, feeRateBps: this.snapshot.feeRateBps, fundingSource: this.config.fundingSource });
      if (String(quote.tokenId) !== outcome.tokenId || quote.side !== 'BUY' || quote.walletAddress?.toLowerCase() !== wallet.walletAddress.toLowerCase() || quote.amountIn !== toWei(amount) || quote.orderType !== orderType) throw new Error('报价与请求不匹配，禁止交易');
    }
    if (this.snapshot?.id !== snapshot.id) throw new Error('报价期间场次已切换，报价作废');
    const fee = fromWei(quote.feeAmount), shares = fromWei(quote.amountOut), minShares = fromWei(quote.minReceive);
    if (!(shares > 0 && minShares > 0 && quote.averagePrice > 0 && Number.isFinite(Number(quote.expireAt))) || !quote.quoteId) throw new Error('报价返回不完整');
    const total = amount + fee;
    // 保守地把 feeAmount 额外计入成本，真实接入时核对费用口径。
    if (Number(quote.averagePrice) > maxPrice || total / minShares > maxPrice) throw new Error('含费用／最小接收份额后的价格超过上限');
    if (total > this.config.maxOrder || this.risk().dailySpent + total > this.config.maxDaily) throw new Error('含费用金额超过交易额度');
    if (this.config.mode === 'demo' && total > Number(this.account.summary.walletBalance)) throw new Error('演示余额不足');
    if (Number(quote.expireAt) <= this.now() + 500) throw new Error('报价已过期');
    for (const [key, value] of this.quotes) if (value.expireAt < this.now()) this.quotes.delete(key);
    const prepared = { id, marketId: this.snapshot.id, marketTitle: this.snapshot.title, direction: input.direction, amount, maxPrice,
      orderType, priceLimit, slippageBps, maxPerRound, quoteId: quote.quoteId, tokenId: outcome.tokenId, fee,
      total, shares, minShares, averagePrice: Number(quote.averagePrice), expireAt: Math.min(Number(quote.expireAt), this.now() + 10000), mode: this.config.mode };
    this.quotes.set(id, prepared); return prepared;
  }
  async submit(id, source = 'MANUAL') {
    if (this.busy) throw new Error('正在处理交易，请勿重复操作');
    this.busy = true;
    try {
      const previous = this.store.state.orders.find(o => o.requestId === id);
      if (previous) return previous;
      const quote = this.quotes.get(id);
      if (!quote || quote.expireAt <= this.now()) throw new Error('报价不存在或已过期，请重新报价');
      if (this.snapshot?.id !== quote.marketId) throw new Error('场次已切换，旧报价已失效');
      this.assertTradable(quote.direction, quote.total, quote.maxPrice, quote.maxPerRound);
      const record = { id: randomUUID(), requestId: id, marketId: quote.marketId, marketTitle: quote.marketTitle, direction: quote.direction,
        mode: this.config.mode, source, createdAt: this.now(), reservedAmount: quote.total, amount: quote.amount,
        fee: quote.fee, price: quote.averagePrice, orderType: quote.orderType, status: 'SUBMITTING' };
      // 请求前落盘；进程中断后仍保留占用额度，防止误重试。
      this.store.state.orders.push(record); await this.store.save(); this.quotes.delete(id);
      if (this.config.mode === 'demo') { record.status = 'FILLED'; record.shares = quote.shares; record.orderId = `paper-${record.id.slice(0, 8)}`; }
      else {
        try {
          const wallet = await this.wallet();
          const result = await this.client.place({ walletAddress: wallet.walletAddress, walletId: wallet.walletId, quoteId: quote.quoteId,
            timeInForce: quote.orderType === 'MARKET' ? 'FOK' : 'GTC', accountType: this.config.accountType,
            orderType: quote.orderType, slippageBps: quote.slippageBps, fundingSource: this.config.fundingSource,
            ...(quote.orderType === 'LIMIT' ? { priceLimit: quote.priceLimit } : {}) });
          if (!result.orderId) throw new Error('下单响应缺少订单 ID');
          record.orderId = String(result.orderId); record.status = 'SUBMITTED';
        } catch (error) {
          // 网络异常、上游拒绝也不自动重试。人工核对后通过专用接口解除。
          record.status = 'UNKNOWN'; record.error = error.message; this.auto = false;
        }
      }
      await this.store.save(); await this.store.audit({ type: 'ORDER', order: record });
      if (this.config.mode === 'demo') this.refreshDemo();
      return record;
    } finally { this.busy = false; }
  }
  async saveStrategy(input) {
    const strategy = validateStrategy(input);
    if (strategy.amount > this.config.maxOrder) throw new Error('策略金额超过单笔额度');
    this.auto = false; this.strategy = strategy; this.strategyRevision++; this.autoRevision++;
    this.store.state.strategy = this.strategy; await this.store.save(); return this.strategy;
  }
  async setAuto(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('开关格式无效');
    if (enabled && !Number.isFinite(this.snapshot?.targetPrice)) throw new Error('目标价未连接，不能启动价差策略');
    if (enabled && this.config.mode === 'live' && (!this.config.liveEnabled || !this.snapshot?.priceVerified || this.error)) throw new Error('真实行情、规则验证或下单开关未就绪');
    if (enabled && this.risk().unresolvedOrders) throw new Error('存在结果未知的订单，请先核对');
    this.auto = enabled; this.autoRevision++; await this.store.audit({ type: 'AUTO', enabled, mode: this.config.mode });
  }
  async tickStrategy(preview = false) {
    if ((!this.auto && !preview) || this.decisionBusy || this.busy) return this.decision;
    this.decisionBusy = true;
    try {
      const revision = this.strategyRevision, autoRevision = this.autoRevision;
      const snapshot = this.snapshot, risk = this.risk(), now = this.now();
      let decision = evaluateStrategy(snapshot, this.strategy, risk, now);
      const state = snapshot ? decisionState(snapshot, this.strategy, risk, now) : null;
      if (this.error) decision = { action: 'SKIP', reason: this.error };
      if (decision.action !== 'SKIP' && this.strategy.custom) {
        const custom = await runCustom(state);
        decision = custom.action === decision.action ? custom : { action: 'SKIP', reason: custom.action === 'SKIP' ? custom.reason : '自定义方向与基础策略条件不一致' };
      }
      if (decision.action !== 'SKIP' && this.strategy.decisionMode === 'JEV') {
        // 最多两秒一轮，防止尾盘连续请求耗尽额度。
        if (!preview && now - this.lastDecisionAt < 2000) return this.decision;
        this.lastDecisionAt = now;
        const judged = await runJev(state, this.config);
        decision = judged.action === decision.action ? judged : { ...judged, action: 'SKIP', reason: judged.action === 'SKIP' ? judged.reason : 'jev 方向与基础策略条件不一致' };
      }
      if (decision.action !== 'SKIP') {
        const fresh = evaluateStrategy(this.snapshot, this.strategy, this.risk(), this.now());
        if (snapshot.id !== this.snapshot?.id || fresh.action !== decision.action) decision = { action: 'SKIP', reason: '决策期间场次或条件变化，结果作废' };
        if (revision !== this.strategyRevision || autoRevision !== this.autoRevision) decision = { action: 'SKIP', reason: '策略或运行状态已改变，结果作废' };
      }
      this.decision = { ...decision, at: this.now(), preview };
      if (preview || decision.action !== 'SKIP') await this.store.audit({ type: 'DECISION', mode: this.config.mode, decision: this.decision, state });
      if (!preview && this.auto && decision.action !== 'SKIP') {
        const prepared = await this.prepareQuote({ marketId: snapshot.id, direction: decision.action.slice(4), amount: this.strategy.amount,
          maxPrice: this.strategy.maxPrice, orderType: 'MARKET', slippageBps: 100 }, this.strategy.maxPerRound);
        // 停止按钮在报价等待期间也有效。
        const check = evaluateStrategy(this.snapshot, this.strategy, this.risk(), this.now());
        if (this.auto && revision === this.strategyRevision && autoRevision === this.autoRevision && check.action === decision.action && this.now() < snapshot.endDate - this.strategy.minRemainingSeconds * 1000) await this.submit(prepared.id, this.strategy.decisionMode);
      }
      return this.decision;
    } catch (error) { this.decision = { action: 'SKIP', reason: error.message, at: this.now() }; return this.decision; }
    finally { this.decisionBusy = false; }
  }
  demoScenario(input) {
    if (this.config.mode !== 'demo') throw new Error('此功能仅限演示模式');
    if (this.config.btcPriceMode === 'live') throw new Error('真实 BTC 行情模式不允许用模拟价格替换；场景测试请设置 BTC_PRICE_MODE=simulated');
    const remaining = Number(input.remaining), delta = Number(input.delta);
    if (!Number.isFinite(remaining) || remaining < 1 || remaining > 300 || !Number.isFinite(delta) || Math.abs(delta) > 1000) throw new Error('演示参数无效');
    this.auto = false;
    this.autoRevision++;
    this.scenario = { start: this.now() - (300 - remaining) * 1000, delta };
    this.refreshDemo();
  }
  async resolveUnknown(input) {
    if (this.busy) throw new Error('正在处理交易');
    const order = this.store.state.orders.find(o => o.id === input.id && o.mode === 'live');
    if (!order || !['SUBMITTING', 'UNKNOWN'].includes(order.status)) throw new Error('订单不在待核对状态');
    if (input.confirmation !== '已在币安核对') throw new Error('请先在币安核对真实订单');
    if (input.orderId) {
      const wallet = await this.wallet(); const actual = (await this.allOrders(wallet.walletAddress)).find(o => String(o.orderId) === String(input.orderId));
      if (!actual || String(actual.marketTopicId) !== order.marketId || actual.side !== 'BUY') throw new Error('未找到匹配场次的币安订单');
      order.orderId = String(actual.orderId); order.status = actual.status; order.exchange = actual;
    } else order.status = 'REJECTED';
    await this.store.save(); await this.store.audit({ type: 'MANUAL_RECONCILE', order }); return order;
  }
}
