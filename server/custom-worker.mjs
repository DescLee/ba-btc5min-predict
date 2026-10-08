import { parentPort, workerData } from 'node:worker_threads';
try {
  const { decide } = await import('../strategies/custom.mjs');
  const result = await decide(workerData);
  parentPort.postMessage(result);
} catch { parentPort.postMessage({ action: 'SKIP', reason: '自定义策略执行异常' }); }
