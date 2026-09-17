import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, renameSync, existsSync, rmSync, rmdirSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const project = resolve(fileURLToPath(new URL('..', import.meta.url))), distribution = join(project, 'dist');
const destination = join(distribution, 'autocodex-guard');
const staging = join(distribution, `.build-${randomUUID()}`), output = join(staging, 'autocodex-guard');
const version = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version;
if (dirname(destination) !== distribution || basename(destination) !== 'autocodex-guard' || dirname(staging) !== distribution) throw new Error('Invalid package destination');
mkdirSync(output, { recursive: true });
for (const component of ['.codex-plugin', 'scripts', 'skills']) cpSync(join(project, 'plugins', 'autocodex-guard', component), join(output, component), { recursive: true });
const runtime = join(output, 'runtime'); mkdirSync(runtime, { recursive: true });
for (const directory of ['src', 'public']) cpSync(join(project, directory), join(runtime, directory), { recursive: true });
if (process.platform === 'win32') {
  const built = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(project, 'scripts', 'build-desktop.ps1'), '-OutputDirectory', join(runtime, 'native')],
    { encoding: 'utf8', windowsHide: true, shell: false });
  if (built.status !== 0) throw new Error(built.stderr || built.stdout || 'Desktop relay build failed');
  const windowBuild = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(project, 'scripts', 'build-window.ps1'), '-OutputDirectory', join(runtime, 'native')],
    { encoding: 'utf8', windowsHide: true, shell: false });
  if (windowBuild.status !== 0) throw new Error(windowBuild.stderr || windowBuild.stdout || 'Window build failed');
}
writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'autocodex-guard-runtime', version, private: true, type: 'module', engines: { node: '>=24.0.0' }, scripts: { start: 'node src/main.mjs', demo: 'node src/main.mjs --demo', 'diagnose:codex': 'node src/main.mjs --diagnose-codex' } }, null, 2));
for (const filename of ['Start-AutoCodex.ps1', 'Start-AutoCodex.cmd', 'Start-AutoCodexBrowser.cmd', 'Open-AutoCodexWindow.ps1', 'Open-AutoCodexWindow.cmd', 'Start-AutoCodexDesktop.ps1', 'Start-AutoCodexDesktop.cmd', 'Stop-AutoCodex.ps1', 'Configure-LocalPlugin.ps1', 'README.md', 'PROJECT_STATE.md']) cpSync(join(project, filename), join(output, filename));
cpSync(join(project, 'docs'), join(output, 'docs'), { recursive: true });

// A distribution has no machine-specific MCP wiring. The startup/configuration
// script fills this template on the target PC before users install the plugin.
const mcp = { mcpServers: {} };
writeFileSync(join(output, '.mcp.json'), JSON.stringify(mcp, null, 2));

const hashes = {};
function inventory(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Package cannot contain symbolic links');
    if (stat.isDirectory()) { if (entry === '.autocodex' || entry === '.work') throw new Error('Runtime data must not enter release packages'); inventory(path); }
    else if (entry !== 'SHA256SUMS.json') hashes[path.slice(output.length + 1).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}
inventory(output); writeFileSync(join(output, 'SHA256SUMS.json'), JSON.stringify(hashes, null, 2));
let archive = null;
if (process.platform === 'win32') {
  archive = join(distribution, `autocodex-guard-${version}.zip`);
  const temporary = join(distribution, `autocodex-guard-${randomUUID()}.zip.tmp`);
  // Call the built-in compression API with data in environment variables. This
  // includes dotfiles and does not require changing PowerShell script policy.
  const command = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($env:AUTOCODEX_ZIP_DESTINATION, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $env:AUTOCODEX_ZIP_SOURCE -File -Recurse -Force | ForEach-Object {
    $entryName = 'autocodex-guard/' + $_.FullName.Substring($env:AUTOCODEX_ZIP_SOURCE.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $archive.Dispose() }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, shell: false,
    env: { ...process.env, AUTOCODEX_ZIP_SOURCE: output, AUTOCODEX_ZIP_DESTINATION: temporary } });
  if (result.status !== 0) throw new Error(result.stderr || 'ZIP packaging failed');
  renameSync(temporary, archive);
}
// Replace only this generated destination after checking its absolute location
// and refusing to remove any runtime data from someone using the unpacked build.
if (existsSync(destination)) {
  const verifyDisposable = directory => {
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Refusing to replace a linked build directory');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['.autocodex', '.work', 'connection.json', 'open-panel.html', 'guard.sqlite'].includes(entry.name)) throw new Error('Existing build contains runtime data; stop it and move its data before packaging');
      if (entry.isSymbolicLink()) throw new Error('Refusing to replace a linked build member');
      if (entry.isDirectory()) verifyDisposable(join(directory, entry.name));
    }
  };
  verifyDisposable(destination);
  if (resolve(destination) !== join(resolve(distribution), 'autocodex-guard')) throw new Error('Unsafe build cleanup path');
  rmSync(destination, { recursive: true, force: true });
}
renameSync(output, destination); rmdirSync(staging);
process.stdout.write(JSON.stringify({ plugin: destination, archive, files: Object.keys(hashes).length, includesRuntimeData: false, mcpConfiguration: 'generated on target PC at startup' }, null, 2) + '\n');
