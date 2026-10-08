import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { readConfig } from '../server/config.mjs';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { BinanceClient, mapOutcomes, isBtcFiveMinute, toWei } from '../server/binance.mjs';
import { defaultStrategy, evaluateStrategy, validateStrategy, decisionState } from '../server/strategy.mjs';
import { runCustom, runJev } from '../server/deciders.mjs';
async function setup(t, overrides = {}, client) {
  const dir = await mkdtemp(join(tmpdir(), 'five-min-test-'));
  const store = new Store(dir); await store.init();
  t.after(async () => { await store.tail; await rm(dir, { recursive: true, force: true }); });
  const engine = new Engine({ ...readConfig({}), btcPriceMode: 'simulated', ...overrides }, store, client);
  if (engine.config.mode === 'demo' && engine.config.btcPriceMode === 'simulated') engine.demoScenario({ remaining: 25, delta: 50 });
  return engine;
}
const buy = engine => ({ marketId: engine.snapshot.id, direction: 'UP', amount: 5, maxPrice: .95, orderType: 'MARKET', slippageBps: 100 });
test('金额使用 BigInt 转换，拒绝科学计数和过度精度', () => {
  assert.equal(toWei('5.123456'), '5123456000000000000');
  for (const amount of ['0', '-1', '1e3', '0.0000001', 'NaN']) assert.throws(() => toWei(amount));
});
test('仅选择 BTC 五分钟，不以其他周期替代', () => {
  const topic = { symbol: 'BTCUSDT', chartType: 'CRYPTO_UP_DOWN', startDate: 1000, endDate: 301000 };
  assert.equal(isBtcFiveMinute(topic), true); assert.equal(isBtcFiveMinute({ ...topic, endDate: 3601000 }), false);
});
test('涨跌映射与数组顺序无关，拒绝猜测 YES/NO', () => {
  const topic = { markets: [{ marketId: 2, title: 'DOWN', outcomes: [{ name: 'YES', tokenId: 'd' }] }, { marketId: 1, title: 'UP', outcomes: [{ name: 'YES', tokenId: 'u' }] }] };
  assert.equal(mapOutcomes(topic).UP.tokenId, 'u');
  assert.throws(() => mapOutcomes({ markets: [{ title: 'BTC', outcomes: [{ name: 'YES', tokenId: 'u' }, { name: 'NO', tokenId: 'd' }] }] }));
  assert.throws(() => mapOutcomes({ markets: [...topic.markets, topic.markets[0]] }));
});
test('签名覆盖查询参数和 POST 表单，Key 只在请求头', async () => {
  let request;
  const client = new BinanceClient({ apiKey: 'test-key', apiSecret: 'test-secret' }, async (url, options) => { request = { url: new URL(url), options }; return { ok: true, json: async () => ({ quoteId: 'q' }) }; });
  await client.quote({ tokenId: 'u', amountIn: toWei(5), side: 'BUY' });
  const signature = request.url.searchParams.get('signature'); request.url.searchParams.delete('signature');
  assert.equal(signature, createHmac('sha256', 'test-secret').update(request.url.searchParams.toString() + request.options.body).digest('hex'));
  assert.equal(request.options.headers['X-MBX-APIKEY'], 'test-key'); assert.equal(request.url.toString().includes('test-key'), false);
});
test('首次连接较慢时，时间校准不能把签名时间推到服务器未来', async t => {
  let clock = 1000000;
  t.mock.method(Date, 'now', () => clock);
  const client = new BinanceClient({}, async () => { clock = 1004000; return { ok: true, json: async () => ({ serverTime: 1004000 }) }; });
  await client.syncTime(); assert.ok(client.offset <= 0, `错误时间偏移 ${client.offset}ms`);
});
test('时间戳错误只重试一次只读请求，不重试真实下单', async () => {
  let reads = 0, places = 0, syncs = 0;
  const client = new BinanceClient({ apiKey: 'test', apiSecret: 'test' }, async (url, options) => {
    if (url.includes('/api/v3/time')) { syncs++; return { ok: true, json: async () => ({ serverTime: Date.now() }) }; }
    if (options.method === 'GET') { reads++; return { ok: reads > 1, json: async () => reads === 1 ? { code: -1021, msg: 'timestamp ahead' } : { marketTopics: [] } }; }
    places++; return { ok: false, json: async () => ({ code: -1021, msg: 'timestamp ahead' }) };
  });
  await client.markets(); assert.equal(reads, 2); assert.equal(syncs, 1);
  await assert.rejects(client.place({ quoteId: 'q' }), /timestamp/); assert.equal(places, 1); assert.equal(syncs, 1);
});
test('模拟手动报价、提交、重复确认只产生一笔，重启记录保留', async t => {
  const e = await setup(t); const q = await e.prepareQuote(buy(e));
  const first = await e.submit(q.id); const duplicate = await e.submit(q.id);
  assert.equal(first.status, 'FILLED'); assert.equal(first.id, duplicate.id); assert.equal(e.store.state.orders.length, 1);
  const restored = new Store(e.store.dir); await restored.init(); assert.equal(restored.state.orders.length, 1);
});
test('阻止同一期第二笔、旧场次报价及超过费用后的额度', async t => {
  const e = await setup(t); const q = await e.prepareQuote(buy(e)); await e.submit(q.id);
  await assert.rejects(e.prepareQuote(buy(e)), /次数/);
  const other = await setup(t); const old = await other.prepareQuote(buy(other)); other.demoScenario({ remaining: 20, delta: 50 });
  await assert.rejects(other.submit(old.id), /场次/);
  const capped = await setup(t, { maxOrder: 5 }); await assert.rejects(capped.prepareQuote(buy(capped)), /含费用/);
});
test('过期报价和过期行情不能下单', async t => {
  const e = await setup(t); const q = await e.prepareQuote(buy(e)); e.quotes.get(q.id).expireAt = 0;
  await assert.rejects(e.submit(q.id), /过期/);
  e.snapshot.updatedAt = 0; await assert.rejects(e.prepareQuote(buy(e)), /行情已过期/);
});
test('价差方向、时间边界、买价上限分别过滤策略', async t => {
  const e = await setup(t); const risk = e.risk(), now = e.now();
  assert.equal(evaluateStrategy(e.snapshot, defaultStrategy, risk, now).action, 'BUY_UP');
  assert.equal(evaluateStrategy(e.snapshot, defaultStrategy, risk, e.snapshot.endDate - 5000).action, 'SKIP');
  assert.equal(evaluateStrategy(e.snapshot, defaultStrategy, risk, e.snapshot.endDate - 31000).action, 'SKIP');
  assert.equal(evaluateStrategy(e.snapshot, { ...defaultStrategy, maxPrice: .5 }, risk, now).action, 'SKIP');
  e.demoScenario({ remaining: 25, delta: -50 }); assert.equal(evaluateStrategy(e.snapshot, defaultStrategy, e.risk(), e.now()).action, 'BUY_DOWN');
});
test('策略预览不下单，启动自动模拟后每期只成交一次', async t => {
  const e = await setup(t); const preview = await e.tickStrategy(true); assert.equal(preview.action, 'BUY_UP'); assert.equal(e.store.state.orders.length, 0);
  await e.setAuto(true); await e.tickStrategy(); await e.tickStrategy(); assert.equal(e.store.state.orders.length, 1);
  await e.setAuto(false); e.demoScenario({ remaining: 25, delta: -50 }); await e.tickStrategy(); assert.equal(e.store.state.orders.length, 1);
});
test('修改策略停止运行，无效策略不会写入', async t => {
  const e = await setup(t); await e.setAuto(true); await e.saveStrategy({ ...defaultStrategy, minDeltaUsd: 70 }); assert.equal(e.auto, false);
  await assert.rejects(e.saveStrategy({ ...defaultStrategy, amount: 100 }), /单笔额度/); assert.equal(e.strategy.minDeltaUsd, 70);
  assert.throws(() => validateStrategy({ minRemainingSeconds: 30, windowSeconds: 30 }));
});
test('自定义代码可执行，jev 未配置时安全跳过', async t => {
  const e = await setup(t); const input = decisionState(e.snapshot, e.strategy, e.risk(), e.now());
  assert.equal((await runCustom(input)).action, 'BUY_UP');
  assert.equal((await runJev(input, { ...e.config, jevCommand: '/does-not-exist' })).action, 'SKIP');
});
test('演示换期会结算模拟持仓', async t => {
  const e = await setup(t); const q = await e.prepareQuote(buy(e)); const order = await e.submit(q.id);
  e.demoScenario({ remaining: 20, delta: -50 }); assert.equal(order.status, 'SETTLED'); assert.ok(order.payout > 0); assert.ok(Number.isFinite(order.pnl));
});
function liveSnapshot() {
  const now = Date.now(); return { id: '42', title: 'BTC 5m', startDate: now - 200000, endDate: now + 100000, targetPrice: 80000, price: 80050,
    priceUpdatedAt: now, updatedAt: now, priceVerified: true, feeRateBps: 200,
    outcomes: { UP: { tokenId: 'u', ask: .5, tradingStatus: 'OPEN' }, DOWN: { tokenId: 'd', ask: .5, tradingStatus: 'OPEN' } } };
}
test('真实交易开关和规则验证缺一不可', async t => {
  const e = await setup(t, { mode: 'live' }); e.snapshot = liveSnapshot();
  await assert.rejects(e.prepareQuote(buy(e)), /开关/);
  e.config.liveEnabled = true; await assert.rejects(e.prepareQuote(buy(e)), /验证/);
});
test('真实下单超时保留未知订单和额度，不自动重试', async t => {
  let places = 0;
  const fake = { now: () => Date.now(), wallets: async () => ({ wallets: [{ walletAddress: '0xabc', walletId: 'w' }] }),
    quote: async () => ({ quoteId: 'q', tokenId: 'u', side: 'BUY', walletAddress: '0xabc', amountIn: toWei(5), orderType: 'MARKET', feeAmount: toWei('.1'.replace(/^\./, '0.')), amountOut: toWei(10), minReceive: toWei(9.9), averagePrice: .5, expireAt: Date.now() + 20000 }),
    place: async () => { places++; throw new Error('timeout'); } };
  const e = await setup(t, { mode: 'live', liveEnabled: true, rulesVerified: true }, fake); e.snapshot = liveSnapshot(); e.rawTopic = { chainId: '56' };
  const q = await e.prepareQuote(buy(e)), order = await e.submit(q.id);
  assert.equal(order.status, 'UNKNOWN'); assert.equal(e.risk().dailySpent, 5.1); assert.equal(e.risk().unresolvedOrders, 1);
  await e.submit(q.id); assert.equal(places, 1);
  await assert.rejects(e.prepareQuote(buy(e)), /结果未知/);
});
test('本地状态写入失败时绝不发起真实下单', async t => {
  const e = await setup(t); const q = await e.prepareQuote(buy(e));
  e.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(e.submit(q.id), /disk full/); assert.equal(e.store.state.orders[0].status, 'SUBMITTING');
});
test('自动报价等待期间停止，返回后不得提交订单', async t => {
  const e = await setup(t); let finishQuote, began;
  const waiting = new Promise(resolve => began = resolve);
  const original = e.prepareQuote.bind(e);
  e.prepareQuote = async (...args) => { const q = await original(...args); began(); await new Promise(resolve => finishQuote = resolve); return q; };
  await e.setAuto(true); const tick = e.tickStrategy(); await waiting;
  await e.setAuto(false); finishQuote(); await tick;
  assert.equal(e.store.state.orders.length, 0);
});
test('jev CLI 结构化结果可解析，低置信度跳过', async t => {
  const e = await setup(t); const command = join(e.store.dir, 'fake-jev');
  await writeFile(command, '#!/usr/bin/env node\nconsole.log(JSON.stringify({answers:{action:{choice:"BUY_UP",confidence:0.95,probabilities:{BUY_UP:0.95,SKIP:0.05}}}}));\n', { mode: 0o700 });
  const config = { ...e.config, jevCommand: command };
  assert.equal((await runJev({}, config)).action, 'BUY_UP');
  assert.equal((await runJev({}, { ...config, jevConfidence: .99 })).action, 'SKIP');
});
test('无账户密钥也能读取真实 BTC 价格，不混入随机数据', async t => {
  let price = 85000;
  const e = await setup(t, { btcPriceMode: 'live' }, { spot: async () => ({ price, receivedAt: Date.now(), source: 'BINANCE_SPOT' }) });
  await e.refresh(); assert.equal(e.snapshot.price, 85000); assert.equal(e.snapshot.priceSource, 'BINANCE_SPOT');
  assert.equal(e.snapshot.targetPrice, null); price = 85012; await e.refresh();
  assert.equal(e.snapshot.price, 85012); assert.equal(e.snapshot.targetPrice, null);
  assert.throws(() => e.demoScenario({ remaining: 25, delta: 50 }), /不允许/);
});
test('真实行情中断保留旧价格并报错，不回退模拟行情', async t => {
  let failed = false;
  const e = await setup(t, { btcPriceMode: 'live' }, { spot: async () => { if (failed) throw new Error('网络超时'); return { price: 84000, receivedAt: Date.now() }; } });
  await e.refresh(); const previousAt = e.snapshot.priceUpdatedAt; failed = true; await e.refresh();
  assert.equal(e.snapshot.price, 84000); assert.equal(e.snapshot.priceUpdatedAt, previousAt); assert.match(e.error, /不切换模拟数据/);
});
test('第一次真实行情获取失败时不生成模拟快照', async t => {
  const e = await setup(t, { btcPriceMode: 'live' }, { spot: async () => { throw new Error('网络不可用'); } });
  await e.refresh(); assert.equal(e.snapshot, null); assert.match(e.error, /真实 BTC 行情获取失败/);
});
test('目标价只取官方场次字段，模拟交易模式也可只读请求', async t => {
  const now = Date.now();
  let topic = { marketTopicId: 123, symbol: 'BTCUSDT', chartType: 'CRYPTO_UP_DOWN', startDate: now - 100000, endDate: now + 200000, variantData: { startPrice: '81234.56' }, description: '真实场次规则' };
  const fake = { now: () => Date.now(), syncTime: async () => {}, spot: async () => ({ price: 85000, receivedAt: Date.now() }), markets: async () => ({ marketTopics: [topic], hasMore: false }), detail: async () => topic };
  const e = await setup(t, { btcPriceMode: 'live', apiKey: 'test', apiSecret: 'test', liveEnabled: false }, fake);
  await e.refresh(); assert.equal(e.snapshot.targetPrice, 81234.56); assert.equal(e.snapshot.targetPriceSource, 'BINANCE_PREDICTION_API');
  assert.equal(e.snapshot.marketTopicId, 123); assert.equal(e.config.liveEnabled, false);
  topic = { ...topic, variantData: {} }; await e.refresh();
  assert.equal(e.snapshot.targetPrice, null); assert.equal(e.publicState().targetStatus.connected, false);
});
test('缺少官方目标价时交易、自动策略和差值均不可用', async t => {
  const e = await setup(t, { btcPriceMode: 'live' }, { spot: async () => ({ price: 85000, receivedAt: Date.now() }) });
  await e.refresh(); assert.match(e.targetError, /API Key/);
  assert.equal(evaluateStrategy(e.snapshot, e.strategy, e.risk(), e.now()).action, 'SKIP');
  assert.equal(decisionState(e.snapshot, e.strategy, e.risk()).btc.deltaUsd, null);
  await assert.rejects(e.prepareQuote(buy(e)), /目标价/);
  await assert.rejects(e.setAuto(true), /目标价/);
});
test('账户余额无权限时仍保留真实目标价与涨跌盘口', async t => {
  const now = Date.now(); let walletCalls = 0;
  const topic = { marketTopicId: 456, symbol: 'BTCUSDT', chartType: 'CRYPTO_UP_DOWN', title: 'BTC Up or Down 5m', vendor: 'PREDICT_FUN', startDate: now - 100000, endDate: now + 200000,
    variantData: { startPrice: '83514.445', priceFeedProvider: 'CHAINLINK', priceFeedSymbol: 'BTCUSDT' },
    markets: [{ marketId: 9, title: 'Bitcoin Up or Down', tradingStatus: 'OPEN', outcomes: [{ name: 'Up', tokenId: 'u', price: '.17' }, { name: 'Down', tokenId: 'd', price: '.83' }] }] };
  const fake = { now: () => Date.now(), syncTime: async () => {}, spot: async () => ({ price: 83500, receivedAt: Date.now() }), markets: async () => ({ marketTopics: [topic], hasMore: false }), detail: async () => topic,
    book: async (_, o) => ({ timestamp: Date.now(), asks: [{ price: o.direction === 'UP' ? '.17' : '.84', size: '100' }], bids: [{ price: o.direction === 'UP' ? '.16' : '.83', size: '200' }] }),
    wallets: async () => { walletCalls++; throw new Error('币安接口错误 -1002：未授权'); } };
  const e = await setup(t, { mode: 'live', btcPriceMode: 'live', apiKey: 'test', apiSecret: 'test' }, fake);
  await e.refresh(); await e.refresh();
  assert.equal(e.error, null); assert.match(e.accountError, /未授权/); assert.equal(walletCalls, 1);
  assert.equal(e.snapshot.targetPrice, 83514.445); assert.equal(e.snapshot.outcomes.DOWN.ask, .84);
  assert.equal(e.snapshot.settlementPriceSource, 'CHAINLINK'); assert.equal(e.publicState().targetStatus.connected, true);
  assert.equal(e.snapshot.priceVerified, false);
});

