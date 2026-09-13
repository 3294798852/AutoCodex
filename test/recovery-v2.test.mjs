import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, STREAM, TIMEOUT } from './helpers.mjs';
import { decideFailure, newIncident, validatePolicy } from '../src/core/policy.mjs';
import { newOutputMonitor, noOutputElapsed } from '../src/core/progress.mjs';

async function output(h, id, text = '已完成解析模块并保存修改，接下来验证剩余的调用路径。', itemId = 'message') {
  const task = h.store.task(id);
  h.adapter.notify('item/completed', { threadId: task.threadId, turnId: task.turnId, item: { id: itemId, type: 'agentMessage', text } });
  await h.flush();
}
async function tick(h) { h.supervisor.tick(); await h.flush(); }

test('a different E0 does not let two later identical failures trip a three-error threshold', async t => {
  const h = await harness(t), task = await h.create();
  await h.finish(task.id, 'failed', TIMEOUT);
  for (let i = 0; i < 2; i++) { await h.step(task.id); await h.finish(task.id); }
  assert.equal(h.store.task(task.id).status, 'retry_wait');
  assert.equal(h.store.task(task.id).incident.consecutiveSame, 2);
  await h.step(task.id); await h.finish(task.id);
  assert.equal(h.store.task(task.id).status, 'needs_attention');
  assert.equal(h.store.task(task.id).totalAutoAttempts, 3);
});

test('three errors inside the window trip even with useful output between them (OR rule)', async t => {
  const h = await harness(t), task = await h.create();
  await h.finish(task.id);
  for (let i = 0; i < 2; i++) { await h.step(task.id); await output(h, task.id, `模块 ${i} 已完成解析和验证，下一步继续处理剩余工作。`); await h.finish(task.id); }
  const final = h.store.task(task.id);
  assert.equal(final.status, 'needs_attention');
  assert.equal(final.incident.match.withinWindow, true);
  assert.equal(final.incident.match.noOutputBetween, false);
  assert.equal(final.totalAutoAttempts, 2);
});

test('sporadic failures separated by useful output and time do not exhaust the old lifetime budget', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 3600000 } });
  for (let i = 0; i < 9; i++) {
    h.advance(301000);
    await output(h, task.id, `第 ${i} 个工作模块已经完成，文件与测试结果已保存。`);
    await h.finish(task.id);
    assert.equal(h.store.task(task.id).status, 'retry_wait');
    await h.step(task.id);
  }
  const current = h.store.task(task.id);
  assert.equal(current.totalAutoAttempts, 9);
  assert.equal(current.incident.attemptsWithoutOutput, 1);
  assert.equal(current.incident.match.triggered, false);
  assert.equal(h.store.records('alerts').length, 0);
});

test('three same errors without output trip even outside the time window', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 3600000 } });
  for (let i = 0; i < 3; i++) {
    h.advance(301000); await h.finish(task.id);
    if (i < 2) await h.step(task.id);
  }
  const final = h.store.task(task.id);
  assert.equal(final.status, 'needs_attention');
  assert.equal(final.incident.match.withinWindow, false);
  assert.equal(final.incident.match.noOutputBetween, true);
  assert.equal(final.totalAutoAttempts, 2);
});

test('time window is inclusive and uses the latest N failures instead of the oldest streak', () => {
  function run(times) {
    const task = { incident: newIncident(), policy: validatePolicy({ errorWindowMs: 1000, noOutputTimeoutMs: 3600000 }), outputMonitor: newOutputMonitor(0) };
    let decision;
    for (const at of times) { task.outputMonitor.sequence++; decision = decideFailure(task, { category: 'timeout', recoverable: true }, at, () => 0); task.incident = decision.incident; }
    return decision;
  }
  assert.equal(run([0, 500, 1000]).action, 'manual');
  assert.equal(run([0, 500, 1001]).action, 'continue');
  const rolling = run([0, 4000, 4500, 5000]);
  assert.equal(rolling.incident.consecutiveSame, 4);
  assert.equal(rolling.incident.match.spanMs, 1000);
  assert.equal(rolling.action, 'manual');
});

test('capacity and rate limits each allow four retries before the fifth same failure', async t => {
  const h = await harness(t);
  for (const error of [{ message: 'The model is at capacity. Please try again.' }, { httpStatusCode: 429, message: 'Too many requests' }]) {
    const task = await h.create();
    for (let i = 0; i < 5; i++) {
      await h.finish(task.id, 'failed', error);
      const current = h.store.task(task.id);
      assert.equal(current.incident.consecutiveSame, i + 1);
      assert.equal(current.incident.threshold, 5);
      assert.equal(current.status, i === 4 ? 'needs_attention' : 'retry_wait');
      if (i < 4) await h.step(task.id);
    }
    assert.equal(h.store.task(task.id).totalAutoAttempts, 4);
  }
});

