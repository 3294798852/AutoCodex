import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { prepareRecycle, recyclePaths } from '../src/core/recycle.mjs';
import { DEFAULT_DND } from '../src/core/dnd-policy.mjs';

assert.equal(process.platform, 'win32');
mkdirSync('.work', { recursive: true });
const workspace = mkdtempSync(resolve('.work/recycle-validation-'));
const label = 'AutoCodex-test-' + randomUUID();
const file = join(workspace, label + '-中文 file.txt'), folder = join(workspace, label + '-folder');
mkdirSync(folder); writeFileSync(file, 'recycle fixture'); writeFileSync(join(folder, 'nested.txt'), 'nested fixture');
writeFileSync(join(workspace, 'fixtures.json'), JSON.stringify([file, folder]));
const settings = { ...DEFAULT_DND, recycleDeletes: true };
const prepared = prepareRecycle({ paths: [file, folder] }, { cwd: workspace, sandbox: 'workspace-write' }, settings, join(workspace, 'guard-data'));
const result = await recyclePaths(prepared.paths);
assert.equal(result.success, true, JSON.stringify(result));
assert(!existsSync(file) && !existsSync(folder), 'Original paths must move out of the workspace');
// Verify and restore only the uniquely named fixtures created by this script.
const check = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$expected = ConvertFrom-Json -InputObject $env:AUTOCODEX_RECYCLE_FIXTURES
$shell = New-Object -ComObject Shell.Application
$bin = $shell.Namespace(10)
$found = @()
foreach ($item in $bin.Items()) {
  $original = Join-Path ([string]$item.ExtendedProperty('System.Recycle.DeletedFrom')) ([string]$item.ExtendedProperty('System.FileName'))
  if ($expected -contains $original) { $found += $original; $item.InvokeVerb('undelete') }
}
@{found=$found.Count; expected=@($expected).Count} | ConvertTo-Json -Compress
`;
const verify = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8', windowsHide: true,
  env: { ...process.env, AUTOCODEX_RECYCLE_FIXTURES: JSON.stringify([file, folder]) } });
assert.equal(verify.status, 0, verify.stderr);
const evidence = JSON.parse(verify.stdout.trim()); assert.equal(evidence.found, 2, verify.stdout);
for (let i = 0; i < 100 && (!existsSync(file) || !existsSync(folder)); i++) await new Promise(resolve => setTimeout(resolve, 100));
assert.equal(readFileSync(file, 'utf8'), 'recycle fixture');
assert.equal(readFileSync(join(folder, 'nested.txt'), 'utf8'), 'nested fixture');
const report = { testedAt: new Date().toISOString(), windowsRecycleBin: true, unicodeAndSpacePaths: true, filesAndDirectories: true,
  recycled: 2, restored: 2, contentVerified: true, permanentDeletionUsed: false, modelRequests: 0 };
writeFileSync('.work/recycle-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
