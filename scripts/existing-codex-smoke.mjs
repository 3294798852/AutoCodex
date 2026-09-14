import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAdapter } from '../src/adapters/codex.mjs';
import { Store } from '../src/core/store.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';

mkdirSync('.work', { recursive: true });
const root = mkdtempSync(resolve('.work/existing-codex-')), configDir = join(root, 'codex'), workspace = join(root, 'workspace');
mkdirSync(configDir); mkdirSync(workspace);
let response, requests = 0, mode = 'hold';
const upstream = createServer(async (req, res) => {
  for await (const _ of req) { /* discard isolated request */ }
  requests++;
  if (mode === 'fail') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"local fixture unavailable"}}'); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const responseId = 'resp_' + randomUUID().replaceAll('-', '');
  const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  send('response.created', { response: { id: responseId, status: 'in_progress', output: [] } });
  response = () => {
    const item = { type: 'message', id: 'msg_' + responseId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '原有会话的隔离验证已经完成。', annotations: [] }] };
    send('response.output_item.added', { output_index: 0, item }); send('response.output_item.done', { output_index: 0, item });
    send('response.completed', { response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end(); response = null;
  };
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
writeFileSync(join(configDir, 'config.toml'), `model="autocodex-fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${upstream.address().port}/v1"\nwire_api="responses"\nenv_key="AUTOCODEX_FIXTURE_KEY"\nrequest_max_retries=0\nstream_max_retries=0\nsupports_websockets=false\n`);
const environment = { CODEX_HOME: configDir, AUTOCODEX_FIXTURE_KEY: 'local-fixture' };
const writer = new CodexAdapter({ environment }), reader = new CodexAdapter({ environment });
const store = new Store(join(root, 'guard')), supervisor = new Supervisor({ store, adapter: reader });
const wait = async predicate => { const until = Date.now() + 20000; while (Date.now() < until) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Existing-session fixture timed out'); };
const checks = []; let observed;
try {
  const thread = await writer.createThread({ cwd: workspace, sandbox: 'read-only' });
  await writer.startTurn({ threadId: thread.id, cwd: workspace, sandbox: 'read-only' }, 'Local fixture only. Reply briefly.');
  await wait(() => !!response);
  const page = await supervisor.existing.list(); assert(page.data.some(t => t.id === thread.id)); checks.push('official list discovers a conversation owned by another Codex process');
  observed = await supervisor.existing.add({ threadId: thread.id });
  assert.equal(observed.observation.phase, 'active_recent'); checks.push('already active conversation joins monitoring without resume');
  assert.equal((await reader.client.request('thread/loaded/list', {})).data.length, 0);
  await supervisor.control(observed.id, 'observe_stop'); response();
  await wait(async () => (await writer.readThread(thread.id)).turns.at(-1)?.status === 'completed');
  checks.push('stopping monitoring lets the original turn finish normally');
  await supervisor.control(observed.id, 'observe_start');
  await wait(async () => { await supervisor.existing.poll(observed.id); return store.task(observed.id).observation.phase === 'completed'; });
  assert(store.task(observed.id).lastOutput.includes('隔离验证')); checks.push('persisted real output and completion appear after monitoring resumes');
  mode = 'fail';
  await writer.startTurn({ threadId: thread.id, cwd: workspace, sandbox: 'read-only' }, 'Local error fixture.');
  await wait(async () => (await writer.readThread(thread.id)).turns.at(-1)?.status === 'failed');
  await supervisor.existing.poll(observed.id);
  assert.equal(store.task(observed.id).observation.phase, 'error');
  assert.equal(store.records('alerts').filter(a => a.code === 'observed_error').length, 1);
  checks.push('real HTTP 503 termination is shown as an error and alerts once');
  const summary = await reader.readThreadSummary(thread.id);
  const eventTypes = [...new Set(readFileSync(summary.path, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.type === 'event_msg').map(r => r.payload.type))];
  assert.equal(requests, 2); assert.equal((await reader.client.request('thread/loaded/list', {})).data.length, 0);
  const report = { testedAt: new Date().toISOString(), checks, localRequests: requests, paidModelRequests: 0, observedFailurePhase: store.task(observed.id).observation.phase, observedAlerts: store.records('alerts').map(a => a.code), eventTypes, readerLoadedThreads: 0 };
  writeFileSync('docs/validation/existing-codex-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(JSON.stringify({ root, error: error.message, observation: observed ? store.task(observed.id).observation : null })); throw error; }
finally { await supervisor.close(); await writer.close(); store.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); }
