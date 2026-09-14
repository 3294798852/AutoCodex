import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readRollout } from '../src/adapters/rollout-reader.mjs';
import { observationEvidence } from '../src/core/existing-sessions.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';
import { harness, tempDirectory } from './helpers.mjs';

const entry = (type, at, extra = {}) => JSON.stringify({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type, ...extra } }) + '\n';
const header = id => JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n';
async function fixture(t) {
  const h = await harness(t), id = 'external-fixture', path = join(h.directory, 'existing.jsonl');
  writeFileSync(path, header(id) + entry('task_started', h.now(), { turn_id: 'one' }));
  h.adapter.threads.set(id, { id, name: '原会话', cwd: h.directory, path, status: { type: 'notLoaded' }, turns: [{ id: 'one', status: 'interrupted' }] });
  h.adapter.readThreadSummary = id => h.adapter.readThread(id);
  h.adapter.listThreads = async options => { h.adapter.listOptions = options; return { data: [...h.adapter.threads.values()], nextCursor: 'next' }; };
  let resumed = 0;
  h.adapter.resumeThread = async task => { resumed++; return h.adapter.readThread(task.threadId); };
  const task = await h.supervisor.existing.add({ threadId: id });
  return { ...h, id, path, taskId: task.id, resumed: () => resumed,
    append(type, extra = {}) { h.advance(10); appendFileSync(path, entry(type, h.now(), extra)); },
    async poll() { await h.supervisor.exclusive(task.id, () => h.supervisor.existing.poll(task.id)); return h.store.task(task.id); } };
}

test('existing discovery supports all providers, server pagination, title filters, archive and bounded metadata', async t => {
  const h = await fixture(t);
  const page = await h.supervisor.existing.list({ searchTerm: '原', cursor: 'old', archived: true });
  assert.deepEqual(h.adapter.listOptions, { searchTerm: '原', cursor: 'old', archived: true });
  assert.equal(page.nextCursor, 'next'); assert.equal(page.data[0].taskId, h.taskId);
  assert(!('path' in page.data[0])); assert(!('turns' in page.data[0]));
});

test('join running desktop history without resume or send; duplicates are atomic and later turns remain monitored', async t => {
  const h = await fixture(t);
  const again = await Promise.all([h.supervisor.existing.add({ threadId: h.id }), h.supervisor.existing.add({ threadId: h.id })]);
  assert(again.every(t => t.id === h.taskId)); assert.equal(h.store.tasks().length, 1);
  assert.equal(h.resumed(), 0); assert.equal(h.adapter.sent.length, 0);
  assert.equal(h.store.task(h.taskId).observation.phase, 'active_recent');
  h.append('task_complete', { turn_id: 'one', last_agent_message: '旧会话工作已经完成' });
  assert.equal((await h.poll()).observation.phase, 'completed');
  h.append('token_count'); assert.equal((await h.poll()).observation.phase, 'completed');
  h.append('task_started', { turn_id: 'two' });
  const active = await h.poll(); assert.equal(active.observation.phase, 'active_recent'); assert.equal(active.turnId, 'two');
  h.append('task_complete', { turn_id: 'one' }); assert.equal((await h.poll()).observation.phase, 'active_recent');
  h.append('turn_aborted', { turn_id: 'two' }); assert.equal((await h.poll()).observation.phase, 'interrupted');
  assert.equal(h.adapter.sent.length, 0);
});

test('only explicit error events alert; failed commands and error text do not cause retries, output is redacted', async t => {
  const h = await fixture(t);
  h.append('item_completed', { turn_id: 'one', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'error 已修复 password=private-value' }] } });
  h.append('item_completed', { turn_id: 'one', item: { type: 'Reasoning', raw_content: 'PRIVATE_REASONING' } });
  h.append('exec_command_end', { exit_code: 1 }); await h.poll();
  assert.equal(h.store.records('alerts').length, 0);
  assert(h.store.task(h.taskId).lastOutput.includes('[REDACTED]'));
  h.append('error', { message: 'stream disconnected' }); await h.poll(); await h.poll();
  assert.equal(h.store.records('alerts').length, 1);
  assert.equal(h.store.task(h.taskId).observation.phase, 'error');
  assert.equal(h.adapter.sent.length, 0);
  const exported = JSON.stringify({ state: h.supervisor.snapshot(), events: h.store.events() });
  assert(!exported.includes('PRIVATE_REASONING')); assert(!exported.includes('private-value'));
});

