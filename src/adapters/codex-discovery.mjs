import { existsSync, statSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, join, delimiter, isAbsolute, resolve, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { AppError } from '../core/util.mjs';

const TARGETS = {
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
};
const envValue = (env, name) => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())] || '';
function stat(path) { try { return statSync(path); } catch { return null; } }
const isFile = path => !!stat(path)?.isFile();

export function normalizeCodexInput(value, { cwd = process.cwd(), home = homedir() } = {}) {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new AppError('Codex 路径必须是单行文本，不能超过 4096 个字符');
  let input = value.trim();
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) input = input.slice(1, -1);
  if (/^~([\\/]|$)/.test(input)) input = home + input.slice(1);
  // Bare executable names are searched in PATH. Relative directories are also
  // accepted; executable files in cwd require an explicit ./ or .\ prefix.
  if (input && (isAbsolute(input) || /[\\/]/.test(input) || input === '.' || input === '..' || stat(resolve(cwd, input))?.isDirectory())) return resolve(cwd, input);
  return input;
}

function withHelpers(env, paths) {
  const result = { ...env }, original = envValue(env, 'PATH');
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'path') delete result[key];
  result.PATH = [...paths.filter(path => stat(path)?.isDirectory()), original].filter(Boolean).join(delimiter);
  return result;
}

function fromLauncher(launcher, ctx) {
  const canonical = realpathSync(launcher), root = dirname(dirname(canonical));
  const target = TARGETS[`${ctx.platform}-${ctx.arch}`];
  const roots = [join(root, 'vendor')];
  try {
    const require = createRequire(canonical);
    roots.unshift(join(dirname(require.resolve(`@openai/codex-${ctx.platform}-${ctx.arch}/package.json`)), 'vendor'));
  } catch { /* Older npm packages keep their native program in their own vendor directory. */ }
  if (target) for (const vendor of roots) for (const sub of ['bin', 'codex']) {
    const binary = join(vendor, target, sub, ctx.executable);
    if (isFile(binary)) return { command: realpathSync(binary), args: [], env: withHelpers(ctx.env, [join(vendor, target, 'path'), dirname(binary)]), kind: 'npm-native', launcher: canonical };
  }
  return { command: ctx.node, args: [canonical], env: ctx.env, kind: 'npm-launcher', launcher: canonical };
}

function fileRuntime(file, ctx) {
  if (!isFile(file)) return null;
  const canonical = realpathSync(file), extension = extname(canonical).toLowerCase();
  if (/\.(cmd|bat|ps1)$/i.test(file)) {
    // Never run a shell wrapper. Only translate the standard npm Codex shim.
    if (!/^codex\.(cmd|bat|ps1)$/i.test(basename(file))) return null;
    const launcher = join(dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    return isFile(launcher) ? fromLauncher(launcher, ctx) : null;
  }
  if (['.js', '.mjs'].includes(extension)) {
    if (!/^codex\.m?js$/i.test(basename(canonical))) return null;
    return fromLauncher(canonical, ctx);
  }
  if (ctx.platform === 'win32' && extension !== '.exe') return null;
  // Electron's GUI executable has the same filename on Windows. A sibling
  // app.asar identifies the desktop entry point, not its embedded CLI.
  if (existsSync(join(dirname(canonical), 'resources', 'app.asar'))) return null;
  return { command: canonical, args: [], env: withHelpers(ctx.env, [join(dirname(dirname(canonical)), 'path'), dirname(canonical)]), kind: 'native' };
}

function* inCommandDirectory(directory, ctx, name = 'codex') {
  const executable = ctx.platform === 'win32' && !extname(name) ? `${name}.exe` : name;
  yield join(directory, executable);
  if (/^codex(?:\.exe|\.cmd|\.ps1|\.bat)?$/i.test(name)) {
    yield join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    yield join(directory, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  }
}

function versionDirectories(directory) {
  if (!stat(directory)?.isDirectory()) return [];
  try {
    // Only one level; bounded to 24 candidates. A timestamp tie is deterministic.
    return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => ({ path: join(directory, entry.name), name: entry.name, time: stat(join(directory, entry.name))?.mtimeMs || 0 }))
      .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name, undefined, { numeric: true }))
      .slice(0, 24).map(entry => entry.path);
  } catch { return []; }
}

function* inInstallation(directory, ctx) {
  // Finite known layouts, never a recursive drive scan.
  for (const sub of ['', 'bin', 'resources', 'resources/bin', 'resources/codex', 'app/resources', 'Contents/Resources']) {
    yield* inCommandDirectory(join(directory, sub), ctx);
  }
  yield join(directory, 'bin', 'codex.js');
  yield join(directory, 'codex.js');
  for (const root of [join(directory, 'bin'), directory]) {
    for (const version of versionDirectories(root)) yield join(version, ctx.executable);
  }
}

