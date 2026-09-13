import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { JsonlRpcClient } from '../src/adapters/rpc-client.mjs';
import { CodexAdapter } from '../src/adapters/codex.mjs';

test('effective Codex model and provider survive thread creation and resume', async () => {
  const adapter = new CodexAdapter(), requests = [];
  adapter.client = { connected: true, async request(method, params) {
    requests.push({ method, params });
    return { thread: { id: 'thread-1', model: null }, model: 'effective-model', modelProvider: 'configured-provider' };
  } };
  const thread = await adapter.createThread({ cwd: process.cwd() });
  assert.equal(thread.model, 'effective-model');
  assert.equal(thread.modelProvider, 'configured-provider');
  await adapter.resumeThread({ cwd: process.cwd(), threadId: thread.id, model: thread.model, modelProvider: thread.modelProvider });
  assert.equal(requests[1].params.model, 'effective-model');
  assert.equal(requests[1].params.modelProvider, 'configured-provider');
  assert.equal(requests[1].params.approvalPolicy, 'on-request');
});

test('real child-process JSONL supports fragmented UTF-8, errors and bidirectional approvals', async t => {
  const rpc = new JsonlRpcClient({ command: process.execPath, args: [resolve('test/fixtures/app-server.mjs')], timeoutMs: 1000 });
  t.after(() => rpc.close());
  let diagnostics = 0; rpc.on('diagnostic', () => diagnostics++);
  const initialized = await rpc.connect(); assert.equal(initialized.userAgent, 'fixture/0.153.4');
  assert.deepEqual(await rpc.request('test/unicode', {}), { text: '断流恢复 ✓' });
  await assert.rejects(rpc.request('test/error', {}), error => error.code === -32001 && !error.uncertain);
  rpc.on('request', request => rpc.respond(request.id, { decision: 'decline' }));
  assert.deepEqual(await rpc.request('test/request', {}), { decision: 'decline' });
  assert.equal(diagnostics, 1);
});

test('RPC timeout removes pending calls and marks delivery uncertain', async t => {
  const rpc = new JsonlRpcClient({ command: process.execPath, args: [resolve('test/fixtures/app-server.mjs')], timeoutMs: 1000 });
  t.after(() => rpc.close()); await rpc.connect();
  await assert.rejects(rpc.request('test/hang', {}, 30), error => error.uncertain && error.code === 'rpc_timeout');
  assert.equal(rpc.pending.size, 0);
});

test('child exit rejects pending calls without leaving timers or transport open', async t => {
  const rpc = new JsonlRpcClient({ command: process.execPath, args: [resolve('test/fixtures/app-server.mjs')], timeoutMs: 1000 });
  t.after(() => rpc.close()); await rpc.connect();
  await assert.rejects(rpc.request('test/disconnect', {}), error => error.uncertain);
  assert.equal(rpc.connected, false); assert.equal(rpc.pending.size, 0);
});
