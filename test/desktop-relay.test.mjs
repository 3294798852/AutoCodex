import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProtocolRelay } from '../src/desktop/protocol-relay.mjs';
import { harness, STREAM } from './helpers.mjs';
import { DesktopMonitor } from '../src/core/desktop-monitor.mjs';
import { signRecycle, verifiedRecycle } from '../src/desktop/recycle-protocol.mjs';

function wire(options = {}) {
  const server = [], desktop = [], events = [];
  const relay = new ProtocolRelay({ toServer: m => server.push(m), toDesktop: m => desktop.push(m), ...options });
  relay.on('event', e => events.push(e));
  relay.rememberThread({ id: 'thread', cwd: process.cwd() });
  return { relay, server, desktop, events };
}
function started(relay, id = 'turn') { relay.fromServer({ method: 'turn/started', params: { threadId: 'thread', turn: { id, status: 'inProgress' } } }); }
function ended(relay, status = 'failed') { relay.fromServer({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status, error: STREAM } } }); }
const action = () => ({ id: 'action', threadId: 'thread', failedTurnId: 'turn', generation: 0, kind: 'continue', message: 'Continue fixture.' });
const flush = () => new Promise(r => setImmediate(r));

test('desktop protocol forwards original ids, payload and normal output without a monitor', async () => {
  const h = wire();
  h.relay.fromDesktop({ id: 'same', method: 'thread/read', params: { threadId: 'thread' } });
  const id = h.server[0].id;
  assert.equal(id, 'same');
  h.relay.fromServer({ id, result: { thread: { id: 'thread', turns: [] } } });
  assert.equal(h.desktop[0].id, 'same');
  const notice = { method: 'arbitrary/newNotification', params: { value: 'unmodified' } };
  h.relay.fromServer(notice); assert.equal(h.desktop.at(-1), notice);
  h.relay.fromDesktop({ id: 45, result: { decision: 'accept' } }); assert.deepEqual(h.server.at(-1), { id: 45, result: { decision: 'accept' } });
  h.relay.close();
});

test('continuation uses the owned connection without resume and hides internal replies including late duplicates', async () => {
  const h = wire(); started(h.relay); ended(h.relay);
  const result = h.relay.execute(action());
  assert.equal(h.server.length, 1); assert.equal(h.server[0].method, 'turn/start');
  assert.equal(h.server[0].params.threadId, 'thread');
  h.relay.fromServer({ id: h.server[0].id, result: { turn: { id: 'next' } } });
  assert.deepEqual(await result, { outcome: 'sent', turnId: 'next' });
  const count = h.desktop.length;
  h.relay.fromServer({ id: h.server[0].id, result: { turn: { id: 'next' } } });
  assert.equal(h.desktop.length, count);
  assert.equal((await h.relay.execute(action())).outcome, 'unknown'); assert.equal(h.server.length, 1);
});

test('user stop, new input, ongoing turn and normal completion prevent automatic sends', async () => {
  for (const mode of ['stop', 'input', 'running', 'completed']) {
    const h = wire(); started(h.relay);
    if (mode !== 'running') ended(h.relay, mode === 'completed' ? 'completed' : 'failed');
    if (mode === 'stop') h.relay.fromDesktop({ id: 1, method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } });
    if (mode === 'input') h.relay.fromDesktop({ id: 1, method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: 'User request' }] } });
    const before = h.server.length;
    assert.equal((await h.relay.execute(action())).outcome, 'skipped', mode);
    assert.equal(h.server.length, before, mode); h.relay.close();
  }
});

test('approval auto decision is once only and manual fallback leaves normal desktop responses intact', async () => {
  for (const automatic of [true, false]) {
    const h = wire({ approval: async () => ({ automatic, response: { decision: 'accept' } }) }); started(h.relay);
    const message = { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'git status' } };
    h.relay.fromServer(message); h.relay.fromServer(message); await flush();
    assert.equal(h.server.length, automatic ? 1 : 0);
    if (!automatic) { assert.equal(h.desktop.at(-1), message); h.relay.fromDesktop({ id: 1, result: { decision: 'cancel' } }); assert.equal(h.server.at(-1).result.decision, 'cancel'); }
    h.relay.fromServer(message); await flush(); assert.equal(h.server.length, 1);
    h.relay.close();
  }
});

test('delayed automatic approval yields to a user interrupt without answering the old request', async () => {
  let complete;
  const h = wire({ approval: () => new Promise(r => { complete = r; }) }); started(h.relay);
  const message = { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn' } };
  h.relay.fromServer(message);
  h.relay.fromDesktop({ id: 1, method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } });
  complete({ automatic: true, response: { decision: 'accept' } }); await flush();
  assert.equal(h.server.length, 1); assert.equal(h.server[0].method, 'turn/interrupt');
  assert.equal(h.desktop.at(-1), message); h.relay.close();
});

