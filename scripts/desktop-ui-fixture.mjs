import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverDesktop, desktopRelayPaths } from '../src/desktop/discovery.mjs';
import { CodexAdapter, resolveCodex } from '../src/adapters/codex.mjs';
import { Store } from '../src/core/store.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';
import { createDashboardServer } from '../src/server/http.mjs';

mkdirSync('.work', { recursive: true });
const root = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(resolve('.work/desktop-ui-')), home = join(root, 'codex'), workspace = join(root, 'workspace');
if (!root.startsWith(resolve('.work/desktop-ui-'))) throw new Error('Not a desktop fixture directory');
mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
const modePath = join(root, 'mode.json'); writeFileSync(modePath, JSON.stringify({ mode: 'normal' }));
let requests = 0;
const provider = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  requests++;
  writeFileSync(join(root, 'last-request.json'), text);
  const fixture = JSON.parse(readFileSync(modePath, 'utf8'));
  if (fixture.mode === 'fail' && fixture.remaining > 0) {
    writeFileSync(modePath, JSON.stringify({ ...fixture, remaining: fixture.remaining - 1 }));
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Isolated desktop upstream unavailable', type: 'server_error' } })); return;
  }
  const id = 'ui_' + randomUUID().replaceAll('-', '');
  const output = fixture.mode === 'command' ? [{ type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, name: 'exec_command',
    arguments: JSON.stringify({ cmd: 'git status --short', workdir: process.cwd(), sandbox_permissions: 'require_escalated', justification: 'Local read-only desktop integration fixture.', max_output_tokens: 100 }), status: 'completed' }]
    : [{ type: 'message', id: 'msg_' + id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'AutoCodex isolated desktop fixture completed. Original conversation remains available.', annotations: [] }] }];
  if (fixture.mode === 'command') writeFileSync(modePath, JSON.stringify({ mode: 'normal' }));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}\n\n`);
  send('response.created', { response: { id, status: 'in_progress', output: [] } });
  output.forEach((item, output_index) => { send('response.output_item.added', { output_index, item }); send('response.output_item.done', { output_index, item }); });
  send('response.completed', { response: { id, status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
});
await new Promise(r => provider.listen(0, '127.0.0.1', r));
writeFileSync(join(home, 'config.toml'), `model="autocodex-fixture"\nmodel_provider="fixture"\n[windows]\nsandbox="unelevated"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nenv_key="AUTOCODEX_FIXTURE_KEY"\nrequest_max_retries=0\nstream_max_retries=0\nsupports_websockets=false\n`);
writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'local-fixture-only' }));
const env = { ...process.env, CODEX_HOME: home, AUTOCODEX_FIXTURE_KEY: 'local-fixture-only' };
const seed = new CodexAdapter({ environment: env });
const thread = await seed.createThread({ cwd: workspace, model: 'autocodex-fixture' });
await seed.client.request('thread/name/set', { threadId: thread.id, name: 'AutoCodex isolated desktop test' });
const done = new Promise(resolve => seed.on('notification', n => { if (n.method === 'turn/completed') resolve(); }));
await seed.startTurn({ threadId: thread.id, cwd: workspace }, 'Initialize the isolated desktop fixture.'); await done; await seed.close();
const store = new Store(join(root, 'guard')), adapter = new CodexAdapter({ environment: env });
const supervisor = new Supervisor({ store, adapter }), http = createDashboardServer(supervisor, { port: 0 });
supervisor.setDefaults({ baseDelayMs: 1200, maxDelayMs: 2000, jitterRatio: 0 });
supervisor.setDnd({ revision: supervisor.dnd.revision, commonCommands: true, outsideWorkspace: true, recycleDeletes: true, systemTools: true, confirmationPrompts: true });
const task = await supervisor.existing.add({ threadId: thread.id });
await supervisor.desktop.configure(task.id, { revision: 0, autoContinue: true, autoApprove: true });
await http.listen(); supervisor.start();
const paths = desktopRelayPaths(process.cwd()), cli = resolveCodex(), config = join(root, 'relay.json');
writeFileSync(config, JSON.stringify({ codex: cli.command, codexArgs: cli.args, connectionFile: join(store.directory, 'connection.json') }));
const log = openSync(join(root, 'desktop.log'), 'a');
const app = spawn(discoverDesktop().path, ['--user-data-dir=' + join(root, 'browser')], { windowsHide: false, stdio: ['ignore', log, log], env: { ...env,
  CODEX_ELECTRON_USER_DATA_PATH: join(root, 'electron'), CODEX_CLI_PATH: paths.executable,
  AUTOCODEX_RELAY_CONFIG: config, AUTOCODEX_RELAY_NODE: process.execPath, AUTOCODEX_RELAY_SCRIPT: paths.script } });
closeSync(log);
writeFileSync('.work/desktop-ui-current.json', JSON.stringify({ root, taskId: task.id, threadId: thread.id, desktopPid: app.pid, modePath, connectionFile: join(store.directory, 'connection.json') }, null, 2));
console.log(JSON.stringify({ root, taskId: task.id, threadId: thread.id, desktopPid: app.pid, fixture: 'isolated local provider; close this test window to finish' }));
await new Promise(resolve => app.once('exit', resolve));
writeFileSync(join(root, 'results.json'), JSON.stringify({ testedAt: new Date().toISOString(), task: store.task(task.id), events: store.events({ limit: 200 }), requests, paidModelRequests: 0 }, null, 2));
await supervisor.close(); await http.close(); store.close(); provider.closeAllConnections(); await new Promise(r => provider.close(r));
