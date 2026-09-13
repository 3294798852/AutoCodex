import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';
import { ControlledAdapter, tempDirectory, STREAM } from './helpers.mjs';

test('WAL survives abrupt process exit; uncommitted writes and receipts roll back together', t => {
  const tmp = tempDirectory('crash-'); t.after(() => tmp.remove());
  const result = spawnSync(process.execPath, [resolve('test/fixtures/crash-store.mjs'), tmp.directory], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 9, result.stderr);
  const store = new Store(tmp.directory);
  try {
    assert.equal(store.getMeta('committed'), 'durable');
    assert.equal(store.receipt('committed-receipt', 3), false);
    assert.equal(store.receipt('uncommitted-receipt', 3), true);
  } finally { store.close(); }
});

test('same data directory rejects concurrent supervisor instances', t => {
  const tmp = tempDirectory('lock-'); t.after(() => tmp.remove());
  const store = new Store(tmp.directory);
  try { assert.throws(() => new Store(tmp.directory), /已由进程/); }
  finally { store.close(); }
});

test('nested transactions keep dedupe receipts atomic with task changes', t => {
  const tmp = tempDirectory('transaction-'); t.after(() => tmp.remove()); const store = new Store(tmp.directory);
  try {
    assert.throws(() => store.transaction(() => { store.receipt('once', 1); store.transaction(() => store.setMeta('value', 'changed')); throw new Error('disk simulation'); }));
    assert.equal(store.receipt('once', 2), true); assert.equal(store.getMeta('value'), undefined);
  } finally { store.close(); }
});

test('restart restores a scheduled retry without resetting its counters', async t => {
  const tmp = tempDirectory('restart-'); t.after(() => tmp.remove());
  const adapter = new ControlledAdapter(); let now = 1000;
  let store = new Store(tmp.directory), supervisor = new Supervisor({ store, adapter, now: () => now, random: () => 0 });
  const task = await supervisor.createTask({ name: 'restart', prompt: 'continue project', cwd: process.cwd(), policy: { baseDelayMs: 50 } });
  adapter.finish(task.threadId, 'failed', STREAM);
  await new Promise(resolve => setImmediate(resolve)); await Promise.all([...supervisor.queues.values()]);
  const due = store.task(task.id).retryDueAt;
  await supervisor.close(); store.close();
  store = new Store(tmp.directory); supervisor = new Supervisor({ store, adapter, now: () => now, random: () => 0 });
  try {
    await supervisor.recover(); assert.equal(store.task(task.id).retryDueAt, due);
    assert.equal(store.task(task.id).incident.consecutiveSame, 1);
    assert.equal(store.task(task.id).incident.recentErrors[0].at, 1000);
    now = due; supervisor.tick(); await new Promise(resolve => setImmediate(resolve)); await Promise.all([...supervisor.queues.values()]);
    assert.equal(adapter.sent.length, 2); assert.equal(store.task(task.id).totalAutoAttempts, 1);
  } finally { await supervisor.close(); store.close(); }
});

test('restart retains the output deadline and a latched protection cannot be resumed', async t => {
  const tmp = tempDirectory('deadline-'); t.after(() => tmp.remove());
  const adapter = new ControlledAdapter(); let now = 1000;
  let store = new Store(tmp.directory), supervisor = new Supervisor({ store, adapter, now: () => now });
  const task = await supervisor.createTask({ prompt: 'keep working', cwd: process.cwd(), policy: { noOutputTimeoutMs: 1000 } });
  await new Promise(resolve => setImmediate(resolve)); await Promise.all([...supervisor.queues.values()]);
  await supervisor.close(); store.close();
  now = 2001; store = new Store(tmp.directory); supervisor = new Supervisor({ store, adapter, now: () => now });
  await supervisor.recover(); supervisor.tick(); await new Promise(resolve => setImmediate(resolve)); await Promise.all([...supervisor.queues.values()]);
  assert.equal(store.task(task.id).outputMonitor.sinceAt, 1000);
  assert.equal(store.task(task.id).outputMonitor.blocked, true);
  await supervisor.close(); store.close();
  store = new Store(tmp.directory); supervisor = new Supervisor({ store, adapter, now: () => now });
  try {
    await supervisor.recover();
    assert.equal(store.task(task.id).outputMonitor.blocked, true);
    await assert.rejects(supervisor.control(task.id, 'resume'), /长期无输出/);
    assert.equal(adapter.sent.length, 1);
  } finally { await supervisor.close(); store.close(); }
});

test('legacy counters are not misread as new evidence and a pending old replacement is held', async t => {
  const tmp = tempDirectory('upgrade-'); t.after(() => tmp.remove());
  const store = new Store(tmp.directory), adapter = new ControlledAdapter();
  let supervisor = new Supervisor({ store, adapter, now: () => 1000 });
  const task = await supervisor.createTask({ prompt: 'legacy task', cwd: process.cwd() });
  await new Promise(resolve => setImmediate(resolve)); await Promise.all([...supervisor.queues.values()]);
  await supervisor.close();
  const legacy = store.task(task.id);
  legacy.incident = { id: legacy.incident.id, autoAttempts: 2, consecutiveSame: 2, lastRetryCategory: 'stream_disconnected', replacements: 0 };
  delete legacy.outputMonitor; delete legacy.policy.errorWindowMs; delete legacy.policy.noOutputTimeoutMs;
  legacy.status = 'retry_wait'; legacy.retryPlan = 'replace'; legacy.retryDueAt = 1500;
  store.saveTask(legacy);
  supervisor = new Supervisor({ store, adapter, now: () => 2000 });
  try {
    const upgraded = store.task(task.id);
    assert.equal(upgraded.status, 'needs_attention');
    assert.equal(upgraded.incident.autoAttempts, 2);
    assert.equal(upgraded.incident.consecutiveSame, 0);
    assert.equal(upgraded.outputMonitor.sinceAt, 2000);
    assert.equal(upgraded.policy.errorWindowMs, 300000);
    assert.equal(upgraded.policy.noOutputTimeoutMs, 600000);
    await supervisor.recover(); supervisor.tick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(adapter.sent.length, 1);
  } finally { await supervisor.close(); store.close(); }
});
