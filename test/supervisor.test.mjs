import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ControlledAdapter, STREAM, TIMEOUT } from './helpers.mjs';
import { RpcError } from '../src/adapters/rpc-client.mjs';
import { CodexAdapter } from '../src/adapters/codex.mjs';

test('E0 counts: three identical failures send exactly C1 and C2', async t => {
  const h = await harness(t), task = await h.create();
  await h.finish(task.id);
  assert.equal(h.store.task(task.id).incident.consecutiveSame, 1);
  await h.step(task.id); await h.finish(task.id);
  assert.equal(h.store.task(task.id).incident.consecutiveSame, 2);
  await h.step(task.id); await h.finish(task.id);
  const final = h.store.task(task.id);
  assert.equal(final.status, 'needs_attention');
  assert.equal(final.totalAutoAttempts, 2);
  assert.equal(h.adapter.sent.length, 3);
  assert.equal(h.store.records('alerts')[0].code, 'repeated_error');
  h.advance(999999); await h.step(task.id);
  assert.equal(h.adapter.sent.length, 3);
});

test('different continuation errors reset same-type streak without resetting total budget', async t => {
  const h = await harness(t), task = await h.create();
  await h.finish(task.id); await h.step(task.id); await h.finish(task.id);
  await h.step(task.id); await h.finish(task.id, 'failed', TIMEOUT);
  assert.equal(h.store.task(task.id).incident.consecutiveSame, 1);
  await h.step(task.id); await h.finish(task.id, 'failed', TIMEOUT);
  assert.equal(h.store.task(task.id).status, 'retry_wait');
  await h.step(task.id); await h.finish(task.id, 'failed', TIMEOUT);
  assert.equal(h.store.task(task.id).status, 'needs_attention');
  assert.equal(h.store.task(task.id).totalAutoAttempts, 4);
});

test('100 duplicate terminal events schedule one continuation', async t => {
  const h = await harness(t), task = await h.create();
  const turn = await h.finish(task.id);
  for (let i = 0; i < 100; i++) h.adapter.notify('turn/completed', { threadId: task.threadId, turn });
  await h.flush(); await h.step(task.id);
  assert.equal(h.adapter.sent.length, 2);
  assert.equal(h.store.events({ taskId: task.id }).filter(e => e.type === 'retry_scheduled').length, 1);
});

test('normal completion and user interruption never auto-continue', async t => {
  const h = await harness(t);
  for (const status of ['completed', 'interrupted']) {
    const task = await h.create(); await h.finish(task.id, status); h.advance(99999); await h.step(task.id);
    assert.equal(h.store.task(task.id).totalAutoAttempts, 0);
    assert.equal(h.store.task(task.id).status, status === 'completed' ? 'completed' : 'stopped');
  }
});

test('Codex internal retries and failed tools are observations, not continuation triggers', async t => {
  const h = await harness(t), task = await h.create();
  h.adapter.notify('error', { threadId: task.threadId, turnId: task.turnId, error: STREAM, willRetry: true });
  h.adapter.notify('item/completed', { threadId: task.threadId, turnId: task.turnId, item: { id: 'tool', type: 'commandExecution', command: 'test', status: 'failed', exitCode: 1 } });
  await h.flush(); h.advance(90000); await h.step(task.id);
  assert.equal(h.adapter.sent.length, 1); assert.equal(h.store.task(task.id).status, 'running');
});

test('late old-turn and old-thread events cannot alter current task', async t => {
  const h = await harness(t), task = await h.create();
  const old = await h.finish(task.id); await h.step(task.id);
  h.adapter.notify('turn/completed', { threadId: task.threadId, turn: { ...old, status: 'completed' } });
  h.adapter.notify('turn/completed', { threadId: 'unrelated', turn: { id: h.store.task(task.id).turnId, status: 'failed', error: STREAM } });
  await h.flush(); assert.equal(h.store.task(task.id).status, 'running');
});