function* automaticCandidates(ctx) {
  for (const dir of envValue(ctx.env, 'PATH').split(delimiter).filter(Boolean)) {
    const directory = resolve(ctx.cwd, dir.replace(/^"|"$/g, ''));
    for (const file of inCommandDirectory(directory, ctx)) yield { file, source: 'PATH' };
  }
  for (const dir of envValue(ctx.env, 'AUTOCODEX_CODEX_SEARCH_PATHS').split(delimiter).filter(Boolean)) {
    for (const file of inInstallation(resolve(ctx.cwd, dir.replace(/^"|"$/g, '')), ctx)) yield { file, source: '额外搜索目录' };
  }
  const npmRoots = [envValue(ctx.env, 'NPM_CONFIG_PREFIX'), dirname(ctx.node)];
  if (ctx.platform === 'win32' && envValue(ctx.env, 'APPDATA')) npmRoots.unshift(join(envValue(ctx.env, 'APPDATA'), 'npm'));
  for (const dir of npmRoots.filter(Boolean)) for (const file of inCommandDirectory(resolve(ctx.cwd, dir), ctx)) yield { file, source: 'npm 安装目录' };
  const userRoots = [join(ctx.home, '.local', 'bin'), join(ctx.home, '.codex', 'bin')];
  const codexHome = envValue(ctx.env, 'CODEX_HOME');
  if (codexHome) userRoots.unshift(join(codexHome, 'bin'));
  for (const dir of userRoots) for (const file of inInstallation(dir, ctx)) yield { file, source: '用户安装目录' };
  const desktopRoots = [];
  if (ctx.platform === 'win32') {
    const local = envValue(ctx.env, 'LOCALAPPDATA'), programFiles = envValue(ctx.env, 'ProgramFiles');
    if (local) desktopRoots.push(join(local, 'OpenAI', 'Codex'), join(local, 'Programs', 'Codex'), join(local, 'Programs', 'ChatGPT'));
    if (programFiles) desktopRoots.push(join(programFiles, 'Codex'), join(programFiles, 'ChatGPT'));
  } else if (ctx.platform === 'darwin') {
    for (const base of ['/Applications', join(ctx.home, 'Applications')]) for (const name of ['Codex.app', 'ChatGPT.app']) desktopRoots.push(join(base, name));
    for (const base of ['/opt/homebrew/bin', '/usr/local/bin']) for (const file of inCommandDirectory(base, ctx)) yield { file, source: '系统安装目录' };
  } else {
    for (const base of ['/usr/local/bin', '/usr/bin']) for (const file of inCommandDirectory(base, ctx)) yield { file, source: '系统安装目录' };
  }
  for (const dir of desktopRoots) for (const file of inInstallation(dir, ctx)) yield { file, source: '桌面版附带 CLI' };
}

/** Resolves argv without running code. Empty string explicitly selects automatic
 * discovery; undefined first honors AUTOCODEX_CODEX_COMMAND for CLI callers. */
export function resolveCodex(command, options = {}) {
  const ctx = { env: process.env, cwd: process.cwd(), home: homedir(), node: process.execPath, platform: process.platform, arch: process.arch, ...options };
  ctx.executable = ctx.platform === 'win32' ? 'codex.exe' : 'codex';
  const selected = command ?? envValue(ctx.env, 'AUTOCODEX_CODEX_COMMAND');
  const input = normalizeCodexInput(selected, ctx);
  const source = command === undefined && selected ? '环境变量' : '手动指定';
  function* candidates() {
    if (!input) { yield* automaticCandidates(ctx); return; }
    if (isAbsolute(input)) {
      if (stat(input)?.isDirectory()) for (const file of inInstallation(input, ctx)) yield { file, source };
      else yield { file: input, source };
    } else {
      for (const dir of envValue(ctx.env, 'PATH').split(delimiter).filter(Boolean)) {
        for (const file of inCommandDirectory(resolve(ctx.cwd, dir.replace(/^"|"$/g, '')), ctx, input)) yield { file, source };
      }
    }
  }
  const seen = new Set();
  for (const { file, source: foundSource } of candidates()) {
    const key = ctx.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key)) continue;
    seen.add(key);
    const runtime = fileRuntime(file, ctx);
    if (runtime) return { ...runtime, source: foundSource, requested: input, path: runtime.args[0] || runtime.command };
  }
  throw new AppError(input
    ? `指定位置未找到可用的 Codex CLI：${input}。请提供 CLI 程序、npm 的 codex 启动文件或其安装目录；桌面主程序和任意包装脚本不能代替 CLI。`
    : '未找到 Codex CLI。请安装 Codex CLI，或在“恢复设置 → Codex 安装”中输入路径，也可使用 -CodexPath / --codex-command 指定。', 400, 'codex_not_found');
}

export function describeCodex(runtime) {
  return { found: true, path: runtime.path, source: runtime.source, kind: runtime.kind, launcher: runtime.launcher || null };
}

export function inspectCodex(command, options) {
  try { return describeCodex(resolveCodex(command, options)); }
  catch (error) { return { found: false, error: error.message, code: error.code || 'codex_discovery_failed' }; }
}