test('freshness becomes unknown and staleness alerts once without labelling crash or dispatching', async t => {
  const h = await fixture(t);
  h.advance(31000); assert.equal((await h.poll()).observation.phase, 'unknown');
  h.advance(600000); await h.poll(); await h.poll();
  assert.equal(h.store.records('alerts').length, 1);
  assert.equal(h.store.records('alerts')[0].code, 'observation_stale');
  h.supervisor.tick(); await h.flush(); assert.equal(h.adapter.sent.length, 0);
});

test('task_complete containing a failure stays error even after final usage records', async t => {
  const h = await fixture(t);
  h.append('task_complete', { turn_id: 'one', error: { message: 'unexpected status 503', codex_error_info: 'other' } });
  h.append('token_count'); assert.equal((await h.poll()).observation.phase, 'error');
  assert.equal(h.store.records('alerts').length, 1);
  h.advance(700000); await h.poll(); assert.equal(h.store.records('alerts').length, 1);
});

test('stop monitoring does not interrupt original thread; restore reads missed events and managed controls reject', async t => {
  const h = await fixture(t);
  for (const action of ['stop', 'continue', 'pause', 'new_session', 'policy', 'adopt']) await assert.rejects(h.supervisor.control(h.taskId, action), /观察|确认/);
  await h.supervisor.control(h.taskId, 'observe_stop');
  h.append('task_complete', { turn_id: 'one' }); await h.poll();
  assert.equal(h.store.task(h.taskId).observation.phase, 'active_recent');
  assert.equal(h.adapter.interrupted, undefined);
  await h.supervisor.control(h.taskId, 'observe_start');
  assert.equal(h.store.task(h.taskId).observation.phase, 'completed');
  assert.equal(h.resumed(), 0);
});

test('persisted cursor survives restart without replaying alerts; no resume or automatic action', async t => {
  const h = await fixture(t);
  h.append('error', { message: 'stream disconnected' }); await h.poll();
  await h.supervisor.close();
  const restored = new Supervisor({ store: h.store, adapter: h.adapter, now: h.now });
  try {
    await restored.recover(); await restored.existing.poll(h.taskId);
    assert.equal(h.store.records('alerts').length, 1);
    h.append('task_complete', { turn_id: 'one' }); await restored.existing.poll(h.taskId);
    assert.equal(h.store.task(h.taskId).observation.phase, 'completed');
    assert.equal(h.adapter.sent.length, 0); assert.equal(h.resumed(), 0);
  } finally { await restored.close(); }
});

test('missing log warns once and recovers, archive relocation refreshes metadata', async t => {
  const h = await fixture(t), moved = join(h.directory, 'archived.jsonl');
  renameSync(h.path, moved);
  await h.poll(); await h.poll();
  assert.equal(h.store.records('alerts').length, 1); assert.equal(h.store.task(h.taskId).observation.phase, 'unavailable');
  h.adapter.threads.get(h.id).path = moved; h.advance(31000);
  assert.notEqual((await h.poll()).observation.phase, 'unavailable');
});

test('explicit adoption preserves identity/settings and sends only after successful ownership handshake', async t => {
  const h = await fixture(t); h.adapter.threads.get(h.id).model = 'original-model';
  h.adapter.threads.get(h.id).modelProvider = 'original-provider';
  h.adapter.resumeThread = async () => { throw new Error('writer is busy'); };
  await assert.rejects(h.supervisor.control(h.taskId, 'adopt', { ownershipConfirmed: true }), /writer is busy/);
  assert.equal(h.store.task(h.taskId).controlMode, 'observe'); assert.equal(h.adapter.sent.length, 0);
  h.adapter.resumeThread = async task => h.adapter.readThread(task.threadId);
  const task = await h.supervisor.control(h.taskId, 'adopt', { ownershipConfirmed: true, message: '接续原任务' });
  assert.equal(task.controlMode, 'managed'); assert.equal(task.threadId, h.id); assert.equal(task.model, 'original-model');
  assert.equal(task.modelProvider, 'original-provider'); assert.equal(task.observation.enabled, false);
  assert.equal(h.adapter.sent.length, 1); assert.equal(h.adapter.sent[0].threadId, h.id);
});

