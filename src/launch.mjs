import { spawn } from 'node:child_process';
import { readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';

// The Windows launcher passes argv in a temporary JSON file. This preserves
// spaces, Unicode and trailing backslashes without shell command construction.
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(request.args) || !request.args.every(arg => typeof arg === 'string') || typeof request.cwd !== 'string' || typeof request.dataDirectory !== 'string') throw new Error('无效的启动请求');
const output = openSync(join(request.dataDirectory, 'service.log'), 'a');
const errors = openSync(join(request.dataDirectory, 'service-error.log'), 'a');
try {
  const proc = spawn(process.execPath, request.args, {
    cwd: request.cwd, env: process.env, detached: true, windowsHide: true,
    stdio: ['ignore', output, errors],
  });
  await once(proc, 'spawn');
  proc.unref();
  process.stdout.write(JSON.stringify({ pid: proc.pid }) + '\n');
} finally { closeSync(output); closeSync(errors); }