test('five-error exemption uses the same time-or-output condition', () => {
  const task = { incident: newIncident(), policy: validatePolicy({ noOutputTimeoutMs: 3600000 }), outputMonitor: newOutputMonitor(0) };
  let decision;
  for (let i = 0; i < 5; i++) {
    task.outputMonitor.sequence++;
    decision = decideFailure(task, { category: 'rate_limit', recoverable: true }, i * 301000, () => 0);
    task.incident = decision.incident;
  }
  assert.equal(decision.action, 'continue');
  assert.equal(decision.incident.threshold, 5);
});

test('a live turn with no output is reported and latched without forcibly interrupting tools', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000 } });
  h.advance(1000); await tick(h);
  let current = h.store.task(task.id);
  assert.equal(current.status, 'running'); assert.equal(current.outputMonitor.blocked, true);
  assert.equal(current.paused, true); assert.equal(h.adapter.interrupted, undefined);
  const alert = h.store.records('alerts', task.id)[0]; assert.equal(alert.code, 'no_effective_output');
  h.supervisor.acknowledge(alert.id);
  await output(h, task.id); await h.finish(task.id); h.advance(99999); await tick(h);
  current = h.store.task(task.id);
  assert.equal(current.status, 'needs_attention'); assert.equal(current.outputMonitor.blocked, true);
  assert.equal(h.adapter.sent.length, 1); assert.equal(h.store.records('alerts', task.id).length, 1);
  await assert.rejects(h.supervisor.control(task.id, 'resume'), /长期无输出/);
  await h.supervisor.control(task.id, 'continue');
  assert.equal(h.store.task(task.id).outputMonitor.blocked, false);
  assert.equal(h.adapter.sent.length, 2);
});

test('continuous internal retries, reasoning and stdout activity cannot suppress the output deadline', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000 } });
  for (let i = 0; i < 4; i++) {
    h.advance(300);
    h.adapter.notify('error', { threadId: task.threadId, turnId: task.turnId, error: STREAM, willRetry: true });
    h.adapter.notify('item/reasoning/textDelta', { threadId: task.threadId, turnId: task.turnId, delta: 'thinking' });
    h.adapter.notify('item/commandExecution/outputDelta', { threadId: task.threadId, turnId: task.turnId, delta: 'heartbeat' });
    await h.flush(); await tick(h);
  }
  assert.equal(h.store.task(task.id).outputMonitor.blocked, true);
  assert.equal(h.store.task(task.id).incident.consecutiveSame, 0);
  assert.equal(h.adapter.sent.length, 1);
});

test('empty text, retry notices and repeated business output do not keep a broken task alive', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000 } });
  await output(h, task.id, '解析逻辑已经修复，测试结果已保存到项目文件。', 'first');
  const first = h.store.task(task.id).outputMonitor.lastEffectiveAt;
  h.advance(800);
  for (const [i, text] of ['   ', 'Thinking...', 'Retrying... 1/5', 'The model is at capacity. Please try again later.', '解析逻辑已经修复，测试结果已保存到项目文件。'].entries()) await output(h, task.id, text, `repeat-${i}`);
  assert.equal(h.store.task(task.id).outputMonitor.lastEffectiveAt, first);
  h.advance(200); await tick(h); assert.equal(h.store.task(task.id).outputMonitor.blocked, true);
});

test('useful streamed text resets no-output time after small deltas accumulate', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000 } });
  h.advance(800);
  for (const delta of ['Parser ', 'implementation ', 'is complete ', 'and tests are now passing.']) h.adapter.notify('item/agentMessage/delta', { threadId: task.threadId, turnId: task.turnId, itemId: 'streamed', delta });
  await h.flush();
  assert.equal(h.store.task(task.id).outputMonitor.lastEffectiveAt, h.now());
  h.advance(999); await tick(h); assert.equal(h.store.task(task.id).outputMonitor.blocked, false);
  h.advance(1); await tick(h); assert.equal(h.store.task(task.id).outputMonitor.blocked, true);
});

