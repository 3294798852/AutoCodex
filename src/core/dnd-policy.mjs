import { isAbsolute, resolve, relative, dirname, basename, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { assert } from './util.mjs';

export const DND_KEYS = ['outsideWorkspace', 'commonCommands', 'recycleDeletes', 'systemTools', 'confirmationPrompts'];
export const DND_LABELS = { outsideWorkspace: '沙箱外写文件免确认', commonCommands: '常用命令免确认', recycleDeletes: '大批量删除免确认', systemTools: '系统级工具放行', confirmationPrompts: '弹窗自动点允许' };
export const DEFAULT_DND = Object.freeze({ outsideWorkspace: false, commonCommands: false, recycleDeletes: false, systemTools: false, confirmationPrompts: false, outsideRoots: [], revision: 0 });

function absolutePath(value) {
  assert(typeof value === 'string' && value.length <= 2000 && isAbsolute(value), '需要完整的本机绝对路径');
  assert(!/[\0\r\n*?]/.test(value) && !value.startsWith('\\\\') && !value.startsWith('//'), '不支持通配符、设备或网络路径');
  if (process.platform === 'win32') {
    assert(/^[A-Za-z]:[\\/]/.test(value) && !value.slice(2).includes(':') && !/[. ](?:[\\/]|$)/.test(value), '不支持特殊设备流或模糊路径');
    assert(!value.split(/[\\/]/).some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), '不支持设备名称');
  }
  return resolve(value);
}
export function canonicalPath(value) {
  absolutePath(value);
  let path = resolve(value), suffix = [];
  while (!existsSync(path)) { const parent = dirname(path); assert(parent !== path, '路径所在磁盘不可用'); suffix.unshift(basename(path)); path = parent; }
  return resolve(realpathSync(path), ...suffix);
}
export function within(path, root) { const rel = relative(root, path); return rel === '' || !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && rel !== '..' && !isAbsolute(rel); }
export function validateDnd(input, previous = DEFAULT_DND, { restoring = false } = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input), '免打扰设置必须是对象');
  assert(Object.keys(input).every(key => [...DND_KEYS, 'outsideRoots', 'revision'].includes(key)), '包含未知免打扰设置');
  const next = structuredClone(previous);
  for (const key of DND_KEYS) if (Object.hasOwn(input, key)) { assert(typeof input[key] === 'boolean', '开关必须为 true 或 false'); next[key] = input[key]; }
  if (Object.hasOwn(input, 'outsideRoots')) {
    assert(Array.isArray(input.outsideRoots) && input.outsideRoots.length <= 20, '最多配置 20 个工作区外目录');
    next.outsideRoots = [...new Set(input.outsideRoots.map(restoring ? absolutePath : canonicalPath))];
  }
  if (Object.hasOwn(input, 'revision')) assert(Number.isSafeInteger(input.revision) && input.revision >= 0, '设置版本无效');
  return next;
}
const manual = reason => ({ automatic: false, reason, categories: [] });
function allow(settings, categories, response, reason) {
  const unique = [...new Set(categories)], missing = unique.filter(key => !settings[key]);
  return missing.length ? manual('未开启：' + missing.map(key => DND_LABELS[key]).join('、')) : { automatic: true, categories: unique, response, reason };
}
export function pathCategories(path, task, settings) {
  const resolved = canonicalPath(path), cwd = canonicalPath(task.workspaceCwd || task.cwd);
  if (within(resolved, cwd)) return [];
  assert(!settings.outsideRoots.length || settings.outsideRoots.some(root => within(resolved, canonicalPath(root))), '目标不在允许的工作区外目录');
  return ['outsideWorkspace'];
}

