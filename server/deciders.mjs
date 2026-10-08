import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export function runCustom(state) {
  return new Promise(resolve => {
    const worker = new Worker(new URL('./custom-worker.mjs', import.meta.url), { workerData: state, env: {}, resourceLimits: { maxOldGenerationSizeMb: 32 } });
    const finish = result => { clearTimeout(timer); worker.terminate(); resolve(result); };
    const timer = setTimeout(() => finish({ action: 'SKIP', reason: '自定义策略超时' }), 500);
    worker.once('message', result => finish(['BUY_UP', 'BUY_DOWN', 'SKIP'].includes(result?.action) ? { action: result.action, reason: String(result.reason || '').slice(0, 200) } : { action: 'SKIP', reason: '自定义策略返回格式无效' }));
    worker.once('error', () => finish({ action: 'SKIP', reason: '自定义策略执行失败' }));
  });
}
export async function runJev(state, config) {
  const started = Date.now();
  try {
    const spec = fileURLToPath(new URL('../strategies/jev.json', import.meta.url));
    const { stdout } = await exec(config.jevCommand, ['run', spec, '--json', '-s', JSON.stringify(state)], {
      timeout: config.jevTimeout, maxBuffer: 128000,
      env: { ...process.env, BINANCE_API_KEY: '', BINANCE_API_SECRET: '' }
    });
    const result = JSON.parse(stdout);
    const answer = result.answers?.action || result.questions?.action || result.action;
    if (!answer || !['BUY_UP', 'BUY_DOWN', 'SKIP'].includes(answer.choice) || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) throw new Error('format');
    const action = answer.confidence >= config.jevConfidence ? answer.choice : 'SKIP';
    return { action, confidence: answer.confidence, probabilities: answer.probabilities, latencyMs: Date.now() - started, reason: action === 'SKIP' ? 'jev 跳过或判断置信度不足' : 'jev 判断通过（置信度不代表交易胜率）' };
  } catch { return { action: 'SKIP', latencyMs: Date.now() - started, reason: 'jev 未配置、超时或返回格式无效' }; }
}
