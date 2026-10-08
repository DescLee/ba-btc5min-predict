import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { PaperTrading, simulateFill, officialSettlement, paperStats, validatePaperSettings, calculatePaperFee, paperFeeModel } from '../server/paper.mjs';

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'paper-test-')); const store = new Store(dir); await store.init();
  t.after(async () => { await store.tail; await rm(dir, { recursive: true, force: true }); });
  let clock = 1000000, s = { id: '123', title: 'BTC 5m', startDate: 710000, endDate: 1010000, targetPrice: 80000,
    targetPriceSource: 'BINANCE_PREDICTION_API', bookSource: 'BINANCE_PREDICTION_API', price: 80050,
    priceSource: 'BINANCE_SPOT', settlementPriceSource: 'CHAINLINK', priceVerified: false, feeRateBps: 200,
    vendor: 'PREDICT_FUN', priceUpdatedAt: clock, updatedAt: clock,
    outcomes: { UP: { tokenId: 'u', marketId: 9, ask: .6, tradingStatus: 'OPEN', bookAt: clock }, DOWN: { tokenId: 'd', marketId: 9, ask: .4, tradingStatus: 'OPEN', bookAt: clock } } };
  let bookCalls = 0, detailCalls = 0;
  const client = { book: async (_, o) => { bookCalls++; return { tokenId: o.tokenId, timestamp: clock, asks: [{ price: '.6', size: '100' }] }; },
    detail: async () => { detailCalls++; return { marketTopicId: 123, status: 'RESOLVED', endDate: 1010000,
      variantData: { startPrice: '80000', endPrice: '80030', priceFeedProvider: 'CHAINLINK' }, markets: [{ outcomes: [{ name: 'Up', winner: true }] }] }; },
    quote: () => { throw new Error('模拟禁止请求真实报价'); }, place: () => { throw new Error('模拟禁止下真实订单'); }, ...overrides };
  const paper = new PaperTrading({ store, client, getSnapshot: () => s, getError: () => null, now: () => clock, logger: overrides.logger || (() => {}) });
  return { paper, store, client, snapshot: s, advance: ms => { clock += ms; s.priceUpdatedAt = clock; s.updatedAt = clock; },
    calls: () => ({ bookCalls, detailCalls }), now: () => clock, setSnapshot: value => s = value };
}
test('缺省使用10秒、0价差、1USDT，允许自定义并拒绝无效参数', () => {
  const s = validatePaperSettings(); assert.equal(s.amount, 1); assert.equal(s.windowSeconds, 10); assert.equal(s.minDeltaUsd, 0);
  assert.equal(validatePaperSettings({ amount: 5 }).amount, 5);
  for (const input of [{amount:0}, {windowSeconds:1}, {minDeltaUsd:-1}]) assert.throws(() => validatePaperSettings(input), /无效/);
});
test('盘口逐档成交，成交价按份额加权，金额不超过1', () => {
  const fill = simulateFill({ tradingStatus: 'OPEN', asks: [{ price: .5, size: 1 }, { price: .6, size: 2 }] }, 1, .6);
  assert.equal(fill.filled, true); assert.ok(Math.abs(fill.shares - (1 + .5 / .6)) < 1e-10);
  assert.equal(fill.fills.reduce((sum, l) => sum + l.cost, 0), 1);
});
test('成交均价消除浮点尾差，不把0.88显示成0.87', () => {
  assert.equal(simulateFill({ tradingStatus: 'OPEN', asks: [{ price: .88, size: 100 }] }, 1, .99).averagePrice, .88);
});
test('涨停、无卖盘、深度不足、超价和闭市均不成交', () => {
  assert.equal(simulateFill({ tradingStatus: 'OPEN', asks: [] }, 1, .99).code, 'NO_ASKS');
  assert.equal(simulateFill({ tradingStatus: 'OPEN', asks: [{ price: 1, size: 100 }] }, 1, .99).code, 'PRICE_LIMIT');
  assert.equal(simulateFill({ tradingStatus: 'OPEN', asks: [{ price: .5, size: 1 }] }, 1, .99).code, 'INSUFFICIENT_DEPTH');
  assert.equal(simulateFill({ tradingStatus: 'OPEN', asks: [{ price: .7, size: 100 }] }, 1, .6).code, 'PRICE_CAP');
  assert.equal(simulateFill({ tradingStatus: 'CLOSED', asks: [{ price: .5, size: 100 }] }, 1, .99).code, 'MARKET_CLOSED');
});
test('最后10秒仅尝试一次，500ms前不成交，执行后等待期末', async t => {
  const f = await fixture(t); f.snapshot.endDate += 1; await f.paper.tick(); assert.equal(f.store.state.paper.records.length, 0);
  f.snapshot.endDate -= 1; await f.paper.tick(); const r = f.store.state.paper.records[0];
  assert.equal(r.status, 'PENDING'); assert.equal(r.amount, 1); assert.equal(f.calls().bookCalls, 0);
  f.advance(400); await f.paper.tick(); assert.equal(r.status, 'PENDING');
  f.advance(100); await f.paper.tick(); assert.equal(r.status, 'FILLED'); assert.equal(r.amount, 1); assert.ok(Math.abs(r.fee - .02 * .4 / .6) < 1e-12);
  await f.paper.tick(); assert.equal(f.store.state.paper.records.length, 1); assert.equal(f.calls().bookCalls, 1);
});
test('期后按官方结果结算并写独立JSON，刷新与重启不重复下注', async t => {
  const f = await fixture(t); await f.paper.tick(); f.advance(500); await f.paper.tick();
  f.advance(10000); await f.paper.tick(); const r = f.store.state.paper.records[0];
  assert.equal(r.status, 'SETTLED'); assert.equal(r.result, 'UP'); assert.equal(r.finalPrice, 80030);
  assert.ok(Math.abs(r.pnl - (1 / .6 - 1 - .02 * .4 / .6)) < 1e-10);
  const file = JSON.parse(await readFile(join(f.store.dir, 'paper-trades', 'round-123.json'), 'utf8'));
  assert.equal(file.record.amount, 1); assert.equal(file.record.status, 'SETTLED');
  const restored = new Store(f.store.dir); await restored.init(); assert.equal(restored.state.paper.records.length, 1);
  const p = new PaperTrading({ store: restored, client: f.client, getSnapshot: () => f.snapshot, getError: () => null, now: f.now });
  await p.tick(); assert.equal(restored.state.paper.records.length, 1);
});
test('涨停买入失败期后也归档，但不计入盈亏和胜率', async t => {
  const f = await fixture(t); f.snapshot.outcomes.UP.ask = 1; await f.paper.tick();
  assert.equal(f.store.state.paper.records[0].status, 'FAILED'); f.advance(11000); await f.paper.tick();
  const file = JSON.parse(await readFile(join(f.store.dir, 'paper-trades', 'round-123.json'), 'utf8'));
  assert.equal(file.record.status, 'FAILED'); assert.equal(file.record.pnl, undefined);
  const stats = f.paper.publicState().stats; assert.equal(stats.failures, 1); assert.equal(stats.winRate, null); assert.equal(stats.fillRate, 0);
});
test('延迟后价格变化或盘口深度不够，FOK不会虚构部分成交', async t => {
  const f = await fixture(t, { book: async (_, o) => ({ tokenId: o.tokenId, timestamp: 1000500, asks: [{ price: '.6', size: '.1' }] }) });
  await f.paper.tick(); f.advance(500); await f.paper.tick();
  const r = f.store.state.paper.records[0]; assert.equal(r.status, 'FAILED'); assert.equal(r.failureCode, 'INSUFFICIENT_DEPTH'); assert.equal(r.shares, undefined);
});
test('停止模拟后 pending取消，盘口返回不能覆盖停止状态', async t => {
  let release, begin; const begun = new Promise(resolve => begin = resolve);
  const f = await fixture(t, { book: async (_, o) => { begin(); await new Promise(resolve => release = resolve); return { tokenId: o.tokenId, timestamp: 1000500, asks: [{ price: '.6', size: '100' }] }; } });
  await f.paper.tick(); f.advance(500); const running = f.paper.tick(); await begun;
  await f.paper.configure({ enabled: false }); release(); await running;
  assert.equal(f.store.state.paper.records[0].status, 'FAILED'); assert.equal(f.store.state.paper.records[0].failureCode, 'STOPPED');
});
test('执行时换期或进入最后1秒，不会模拟成交', async t => {
  const f = await fixture(t); await f.paper.tick(); f.advance(9500); await f.paper.tick();
  assert.equal(f.store.state.paper.records[0].failureCode, 'EXPIRED'); assert.equal(f.calls().bookCalls, 0);
});
test('官方结果未发布保持待结算，不能拿当前现货猜结果', async t => {
  const f = await fixture(t, { detail: async () => ({ marketTopicId: 123, status: 'REGISTERED', endDate: 1010000, variantData: { startPrice: '80000', endPrice: null } }) });
  await f.paper.tick(); f.advance(500); await f.paper.tick(); f.snapshot.price = 1; f.advance(10000); await f.paper.tick();
  const r = f.store.state.paper.records[0]; assert.equal(r.status, 'FILLED'); assert.equal(r.pnl, undefined);
  const file = JSON.parse(await readFile(join(f.store.dir, 'paper-trades', 'round-123.json'), 'utf8')); assert.equal(file.record.status, 'FILLED');
});
test('平局按每份0.5结算，冲突和场次不匹配均拒绝', () => {
  const r = { marketTopicId: '123', endDate: 10, targetPrice: 100, direction: 'UP' };
  const t = { marketTopicId: 123, endDate: 10, status: 'RESOLVED', variantData: { startPrice: '100', endPrice: '100' } };
  assert.equal(officialSettlement(t, r).payoutPerShare, .5);
  assert.throws(() => officialSettlement({ ...t, marketTopicId: 124 }, r), /不匹配/);
  assert.throws(() => officialSettlement({ ...t, variantData: { startPrice: '100', endPrice: '101' }, markets: [{ outcomes: [{ name: 'Down', winner: true }] }] }, r), /冲突/);
});
test('猜对方向却赔钱：胜率与赚钱笔数必须分开', () => {
  const stats = paperStats([{ status: 'SETTLED', direction: 'UP', result: 'UP', pnl: -.01, totalCost: 1.02 },
    { status: 'SETTLED', direction: 'UP', result: 'DOWN', pnl: -1.02, totalCost: 1.02 },
    { status: 'SETTLED', direction: 'DOWN', result: 'DOWN', pnl: .5, totalCost: 1.02 }, { status: 'FAILED' }, { status: 'SKIPPED' }, { status: 'PENDING' }]);
  assert.equal(stats.winRate, 2 / 3); assert.equal(stats.profitable, 1); assert.equal(stats.losing, 2); assert.equal(stats.fillRate, .75);
  assert.ok(Math.abs(stats.netPnl + .53) < 1e-10);
});

