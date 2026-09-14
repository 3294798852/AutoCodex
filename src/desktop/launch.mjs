import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { discoverDesktop, desktopRelayPaths } from './discovery.mjs';
import { resolveCodex } from '../adapters/codex-discovery.mjs';
import { selectCodexCommand, readSavedCodexCommand } from '../server/codex-settings.mjs';
import { VERSION } from '../version.mjs';

const print = value => console.log(JSON.stringify(value).replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
try {
const input = JSON.parse(readFileSync(process.argv[2], 'utf8')), desktop = discoverDesktop(input.desktopPath), paths = desktopRelayPaths(input.root);
const selected = selectCodexCommand({ command: input.codexPathExplicit ? input.codexPath : undefined, saved: readSavedCodexCommand(input.dataDirectory) });
const cli = resolveCodex(selected.command);
const report = { desktop: desktop.path, source: desktop.source, cli: cli.command, relay: paths.executable };
if (input.checkOnly) print({ ...report, version: VERSION, ok: true });
else {
  const connection = JSON.parse(readFileSync(join(input.dataDirectory, 'connection.json'), 'utf8'));
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.origin)) throw new Error('本机监护地址无效');
  const response = await fetch(connection.origin + '/api/v1/state', { headers: { Authorization: 'Bearer ' + connection.token }, redirect: 'error', signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('本机监护服务尚未就绪');
  const state = await response.json();
  if (!state.desktop || state.version !== VERSION) throw new Error('已有监护服务版本较旧，请正常停止 AutoCodex 服务后重新运行此入口。');
  const running = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:AUTOCODEX_DESKTOP_TARGET }).Count"],
    { env: { ...process.env, AUTOCODEX_DESKTOP_TARGET: desktop.path }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (running.status !== 0 || Number(running.stdout.trim()) > 0) {
    const active = state.desktop.available;
    print({ ok: active, ...report, message: active ? '原 Codex 自动辅助已连接，已复用本机服务。' : 'Codex 桌面正在运行。请在方便时从文件菜单退出 Codex，再运行此入口接入自动辅助；现有监测继续运行。' });
    process.exitCode = active ? 0 : 3;
  } else {
    mkdirSync(input.dataDirectory, { recursive: true });
    const configPath = join(input.dataDirectory, 'desktop-relay.json');
    writeFileSync(configPath, JSON.stringify({ codex: cli.command, codexArgs: cli.args, connectionFile: join(input.dataDirectory, 'connection.json') }, null, 2));
    const child = spawn(desktop.path, [], { detached: true, stdio: 'ignore', windowsHide: false,
      env: { ...cli.env, CODEX_CLI_PATH: paths.executable, AUTOCODEX_RELAY_CONFIG: configPath, AUTOCODEX_RELAY_NODE: process.execPath, AUTOCODEX_RELAY_SCRIPT: paths.script } });
    child.once('spawn', () => { child.unref(); print({ ok: true, ...report, message: '已启动带自动辅助连接的 Codex。面板中选择已有会话，开启自动续发或免打扰。' }); });
    child.once('error', e => { print({ ok: false, error: e.message }); process.exitCode = 1; });
  }
}
} catch (error) { print({ ok: false, error: error.message }); process.exitCode = 1; }
