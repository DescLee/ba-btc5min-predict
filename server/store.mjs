import { mkdir, readFile, writeFile, rename, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
export class Store {
  constructor(dir) { this.dir = dir; this.state = { orders: [], strategy: null }; this.tail = Promise.resolve(); }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('本地状态文件损坏，停止启动以保护订单记录'); }
    if (!Array.isArray(this.state.orders)) throw new Error('本地订单记录无效');
  }
  save() {
    const content = JSON.stringify(this.state, null, 2);
    const operation = this.tail.then(async () => {
      const temp = join(this.dir, 'state.tmp');
      await writeFile(temp, content, { mode: 0o600 }); await rename(temp, join(this.dir, 'state.json'));
    });
    this.tail = operation.catch(() => {}); return operation;
  }
  async audit(event) {
    await appendFile(join(this.dir, 'events.jsonl'), JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 });
  }
  async clearPaperArchives() { await rm(join(this.dir, 'paper-trades'), { recursive: true, force: true }); }
  async archivePaper(record) {
    if (!/^\d+$/.test(record.marketTopicId)) throw new Error('模拟场次 ID 无效');
    const dir = join(this.dir, 'paper-trades'); await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `round-${record.marketTopicId}.json`);
    const { archiveVersion, ...clean } = record;
    await writeFile(`${path}.tmp`, JSON.stringify({ schemaVersion: 1, exportedAt: Date.now(), record: clean }, null, 2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  paperExport() { return JSON.stringify({ schemaVersion: 1, exportedAt: Date.now(), records: this.state.paper?.records || [] }, null, 2); }
}