// Expansion, redirection, script bodies and ambiguous syntax stay manual.
export function tokenizeCommands(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 16000 || /[$\x60%{}\x00-\x1f()<>]/.test(command)) return null;
  let quote = '', token = '', current = [], segments = [], empty = true;
  const flush = () => { if (!empty) { current.push(token); token = ''; empty = true; } };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && /["'\\]/.test(command[i + 1] || '')) return null;
    if (quote) { if (ch === quote) quote = ''; else token += ch; empty = false; continue; }
    if (ch === '"' || ch === "'") { quote = ch; empty = false; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    if (ch === ',' || ch === '^') return null;
    if (ch === ';' || ch === '|' || ch === '&') {
      flush();
      if (ch === '&' && !current.length && !segments.length && command[i + 1] !== '&') continue;
      if (!current.length) return null;
      if (command[i + 1] === ch && ch !== ';') i++;
      else if (ch === '&') return null;
      segments.push(current); current = []; continue;
    }
    token += ch; empty = false;
  }
  if (quote) return null;
  flush(); if (!current.length) return null;
  segments.push(current); return segments.length <= 20 ? segments : null;
}
const readers = new Set(['get-content', 'get-childitem', 'get-item', 'test-path', 'resolve-path', 'cat', 'ls', 'dir', 'type', 'rg']);
const formatters = new Set(['select-object', 'sort-object', 'measure-object', 'format-list', 'format-table', 'out-string']);
const systemCommands = new Set(['get-service', 'start-service', 'stop-service', 'restart-service', 'set-service', 'get-process', 'stop-process', 'get-nettcpconnection', 'get-itemproperty', 'set-itemproperty', 'netstat', 'ipconfig', 'tasklist', 'taskkill']);
// Resolve recognized installed shells, never strip arbitrary executable paths to a trusted basename.
const shellCandidates = process.platform === 'win32' ? [
  process.env.SystemRoot && join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
  process.env.USERPROFILE && join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'),
] : ['/bin/sh', '/bin/bash', '/usr/bin/sh', '/usr/bin/bash'];
const installedShells = new Map(shellCandidates.filter(path => path && existsSync(path)).map(path => [canonicalPath(path).toLowerCase(), basename(path).replace(/\.exe$/i, '').toLowerCase()]));
function classifySegment(tokens, task, settings, depth = 0) {
  if (depth > 2 || !tokens.length) return manual('命令结构过深或缺失');
  const [program, ...args] = tokens, name = program.toLowerCase().replace(/\.exe$/, '');
  if (['powershell', 'pwsh', 'bash', 'sh'].includes(name)) {
    const index = args.findIndex(arg => ['-command', '-c', '-lc'].includes(arg.toLowerCase()));
    const flags = args.slice(0, index).map(arg => arg.toLowerCase());
    if (index < 0 || args.length !== index + 2 || flags.some(arg => !['-noprofile', '-noninteractive', '-nologo'].includes(arg))) return manual('脚本启动参数不在支持范围');
    return classifyCommand(args[index + 1], task, settings, depth + 1);
  }
  if (/[\\/]/.test(program)) return manual('未识别的可执行文件路径');
  const lower = args.map(arg => arg.toLowerCase());
  if (['rm', 'rmdir', 'del', 'erase', 'remove-item', 'unlink', 'format', 'diskpart', 'clear-recyclebin'].includes(name)) return manual('直接删除不会转换为回收站操作，请使用 autocodex_recycle');
  let categories = [];
  if (readers.has(name)) {
    if (args.some(arg => arg.startsWith('-') && (/[:=]/.test(arg) || !/^(?:--?(?:files|hidden|line-number|no-heading|smart-case|ignore-case|fixed-strings|glob|iglob|type|type-not|encoding|max-count|count|files-with-matches|files-without-match|context|after-context|before-context)|-[nilsSFvcegABCU0-9]+|-LiteralPath|-Path|-Encoding|-Raw|-TotalCount|-Tail|-Force|-Recurse|-File|-Directory|-Name|-Depth)$/i.test(arg)))) return manual('查询命令参数不在可识别范围');
    categories.push('commonCommands');
    let paths = [];
    const valueOptions = new Set(['-encoding', '-totalcount', '-tail', '-depth', '--encoding', '--max-count', '--context', '--after-context', '--before-context', '-a', '-b', '-c']);
    let patternSeen = name !== 'rg' || args.includes('--files');
    for (let i = 0; i < args.length; i++) {
      const arg = args[i], lowerArg = arg.toLowerCase();
      if (name === 'rg' && ['-f', '-e', '--glob', '--iglob', '--type', '--type-not', '-g'].includes(lowerArg)) return manual('搜索文件/模式参数需人工核对');
      if (valueOptions.has(lowerArg)) { if (!args[++i] || args[i].startsWith('-')) return manual('查询参数值缺失'); continue; }
      if (arg.startsWith('-')) continue;
      if (!patternSeen) { patternSeen = true; continue; }
      paths.push(arg);
    }
    if (!paths.length) paths = ['.'];
    for (const path of paths) {
      categories.push(...pathCategories(resolve(task.cwd, path), task, settings));
    }
  } else if (['set-content', 'add-content', 'new-item'].includes(name)) {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['-literalpath', '-path', '-value', '-encoding', '-itemtype'].includes(lower[i]) || !args[i + 1] || Object.hasOwn(options, lower[i])) return manual('文件写入需要明确路径和值');
      options[lower[i]] = args[i + 1];
    }
    const path = options['-literalpath'] || options['-path'];
    if (!path || options['-path'] && options['-literalpath']) return manual('文件目标缺失或不明确');
    if (name === 'new-item' && !['file', 'directory'].includes(options['-itemtype']?.toLowerCase())) return manual('只支持创建普通文件或文件夹');
    if (name !== 'new-item' && !Object.hasOwn(options, '-value')) return manual('写入内容缺失');
    pathCategories(resolve(task.cwd, path), task, settings); categories.push('outsideWorkspace');
  } else if (formatters.has(name) && args.every(arg => !/[\\/:]/.test(arg))) categories.push('commonCommands');
  else if (name === 'git' && ['status', 'diff', 'log', 'show', 'branch'].includes(lower[0])) {
    if (lower.some(arg => /^(--output|--ext-diff|--no-index|--exec|--textconv|-d|--delete|--force|-f|--move|-m|--copy|-c)(=|$)/i.test(arg))) return manual('Git 参数需要人工核对');
    if (lower[0] === 'branch' && args.length > 1 && !args.slice(1).every(arg => ['--list', '-a', '--all', '-r', '--remotes', '--show-current'].includes(arg))) return manual('修改分支需要人工核对');
    categories.push('commonCommands');
  } else if (['npm', 'pnpm', 'yarn'].includes(name) && (
    ['test', 'build', 'lint', 'check'].includes(lower[0]) && args.length === 1 ||
    lower[0] === 'run' && ['test', 'build', 'lint', 'check', 'typecheck'].includes(lower[1]) && args.length === 2)) categories.push('commonCommands');
  else if (['node', 'python', 'python3'].includes(name) && lower.length === 1 && ['--version', '-v'].includes(lower[0])) categories.push('commonCommands');
  else if (systemCommands.has(name) || program.toLowerCase() === 'sc.exe' && ['query', 'queryex', 'start', 'stop', 'config'].includes(lower[0]) || name === 'reg' && ['query', 'add'].includes(lower[0])) categories.push('systemTools');
  else return manual('命令不在当前可识别列表，保留人工决定');
  return { automatic: true, categories };
}
function classifyCommand(command, task, settings, depth = 0) {
  if (typeof command === 'string') {
    const wrapper = command.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))\s+([\s\S]+)$/);
    if (wrapper) {
      let executable = wrapper[1] || wrapper[2] || wrapper[3];
      // Codex's Windows display string doubles path separators inside the executable token.
      if (process.platform === 'win32' && /^[A-Za-z]:/.test(executable)) executable = executable.replace(/\\{2}/g, '\\');
      if (isAbsolute(executable)) {
        const shell = installedShells.get(canonicalPath(executable).toLowerCase());
        if (!shell) return manual('未识别的可执行文件路径');
        command = shell + ' ' + wrapper[4];
      }
    }
  }
  const segments = tokenizeCommands(command); if (!segments) return manual('命令含展开、重定向或未支持语法');
  let categories = [];
  for (const tokens of segments) { const result = classifySegment(tokens, task, settings, depth); if (!result.automatic) return result; categories.push(...result.categories); }
  return { automatic: true, categories };
}
function permissionCategories(permissions, task, settings) {
  assert(permissions && typeof permissions === 'object' && !Array.isArray(permissions), '权限内容不完整');
  assert(Object.keys(permissions).every(key => ['fileSystem', 'network'].includes(key)) && !permissions.network, '网络或未知权限保留人工');
  const fs = permissions.fileSystem;
  assert(fs && typeof fs === 'object' && !Array.isArray(fs) && Object.keys(fs).every(key => ['read', 'write', 'entries'].includes(key)), '权限范围不明确');
  for (const key of ['read', 'write', 'entries']) assert(fs[key] == null || Array.isArray(fs[key]), '权限路径必须为数组');
  const paths = [...(fs.read || []), ...(fs.write || [])];
  for (const entry of fs.entries || []) {
    assert(entry && Object.keys(entry).every(key => ['access', 'path'].includes(key)) && ['read', 'write'].includes(entry.access) && entry.path?.type === 'path' && Object.keys(entry.path).every(key => ['type', 'path'].includes(key)), '通配、未知或特殊路径权限保留人工');
    paths.push(entry.path.path);
  }
  assert(paths.length > 0 && paths.length <= 80, '权限路径数量无效');
  for (const path of paths) pathCategories(path, task, settings);
  return ['outsideWorkspace'];
}
const acceptLabels = new Set(['accept', 'allow', 'approve', '允许', '批准', '同意']);
const negativeLabels = new Set(['decline', 'deny', 'cancel', '拒绝', '取消']);
export function evaluateDnd({ request, item, task, settings }) {
  const p = request.params || {};
  try {
    if (p.environmentId && p.environmentId !== 'local') return manual('远程执行环境保留人工决定');
    if (task.sandbox === 'read-only') return manual('只读任务保留人工批准');
    if (request.method === 'item/commandExecution/requestApproval') {
      if (p.networkApprovalContext || p.kind && p.kind !== 'command') return manual('网络或标准输入批准保留人工');
      if (p.availableDecisions && !p.availableDecisions.includes('accept')) return manual('Codex 未提供单次允许');
      const cwd = canonicalPath(p.cwd || item?.cwd || task.cwd);
      const result = classifyCommand(p.command ?? item?.command, { ...task, cwd, workspaceCwd: task.cwd }, settings);
      if (!result.automatic) return result;
      const categories = [...result.categories, ...pathCategories(cwd, task, settings)];
      if (p.additionalPermissions) categories.push(...permissionCategories(p.additionalPermissions, task, settings));
      return allow(settings, categories, { decision: 'accept' }, '全部命令片段匹配已开启类别');
    }
    if (request.method === 'item/fileChange/requestApproval') {
      assert(item?.type === 'fileChange' && Array.isArray(item.changes) && item.changes.length && item.changes.length <= 80, '缺少完整文件变更预览');
      if (p.availableDecisions && !p.availableDecisions.includes('accept')) return manual('Codex 未提供单次允许');
      for (const change of item.changes) {
        assert(['add', 'update'].includes(change.kind?.type), '文件删除或未知补丁类型保留人工');
        pathCategories(change.path, task, settings);
        if (change.kind.move_path) pathCategories(change.kind.move_path, task, settings);
      }
      return allow(settings, ['outsideWorkspace'], { decision: 'accept' }, '文件变更路径已核实，仅批准本次');
    }
    if (request.method === 'item/permissions/requestApproval') {
      const categories = permissionCategories(p.permissions, task, settings);
      return allow(settings, categories, { permissions: structuredClone(p.permissions), scope: 'turn' }, '授予请求中的确切文件权限，仅限当前回合');
    }
    if (request.method.endsWith('requestUserInput')) {
      assert(item?.type === 'mcpToolCall' && item.id === p.itemId, '普通问题不视为权限确认');
      assert(Array.isArray(p.questions) && p.questions.length > 0 && p.questions.length <= 3, '确认内容不完整');
      const answers = {};
      for (const q of p.questions) {
        assert(!q.isOther && !q.isSecret && q.id && Array.isArray(q.options) && q.options.length >= 2, '需要用户输入的内容不能自动回答');
        const positive = q.options.filter(o => acceptLabels.has(o.label?.toLowerCase()));
        assert(positive.length === 1 && q.options.every(o => acceptLabels.has(o.label?.toLowerCase()) || negativeLabels.has(o.label?.toLowerCase())), '选项不是明确的允许/拒绝确认');
        answers[q.id] = { answers: [positive[0].label] };
      }
      return allow(settings, ['confirmationPrompts'], { answers }, '关联工具的明确允许/拒绝确认');
    }
    if (request.method === 'mcpServer/elicitation/request') {
      if (p.mode === 'form' && p._meta?.codex_approval_kind === 'mcp_tool_call'
        && item?.type === 'mcpToolCall' && item.server === p.serverName && item.status === 'inProgress'
        && JSON.stringify(item.arguments) === JSON.stringify(p._meta.tool_params)) {
        return allow(settings, ['confirmationPrompts'], { action: 'accept', content: {} }, 'Codex 关联的确切 MCP 工具调用确认');
      }
      const schema = p.requestedSchema;
      assert(p.mode === 'form' && schema?.type === 'object' && schema.properties && !schema.anyOf && !schema.oneOf && !schema.allOf && !schema.$ref, '授权流程或复杂表单需要人工');
      const entries = Object.entries(schema.properties);
      assert(entries.length === 1 && schema.required?.length === 1 && schema.required[0] === entries[0][0], '非单项确认表单');
      const [key, field] = entries[0];
      assert(['confirm', 'approve', 'allow'].includes(key) && field.type === 'boolean' && Object.keys(field).every(k => ['type', 'title', 'description'].includes(k)), '普通表单不自动填答');
      return allow(settings, ['confirmationPrompts'], { action: 'accept', content: { [key]: true } }, '明确的单项工具确认表单');
    }
    return manual('此请求需要人工处理');
  } catch (error) { return manual(error.message); }
}
