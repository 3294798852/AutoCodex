import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDashboardServer } from '../src/server/http.mjs';
import { JsonlRpcClient } from '../src/adapters/rpc-client.mjs';
import { request as rawRequest } from 'node:http';
import { harness } from './helpers.mjs';

async function fixture(t) {
  const h = await harness(t);
  const http = createDashboardServer(h.supervisor, { port: 0 });
  const address = await http.listen(); t.after(() => http.close());
  const connection = JSON.parse(readFileSync(join(h.directory, 'connection.json'), 'utf8'));
  const request = (path, { plugin = false, ...options } = {}) => fetch(`${address.origin}${path}`, {
    ...options, headers: { Authorization: `Bearer ${plugin ? connection.pluginToken : connection.token}`, ...options.headers },
  });
  return { ...h, http, address, connection, request };
}

test('existing conversation API lists and monitors without sending; cross-site and plugin control stay denied', async t => {
  const h = await fixture(t), id = 'external-http', path = join(h.directory, 'rollout.jsonl');
  const meta = { id, path, name: 'HTTP existing', cwd: h.directory, updatedAt: Date.now() / 1000 };
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
  h.adapter.listThreads = async () => ({ data: [meta], nextCursor: null });
  h.adapter.readThreadSummary = async () => meta;
  assert.equal((await h.request('/api/v1/threads', { plugin: true })).status, 403);
  assert.equal((await h.request('/api/v1/threads', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const listed = await (await h.request('/api/v1/threads')).json(); assert.equal(listed.data[0].id, id);
  const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: id }) };
  assert.equal((await h.request('/api/v1/observations', { ...post, plugin: true })).status, 403);
  const added = await h.request('/api/v1/observations', post); assert.equal(added.status, 201);
  const task = await added.json(); assert.equal(task.controlMode, 'observe'); assert.equal(h.adapter.sent.length, 0);
  const duplicate = await (await h.request('/api/v1/observations', post)).json(); assert.equal(duplicate.id, task.id);
  const forbidden = await h.request(`/api/v1/tasks/${task.id}/control`, { ...post, body: '{"action":"continue"}' }); assert.equal(forbidden.status, 409);
  const abort = new AbortController(), stream = await h.request('/api/v1/events', { signal: abort.signal }), reader = stream.body.getReader();
  try {
    await reader.read();
    appendFileSync(path, JSON.stringify({ type: 'event_msg', timestamp: new Date(h.now()).toISOString(), payload: { type: 'task_complete', error: { message: 'HTTP 503 fixture' } } }) + '\n');
    await h.supervisor.existing.poll(task.id);
    const chunk = new TextDecoder().decode((await reader.read()).value); assert(chunk.includes('observed_error'));
    assert.equal(h.adapter.sent.length, 0);
  } finally { await reader.cancel(); abort.abort(); }
});

