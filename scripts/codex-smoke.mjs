import { spawnSync } from 'node:child_process';
import { CodexAdapter, resolveCodex } from '../src/adapters/codex.mjs';

// This probe does not create a thread or ask a model to generate.
const runtime = resolveCodex();
const version = spawnSync(runtime.command, [...runtime.args, '--version'], { env: runtime.env, encoding: 'utf8', windowsHide: true });
if (version.status !== 0) throw new Error(version.stderr || 'Codex version probe failed');
const adapter = new CodexAdapter({ timeoutMs: 20000 });
try {
  const connection = await adapter.connect();
  const loaded = await adapter.client.request('thread/loaded/list', {});
  if (!Array.isArray(loaded.data)) throw new Error('Unexpected thread/loaded/list response');
  process.stdout.write(JSON.stringify({ version: version.stdout.trim(), connected: connection.connected, loadedThreads: loaded.data.length, modelGenerationRequested: false, transport: 'stdio' }, null, 2) + '\n');
} finally { await adapter.close(); }
