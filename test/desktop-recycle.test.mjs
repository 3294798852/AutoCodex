import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tempDirectory } from './helpers.mjs';

async function fixture(t) {
  const tmp = tempDirectory(), config = join(tmp.directory, 'relay.json'), directory = join(tmp.directory, 'guard');
  mkdirSync(directory); writeFileSync(config, JSON.stringify({ connectionFile: join(directory, 'connection.json') }));
  const path = join(tmp.directory, 'fixture.txt'); writeFileSync(path, 'preserved');
  const child = spawn(process.execPath, ['src/desktop/recycle-server.mjs'], { windowsHide: true,
    env: { ...process.env, AUTOCODEX_RECYCLE_CONFIG: config, AUTOCODEX_RECYCLE_SECRET: 'fixture-secret' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve)), messages = [], waiters = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const value = JSON.parse(line), index = waiters.findIndex(w => w.filter(value));
    if (index < 0) messages.push(value); else { const w = waiters.splice(index, 1)[0]; clearTimeout(w.timer); w.resolve(value); } });
  const next = filter => new Promise((resolve, reject) => {
    const index = messages.findIndex(filter); if (index >= 0) { resolve(messages.splice(index, 1)[0]); return; }
    const timer = setTimeout(() => reject(new Error('MCP fixture timed out')), 3000); waiters.push({ filter, resolve, timer });
  });
  t.after(async () => { child.stdin.end(); child.kill(); await exited; lines.close(); for (const w of waiters) clearTimeout(w.timer); tmp.remove(); });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  return { path, directory, send, next };
}

test('desktop recycle cancellation releases the pending confirmation without changing files', { skip: process.platform !== 'win32' }, async t => {
  const h = await fixture(t);
  h.send({ id: 1, method: 'tools/call', params: { name: 'recycle', arguments: { paths: [h.path] } } });
  await h.next(m => m.method === 'elicitation/create');
  h.send({ method: 'notifications/cancelled', params: { requestId: 1 } });
  const response = await h.next(m => m.id === 1);
  assert.equal(response.result.structuredContent.state, 'cancelled'); assert.equal(readFileSync(h.path, 'utf8'), 'preserved');
  h.send({ id: 2, method: 'tools/call', params: { name: 'recycle', arguments: { paths: [h.path] } } });
  const confirm = await h.next(m => m.method === 'elicitation/create');
  h.send({ id: confirm.id, result: { action: 'decline' } });
  assert.equal((await h.next(m => m.id === 2)).result.structuredContent.state, 'cancelled');
});

test('desktop recycle unresolved journal prevents a second execution', { skip: process.platform !== 'win32' }, async t => {
  const h = await fixture(t), key = createHash('sha256').update(JSON.stringify([h.path])).digest('hex');
  const journals = join(h.directory, 'desktop-recycle-journal'); mkdirSync(journals, { recursive: true });
  writeFileSync(join(journals, key + '.json'), JSON.stringify({ state: 'executing', id: 'previous' }));
  h.send({ id: 1, method: 'tools/call', params: { name: 'recycle', arguments: { paths: [h.path] } } });
  const response = await h.next(m => m.id === 1);
  assert.equal(response.result.isError, true); assert.equal(response.result.structuredContent.state, 'uncertain'); assert(existsSync(h.path));
});