test('auth, quota and policy failures stop without automatic new sessions', async t => {
  const h = await harness(t);
  for (const category of ['unauthorized', 'usageLimitExceeded', 'cyberPolicy', 'contextWindowExceeded']) {
    const task = await h.create({ policy: { strategy: 'new_session' } });
    await h.finish(task.id, 'failed', { message: category, codexErrorInfo: category });
    assert.equal(h.store.task(task.id).status, 'needs_attention');
    assert.equal(h.store.task(task.id).threadChain.length, 1);
  }
});

test('pause persists and prevents a scheduled retry until resumed', async t => {
  const h = await harness(t), task = await h.create();
  await h.finish(task.id); await h.supervisor.control(task.id, 'pause'); await h.step(task.id);
  assert.equal(h.adapter.sent.length, 1);
  await h.supervisor.control(task.id, 'resume'); await h.step(task.id);
  assert.equal(h.adapter.sent.length, 2);
});

test('stop cancels due retries and ignores late errors', async t => {
  const h = await harness(t), task = await h.create();
  const turn = await h.finish(task.id); await h.supervisor.control(task.id, 'stop');
  h.adapter.notify('turn/completed', { threadId: task.threadId, turn });
  await h.step(task.id); assert.equal(h.store.task(task.id).status, 'stopped'); assert.equal(h.adapter.sent.length, 1);
});

test('replacement receives original objective, old link, checkpoint and bounded history', async t => {
  const h = await harness(t), task = await h.create({ policy: { strategy: 'new_session' } });
  h.supervisor.checkpoint(task.id, 'Parser implemented; UI pending.');
  for (let i = 0; i < 3; i++) { await h.finish(task.id); await h.step(task.id); }
  const latest = h.store.task(task.id);
  assert.equal(latest.threadChain.length, 2);
  assert.equal(latest.turnKind, 'fallback');
  const prompt = h.adapter.sent.at(-1).text;
  assert(prompt.includes('Finish the implementation')); assert(prompt.includes(task.threadId));
  assert(prompt.includes('Parser implemented; UI pending.'));
  assert.equal(h.store.records('handoffs', task.id).length, 1);
  await h.finish(task.id, 'completed'); assert.equal(h.store.task(task.id).status, 'completed');
});

test('replacement first-turn immediate failure permanently halts automatic recovery', async t => {
  const h = await harness(t), task = await h.create({ policy: { strategy: 'new_session' } });
  for (let i = 0; i < 3; i++) { await h.finish(task.id); await h.step(task.id); }
  await h.finish(task.id); h.advance(999999); await h.step(task.id);
  assert.equal(h.store.task(task.id).status, 'failed'); assert.equal(h.adapter.sent.length, 4);
  assert.equal(h.store.task(task.id).threadChain.length, 2);
  assert.equal(h.store.records('alerts', task.id)[0].code, 'replacement_failed_immediately');
});

test('completed tool progress makes replacement first-turn failure eligible for ordinary recovery', async t => {
  const h = await harness(t), task = await h.create({ policy: { strategy: 'new_session' } });
  for (let i = 0; i < 3; i++) { await h.finish(task.id); await h.step(task.id); }
  const latest = h.store.task(task.id);
  h.adapter.notify('item/completed', { threadId: latest.threadId, turnId: latest.turnId, item: { id: 'done', type: 'commandExecution', command: 'check', status: 'completed', exitCode: 0 } });
  await h.flush(); await h.finish(task.id);
  assert.equal(h.store.task(task.id).status, 'retry_wait');
  await h.step(task.id); await h.finish(task.id); await h.step(task.id); await h.finish(task.id);
  assert.equal(h.store.task(task.id).status, 'needs_attention');
  assert.equal(h.store.task(task.id).threadChain.length, 2);
});