test('console记录判断、执行、期末结果，包含方向价格时间和盈亏且不重复', async t => {
  const logs = []; const f = await fixture(t, { logger: (...args) => logs.push(args) });
  await f.paper.tick(); f.advance(500); await f.paper.tick(); f.advance(10000); await f.paper.tick(); await f.paper.tick();
  assert.equal(logs.length, 4);
  const decision = logs[1][1], execution = logs[2][1], result = logs[3][1];
  assert.equal(decision.方向, '买涨'); assert.equal(decision.下注金额USDT, 1);
  assert.equal(execution.买入价格, .6); assert.equal(execution.时间戳, 1000500);
  assert.equal(result.操作结果, '成功'); assert.ok(result.盈利金额USDT > 0); assert.equal(result.亏损金额USDT, 0);
  const saved = JSON.parse(await readFile(join(f.store.dir, 'paper-trades', 'round-123.json'), 'utf8'));
  assert.equal(saved.record.consoleEvents.length, 3);
});
test('未成交的期末console明确失败且盈亏均为零', async t => {
  const logs = []; const f = await fixture(t, { logger: (...args) => logs.push(args) });
  f.snapshot.outcomes.UP.ask = 1; await f.paper.tick(); f.advance(11000); await f.paper.tick(); await f.paper.tick();
  assert.equal(logs.length, 3); const result = logs[2][1];
  assert.equal(result.操作结果, '失败（未成交）'); assert.equal(result.盈利金额USDT, 0); assert.equal(result.亏损金额USDT, 0);
});

