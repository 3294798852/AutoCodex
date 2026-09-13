import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let files = 0;
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (path.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
      if (result.status) { process.stderr.write(result.stderr); process.exitCode = 1; }
      files++;
    }
  }
}
for (const dir of ['src', 'public', 'scripts', 'test', 'plugins']) walk(resolve(dir));
for (const file of ['package.json', 'plugins/autocodex-guard/.codex-plugin/plugin.json', 'plugins/autocodex-guard/.mcp.json']) JSON.parse(readFileSync(file, 'utf8'));
process.stdout.write(`Checked ${files} JavaScript modules and JSON manifests.\n`);
