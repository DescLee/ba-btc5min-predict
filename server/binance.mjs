import { createHmac } from 'node:crypto';
const PUBLIC_ROOT = 'https://data-api.binance.vision';
const networkReason = error => error.name === 'TimeoutError' ? '请求超时' : error.cause?.code === 'ECONNRESET' ? '连接被重置（ECONNRESET）' : error.cause?.code === 'ECONNREFUSED' ? '连接被拒绝（ECONNREFUSED）' : error.message;
const ROOT = '/sapi/v1/w3w/wallet/prediction';
export function toWei(value) {
  const text = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(text) || Number(text) <= 0) throw new Error('金额须大于零，最多保留 6 位小数');
  const [whole, fraction = ''] = text.split('.');
  return (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))).toString();
}
export function fromWei(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('接口金额格式无效');
  return Number(BigInt(value)) / 1e18;
}
export class BinanceClient {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; this.offset = 0; }
  async syncTime() {
    const r = await this.fetcher(`${PUBLIC_ROOT}/api/v3/time`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`币安时间同步失败 HTTP ${r.status}`);
    const data = await r.json();
    if (!Number.isFinite(data.serverTime)) throw new Error('币安时间响应无效');
    // 首次 DNS/TLS 建连并非对称网络延迟，不能取整个请求的中点。
    // 使用收到响应时的服务器时间，签名略落后，避免超前 1000ms 被拒绝。
    this.offset = data.serverTime - Date.now();
  }
  now() { return Math.floor(Date.now() + this.offset); }
  async request(path, params = {}, method = 'GET', retryTime = true) {
    if (!this.config.apiKey || !this.config.apiSecret) throw new Error('未配置币安 API Key / Secret');
    const query = new URLSearchParams({ timestamp: String(this.now()), recvWindow: '5000' });
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) (method === 'GET' ? query : body).set(k, String(v));
    const payload = query.toString() + body.toString();
    query.set('signature', createHmac('sha256', this.config.apiSecret).update(payload).digest('hex'));
    const r = await this.fetcher(`https://api.binance.com${ROOT}${path}?${query}`, {
      method, headers: { 'X-MBX-APIKEY': this.config.apiKey, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body: body.toString() } : {}), signal: AbortSignal.timeout(5000)
    }).catch(error => { throw new Error(`币安预测接口连接失败：${networkReason(error)}`); });
    const data = await r.json();
    if (data.code === -1021 && method === 'GET' && retryTime) {
      await this.syncTime(); return this.request(path, params, method, false);
    }
    if (!r.ok || (typeof data.code === 'number' && data.code < 0)) {
      const error = new Error(`币安接口错误 ${data.code ?? r.status}：${String(data.msg || '请求失败').slice(0, 240)}`);
      error.upstreamCode = data.code; throw error;
    }
    return data;
  }
  wallets() { return this.request('/wallet/list'); }
  markets(offset = 0) { return this.request('/market/list', { l1Category: 'crypto', l2Category: 'up-down', sortBy: 'END_DATE', orderBy: 'ASC', offset, limit: 100 }); }
  detail(id) { return this.request('/market/detail', { marketTopicId: id }); }
  book(topic, outcome) { return this.request('/order-book', { vendor: topic.vendor.toLowerCase(), marketId: outcome.marketId, tokenId: outcome.tokenId }); }
  quote(params) { return this.request('/trade/get-quote', params, 'POST'); }
  place(params) { return this.request('/trade/place-order-bundle', params, 'POST'); }
  orders(walletAddress, history = false, offset = 0) { return this.request(history ? '/order/history' : '/order/list', { walletAddress, offset, limit: 100 }); }
  positions(walletAddress) { return this.request('/position/list', { walletAddress, limit: 100 }); }
  async spot() {
    const r = await this.fetcher(`${PUBLIC_ROOT}/api/v3/ticker/price?symbol=BTCUSDT`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`BTC 参考行情失败 HTTP ${r.status}`);
    const data = await r.json();
    if (!Number.isFinite(Number(data.price)) || Number(data.price) <= 0) throw new Error('BTC 参考行情无效');
    return { price: Number(data.price), receivedAt: this.now(), source: 'BINANCE_SPOT', endpoint: 'data-api.binance.vision', timestampKind: '接收时间（接口未提供成交时间）' };
  }
}
export function isBtcFiveMinute(topic) {
  return topic.symbol === 'BTCUSDT' && topic.chartType === 'CRYPTO_UP_DOWN' && Number(topic.endDate) - Number(topic.startDate) === 300000;
}
// 仅接受明确方向名称。禁止按数组顺序或 YES/NO 位置猜测。
export function mapOutcomes(topic) {
  const result = {};
  const nameDirection = name => ({ UP: 'UP', DOWN: 'DOWN', 涨: 'UP', 跌: 'DOWN' })[String(name).trim().toUpperCase()];
  for (const market of topic.markets || []) {
    const marketDirection = nameDirection(market.title);
    for (const outcome of market.outcomes || []) {
      let direction = nameDirection(outcome.name);
      if (!direction && marketDirection && String(outcome.name).toUpperCase() === 'YES') direction = marketDirection;
      if (!direction || !outcome.tokenId) continue;
      if (result[direction]) throw new Error(`市场 ${direction} 方向映射不唯一，需要核对实际响应`);
      result[direction] = { direction, tokenId: String(outcome.tokenId), marketId: market.marketId, tradingStatus: market.tradingStatus, price: Number(outcome.price) };
    }
  }
  if (!result.UP || !result.DOWN || result.UP.tokenId === result.DOWN.tokenId) throw new Error('无法明确识别涨／跌两个方向，已禁止交易');
  return result;
}