test('自定义窗口、价差与金额生效，价差未满足时继续等而不占用本期机会', async t => {
  const f = await fixture(t); await f.paper.configure({ enabled: true, settings: { windowSeconds: 30, minDeltaUsd: 100, amount: 5 } });
  f.snapshot.endDate += 15000;
  await f.paper.tick(); assert.equal(f.store.state.paper.records.length, 0);
  f.snapshot.price = 80100; await f.paper.tick(); const r = f.store.state.paper.records[0];
  assert.equal(r.amount, 5); assert.equal(r.remainingSeconds, 25);
  f.advance(500); await f.paper.tick(); assert.equal(r.status, 'FILLED'); assert.ok(Math.abs(r.totalCost - (5 + .02 * .4 * 5 / .6)) < 1e-12);
  const restored = new Store(f.store.dir); await restored.init();
  const p = new PaperTrading({ store: restored, client: f.client, getSnapshot: () => f.snapshot, getError: () => null, now: f.now, logger: () => {} });
  assert.equal(p.data.settings.amount, 5); assert.equal(p.data.settings.windowSeconds, 30);
});
test('负价差取绝对值，待执行订单保留判断时的配置', async t => {
  const f = await fixture(t); f.snapshot.price = 79900;
  await f.paper.configure({ enabled: true, settings: { minDeltaUsd: 100, amount: 2 } });
  await f.paper.tick(); const r = f.store.state.paper.records[0]; assert.equal(r.direction, 'DOWN');
  await f.paper.configure({ enabled: true, settings: { amount: 9 } });
  f.client.book = async (_, o) => ({tokenId:o.tokenId,timestamp:f.now(),asks:[{price:.4,size:100}]});
  f.advance(500); await f.paper.tick(); assert.equal(r.amount, 2); assert.equal(r.totalCost, 2.04);
});

