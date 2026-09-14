import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeCodexInput } from '../adapters/codex-discovery.mjs';
import { redact } from '../core/util.mjs';

function jsonFile(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
const option = (args, key) => {
  const equals = args.find(arg => arg.startsWith(key + '='));
  if (equals !== undefined) return equals.slice(key.length + 1);
  const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1];
};
function validateRequest(request) {
  if (!request || !Array.isArray(request.args) || !request.args.length || !request.args.every(arg => typeof arg === 'string')
    || typeof request.cwd !== 'string' || !isAbsolute(request.cwd)
    || typeof request.dataDirectory !== 'string' || !isAbsolute(request.dataDirectory)
    || resolve(option(request.args, '--data-dir') || '') !== resolve(request.dataDirectory)) throw new Error('无效的启动请求');
  const port = Number(option(request.args, '--port') || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间');
  return { mode: request.args.includes('--demo') ? 'demo' : 'codex', port, command: option(request.args, '--codex-command') };
}
async function localJson(origin, path, token, timeoutMs) {
  const response = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: token ? { Authorization: 'Bearer ' + token } : {} });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`本机服务返回 HTTP ${response.status}`); }
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length; if (size > 128 * 1024) throw new Error('本机服务检查响应过大'); parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function inspectInstance(directory, { timeoutMs = 1000 } = {}) {
  let lock;
  try { lock = jsonFile(join(directory, 'supervisor.lock')); }
  catch (error) {
    return error.code === 'ENOENT' ? { status: 'absent' } : { status: 'waiting', reason: '数据目录锁暂时无法读取' };
  }
  if (!lock || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.nonce !== 'string') return { status: 'waiting', reason: '数据目录锁内容不完整' };
  try { if (!alive(lock.pid)) return { status: 'absent' }; }
  catch { return { status: 'waiting', reason: `无法核对数据目录的进程 ${lock.pid}` }; }
  const waiting = reason => ({ status: 'waiting', pid: lock.pid, reason });
  let connection;
  try { connection = jsonFile(join(directory, 'connection.json')); }
  catch { return waiting('已有进程仍在启动，连接文件尚不可用'); }
  if (!connection || connection.pid !== lock.pid) return waiting('已有进程的连接信息尚未就绪');
  // Never send an admin credential outside the exact loopback origin or follow redirects.
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(connection.origin || '') || Number(connection.origin.split(':').at(-1)) > 65535
    || !/^[a-f0-9]{64}$/.test(connection.token || '') || !['codex', 'demo'].includes(connection.mode)) return waiting('已有进程的本机连接信息无效');
  try {
    const health = await localJson(connection.origin, '/healthz', null, timeoutMs);
    if (health.ok !== true || health.mode !== connection.mode) return waiting('已有服务尚未通过健康检查');
    const settings = await localJson(connection.origin, '/api/v1/codex', connection.token, timeoutMs);
    if (settings.enabled !== (connection.mode === 'codex')) return waiting('已有服务未通过身份核对');
    const current = jsonFile(join(directory, 'supervisor.lock')), latest = jsonFile(join(directory, 'connection.json'));
    if (current.pid !== lock.pid || current.nonce !== lock.nonce || latest.pid !== connection.pid
      || latest.token !== connection.token || latest.origin !== connection.origin || !alive(lock.pid)) return waiting('服务正在切换进程，等待重新核对');
    return { status: 'ready', connection, settings };
  } catch { return waiting('已有进程未响应或管理口令认证失败'); }
}

