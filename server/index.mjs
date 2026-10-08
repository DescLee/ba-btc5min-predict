import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
const config = readConfig();
const store = new Store(fileURLToPath(new URL('../data/', import.meta.url)));
await store.init();
const engine = new Engine(config, store);
const token = randomBytes(32).toString('hex');
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.ico': ['favicon.svg', 'image/svg+xml'] };
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const hosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  if (!hosts.includes(req.headers.host)) return json(res, 403, { error: '仅允许本地访问' });
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  try {
    if (req.method === 'GET' && assets[pathname]) {
      const [name, type] = assets[pathname];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      return res.end(await readFile(new URL(`../public/${name}`, import.meta.url)));
    }
    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, { ...engine.publicState(), sessionToken: token });
    if (req.method === 'GET' && pathname === '/api/paper/export') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="paper-trades.json"', 'Cache-Control': 'no-store' });
      return res.end(store.paperExport());
    }
    if (req.method !== 'POST' || !pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在' });
    if (req.headers['x-workbench-token'] !== token || req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`)) return json(res, 403, { error: '会话无效，请刷新页面' });
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: '仅接受 JSON' });
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 16000) throw new Error('请求过大'); }
    const body = JSON.parse(text || '{}');
    let result;
    switch (pathname) {
      case '/api/refresh': await engine.refresh(); result = engine.publicState(); break;
      case '/api/quote': result = await engine.prepareQuote(body); break;
      case '/api/order': result = await engine.submit(body.quoteId); break;
      case '/api/strategy': result = await engine.saveStrategy(body); break;
      case '/api/auto': await engine.setAuto(body.enabled); result = { enabled: engine.auto }; break;
      case '/api/strategy/preview': result = await engine.tickStrategy(true); break;
      case '/api/demo/scenario': engine.demoScenario(body); result = engine.publicState(); break;
      case '/api/orders/reconcile': result = await engine.resolveUnknown(body); break;
      case '/api/paper/reset': result = await engine.paper.reset(); break;
      case '/api/paper/config': result = await engine.paper.configure(body); break;
      default: return json(res, 404, { error: '接口不存在' });
    }
    json(res, 200, result);
  } catch (error) { json(res, 400, { error: error.message }); }
});
server.requestTimeout = 10000;
server.listen(config.port, '127.0.0.1', () => console.log(`BTC 5分钟交易工作台：http://127.0.0.1:${config.port} · ${config.mode === 'demo' ? '演示模式' : '真实接口模式'}`));
const btcTimer = setInterval(() => { if (config.btcPriceMode === 'live' || config.mode === 'live') engine.refreshBtc().catch(() => {}); }, config.pollMs);
await engine.refresh();
const refreshTimer = setInterval(() => engine.refresh().catch(() => {}), config.pollMs);
const strategyTimer = setInterval(() => engine.tickStrategy().catch(() => {}), 500);
const paperTimer = setInterval(() => engine.paper.tick().catch(() => {}), 500);
await store.save();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { engine.auto = false; clearInterval(btcTimer); clearInterval(refreshTimer); clearInterval(strategyTimer); clearInterval(paperTimer); server.close(async () => { await store.tail; process.exit(0); }); });