test('官方手续费曲线覆盖低价、0.5、0.99与跨档成交', () => {
  assert.equal(calculatePaperFee([{price:.2,shares:5}],200), .02);
  assert.equal(calculatePaperFee([{price:.5,shares:2}],200), .02);
  assert.ok(Math.abs(calculatePaperFee([{price:.99,shares:1/.99}],200)-.0002020202020202022)<1e-14);
  assert.ok(Math.abs(calculatePaperFee([{price:.4,shares:1},{price:.8,shares:2}],200)-.016)<1e-14);
  assert.throws(()=>calculatePaperFee([{price:1,shares:1}],200), /无效/);
});
test('旧费用迁移重算盈亏、console和文件，保留旧值且重启幂等', async t => {
  const f = await fixture(t); await f.paper.tick(); f.advance(500); await f.paper.tick(); f.advance(10000); await f.paper.tick();
  const r=f.store.state.paper.records[0]; r.fee=.02; r.totalCost=1.02; r.pnl=r.payout-1.02; r.feeModel='旧固定费率';
  const args={store:f.store,client:f.client,getSnapshot:()=>f.snapshot,getError:()=>null,now:f.now,logger:()=>{}};
  const p=new PaperTrading(args); await p.tick();
  assert.equal(r.previousFeeCalculation.fee,.02); assert.equal(r.feeModel,paperFeeModel);
  assert.equal(r.consoleEvents.find(e=>e.phase==='本期结果').净盈亏USDT,r.pnl);
  const file=JSON.parse(await readFile(join(f.store.dir,'paper-trades','round-123.json'),'utf8'));
  assert.equal(file.record.fee,r.fee); new PaperTrading(args); assert.equal(r.previousFeeCalculation.fee,.02);
});