test('loopback API enforces authentication, Origin, Host, body limit and plugin scope', async t => {
  const h = await fixture(t);
  assert.equal((await fetch(`${h.address.origin}/api/v1/state`)).status, 401);
  assert.equal((await h.request('/api/v1/state', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = rawRequest(`${h.address.origin}/api/v1/state`, { headers: { Host: 'attacker.example', Authorization: `Bearer ${h.connection.token}` } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await h.request('/api/v1/state', { plugin: true })).status, 200);
  assert.equal((await h.request('/api/v1/tasks', { plugin: true, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await h.request('/api/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ huge: 'x'.repeat(70000) }) })).status, 413);
  const page = await fetch(h.address.origin);
  assert.equal(page.status, 200); assert(page.headers.get('content-security-policy').includes("script-src 'self'"));
  const exchange = await fetch(`${h.address.origin}/api/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.address.origin }, body: JSON.stringify({ token: h.connection.token }) });
  assert.equal(exchange.status, 200); assert(exchange.headers.get('set-cookie').includes('HttpOnly; SameSite=Strict'));
  const state = await (await h.request('/api/v1/state')).text(); assert(!state.includes(h.connection.token)); assert(!state.includes(h.connection.pluginToken));
});

test('writer conflicts return actionable 409 without binding or modifying the original task', async t => {
  const h = await fixture(t), id = 'foreign-writer', path = join(h.directory, 'writer.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
  const thread = { id, path, cwd: h.directory, status: { type: 'notLoaded' }, turns: [] };
  h.adapter.readThreadSummary = async () => thread; h.adapter.readThread = async () => thread;
  h.adapter.resumeThread = async () => { throw new Error(`thread ${id} already has an active writer`); };
  const task = await h.supervisor.existing.add({ threadId: id });
  const response = await h.request(`/api/v1/tasks/${task.id}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'adopt', ownershipConfirmed: true }) });
  assert.equal(response.status, 409); const result = await response.json(); assert.equal(result.code, 'thread_in_use'); assert.match(result.error, /保持监测/);
  assert.equal(h.store.task(task.id).controlMode, 'observe'); assert.equal(h.adapter.sent.length, 0);
});

test('local-file document navigation can open the public panel while cross-site API and embedded requests stay blocked', async t => {
  const h = await fixture(t);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  // Node fetch overwrites Sec-Fetch-Mode; raw HTTP reproduces browser navigation metadata.
  const request = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = rawRequest(h.address.origin + path, { method, headers: { ...navigation, ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject); req.end(body);
  });
  for (const path of ['/', '/index.html', '/history/fixture-thread']) {
    const response = await request(path);
    assert.equal(response.status, 200, path); assert(response.headers['content-type'].includes('text/html'));
    assert(!response.body.includes(h.connection.token)); assert(!response.body.includes(h.connection.pluginToken));
    assert.equal(response.headers['x-frame-options'], 'DENY');
  }
  const authenticated = { Authorization: 'Bearer ' + h.connection.token };
  assert.equal((await request('/api/v1/state', { headers: authenticated })).status, 403);
  assert.equal((await request('/api/v1/events', { headers: authenticated })).status, 403);
  assert.equal((await request('/api/v1/dnd', { method: 'POST', headers: { ...authenticated, 'Content-Type': 'application/json' }, body: '{"revision":0,"commonCommands":true}' })).status, 403);
  assert.equal(h.supervisor.dnd.commonCommands, false);
  assert.equal((await request('/', { headers: { 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
  assert.equal((await request('/', { headers: { 'Sec-Fetch-Mode': 'cors' } })).status, 403);
  assert.equal((await request('/dashboard.mjs')).status, 403);
  assert.equal((await request('/api/v1/session', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: h.connection.token }) })).status, 403);
});

test('SSE initial snapshot and mutations arrive in under one second', async t => {
  const h = await fixture(t), abort = new AbortController();
  t.after(() => abort.abort());
  const response = await h.request('/api/v1/events', { signal: abort.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader(); await reader.read();
  const start = performance.now(); const task = await h.create();
  let buffer = '';
  while (!buffer.includes(task.id)) {
    const result = await reader.read(); assert(!result.done); buffer += new TextDecoder().decode(result.value);
  }
  const latency = performance.now() - start;
  assert(latency < 1000, `SSE update took ${latency} ms`);
  await reader.cancel(); abort.abort();
});

test('MCP bridge performs real stdio handshake and scoped local checkpoint roundtrip', async t => {
  const h = await fixture(t), task = await h.create();
  const bridge = new JsonlRpcClient({ command: process.execPath, args: [resolve('plugins/autocodex-guard/scripts/bridge.mjs')], env: { ...process.env, AUTOCODEX_CONNECTION_FILE: h.address.connectionPath }, timeoutMs: 2000 });
  t.after(() => bridge.close());
  const init = await bridge.connect(); assert.equal(init.serverInfo.name, 'autocodex-guard');
  const list = await bridge.request('tools/list', {}); assert.equal(list.tools.length, 3);
  const status = await bridge.request('tools/call', { name: 'guard_status', arguments: { taskId: task.id } });
  assert.equal(status.isError, false); assert(status.content[0].text.includes(task.id));
  const checkpoint = await bridge.request('tools/call', { name: 'guard_checkpoint', arguments: { taskId: task.id, text: 'Core complete; UI verified.' } });
  assert.equal(checkpoint.isError, false); assert.equal(h.store.records('checkpoints', task.id)[0].text, 'Core complete; UI verified.');
  const missing = await bridge.request('tools/call', { name: 'guard_checkpoint', arguments: { text: 'ambiguous' } });
  assert.equal(missing.isError, true);
});

test('SSE p95 over twenty ordered updates stays below one second', async t => {
  const h = await fixture(t), task = await h.create(), abort = new AbortController();
  const response = await h.request('/api/v1/events', { signal: abort.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffered = '';
  const nextSnapshot = async () => {
    while (true) {
      const boundary = buffered.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) return JSON.parse(data.slice(6));
      } else {
        const chunk = await reader.read(); assert(!chunk.done); buffered += decoder.decode(chunk.value, { stream: true });
      }
    }
  };
  try {
    await nextSnapshot();
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const marker = `[latency:${i}:]`, start = performance.now();
      h.adapter.notify('item/agentMessage/delta', { threadId: task.threadId, turnId: task.turnId, delta: marker });
      await h.flush();
      while (!(await nextSnapshot()).tasks.find(item => item.id === task.id).lastOutput.includes(marker)) {}
      samples.push(performance.now() - start);
    }
    const sorted = [...samples].sort((a, b) => a - b), p95 = sorted[Math.ceil(sorted.length * .95) - 1];
    assert(p95 < 1000, `SSE p95 ${p95} ms`);
    writeFileSync(resolve('.work/latency-report.json'), JSON.stringify({ measuredAt: new Date().toISOString(), samples: 20, p50Ms: Math.round(sorted[9]), p95Ms: Math.round(p95), maxMs: Math.round(sorted.at(-1)), scope: 'single local client; mock Codex adapter; real HTTP SSE' }, null, 2));
  } finally { await reader.cancel(); abort.abort(); }
});

test('large multi-task SSE snapshots drain completely and keep delivering new output', { timeout: 10000 }, async t => {
  const h = await fixture(t), abort = new AbortController();
  t.after(() => abort.abort());
  const tasks = [];
  for (let i = 0; i < 10; i++) tasks.push(await h.create({ name: `Large task ${i}`, prompt: `Project ${i}: ${'detailed objective '.repeat(600)}` }));
  const response = await h.request('/api/v1/events', { signal: abort.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  const next = async () => {
    while (true) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) return JSON.parse(data.slice(6));
      } else {
        const chunk = await reader.read(); assert(!chunk.done, 'stream must stay open');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
  };
  try {
    const initial = await next(); assert.equal(initial.tasks.length, 10);
    assert(Buffer.byteLength(JSON.stringify(initial)) > 65536);
    assert(!('buffers' in initial.tasks[0].outputMonitor));
    const task = tasks[0], marker = 'New verified project output is delivered after the large snapshot.';
    h.adapter.notify('item/agentMessage/delta', { threadId: task.threadId, turnId: task.turnId, delta: marker }); await h.flush();
    while (!(await next()).tasks.find(item => item.id === task.id).lastOutput.includes(marker)) {}
  } finally { await reader.cancel(); abort.abort(); }
});
