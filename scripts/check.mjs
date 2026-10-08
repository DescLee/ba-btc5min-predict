import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await check(file);
    else if (/\.(mjs|js)$/.test(file)) {
      const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (r.status !== 0) process.exit(1);
    }
  }
}
for (const dir of ['server', 'public', 'strategies', 'test']) await check(dir);
console.log('JavaScript 语法检查通过');