test('兜底秒数必须小于主窗口，开关必须为布尔值', () => {
  assert.throws(() => validatePaperSettings({ fallbackEnabled:true, fallbackWindowSeconds:10 }), /小于/);
  assert.throws(() => validatePaperSettings({ fallbackEnabled:'true' }), /开关/);
  assert.equal(validatePaperSettings({windowSeconds:2}).fallbackEnabled,false);
});
test('主窗口未达标也只console一次；兜底匹配后执行且保存触发配置', async t => {
  const logs=[]; const f=await fixture(t,{logger:(...args)=>logs.push(args)});
  await f.paper.configure({enabled:true,settings:{windowSeconds:10,minDeltaUsd:100,fallbackEnabled:true,fallbackWindowSeconds:5,fallbackMinDeltaUsd:40}});
  await f.paper.tick(); await f.paper.tick(); assert.equal(f.paper.data.records.length,0);
  assert.equal(logs.length,1); assert.equal(logs[0][1].phase,'主策略入场窗口');
  f.advance(5000); await f.paper.tick(); const r=f.paper.data.records[0];
  assert.equal(r.strategyType,'FALLBACK'); assert.equal(r.deltaUsd,50); assert.equal(r.settings.fallbackMinDeltaUsd,40);
  assert.equal(logs[1][1].phase,'兜底入场窗口');
  f.advance(500); await f.paper.tick(); assert.equal(r.status,'FILLED');
});
test('主策略优先，主策略买入失败不触发兜底重试', async t => {
  const f=await fixture(t); await f.paper.configure({enabled:true,settings:{fallbackEnabled:true,fallbackWindowSeconds:5,fallbackMinDeltaUsd:10}});
  f.snapshot.outcomes.UP.ask=1; await f.paper.tick(); f.advance(5000); await f.paper.tick();
  assert.equal(f.paper.data.records.length,1); assert.equal(f.paper.data.records[0].strategyType,'PRIMARY');
  assert.equal(f.paper.data.records[0].status,'FAILED');
});
test('两个窗口均不满足则不交易，期末保存跳过记录及两次窗口console', async t => {
  const logs=[]; const f=await fixture(t,{logger:(...args)=>logs.push(args)});
  await f.paper.configure({enabled:true,settings:{minDeltaUsd:100,fallbackEnabled:true,fallbackWindowSeconds:5,fallbackMinDeltaUsd:60}});
  await f.paper.tick(); f.advance(5000); await f.paper.tick(); f.advance(5000); await f.paper.tick();
  const r=f.paper.data.records[0]; assert.equal(r.status,'SKIPPED'); assert.equal(r.strategyType,'NONE'); assert.equal(f.calls().bookCalls,0);
  assert.deepEqual(logs.map(l=>l[1].phase),['主策略入场窗口','兜底入场窗口','本期结果']);
  const file=JSON.parse(await readFile(join(f.store.dir,'paper-trades','round-123.json'),'utf8'));
  assert.equal(file.record.settings.fallbackMinDeltaUsd,60); assert.equal(file.record.deltaUsd,50);
});

test('模拟滑点默认10%，支持1000bps并按10%执行，不放大100倍', async t => {
  assert.equal(validatePaperSettings().slippageBps,1000);
  assert.throws(()=>validatePaperSettings({slippageBps:10001}),/无效/);
  const f=await fixture(t,{book:async(_,o)=>({tokenId:o.tokenId,timestamp:1000500,asks:[{price:.65,size:100}]})});
  await f.paper.tick(); f.advance(500); await f.paper.tick(); const r=f.paper.data.records[0];
  assert.equal(r.status,'FILLED'); assert.ok(Math.abs(r.executionPriceCap-.66)<1e-12);
});

