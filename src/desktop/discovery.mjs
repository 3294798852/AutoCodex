import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function discoverDesktop(explicit, { env = process.env } = {}) {
  if (explicit?.trim()) {
    let path = resolve(explicit.trim());
    if (existsSync(path) && statSync(path).isDirectory()) {
      path = ['ChatGPT.exe', 'Codex.exe', 'app/ChatGPT.exe', 'app/Codex.exe'].map(name => join(path, name))
        .find(candidate => existsSync(candidate) && statSync(candidate).isFile()) || path;
    }
    if (!existsSync(path) || !statSync(path).isFile() || !/\.exe$/i.test(path)) throw new Error('Codex 桌面路径无效，请选择桌面程序或安装目录');
    return { path, source: '手动指定' };
  }
  const candidates = [];
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Codex', 'Codex.exe'), join(env.LOCALAPPDATA, 'Programs', 'Codex', 'ChatGPT.exe'));
  const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation"], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (!query.error && query.status === 0) for (const root of query.stdout.trim().split(/\r?\n/).filter(Boolean)) candidates.push(join(root, 'app', 'ChatGPT.exe'), join(root, 'app', 'Codex.exe'));
  for (const path of candidates) if (existsSync(path) && statSync(path).isFile()) return { path, source: '自动发现' };
  throw new Error('未自动找到 Codex 桌面程序，请使用 -DesktopPath 指定安装目录或程序');
}
export function desktopRelayPaths(root) {
  const runtime = existsSync(join(root, 'runtime', 'src', 'main.mjs')) ? join(root, 'runtime') : root;
  const bundled = join(runtime, 'native', 'AutoCodexRelay.exe');
  return { runtime, executable: existsSync(bundled) ? bundled : join(root, '.work', 'desktop-runtime', 'AutoCodexRelay.exe'),
    script: join(runtime, 'src', 'desktop', 'main.mjs') };
}