test('token deltas are not meaningful progress during replacement startup', async t => {
  const h = await harness(t), task = await h.create({ policy: { strategy: 'new_session' } });
  for (let i = 0; i < 3; i++) { await h.finish(task.id); await h.step(task.id); }
  const latest = h.store.task(task.id);
  h.adapter.notify('item/agentMessage/delta', { threadId: latest.threadId, turnId: latest.turnId, delta: 'Thinking...' });
  await h.flush(); await h.finish(task.id); assert.equal(h.store.task(task.id).status, 'failed');
});

test('replacement failure after startup window follows normal retry policy', async t => {
  const h = await harness(t), task = await h.create({ policy: { strategy: 'new_session' } });
  for (let i = 0; i < 3; i++) { await h.finish(task.id); await h.step(task.id); }
  h.advance(31000); await h.finish(task.id); assert.equal(h.store.task(task.id).status, 'retry_wait');
});

test('alternating errors cannot exceed total continuation budget', async t => {
  const h = await harness(t), task = await h.create({ policy: { maxAutoAttempts: 4 } });
  await h.finish(task.id);
  for (let i = 0; i < 4; i++) { await h.step(task.id); await h.finish(task.id, 'failed', i % 2 ? TIMEOUT : STREAM); }
  assert.equal(h.store.task(task.id).totalAutoAttempts, 4);
  assert.equal(h.store.records('alerts', task.id)[0].code, 'retry_budget_exhausted');
});

test('uncertain delivery is reconciled by the persisted action marker without resending', async t => {
  const adapter = new ControlledAdapter(); adapter.startError = new RpcError('lost reply', { uncertain: true });
  const h = await harness(t, { adapter }), task = await h.create();
  assert.equal(task.status, 'needs_attention'); assert(task.pendingActionId);
  await h.supervisor.control(task.id, 'reconcile');
  assert.equal(h.store.task(task.id).status, 'running');
  assert.equal(h.store.task(task.id).pendingActionId, null); assert.equal(adapter.sent.length, 1);
});

test('unconfirmed delivery without matching history requires manual handling', async t => {
  const adapter = new ControlledAdapter(); adapter.startError = new RpcError('lost reply', { uncertain: true }); adapter.omitHistory = true;
  const h = await harness(t, { adapter }), task = await h.create();
  await h.supervisor.control(task.id, 'reconcile'); await h.step(task.id);
  assert.equal(h.store.task(task.id).status, 'needs_attention'); assert.equal(adapter.sent.length, 1);
  await assert.rejects(h.supervisor.control(task.id, 'continue'), /不确定/);
});

test('completion arriving before turn/start response is preserved', async t => {
  const adapter = new ControlledAdapter(); adapter.earlyCompletion = true;
  const h = await harness(t, { adapter }), task = await h.create();
  assert.equal(task.status, 'completed'); assert.equal(adapter.sent.length, 1);
});

test('owned process disconnect reconciles before one new continuation', async t => {
  const h = await harness(t), task = await h.create();
  h.adapter.threads.get(task.threadId).status = { type: 'notLoaded' };
  h.adapter.emit('disconnect', new Error('process exited'));
  await h.flush(); assert.equal(h.store.task(task.id).retryPlan, 'reconcile');
  await h.step(task.id); assert.equal(h.adapter.sent.length, 1);
  await h.step(task.id); assert.equal(h.adapter.sent.length, 2);
});

test('approval waits do not cause retries and only explicit one-time decisions are sent', async t => {
  const h = await harness(t), task = await h.create();
  h.adapter.emit('request', { id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: task.threadId, turnId: task.turnId, command: 'test', availableDecisions: ['accept', 'decline'] } });
  await h.flush(); h.advance(999999); await h.step(task.id);
  assert.equal(h.store.task(task.id).status, 'waiting_user'); assert.equal(h.adapter.sent.length, 1);
  const approval = h.supervisor.pendingApprovals(task.id)[0];
  await assert.rejects(h.supervisor.respondApproval(approval.id, { decision: 'acceptForSession' }));
  await h.supervisor.respondApproval(approval.id, { decision: 'accept' });
  assert.deepEqual(h.adapter.replies[0].result, { decision: 'accept' });
  await assert.rejects(h.supervisor.respondApproval(approval.id, { decision: 'accept' }));
});