test('归零清除记录统计日志及独立文件，保留配置，当前场次不能再下注', async t => {
  const f=await fixture(t); await f.paper.tick(); f.advance(500); await f.paper.tick(); f.advance(10000); await f.paper.tick();
  const settings={...f.paper.data.settings}; await f.paper.reset();
  assert.equal(f.paper.publicState().stats.total,0); assert.equal(f.paper.publicState().stats.netPnl,0);
  assert.equal(f.paper.data.windows.length,0); assert.deepEqual(f.paper.data.settings,settings); assert.equal(f.paper.data.enabled,true);
  await assert.rejects(readFile(join(f.store.dir,'paper-trades','round-123.json')), /ENOENT/);
  const restored=new Store(f.store.dir); await restored.init(); assert.equal(restored.state.paper.records.length,0);
  f.snapshot.endDate+=300000; f.advance(290000); await f.paper.tick(); assert.equal(f.paper.data.records.length,1);
});
test('盘口请求进行中归零等待结束，不会复活旧记录，同期禁止再次下注', async t => {
  let release,begin;const begun=new Promise(resolve=>begin=resolve);
  const f=await fixture(t,{book:async(_,o)=>{begin();await new Promise(resolve=>release=resolve);return {tokenId:o.tokenId,timestamp:f.now(),asks:[{price:.6,size:100}]};}});
  await f.paper.tick(); f.advance(500);const ticking=f.paper.tick();await begun;
  const reset=f.paper.reset();release();await ticking;await reset;await f.paper.tick();
  assert.equal(f.paper.data.records.length,0);assert.equal(f.paper.data.windows.length,0);
  const p=new PaperTrading({store:f.store,client:f.client,getSnapshot:()=>f.snapshot,getError:()=>null,now:f.now,logger:()=>{}});
  await p.tick();assert.equal(p.data.records.length,0);
});

test('0.98挂单只在最后90秒触发，跟随盘口方向，不跟随BTC价差', async t => {
  const f=await fixture(t);await f.paper.configure({enabled:true,settings:{strategyMode:'TOUCH_LIMIT'}});
  f.snapshot.endDate+=80001;f.snapshot.price=79900;f.snapshot.outcomes.UP.ask=.98;
  await f.paper.tick();assert.equal(f.paper.data.records.length,0);f.snapshot.endDate--;
  await f.paper.tick();const r=f.paper.data.records[0];assert.equal(r.direction,'UP');assert.equal(r.limitPrice,.98);
  assert.equal(r.strategyType,'TOUCH_LIMIT');assert.equal(r.status,'PENDING');assert.equal(r.settings.windowSeconds,90);
  await f.paper.tick();assert.equal(f.paper.data.records.length,1);
});
test('限价0.98不追0.99，深度不足继续挂单，满足后整笔成交并官方结算', async t => {
  let price=.99,size=100;const f=await fixture(t);
  f.client.book=async(_,o)=>({tokenId:o.tokenId,timestamp:f.now(),asks:[{price,size}]});
  await f.paper.configure({enabled:true,settings:{strategyMode:'TOUCH_LIMIT',slippageBps:1000}});
  f.snapshot.outcomes.UP.ask=.99;await f.paper.tick();f.advance(500);await f.paper.tick();let r=f.paper.data.records[0];
  assert.equal(r.status,'PENDING');assert.equal(r.executionPriceCap,.98);
  price=.98;size=.1;f.advance(1000);await f.paper.tick();assert.equal(r.status,'PENDING');assert.equal(r.shares,undefined);
  size=100;f.advance(1000);await f.paper.tick();assert.equal(r.status,'FILLED');assert.equal(r.averagePrice,.98);
  f.advance(10000);await f.paper.tick();assert.equal(r.status,'SETTLED');assert.equal(r.result,'UP');
  assert.ok(Math.abs(r.pnl-(1/.98-1-.02*.02/.98))<1e-12);
});
test('限价挂单到期取消且重启不重复挂单；同时触达或无卖盘不选方向', async t => {
  const f=await fixture(t);await f.paper.configure({enabled:true,settings:{strategyMode:'TOUCH_LIMIT'}});
  f.snapshot.outcomes.UP.ask=.99;f.snapshot.outcomes.DOWN.ask=.99;await f.paper.tick();assert.equal(f.paper.data.records.length,0);
  f.snapshot.outcomes.UP.ask=null;f.snapshot.outcomes.DOWN.ask=null;await f.paper.tick();assert.equal(f.paper.data.records.length,0);
  f.snapshot.outcomes.DOWN.ask=.98;await f.paper.tick();const r=f.paper.data.records[0];assert.equal(r.direction,'DOWN');
  f.advance(9500);await f.paper.tick();assert.equal(r.status,'FAILED');assert.equal(r.failureCode,'EXPIRED');
  const p=new PaperTrading({store:f.store,client:f.client,getSnapshot:()=>f.snapshot,getError:()=>null,now:f.now,logger:()=>{}});
  await p.tick();assert.equal(p.data.records.length,1);
});
test('停止模拟撤销0.98挂单，后续盘口不能成交', async t => {
  const f=await fixture(t);await f.paper.configure({enabled:true,settings:{strategyMode:'TOUCH_LIMIT'}});
  f.snapshot.outcomes.UP.ask=.98;await f.paper.tick();await f.paper.configure({enabled:false});
  f.advance(500);await f.paper.tick();assert.equal(f.paper.data.records[0].status,'FAILED');assert.equal(f.calls().bookCalls,0);
});