function readyResult(instance, request, expected, launchedPid) {
  const { connection, settings } = instance;
  const nextStep = '请先使用 Stop-AutoCodex.ps1（自定义目录时带相同 -DataDir）停止原服务，再重新启动。';
  if (connection.mode !== expected.mode) throw new Error(`此数据目录正在运行${connection.mode === 'demo' ? '演练' : '真实'}模式。请使用不同数据目录；或先停止原服务再切换模式。`);
  if (request.portExplicit && Number(connection.origin.split(':').at(-1)) !== expected.port) throw new Error(`服务已在 ${connection.origin} 运行；本次指定的新端口 ${expected.port} 尚未生效。${nextStep}`);
  if (expected.command !== undefined && expected.mode === 'codex') {
    const requested = normalizeCodexInput(expected.command, { cwd: request.cwd });
    const same = process.platform === 'win32' ? requested.toLowerCase() === (settings.activeCommand || '').toLowerCase() : requested === settings.activeCommand;
    if (!same) throw new Error(`服务已运行；本次指定的新 Codex 路径需重新启动才能生效。${nextStep}`);
  }
  const launchPath = join(request.dataDirectory, 'open-panel.html');
  const launchUrl = `${connection.origin}/#token=${connection.token}`;
  writeFileSync(launchPath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>打开 AutoCodex</title><meta http-equiv="refresh" content="0;url=${launchUrl}"><a href="${launchUrl}">打开本机监测面板</a></html>`, { mode: 0o600 });
  return { ok: true, status: launchedPid === connection.pid ? 'started' : 'reused', pid: connection.pid, origin: connection.origin, launchPath };
}

function size(path) { try { return statSync(path).size; } catch { return 0; } }
function startupError(path, offset, port) {
  let detail = '';
  try {
    const end = size(path), start = Math.max(offset, end - 8192), bytes = Buffer.alloc(Math.max(0, end - start)), file = openSync(path, 'r');
    try { readSync(file, bytes, 0, bytes.length, start); } finally { closeSync(file); }
    const lines = bytes.toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    detail = lines.find(line => /^(?:[A-Za-z]*Error(?: \[[^\]]+\])?:|启动失败：|守护服务已停止派发：)/.test(line)) || '';
  } catch { /* The original log remains available for diagnosis. */ }
  if (/EADDRINUSE/.test(detail)) return `端口 ${port} 已被其他服务占用。可改用 -Port ${port < 65535 ? port + 1 : 3211}，或先关闭占用该端口的服务。日志：${path}`;
  return `服务启动失败：${redact(detail || '后台进程在面板就绪前退出', 900)}。日志：${path}`;
}

export async function launchService(request, { timeoutMs = 12000, probeTimeoutMs = 1000 } = {}) {
  const expected = validateRequest(request), errorsPath = join(request.dataDirectory, 'service-error.log');
  const deadline = Date.now() + timeoutMs;
  let proc, logOffset = 0, observedExitAt = null, waitingReason = '', waitingPid;
  while (Date.now() < deadline) {
    const instance = await inspectInstance(request.dataDirectory, { timeoutMs: Math.max(1, Math.min(probeTimeoutMs, deadline - Date.now())) });
    if (instance.status === 'ready') return readyResult(instance, request, expected, proc?.pid);
    waitingReason = instance.reason || ''; waitingPid = instance.pid;
    if (!proc && instance.status === 'absent') {
      if (request.probeOnly) return { ok: true, status: 'absent' };
      let output, errors;
      try {
        output = openSync(join(request.dataDirectory, 'service.log'), 'a');
        errors = openSync(errorsPath, 'a'); logOffset = size(errorsPath);
        proc = spawn(process.execPath, request.args, { cwd: request.cwd, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', output, errors] });
        await once(proc, 'spawn'); proc.unref();
      } finally { if (output !== undefined) closeSync(output); if (errors !== undefined) closeSync(errors); }
    }
    if (proc && (proc.exitCode !== null || proc.signalCode !== null)) {
      observedExitAt ??= Date.now();
      // A concurrent launcher may own the lock but still be writing its connection file.
      if (instance.status === 'absent' && Date.now() - observedExitAt >= 300) throw new Error(startupError(errorsPath, logOffset, expected.port));
    }
    await delay(100);
  }
  if (proc && proc.exitCode !== null && !waitingPid) throw new Error(startupError(errorsPath, logOffset, expected.port));
  throw new Error(`${waitingReason || '服务启动尚未就绪'}${waitingPid ? `（进程 ${waitingPid}）` : ''}；已保留原进程和数据，请稍后重新运行启动器，或检查日志：${errorsPath}`);
}
