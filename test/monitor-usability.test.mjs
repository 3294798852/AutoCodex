import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, STREAM } from './helpers.mjs';
import { ProtocolRelay } from '../src/desktop/protocol-relay.mjs';
import { DesktopMonitor } from '../src/core/desktop-monitor.mjs';

async function setup(t) {
  const h = await harness(t), path = join(h.directory, 'root.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: 'root' } }) + '\n');
  h.adapter.readThreadSummary = async () => ({ id: 'root', name: 'Root', cwd: h.directory, path });
  const task = await h.supervisor.existing.add({ threadId: 'root' });
  await h.supervisor.desktop.configure(task.id, { revision: 0, autoContinue: true, autoApprove: true });
  const server = [], desktop = [], events = [];
  const relay = new ProtocolRelay({ now: h.now, toServer: m => server.push(m), toDesktop: m => desktop.push(m) });
  let seq = 0;
  relay.on('event', e => events.push({ ...e, seq: ++seq }));
  relay.rememberThread({ id: 'root', cwd: h.directory, name: 'Root' });
  const poll = () => h.supervisor.desktop.poll({ relayId: relay.id, threads: relay.snapshots(), events: events.splice(0) });
  const notify = (method, threadId, params = {}) => relay.fromServer({ method, params: { threadId, ...params } });
  const start = (id, turnId = id + '-turn') => notify('turn/started', id, { turn: { id: turnId } });
  const output = (id, n) => notify('item/completed', id, { item: { id: 'text' + n, type: 'agentMessage', text: '已经完成有效的业务工作并交付验证结果 ' + n } });
  const finish = (id, status = 'completed', error) => notify('turn/completed', id, { turn: { id: relay.thread(id).turnId, status, error } });
  const child = (id, parent = 'root') => { relay.rememberThread({ id, parentThreadId: parent, cwd: h.directory, name: id }); start(id); };
  await poll(); t.after(() => relay.close());
  return { ...h, task, relay, server, desktop, poll, notify, start, output, finish, child,
    get: id => h.store.tasks().find(t => t.threadId === id) };
}

test('accepted manual recovery resolves alerts live; failed submit and settings changes do not', async t => {
  const h = await setup(t); h.start('root'); h.finish('root', 'failed', { message: 'HTTP 401 unauthorized' }); await h.poll();
  assert.equal(h.get('root').assist.blockCode, 'auth');
  h.relay.fromDesktop({ id: 1, method: 'turn/start', params: { threadId: 'root', input: [] } });
  h.relay.fromServer({ id: 1, error: { message: 'failed to submit' } }); await h.poll();
  assert.equal(h.get('root').assist.blocked, true); assert.equal(h.store.records('alerts')[0].resolvedAt, undefined);
  h.relay.fromDesktop({ id: 2, method: 'thread/settings/update', params: { threadId: 'root' } });
  h.relay.fromServer({ id: 2, result: {} }); await h.poll(); assert.equal(h.get('root').assist.blocked, true);
  h.relay.fromDesktop({ id: 3, method: 'turn/start', params: { threadId: 'root', input: [] } });
  h.start('root', 'manual'); h.relay.fromServer({ id: 3, result: { turn: { id: 'manual' } } }); await h.poll();
  assert.equal(h.get('root').assist.blocked, false); assert.equal(h.get('root').assist.phase, 'running');
  assert(h.store.records('alerts')[0].resolvedAt); assert.equal(h.store.records('alerts')[0].acknowledgedAt, null);
  h.finish('root', 'failed', STREAM); await h.poll(); assert.equal(h.get('root').assist.phase, 'retry_wait');
});

test('uncertain actions stay protected when user continues; ordinary no-output protection clears on new progress', async t => {
  const h = await setup(t); h.start('root'); await h.poll();
  h.advance(600001); await h.poll(); assert.equal(h.get('root').assist.blockCode, 'no_effective_output');
  h.output('root', 1); await h.poll(); assert.equal(h.get('root').assist.blocked, false);
  const task = h.get('root'); h.supervisor.desktop.block(task, 'desktop_recycle_unknown', '核对回收结果');
  h.relay.fromDesktop({ id: 1, method: 'turn/start', params: { threadId: 'root', input: [] } });
  h.start('root', 'new'); h.relay.fromServer({ id: 1, result: { turn: { id: 'new' } } }); h.output('root', 2); await h.poll();
  assert.equal(h.get('root').assist.blocked, true); assert.equal(h.store.records('alerts')[0].resolvedAt, undefined);
});

test('nested children contribute progress, inherit approvals, release and rejoin without grabbing ownership', async t => {
  const h = await setup(t); h.start('root'); h.child('child'); h.child('grandchild', 'child'); await h.poll();
  assert.equal(h.get('grandchild').rootTaskId, h.task.id); assert.equal(h.get('child').assist.autoApprove, true);
  h.advance(599999); h.output('grandchild', 1); await h.poll(); h.advance(5); await h.poll();
  assert.equal(!!h.get('root').assist.blocked, false); assert.equal(!!h.get('child').assist.blocked, false);
  assert.equal(h.get('root').familyProgress.threadId, 'grandchild');
  h.supervisor.setDnd({ revision: 0, commonCommands: true });
  const approval = await h.supervisor.desktop.approve({ relayId: h.relay.id, threadId: 'grandchild', key: 'child-approval', generation: 0,
    state: h.relay.snapshots().find(s => s.id === 'grandchild'), request: { method: 'item/commandExecution/requestApproval',
      params: { threadId: 'grandchild', turnId: 'grandchild-turn', cwd: h.directory, command: 'git status' } } });
  assert.equal(approval.automatic, true);
  h.finish('grandchild'); await h.poll(); assert.equal(h.get('grandchild').observation.enabled, false);
  assert.equal((await h.poll()).watched.some(t => t.threadId === 'grandchild'), false);
  h.start('grandchild', 'again'); await h.poll(); assert.equal(h.get('grandchild').observation.enabled, true);
  await h.supervisor.control(h.task.id, 'observe_stop');
  assert.equal(h.get('child').observation.enabled, false); assert.equal(h.get('grandchild').observation.enabled, false);
  assert.equal((await h.poll()).watched.length, 0);
  assert.equal(h.server.length, 0); assert.equal(h.adapter.sent.length, 0); assert.equal(h.adapter.interrupted, undefined);
});

test('manual exclusion persists during activity and parent restart; unrelated fork/message is not a child', async t => {
  const h = await setup(t); h.start('root'); h.child('child'); await h.poll();
  await h.supervisor.control(h.get('child').id, 'observe_stop'); await h.poll(); assert.equal(h.get('child').observation.enabled, false);
  h.start('child', 'new'); await h.poll(); assert.equal(h.get('child').observation.enabled, false);
  await h.supervisor.control(h.task.id, 'observe_stop'); await h.supervisor.control(h.task.id, 'observe_start'); await h.poll();
  assert.equal(h.get('child').observation.enabled, false);
  await h.supervisor.control(h.get('child').id, 'observe_start'); await h.poll(); assert.equal(h.get('child').observation.enabled, true);
  h.relay.rememberThread({ id: 'fork', forkedFromId: 'root', cwd: h.directory }); h.start('fork');
  h.notify('item/completed', 'root', { item: { type: 'collabAgentToolCall', tool: 'sendMessage', receiverThreadIds: ['fork'], agentsStates: { fork: { status: 'running' } } } });
  await h.poll(); assert.equal(h.get('fork'), undefined);
});

test('child failure gets its own limited recovery and late old output cannot clear root error', async t => {
  const h = await setup(t); h.start('root'); h.child('child'); await h.poll();
  h.finish('child', 'failed', STREAM); await h.poll();
  assert.equal(h.get('child').assist.phase, 'retry_wait'); assert.equal(h.get('root').totalAutoAttempts, 0);
  h.finish('root', 'failed', { message: 'HTTP 401 unauthorized' }); await h.poll();
  h.notify('item/completed', 'root', { turnId: 'old-turn', item: { id: 'old', type: 'agentMessage', text: '旧回合非常长的输出应当不会解决新回合告警' } }); await h.poll();
  assert.equal(h.get('root').assist.blocked, true);
});

test('collaboration schema and read-only child reconciliation cover absent streamed child events', async t => {
  const h = await setup(t); h.start('root');
  h.notify('item/completed', 'root', { item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'root', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } } });
  await h.poll(); assert(h.get('child'));
  const reading = h.relay.refreshChildren(new Map([['root', { autoContinue: true }]]));
  for (let n = 0; n < 3; n++) {
    await new Promise(r => setImmediate(r));
    const request = h.server.at(-1); if (!request) continue;
    h.relay.fromServer({ id: request.id, result: { thread: { id: request.params.threadId, cwd: h.directory, turns: request.params.threadId === 'child'
      ? [{ id: 'child-turn', status: 'completed', items: [{ id: 'done', type: 'agentMessage', text: '子代理已经交付完整有效的工作结果' }] }] : [] } } });
  }
  await reading; await h.poll(); assert.equal(h.get('child').observation.enabled, false);
  assert.equal(h.get('root').familyProgress.threadId, 'child');
  assert(h.server.every(r => r.method === 'thread/read'));
});

