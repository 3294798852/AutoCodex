import { DND_LABELS, DND_KEYS, validateDnd, evaluateDnd } from './dnd-policy.mjs';
import { ExistingSessions } from './existing-sessions.mjs';
import { prepareRecycle, recyclePaths } from './recycle.mjs';
import { EventEmitter } from 'node:events';
import { VERSION } from '../version.mjs';
import { isAbsolute } from 'node:path';
import { statSync, realpathSync } from 'node:fs';
import { AppError, assert, boundedText, uid, redact, safeData } from './util.mjs';
import { DEFAULT_POLICY, validatePolicy, newIncident, decideFailure } from './policy.mjs';
import { classifyError } from './classify.mjs';
import { buildHandoff, persistHandoff, handoffPrompt } from './handoff.mjs';
import { newOutputMonitor, syncOutputSuspension, noOutputElapsed, noOutputExpired, observeAgentOutput, observeToolOutput, successfulTool } from './progress.mjs';

const TERMINAL = new Set(['completed', 'stopped', 'failed']);
const BUSY = new Set(['starting', 'running', 'recovering', 'waiting_user']);
const SUPPORTED_REQUESTS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput',
  'mcpServer/elicitation/request', 'item/tool/call',
]);

export class Supervisor extends EventEmitter {
  constructor({ store, adapter, origin = 'http://127.0.0.1:3210', now = Date.now, random = Math.random, recycle = recyclePaths }) {
    super();
    Object.assign(this, { store, adapter, origin, now, random });
    this.existing = new ExistingSessions(this);
    this.recycle = recycle;
    this.dnd = validateDnd(store.getMeta('dndSettings') || {}, undefined, { restoring: true });
    this.dnd.revision = store.getMeta('dndSettings')?.revision || 0;
    this.rawItems = new Map(); this.rawApprovals = new Map(); this.transportGeneration = 0; this.approvalEpoch = uid();
    this.nativeOperations = new Map();
    this.resolvedRequests = new Set();
    this.pendingStops = new Set();
    this.queues = new Map();
    this.scheduled = new Set();
    this.defaultPolicy = validatePolicy(store.getMeta('defaultPolicy') || {});
    this.closed = false;
    this.faulted = false;
    adapter.on('notification', message => this.routeNotification(message));
    adapter.on('request', message => this.routeRequest(message));
    adapter.on('disconnect', error => {
      this.transportGeneration++; this.rawItems.clear(); this.rawApprovals.clear(); this.resolvedRequests.clear();
      for (const controller of this.nativeOperations.values()) controller.abort();
      this.disconnected(error);
    });
    adapter.on('connected', state => this.emit('change', { type: 'connection', state }));
    adapter.on('diagnostic', data => { this.lastDiagnostic = redact(data.message, 1200); });
    for (const approval of store.records('approvals').filter(a => ['pending', 'sending'].includes(a.status))) {
      if (approval.status === 'sending') {
        const task = store.task(approval.taskId);
        if (task) { task.approvalBlocked = true; this.alert(task, 'approval_uncertain', '服务重启时上次批准或回收结果未确认，请核对后手动处理'); }
        approval.status = 'uncertain';
      } else approval.status = 'expired';
      store.saveRecord('approvals', approval, approval.taskId);
    }
    for (const task of store.tasks()) {
      task.policy = validatePolicy(task.policy || {}, this.defaultPolicy);
      if (task.incident?.version !== 2 || !task.outputMonitor) {
        const previous = task.incident || {};
        task.incident = { ...newIncident(), id: previous.id || uid(), autoAttempts: previous.autoAttempts || 0, replacements: previous.replacements || 0 };
        task.outputMonitor = newOutputMonitor(this.now());
        if (task.retryPlan === 'replace') this.alert(task, 'recovery_rules_upgraded', '恢复规则已升级；旧接续计划缺少时间与输出证据，请核对后手动接续');
        this.record(task, 'recovery_rules_upgraded', '已启用三次/五次错误判定和无输出计时；旧历史及累计次数保留');
      } else store.saveTask(task);
    }
  }

