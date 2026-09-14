import { spawn } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { resolve, join, parse, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, within, pathCategories } from './dnd-policy.mjs';
import { assert } from './util.mjs';

export const RECYCLE_TOOL = { type: 'function', name: 'autocodex_recycle',
  description: 'Move explicitly selected local files or folders to the Windows Recycle Bin. Use this for deletion in AutoCodex tasks; never substitute permanent deletion. Absolute paths only. The local panel decides whether a human approval is needed. Do not retry after an uncertain/partial result.',
  inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 80 } }, required: ['paths'], additionalProperties: false } };

export function prepareRecycle(args, task, settings, dataDirectory) {
  assert(process.platform === 'win32', '本版本回收站工具仅支持 Windows');
  assert(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 1 && Array.isArray(args.paths), '回收站参数仅接受 paths 数组');
  assert(args.paths.length > 0 && args.paths.length <= 80, '每次可移入回收站 1–80 个明确目标');
  assert(task.sandbox !== 'read-only', '只读任务不能使用回收站工具');
  const protectedRoots = [task.cwd, dataDirectory, process.cwd(), process.env.USERPROFILE, process.env.SystemRoot, process.env.ProgramFiles].filter(Boolean).map(canonicalPath);
  const protectedTrees = [dataDirectory, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(canonicalPath);
  let visited = 0;
  const inspect = path => {
    assert(++visited <= 20000, '目标目录过大，请分批处理');
    assert(!['.git', '.codex', '.ssh', '$recycle.bin'].includes(basename(path).toLowerCase()), '目标包含版本记录、凭据目录或回收站，不能整体回收');
    const stat = lstatSync(path);
    assert(!stat.isSymbolicLink(), '回收站操作不接受符号链接或联接点');
    assert(stat.isFile() || stat.isDirectory(), '只支持普通文件与文件夹');
    if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(resolve(path, name));
  };
  const targets = args.paths.map(path => {
    const exact = resolve(path), real = canonicalPath(path);
    assert(exact.toLowerCase() === real.toLowerCase(), '路径经过联接点，请提供真实目录并重新核对');
    assert(real !== parse(real).root && !protectedRoots.some(root => within(root, real)), '不能回收工作目录、运行数据目录、系统目录或它们的父目录');
    assert(!protectedTrees.some(root => within(real, root)), '不能回收系统目录或运行数据库中的内容');
    assert(!real.split(/[\\/]/).some(part => ['.git', '.codex', '.ssh', '$recycle.bin'].includes(part.toLowerCase())), '不能回收版本记录、凭据目录或回收站本身');
    const categories = pathCategories(real, task, settings);
    inspect(real);
    return { path: real, categories };
  });
  assert(new Set(targets.map(t => t.path.toLowerCase())).size === targets.length, '回收目标不能重复');
  assert(!targets.some((a, i) => targets.some((b, j) => i !== j && within(a.path, b.path))), '回收目标不能同时包含父目录与子项');
  return { paths: targets.map(t => t.path), categories: [...new Set(['recycleDeletes', ...targets.flatMap(t => t.categories)])] };
}

export function recyclePaths(paths, { signal } = {}) {
  assert(process.platform === 'win32', '本版本回收站工具仅支持 Windows');
  const script = fileURLToPath(new URL('../native/recycle.ps1', import.meta.url));
  return new Promise((resolvePromise, reject) => {
    // Paths travel as JSON on stdin, never as PowerShell source or switches.
    if (signal?.aborted) { reject(new Error('回收站操作已取消')); return; }
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timeout = false;
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timeout = true; child.kill(); }, 60000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-200000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) { reject(new Error('回收站操作已停止，可能部分完成，请核对结果')); return; }
      if (timeout || code !== 0) { reject(new Error(timeout ? '回收站执行超时，结果可能部分完成；请核对，勿自动重试' : '回收站执行失败；不会转为永久删除。' + stderr)); return; }
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        assert(typeof result.success === 'boolean' && Array.isArray(result.recycled) && result.recycled.every(path => paths.includes(path)), '回收站结果不完整');
        if (result.success) assert(result.recycled.length === paths.length, '回收站完成数量不匹配');
        resolvePromise(result);
      } catch { reject(new Error('回收站响应无法核实，请人工核对，勿重复操作')); }
    });
    child.stdin.end(JSON.stringify({ paths }), 'utf8');
  });
}