test('公共BTC和时间同步使用币安行情专用域名，不发送API密钥', async () => {
  const urls=[];const c=new BinanceClient({apiKey:'private-test',apiSecret:'private-secret'},async(url,options)=>{
    urls.push(url);assert.equal(new URL(url).hostname,'data-api.binance.vision');assert.equal(options.headers,undefined);
    return {ok:true,json:async()=>url.includes('/time')?{serverTime:Date.now()}:{price:'83000.12'}};
  });await c.syncTime();assert.equal((await c.spot()).price,83000.12);assert.equal(urls.length,2);
});
test('预测接口断开时BTC价格和图表继续更新，目标价不可用且模拟不触发', async t => {
  let price=83000,at=Date.now();const e=await setup(t,{mode:'live',apiKey:'test',apiSecret:'test'}, {
    now:()=>at,syncTime:async()=>{},spot:async()=>({price,receivedAt:at}),markets:async()=>{throw new Error('预测网络断开');}
  });await e.refresh();assert.equal(e.snapshot.price,83000);assert.equal(e.snapshot.targetPrice,null);assert.equal(e.snapshot.referenceOnly,true);
  at+=2500;price=83010;await e.refresh();assert.equal(e.snapshot.priceUpdatedAt,at);assert.equal(e.snapshot.history.at(-1).price,83010);
  assert.equal(e.btcError,null);assert.match(e.targetError,/预测网络断开/);await e.paper.tick();assert.equal(e.paper.data.records.length,0);
});

test('预测请求等待期间公共BTC能独立更新，不等待预测超时', async t => {
  let price=83000,release,started;const begun=new Promise(resolve=>started=resolve);
  const e=await setup(t,{mode:'live',apiKey:'test',apiSecret:'test'}, {now:()=>Date.now(),syncTime:async()=>{},spot:async()=>({price,receivedAt:Date.now()}),markets:async()=>{started();await new Promise(resolve=>release=resolve);throw new Error('预测超时');}});
  const refreshing=e.refresh();await begun;price=83020;
  try {await e.refreshBtc();assert.equal(e.btc.price,83020);assert.equal(e.snapshot.price,83020);} finally {release();await refreshing;}
});
