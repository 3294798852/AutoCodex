import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, realpathSync } from 'node:fs';
import { join, dirname, relative, delimiter } from 'node:path';
import { resolveCodex, inspectCodex, normalizeCodexInput } from '../src/adapters/codex-discovery.mjs';
import { tempDirectory } from './helpers.mjs';

function fixture(t) {
  const temp = tempDirectory('discovery-'); t.after(() => temp.remove());
  const file = name => { const path = join(temp.directory, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'fixture'); return realpathSync(path); };
  const options = { env: {}, cwd: temp.directory, home: join(temp.directory, 'home'), node: join(temp.directory, 'node', 'node.exe'), platform: 'win32', arch: 'x64' };
  return { ...temp, options, file };
}

test('automatic discovery respects PATH order and Windows Path casing without appending .exe twice', t => {
  const f = fixture(t), first = f.file('first/codex.exe'), second = f.file('second/codex.exe');
  f.options.env.Path = [dirname(first), dirname(second)].join(delimiter);
  assert.equal(resolveCodex('', f.options).command, first);
  assert.equal(resolveCodex('codex.exe', f.options).command, first);
  assert.equal(resolveCodex('codex', f.options).source, '手动指定');
});

test('explicit CLI files and directories accept spaces, Unicode, relative paths and surrounding quotes', t => {
  const f = fixture(t), binary = f.file('自选 Codex/bin/codex.exe');
  for (const input of [binary, dirname(binary), join(f.directory, '自选 Codex'), `"${binary}"`, `./${relative(f.directory, binary)}`]) {
    assert.equal(resolveCodex(input, f.options).command, binary);
  }
  assert.equal(normalizeCodexInput('~/.local/bin', f.options), join(f.options.home, '.local', 'bin'));
});

test('an explicit missing path never falls back to a valid PATH installation', t => {
  const f = fixture(t), fallback = f.file('path/codex.exe'); f.options.env.PATH = dirname(fallback);
  const missing = join(f.directory, 'absent', 'codex.exe');
  assert.throws(() => resolveCodex(missing, f.options), error => error.code === 'codex_not_found' && error.message.includes(missing));
  f.options.env.AUTOCODEX_CODEX_COMMAND = missing;
  assert.throws(() => resolveCodex(undefined, f.options), /指定位置/);
  assert.equal(resolveCodex('', f.options).command, fallback, 'empty override intentionally selects auto discovery');
});

test('PATH finds npm platform-package native CLI and helper PATH without a shell', t => {
  const f = fixture(t);
  const launcher = f.file('npm/node_modules/@openai/codex/bin/codex.js');
  f.file('npm/codex.cmd');
  const platformPackage = f.file('npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/package.json');
  writeFileSync(platformPackage, JSON.stringify({ name: '@openai/codex-win32-x64' }));
  const vendor = join(dirname(platformPackage), 'vendor', 'x86_64-pc-windows-msvc');
  const binary = f.file(relative(f.directory, join(vendor, 'bin', 'codex.exe')));
  mkdirSync(join(vendor, 'path'), { recursive: true });
  f.options.env.Path = join(f.directory, 'npm');
  const result = resolveCodex('', f.options);
  assert.equal(result.command, binary); assert.equal(result.launcher, launcher);
  assert.equal(result.kind, 'npm-native'); assert.deepEqual(result.args, []);
  assert(result.env.PATH.startsWith(join(vendor, 'path')));
  assert.equal(Object.keys(result.env).filter(key => key.toLowerCase() === 'path').length, 1);
  assert.equal(resolveCodex(join(f.directory, 'npm', 'codex.cmd'), f.options).command, binary);
});

test('legacy npm vendor and npm launchers are supported; arbitrary shell wrappers are rejected', t => {
  const f = fixture(t), launcher = f.file('npm/node_modules/@openai/codex/bin/codex.js');
  const shim = f.file('npm/codex.ps1');
  const result = resolveCodex(shim, f.options);
  assert.equal(result.command, f.options.node); assert.deepEqual(result.args, [launcher]);
  assert.equal(result.kind, 'npm-launcher');
  const binary = f.file('npm/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe');
  assert.equal(resolveCodex(shim, f.options).command, binary);
  const arbitrary = f.file('other/custom.cmd');
  assert.throws(() => resolveCodex(arbitrary, f.options), /包装脚本/);
});

test('npm can be found without PATH via APPDATA or configured npm prefix', t => {
  const f = fixture(t), launcher = f.file('roaming/npm/node_modules/@openai/codex/bin/codex.js');
  f.options.env.APPDATA = join(f.directory, 'roaming');
  assert.equal(resolveCodex('', f.options).path, launcher);
  delete f.options.env.APPDATA; f.options.env.npm_config_prefix = join(f.directory, 'roaming', 'npm');
  assert.equal(resolveCodex('', f.options).source, 'npm 安装目录');
});

test('desktop managed CLI versions are found without PATH using the current local app data directory', t => {
  const f = fixture(t);
  const older = f.file('local/OpenAI/Codex/bin/old/codex.exe');
  const newer = f.file('local/OpenAI/Codex/bin/new/codex.exe');
  utimesSync(dirname(older), 10, 10); utimesSync(dirname(newer), 20, 20);
  f.options.env.LOCALAPPDATA = join(f.directory, 'local');
  const result = resolveCodex('', f.options);
  assert.equal(result.command, newer); assert.equal(result.source, '桌面版附带 CLI');
});

test('an Electron desktop EXE is rejected but its bundled CLI can be selected by directory', t => {
  const f = fixture(t), gui = f.file('desktop/Codex.exe'); f.file('desktop/resources/app.asar');
  const cli = f.file('desktop/resources/codex.exe');
  assert.throws(() => resolveCodex(gui, f.options), /桌面主程序/);
  assert.equal(resolveCodex(dirname(gui), f.options).command, cli);
});

test('additional discovery roots extend installation layouts without source changes', t => {
  const f = fixture(t), binary = f.file('portable 安装/bin/codex.exe');
  f.options.env.AUTOCODEX_CODEX_SEARCH_PATHS = [join(f.directory, 'missing'), join(f.directory, 'portable 安装')].join(delimiter);
  assert.equal(resolveCodex('', f.options).command, binary);
  assert.equal(resolveCodex('', f.options).source, '额外搜索目录');
});

test('discovery is bounded and gives a visible actionable result when Codex is absent', t => {
  const f = fixture(t); f.file('home/.codex/bin/unrelated/deep/deeper/codex.exe');
  const result = inspectCodex('', f.options);
  assert.equal(result.found, false); assert.equal(result.code, 'codex_not_found'); assert(result.error.includes('-CodexPath'));
  for (const input of [undefined, null, {}, 'bad\npath', 'bad\0path', 'x'.repeat(4097)]) assert.throws(() => normalizeCodexInput(input, f.options));
});
