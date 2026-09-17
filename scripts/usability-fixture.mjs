import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/core/store.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';
import { ControlledAdapter } from '../test/helpers.mjs';
import { createDashboardServer } from '../src/server/http.mjs';
import { ProtocolRelay } from '../src/desktop/protocol-relay.mjs';

export async function fixture() {
  mkdirSync('.work', { recursive: true });
  const directory = mkdtempSync(resolve('.work/usability-')), store = new Store(join(directory, 'guard')), adapter = new ControlledAdapter(); adapter.mode = 'codex';
  for (const [id, name] of [['root', '网站开发 · 等待子代理交付'], ['other', '文档整理 · 尚未监测']]) {
    const path = join(directory, id + '.jsonl'); writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
    adapter.threads.set(id, { id, path, cwd: directory, name, turns: [], updatedAt: Date.now() / 1000 });
  }
  adapter.readThreadSummary = id => adapter.readThread(id);
  adapter.listThreads = async () => ({ data: [...adapter.threads.values()], nextCursor: null });
  const supervisor = new Supervisor({ store, adapter }), http = createDashboardServer(supervisor, { port: 0 });
  const address = await http.listen();
  const task = await supervisor.existing.add({ threadId: 'root' });
  await supervisor.desktop.configure(task.id, { revision: 0, autoContinue: true, autoApprove: true });
  const relay = new ProtocolRelay({ toServer: () => {}, toDesktop: () => {} }), events = []; let seq = 0;
  relay.on('event', e => events.push({ ...e, seq: ++seq }));
  const poll = () => supervisor.desktop.poll({ relayId: relay.id, pid: process.pid, workerPid: process.pid, threads: relay.snapshots(), events: events.splice(0) });
  const notify = (method, threadId, params = {}) => relay.fromServer({ method, params: { threadId, ...params } });
  const start = (id, turnId = id + '-turn') => notify('turn/started', id, { turn: { id: turnId } });
  relay.rememberThread({ id: 'root', cwd: directory, name: task.name }); start('root');
  relay.rememberThread({ id: 'other', cwd: directory, name: '文档整理 · 尚未监测' });
  relay.rememberThread({ id: 'child', parentThreadId: 'root', name: '验证工程师', cwd: directory }); start('child'); await poll();
  notify('item/completed', 'child', { item: { id: 'result', type: 'agentMessage', text: '已完成页面验证，正在汇总检查结果。' } }); await poll();
  const timer = setInterval(() => void poll(), 250);
  return { directory, store, supervisor, address, task, relay, poll, notify, start,
    async close() { clearInterval(timer); relay.close(); await supervisor.close(); await http.close(); store.close(); } };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const f = await fixture();
  writeFileSync(join(f.directory, 'fixture.json'), JSON.stringify({ connectionPath: f.address.connectionPath, origin: f.address.origin }));
  console.log(JSON.stringify({ directory: f.directory, connectionPath: f.address.connectionPath, origin: f.address.origin }));
  process.on('SIGINT', async () => { await f.close(); process.exit(); });
  process.on('SIGTERM', async () => { await f.close(); process.exit(); });
}
