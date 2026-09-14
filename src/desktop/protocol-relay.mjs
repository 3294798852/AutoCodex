import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { RECYCLE_SERVER, verifiedRecycle } from './recycle-protocol.mjs';

const hasId = value => Object.hasOwn(value, 'id');
const key = value => JSON.stringify(value);
const sandboxMode = policy => ({ readOnly: 'read-only', dangerFullAccess: 'danger-full-access', externalSandbox: 'external-sandbox' }[policy?.type] || 'workspace-write');
const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request']);
const threadOptions = ['model', 'modelProvider', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'permissions',
  'baseInstructions', 'developerInstructions', 'config', 'dynamicTools', 'personality', 'serviceTier', 'projectId',
  'runtimeWorkspaceRoots', 'selectedCapabilityRoots', 'environments', 'historyMode'];

// The desktop remains the sole app-server client. Internal calls never resume a thread.
export class ProtocolRelay extends EventEmitter {
  constructor({ toServer, toDesktop, approval = async () => null, now = Date.now, timeoutMs = 15000, approvalTimeoutMs = 1500, recycleSecret, onFault = () => {} }) {
    super(); Object.assign(this, { toServer, toDesktop, approval, now, timeoutMs, approvalTimeoutMs, recycleSecret, onFault });
    this.id = randomUUID(); this.sequence = 0; this.pending = new Map(); this.threads = new Map();
    this.items = new Map(); this.approvals = new Map(); this.resolved = new Set(); this.actions = new Set(); this.internalIds = new Set(); this.closed = false;
  }
  observe(fn) {
    try { return fn(); }
    catch (error) { this.assistanceDisabled = true; this.onFault(error); }
  }
  thread(id) {
    if (!this.threads.has(id)) this.threads.set(id, { id, generation: 0, loaded: false, active: false, pendingUser: 0, waiting: 0, turnId: null, failedTurnId: null });
    return this.threads.get(id);
  }
  event(type, threadId, data = {}) {
    this.observe(() => this.emit('event', { type, threadId, at: this.now(), ...data }));
  }
  snapshots() {
    return [...this.threads.values()].filter(t => t.loaded).map(({ template, startParams, error, ...t }) => ({ ...t }));
  }
  fromDesktop(message) {
    if (!message || typeof message !== 'object') return this.toServer(message);
    if (message.method && hasId(message)) {
      const p = message.params || {}, t = p.threadId ? this.thread(p.threadId) : null;
      this.observe(() => { if (t && ['turn/start', 'turn/steer', 'turn/interrupt', 'thread/settings/update', 'thread/unsubscribe', 'thread/archive'].includes(message.method)) {
        t.generation++;
        if (message.method === 'turn/start') {
          t.pendingUser++; t.template = { ...t.template, ...p };
          for (const name of ['input', 'clientUserMessageId', 'toolOutput', 'attachments', 'additionalContext', 'responsesapiClientMetadata']) delete t.template[name];
          for (const name of threadOptions) if (p[name] != null) (t.startParams ||= {})[name] = p[name];
        }
        if (message.method === 'thread/settings/update') t.template = { ...t.template, ...p };
        if (p.permissions) { delete t.template.sandboxPolicy; delete t.startParams?.sandbox; }
        if (p.sandboxPolicy) { delete t.template.permissions; delete t.startParams?.permissions; t.sandbox = sandboxMode(p.sandboxPolicy); }
        if (['thread/unsubscribe', 'thread/archive'].includes(message.method)) t.loaded = false;
        this.event(message.method === 'turn/interrupt' ? 'user_stop' : 'user_change', t.id, { generation: t.generation });
      } });
      // Preserve ordinary IDs so oversized messages can still bypass observation.
      const id = this.internalIds.has(message.id) ? `${this.id}:app:${++this.sequence}` : message.id;
      this.pending.set(id, { originalId: message.id, method: message.method, params: p });
      return this.toServer({ ...message, id });
    }
    if (!message.method && hasId(message)) {
      const waiting = this.approvals.get(key(message.id));
      if (waiting) { this.resolveApproval(waiting, 'manual'); }
    }
    return this.toServer(message);
  }
  fromServer(message) {
    if (!message || typeof message !== 'object') return this.toDesktop(message);
    if (!message.method && hasId(message)) {
      const p = this.pending.get(message.id);
      if (!p) { if (this.internalIds.has(message.id)) return; return this.toDesktop(message); }
      this.pending.delete(message.id); clearTimeout(p.timer);
      if (p.method === 'turn/start' && !p.internal) this.thread(p.params.threadId).pendingUser = Math.max(0, this.thread(p.params.threadId).pendingUser - 1);
      this.observe(() => { if (!message.error) {
        if (['thread/start', 'thread/resume', 'thread/fork'].includes(p.method) && message.result?.thread) this.rememberThread(message.result.thread, p.params, message.result);
        if (p.method === 'thread/unsubscribe' && p.params.threadId) this.thread(p.params.threadId).loaded = false;
      } });
      if (p.internal) { p.resolve(message); return; }
      return this.toDesktop({ ...message, id: p.originalId });
    }
    if (!this.assistanceDisabled && message.method && hasId(message) && approvalMethods.has(message.method)) {
      if (this.approvals.has(key(message.id)) || this.resolved.has(key(message.id))) return;
      const p = message.params || {};
      if (!p.threadId) return this.toDesktop(message);
      const t = this.thread(p.threadId);
      const entry = { message, threadId: p.threadId, turnId: p.turnId, generation: t.generation, forwarded: false, resolved: false, key: `${this.id}:${key(message.id)}` };
      this.approvals.set(key(message.id), entry); t.waiting++;
      this.event('waiting', t.id, { turnId: p.turnId });
      // A slow/offline policy service must not delay other desktop notifications.
      void this.decideApproval(entry).catch(error => { this.assistanceDisabled = true; this.onFault(error); });
      return;
    }
    if (message.method) this.observe(() => this.notification(message));
    return this.toDesktop(message);
  }
  rememberThread(thread, config = {}, result = {}) {
    const t = this.thread(thread.id);
    t.loaded = true; t.cwd = thread.cwd || config.cwd || t.cwd;
    t.startParams = { ...(t.startParams || {}), ...Object.fromEntries(threadOptions.filter(k => config[k] != null).map(k => [k, config[k]])) };
    for (const k of ['model', 'modelProvider', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'serviceTier', 'runtimeWorkspaceRoots']) if (result[k] != null) t.startParams[k] = result[k];
    t.model = result.model || thread.model || config.model || t.model;
    t.modelProvider = result.modelProvider || thread.modelProvider || config.modelProvider || t.modelProvider;
    t.sandbox = config.sandbox || (result.sandbox ? sandboxMode(result.sandbox) : t.sandbox || 'workspace-write');
    const profile = config.permissions || result.activePermissionProfile?.id;
    if (profile) {
      t.startParams.permissions = profile; delete t.startParams.sandbox;
      t.template = { ...t.template, permissions: profile }; delete t.template.sandboxPolicy;
    }
    if (result.sandbox && !profile && !t.template?.permissions) t.template = { ...t.template, sandboxPolicy: result.sandbox };
    if (result.reasoningEffort && !t.template?.effort) t.template = { ...t.template, effort: result.reasoningEffort };
    t.startParams.cwd = t.cwd; t.startParams.model = t.model; t.startParams.modelProvider = t.modelProvider;
    if (!t.startParams.permissions) t.startParams.sandbox = t.sandbox === 'external-sandbox' ? 'read-only' : t.sandbox;
    t.name = String(thread.name || thread.preview || t.name || 'Codex').slice(0, 180);
    t.path = thread.path || t.path;
    this.event('loaded', t.id);
  }
  notification(message) {
    const p = message.params || {}, id = p.threadId || p.thread?.id;
    if (message.method === 'thread/started' && p.thread) this.rememberThread(p.thread);
    if (message.method === 'serverRequest/resolved') {
      const entry = this.approvals.get(key(p.requestId)); if (entry) this.resolveApproval(entry, 'resolved');
    }
    if (!id) return;
    const t = this.thread(id), turnId = p.turnId || p.turn?.id || t.turnId;
    if (message.method === 'turn/started') {
      t.loaded = true; t.active = true; t.turnId = turnId; t.failedTurnId = null; t.error = null;
      this.event('started', id, { turnId, generation: t.generation });
    } else if (message.method === 'error') {
      if (turnId === t.turnId) t.error = p.error;
      this.event('error', id, { turnId, willRetry: p.willRetry, error: p.error });
    } else if (message.method === 'turn/completed') {
      if (t.turnId && turnId !== t.turnId) return;
      t.active = false; t.turnId = turnId;
      t.failedTurnId = p.turn?.status === 'failed' ? turnId : null;
      this.event('terminal', id, { turnId, status: p.turn?.status, error: p.turn?.error || t.error, generation: t.generation });
      for (const entry of this.approvals.values()) if (entry.threadId === id) this.resolveApproval(entry, 'expired');
    } else if (message.method === 'item/agentMessage/delta') {
      this.event('output', id, { turnId, itemId: p.itemId, text: String(p.delta || '').slice(-6000), complete: false });
    } else if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = p.item;
      if (!item) return;
      if (message.method === 'item/completed' && item.type === 'mcpToolCall' && item.server === RECYCLE_SERVER) {
        const result = verifiedRecycle(item.result?.structuredContent?._meta, this.recycleSecret);
        if (result) this.event('recycle_result', id, { turnId, result });
      }
      if (['fileChange', 'commandExecution', 'mcpToolCall'].includes(item.type)) {
        this.items.set(`${id}:${turnId}:${item.id}`, item);
        if (this.items.size > 1000) this.items.delete(this.items.keys().next().value);
      }
      if (message.method === 'item/completed' && item.type === 'agentMessage') this.event('output', id, { turnId, itemId: item.id, text: String(item.text || '').slice(-6000), complete: true });
      else if (message.method === 'item/completed' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
        this.event('tool', id, { turnId, item: { id: item.id, type: item.type, status: item.status, exitCode: item.exitCode, success: item.success, error: item.error ? true : undefined } });
      }
    } else if (message.method === 'thread/closed') { t.loaded = false; this.event('unloaded', id); }
  }
  resolveApproval(entry, outcome) {
    if (entry.resolved) return;
    entry.resolved = true; this.approvals.delete(key(entry.message.id)); this.resolved.add(key(entry.message.id));
    if (this.resolved.size > 5000) this.resolved.delete(this.resolved.values().next().value);
    const t = this.thread(entry.threadId); t.waiting = Math.max(0, t.waiting - 1);
    this.event('approval_result', entry.threadId, { key: entry.key, outcome, turnId: entry.turnId });
  }
  async decideApproval(entry) {
    let decision, timer;
    const p = entry.message.params || {};
    const item = this.items.get(`${entry.threadId}:${entry.turnId}:${p.itemId}`)
      || [...this.items.entries()].find(([k, v]) => k.startsWith(`${entry.threadId}:${entry.turnId}:`) && v.type === 'mcpToolCall' && v.status === 'inProgress'
        && v.server === p.serverName && key(v.arguments) === key(p._meta?.tool_params))?.[1];
    const ownGate = !!this.recycleSecret && p.serverName === RECYCLE_SERVER && p._meta?.codex_approval_kind === 'mcp_tool_call' && item?.tool === 'recycle';
    try { decision = await Promise.race([
      this.approval({ key: entry.key, threadId: entry.threadId, generation: entry.generation, state: this.snapshots().find(t => t.id === entry.threadId),
        recycle: ownGate ? { paths: item.arguments?.paths, gate: true } : p.serverName === RECYCLE_SERVER ? verifiedRecycle(p._meta, this.recycleSecret) : null,
        request: entry.message, item }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), this.approvalTimeoutMs); }),
    ]); } catch { /* Normal desktop approval is the fallback. */ }
    finally { clearTimeout(timer); }
    if (entry.resolved || this.closed) return;
    const t = this.thread(entry.threadId);
    if (decision?.automatic && !this.assistanceDisabled && t.generation === entry.generation && t.active && t.turnId === entry.turnId) {
      try { this.toServer({ id: entry.message.id, result: decision.response }); this.resolveApproval(entry, 'automatic'); return; }
      catch { this.resolveApproval(entry, 'uncertain'); return; }
    }
    entry.forwarded = true; this.toDesktop(entry.message);
    this.event('approval_manual', t.id, { key: entry.key, reason: decision?.reason || '保留原客户端批准' });
  }
  async execute(action) {
    if (this.closed || this.assistanceDisabled || this.actions.has(action.id)) return { outcome: 'unknown', reason: '动作已处理或辅助连接不可用' };
    this.actions.add(action.id);
    if (this.actions.size > 5000) this.actions.delete(this.actions.values().next().value);
    const t = this.threads.get(action.threadId);
    if (!t?.loaded || t.active || t.pendingUser || t.waiting || t.generation !== action.generation || t.failedTurnId !== action.failedTurnId) {
      return { outcome: 'skipped', reason: '原任务状态已变化，已避让用户操作' };
    }
    if (action.kind === 'replace') return this.replace(action, t);
    if (action.kind !== 'continue') return { outcome: 'skipped', reason: '未知辅助动作' };
    const params = { ...(t.template || {}), threadId: t.id, input: [{ type: 'text', text: action.message }] };
    t.pendingUser++;
    try {
      const result = await this.request('turn/start', params);
      return result.error ? { outcome: 'rejected', error: result.error } : { outcome: 'sent', turnId: result.result?.turn?.id };
    } catch (error) { return { outcome: 'unknown', reason: error.message }; }
    finally { t.pendingUser = Math.max(0, t.pendingUser - 1); }
  }
  request(method, params) {
    let id;
    do { id = `${this.id}:auto:${++this.sequence}`; } while (this.pending.has(id));
    this.internalIds.add(id);
    if (this.internalIds.size > 5000) this.internalIds.delete(this.internalIds.values().next().value);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('发送结果未确认')); }, this.timeoutMs);
      this.pending.set(id, { internal: true, method, params, resolve, timer });
      try { this.toServer({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async replace(action, source) {
    source.pendingUser++;
    try {
      const created = await this.request('thread/start', { ...source.startParams, serviceName: 'autocodex_desktop' });
      if (created.error) return { outcome: 'rejected', error: created.error };
      const thread = created.result?.thread;
      if (!thread?.id) return { outcome: 'unknown', reason: '新任务身份未确认' };
      const next = this.thread(thread.id);
      next.template = { ...source.template }; next.startParams = { ...source.startParams };
      if (source.generation !== action.generation || source.active || !source.loaded || next.active || next.pendingUser) {
        return { outcome: 'skipped', newThreadId: next.id, reason: '用户已有新操作，保留空白接续任务' };
      }
      this.event('replacement_created', source.id, { actionId: action.id, thread: { id: thread.id, path: thread.path, cwd: thread.cwd }, generation: next.generation });
      next.pendingUser++;
      try {
        const result = await this.request('turn/start', { ...next.template, threadId: next.id, input: [{ type: 'text', text: action.message }] });
        return result.error ? { outcome: 'rejected', newThreadId: next.id, error: result.error }
          : { outcome: 'sent', newThreadId: next.id, turnId: result.result?.turn?.id };
      } finally { next.pendingUser = Math.max(0, next.pendingUser - 1); }
    } catch (e) { return { outcome: 'unknown', reason: e.message }; }
    finally { source.pendingUser = Math.max(0, source.pendingUser - 1); }
  }
  close() {
    this.closed = true;
    for (const p of this.pending.values()) if (p.internal) { clearTimeout(p.timer); p.resolve({ error: { message: '原进程连接关闭', uncertain: true } }); }
    this.pending.clear();
  }
}