test('stalled approval policy falls back within the deadline and resolved requests are never forwarded late', async () => {
  const h = wire({ approvalTimeoutMs: 20, approval: () => new Promise(() => {}) }); started(h.relay);
  const request = { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn' } };
  h.relay.fromServer(request);
  await new Promise(r => setTimeout(r, 35)); assert.equal(h.desktop.at(-1), request);
  h.relay.fromServer({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 7 } });
  assert.equal(h.relay.thread('thread').waiting, 0); h.relay.close();
});

test('replacement keeps thread configuration and yields when user acts during creation', async () => {
  const h = wire(); h.relay.rememberThread({ id: 'thread', cwd: process.cwd() }, { model: 'chosen', sandbox: 'read-only', approvalPolicy: 'untrusted' });
  started(h.relay); ended(h.relay);
  const next = h.relay.execute({ ...action(), kind: 'replace' });
  assert.equal(h.server[0].method, 'thread/start'); assert.equal(h.server[0].params.sandbox, 'read-only');
  h.relay.fromDesktop({ id: 4, method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: 'New user work' }] } });
  h.relay.fromServer({ id: h.server[0].id, result: { thread: { id: 'next', cwd: process.cwd() }, model: 'chosen' } });
  assert.equal((await next).outcome, 'skipped'); assert.equal(h.server.length, 2); h.relay.close();
});

test('continuation does not replay previous tool results, message ids or additional context', async () => {
  const h = wire();
  h.relay.fromDesktop({ id: 2, method: 'turn/start', params: { threadId: 'thread', input: [], toolOutput: { name: 'delete', output: 'done' }, clientUserMessageId: 'user', additionalContext: [{ text: 'one time' }] } });
  h.relay.fromServer({ id: h.server[0].id, result: { turn: { id: 'turn' } } });
  started(h.relay); ended(h.relay);
  const sending = h.relay.execute({ ...action(), generation: 1 });
  assert.equal(h.server[1].params.toolOutput, undefined); assert.equal(h.server[1].params.clientUserMessageId, undefined);
  h.relay.fromServer({ id: h.server[1].id, result: { turn: { id: 'next' } } }); await sending; h.relay.close();
});

test('observer exceptions cannot swallow desktop requests, mapped replies or notifications', async () => {
  const faults = [], h = wire({ onFault: e => faults.push(e.message) });
  h.relay.on('event', () => { throw new Error('observer failure'); });
  const input = { id: 12, method: 'turn/start', params: { threadId: 'thread', input: [] } };
  h.relay.fromDesktop(input); assert.deepEqual(h.server.at(-1), input);
  const response = { id: 12, result: { turn: { id: 'turn' } } };
  h.relay.fromServer(response); assert.deepEqual(h.desktop.at(-1), response);
  const notification = { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } };
  h.relay.fromServer(notification); assert.deepEqual(h.desktop.at(-1), notification);
  assert(faults.includes('observer failure'));
  ended(h.relay); assert.equal((await h.relay.execute({ ...action(), generation: 1 })).outcome, 'unknown'); h.relay.close();
});

test('new task retains named permissions or exact sandbox policy including writable roots', async () => {
  for (const named of [false, true]) {
    const h = wire(), sandbox = { type: 'workspaceWrite', networkAccess: false, writableRoots: [process.cwd()], excludeTmpdirEnvVar: true };
    h.relay.rememberThread({ id: 'thread', cwd: process.cwd() }, {}, { sandbox, ...(named ? { activePermissionProfile: { id: 'project-restricted' } } : {}) });
    started(h.relay); ended(h.relay);
    const pending = h.relay.execute({ ...action(), kind: 'replace' });
    if (named) { assert.equal(h.server[0].params.permissions, 'project-restricted'); assert.equal(h.server[0].params.sandbox, undefined); }
    h.relay.fromServer({ id: h.server[0].id, result: { thread: { id: 'next', cwd: process.cwd() } } }); await flush();
    const turn = h.server.at(-1);
    assert.equal(turn.method, 'turn/start');
    if (named) { assert.equal(turn.params.permissions, 'project-restricted'); assert.equal(turn.params.sandboxPolicy, undefined); }
    else assert.deepEqual(turn.params.sandboxPolicy, sandbox);
    h.relay.fromServer({ id: turn.id, result: { turn: { id: 'next-turn' } } }); await pending; h.relay.close();
  }
});

