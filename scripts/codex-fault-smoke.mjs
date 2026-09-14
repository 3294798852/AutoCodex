import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';
import { CodexAdapter } from '../src/adapters/codex.mjs';

// The real Codex executable talks exclusively to this local test provider for generation.
// A separate Codex home prevents changes to the user's login/config/history.
mkdirSync(resolve('.work'), { recursive: true });
const directory = mkdtempSync(join(resolve('.work'), 'codex-fault-'));
const codexHome = join(directory, 'codex-home'), workspace = join(directory, 'workspace');
mkdirSync(codexHome); mkdirSync(workspace);
let requests = 0, failureMode = 'http_503';
const upstream = createServer((req, res) => {
  req.resume();
  if (req.url.includes('/responses')) requests++;
  if (failureMode === 'stream_disconnect' || failureMode === 'silent_stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_local_fixture"}}\n\n');
    if (failureMode === 'stream_disconnect') res.end();
    return;
  }
  const status = failureMode === 'quota_402' ? 402 : ['rate_limit', 'quota_hidden_429'].includes(failureMode) ? 429 : 503;
  const message = { capacity: 'The model is at capacity. Please try again later.', rate_limit: 'Rate limit exceeded. Too many requests.', quota_402: 'insufficient_quota: quota exceeded', quota_hidden_429: 'insufficient_quota: quota exceeded' }[failureMode] || 'AutoCodex local fixture: upstream temporarily unavailable';
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: failureMode.startsWith('quota_') ? 'insufficient_quota' : 'server_error', code: failureMode.startsWith('quota_') ? 'insufficient_quota' : failureMode } }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;
writeFileSync(join(codexHome, 'config.toml'), `model = "autocodex-fixture"\nmodel_provider = "autocodex_fixture"\n\n[model_providers.autocodex_fixture]\nname = "AutoCodex Local Fixture"\nbase_url = "${endpoint}"\nwire_api = "responses"\nenv_key = "AUTOCODEX_FIXTURE_KEY"\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 30000\nsupports_websockets = false\n`);
const store = new Store(join(directory, 'guard'));
const adapter = new CodexAdapter({ timeoutMs: 20000, environment: { CODEX_HOME: codexHome, AUTOCODEX_FIXTURE_KEY: 'local-fixture-not-a-real-key' } });
const supervisor = new Supervisor({ store, adapter, random: () => 0 });
const diagnostics = [];
adapter.on('diagnostic', data => { if (diagnostics.length < 20) diagnostics.push(data.message); });
let fatal;
supervisor.on('fatal', error => { fatal = error; });
async function waitTask(id, expected) {
  const deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    if (fatal) throw fatal;
    const task = store.task(id);
    if (expected === 'output_blocked' ? task.outputMonitor.blocked : task.status === expected) return task;
    if (['needs_attention', 'failed', 'stopped', 'completed'].includes(task.status)) throw new Error(`Unexpected state ${task.status}: ${JSON.stringify(store.records('alerts', id))}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for ${expected}: ${JSON.stringify(store.task(id))}`);
}
const results = [];
try {
  supervisor.start();
  for (const scenario of [
    { strategy: 'manual', failure: 'http_503' },
    { strategy: 'new_session', failure: 'http_503' },
    { strategy: 'manual', failure: 'stream_disconnect' },
    { strategy: 'manual', failure: 'capacity', continuations: 4 },
    { strategy: 'manual', failure: 'rate_limit', continuations: 4 },
    { strategy: 'manual', failure: 'quota_402', continuations: 0 },
    // This CLI drops the 429 body; only the status remains available to integrations.
    { strategy: 'manual', failure: 'quota_hidden_429', continuations: 4 },
    { strategy: 'new_session', failure: 'silent_stream', continuations: 0 },
  ]) {
    const strategy = scenario.strategy;
    failureMode = scenario.failure;
    const before = requests;
    const silent = failureMode === 'silent_stream';
    const task = await supervisor.createTask({ name: `Local ${failureMode} test / ${strategy}`, prompt: 'This is a local transport test. Reply with OK; do not use tools or change files.', cwd: workspace, sandbox: 'read-only', model: 'autocodex-fixture', policy: { strategy, baseDelayMs: 100, maxDelayMs: 200, rateLimitDelayMs: 100, jitterRatio: 0 } });
    if (silent) {
      // Measure an established silent stream; CLI startup can exceed the short fixture deadline.
      const readyBy = Date.now() + 10000;
      while (requests === before && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(requests - before, 1, 'Silent stream fixture must establish one model request');
      const active = store.task(task.id);
      active.outputMonitor.sinceAt = Date.now();
      store.saveTask(active);
      await supervisor.control(task.id, 'policy', { policy: { noOutputTimeoutMs: 1500 } });
    }
    const final = await waitTask(task.id, silent ? 'output_blocked' : strategy === 'manual' ? 'needs_attention' : 'failed');
    assert.equal(final.totalAutoAttempts, scenario.continuations ?? 2);
    assert.equal(final.threadChain.length, strategy === 'manual' || silent ? 1 : 2);
    assert.equal(requests - before, final.totalAutoAttempts + final.threadChain.length);
    if (silent) { assert.equal(final.status, 'running'); assert.equal(store.records('alerts', task.id)[0].code, 'no_effective_output'); }
    const history = await adapter.readThread(final.threadId);
    assert(history.turns.length >= 1);
    assert(history.turns.some(turn => turn.items.some(item => item.type === 'userMessage' && item.content.some(part => part.text?.includes('[AutoCodex action: ')))), 'Actual Codex history must retain the action marker used for reconciliation');
    const result = { failure: failureMode, strategy, finalStatus: final.status, automaticContinuations: final.totalAutoAttempts, sessions: final.threadChain.length, localRequests: requests - before, category: final.lastError?.category || null, noOutputBlocked: final.outputMonitor.blocked };
    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (silent) await supervisor.control(task.id, 'stop');
  }
  const report = { testedAt: new Date().toISOString(), endpoint: 'localhost fixture only', paidModelRequests: 0, results };
  writeFileSync(resolve('.work/codex-fault-report.json'), JSON.stringify(report, null, 2));
} catch (error) {
  writeFileSync(join(directory, 'failure.json'), JSON.stringify({ message: error.message, diagnostics, tasks: store.tasks(), events: store.events({ limit: 60 }) }, null, 2));
  process.stderr.write(`Real Codex fault test failed; diagnostic file: ${join(directory, 'failure.json')}\n`);
  throw error;
} finally {
  await supervisor.close(); store.close();
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
