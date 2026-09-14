import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ProtocolRelay } from './protocol-relay.mjs';

const configPath = process.env.AUTOCODEX_RELAY_CONFIG;
if (!configPath) throw new Error('Missing AUTOCODEX_RELAY_CONFIG');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const args = process.argv.slice(2);
if (!config.codex || resolve(config.codex) === resolve(process.env.CODEX_CLI_PATH || '.')) throw new Error('Invalid real Codex path');
const environment = { ...process.env }; delete environment.CODEX_CLI_PATH; delete environment.AUTOCODEX_RELAY_CONFIG;
const isServer = args.includes('app-server') && !args.includes('proxy') && !args.includes('generate-json-schema') && !args.includes('generate-ts');
const recycleSecret = randomBytes(32).toString('hex'), extra = [];
if (isServer && process.platform === 'win32') {
  environment.AUTOCODEX_RECYCLE_SECRET = recycleSecret; environment.AUTOCODEX_RECYCLE_CONFIG = configPath;
  for (const [name, value] of Object.entries({ command: process.execPath, args: [fileURLToPath(new URL('./recycle-server.mjs', import.meta.url))],
    env_vars: ['AUTOCODEX_RECYCLE_SECRET', 'AUTOCODEX_RECYCLE_CONFIG'], enabled: true, startup_timeout_sec: 3, tool_timeout_sec: 360,
    default_tools_approval_mode: 'auto' })) {
    extra.push('-c', 'mcp_servers.autocodex_recycle.' + name + '=' + JSON.stringify(value));
  }
}
const child = spawn(config.codex, [...(config.codexArgs || []), ...args, ...extra], { env: environment, windowsHide: true, shell: false, stdio: isServer ? ['pipe', 'pipe', 'inherit'] : 'inherit' });
if (!isServer) {
  child.on('error', e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  let connection, connected = false, stopped = false, inflight = false, sequence = 0, watched = new Map(), backlog = [], overflow = false;
  const write = (stream, message) => {
    if (stream.destroyed || !stream.writable) throw new Error('Closed protocol stream');
    stream.write(JSON.stringify(message) + '\n');
  };
  async function api(path, input, timeout = 1400) {
    if (!connection) {
      connection = JSON.parse(readFileSync(config.connectionFile, 'utf8'));
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.origin) || !connection.relayToken) throw new Error('Invalid relay connection');
    }
    const response = await fetch(connection.origin + '/api/v1/desktop/' + path, { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + connection.relayToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) { connection = null; throw new Error('Monitor unavailable'); }
    return response.json();
  }
  const fault = error => { overflow = true; process.stderr.write('AutoCodex relay: ' + error.message + '\n'); };
  const relay = new ProtocolRelay({ toServer: m => write(child.stdin, m), toDesktop: m => write(process.stdout, m), recycleSecret, onFault: fault,
    approval: value => {
      if (!connected || !watched.get(value.threadId)?.autoApprove || overflow) return null;
      const request = { relayId: relay.id, ...value };
      if (Buffer.byteLength(JSON.stringify(request)) > 60000) return null;
      return api('approval', request);
    } });
  relay.on('event', event => {
    if (event.type === 'replacement_created') watched.set(event.thread.id, { ...watched.get(event.threadId) });
    if (!watched.has(event.threadId) && !['loaded', 'action_result'].includes(event.type)) return;
    if (Buffer.byteLength(JSON.stringify(event)) > 38000) { overflow = true; return; }
    backlog.push({ ...event, seq: ++sequence });
    if (backlog.length > 1000) { backlog = []; overflow = true; }
  });
  function lines(input, destination, onMessage) {
    const decoder = new StringDecoder('utf8'); let pending = '', bypass = false;
    input.on('data', chunk => {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (bypass || line.length > 32 * 1024 * 1024) { destination.write(line + '\n'); bypass = false; overflow = true; continue; }
        let message; try { message = JSON.parse(line); } catch { destination.write(line + '\n'); continue; }
        try { onMessage(message); } catch (error) { fault(error); }
      }
      if (pending.length > 32 * 1024 * 1024 || bypass) { destination.write(pending); pending = ''; bypass = true; overflow = true; }
      if (destination.writableLength > 1024 * 1024) { input.pause(); destination.once('drain', () => input.resume()); }
    });
    input.on('end', () => { pending += decoder.end(); if (pending) destination.write(pending); });
  }
  lines(process.stdin, child.stdin, m => relay.fromDesktop(m));
  lines(child.stdout, process.stdout, m => relay.fromServer(m));
  process.stdin.on('end', () => { stopped = true; relay.close(); child.stdin.end(); });
  child.stdin.on('error', () => { stopped = true; relay.close(); clearInterval(timer); });
  process.stdout.on('error', () => { stopped = true; relay.close(); clearInterval(timer); child.stdin.end(); });
  child.on('error', e => { process.stderr.write(e.message + '\n'); stopped = true; clearInterval(timer); process.exitCode = 1; });
  child.on('exit', code => { stopped = true; relay.close(); clearInterval(timer); process.stdin.destroy(); child.stdout.destroy(); process.exitCode = code ?? 1; });
  async function poll() {
    if (stopped || inflight) return;
    inflight = true;
    try {
      const events = []; let size = 0;
      for (const event of backlog) { size += Buffer.byteLength(JSON.stringify(event)); if (size > 40000) break; events.push(event); }
      const threads = relay.snapshots();
      if (threads.length > 100 || Buffer.byteLength(JSON.stringify(threads)) > 20000) overflow = true;
      const snapshots = []; let bytes = 0;
      for (const state of threads.slice(0, 100)) { bytes += Buffer.byteLength(JSON.stringify(state)); if (bytes > 20000) break; snapshots.push(state); }
      const result = await api('poll', { relayId: relay.id, pid: process.pid, workerPid: child.pid, overflow, threads: snapshots, events });
      connected = true; watched = new Map(result.watched.map(t => [t.threadId, t]));
      if (events.length) backlog = backlog.filter(e => e.seq > events.at(-1).seq);
      for (const action of result.actions || []) {
        if (overflow || !watched.get(action.threadId)?.autoContinue) {
          relay.event('action_result', action.threadId, { actionId: action.id, outcome: 'skipped' }); continue;
        }
        void relay.execute(action).then(value => relay.event('action_result', action.threadId, { actionId: action.id, ...value }));
      }
    } catch { connected = false; connection = null; }
    finally { inflight = false; }
  }
  const timer = setInterval(() => void poll(), 250); timer.unref(); void poll();
}