test('permission settings changes invalidate a pending continue and preserve the new scope', async () => {
  const h = wire(); started(h.relay); ended(h.relay);
  h.relay.fromDesktop({ id: 5, method: 'thread/settings/update', params: { threadId: 'thread', sandboxPolicy: { type: 'readOnly', networkAccess: false } } });
  assert.equal((await h.relay.execute(action())).outcome, 'skipped');
  assert.equal(h.relay.thread('thread').sandbox, 'read-only'); h.relay.close();
});

test('recycle identity rejects tampering and requires the connection secret', () => {
  const value = { id: 'recycle', paths: ['C:/fixture.txt'] }, secret = 'local-fixture';
  const meta = { autocodexRecycle: value, autocodexSignature: signRecycle(value, secret) };
  assert.deepEqual(verifiedRecycle(meta, secret), value);
  assert.equal(verifiedRecycle(meta, 'other-connection'), null);
  assert.equal(verifiedRecycle({ ...meta, autocodexRecycle: { ...value, paths: ['C:/different.txt'] } }, secret), null);
});

async function monitoring(t) {
  const h = await harness(t), path = join(h.directory, 'original.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: 'thread' } }) + '\n');
  h.adapter.readThreadSummary = async () => ({ id: 'thread', cwd: h.directory, path });
  const task = await h.supervisor.existing.add({ threadId: 'thread' });
  await h.supervisor.desktop.configure(task.id, { revision: 0, autoContinue: true, autoApprove: true });
  let sequence = 0, generation = 0;
  const state = { id: 'thread', loaded: true, active: false, generation, turnId: null, failedTurnId: null, sandbox: 'workspace-write' };
  const poll = events => h.supervisor.desktop.poll({ relayId: 'relay', threads: [{ ...state }], events: events.map(e => ({ ...e, at: h.now(), seq: ++sequence, threadId: 'thread', generation })) });
  await poll([]);
  return { ...h, taskId: task.id, poll, state };
}

test('desktop monitor retries two times and stops after third same failure; duplicates do not add actions', async t => {
  const h = await monitoring(t);
  for (let n = 0; n < 3; n++) {
    h.state.turnId = `turn${n}`; h.state.active = true;
    await h.poll([{ type: 'started', turnId: h.state.turnId }]);
    h.state.active = false; h.state.failedTurnId = h.state.turnId;
    await h.poll([{ type: 'terminal', turnId: h.state.turnId, status: 'failed', error: STREAM }]);
    const task = h.store.task(h.taskId);
    if (n < 2) {
      h.advance(task.assist.dueAt - h.now());
      const { actions } = await h.poll([]); assert.equal(actions.length, 1);
      assert.equal((await h.poll([])).actions.length, 0);
      await h.poll([{ type: 'action_result', actionId: actions[0].id, outcome: 'sent', turnId: `turn${n + 1}` }]);
    }
  }
  const result = h.store.task(h.taskId);
  assert.equal(result.totalAutoAttempts, 2); assert.equal(result.assist.blocked, true);
  assert.equal(result.incident.consecutiveSame, 3); assert.equal(result.controlMode, 'observe'); assert.equal(h.adapter.sent.length, 0);
});

test('pending desktop recovery is cancelled for a user message and disabled switches; settings use revisions', async t => {
  const h = await monitoring(t);
  h.state.turnId = 'turn'; h.state.failedTurnId = 'turn';
  await h.poll([{ type: 'started', turnId: 'turn' }, { type: 'terminal', turnId: 'turn', status: 'failed', error: STREAM }]);
  h.state.generation++;
  await h.poll([{ type: 'user_change' }]); h.advance(10000);
  assert.equal((await h.poll([])).actions.length, 0);
  await assert.rejects(h.supervisor.desktop.configure(h.taskId, { revision: 0, autoContinue: false }), /其他页面/);
  await h.supervisor.desktop.configure(h.taskId, { revision: 1, autoContinue: false });
  assert.equal(h.store.task(h.taskId).assist.autoContinue, false);
});

test('desktop approval uses exact task and independent switches and keeps unknown commands manual', async t => {
  const h = await monitoring(t);
  h.supervisor.setDnd({ revision: 0, commonCommands: true });
  const input = { relayId: 'relay', threadId: 'thread', key: 'request1', generation: 0,
    request: { method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'git status', cwd: h.directory } } };
  const approved = await h.supervisor.desktop.approve(input); assert.equal(approved.automatic, true);
  assert.equal((await h.supervisor.desktop.approve(input)).automatic, false);
  const unknown = structuredClone(input); unknown.key = 'request2'; unknown.request.params.command = 'unknown-script --do-things';
  assert.equal((await h.supervisor.desktop.approve(unknown)).automatic, false);
  await h.supervisor.desktop.configure(h.taskId, { revision: 1, autoApprove: false });
  assert.equal((await h.supervisor.desktop.approve({ ...input, key: 'request3' })).automatic, false);
});