test('completed parent agent does not hide an active grandchild; explicit closure releases watchers', async t => {
  const h = await setup(t); h.start('root'); h.child('child'); h.child('grandchild', 'child'); await h.poll();
  h.finish('child'); await h.poll(); await h.poll();
  assert.equal(h.get('child').observation.enabled, false); assert.equal(h.get('grandchild').observation.enabled, true);
  h.output('grandchild', 4); await h.poll(); assert.equal(h.get('root').familyProgress.threadId, 'grandchild');
  await h.supervisor.desktop.configure(h.task.id, { revision: 1, autoApprove: false }); await h.poll();
  assert.equal(h.get('grandchild').assist.autoApprove, false);
  h.notify('thread/closed', 'grandchild'); const result = await h.poll();
  assert.equal(h.get('grandchild').observation.enabled, false); assert.equal(result.watched.some(t => t.threadId === 'grandchild'), false);
});

test('replaying a historical wait result cannot release a reactivated child', async t => {
  const h = await setup(t); h.start('root'); h.child('child'); await h.poll();
  const item = { id: 'old-wait', type: 'collabAgentToolCall', tool: 'wait', senderThreadId: 'root', receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed', message: '完成旧任务并交付有效成果' } } };
  h.notify('item/completed', 'root', { item }); await h.poll(); assert.equal(h.get('child').observation.enabled, false);
  h.start('child', 'new-child-turn'); await h.poll();
  h.relay.rememberThread({ id: 'root', turns: [{ id: 'root-turn', items: [item] }] }); await h.poll();
  assert.equal(h.get('child').observation.enabled, true);
});

test('ordinary recovery alerts remain resolvable across service restart while uncertain receipts stay locked', async t => {
  const h = await setup(t); h.start('root'); h.finish('root', 'failed', { message: 'HTTP 401 unauthorized' }); await h.poll();
  h.supervisor.desktop = new DesktopMonitor(h.supervisor);
  assert.equal(h.get('root').assist.blockCode, 'auth');
  h.relay.fromDesktop({ id: 1, method: 'turn/start', params: { threadId: 'root', input: [] } });
  h.start('root', 'after-restart'); h.relay.fromServer({ id: 1, result: { turn: { id: 'after-restart' } } }); await h.poll();
  assert.equal(h.get('root').assist.blocked, false); assert(h.store.records('alerts')[0].resolvedAt);
});

test('waiting on a child approval suspends the family timer; resumed child progress restores it', async t => {
  const h = await setup(t); h.start('root'); h.child('child'); await h.poll();
  h.relay.fromServer({ id: 20, method: 'item/tool/requestUserInput', params: { threadId: 'child', turnId: 'child-turn', questions: [] } });
  await h.poll(); h.advance(900000); await h.poll();
  assert.equal(!!h.get('root').assist.blocked, false); assert.equal(h.get('root').familyWaiting, true);
  h.relay.fromDesktop({ id: 20, result: { answers: {} } }); h.output('child', 7); await h.poll();
  assert.equal(h.get('root').familyWaiting, false); assert.equal(h.get('root').outputMonitor.suspendedAt, null);
});

test('a child that starts and finishes between polls still contributes progress then releases', async t => {
  const h = await setup(t); h.start('root'); await h.poll();
  h.child('brief'); h.output('brief', 9); h.finish('brief'); h.notify('thread/closed', 'brief'); await h.poll();
  assert.equal(h.get('brief').observation.enabled, false); assert.equal(h.get('root').familyProgress.threadId, 'brief');
});

test('first child permission can inherit before its first periodic monitor poll', async t => {
  const h = await setup(t); h.start('root'); await h.poll(); h.child('quick');
  h.supervisor.setDnd({ revision: 0, commonCommands: true });
  const result = await h.supervisor.desktop.approve({ relayId: h.relay.id, threadId: 'quick', key: 'quick-request', generation: 0,
    state: h.relay.snapshots().find(s => s.id === 'quick'), request: { method: 'item/commandExecution/requestApproval',
      params: { threadId: 'quick', turnId: 'quick-turn', command: 'git status', cwd: h.directory } } });
  assert.equal(result.automatic, true); assert.equal(h.get('quick').parentTaskId, h.task.id);
});
