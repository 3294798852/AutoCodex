import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonlRpcClient } from '../src/adapters/rpc-client.mjs';
import { CodexAdapter } from '../src/adapters/codex.mjs';
import { resolveCodex } from '../src/adapters/codex-discovery.mjs';
import { Store } from '../src/core/store.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';
import { createDashboardServer } from '../src/server/http.mjs';

mkdirSync('.work', { recursive: true });
const root = mkdtempSync(resolve('.work/desktop-relay-')), home = join(root, 'codex'), workspace = join(root, 'workspace');
mkdirSync(home); mkdirSync(workspace);
let mode = 'normal', requests = 0, lastInput, faultBudget = 0;
const recycleFile = join(workspace, 'AutoCodex-desktop-recycle-' + randomUUID() + '.txt');
const upstream = createServer(async (req, res) => {
  let text = ''; for await (const c of req) text += c;
  const body = JSON.parse(text); requests++; lastInput = body.input;
  writeFileSync(join(root, 'tools.json'), JSON.stringify(body.tools, null, 2));
  if (mode === 'fail' && faultBudget-- > 0) {
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Local upstream unavailable', type: 'server_error' } })); return;
  }
  const id = 'fixture_' + randomUUID().replaceAll('-', '');
  const output = mode === 'recycle' ? [{ type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, namespace: 'mcp__autocodex_recycle', name: 'recycle', arguments: JSON.stringify({ paths: [recycleFile] }), status: 'completed' }]
    : mode === 'command' ? [{ type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, name: 'exec_command',
    arguments: JSON.stringify({ cmd: 'git status --short', workdir: process.cwd(), sandbox_permissions: 'require_escalated', justification: 'Local read-only fixture.', max_output_tokens: 100 }), status: 'completed' }]
    : [{ type: 'message', id: 'msg_' + id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Isolated desktop relay fixture completed successfully.', annotations: [] }] }];
  if (['command', 'recycle'].includes(mode)) mode = 'normal';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}\n\n`);
  send('response.created', { response: { id, status: 'in_progress', output: [] } });
  output.forEach((item, output_index) => { send('response.output_item.added', { output_index, item }); send('response.output_item.done', { output_index, item }); });
  send('response.completed', { response: { id, status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
writeFileSync(join(home, 'config.toml'), `model="autocodex-fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${upstream.address().port}/v1"\nwire_api="responses"\nenv_key="AUTOCODEX_FIXTURE_KEY"\nrequest_max_retries=0\nstream_max_retries=0\nsupports_websockets=false\n`);
const env = { ...process.env, CODEX_HOME: home, AUTOCODEX_FIXTURE_KEY: 'local-fixture' };
const runtime = resolveCodex(), relayPath = resolve('.work/desktop-runtime/AutoCodexRelay.exe'), configPath = join(root, 'relay.json');
const store = new Store(join(root, 'guard')), adapter = new CodexAdapter({ environment: env });
const supervisor = new Supervisor({ store, adapter }), http = createDashboardServer(supervisor, { port: 0 });
let fatal, httpClosed = false;
supervisor.on('fatal', e => { fatal = e; });
supervisor.setDefaults({ baseDelayMs: 100, maxDelayMs: 300, rateLimitDelayMs: 100, jitterRatio: 0, noOutputTimeoutMs: 60000 });
await http.listen(); supervisor.start();
writeFileSync(configPath, JSON.stringify({ codex: runtime.command, codexArgs: runtime.args, connectionFile: join(store.directory, 'connection.json') }));
const desktop = new JsonlRpcClient({ command: relayPath, args: ['app-server', '--listen', 'stdio://'], env: { ...env,
  CODEX_CLI_PATH: relayPath, AUTOCODEX_RELAY_NODE: process.execPath, AUTOCODEX_RELAY_SCRIPT: resolve('src/desktop/main.mjs'), AUTOCODEX_RELAY_CONFIG: configPath } });
const notices = [], manual = [], diagnostics = [], checks = [];
desktop.on('notification', n => notices.push(n));
desktop.on('diagnostic', d => diagnostics.push(d.message));
desktop.on('request', r => { manual.push(r); void desktop.respond(r.id, r.method === 'mcpServer/elicitation/request' ? { action: 'cancel' } : { decision: 'accept' }); });
const waitFor = async (fn, label, timeout = 35000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fatal) throw fatal; const result = fn(); if (result) return result; await new Promise(r => setTimeout(r, 70)); }
  throw new Error('Timed out: ' + label);
};
const complete = id => notices.find(n => n.method === 'turn/completed' && n.params.turn.id === id);
const send = async (threadId, text = 'Local fixture only.') => (await desktop.request('turn/start', { threadId, input: [{ type: 'text', text }] })).turn;
async function enroll(strategy = 'manual') {
  mode = 'normal';
  const { thread } = await desktop.request('thread/start', { cwd: workspace, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' });
  const turn = await send(thread.id); await waitFor(() => complete(turn.id), 'initial normal completion');
  supervisor.setDefaults({ strategy });
  const task = await supervisor.existing.add({ threadId: thread.id });
  await supervisor.desktop.configure(task.id, { revision: 0, autoContinue: true, autoApprove: true });
  await waitFor(() => store.task(task.id).assist.connected, 'relay connected');
  return task;
}
try {
  const init = await desktop.connect(); checks.push('native exe starts real CLI and forwards initialization');
  const task = await enroll(); mode = 'fail'; faultBudget = 3;
  await send(task.threadId);
  await waitFor(() => store.task(task.id).assist.blocked, 'two retries then stop');
  assert.equal(store.task(task.id).totalAutoAttempts, 2);
  assert.equal(store.task(task.id).incident.consecutiveSame, 3);
  assert.equal(store.task(task.id).controlMode, 'observe');
  checks.push('same original writer: initial 503 plus two continues then alert');
  const continued = notices.filter(n => n.method === 'turn/started' && n.params.threadId === task.threadId);
  assert.equal(continued.length, 4); checks.push('desktop receives all automatic turn notifications');
  const fallback = await enroll('new_session'); mode = 'fail'; faultBudget = 4;
  await send(fallback.threadId);
  await waitFor(() => store.records('alerts', fallback.id).some(a => a.code === 'replacement_failed_immediately'), 'new task first failure');
  const failed = store.task(fallback.id);
  assert.equal(failed.threadChain.length, 2); assert.equal(failed.totalAutoAttempts, 2);
  assert.equal(store.records('handoffs', fallback.id).length, 1);
  assert(JSON.stringify(lastInput).includes(fallback.threadId)); checks.push('fresh original-desktop task receives handoff; immediate first failure halts');
  const recovery = await enroll('new_session'); mode = 'fail'; faultBudget = 3;
  await send(recovery.threadId);
  await waitFor(() => store.task(recovery.id).threadChain.length === 2 && store.task(recovery.id).assist.phase === 'completed', 'successful fresh task');
  checks.push('replacement succeeds and stays visible through original connection');
  const approvals = await enroll();
  supervisor.setDnd({ revision: 0, commonCommands: true, outsideWorkspace: true });
  mode = 'command'; const run = await send(approvals.threadId); await waitFor(() => complete(run.id), 'automatic command approval');
  await waitFor(() => store.task(approvals.id).totalAutoApprovals === 1, 'approval audit');
  assert.equal(manual.length, 0); checks.push('real command permission automatically answered without desktop prompt');
  writeFileSync(recycleFile, 'Isolated original desktop recycle fixture');
  supervisor.setDnd({ revision: 1, recycleDeletes: true });
  mode = 'recycle'; const recycling = await send(approvals.threadId); await waitFor(() => complete(recycling.id), 'original desktop MCP recycle');
  assert.equal(existsSync(recycleFile), false, 'MCP recycle must move the fixture to Recycle Bin');
  await waitFor(() => store.events({ taskId: approvals.id }).some(e => e.type === 'desktop_recycle_result'), 'recycle audit');
  assert.equal(manual.length, 0);
  const restored = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$found = 0
foreach ($item in $shell.Namespace(10).Items()) {
  $original = Join-Path ([string]$item.ExtendedProperty('System.Recycle.DeletedFrom')) ([string]$item.ExtendedProperty('System.FileName'))
  if ($original -eq $env:AUTOCODEX_RECYCLE_FIXTURE) { $found++; $item.InvokeVerb('undelete') }
}
if ($found -ne 1) { throw 'Expected exactly one isolated fixture in Recycle Bin' }
`], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AUTOCODEX_RECYCLE_FIXTURE: recycleFile } });
  assert.equal(restored.status, 0, restored.stderr);
  await waitFor(() => existsSync(recycleFile), 'restore test fixture');
  assert.equal(readFileSync(recycleFile, 'utf8'), 'Isolated original desktop recycle fixture');
  checks.push('original-desktop MCP tool: signed confirmation, native recycle, result audit and fixture restoration');
  const current = store.task(approvals.id);
  await supervisor.desktop.configure(approvals.id, { revision: current.assist.revision, autoApprove: false });
  mode = 'command'; const normal = await send(approvals.threadId); await waitFor(() => complete(normal.id), 'manual command approval');
  assert.equal(manual.length, 1); checks.push('disabled switch preserves original desktop approval');
  await http.close(); httpClosed = true;
  mode = 'command'; const offline = await send(approvals.threadId); await waitFor(() => complete(offline.id), 'offline passthrough');
  assert.equal(manual.length, 2); checks.push('monitor offline: normal conversation and manual approval still work');
  const report = { testedAt: new Date().toISOString(), scope: 'real native relay and Codex CLI, simulated desktop RPC client, isolated local upstream',
    codex: init.userAgent, checks, localRequests: requests, paidModelRequests: 0 };
  writeFileSync('docs/validation/desktop-relay-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (e) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ message: e.message, tasks: store.tasks(), events: store.events({ limit: 80 }), notices, manual, diagnostics }, null, 2));
  console.error('Diagnostic directory: ' + root); throw e;
} finally {
  await desktop.close(); await supervisor.close(); if (!httpClosed) await http.close(); store.close();
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
}