test('限时触达默认90秒/0.98，拒绝无效时间价格', () => {
  const settings=validatePaperSettings();assert.equal(settings.touchWindowSeconds,90);assert.equal(settings.touchPrice,.98);
  for(const input of [{touchWindowSeconds:1},{touchWindowSeconds:301},{touchWindowSeconds:2.5},{touchPrice:0},{touchPrice:1},{touchPrice:.985}])assert.throws(()=>validatePaperSettings(input));
});
test('限时触达自定义窗口和价格影响触发及执行上限，旧挂单保留原参数', async t => {
  const f=await fixture(t);await f.paper.configure({enabled:true,settings:{strategyMode:'TOUCH_LIMIT',touchWindowSeconds:6,touchPrice:.95}});
  f.snapshot.outcomes.UP.ask=.95;await f.paper.tick();assert.equal(f.paper.data.records.length,0);
  f.advance(4000);f.snapshot.outcomes.UP.bookAt=f.now();f.snapshot.outcomes.UP.ask=.94;
  await f.paper.tick();assert.equal(f.paper.data.records.length,0);
  f.snapshot.outcomes.UP.ask=.95;await f.paper.tick();const r=f.paper.data.records[0];
  assert.equal(r.limitPrice,.95);assert.equal(r.triggerPrice,.95);assert.equal(r.settings.windowSeconds,6);
  await f.paper.configure({enabled:true,settings:{strategyMode:'TOUCH_LIMIT',touchWindowSeconds:90,touchPrice:.98}});
  f.client.book=async(_,o)=>({tokenId:o.tokenId,timestamp:f.now(),asks:[{price:.96,size:100}]});
  f.advance(500);await f.paper.tick();assert.equal(r.status,'PENDING');assert.equal(r.executionPriceCap,.95);
  f.client.book=async(_,o)=>({tokenId:o.tokenId,timestamp:f.now(),asks:[{price:.95,size:100}]});
  f.advance(1000);await f.paper.tick();assert.equal(r.status,'FILLED');assert.equal(r.averagePrice,.95);
  const restored=new Store(f.store.dir);await restored.init();assert.equal(restored.state.paper.records[0].settings.touchWindowSeconds,6);
});