test('unknown server requests are rejected and surfaced instead of silently approved', async t => {
  const h = await harness(t), task = await h.create();
  h.adapter.emit('request', { id: 55, method: 'unsupported/action', params: { threadId: task.threadId, turnId: task.turnId } });
  await h.flush(); assert.equal(h.adapter.rejections.length, 1); assert.equal(h.adapter.replies.length, 0);
  assert.equal(h.store.task(task.id).status, 'needs_attention');
});

test('long silence alerts without inventing a transport failure or sending a message', async t => {
  const h = await harness(t), task = await h.create();
  h.advance(400000); await h.step(task.id);
  assert.equal(h.store.task(task.id).status, 'running'); assert.equal(h.adapter.sent.length, 1);
  assert.equal(h.store.records('alerts')[0].code, 'no_recent_activity');
});

test('acknowledging an alert never resumes the task', async t => {
  const h = await harness(t), task = await h.create();
  await h.finish(task.id, 'failed', { codexErrorInfo: 'unauthorized', message: 'login required' });
  h.supervisor.acknowledge(h.store.records('alerts')[0].id);
  await h.step(task.id); assert.equal(h.store.task(task.id).status, 'needs_attention'); assert.equal(h.adapter.sent.length, 1);
});

test('disconnect during approval expires the request and requires manual handling', async t => {
  const h = await harness(t), task = await h.create();
  h.adapter.emit('request', { id: 101, method: 'item/fileChange/requestApproval', params: { threadId: task.threadId, turnId: task.turnId } });
  await h.flush(); h.adapter.emit('disconnect', new Error('connection closed')); await h.flush();
  h.advance(999999); await h.step(task.id);
  assert.equal(h.store.task(task.id).status, 'needs_attention');
  assert.equal(h.supervisor.pendingApprovals(task.id).length, 0); assert.equal(h.adapter.sent.length, 1);
});

test('pending replacement and retry budgets are rechecked after policy edits', async t => {
  const h = await harness(t), task = await h.create({ policy: { strategy: 'new_session' } });
  await h.finish(task.id); await h.step(task.id); await h.finish(task.id); await h.step(task.id); await h.finish(task.id);
  assert.equal(h.store.task(task.id).retryPlan, 'replace');
  await h.supervisor.control(task.id, 'policy', { policy: { strategy: 'manual' } });
  await h.step(task.id); assert.equal(h.store.task(task.id).threadChain.length, 1);
  assert.equal(h.store.task(task.id).status, 'needs_attention');
});

test('completed and stopped tasks cannot be reactivated by reconciliation', async t => {
  const h = await harness(t), task = await h.create(); await h.finish(task.id, 'completed');
  await assert.rejects(h.supervisor.control(task.id, 'reconcile'), /已结束/);
  assert.equal(h.store.task(task.id).status, 'completed');
});

test('known surviving worker is never silently replaced by a new Codex process', async () => {
  const adapter = new CodexAdapter({ priorWorkerPid: process.pid });
  await assert.rejects(adapter.connect(), /仍在运行/); assert.equal(adapter.client, undefined);
});

test('twenty concurrent tasks retain independent recovery counters', async t => {
  const h = await harness(t);
  const tasks = await Promise.all(Array.from({ length: 20 }, (_, i) => h.create({ name: `Task ${i}` })));
  await Promise.all(tasks.map(task => h.finish(task.id)));
  await Promise.all(tasks.map(task => h.step(task.id)));
  for (const task of tasks) { assert.equal(h.store.task(task.id).incident.autoAttempts, 1); assert.equal(h.store.task(task.id).incident.consecutiveSame, 1); }
  assert.equal(h.adapter.sent.length, 40);
});

