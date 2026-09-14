import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CodexAdapter } from '../src/adapters/codex.mjs';
import { Store } from '../src/core/store.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';

mkdirSync('.work', { recursive: true });
const root = mkdtempSync(resolve('.work/dnd-codex-')), workspace = join(root, 'workspace'), configDir = join(root, 'codex');
mkdirSync(workspace); mkdirSync(configDir);
const file = join(workspace, 'AutoCodex-dynamic-' + randomUUID() + '.txt');
writeFileSync(file, 'dynamic recycle fixture');
let requests = 0, mode = 'inspect', toolSpec = [], lastInput = null;
const upstream = createServer(async (req, res) => {
  let data = ''; for await (const chunk of req) data += chunk;
  const body = JSON.parse(data); requests++; lastInput = body.input;
  if (body.tools) { toolSpec = body.tools; writeFileSync(join(root, 'tool-spec.json'), JSON.stringify(toolSpec, null, 2)); }
  const responseId = 'resp_' + randomUUID().replaceAll('-', '');
  const output = mode === 'recycle' ? [{ type: 'function_call', id: 'fc_' + responseId, call_id: 'call_' + responseId,
    name: 'autocodex_recycle', arguments: JSON.stringify({ paths: [file] }), status: 'completed' }]
    : mode === 'command' ? [{ type: 'function_call', id: 'fc_' + responseId, call_id: 'call_' + responseId,
      name: 'exec_command', arguments: JSON.stringify({ cmd: 'git status --short', workdir: process.cwd(), sandbox_permissions: 'require_escalated', justification: 'Local AutoCodex approval fixture: read Git status only.', max_output_tokens: 500 }), status: 'completed' }]
    : [{ type: 'message', id: 'msg_' + responseId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Local fixture completed.', annotations: [] }] }];
  if (mode === 'recycle' || mode === 'command') mode = 'done';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (event, payload) => res.write('event: ' + event + '\ndata: ' + JSON.stringify({ type: event, ...payload }) + '\n\n');
  send('response.created', { response: { id: responseId, status: 'in_progress', output: [] } });
  output.forEach((item, output_index) => { send('response.output_item.added', { output_index, item }); send('response.output_item.done', { output_index, item }); });
  send('response.completed', { response: { id: responseId, status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
writeFileSync(join(configDir, 'config.toml'), 'model="autocodex-fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:' + upstream.address().port + '/v1"\nwire_api="responses"\nenv_key="AUTOCODEX_FIXTURE_KEY"\nrequest_max_retries=0\nstream_max_retries=0\nsupports_websockets=false\n');
const store = new Store(join(root, 'guard')), adapter = new CodexAdapter({ environment: { CODEX_HOME: configDir, AUTOCODEX_FIXTURE_KEY: 'local-fixture' } });
const supervisor = new Supervisor({ store, adapter });
let fatal; supervisor.on('fatal', error => { fatal = error; });
const notifications = []; adapter.on('request', request => notifications.push({ method: request.method, params: request.params }));
const wait = async taskId => {
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    if (fatal) throw fatal;
    const task = store.task(taskId);
    if (task.status === 'completed') return task;
    if (['needs_attention', 'failed', 'stopped', 'waiting_user'].includes(task.status)) throw new Error('Unexpected state: ' + task.status + '; ' + JSON.stringify(store.records('approvals', taskId)));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + JSON.stringify(store.events({ taskId, limit: 10 })));
};
try {
  supervisor.setDnd({ revision: 0, recycleDeletes: true });
  mode = 'recycle';
  const task = await supervisor.createTask({ prompt: 'Local fixture test only.', cwd: workspace });
  const final = await wait(task.id);
  assert(final.recycleToolAvailable); assert.equal(final.totalAutoApprovals, 1);
  assert(!existsSync(file)); assert.equal(notifications[0]?.method, 'item/tool/call');
  assert(JSON.stringify(lastInput).includes('recycled'), 'Codex must send dynamic tool output back to the provider');
  supervisor.setDnd({ revision: 1, commonCommands: true, outsideWorkspace: true });
  mode = 'command';
  const commandTask = await supervisor.createTask({ prompt: 'Local read-only Git status fixture.', cwd: process.cwd() });
  const commandFinal = await wait(commandTask.id);
  assert.equal(commandFinal.totalAutoApprovals, 1);
  assert(notifications.some(request => request.method === 'item/commandExecution/requestApproval'));
  assert(JSON.stringify(lastInput).includes('Process exited with code 0'), 'Codex must report successful command execution');
  const restored = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$found = 0
foreach ($item in $shell.Namespace(10).Items()) {
  $original = Join-Path ([string]$item.ExtendedProperty('System.Recycle.DeletedFrom')) ([string]$item.ExtendedProperty('System.FileName'))
  if ($original -eq $env:AUTOCODEX_RECYCLE_FIXTURE) { $found++; $item.InvokeVerb('undelete') }
}
if ($found -ne 1) { throw 'Expected exactly one fixture in Recycle Bin' }
`], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AUTOCODEX_RECYCLE_FIXTURE: file } });
  assert.equal(restored.status, 0, restored.stderr);
  for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(readFileSync(file, 'utf8'), 'dynamic recycle fixture');
  const report = { testedAt: new Date().toISOString(), realCodex: adapter.state.detail, dynamicRegistration: true, dynamicToolRpc: true,
    nativeRecycle: true, fixtureRestored: true, toolResultAccepted: true, realCommandApproval: true, commandExecuted: 'git status --short', automaticApprovals: final.totalAutoApprovals + commandFinal.totalAutoApprovals, localRequests: requests, paidModelRequests: 0 };
  writeFileSync('.work/dnd-codex-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ message: error.message, notifications, events: store.events({ limit: 80 }) }, null, 2));
  console.error('Diagnostic directory: ' + root); throw error;
} finally { await supervisor.close(); store.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
