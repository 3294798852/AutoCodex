#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const version = JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8')).version;

const tools = [
  {
    name: 'guard_status', description: '查询本机 AutoCodex 受管任务、运行状态、恢复次数和告警。只读；不会接管、创建或继续其他会话。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, threadId: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'guard_checkpoint', description: '为明确指定的受管任务保存检查点，包括已完成、待办和约束，供异常后新会话接续。必须提供 taskId 或 threadId。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, threadId: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 8000 } }, required: ['text'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'guard_read_handoff', description: '读取明确指定的交接包，或指定受管任务最新的交接材料。包含旧对话链接、原目标、检查点和有界历史。',
    inputSchema: { type: 'object', properties: { handoffId: { type: 'string' }, taskId: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

async function request(path, data) {
  const filename = process.env.AUTOCODEX_CONNECTION_FILE || resolve('.autocodex/live/connection.json');
  let connection;
  try { connection = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new Error('无法读取 AutoCodex 连接文件。请启动本机守护服务，并将 AUTOCODEX_CONNECTION_FILE 指向其 connection.json。'); }
  const origin = new URL(connection.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.pathname !== '/') throw new Error('AutoCodex 插件只连接本机 127.0.0.1 服务');
  if (typeof connection.pluginToken !== 'string') throw new Error('连接文件缺少插件专用口令，请更新并重启守护服务');
  const response = await fetch(`${origin.origin}/api/v1${path}`, {
    method: data === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${connection.pluginToken}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本机守护服务返回错误');
  return result;
}

async function findTask(args) {
  if (!args.taskId && !args.threadId) throw new Error('请明确提供 taskId 或 threadId，不自动选择其他任务');
  const state = await request('/state');
  const tasks = state.tasks.filter(task => (!args.taskId || task.id === args.taskId) && (!args.threadId || task.threadId === args.threadId));
  if (tasks.length !== 1) throw new Error('无法唯一确定受管任务；请从监测面板复制 taskId');
  return tasks[0];
}

async function call(name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
  if (name === 'guard_status') {
    const state = await request('/state');
    const tasks = state.tasks.filter(task => (!args.taskId || task.id === args.taskId) && (!args.threadId || task.threadId === args.threadId));
    return { mode: state.mode, connection: state.connection, tasks: tasks.map(task => ({
      taskId: task.id, name: task.name, cwd: task.cwd, threadId: task.threadId, status: task.status, paused: task.paused,
      totalAutoAttempts: task.totalAutoAttempts, incident: task.incident, lastError: task.lastError,
      lastHandoffId: task.lastHandoffId || null,
    })), alerts: state.alerts.filter(alert => tasks.some(task => task.id === alert.taskId) && !alert.acknowledgedAt) };
  }
  if (name === 'guard_checkpoint') {
    const task = await findTask(args);
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 8000) throw new Error('检查点需要 1–8000 个字符');
    return request(`/tasks/${encodeURIComponent(task.id)}/checkpoint`, { text: args.text });
  }
  if (name === 'guard_read_handoff') {
    if (args.handoffId) return request(`/handoffs/${encodeURIComponent(args.handoffId)}`);
    if (!args.taskId) throw new Error('请提供 handoffId 或 taskId');
    const detail = await request(`/tasks/${encodeURIComponent(args.taskId)}`);
    if (!detail.handoffs.length) throw new Error('此任务尚未生成交接材料');
    return detail.handoffs[0];
  }
  throw new Error(`未知工具：${name}`);
}

const output = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let initialized = false;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (line.length > 65536) { output({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message too large' } }); return; }
  void (async () => {
    let message;
    try { message = JSON.parse(line); }
    catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    if (!Object.hasOwn(message, 'id')) return;
    const respond = result => output({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      initialized = true;
      respond({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'autocodex-guard', version } });
      return;
    }
    if (!initialized) { output({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'Not initialized' } }); return; }
    if (message.method === 'ping') { respond({}); return; }
    if (message.method === 'tools/list') { respond({ tools }); return; }
    if (message.method === 'tools/call') {
      try { const result = await call(message.params?.name, message.params?.arguments); respond({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }); }
      catch (error) { respond({ content: [{ type: 'text', text: error.message }], isError: true }); }
      return;
    }
    output({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  })().catch(() => output({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal bridge error' } }));
});