test('a final error notification supplies missing terminal details only for its own turn', async t => {
  const h = await harness(t), task = await h.create();
  h.adapter.notify('error', { threadId: task.threadId, turnId: task.turnId, error: STREAM, willRetry: false });
  await h.flush(); await h.finish(task.id, 'failed', null);
  assert.equal(h.store.task(task.id).lastError.category, 'stream_disconnected');
  await h.step(task.id); await h.finish(task.id, 'failed', null);
  assert.equal(h.store.task(task.id).lastError.category, 'unknown');
  assert.equal(h.store.task(task.id).status, 'needs_attention');
});

test('ongoing tool activity prevents false silence alarms without storing raw output', async t => {
  const h = await harness(t), task = await h.create({ policy: { staleAfterMs: 1000 } });
  h.advance(900);
  h.adapter.notify('item/commandExecution/outputDelta', { threadId: task.threadId, turnId: task.turnId, delta: 'sensitive-tool-output' });
  await h.flush(); h.advance(900); await h.step(task.id);
  assert.equal(h.store.records('alerts').length, 0);
  assert(!JSON.stringify(h.store.events({ taskId: task.id })).includes('sensitive-tool-output'));
});

test('replacement pins the persisted effective model and provider when defaults change', async t => {
  const adapter = new ControlledAdapter(), createThread = adapter.createThread.bind(adapter), requests = [];
  let defaultModel = 'original-model', defaultProvider = 'original-provider';
  adapter.createThread = async task => {
    requests.push({ model: task.model, modelProvider: task.modelProvider });
    return { ...await createThread(task), model: task.model || defaultModel, modelProvider: task.modelProvider || defaultProvider };
  };
  const h = await harness(t, { adapter }), task = await h.create({ policy: { strategy: 'new_session' } });
  defaultModel = 'changed-model'; defaultProvider = 'changed-provider';
  for (let i = 0; i < 3; i++) { await h.finish(task.id); await h.step(task.id); }
  assert.deepEqual(requests[1], { model: 'original-model', modelProvider: 'original-provider' });
  assert.equal(h.store.task(task.id).model, 'original-model');
  assert.equal(h.store.task(task.id).modelProvider, 'original-provider');
  assert.equal(h.store.records('handoffs', task.id)[0].modelProvider, 'original-provider');
});

test('explicit transfer resumes an idle thread with its original model and provider', async t => {
  const h = await harness(t);
  const old = await h.adapter.createThread({ cwd: process.cwd() });
  Object.assign(h.adapter.threads.get(old.id), { model: 'history-model', modelProvider: 'history-provider' });
  await assert.rejects(h.create({ threadId: old.id }), /确认/);
  assert.equal(h.adapter.sent.length, 0);
  const task = await h.create({ threadId: old.id, ownershipConfirmed: true });
  assert.equal(task.status, 'running');
  assert.equal(task.threadId, old.id);
  assert.equal(task.threadChain[0].reason, 'adopted');
  assert.equal(task.model, 'history-model');
  assert.equal(task.modelProvider, 'history-provider');
  assert.equal(h.adapter.threads.size, 1);
  assert.equal(h.adapter.sent.length, 1);
  await assert.rejects(h.create({ threadId: old.id, ownershipConfirmed: true }), /其他监护任务/);
});

test('transfer rejects active status and unfinished history without dispatching', async t => {
  const h = await harness(t);
  for (const activeStatus of [true, false]) {
    const old = await h.adapter.createThread({ cwd: process.cwd() });
    Object.assign(h.adapter.threads.get(old.id), activeStatus
      ? { status: { type: 'active' } }
      : { turns: [{ id: 'unfinished', status: 'inProgress', items: [] }] });
    const task = await h.create({ threadId: old.id, ownershipConfirmed: true });
    assert.equal(task.status, 'needs_attention');
    assert.equal(h.store.records('alerts', task.id)[0].code, 'adoption_failed');
  }
  assert.equal(h.adapter.sent.length, 0);
});
