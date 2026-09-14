import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAdapter, resolveCodex } from '../src/adapters/codex.mjs';
import { JsonlRpcClient } from '../src/adapters/rpc-client.mjs';

// Every generated conversation and upstream request is confined to this fixture.
mkdirSync('.work', { recursive: true });
const root = mkdtempSync(resolve('.work/monitor-probe-')), configDir = join(root, 'codex'), workspace = join(root, 'workspace');
mkdirSync(configDir); mkdirSync(workspace);
const hookLog = join(root, 'hooks.jsonl'), hookScript = join(root, 'hook.mjs');
writeFileSync(hookScript, `import { appendFileSync } from 'node:fs';\nlet s=''; for await (const c of process.stdin) s+=c; const e=JSON.parse(s); appendFileSync(${JSON.stringify(hookLog)},JSON.stringify({event:e.hook_event_name,turnId:e.turn_id})+'\\n'); process.stdout.write('{}');\n`);
let mode = 'success', requests = 0, pendingResponse;
const upstream = createServer(async (req, res) => {
  for await (const _ of req) { /* isolated request */ } requests++;
  if (mode === '503') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"local fixture unavailable"}}'); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const id = 'resp_' + randomUUID().replaceAll('-', ''), send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  send('response.created', { response: { id, status: 'in_progress', output: [] } });
  if (mode === 'disconnect') { res.end(); return; }
  if (mode === 'hold') { pendingResponse = res; return; }
  const item = { type: 'message', id: 'msg_' + id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Local fixture complete.', annotations: [] }] };
  send('response.output_item.added', { output_index: 0, item }); send('response.output_item.done', { output_index: 0, item });
  send('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
writeFileSync(join(configDir, 'config.toml'), `model="autocodex-fixture"\nmodel_provider="fixture"\n[features]\nhooks=true\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${upstream.address().port}/v1"\nwire_api="responses"\nenv_key="AUTOCODEX_FIXTURE_KEY"\nrequest_max_retries=0\nstream_max_retries=0\nsupports_websockets=false\n`);
const quotePs = value => "'" + value.replaceAll("'", "''") + "'";
const hooks = Object.fromEntries(['UserPromptSubmit', 'Stop', 'Interrupt', 'PermissionRequest'].map(event => [event, [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${hookScript}"`, commandWindows: `& ${quotePs(process.execPath)} ${quotePs(hookScript)}`, timeout: 3 }] }]]));
writeFileSync(join(configDir, 'hooks.json'), JSON.stringify({ hooks }));
const runtime = resolveCodex(process.env.AUTOCODEX_PROBE_CODEX), environment = { ...runtime.env, CODEX_HOME: configDir, AUTOCODEX_FIXTURE_KEY: 'local-fixture' };
const writer = new JsonlRpcClient({ ...runtime, env: environment, args: [...runtime.args, 'app-server', '--listen', 'stdio://'] });
const reader = new CodexAdapter({ command: process.env.AUTOCODEX_PROBE_CODEX, environment });
const wait = async predicate => { const until = Date.now() + 20000; while (Date.now() < until) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Monitor probe timed out'); };
const capture = async fn => { try { return { ok: true, result: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };
const hookEvents = () => existsSync(hookLog) ? readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const report = { testedAt: new Date().toISOString(), version: spawnSync(runtime.command, [...runtime.args, '--version'], { env: environment, encoding: 'utf8', windowsHide: true }).stdout.trim(), paidModelRequests: 0, hookCases: [] };
const terminals = new Map();
writer.on('notification', n => { if (n.method === 'turn/completed') terminals.set(n.params.turn.id, n.params.turn); });
try {
  await writer.connect();
  report.hookTypes = (await writer.request('hooks/list', { cwds: [workspace] })).data[0].hooks.map(h => h.eventName);
  const { thread } = await writer.request('thread/start', { cwd: workspace, sandbox: 'read-only', approvalPolicy: 'on-request', historyMode: 'legacy' });
  const turn = async newMode => {
    mode = newMode;
    const { turn } = await writer.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Local transport fixture only.' }] });
    if (newMode === 'hold') { await wait(() => !!pendingResponse); await writer.request('turn/interrupt', { threadId: thread.id, turnId: turn.id }); pendingResponse.destroy(); pendingResponse = null; }
    await wait(() => terminals.has(turn.id));
  };
  await turn('success');
  await reader.connect();
  report.idleOwnerResume = await capture(() => reader.client.request('thread/resume', { threadId: thread.id, cwd: workspace }));
  assert.equal(report.idleOwnerResume.ok, false); assert.match(report.idleOwnerResume.message, /active writer/);
  report.otherProcessUnsubscribe = await reader.client.request('thread/unsubscribe', { threadId: thread.id });
  report.resumeAfterForeignUnsubscribe = await capture(() => reader.client.request('thread/resume', { threadId: thread.id, cwd: workspace }));
  const queued = await capture(() => reader.client.request('thread/queue/add', { threadId: thread.id, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'Isolated queued fixture.' }] }));
  report.foreignQueueAdd = queued;
  if (queued.ok) {
    const count = requests;
    await new Promise(r => setTimeout(r, 2000)); report.queueStartedAutomatically = requests !== count;
    report.foreignQueueStart = await capture(() => reader.client.request('thread/queue/start', { threadId: thread.id }));
    // Remove this fixture's queue entry through its owner before testing further turns.
    await capture(() => writer.request('thread/queue/delete', { threadId: thread.id, queuedSubmissionId: queued.result.queuedSubmission.id }));
  }
  await turn('hold');
  await writer.close();
  report.resumeAfterOwnerExit = await capture(async () => { const t = await reader.resumeThread({ threadId: thread.id, cwd: workspace }); return { id: t.id, turnCount: t.turns?.length }; });
  assert.equal(report.resumeAfterOwnerExit.ok, true);
  for (const caseMode of ['success', '503', 'disconnect']) {
    mode = caseMode; const before = hookEvents().length;
    const result = await new Promise((resolve, reject) => {
      const proc = spawn(runtime.command, [...runtime.args, 'exec', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--json', '--sandbox', 'read-only', '-C', workspace, 'Local fixture only. Reply briefly.'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', diagnostic = ''; proc.stdout.on('data', c => { output += c; }); proc.stderr.on('data', c => { diagnostic += c; });
      const timer = setTimeout(() => { proc.kill(); reject(new Error('Hook CLI fixture timed out')); }, 25000);
      proc.once('error', reject); proc.once('exit', code => { clearTimeout(timer); resolve({ code, output, diagnostic }); });
    });
    const events = hookEvents().slice(before).map(e => e.event);
    writeFileSync(join(root, `cli-${caseMode}.json`), JSON.stringify(result));
    report.hookCases.push({ mode, exitCode: result.code, events });
    if (caseMode === 'success') assert(events.includes('Stop'), 'Positive control must execute the Stop hook: ' + result.diagnostic);
  }
  report.localRequests = requests;
  mkdirSync('docs/validation', { recursive: true });
  writeFileSync('docs/validation/monitor-capability-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(JSON.stringify({ root, message: error.message, report })); throw error; }
finally { await writer.close(); await reader.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); }