test('active writer conflicts remain observable across repeated attempts and restart, then resume only after release', async t => {
  const h = await fixture(t), before = h.store.task(h.taskId);
  h.adapter.threads.get(h.id).model = 'kept-model';
  h.adapter.resumeThread = async () => { throw Object.assign(new Error(`thread ${h.id} already has an active writer`), { code: -32600 }); };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(h.supervisor.control(h.taskId, 'adopt', { ownershipConfirmed: true }), error => error.status === 409 && error.code === 'thread_in_use' && /停止回复并不释放/.test(error.message));
  }
  const rejected = h.store.task(h.taskId);
  assert.equal(rejected.controlMode, 'observe'); assert.equal(rejected.observation.enabled, true);
  assert.equal(rejected.threadId, before.threadId); assert.equal(rejected.model, before.model);
  assert.equal(rejected.pendingActionId, null); assert.equal(h.adapter.sent.length, 0); assert.equal(h.adapter.interrupted, undefined);
  assert.equal(h.store.events({ taskId: h.taskId }).filter(e => e.type === 'adoption_blocked').length, 1);
  await h.supervisor.close();
  const restored = new Supervisor({ store: h.store, adapter: h.adapter, now: h.now });
  try {
    await restored.recover(); assert.equal(h.adapter.sent.length, 0);
    assert.equal(restored.getTask(h.taskId).observation.lastControlError.code, 'thread_in_use');
    h.append('agent_message', { message: '原客户端仍然可以继续工作并产生新的结果。' });
    await restored.existing.poll(h.taskId); assert.match(restored.getTask(h.taskId).lastOutput, /原客户端/);
    h.adapter.resumeThread = async task => h.adapter.readThread(task.threadId);
    const outcomes = await Promise.allSettled([restored.control(h.taskId, 'adopt', { ownershipConfirmed: true }), restored.control(h.taskId, 'adopt', { ownershipConfirmed: true })]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1); assert.equal(h.adapter.sent.length, 1);
    assert.equal(restored.getTask(h.taskId).model, 'kept-model'); assert.equal(restored.getTask(h.taskId).observation.lastControlError, null);
  } finally { await restored.close(); }
});

test('uncertain resume is not disguised as writer conflict or followed by a turn', async t => {
  const h = await fixture(t), error = Object.assign(new Error('resume response timed out'), { uncertain: true, code: 'rpc_timeout' });
  h.adapter.resumeThread = async () => { throw error; };
  await assert.rejects(h.supervisor.control(h.taskId, 'adopt', { ownershipConfirmed: true }), e => e === error);
  assert.equal(h.store.task(h.taskId).controlMode, 'observe'); assert.equal(h.adapter.sent.length, 0);
});

test('reader preserves split UTF-8 and incomplete lines, skips corrupt records and detects truncation or replacement', async t => {
  const temp = tempDirectory(); t.after(temp.remove); const path = join(temp.directory, 'rollout.jsonl'), id = 'abc';
  writeFileSync(path, header(id)); const first = await readRollout(path, id);
  const bytes = Buffer.from(entry('agent_message', Date.now(), { message: '中文输出' })); const split = bytes.indexOf(Buffer.from('中')) + 1;
  appendFileSync(path, bytes.subarray(0, split)); const partial = await readRollout(path, id, first.cursor); assert.equal(partial.records.length, 0);
  appendFileSync(path, bytes.subarray(split)); appendFileSync(path, '{bad json}\n');
  const finished = await readRollout(path, id, partial.cursor); assert.equal(finished.records[0].record.payload.message, '中文输出'); assert.equal(finished.dropped, 1);
  const noReplay = await readRollout(path, id, finished.cursor); assert.equal(noReplay.records.length, 0);
  writeFileSync(path, header(id) + entry('task_complete', Date.now()));
  const reset = await readRollout(path, id, finished.cursor); assert(reset.reset); assert.notEqual(reset.cursor.cycle, finished.cursor.cycle);
  writeFileSync(path, header('different-thread')); await assert.rejects(readRollout(path, id, reset.cursor), /身份不匹配/);
});

test('reader is bounded on huge logs and oversized lines, can reach following valid records', async t => {
  const temp = tempDirectory(); t.after(temp.remove); const path = join(temp.directory, 'large.jsonl'), id = 'huge';
  writeFileSync(path, header(id) + 'x'.repeat(4 * 1024 * 1024) + '\n' + entry('task_complete', Date.now()));
  const batch = await readRollout(path, id); assert(batch.truncated); assert(batch.records.some(r => r.record.payload?.type === 'task_complete'));
  appendFileSync(path, 'x'.repeat(2 * 1024 * 1024) + '\n' + entry('task_started', Date.now()));
  let next = await readRollout(path, id, batch.cursor); assert(next.dropped); assert(next.cursor.discarding);
  next = await readRollout(path, id, next.cursor); next = await readRollout(path, id, next.cursor);
  assert(next.records.some(r => r.record.payload?.type === 'task_started'));
});

test('unrecognized text and reasoning never become synthetic errors or exposed output', () => {
  assert.equal(observationEvidence({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private' }] } }), null);
  assert.equal(observationEvidence({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'future_event', message: 'error' } }), null);
});