test('capacity errors have four continues and a fifth failure alarm', async t => {
  const h = await monitoring(t);
  for (let n = 0; n < 5; n++) {
    h.state.turnId = `capacity-${n}`; h.state.failedTurnId = h.state.turnId;
    await h.poll([{ type: 'started', turnId: h.state.turnId }, { type: 'terminal', turnId: h.state.turnId, status: 'failed', error: { message: 'server overloaded at capacity' } }]);
    if (n === 4) break;
    h.advance(h.store.task(h.taskId).assist.dueAt - h.now());
    const result = await h.poll([]); assert.equal(result.actions.length, 1);
    await h.poll([{ type: 'action_result', actionId: result.actions[0].id, outcome: 'sent', turnId: `capacity-${n + 1}` }]);
  }
  assert.equal(h.store.task(h.taskId).totalAutoAttempts, 4); assert.equal(h.store.task(h.taskId).assist.blocked, true);
});

test('service restart and unknown delivery stay latched across toggle cycles and late success', async t => {
  const h = await monitoring(t);
  h.state.turnId = 'turn'; h.state.failedTurnId = 'turn';
  await h.poll([{ type: 'started', turnId: 'turn' }, { type: 'terminal', turnId: 'turn', status: 'failed', error: STREAM }]);
  h.advance(h.store.task(h.taskId).assist.dueAt - h.now());
  const { actions } = await h.poll([]);
  h.supervisor.desktop = new DesktopMonitor(h.supervisor);
  assert.equal(h.store.task(h.taskId).assist.blocked, true);
  await h.supervisor.desktop.configure(h.taskId, { revision: 1, autoContinue: false });
  await h.supervisor.desktop.configure(h.taskId, { revision: 2, autoContinue: true });
  await h.poll([{ type: 'action_result', actionId: actions[0].id, outcome: 'sent', turnId: 'next' }]);
  assert.equal(h.store.task(h.taskId).assist.blocked, true); assert.equal((await h.poll([])).actions.length, 0);
  await h.supervisor.desktop.configure(h.taskId, { revision: 3, reset: true });
  assert.equal(!!h.store.task(h.taskId).assist.blocked, false);
});

test('manual approval wait excludes no-output time and user stop cancels failed-turn retries', async t => {
  const h = await monitoring(t);
  await h.poll([{ type: 'started', turnId: 'turn' }, { type: 'waiting', turnId: 'turn' }]);
  h.advance(900000); await h.poll([]);
  assert.equal(!!h.store.task(h.taskId).assist.blocked, false);
  const before = h.store.task(h.taskId).outputMonitor.sinceAt;
  await h.poll([{ type: 'approval_result', key: 'manual', outcome: 'manual' }]);
  assert.equal(h.store.task(h.taskId).outputMonitor.sinceAt - before, 900000);
  await h.poll([{ type: 'user_stop' }, { type: 'terminal', turnId: 'turn', status: 'failed', error: STREAM }]);
  assert.equal(h.store.actions(h.taskId).length, 0);
});

test('monitoring stop and recovery strategy change cancel planned actions without interrupt', async t => {
  const h = await monitoring(t);
  h.state.turnId = 'turn'; h.state.failedTurnId = 'turn';
  await h.poll([{ type: 'started', turnId: 'turn' }, { type: 'terminal', turnId: 'turn', status: 'failed', error: STREAM }]);
  await h.supervisor.control(h.taskId, 'policy', { policy: { strategy: 'new_session' } });
  assert.equal(h.store.task(h.taskId).policy.strategy, 'new_session');
  await h.supervisor.control(h.taskId, 'observe_stop');
  h.advance(10000); assert.equal((await h.poll([])).actions.length, 0);
  assert.equal(h.adapter.interrupted, undefined);
});

test('a stale poll queued behind stop cannot dispatch a planned continuation', async t => {
  const h = await monitoring(t); h.state.turnId = 'turn'; h.state.failedTurnId = 'turn';
  await h.poll([{ type: 'started', turnId: 'turn' }, { type: 'terminal', turnId: 'turn', status: 'failed', error: STREAM }]);
  h.advance(10000);
  const stop = h.supervisor.control(h.taskId, 'observe_stop'), pending = h.poll([]);
  await stop; assert.equal((await pending).actions.length, 0); assert.equal(h.adapter.sent.length, 0);
});
