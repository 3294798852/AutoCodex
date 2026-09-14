import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launchService, inspectInstance } from '../src/server/launcher.mjs';
import { tempDirectory } from './helpers.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
async function freePort() {
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}
async function call(directory, path, data) {
  const c = json(join(directory, 'connection.json'));
  const response = await fetch(c.origin + '/api/v1' + path, { signal: AbortSignal.timeout(3000), headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
  assert.equal(response.status, path === '/tasks' ? 201 : path === '/shutdown' ? 202 : 200); return response.json();
}
async function shutdown(directory) {
  if (!existsSync(join(directory, 'supervisor.lock')) || !existsSync(join(directory, 'connection.json'))) return;
  const c = json(join(directory, 'connection.json')), lock = json(join(directory, 'supervisor.lock'));
  if (lock.pid !== c.pid || c.pid === process.pid) return;
  try { process.kill(c.pid, 0); } catch { return; }
  await call(directory, '/shutdown', {});
  for (let i = 0; i < 80; i++) { try { process.kill(c.pid, 0); } catch { return; } await delay(50); }
  throw new Error('Isolated launcher fixture did not stop');
}
async function fixture(t, demo = true) {
  const tmp = tempDirectory('launcher 中文 '), port = await freePort();
  t.after(async () => { await shutdown(tmp.directory); tmp.remove(); });
  const request = { args: [resolve('src/main.mjs'), '--port', String(port), '--data-dir', tmp.directory, ...(demo ? ['--demo'] : [])],
    cwd: process.cwd(), dataDirectory: tmp.directory, portExplicit: true };
  return { ...tmp, request, port };
}

test('repeated launch reuses same PID and preserves running task, settings, credentials and logs', async t => {
  const h = await fixture(t), initial = await launchService(h.request);
  assert.equal(initial.status, 'started'); assert.equal((await inspectInstance(h.directory)).status, 'ready');
  const connection = readFileSync(join(h.directory, 'connection.json'), 'utf8');
  const task = await call(h.directory, '/tasks', { name: 'Kept running', cwd: h.directory, prompt: 'Isolated no-output fixture', scenario: 'no_output' });
  await call(h.directory, '/dnd', { revision: 0, commonCommands: true });
  const log = readFileSync(join(h.directory, 'service-error.log'), 'utf8');
  unlinkSync(initial.launchPath);
  const repeated = await launchService(h.request);
  assert.equal(repeated.status, 'reused'); assert.equal(repeated.pid, initial.pid); assert(existsSync(repeated.launchPath));
  assert.equal(readFileSync(join(h.directory, 'connection.json'), 'utf8'), connection);
  assert.equal(readFileSync(join(h.directory, 'service-error.log'), 'utf8'), log);
  const state = await call(h.directory, '/state');
  assert.equal(state.tasks.length, 1); assert.equal(state.tasks[0].id, task.id); assert.equal(state.tasks[0].status, 'running');
  assert.equal(state.dnd.settings.commonCommands, true); assert.equal(state.tasks[0].totalAutoAttempts, 0);
  assert(!JSON.stringify(repeated).includes(json(join(h.directory, 'connection.json')).token));
  const defaultPort = { ...h.request, portExplicit: false, args: h.request.args.map((arg, i) => i === 2 ? '3210' : arg) };
  assert.equal((await launchService(defaultPort)).origin, initial.origin);
});

test('simultaneous launches converge on one healthy service and lock owner', async t => {
  const h = await fixture(t);
  const results = await Promise.all([launchService(h.request), launchService(h.request), launchService(h.request)]);
  assert.equal(new Set(results.map(r => r.pid)).size, 1);
  assert.equal(results.filter(r => r.status === 'started').length, 1);
  assert.equal(json(join(h.directory, 'supervisor.lock')).pid, results[0].pid);
});

test('stale connection from another data directory never reuses or shuts down that service', async t => {
  const first = await fixture(t), second = await fixture(t);
  const original = await launchService(first.request);
  writeFileSync(join(second.directory, 'connection.json'), readFileSync(join(first.directory, 'connection.json')));
  const fresh = await launchService(second.request);
  assert.equal(fresh.status, 'started'); assert.notEqual(fresh.pid, original.pid);
  assert.equal((await inspectInstance(first.directory)).status, 'ready');
});

test('explicit port, mode and Codex path changes are rejected without disturbing current instance', async t => {
  const h = await fixture(t, false), original = await launchService(h.request);
  const args = [...h.request.args]; args[2] = String(h.port === 65535 ? 3211 : h.port + 1);
  await assert.rejects(launchService({ ...h.request, args }), /指定的新端口/);
  await assert.rejects(launchService({ ...h.request, args: [...h.request.args, '--demo'] }), /正在运行真实模式/);
  await assert.rejects(launchService({ ...h.request, args: [...h.request.args, '--codex-command=missing-codex.exe'] }), /新 Codex 路径/);
  assert.equal((await launchService({ ...h.request, probeOnly: true })).pid, original.pid);
});

test('occupied port reports the actual startup reason and keeps unrelated server alive', async t => {
  const h = await fixture(t), server = createServer((_req, res) => res.end('unrelated'));
  await new Promise(r => server.listen(h.port, '127.0.0.1', r));
  try {
    writeFileSync(join(h.directory, 'service-error.log'), 'Error: Old failure that must not be reported\n');
    await assert.rejects(launchService(h.request), error => error.message.includes(`端口 ${h.port}`) && error.message.includes('-Port') && !error.message.includes('Old failure'));
    assert.equal(await (await fetch(`http://127.0.0.1:${h.port}`)).text(), 'unrelated');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('live lock without a responsive service is preserved and does not spawn another process', async t => {
  const h = await fixture(t), lock = JSON.stringify({ pid: process.pid, nonce: 'isolated-live-lock' });
  writeFileSync(join(h.directory, 'supervisor.lock'), lock);
  await assert.rejects(launchService(h.request, { timeoutMs: 350, probeTimeoutMs: 100 }), /已保留原进程和数据/);
  assert.equal(readFileSync(join(h.directory, 'supervisor.lock'), 'utf8'), lock);
  assert(!existsSync(join(h.directory, 'service-error.log')));
});

test('bad authentication and non-loopback or redirecting endpoints are never reused', async t => {
  const h = await fixture(t), original = await launchService(h.request), connection = json(join(h.directory, 'connection.json'));
  const set = change => writeFileSync(join(h.directory, 'connection.json'), JSON.stringify({ ...connection, ...change }));
  try {
    set({ token: '0'.repeat(64) }); assert.equal((await inspectInstance(h.directory)).status, 'waiting');
    set({ origin: 'https://example.invalid' }); assert.equal((await inspectInstance(h.directory)).status, 'waiting');
    set({ origin: 'http://127.0.0.1:99999' }); assert.equal((await inspectInstance(h.directory)).status, 'waiting');
    set({ pid: connection.pid + 1 }); assert.equal((await inspectInstance(h.directory)).status, 'waiting');
    let redirected = 0;
    const server = createServer((req, res) => { if (req.url === '/target') redirected++; res.writeHead(302, { Location: '/target' }); res.end(); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try { set({ origin: `http://127.0.0.1:${server.address().port}` }); assert.equal((await inspectInstance(h.directory)).status, 'waiting'); assert.equal(redirected, 0); }
    finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  } finally { set({}); }
  assert.equal((await launchService(h.request)).pid, original.pid);
});

test('foreground probe does not start a new service; startup stderr is localized and redacted', async t => {
  const h = await fixture(t);
  assert.deepEqual(await launchService({ ...h.request, probeOnly: true }), { ok: true, status: 'absent' });
  assert(!existsSync(join(h.directory, 'service.log')));
  const entry = join(h.directory, 'fails.mjs');
  writeFileSync(entry, "throw new Error('文件无法打开 password=fixture-private-value');\n");
  await assert.rejects(launchService({ ...h.request, args: [entry, ...h.request.args.slice(1)] }), error => /文件无法打开/.test(error.message) && error.message.includes('[REDACTED]') && !error.message.includes('fixture-private-value'));
});

test('Windows PowerShell repeated File and direct invocation plus Foreground reuse work', { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
  const h = await fixture(t), script = resolve('Start-AutoCodex.ps1');
  const run = args => new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
      windowsHide: true, env: { ...process.env, AUTOCODEX_LAUNCH_TEST_RUNTIME: process.cwd(), AUTOCODEX_LAUNCH_TEST_SCRIPT: relocated, AUTOCODEX_LAUNCH_TEST_DATA: h.directory, AUTOCODEX_LAUNCH_TEST_PORT: String(h.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; proc.stdout.on('data', p => { out += p; }); proc.stderr.on('data', p => { err += p; });
    proc.on('error', reject); proc.on('exit', code => resolve({ code, out, err }));
  });
  // Configure-LocalPlugin normally edits the user's source .mcp.json. This test
  // runs a copied launcher rooted beside a relocated runtime with no config script.
  const relocated = join(h.directory, 'Start-AutoCodex.ps1');
  const content = readFileSync(script, 'utf8').replace("$projectDirectory = $PSScriptRoot", "$projectDirectory = $env:AUTOCODEX_LAUNCH_TEST_RUNTIME");
  writeFileSync(relocated, content);
  const first = await run(['-File', relocated, '-Demo', '-Port', String(h.port), '-DataDir', h.directory, '-NoBrowser']); assert.equal(first.code, 0, first.err);
  const c = json(join(h.directory, 'connection.json'));
  const again = await run(['-Command', '& $env:AUTOCODEX_LAUNCH_TEST_SCRIPT -Demo -Port $env:AUTOCODEX_LAUNCH_TEST_PORT -DataDir $env:AUTOCODEX_LAUNCH_TEST_DATA -NoBrowser -Foreground; exit $LASTEXITCODE']); assert.equal(again.code, 0, again.err);
  assert.equal(json(join(h.directory, 'connection.json')).pid, c.pid);
  assert(!again.out.includes(c.token));
});