test('successful tools reset the deadline once and duplicated completion does not reset it again', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000 } });
  const item = { id: 'build', type: 'commandExecution', status: 'completed', exitCode: 0 };
  h.advance(800); h.adapter.notify('item/completed', { threadId: task.threadId, turnId: task.turnId, item }); await h.flush();
  h.advance(800); h.adapter.notify('item/completed', { threadId: task.threadId, turnId: task.turnId, item }); await h.flush();
  assert.equal(noOutputElapsed(h.store.task(task.id), h.now()), 800);
  h.advance(200); await tick(h); assert.equal(h.store.task(task.id).outputMonitor.blocked, true);
});

test('terminal history supplies valid output when item notifications were missed', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000 } });
  h.advance(1200);
  h.adapter.threads.get(task.threadId).turns.at(-1).items.push({ id: 'saved', type: 'fileChange', status: 'completed' });
  await h.finish(task.id);
  assert.equal(h.store.task(task.id).status, 'retry_wait');
  assert.equal(h.store.task(task.id).outputMonitor.lastEffectiveAt, h.now());
});

test('watchdog reports during long backoff before a retry is due', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000, rateLimitDelayMs: 300000 } });
  await h.finish(task.id, 'failed', { httpStatusCode: 429, message: 'Too many requests' });
  h.advance(1000); await tick(h);
  assert.equal(h.store.task(task.id).status, 'needs_attention');
  assert.equal(h.store.task(task.id).retryDueAt, null);
  assert.equal(h.adapter.sent.length, 1);
});

test('watchdog cancels a pending replacement and is carried into an already-created replacement', async t => {
  const h = await harness(t);
  for (const alreadyCreated of [false, true]) {
    const task = await h.create({ policy: { strategy: 'new_session', noOutputTimeoutMs: 1000, baseDelayMs: 50, maxDelayMs: 200 } });
    const baseline = task.outputMonitor.sinceAt;
    for (let i = 0; i < 3; i++) { await h.finish(task.id); if (i < 2 || alreadyCreated) await h.step(task.id); }
    h.advance(1000); await tick(h);
    const current = h.store.task(task.id);
    assert.equal(current.outputMonitor.blocked, true);
    assert.equal(current.outputMonitor.sinceAt, baseline);
    assert.equal(current.threadChain.length, alreadyCreated ? 2 : 1);
    assert.equal(current.totalAutoAttempts, 2);
  }
});

test('manual pauses exclude user-controlled waiting time from the deadline', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000 } });
  h.advance(700); await h.supervisor.control(task.id, 'pause'); h.advance(10000); await tick(h);
  assert.equal(h.store.records('alerts').length, 0);
  await h.supervisor.control(task.id, 'resume');
  h.advance(299); await tick(h); assert.equal(h.store.task(task.id).outputMonitor.blocked, false);
  h.advance(1); await tick(h); assert.equal(h.store.task(task.id).outputMonitor.blocked, true);
});

test('blocking approvals exclude waiting time and resume the remaining output deadline', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000 } });
  h.advance(700);
  h.adapter.emit('request', { id: 987, method: 'item/commandExecution/requestApproval', params: { threadId: task.threadId, turnId: task.turnId, availableDecisions: ['accept', 'decline'] } });
  await h.flush(); h.advance(10000); await tick(h);
  assert.equal(h.store.records('alerts').length, 0);
  await h.supervisor.respondApproval(h.supervisor.pendingApprovals(task.id)[0].id, { decision: 'accept' });
  h.advance(300); await tick(h); assert.equal(h.store.task(task.id).outputMonitor.blocked, true);
});

test('late output from a failed turn cannot renew the next retry output deadline', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000, baseDelayMs: 2000, maxDelayMs: 2000 } });
  await h.finish(task.id); h.advance(900); await output(h, task.id);
  assert.equal(h.store.task(task.id).outputMonitor.sequence, 0);
  h.advance(100); await tick(h); assert.equal(h.store.task(task.id).outputMonitor.blocked, true);
});

test('alternating error categories cannot evade the independent output deadline', async t => {
  const h = await harness(t), task = await h.create({ policy: { noOutputTimeoutMs: 1000, maxAutoAttempts: 30, baseDelayMs: 50, maxDelayMs: 200 } });
  for (let i = 0; i < 12 && !h.store.task(task.id).outputMonitor.blocked; i++) {
    await h.finish(task.id, 'failed', i % 2 ? TIMEOUT : STREAM); await h.step(task.id);
  }
  assert.equal(h.store.task(task.id).outputMonitor.blocked, true);
  assert.equal(h.store.records('alerts', task.id)[0].code, 'no_effective_output');
  assert(h.store.task(task.id).totalAutoAttempts < 30);
});