  exclusive(id, fn) {
    const previous = this.queues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (this.closed || this.faulted) throw new AppError('守护服务已停止派发', 503);
      return fn();
    }).catch(error => {
      if (/SQLITE/.test(String(error.code || ''))) this.fault(error);
      throw error;
    });
    this.queues.set(id, next);
    next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {});
    return next;
  }

  fault(error) {
    if (this.faulted || this.closed) return;
    this.faulted = true;
    clearInterval(this.timer);
    this.emit('fatal', error);
  }

  getTask(id) { const task = this.store.task(id); assert(task, '任务不存在', 404); return task; }

  rememberThreadSettings(task, thread) {
    for (const key of ['model', 'modelProvider']) {
      if (typeof thread?.[key] === 'string' && thread[key]) task[key] = thread[key];
    }
  }

  record(task, type, message, options = {}) {
    syncOutputSuspension(task, this.now());
    let event;
    this.store.transaction(() => {
      task.updatedAt = this.now();
      this.store.saveTask(task);
      event = this.store.event(task.id, type, message, { ...options, now: this.now() });
    });
    this.emit('change', { taskId: task.id, event });
    return event;
  }

  alert(task, code, title, { final = false, preserveStatus = false, severity = 'error' } = {}) {
    if (!preserveStatus) {
      task.status = final ? 'failed' : 'needs_attention';
      task.retryDueAt = null;
      task.retryPlan = null;
    }
    syncOutputSuspension(task, this.now());
    const alert = { id: uid(), taskId: task.id, code, title, severity, createdAt: this.now(), acknowledgedAt: null };
    this.store.transaction(() => {
      this.store.saveRecord('alerts', alert, task.id);
      task.updatedAt = this.now();
      this.store.saveTask(task);
      this.store.event(task.id, 'alert', title, { level: severity, data: { code, alertId: alert.id }, now: this.now() });
    });
    this.emit('change', { taskId: task.id, alert });
  }

  async createTask(input) {
    if (input.threadId) assert(input.ownershipConfirmed === true, '接管前需要确认该会话已在其他客户端停止');
    const requestedThreadId = input.threadId ? boundedText(input.threadId, '会话 ID', 180) : null;
    if (requestedThreadId) assert(!this.store.tasks().some(existing => (existing.threadId === requestedThreadId || existing.adoptThreadId === requestedThreadId) && (existing.controlMode === 'observe' || !TERMINAL.has(existing.status))), '该会话已在其他监护任务中，请从原任务移交或继续', 409);
    const prompt = boundedText(input.prompt, '任务描述', 16000);
    const name = boundedText(input.name || prompt.slice(0, 60), '任务名称', 120);
    const cwdInput = boundedText(input.cwd, '工作目录', 2000);
    assert(isAbsolute(cwdInput), '工作目录必须是本机绝对路径');
    let cwd;
    try { assert(statSync(cwdInput).isDirectory(), '工作目录不是文件夹'); cwd = realpathSync(cwdInput); }
    catch (error) { throw new AppError(`工作目录不可用：${error.message}`); }
    assert(['workspace-write', 'read-only'].includes(input.sandbox || 'workspace-write'), '只支持项目读写或只读沙箱');
    const model = boundedText(input.model, '模型', 128, { optional: true });
    if (input.sourceUrl) assert(typeof input.sourceUrl === 'string' && /^(https?:\/\/|codex:\/\/)/i.test(input.sourceUrl) && input.sourceUrl.length <= 2000, '旧会话链接格式不正确');
    const now = this.now();
    const task = {
      id: uid(), name, prompt, cwd, model, modelProvider: null, sandbox: input.sandbox || 'workspace-write',
      policy: validatePolicy(input.policy || {}, this.defaultPolicy), mode: this.adapter.mode,
      scenario: input.scenario || 'intermittent', sourceUrl: input.sourceUrl || null,
      status: 'starting', paused: false, stopRequested: false,
      threadId: null, threadChain: [], turnId: null, turnKind: 'initial', turnStartedAt: now,
      adoptThreadId: requestedThreadId,
      pendingActionId: null, lastTerminalTurnId: null, incident: newIncident(), totalAutoAttempts: 0,
      retryDueAt: null, retryPlan: null, meaningfulProgress: false, isFallbackFirstTurn: false,
      lastError: null, lastActivityAt: now, lastOutput: '', outputMonitor: newOutputMonitor(now), createdAt: now, updatedAt: now,
      transportLost: false, staleWarned: false,
    };
    this.record(task, 'task_created', '任务已加入监护');
    return this.exclusive(task.id, async () => {
      if (input.threadId) {
        assert(input.ownershipConfirmed === true, '接管前需要确认该会话已在其他客户端停止');
        const threadId = requestedThreadId;
        try {
          const thread = await this.adapter.readThread(threadId);
          assert(thread.status?.type !== 'active' && !thread.turns?.some(turn => turn.status === 'inProgress'), '会话仍有活动回合，不能接管', 409);
          assert(!thread.cwd || realpathSync(thread.cwd) === cwd, '接管工作目录必须与原会话一致');
          if (!task.model && thread.model) task.model = thread.model;
          if (thread.modelProvider) task.modelProvider = thread.modelProvider;
          task.threadId = threadId;
          task.threadChain.push({ id: threadId, createdAt: now, reason: 'adopted' });
          this.rememberThreadSettings(task, await this.adapter.resumeThread(task));
          this.record(task, 'thread_adopted', '已接管用户移交的停止会话');
        } catch (error) {
          this.alert(task, 'adoption_failed', `会话接管失败：${redact(error.message)}`);
          return this.getTask(task.id);
        }
      } else if (!await this.openThread(task, false)) return this.getTask(task.id);
      await this.sendTurn(task, prompt, 'initial', `initial:${task.id}`);
      return this.getTask(task.id);
    });
  }

  async openThread(task, fallback) {
    if (this.closing || this.pendingStops.has(task.id)) return false;
    const action = { id: uid(), taskId: task.id, key: `thread:${task.id}:${uid()}`, kind: 'create_thread', state: 'sending', createdAt: this.now() };
    task.pendingActionId = action.id;
    task.status = fallback ? 'recovering' : 'starting';
    this.store.transaction(() => { this.store.saveAction(action); this.store.saveTask(task); });
    try {
      const thread = await this.adapter.createThread(task);
      assert(thread?.id, 'Codex 没有返回新会话 ID', 502);
      this.rememberThreadSettings(task, thread);
      task.recycleToolAvailable = thread.recycleToolAvailable === true;
      task.threadId = thread.id;
      task.threadChain.push({ id: thread.id, createdAt: this.now(), reason: fallback ? 'recovery' : 'created' });
      task.pendingActionId = null;
      action.state = 'accepted'; action.threadId = thread.id;
      this.store.transaction(() => { this.store.saveAction(action); this.store.saveTask(task); });
      this.record(task, 'thread_created', fallback ? '已创建接续会话' : 'Codex 会话已创建', { data: { threadId: thread.id } });
      return true;
    } catch (error) {
      action.state = error.uncertain ? 'uncertain' : 'rejected';
      action.error = redact(error.message);
      this.store.saveAction(action);
      if (!error.uncertain) task.pendingActionId = null;
      this.alert(task, fallback ? 'replacement_creation_failed' : 'thread_creation_failed', `创建${fallback ? '接续' : ''}会话失败：${redact(error.message)}`, { final: fallback });
      return false;
    }
  }

  async sendTurn(task, text, kind, key) {
    if (this.closing || this.pendingStops.has(task.id) || task.stopRequested || task.paused && kind === 'continue') return;
    if (task.approvalBlocked) { this.holdUncertainApproval(task); return; }
    if (['continue', 'fallback'].includes(kind) && noOutputExpired(task, this.now())) { this.blockForNoOutput(task); return; }
    const action = { id: uid(), taskId: task.id, key, kind, state: 'sending', threadId: task.threadId, createdAt: this.now() };
    const toolGuidance = task.recycleToolAvailable ? '\n文件删除请调用 autocodex_recycle 移入回收站；工具失败或结果不明时请报告并核对，不要改用永久删除或自动重试。' : '';
    const message = `${text}${toolGuidance}\n\n[AutoCodex task: ${task.id}]\n[AutoCodex action: ${action.id}]`;
    action.marker = `[AutoCodex action: ${action.id}]`;
    task.pendingActionId = action.id;
    task.status = kind === 'fallback' ? 'recovering' : 'starting';
    task.turnId = null;
    task.turnKind = kind;
    task.turnStartedAt = this.now();
    task.meaningfulProgress = false;
    task.isFallbackFirstTurn = kind === 'fallback';
    task.retryDueAt = null;
    task.retryPlan = null;
    task.lastActivityAt = this.now();
    task.staleWarned = false;
    task.observedError = null;
    task.observedErrorFinal = false;
    task.transportLost = false;
    task.outputMonitor.buffers = [];
    if (kind === 'continue') { task.incident.autoAttempts++; task.incident.attemptsWithoutOutput++; task.totalAutoAttempts++; }
    this.store.transaction(() => { this.store.saveAction(action); this.store.saveTask(task); });
    this.record(task, 'turn_dispatch', kind === 'continue' ? `自动发送继续 · 本周期第 ${task.incident.autoAttempts} 次` : kind === 'fallback' ? '向新会话发送交接材料' : '向 Codex 发送任务', { data: { actionId: action.id, kind } });
    try {
      const turn = await this.adapter.startTurn(task, message);
      assert(turn?.id, 'Codex 没有返回回合 ID', 502);
      task.turnId = turn.id;
      task.pendingActionId = null;
      task.status = 'running';
      action.state = 'accepted'; action.turnId = turn.id;
      this.store.transaction(() => { this.store.saveAction(action); this.store.saveTask(task); });
      this.record(task, 'turn_started', 'Codex 正在执行', { data: { turnId: turn.id } });
      if (turn.status && turn.status !== 'inProgress') this.completeTurn(task.id, task.threadId, turn);
    } catch (error) {
      action.state = error.uncertain ? 'uncertain' : 'rejected';
      action.error = redact(error.message);
      this.store.saveAction(action);
      if (error.uncertain) {
        this.alert(task, 'delivery_uncertain', '消息已尝试发送但未收到确认；先核对历史，防止重复执行');
      } else {
        task.pendingActionId = null;
        const failure = classifyError(error);
        task.turnId = `rejected:${action.id}`;
        await this.settleFailure(task, failure);
      }
    }
  }

  routeNotification({ method, params = {} }) {
    if (this.closed || this.faulted) return;
    const threadId = params.threadId || params.thread?.id;
    if (!threadId) return;
    const task = this.store.taskByThread(threadId);
    if (!task || task.threadId !== threadId || task.controlMode === 'observe') return;
    if (method === 'serverRequest/resolved') {
      const key = this.transportGeneration + ':' + threadId + ':' + String(params.requestId);
      this.resolvedRequests.add(key);
      if (this.resolvedRequests.size > 1000) this.resolvedRequests.delete(this.resolvedRequests.values().next().value);
      for (const raw of this.rawApprovals.values()) if (raw.request.params.threadId === threadId && String(raw.request.id) === String(params.requestId)) {
        raw.resolved = true; this.nativeOperations.get(task.id)?.abort();
      }
    }
    const generation = this.transportGeneration;
    this.exclusive(task.id, () => generation === this.transportGeneration && this.handleNotification(task.id, method, params)).catch(error => this.fault(error));
  }

  async handleNotification(id, method, params) {
    const task = this.getTask(id);
    if (TERMINAL.has(task.status) || task.stopRequested) return;
    if (params.threadId && params.threadId !== task.threadId) return;
    const turnId = params.turnId || params.turn?.id;
    if (turnId && task.turnId && turnId !== task.turnId) return;
    if (method === 'turn/completed') { await this.handleCompletion(task, params.turn); return; }
    if (task.turnId && task.lastTerminalTurnId === task.turnId && method !== 'serverRequest/resolved') return;
    if (method === 'turn/started') {
      if (!task.turnId && task.pendingActionId) {
        const action = this.store.action(task.pendingActionId);
        if (action?.kind !== 'create_thread') {
          task.turnId = params.turn.id; task.pendingActionId = null; task.status = 'running';
          action.turnId = task.turnId; action.state = 'accepted'; this.store.saveAction(action);
          this.record(task, 'delivery_reconciled', '运行事件确认消息已被接受');
        }
      }
      return;
    }
    if (method === 'serverRequest/resolved') {
      for (const approval of this.store.records('approvals', id)) {
        if (approval.requestId === String(params.requestId) && approval.status === 'pending') {
          approval.status = 'resolved'; this.store.saveRecord('approvals', approval, id); this.rawApprovals.delete(approval.id);
        }
      }
      if (task.status === 'waiting_user' && !this.pendingApprovals(id).length) task.status = 'running';
      this.record(task, 'request_resolved', '用户请求已解决');
      return;
    }
    if (method === 'error') {
      const error = classifyError(params.error);
      task.observedError = error;
      task.observedErrorFinal = params.willRetry === false;
      this.record(task, params.willRetry ? 'codex_retrying' : 'error_observed', params.willRetry ? `Codex 正在内部重试：${error.label}` : `检测到异常，等待回合终态：${error.label}`, { level: 'warning', data: { error, willRetry: params.willRetry } });
      return;
    }
    if (method === 'item/agentMessage/delta') {
      task.lastOutput = (task.lastOutput + redact(params.delta, 3000)).slice(-6000);
      observeAgentOutput(task, params.itemId, params.delta, this.now());
      task.lastActivityAt = this.now();
      this.store.saveTask(task);
      // UI receives bounded snapshots; raw reasoning and tool output deltas are not logged.
      this.emit('change', { taskId: id, type: 'output' });
      return;
    }
    if (['item/commandExecution/outputDelta', 'item/plan/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method)) {
      // Count activity without retaining raw reasoning or noisy tool output.
      if (this.now() - task.lastActivityAt >= 250) { task.lastActivityAt = this.now(); this.store.saveTask(task); }
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item || {};
      const itemKey = task.threadId + ':' + task.turnId + ':' + item.id;
      if (method === 'item/started') {
        if (this.rawItems.size >= 200) this.rawItems.delete(this.rawItems.keys().next().value);
        this.rawItems.set(itemKey, structuredClone(item));
      } else this.rawItems.delete(itemKey);
      task.lastActivityAt = this.now();
      if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
        task.itemPreviews = [...(task.itemPreviews || []).filter(old => old.id !== item.id).slice(-9), safeData(item)];
        const success = method === 'item/completed' && successfulTool(item);
        if (success) observeToolOutput(task, item, this.now());
        this.record(task, method === 'item/started' ? 'tool_started' : 'tool_completed', `${method === 'item/started' ? '执行' : '完成'}：${redact(item.command || item.tool || '文件修改', 160)}`, { data: { itemType: item.type, itemId: item.id, status: item.status, success } });
      } else if (item.type === 'agentMessage' && method === 'item/completed') {
        task.lastOutput = redact(item.text, 6000);
        observeAgentOutput(task, item.id, item.text, this.now(), true);
        this.record(task, 'agent_message', 'Codex 输出已更新', { data: { text: redact(item.text, 1600) } });
      } else this.store.saveTask(task);
      return;
    }
    if (method === 'thread/status/changed') {
      task.runtimeStatus = safeData(params.status);
      this.store.saveTask(task);
    }
  }

  completeTurn(id, threadId, turn) {
    this.exclusive(id, async () => {
      const task = this.getTask(id);
      if (task.threadId === threadId && task.turnId === turn.id && !TERMINAL.has(task.status)) await this.handleCompletion(task, turn);
    }).catch(error => this.fault(error));
  }

  handleCompletion(task, turn) {
    if (!turn?.id || task.turnId !== turn.id) return;
    return this.store.transaction(() => {
    if (!this.store.receipt(`terminal:${task.threadId}:${turn.id}`, this.now())) return;
    for (const item of turn.items || []) {
      if (item.type === 'agentMessage') observeAgentOutput(task, item.id, item.text, this.now(), true);
      else observeToolOutput(task, item, this.now());
    }
    task.lastActivityAt = this.now();
    task.lastTerminalTurnId = turn.id;
    task.pendingActionId = null;
    for (const request of this.pendingApprovals(task.id)) {
      request.status = 'expired'; this.store.saveRecord('approvals', request, task.id); this.rawApprovals.delete(request.id);
    }
    for (const key of this.rawItems.keys()) if (key.startsWith(task.threadId + ':' + turn.id + ':')) this.rawItems.delete(key);
    if (task.approvalBlocked) { this.holdUncertainApproval(task); return; }
    if (turn.status === 'completed') {
      task.status = 'completed'; task.retryDueAt = null; task.retryPlan = null;
      task.lastIncident = { ...task.incident }; task.incident = newIncident(); task.lastError = null; task.isFallbackFirstTurn = false;
      this.record(task, 'completed', '本次任务回合已正常完成');
    } else if (turn.status === 'interrupted') {
      task.status = 'stopped'; task.stopRequested = true; task.retryDueAt = null; task.retryPlan = null;
      this.record(task, 'interrupted', '回合被中断，自动恢复已停止');
    } else if (turn.status === 'failed') this.settleFailure(task, turn.error ? classifyError(turn.error) : task.observedErrorFinal && task.observedError ? task.observedError : classifyError({ message: '失败回合未包含错误详情' }));
    else this.alert(task, 'unknown_terminal', `无法确认回合终态：${turn.status}`);
    });
  }

  settleFailure(task, error) {
    task.lastError = error;
    task.lastTerminalTurnId = task.turnId;
    if (task.approvalBlocked) { this.holdUncertainApproval(task); return; }
    const decision = decideFailure(task, error, this.now(), this.random);
    task.incident = decision.incident;
    this.record(task, 'turn_failed', error.label, { level: 'warning', data: { error, consecutiveSame: task.incident.consecutiveSame, autoAttempts: task.incident.autoAttempts, threshold: task.incident.threshold, match: task.incident.match } });
    if (decision.action === 'halt') {
      this.alert(task, decision.code, '新会话首轮立即失败，自动接续已完全停止，请手动处理', { final: true });
    } else if (decision.action === 'manual') {
      if (decision.code === 'no_effective_output') { this.blockForNoOutput(task); return; }
      const title = decision.code === 'repeated_error' ? `${this.repeatedErrorReason(task)}，已停止自动续发`
        : decision.code === 'retry_budget_exhausted' ? '无有效输出期间的自动续发次数达到上限，已暂停等待处理'
          : `${error.label}，已暂停等待处理`;
      this.alert(task, decision.code, title);
    } else if (decision.action === 'replace') {
      task.status = 'retry_wait'; task.retryPlan = 'replace'; task.retryDueAt = this.now() + task.policy.baseDelayMs;
      this.alert(task, 'repeated_error', `${this.repeatedErrorReason(task)}，准备新会话接续`, { preserveStatus: true, severity: 'warning' });
    } else {
      task.status = 'retry_wait'; task.retryPlan = 'continue'; task.retryDueAt = decision.dueAt;
      this.record(task, 'retry_scheduled', `将在 ${Math.ceil((decision.dueAt - this.now()) / 1000)} 秒后自动继续`, { data: { dueAt: decision.dueAt } });
    }
  }

  repeatedErrorReason(task) {
    const { threshold, match } = task.incident;
    const reason = match.withinWindow ? `${Math.round(task.policy.errorWindowMs / 1000)} 秒内` : '期间无有效输出';
    return `连续 ${threshold} 次同类错误（含首次错误，${reason}）`;
  }

  holdUncertainApproval(task) {
    task.status = 'needs_attention'; task.retryDueAt = null; task.retryPlan = null;
    this.record(task, 'approval_protection_held', '批准或回收结果仍需核对，自动续发与新会话接续保持停止');
  }

  blockForNoOutput(task) {
    const running = BUSY.has(task.status) && task.turnId && task.lastTerminalTurnId !== task.turnId;
    task.retryDueAt = null; task.retryPlan = null;
    if (task.outputMonitor.blocked) {
      if (!running) task.status = 'needs_attention';
      this.store.saveTask(task);
      this.emit('change', { taskId: task.id });
      return;
    }
    const elapsed = Math.round(noOutputElapsed(task, this.now()) / 1000);
    task.outputMonitor.blocked = true;
    task.paused = true;
    this.alert(task, 'no_effective_output', `已连续 ${elapsed} 秒无有效输出，自动恢复已停止，请人工核对${running ? '；当前回合保留运行' : ''}`, { preserveStatus: !!running });
  }

  start() {
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref();
  }

  tick() {
    if (this.closed || this.faulted) return;
    this.existing.tick();
    for (const task of this.store.tasks()) {
      if (task.controlMode === 'observe') continue;
      if (task.paused || task.stopRequested || this.scheduled.has(task.id)) continue;
      if (['starting', 'running', 'recovering', 'retry_wait'].includes(task.status) && noOutputExpired(task, this.now())) {
        this.scheduled.add(task.id);
        this.exclusive(task.id, () => {
          const latest = this.getTask(task.id);
          if (!latest.paused && !latest.stopRequested && ['starting', 'running', 'recovering', 'retry_wait'].includes(latest.status) && noOutputExpired(latest, this.now())) this.blockForNoOutput(latest);
        }).catch(error => this.fault(error)).finally(() => this.scheduled.delete(task.id));
      } else if (task.retryDueAt !== null && task.retryDueAt <= this.now() && task.status === 'retry_wait') {
        this.scheduled.add(task.id);
        this.exclusive(task.id, () => this.dispatchScheduled(task.id)).catch(error => this.fault(error)).finally(() => this.scheduled.delete(task.id));
      } else if (task.status === 'running' && !task.staleWarned && this.now() - task.lastActivityAt > task.policy.staleAfterMs) {
        this.exclusive(task.id, () => {
          const latest = this.getTask(task.id);
          if (latest.status !== 'running' || latest.staleWarned) return;
          latest.staleWarned = true;
          this.alert(latest, 'no_recent_activity', '较长时间未收到运行活动；可能仍在执行工具，可核对状态', { preserveStatus: true, severity: 'warning' });
        }).catch(error => this.fault(error));
      }
    }
  }

  async dispatchScheduled(id) {
    const task = this.getTask(id);
    if (task.approvalBlocked) { this.holdUncertainApproval(task); return; }
    if (task.paused || task.stopRequested || task.status !== 'retry_wait' || task.retryDueAt > this.now()) return;
    if (noOutputExpired(task, this.now())) { this.blockForNoOutput(task); return; }
    if (task.retryPlan === 'reconcile') { await this.reconcileTask(task); return; }
    if (task.retryPlan === 'continue' && task.incident.attemptsWithoutOutput >= task.policy.maxAutoAttempts) {
      this.alert(task, 'retry_budget_exhausted', '已达到当前设置的自动续发上限'); return;
    }
    if (task.retryPlan === 'replace' && task.policy.strategy !== 'new_session') {
      this.alert(task, 'repeated_error', '已切换为人工策略，自动新会话计划已取消'); return;
    }
    try {
      const thread = await this.adapter.readThread(task.threadId);
      const last = thread.turns?.at(-1);
      if (thread.status?.type === 'active' || last?.status === 'inProgress' && task.abandonedTurnId !== last.id) {
        this.alert(task, 'external_activity', '会话仍在运行，已取消自动续发以避免重复执行'); return;
      }
      if (last && last.id !== task.lastTerminalTurnId && !task.lastTerminalTurnId?.startsWith('rejected:')) {
        this.alert(task, 'history_changed', '会话历史已有新的回合，已暂停自动控制，请核对'); return;
      }
    } catch (error) {
      this.alert(task, 'preflight_failed', `续发前无法核对会话状态：${redact(error.message)}`); return;
    }
    if (task.retryPlan === 'replace') await this.replaceTask(task, false);
    else await this.sendTurn(task, '继续。从上次异常中断处接续原任务，先核对已完成的工作与当前文件，避免重复执行已经成功的操作。原有权限、批准要求与用户约束继续有效。', 'continue', `continue:${task.id}:${task.incident.id}:${task.lastTerminalTurnId}`);
  }

  async replaceTask(task, manual) {
    if (task.approvalBlocked) { this.holdUncertainApproval(task); return; }
    let history = null, historyError = null;
    try { history = await this.adapter.readThread(task.threadId); }
    catch (error) { historyError = error.message; }
    if (history?.status?.type === 'active' || history?.turns?.at(-1)?.status === 'inProgress' && task.abandonedTurnId !== history.turns.at(-1).id) {
      this.alert(task, 'replacement_active_source', '旧会话仍在运行，不能启动接续会话'); return;
    }
    const packet = buildHandoff(task, history, this.store.records('checkpoints', task.id)[0], this.origin, this.now(), historyError);
    try {
      packet.filePath = persistHandoff(this.store.directory, packet);
      this.store.saveRecord('handoffs', packet, task.id);
    } catch (error) { this.alert(task, 'handoff_failed', `交接材料保存失败：${redact(error.message)}`); return; }
    if (manual) { task.incident = newIncident(); task.outputMonitor = newOutputMonitor(this.now()); }
    task.incident.replacements++;
    task.incident.consecutiveSame = 0; task.incident.lastErrorCategory = null; task.incident.recentErrors = []; task.incident.match = null;
    task.lastHandoffId = packet.id; task.retryDueAt = null; task.retryPlan = null;
    task.turnId = null; task.paused = false; task.stopRequested = false; task.approvalBlocked = false;
    this.record(task, 'handoff_saved', '旧会话链接、目标和进度已保存为交接材料', { data: { handoffId: packet.id, oldThreadId: packet.source.threadId } });
    if (await this.openThread(task, true)) await this.sendTurn(task, handoffPrompt(packet), 'fallback', `fallback:${packet.id}`);
  }

  disconnected(error) {
    if (this.closed || this.faulted) return;
    this.emit('change', { type: 'connection', state: this.adapter.state });
    for (const task of this.store.tasks().filter(item => item.controlMode !== 'observe' && BUSY.has(item.status))) {
      this.exclusive(task.id, () => {
        const latest = this.getTask(task.id);
        if (!BUSY.has(latest.status) || latest.stopRequested) return;
        latest.transportLost = true;
        const hadPendingRequest = latest.status === 'waiting_user' || this.pendingApprovals(task.id).length > 0;
        for (const approval of this.pendingApprovals(task.id)) {
          approval.status = 'expired'; this.store.saveRecord('approvals', approval, task.id);
        }
        if (latest.outputMonitor.blocked) { latest.status = 'needs_attention'; this.record(latest, 'transport_disconnected', 'Codex 已断开；长期无输出保护保持停止'); }
        else if (hadPendingRequest || latest.approvalBlocked) this.alert(latest, 'pending_request_lost', 'Codex 的批准请求已失效或结果未确认，需要人工核对');
        else if (latest.pendingActionId || !latest.turnId) this.alert(latest, 'transport_uncertain', 'Codex 断开时有未确认动作，需核对执行结果');
        else {
          latest.status = 'retry_wait'; latest.retryPlan = 'reconcile'; latest.retryDueAt = this.now() + 2000;
          this.record(latest, 'transport_disconnected', 'Codex 连接断开，将先重连核对历史', { level: 'warning', data: { message: error.message } });
        }
      }).catch(problem => this.fault(problem));
    }
  }

  async recover() {
    for (const approval of this.store.records('approvals').filter(a => a.status === 'pending')) {
      approval.status = 'expired'; this.store.saveRecord('approvals', approval, approval.taskId);
    }
    for (const task of this.store.tasks()) {
      if (task.controlMode === 'observe') continue;
      if (TERMINAL.has(task.status)) continue;
      if (task.mode !== this.adapter.mode) {
        this.alert(task, 'mode_changed', '此任务属于另一运行模式，请使用对应数据目录'); continue;
      }
      if (task.status === 'waiting_user' || task.approvalBlocked) {
        this.alert(task, 'pending_request_lost', '服务重启后原用户请求已失效，需要核对后手动处理'); continue;
      }
      if (task.status === 'retry_wait' && !task.pendingActionId) {
        this.record(task, 'schedule_restored', '已恢复持久化的重试计划'); continue;
      }
      if (BUSY.has(task.status) || task.pendingActionId) await this.exclusive(task.id, () => this.reconcileTask(task));
    }
  }

  async reconcileTask(task) {
    if (!task.threadId) { this.alert(task, 'reconcile_no_thread', '上次会话创建结果未知，请手动核对 Codex 历史'); return; }
    try {
      const thread = await this.adapter.readThread(task.threadId);
      if (task.pendingActionId) {
        const action = this.store.action(task.pendingActionId);
        const matches = (thread.turns || []).filter(turn => action?.marker && (turn.items || []).some(item => item.type === 'userMessage' && (item.content || []).some(part => part.text?.includes(action.marker))));
        if (matches.length !== 1) { this.alert(task, 'delivery_uncertain', '历史中无法唯一确认上次派发结果，已停止自动派发'); return; }
        task.turnId = matches[0].id; task.pendingActionId = null;
        action.turnId = task.turnId; action.state = 'accepted'; this.store.saveAction(action);
      }
      const turn = (thread.turns || []).find(item => item.id === task.turnId);
      if (!turn) { this.alert(task, 'reconcile_missing_turn', '历史中未找到受管回合，请手动核对'); return; }
      if (thread.turns.at(-1)?.id !== turn.id) { this.alert(task, 'history_changed', '历史已出现其他回合，停止自动接管'); return; }
      if (turn.status === 'inProgress') {
        if (thread.status?.type === 'active') {
          this.rememberThreadSettings(task, await this.adapter.resumeThread(task));
          task.status = 'running'; task.retryDueAt = null; task.retryPlan = null;
          this.record(task, 'reconnected', '已重新连接正在执行的受管回合');
        } else if (task.transportLost) {
          task.transportLost = false;
          task.abandonedTurnId = turn.id;
          await this.settleFailure(task, classifyError({ kind: 'processDisconnected', message: '受管进程已断开，历史回合未正常结束' }));
        } else this.alert(task, 'orphaned_turn', '上次回合未结束，无法确认是否仍在其他进程执行；需要人工核对');
      } else {
        if (turn.status === 'interrupted' && task.transportLost && !task.stopRequested) {
          task.transportLost = false;
          await this.settleFailure(task, classifyError({ kind: 'processDisconnected', message: '受管服务断开使回合中断，已核对历史终态' }));
          return;
        }
        task.status = 'running'; task.retryDueAt = null; task.retryPlan = null;
        this.store.saveTask(task);
        // A previously processed failed turn can be reconciled without counting it twice.
        if (task.lastTerminalTurnId === turn.id) {
          this.alert(task, 'reconciled_terminal', '已确认上次回合结束，可手动继续或新建接续会话');
        } else await this.handleCompletion(task, turn);
      }
    } catch (error) { this.alert(task, 'reconcile_failed', `无法核对 Codex 状态：${redact(error.message)}`); }
  }

  pendingApprovals(taskId) { return this.store.records('approvals', taskId).filter(approval => approval.status === 'pending'); }

  routeRequest(request) {
    if (this.closing || this.closed || this.faulted) return;
    const task = this.store.taskByThread(request.params?.threadId), generation = this.transportGeneration;
    if (!task || task.controlMode === 'observe' || task.threadId !== request.params.threadId || task.stopRequested) { this.adapter.reject(request.id, '会话不在控制范围'); return; }
    this.exclusive(task.id, async () => {
      const latest = this.getTask(task.id), params = request.params || {};
      if (this.closing) return;
      if (generation !== this.transportGeneration || this.resolvedRequests.has(generation + ':' + params.threadId + ':' + String(request.id))) return;
      if (this.pendingStops.has(task.id) || latest.stopRequested || TERMINAL.has(latest.status) || params.turnId && params.turnId !== latest.turnId || latest.lastTerminalTurnId === latest.turnId) {
        this.adapter.reject(request.id, '该回合已失效'); return;
      }
      if (!SUPPORTED_REQUESTS.has(request.method) || request.method === 'item/tool/call' && (params.tool !== 'autocodex_recycle' || params.namespace)) {
        this.adapter.reject(request.id, 'AutoCodex 尚不支持此类交互，请在原客户端处理');
        this.alert(latest, 'unsupported_request', 'Codex 请求了尚不支持的交互：' + request.method); return;
      }
      const receipt = this.approvalEpoch + ':' + generation + ':' + params.threadId + ':' + params.turnId + ':' + String(request.id);
      const item = this.rawItems.get(params.threadId + ':' + params.turnId + ':' + params.itemId) || null;
      const raw = { request: structuredClone(request), item, generation };
      const approval = { id: uid(), taskId: task.id, requestId: String(request.id), method: request.method,
        params: safeData(params), item: safeData(item), status: 'pending', createdAt: this.now(), settingsRevision: this.dnd.revision };
      approval.previewLimited = JSON.stringify(approval.params) !== JSON.stringify(params) || JSON.stringify(approval.item) !== JSON.stringify(item);
      let decision;
      if (!params.turnId || params.turnId !== latest.turnId || latest.paused || latest.approvalBlocked || latest.outputMonitor.blocked || latest.transportLost || !this.adapter.state.connected)
        decision = { automatic: false, reason: '任务暂停、保护锁定或缺少当前回合信息', categories: [] };
      else if (request.method === 'item/tool/call') {
        try {
          const prepared = prepareRecycle(params.arguments, latest, this.dnd, this.store.directory);
          const missing = prepared.categories.filter(key => !this.dnd[key]);
          decision = { automatic: !missing.length, categories: prepared.categories, reason: missing.length ? '回收站操作需要人工允许：' + missing.map(key => DND_LABELS[key]).join('、') : '明确目标通过回收站检查', recycle: true };
        } catch (error) { decision = { automatic: false, reason: error.message, categories: [] }; }
      } else decision = evaluateDnd({ ...raw, task: latest, settings: this.dnd });
      approval.automation = { automatic: decision.automatic, reason: redact(decision.reason), categories: decision.categories };
      let inserted = false;
      this.store.transaction(() => {
        inserted = this.store.receipt('approval:' + receipt, this.now());
        if (inserted) this.store.saveRecord('approvals', approval, task.id);
      });
      if (!inserted) return;
      this.rawApprovals.set(approval.id, raw);
      if (decision.automatic) {
        await this.finishApproval(latest, approval, decision.response, { automatic: true, recycle: decision.recycle, categories: decision.categories });
      } else {
        if (params.isBlocking !== false) latest.status = 'waiting_user';
        latest.lastActivityAt = this.now();
        this.record(latest, 'user_requested', 'Codex 需要用户决定：' + redact(decision.reason, 180), { data: { approvalId: approval.id, method: request.method, reason: decision.reason } });
      }
    }).catch(error => this.fault(error));
  }

  async finishApproval(task, approval, response, { automatic = false, recycle = false, categories = [] } = {}) {
    const raw = this.rawApprovals.get(approval.id);
    assert(raw && raw.generation === this.transportGeneration, '请求所属连接已失效，请核对', 409);
    assert(!raw.resolved, '请求已经由 Codex 解决', 409);
    assert(!task.stopRequested && !TERMINAL.has(task.status) && (!raw.request.params.turnId || raw.request.params.turnId === task.turnId), '请求所属回合已失效', 409);
    let prepared;
    if (recycle) {
      try { prepared = prepareRecycle(raw.request.params.arguments, task, this.dnd, this.store.directory); }
      catch (error) {
        if (!automatic) throw error;
        approval.automation = { automatic: false, categories: [], reason: redact(error.message) };
        this.store.saveRecord('approvals', approval, task.id); task.status = 'waiting_user';
        this.record(task, 'user_requested', '回收目标检查未通过，请人工核对：' + redact(error.message, 180));
        return task;
      }
    }
    approval.status = 'sending'; approval.source = automatic ? 'automatic' : 'manual';
    approval.categories = categories; approval.decidedAt = this.now();
    this.store.transaction(() => {
      this.store.saveRecord('approvals', approval, task.id);
      this.store.event(task.id, 'approval_decided', automatic ? '免打扰规则已匹配，正在批准本次请求' : '已记录用户决定', { data: { approvalId: approval.id, source: approval.source, categories, revision: approval.settingsRevision }, now: this.now() });
    });
    try {
      if (recycle) {
        const controller = new AbortController(); this.nativeOperations.set(task.id, controller);
        let result;
        try { result = await this.recycle(prepared.paths, { signal: controller.signal }); }
        finally { this.nativeOperations.delete(task.id); }
        response = { success: result.success, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
        approval.recycleResult = safeData(result);
      }
      assert(!raw.resolved && raw.generation === this.transportGeneration && this.adapter.state.connected, '请求已失效或批准发送前连接已断开', 409);
      await this.adapter.respond(approval.requestId, response);
      assert(raw.generation === this.transportGeneration && this.adapter.state.connected, '批准写入期间连接中断，结果待核对', 409);
      approval.status = 'answered'; approval.answeredAt = this.now(); approval.decision = response?.decision || response?.action || (response?.success === false ? 'decline' : response?.answers ? 'answered' : 'accept');
      this.store.saveRecord('approvals', approval, task.id);
      this.rawApprovals.delete(approval.id);
      if (!this.pendingApprovals(task.id).length && task.status === 'waiting_user') task.status = 'running';
      if (automatic) task.totalAutoApprovals = (task.totalAutoApprovals || 0) + 1;
      this.record(task, automatic ? 'approval_automatic' : 'user_responded', automatic ? '免打扰已处理：' + categories.map(key => DND_LABELS[key]).join('、') : '用户已处理 Codex 请求',
        { data: { approvalId: approval.id, categories, revision: approval.settingsRevision, durationMs: this.now() - approval.createdAt, recycle: approval.recycleResult } });
      if (response?.success === false && recycle) { task.approvalBlocked = true; this.alert(task, 'recycle_incomplete', '回收站操作未全部完成，请核对已回收目标后处理剩余项'); }
    } catch (error) {
      task.approvalBlocked = true;
      approval.status = 'uncertain'; approval.error = redact(error.message);
      this.store.saveRecord('approvals', approval, task.id); this.rawApprovals.delete(approval.id);
      this.alert(task, 'approval_uncertain', '批准或回收结果无法确认，已停止自动重发：' + redact(error.message, 180));
    }
    return task;
  }

  async respondApproval(id, input) {
    const approval = this.store.records('approvals').find(item => item.id === id);
    assert(approval && approval.status === 'pending', '请求已失效或已处理', 409);
    return this.exclusive(approval.taskId, async () => {
      const fresh = this.store.records('approvals', approval.taskId).find(item => item.id === id);
      assert(fresh.status === 'pending', '请求已经处理', 409);
      const task = this.getTask(approval.taskId), raw = this.rawApprovals.get(id);
      assert(raw, '原始请求已失效，请核对状态', 409);
      const params = raw.request.params;
      assert(!task.stopRequested && !TERMINAL.has(task.status), '任务已停止', 409);
      let response, recycle = false;
      if (approval.method === 'item/tool/call') {
        assert(['accept', 'decline', 'cancel'].includes(input.decision), '无效的决定');
        recycle = input.decision === 'accept';
        response = { success: false, contentItems: [{ type: 'inputText', text: '用户未允许此次回收站操作；未执行删除。' }] };
      } else if (approval.method.endsWith('requestUserInput')) {
        assert(input.answers && typeof input.answers === 'object', '请填写问题答案');
        const answers = {};
        for (const question of params.questions || []) answers[question.id] = { answers: [boundedText(input.answers[question.id], question.header || '答案', 8000)] };
        response = { answers };
      } else if (approval.method === 'mcpServer/elicitation/request') {
        assert(['accept', 'decline', 'cancel'].includes(input.decision), '无效的决定');
        response = { action: input.decision, content: input.decision === 'accept' ? input.content ?? null : null };
      } else if (approval.method === 'item/permissions/requestApproval') {
        assert(['accept', 'decline'].includes(input.decision), '无效的决定');
        response = { permissions: input.decision === 'accept' ? params.permissions || {} : {}, scope: 'turn' };
      } else {
        assert(['accept', 'decline', 'cancel'].includes(input.decision), '只允许批准本次、拒绝或取消');
        assert(!params.availableDecisions || params.availableDecisions.includes(input.decision), 'Codex 未提供此决定');
        response = { decision: input.decision };
      }
      return this.finishApproval(task, fresh, response, { recycle });
    });
  }

  setDnd(input) {
    assert(input?.revision === this.dnd.revision, '设置已在其他面板更新，请刷新后重试', 409);
    const next = validateDnd(input, this.dnd); next.revision = this.dnd.revision + 1;
    this.store.transaction(() => {
      this.store.setMeta('dndSettings', next);
      this.store.event(null, 'dnd_settings_updated', '免打扰设置已更新', { data: { settings: next }, now: this.now() });
    });
    this.dnd = next; this.emit('change', { type: 'dnd_settings_updated' });
    return this.dndSnapshot();
  }

  dndSnapshot() {
    const records = this.store.records('approvals');
    return { settings: this.dnd, enabledCount: DND_KEYS.filter(key => this.dnd[key]).length, recycleSupported: process.platform === 'win32',
      autoApproved: records.filter(a => a.source === 'automatic' && a.status === 'answered').length,
      recent: records.filter(a => a.source || a.status === 'pending').sort((a, b) => b.createdAt - a.createdAt).slice(0, 40) };
  }

  async control(id, action, input = {}) {
    if (action === 'stop' && this.getTask(id).controlMode !== 'observe') { this.pendingStops.add(id); this.nativeOperations.get(id)?.abort(); }
    return this.exclusive(id, async () => {
      const task = this.getTask(id);
      if (task.controlMode === 'observe') return this.existing.control(task, action, input);
      if (action === 'pause' || action === 'resume') {
        assert(action !== 'resume' || !task.outputMonitor.blocked, '长期无输出保护已触发，请核对当前回合后使用手动继续或新会话接续', 409);
        task.paused = action === 'pause';
        this.record(task, action, task.paused ? '自动恢复已暂停，当前工作继续运行' : '自动恢复监护已恢复');
      } else if (action === 'stop') {
        task.stopRequested = true; task.status = 'stopped'; task.retryDueAt = null; task.retryPlan = null;
        this.record(task, 'stopped', '用户停止任务，已取消所有自动恢复计划');
        for (const approval of this.pendingApprovals(id)) {
          approval.status = 'expired'; this.store.saveRecord('approvals', approval, id); this.rawApprovals.delete(approval.id);
        }
        if (task.turnId && task.lastTerminalTurnId !== task.turnId) {
          try { await this.adapter.interrupt(task.threadId, task.turnId); }
          catch (error) { this.alert(task, 'interrupt_unconfirmed', `自动派发已停止，但未确认 Codex 中断：${redact(error.message)}`, { preserveStatus: true }); }
        }
      } else if (action === 'reconcile') {
        assert(!TERMINAL.has(task.status), '任务已结束，核对不会自动重新激活任务', 409);
        await this.reconcileTask(task);
      }
      else if (action === 'continue' || action === 'new_session') {
        assert(!BUSY.has(task.status) && task.status !== 'retry_wait', '请先等待当前回合结束或停止自动恢复', 409);
        assert(!task.pendingActionId, '上次派发结果不确定，请先核对状态', 409);
        assert(task.threadId, '尚无可接续的会话，请创建新任务', 409);
        const thread = await this.adapter.readThread(task.threadId);
        assert(thread.status?.type !== 'active' && (thread.turns?.at(-1)?.status !== 'inProgress' || task.abandonedTurnId === thread.turns.at(-1).id), '会话仍在运行或终态不明，不能续发', 409);
        task.paused = false; task.stopRequested = false; task.approvalBlocked = false; this.pendingStops.delete(id);
        if (action === 'new_session') await this.replaceTask(task, true);
        else {
          task.incident = newIncident();
          task.outputMonitor = newOutputMonitor(this.now());
          await this.sendTurn(task, input.message ? boundedText(input.message, '继续消息', 16000) : '继续。用户已核对异常，请从上次停止处接续原任务，保留已有成果与权限边界。', 'manual', `manual:${uid()}`);
        }
      } else if (action === 'policy') {
        task.policy = validatePolicy(input.policy || {}, task.policy);
        this.record(task, 'policy_updated', '任务恢复策略已更新');
      } else throw new AppError('未知任务操作');
      return this.getTask(id);
    });
  }

  checkpoint(id, text) {
    const task = this.getTask(id);
    const checkpoint = { taskId: id, text: redact(boundedText(text, '检查点', 8000), 8000), createdAt: this.now() };
    this.store.saveRecord('checkpoints', checkpoint, id);
    this.record(task, 'checkpoint_saved', '项目检查点已保存');
    return checkpoint;
  }
  acknowledge(id) {
    const alert = this.store.records('alerts').find(item => item.id === id);
    assert(alert, '告警不存在', 404);
    alert.acknowledgedAt = this.now();
    this.store.saveRecord('alerts', alert, alert.taskId);
    this.emit('change', { taskId: alert.taskId, type: 'alert_acknowledged' });
    return alert;
  }
  setDefaults(policy) {
    this.defaultPolicy = validatePolicy(policy, this.defaultPolicy);
    this.store.setMeta('defaultPolicy', this.defaultPolicy);
    return this.defaultPolicy;
  }
  snapshot() {
    const tasks = this.store.tasks().map(task => {
      const { recentHashes, buffers, ...outputMonitor } = task.outputMonitor;
      return { ...task, outputMonitor };
    });
    return { version: VERSION, mode: this.adapter.mode, connection: this.adapter.state, defaultCwd: process.cwd(),
      defaultPolicy: this.defaultPolicy, dnd: this.dndSnapshot(), tasks, alerts: this.store.records('alerts'),
      approvals: this.store.records('approvals').filter(a => a.status === 'pending'), now: this.now(), faulted: this.faulted };
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const controller of this.nativeOperations.values()) controller.abort();
    await Promise.allSettled([...this.queues.values()]);
    this.closed = true;
    for (const task of this.store.tasks().filter(item => item.controlMode !== 'observe' && BUSY.has(item.status))) {
      task.transportLost = true;
      this.store.saveTask(task);
    }
    await this.adapter.close();
  }
}
