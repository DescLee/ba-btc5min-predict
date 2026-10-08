const paperConsoleSeen = new Set();
let paperPage = 1, paperRowsSignature = '', paperPageOptionsCount = 0;
const $ = selector => document.querySelector(selector);
let state, direction = 'UP', bookDirection = 'UP', currentQuote, reconcilingId, requestBusy = false, strategyLoaded = false, paperLoaded = false, clockOffset = 0;
const money = value => Number.isFinite(Number(value)) && value !== null ? Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, roundingMode: 'trunc' }) : '—';
const preciseMoney = value => Number.isFinite(Number(value)) && value !== null ? Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8, roundingMode: 'trunc' }) : '—';
const time = at => new Date(at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const labels = { SUBMITTING: '提交中／待核对', UNKNOWN: '结果未知／待核对', SUBMITTED: '已提交·待成交', FILLED: '已成交', SETTLED: '模拟已结算', REJECTED: '核对未下单', OPENING: '处理中', OPEN: '委托中', CLOSED: '已关闭', FAILED: '失败', CANCELLED: '已撤销', CANCELED: '已撤销' };
function toast(message, error = false) { $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 5000); }
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': state?.sessionToken || '' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
function text(selector, value) { $(selector).textContent = value; }
function colored(selector, value) { $(selector).classList.toggle('positive', value > 0); $(selector).classList.toggle('negative', value < 0); }
async function reload() {
  try { state = await api('/api/state'); clockOffset = state.now - Date.now(); }
  catch (error) { text('#notice', `本地服务连接失败：${error.message}`); $('#notice').classList.add('error'); return; }
  try { render(); }
  catch (error) { console.error('页面渲染失败', error); text('#notice', `页面显示错误：${error.message}`); $('#notice').classList.add('error'); }
}
function render() {
  const demo = state.mode === 'demo', snapshot = state.snapshot;
  const realBtc = state.btcPriceMode === 'live' || !demo;
  text('#mode-badge', demo ? realBtc ? state.targetStatus?.connected ? '真实行情与目标价 · 模拟交易' : '真实 BTC 行情 · 目标价待连接' : '演示模式 · 模拟资金' : state.connection.liveEnabled ? '真实接口 · 下单已启用' : '真实接口 · 只读');
  text('#side-mode', demo ? realBtc ? '真实行情 · 模拟交易' : '演示环境' : '真实接口环境');
  text('#notice', state.error || state.targetStatus?.error || (demo ? realBtc ? 'BTC 现货与本期目标价来自官方接口。盘口和交易仍为模拟，真实下单关闭。' : '当前为演示数据与模拟资金，仅用于验证操作流程，不代表真实行情或收益。' : snapshot?.priceVerified ? '已连接真实接口。交易将使用配置的资金账户，请核对场次与报价。' : `真实目标价与盘口已连接。结算来源：${snapshot?.settlementPriceSource || '待查询'}；当前 BTC 现货仅作参考，不能代替结算价。真实下单关闭或价格源尚未验证。`));
  $('#notice').classList.toggle('error', !!(state.error || state.targetStatus?.error));
  $('#demo-tools').hidden = !demo || realBtc;
  text('#target-label', !realBtc ? '模拟目标价格' : '本期目标价格（官方）');
  if (state.btc && realBtc) { text('#current-price', `$${money(state.btc.price)}`); text('#price-source', '币安 BTCUSDT · 真实现货'); }
  text('#balance-label', demo ? '模拟可用余额' : '预测钱包余额（不代表 CEX 余额）');
  text('#balance', `${money(state.account?.summary?.walletBalance)} USDT`);
  text('#daily-spent', `${money(state.risk.dailySpent)} / ${money(state.risk.maxDaily)}`);
  text('#max-order', `${money(state.risk.maxOrder)} USDT`);
  text('#auto-badge', state.auto ? '运行中' : '已停止'); $('#auto-badge').classList.toggle('green', state.auto);
  text('#toggle-auto', state.auto ? '停止自动交易' : demo ? '启动自动模拟' : '启动自动交易');
  $('#toggle-auto').classList.toggle('danger', state.auto);
  text('#summary-window', `${state.strategy.minRemainingSeconds}～${state.strategy.windowSeconds} 秒`);
  text('#summary-delta', `≥ $${state.strategy.minDeltaUsd}`); text('#summary-price', money(state.strategy.maxPrice));
  text('#summary-mode', `${state.strategy.custom ? '自定义代码 + ' : ''}${state.strategy.decisionMode === 'JEV' ? 'jev 判断' : '确定性规则'}`);
  text('#decision-action', state.decision.action); text('#decision-reason', state.decision.reason);
  if (!strategyLoaded) { fillStrategy(); strategyLoaded = true; }
  if (snapshot) {
    text('#round-info', realBtc && !state.targetStatus?.connected ? '真实预测场次未连接 · BTC 现货持续更新' : `${time(snapshot.startDate)} — ${time(snapshot.endDate)} · 场次 ${snapshot.marketTopicId || snapshot.id}`);
    text('#market-status', realBtc && !state.targetStatus?.connected ? '目标价未连接' : demo ? realBtc ? '真实场次 · 模拟交易' : '模拟场次' : snapshot.outcomes.UP.tradingStatus === 'OPEN' ? '交易中' : '已停止交易');
    text('#target-price', Number.isFinite(snapshot.targetPrice) ? `$${money(snapshot.targetPrice)}` : '—'); text('#current-price', `$${money(state.btc?.price ?? snapshot.price)}`);
    const delta = snapshot.targetPrice === null ? null : snapshot.price - snapshot.targetPrice;
    text('#delta-price', delta === null ? '—' : `${delta >= 0 ? '+' : '−'}$${money(Math.abs(delta))}`); colored('#delta-price', delta);
    text('#price-source', realBtc ? '币安 BTCUSDT · 真实现货' : '模拟行情');
    text('#price-verification', demo ? realBtc ? '真实现货价格 · 预测盘口模拟' : '演示规则 · 非真实结算' : snapshot.priceVerified ? '已配置价格源与规则验证' : `结算源 ${snapshot.settlementPriceSource || '未知'} · 现货价仅供参考`);
    const age = Math.max(0, (state.now - snapshot.priceUpdatedAt) / 1000);
    text('#chart-updated', `${realBtc ? '真实行情 · ' : ''}接收于 ${time(snapshot.priceUpdatedAt)} · ${age.toFixed(1)}s`);
    text('#rules-text', snapshot.rules || 'API 未提供规则描述');
    renderChart(snapshot); renderBook(snapshot); updateDirection();
  }
  $('#quote-button').disabled = requestBusy || state.busy || !snapshot || !Number.isFinite(snapshot.targetPrice) || !!state.error || (!demo && (!state.connection.liveEnabled || !snapshot.priceVerified));
  renderOrders(); renderConnection(); renderPaper(); updateClock();
}
function updateClock() {
  if (!state?.snapshot) return;
  const remaining = Math.max(0, Math.ceil((state.snapshot.endDate - Date.now() - clockOffset) / 1000));
  text('#countdown', state.btcPriceMode === 'live' && !state.targetStatus?.connected ? '—' : `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`);
  if (currentQuote) {
    const seconds = Math.max(0, Math.floor((currentQuote.expireAt - Date.now() - clockOffset) / 1000));
    text('#confirm-order', seconds ? `确认${currentQuote.mode === 'demo' ? '模拟' : '真实'}提交 · ${seconds}s` : '报价已过期，请重新获取');
    $('#confirm-order').disabled = !seconds || requestBusy;
  }
}
function updateDirection() {
  document.querySelectorAll('[data-direction]').forEach(button => button.classList.toggle('selected', button.dataset.direction === direction));
  const price = state?.snapshot?.outcomes[direction]?.ask;
  $('#ticket-price').replaceChildren(document.createTextNode(money(price)), Object.assign(document.createElement('small'), { textContent: ' USDT / 份' }));
  colored('#ticket-price', direction === 'UP' ? 1 : -1);
  text('#quote-button', `获取买${direction === 'UP' ? '涨' : '跌'}报价`);
}
function svg(tag, attrs, content) { const element = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value); if (content) element.textContent = content; return element; }
function renderChart(s) {
  const chart = $('#chart'); chart.replaceChildren();
  const points = s.history || []; const target = s.targetPrice;
  const values = points.map(p => p.price).filter(Number.isFinite); if (Number.isFinite(target)) values.push(target);
  if (!values.length) return;
  const low = Math.min(...values) - 12, high = Math.max(...values) + 12;
  const x = at => 12 + Math.max(0, Math.min(1, (at - s.startDate) / 300000)) * 665;
  const y = value => 190 - (value - low) / (high - low) * 165;
  for (let i = 0; i < 4; i++) {
    const value = low + (high - low) * i / 3, lineY = y(value);
    chart.append(svg('line', { x1: 12, x2: 677, y1: lineY, y2: lineY, stroke: '#29313e', 'stroke-width': 1 }));
    chart.append(svg('text', { x: 691, y: lineY + 4, fill: '#7c8799', 'font-size': 11 }, Math.round(value).toLocaleString('en-US')));
  }
  if (Number.isFinite(target)) { chart.append(svg('line', { x1: 12, x2: 677, y1: y(target), y2: y(target), stroke: '#8b815e', 'stroke-dasharray': '4 5' })); chart.append(svg('text', { x: 16, y: y(target) - 7, fill: '#bca875', 'font-size': 10 }, '目标价')); }
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  const color = s.price >= target ? '#35c79b' : '#ee6b83';
  if (path) chart.append(svg('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  if (points.length) chart.append(svg('circle', { cx: x(points.at(-1).at), cy: y(points.at(-1).price), r: 4, fill: color }));
  for (let i = 0; i <= 5; i++) chart.append(svg('text', { x: 12 + i * 133, y: 222, fill: '#6f7c90', 'font-size': 10, 'text-anchor': i === 5 ? 'end' : 'start' }, time(s.startDate + i * 60000).slice(0, 5)));
}
function renderBook(snapshot) {
  const book = snapshot.outcomes[bookDirection]; const root = $('#orderbook'); root.replaceChildren();
  const row = (level, side) => { const div = document.createElement('div'); div.className = `book-row ${side}`; div.append(Object.assign(document.createElement('span'), { textContent: money(level.price) }), Object.assign(document.createElement('span'), { textContent: money(level.size) })); return div; };
  for (const level of [...book.asks.slice(0, 4)].reverse()) root.append(row(level, 'negative'));
  root.append(Object.assign(document.createElement('div'), { className: 'book-divider', textContent: money(book.ask) }));
  for (const level of book.bids.slice(0, 4)) root.append(row(level, 'positive'));
  text('#spread', book.ask && book.bid ? money(book.ask - book.bid) : '—');
}
function renderOrders() {
  const root = $('#orders'); root.replaceChildren(); text('#order-count', `${state.orders.length} 笔`);
  if (!state.orders.length) { const row = root.insertRow(); const cell = row.insertCell(); cell.colSpan = 7; cell.className = 'empty-cell'; cell.textContent = '暂无订单。先获取报价，或启动策略模拟。'; }
  for (const order of state.orders) {
    const row = root.insertRow();
    const add = value => { const cell = row.insertCell(); cell.textContent = value; return cell; };
    const first = add(time(order.createdAt)); first.append(Object.assign(document.createElement('small'), { textContent: order.marketId }));
    const dir = add(order.direction === 'UP' ? '↗ 买涨' : '↘ 买跌'); dir.className = order.direction === 'UP' ? 'positive' : 'negative';
    add(({ MANUAL: '手动', RULES: '规则', JEV: 'jev' })[order.source] || order.source);
    add(`${money(order.reservedAmount)} USDT`); add(order.shares ? money(order.shares) : '—');
    const status = add(labels[order.status] || order.status);
    if (['UNKNOWN', 'SUBMITTING'].includes(order.status) && state.mode === 'live') { const button = Object.assign(document.createElement('button'), { className: 'button subtle reconcile', textContent: '核对' }); button.onclick = () => { reconcilingId = order.id; $('#reconcile-dialog').showModal(); }; status.append(button); }
    const pnl = add(order.pnl === undefined ? '—' : `${order.pnl >= 0 ? '+' : ''}${money(order.pnl)}`); if (order.pnl !== undefined) pnl.className = order.pnl >= 0 ? 'positive' : 'negative';
  }
  const positions = $('#positions'); positions.replaceChildren();
  const list = state.account?.positions || [];
  positions.append(Object.assign(document.createElement('p'), { textContent: `账户当前持仓：${list.length} 项${state.accountAt ? ` · 更新于 ${time(state.accountAt)}` : ' · 未连接'}` }));
  for (const p of list.slice(0, 10)) positions.append(Object.assign(document.createElement('p'), { textContent: `${p.marketTopicTitle} · ${p.marketTitle} · ${money(p.shares)} 份 · 成本 ${money(p.totalCost)} USDT · ${p.positionStatus}` }));
}
function renderConnection() {
  text('#connection-mode', state.mode === 'demo' ? '演示' : '真实接口');
  const c = state.connection;
  const entries = [['账户查询', state.accountError || (state.account ? '已连接' : '未连接')], ['API 凭证', c.credentials ? '已配置（不展示密钥）' : '未配置'], ['真实下单开关', c.liveEnabled ? '已开启' : '关闭'], ['市场规则核对', c.rulesVerified ? '已配置确认' : '待核对'], ['配置价格源', c.priceSource], ['当前价格源一致性', state.snapshot?.priceVerified && state.mode === 'live' ? '通过' : '未验证'], ['资金来源 / 参考账户', `${c.fundingSource} / ${c.accountType}`], ['自动交易', state.auto ? '运行中' : '关闭'], ['单笔 / 当日额度', `${state.risk.maxOrder} / ${state.risk.maxDaily} USDT`]];
  const root = $('#connection-status'); root.replaceChildren();
  for (const [name, value] of entries) { const div = document.createElement('div'); div.append(Object.assign(document.createElement('span'), { textContent: name }), Object.assign(document.createElement('b'), { textContent: value })); root.append(div); }
}
function fillStrategy() { const form = $('#strategy-form'); for (const [name, value] of Object.entries(state.strategy)) { const field = form.elements.namedItem(name); if (!field) continue; if (field.type === 'checkbox') field.checked = value; else field.value = value; } }
function switchTab(tab) { document.querySelectorAll('.tab-panel').forEach(panel => panel.hidden = panel.id !== `${tab}-tab`); document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab)); text('#page-title', ({ trade: '交易工作台', paper: '模拟交易', strategy: '交易策略', connection: '接口与账户' })[tab]); }
document.querySelectorAll('[data-tab],[data-go]').forEach(button => button.onclick = () => switchTab(button.dataset.tab || button.dataset.go));
document.querySelectorAll('[data-direction]').forEach(button => button.onclick = () => { direction = button.dataset.direction; updateDirection(); });
document.querySelectorAll('[data-book]').forEach(button => button.onclick = () => { bookDirection = button.dataset.book; document.querySelectorAll('[data-book]').forEach(b => b.classList.toggle('selected', b === button)); if (state?.snapshot) renderBook(state.snapshot); });
document.querySelectorAll('[data-amount]').forEach(button => button.onclick = () => $('#trade-form').elements.amount.value = button.dataset.amount);
$('#order-type').onchange = () => $('#limit-label').hidden = $('#order-type').value !== 'LIMIT';
$('#refresh').onclick = async () => { try { $('#refresh').disabled = true; await api('/api/refresh', {}); await reload(); toast(state.error || '行情已刷新', !!state.error); } catch (e) { toast(e.message, true); } finally { $('#refresh').disabled = false; } };
$('#trade-form').onsubmit = async event => {
  event.preventDefault(); if (requestBusy || !state.snapshot) return;
  requestBusy = true; render();
  try {
    const form = new FormData(event.target);
    currentQuote = await api('/api/quote', { ...Object.fromEntries(form), direction, marketId: state.snapshot.id });
    text('#quote-title', `买${direction === 'UP' ? '涨' : '跌'} · ${currentQuote.mode === 'demo' ? '模拟' : '真实'}订单`);
    text('#quote-mode', `${currentQuote.marketTitle} · ${currentQuote.marketId}`);
    const root = $('#quote-details'); root.replaceChildren();
    for (const [name, value] of [['订单类型', currentQuote.orderType], ['买入金额', `${money(currentQuote.amount)} USDT`], ['报价费用', `${money(currentQuote.fee)} USDT`], ['保守总成本', `${money(currentQuote.total)} USDT`], ['平均价格', money(currentQuote.averagePrice)], ['预计份额', money(currentQuote.shares)], ['最少接收份额', money(currentQuote.minShares)]]) { const div = document.createElement('div'); div.append(Object.assign(document.createElement('span'), { textContent: name }), Object.assign(document.createElement('b'), { textContent: value })); root.append(div); }
    $('#quote-dialog').showModal();
  } catch (e) { toast(e.message, true); }
  finally { requestBusy = false; render(); }
};
$('#quote-dialog').addEventListener('close', () => currentQuote = null);
$('#confirm-order').onclick = async () => {
  if (requestBusy || !currentQuote) return; requestBusy = true; updateClock();
  try { const order = await api('/api/order', { quoteId: currentQuote.id }); $('#quote-dialog').close(); toast(order.status === 'UNKNOWN' ? '订单结果未知，请在币安核对。自动交易已停止。' : order.mode === 'demo' ? '模拟订单已成交' : '真实订单已提交，等待成交确认', order.status === 'UNKNOWN'); }
  catch (e) { toast(e.message, true); }
  finally { requestBusy = false; await reload(); }
};
$('#strategy-form').onsubmit = async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
  for (const key of ['windowSeconds', 'minRemainingSeconds', 'minDeltaUsd', 'maxPrice', 'amount', 'maxPerRound']) data[key] = Number(data[key]);
  data.custom = event.target.elements.custom.checked;
  try { await api('/api/strategy', data); await reload(); toast('策略已保存，自动交易已停止'); } catch (e) { toast(e.message, true); }
};
$('#preview').onclick = async () => { try { $('#preview').disabled = true; const result = await api('/api/strategy/preview', {}); await reload(); toast(`${result.action}：${result.reason}`); } catch (e) { toast(e.message, true); } finally { $('#preview').disabled = false; } };
$('#toggle-auto').onclick = async () => { try { $('#toggle-auto').disabled = true; await api('/api/auto', { enabled: !state.auto }); await reload(); toast(state.auto ? '自动策略已启动' : '自动策略已停止'); } catch (e) { toast(e.message, true); } finally { $('#toggle-auto').disabled = false; } };
for (const [id, delta] of [['#demo-up', 50], ['#demo-down', -50]]) $(id).onclick = async () => { try { await api('/api/demo/scenario', { remaining: 25, delta }); await reload(); toast('已切换尾盘模拟场次'); } catch (e) { toast(e.message, true); } };
$('#reconcile-form').onsubmit = async event => { event.preventDefault(); try { await api('/api/orders/reconcile', { id: reconcilingId, ...Object.fromEntries(new FormData(event.target)) }); $('#reconcile-dialog').close(); await reload(); toast('核对结果已保存'); } catch (e) { toast(e.message, true); } };
function updatePaperStrategyFields() {
  const form = $('#paper-form');
  const limit = form.elements.namedItem('strategyMode').value === 'TOUCH_LIMIT';
  document.querySelectorAll('#paper-form [data-paper-delta], #paper-guide [data-paper-delta]').forEach(element => {
    element.hidden = limit;
    element.querySelectorAll('input, select').forEach(field => field.disabled = limit);
  });
  document.querySelectorAll('#paper-form [data-paper-limit], #paper-guide [data-paper-limit]').forEach(element => { element.hidden = !limit; element.querySelectorAll('input, select').forEach(field => field.disabled = !limit); });
}
$('#paper-form').elements.namedItem('strategyMode').onchange = updatePaperStrategyFields;
function renderPaper() {
  const paper = state.paper; if (!paper) return;
  for (const event of paper.windowEvents || []) { const key = `${event.id}:${event.phase}`; if (!paperConsoleSeen.has(key)) { console.info(`[模拟交易][${event.phase}]`, event); paperConsoleSeen.add(key); } }
  for (const record of [...paper.records].reverse()) {
    for (const event of record.consoleEvents || []) {
      const key = `${record.id}:${event.phase}`;
      if (!paperConsoleSeen.has(key)) {
        console.info(`[模拟交易][${event.phase}]`, event);
        paperConsoleSeen.add(key);
      }
    }
  }
  const limitMode = paper.settings.strategyMode === 'TOUCH_LIMIT';
  text('#paper-title', limitMode ? `限时触达 · 最后${paper.settings.touchWindowSeconds}秒 / ${paper.settings.touchPrice}` : `最后 ${paper.settings.windowSeconds} 秒 · 模拟交易`);
  text('#paper-description', limitMode ? `每期最多挂一单，金额 ${paper.settings.amount} USDT；有效卖一价达到${paper.settings.touchPrice}后挂限价${paper.settings.touchPrice}，等待成交。` : `每期最多尝试一次，下注 ${paper.settings.amount} USDT，最小绝对价差 ${paper.settings.minDeltaUsd} USD。`);
  text('#paper-badge', paper.enabled ? '运行中 · 仅模拟' : '已停止'); $('#paper-badge').classList.toggle('green', paper.enabled);
  text('#paper-toggle', paper.enabled ? '停止模拟' : '启动模拟'); $('#paper-toggle').classList.toggle('danger', paper.enabled);
  text('#paper-notice', paper.error || `当前仅模拟下注，每次 ${paper.settings.amount} USDT。真实成交能力以盘口快照估算；未成交不会计入胜率。`);
  $('#paper-notice').classList.toggle('error', !!paper.error);
  text('#paper-event', paper.lastEvent);
  const root = $('#paper-stats'); root.replaceChildren(); const st = paper.stats;
  const percent = value => value === null ? '—' : `${money(value * 100)}%`;
  const metrics = [['成交率', percent(st.fillRate), `${st.filled} / ${st.attempts} 次尝试`], ['成功率（已结算胜率）', percent(st.winRate), `${st.wins} / ${st.settled} 笔已结算`], ['赚钱笔数', st.profitable, `盈利 ${preciseMoney(st.profitAmount)} USDT`], ['赔钱笔数', st.losing, `亏损 ${preciseMoney(st.lossAmount)} USDT`], ['净盈亏', `${st.netPnl >= 0 ? '+' : ''}${preciseMoney(st.netPnl)}`, 'USDT · 已扣估算费用'], ['未成交 / 待处理', `${st.failures} / ${st.pending}`, `跳过 ${st.skipped} · 平局 ${st.draws}`]];
  for (const [name, value, detail] of metrics) { const card = document.createElement('div'); card.className = 'card paper-stat'; card.append(Object.assign(document.createElement('span'), { textContent: name }), Object.assign(document.createElement('strong'), { textContent: String(value) }), Object.assign(document.createElement('small'), { textContent: detail })); root.append(card); }
  const context = $('#paper-context'); context.replaceChildren();
  for (const [name, value] of [['当前场次', state.snapshot?.id || '等待行情'], ['下注金额 / 每期次数', `${paper.settings.amount} USDT / 1 次`], ['判断窗口', limitMode ? `结束前${paper.settings.touchWindowSeconds}秒内` : `结束前 ${paper.settings.windowSeconds} 秒内`], ['入场条件', limitMode ? `卖一价 ≥ ${paper.settings.touchPrice}；限价${paper.settings.touchPrice}` : `最小绝对价差 ${paper.settings.minDeltaUsd} USD`], ['执行余量', '最后 1 秒禁止执行'], ['估算费用', paper.feeModel]]) { const div = document.createElement('div'); div.append(Object.assign(document.createElement('span'), { textContent: name }), Object.assign(document.createElement('b'), { textContent: value })); context.append(div); }
  if (!paperLoaded) { for (const [key, value] of Object.entries(paper.settings)) { const field = $('#paper-form').elements.namedItem(key === 'slippageBps' ? 'slippagePercent' : key); if (field) { if (field.type === 'checkbox') field.checked = value; else field.value = key === 'slippageBps' ? value / 100 : value; } } paperLoaded = true; updatePaperStrategyFields(); }
  text('#paper-count', `${st.total} 条`);
  const filter = $('#paper-filter').value;
  const filteredRecords = paper.records.filter(r => filter === 'ALL' || filter === r.status || filter === 'WAITING' && ['PENDING', 'FILLED'].includes(r.status) || filter === 'PROFIT' && r.pnl > 0 || filter === 'LOSS' && r.pnl < 0);
  const pageSize = Number($('#paper-page-size').value);
  const pages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  paperPage = Math.max(1, Math.min(paperPage, pages));
  const offset = (paperPage - 1) * pageSize;
  const records = filteredRecords.slice(offset, offset + pageSize);
  text('#paper-page-info', filteredRecords.length ? `第 ${offset + 1}–${offset + records.length} 条，共 ${filteredRecords.length} 条` : '共 0 条');
  $('#paper-page-prev').disabled = paperPage === 1;
  $('#paper-page-next').disabled = paperPage === pages;
  const pageSelect = $('#paper-page-number');
  if (paperPageOptionsCount !== pages) {
    pageSelect.replaceChildren();
    for (let page = 1; page <= pages; page++) pageSelect.append(new Option(`第 ${page} / ${pages} 页`, String(page)));
    paperPageOptionsCount = pages;
  }
  pageSelect.value = String(paperPage);
  const signature = JSON.stringify({ filter, paperPage, pageSize, records });
  if (signature === paperRowsSignature) return;
  paperRowsSignature = signature;
  const tbody = $('#paper-records'); tbody.replaceChildren();
  if (!records.length) { const cell = tbody.insertRow().insertCell(); cell.colSpan = 11; cell.className = 'empty-cell'; cell.textContent = '暂无匹配记录。等待入场窗口与价差条件满足后自动尝试模拟下注。'; }
  for (const r of records) {
    const row = tbody.insertRow(); const add = (value, detail) => { const cell = row.insertCell(); cell.textContent = String(value); if (detail) cell.append(Object.assign(document.createElement('small'), { textContent: detail })); return cell; };
    add(r.marketTopicId, `${time(r.startDate)}—${time(r.endDate)} · 判断 ${time(r.createdAt)}`);
    const dir = add(r.direction === 'UP' ? '↗ 买涨' : r.direction === 'DOWN' ? '↘ 买跌' : '跳过', `剩余 ${money(r.remainingSeconds)}s`); dir.className = r.direction === 'UP' ? 'positive' : r.direction === 'DOWN' ? 'negative' : '';
    add(`$${money(r.targetPrice)}`, `参考 $${money(r.decisionPrice)}`);
    add(`${r.deltaUsd >= 0 ? '+' : ''}${money(Number(Number(r.deltaUsd).toPrecision(12)))}`, `绝对值 ${money(Number(Math.abs(r.deltaUsd).toPrecision(12)))}`);
    add(r.settings.strategyMode === 'TOUCH_LIMIT' ? `限时触达 · 最后${r.settings.touchWindowSeconds ?? 90}s · 卖一≥${r.triggerPrice ?? r.settings.touchPrice ?? .98} · 限价${r.limitPrice ?? r.settings.touchPrice ?? .98}` : `最后 ${r.settings.windowSeconds ?? 10}s · 价差 ≥ ${r.settings.minDeltaUsd ?? 0} USD`, `本金 ${r.amount} USDT · 上限 ${r.settings.maxPrice} · 滑点 ${r.settings.slippageBps / 100}% · 延迟 ${r.settings.latencyMs}ms`);
    add(r.strategyType === 'FALLBACK' ? '是 · 兜底触发' : r.strategyType === 'NONE' ? '未触发' : r.strategyType === 'TOUCH_LIMIT' ? '否 · 限时触达' : '否 · 主策略', r.settings.fallbackEnabled ? `已启用：最后 ${r.settings.fallbackWindowSeconds}s · 价差 ≥ ${r.settings.fallbackMinDeltaUsd} USD` : '未启用兜底');
    add(`${money(r.amount || r.settings.amount)} USDT`, r.fee === undefined ? '费用：未成交不扣费' : `估算费用 ${preciseMoney(r.fee)}`);
    add(r.averagePrice === undefined ? '—' : money(r.averagePrice), r.shares === undefined ? '' : `${money(r.shares)} 份`);
    add(({ PENDING: r.orderType === 'LIMIT' ? '已挂单·待成交' : '执行中', FILLED: '已成交·待结算', SETTLED: '已结算', FAILED: '未成交', SKIPPED: '已跳过' })[r.status] || r.status, r.result === 'UP' ? '官方结果：涨' : r.result === 'DOWN' ? '官方结果：跌' : r.result === 'DRAW' ? '官方结果：平局' : '');
    const pnl = add(r.pnl === undefined ? '—' : `${r.pnl >= 0 ? '+' : ''}${preciseMoney(r.pnl)}`); if (r.pnl !== undefined) pnl.className = r.pnl >= 0 ? 'positive' : 'negative';
    const reason = add(r.reason, r.settlementError || (r.archivedAt ? `round-${r.marketTopicId}.json` : '期后写入独立文件')); reason.className = 'paper-reason';
  }
}
$('#paper-filter').onchange = () => { paperPage = 1; renderPaper(); };
$('#paper-page-size').onchange = () => { paperPage = 1; renderPaper(); };
$('#paper-page-number').onchange = event => { paperPage = Number(event.target.value); renderPaper(); };
$('#paper-page-prev').onclick = () => { paperPage--; renderPaper(); };
$('#paper-page-next').onclick = () => { paperPage++; renderPaper(); };
$('#paper-reset').onclick = async () => {
  $('#paper-reset').disabled = true; $('#paper-toggle').disabled = true;
  try {
    await api('/api/paper/reset', {});
    paperPage = 1; paperRowsSignature = ''; paperConsoleSeen.clear();
    await reload(); toast('模拟记录与统计已归零，设置已保留；当前场次不再交易');
  } catch (error) { toast(error.message, true); }
  finally { $('#paper-reset').disabled = false; $('#paper-toggle').disabled = false; }
};
$('#paper-toggle').onclick = async () => { try { $('#paper-toggle').disabled = true; await api('/api/paper/config', { enabled: !state.paper.enabled }); await reload(); toast(state.paper.enabled ? '模拟已启动，按当前设置执行' : '模拟已停止，已有成交继续等待结算'); } catch (e) { toast(e.message, true); } finally { $('#paper-toggle').disabled = false; } };
$('#paper-form').onsubmit = async event => { event.preventDefault(); const fields = Object.fromEntries(new FormData(event.target)); const settings = { ...state.paper.settings, ...fields }; settings.fallbackEnabled = fields.strategyMode === 'TOUCH_LIMIT' ? state.paper.settings.fallbackEnabled : $('#paper-form').elements.namedItem('fallbackEnabled').checked; for (const key of Object.keys(settings)) { if (['fallbackEnabled', 'strategyMode'].includes(key)) continue; if (settings[key] === '') delete settings[key]; else settings[key] = Number(settings[key]); } if (settings.slippagePercent !== undefined) { settings.slippageBps = Math.round(settings.slippagePercent * 100); delete settings.slippagePercent; } try { await api('/api/paper/config', { enabled: state.paper.enabled, settings }); await reload(); toast('模拟设置已保存，尚未尝试的场次按新设置执行'); } catch (e) { toast(e.message, true); } };
await reload(); setInterval(reload, 1500); setInterval(updateClock, 250);
