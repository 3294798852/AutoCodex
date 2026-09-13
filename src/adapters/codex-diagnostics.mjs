import { spawnSync } from 'node:child_process';
import { resolveCodex, describeCodex } from './codex-discovery.mjs';
import { JsonlRpcClient } from './rpc-client.mjs';

export async function diagnoseCodex(command, options = {}) {
  const runtime = resolveCodex(command, options);
  const version = spawnSync(runtime.command, [...runtime.args, '--version'], {
    env: runtime.env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 8000, maxBuffer: 65536,
  });
  if (version.error || version.status !== 0 || !/codex/i.test(version.stdout || '')) {
    throw new Error(`找到了程序，但 Codex 版本检查未通过：${version.error?.message || version.stderr?.trim() || '请确认选择的是 CLI，而不是桌面主程序'}`);
  }
  const client = new JsonlRpcClient({ ...runtime, args: [...runtime.args, 'app-server', '--listen', 'stdio://'], timeoutMs: 10000 });
  try {
    const initialized = await client.connect();
    const loaded = await client.request('thread/loaded/list', {});
    if (!Array.isArray(loaded.data)) throw new Error('当前 Codex 未返回预期的 app-server 数据，请检查 CLI 版本');
    return { ...describeCodex(runtime), version: version.stdout.trim(), connected: true, userAgent: initialized.userAgent,
      loadedThreads: loaded.data.length, modelGenerationRequested: false };
  } finally { await client.close(); }
}
