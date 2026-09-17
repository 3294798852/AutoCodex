import { randomUUID } from 'node:crypto';
import { assert, redact, safeData } from './util.mjs';
import { classifyError } from './classify.mjs';
import { decideFailure, newIncident } from './policy.mjs';
import { newOutputMonitor, observeAgentOutput, observeToolOutput, noOutputExpired, syncOutputSuspension } from './progress.mjs';
import { evaluateDnd } from './dnd-policy.mjs';
import { buildHandoff, persistHandoff, handoffPrompt } from './handoff.mjs';
import { prepareRecycle } from './recycle.mjs';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

export const DEFAULT_ASSIST = Object.freeze({ autoContinue: false, autoApprove: false, revision: 0 });
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,180}$/.test(id);
const liveMs = 3500;
const recoverableAlerts = ['observed_error', 'observation_stale', 'no_effective_output', 'repeated_error', 'retry_budget_exhausted',
  'replacement_failed_immediately', 'auth', 'permission', 'quota', 'context', 'conflict', 'bad_request', 'policy', 'unknown', 'handoff_failed'];
const uncertainCodes = new Set(['desktop_result_unknown', 'desktop_approval_unknown', 'desktop_recycle_unknown', 'approval_uncertain',
  'desktop_events_lost', 'desktop_ambiguous', 'desktop_connection_changed']);

export class DesktopMonitor {
  constructor(supervisor) {
    this.s = supervisor; this.clients = new Map();
    for (const task of this.s.store.tasks().filter(t => t.assist)) {
      task.assist.connected = false;
      const action = this.s.store.action(task.assist.actionId || null);
      if (task.approvalBlocked || action && ['sending', 'sent', 'uncertain'].includes(action.state)) this.block(task, 'desktop_result_unknown', '服务重启，先在原 Codex 核对上次自动动作结果');
      else if (task.assist.blocked) {
        const alert = this.s.store.records('alerts', task.id).find(a => !a.resolvedAt);
        task.assist.blockCode ||= alert?.code || 'desktop_result_unknown'; task.assist.blockedAt ||= alert?.createdAt || this.s.now();
        this.s.store.saveTask(task);
      }
      else { this.cancel(task, '服务已重启'); this.s.store.saveTask(task); }
    }
  }
  snapshot() {
    return { supported: process.platform === 'win32', connectedClients: [...this.clients.values()].filter(c => this.s.now() - c.at < liveMs).length,
      transport: 'stdio-relay', available: [...this.clients.values()].some(c => this.s.now() - c.at < liveMs),
      connections: [...this.clients.values()].map(c => ({ id: c.id, pid: c.pid, workerPid: c.workerPid, connected: this.s.now() - c.at < liveMs,
        lastSeenAt: c.at, threads: c.threads.filter(t => t.loaded).length,
        tasks: c.threads.map(({ id, name, cwd, parentThreadId, agentStatus, active, loaded }) => ({ id, name, cwd, parentThreadId, agentStatus, active, loaded })) })) };
  }
  async configure(id, input) {
    return this.s.exclusive(id, () => {
      const task = this.s.getTask(id);
      assert(task.controlMode === 'observe', '原桌面辅助仅用于已有会话监测', 409);
      assert(!task.parentTaskId || input.reset && Object.keys(input).every(k => ['reset', 'revision'].includes(k)), '子代理开关跟随父任务，请在父任务设置', 409);
      assert(input && Object.keys(input).every(k => ['autoContinue', 'autoApprove', 'revision', 'reset'].includes(k)), '未知桌面辅助设置');
      const a = task.assist || { ...DEFAULT_ASSIST, phase: 'offline', connected: false };
      assert(input.revision === a.revision, '辅助设置已被其他页面修改，请刷新', 409);
      for (const k of ['autoContinue', 'autoApprove', 'reset']) if (k in input) assert(typeof input[k] === 'boolean', '开关值无效');
      const enabling = input.autoContinue === true && !a.autoContinue;
      if (input.reset) {
        const pending = this.s.store.action(a.actionId || null);
        if (pending && ['sending', 'sent', 'uncertain'].includes(pending.state)) { pending.state = 'reviewed'; this.s.store.saveAction(pending); }
        task.approvalBlocked = false; a.blocked = false; a.reason = null; a.actionId = null;
        this.s.resolveAlerts(task, this.s.store.records('alerts', task.id).map(v => v.code), '用户已核对并恢复自动辅助');
        a.blockCode = null;
        for (const item of this.s.store.records('approvals', task.id)) {
          if (!/^[a-f0-9]{64}$/.test(item.recycleJournalKey || '')) continue;
          const path = join(this.s.store.directory, 'desktop-recycle-journal', item.recycleJournalKey + '.json');
          if (!existsSync(path)) continue;
          const journal = JSON.parse(readFileSync(path, 'utf8'));
          if (journal.id !== item.recycleOperationId) continue;
          if (['executing', 'uncertain'].includes(journal.state)) {
            if (existsSync(path + '.lock')) {
              const lock = JSON.parse(readFileSync(path + '.lock', 'utf8'));
              let alive = true;
              try { process.kill(lock.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
              assert(!alive, '回收工具仍在运行，请等待操作结束后核对', 409);
            }
            writeFileSync(path, JSON.stringify({ ...journal, state: 'reviewed', reviewedAt: this.s.now() }), { flush: true });
            if (existsSync(path + '.lock')) unlinkSync(path + '.lock');
          }
        }
      }
      if ((enabling && !a.blocked) || input.reset) { task.incident = newIncident(); task.outputMonitor = newOutputMonitor(this.s.now()); }
      task.assist = { ...a, ...(input.autoContinue === undefined ? {} : { autoContinue: input.autoContinue }),
        ...(input.autoApprove === undefined ? {} : { autoApprove: input.autoApprove }), revision: a.revision + 1, enabledAt: this.s.now() };
      if (input.autoContinue === false || input.reset) this.cancel(task, '用户调整辅助设置');
      this.s.record(task, 'desktop_settings', '已保存原 Codex 自动辅助设置');
      return task;
    });
  }
  cancel(task, reason) {
    const a = task.assist; if (!a) return;
    const action = this.s.store.action(a.actionId || null);
    if (action?.state === 'planned') {
      action.state = 'cancelled'; action.reason = reason; this.s.store.saveAction(action);
      if (a.phase === 'retry_wait') a.phase = 'idle';
    }
    if (!action || !['sending', 'sent'].includes(action.state)) a.actionId = null;
    a.dueAt = null;
  }
  block(task, code, reason) {
    const a = task.assist;
    if (a.blocked && a.reason === reason) return;
    this.cancel(task, reason); a.blocked = true; a.reason = reason; a.phase = 'attention'; a.blockCode = code; a.blockedAt = this.s.now();
    this.s.alert(task, code, reason, { preserveStatus: true });
  }
  recovered(task, evidence, at = this.s.now()) {
    const a = task.assist;
    const codes = evidence === 'progress' ? ['no_effective_output', 'observation_stale'] : recoverableAlerts;
    if (a?.blocked && !uncertainCodes.has(a.blockCode) && !task.approvalBlocked && codes.includes(a.blockCode)
      && at >= (a.blockedAt || 0)) {
      a.blocked = false; a.blockCode = null; a.reason = null;
      a.phase = a.waiting ? 'waiting_user' : a.active ? 'running' : 'idle';
      task.outputMonitor.blocked = false;
    }
    this.s.resolveAlerts(task, codes, evidence === 'progress' ? '已检测到任务树的新进展' : '已确认用户在原 Codex 中处理并继续', at);
  }
  async poll(input) {
    assert(validId(input.relayId) && Array.isArray(input.threads) && input.threads.length <= 200 && Array.isArray(input.events) && input.events.length <= 1000, '辅助连接数据无效');
    for (const t of input.threads) assert(validId(t.id) && Number.isSafeInteger(t.generation) && t.generation >= 0, '辅助任务身份无效');
    const now = this.s.now(), prior = this.clients.get(input.relayId);
    assert(prior || this.clients.size < 20, '桌面辅助连接过多', 429);
    const client = { id: input.relayId, at: now, pid: input.pid, workerPid: input.workerPid, threads: input.threads, overflow: input.overflow === true, lastSeq: prior?.lastSeq || 0 };
    this.clients.set(client.id, client);
    const events = input.events.filter(e => Number.isSafeInteger(e.seq) && e.seq > client.lastSeq);
    const actions = [], watched = [];
    await this.s.family.synchronize(client, events);
    for (const selected of this.s.store.tasks().filter(t => t.controlMode === 'observe' && t.observation.enabled)) {
      const state = client.threads.find(t => t.id === selected.threadId && t.loaded);
      if (!state && !(selected.parentTaskId && selected.assist?.relayId === client.id && events.some(e => e.threadId === selected.threadId))) continue;
      const a = selected.assist;
      let progressed;
      watched.push({ threadId: selected.threadId, autoContinue: !!a?.autoContinue, autoApprove: !!a?.autoApprove });
      await this.s.exclusive(selected.id, async () => {
        const task = this.s.getTask(selected.id);
        const beforeSequence = task.outputMonitor.sequence;
        if (!this.s.family.enabled(task)) return;
        this.s.family.inherit(task);
        if (!task.assist) task.assist = { ...DEFAULT_ASSIST, phase: 'idle', connected: false };
        const a = task.assist, changed = !a.connected || a.relayId !== client.id;
        const owners = [...this.clients.values()].filter(c => now - c.at < liveMs && c.threads.some(t => t.id === task.threadId && t.loaded));
        if (owners.length > 1) { this.block(task, 'desktop_ambiguous', '多个桌面连接报告同一任务，自动辅助已暂停'); return; }
        if (a.relayId && a.relayId !== client.id) this.block(task, 'desktop_connection_changed', '原桌面连接已变化，请核对后恢复辅助');
        a.relayId = client.id; a.connected = true; a.lastSeenAt = now;
        this.s.resolveAlerts(task, ['desktop_offline'], '原 Codex 连接已恢复');
        if (client.overflow) this.block(task, 'desktop_events_lost', '桌面事件积压，自动辅助已暂停，请核对');
        for (const event of events) {
          if (event.threadId === task.threadId || event.type === 'action_result' && this.s.store.action(event.actionId || null)?.taskId === task.id) await this.consume(task, event);
        }
        if (state?.turnId && (!a.turnId || state.active && state.turnId !== a.turnId)) {
          if (a.turnId && state.generation > (a.generation || 0)) this.recovered(task, 'user');
          this.cancel(task, '已同步原 Codex 的当前回合');
          a.turnId = state.turnId; a.active = state.active; a.generation = state.generation; task.turnId = state.turnId;
          if (state.active && !a.blocked) { a.sessionActive = true; a.phase = 'running'; task.turnStartedAt = now; }
        }
        const action = this.s.store.action(a.actionId || null);
        if (action && ['sending', 'sent'].includes(action.state) && now - action.sentAt > 25000) this.block(task, 'desktop_result_unknown', '原窗口续发结果未确认，请人工核对');
        if (action?.state === 'planned' && now >= action.dueAt && !a.blocked && a.autoContinue) {
          const latestState = client.threads.find(t => t.id === task.threadId);
          if (!latestState?.loaded || latestState.active || latestState.waiting || latestState.pendingUser || latestState.generation !== action.generation || latestState.failedTurnId !== action.failedTurnId
            || action.kind === 'replace' && task.policy.strategy !== 'new_session') {
            this.cancel(task, '原任务已有新活动');
          } else {
            action.ancestors = this.s.family.ancestors(task).map(p => ({ threadId: p.threadId, generation: p.assist?.generation }));
            action.state = 'sending'; action.sentAt = now;
            if (action.kind === 'continue') { task.incident.autoAttempts++; task.incident.attemptsWithoutOutput++; task.totalAutoAttempts++; }
            this.s.store.saveAction(action); a.phase = 'sending';
            actions.push(action);
          }
        }
        this.s.store.saveTask(task);
        if (task.outputMonitor.sequence > beforeSequence) progressed = task;
        if (changed) this.s.record(task, 'desktop_connected', '已接入原 Codex 通信通道');
        else if (events.length) this.s.emit('change', { taskId: task.id, type: 'desktop_activity' });
      });
      if (progressed) await this.s.family.progress(progressed, progressed.outputMonitor.lastEffectiveAt);
    }
    await this.s.family.releaseEnded(client);
    for (const selected of this.s.store.tasks().filter(t => t.assist?.relayId === client.id && this.s.family.enabled(t))) {
      await this.s.exclusive(selected.id, () => {
        const task = this.s.getTask(selected.id), a = task.assist;
        task.familyWaiting = this.s.family.descendants(task.id).some(t => this.s.family.enabled(t) && t.assist?.waiting > 0);
        syncOutputSuspension(task, now);
        if (this.s.family.enabled(task) && a.sessionActive && a.autoContinue && !a.blocked && a.phase !== 'waiting_user' && noOutputExpired(task, now)) {
          task.outputMonitor.blocked = true; this.block(task, 'no_effective_output', '任务及活跃子代理持续没有有效输出，自动续发已停止，请核对');
        }
        this.s.store.saveTask(task);
      });
    }
    if (events.length) client.lastSeq = Math.max(...events.map(e => e.seq), client.lastSeq);
    return { watched: this.s.store.tasks().filter(t => t.controlMode === 'observe' && this.s.family.enabled(t) && t.assist?.relayId === client.id)
      .map(t => ({ threadId: t.threadId, autoContinue: !!t.assist.autoContinue && !t.assist.blocked, autoApprove: !!t.assist.autoApprove && !t.assist.blocked })),
      excluded: this.s.store.tasks().filter(t => t.controlMode === 'observe' && t.assist?.relayId === client.id && (!t.observation.enabled && (!t.parentTaskId || t.monitorExcluded)))
        .map(t => t.threadId), actions };
  }
  async consume(task, event) {
    const a = task.assist, now = this.s.now();
    if (!this.s.store.receipt(`desktop:${a.relayId}:${event.seq}`, now)) return;
    if (event.type === 'loaded') return;
    if (event.type === 'recycle_result') {
      const result = event.result;
      const item = this.s.store.records('approvals', task.id).find(v => v.recycleOperationId === result?.id);
      if (item) { item.nativeResult = safeData(result); this.s.store.saveRecord('approvals', item, task.id); }
      if (result?.state === 'uncertain') this.block(task, 'desktop_recycle_unknown', '回收操作结果不明，请核对文件和回收站后恢复辅助');
      else this.s.record(task, 'desktop_recycle_result', result?.success ? '所选文件已移入 Windows 回收站' : '回收操作未执行');
      return;
    }
    if (event.type === 'replacement_created') {
      const action = this.s.store.action(event.actionId || null);
      if (!action || action.kind !== 'replace' || action.taskId !== task.id || action.state !== 'sending' || !validId(event.thread?.id)) return;
      task.threadId = event.thread.id; task.turnId = null;
      task.threadChain.push({ id: task.threadId, createdAt: now, reason: 'desktop_fallback' });
      task.observation = { ...task.observation, path: event.thread.path, cursor: null, evidence: null, attachedAt: now, lastRecordAt: null, lastActivityAt: null, readError: null };
      task.incident.replacements++; task.incident.consecutiveSame = 0; task.incident.lastErrorCategory = null; task.incident.recentErrors = [];
      task.isFallbackFirstTurn = true; task.meaningfulProgress = false;
      a.turnId = null; a.generation = event.generation; a.active = false; a.phase = 'starting';
      this.s.record(task, 'desktop_replacement', '已在原 Codex 创建接续任务，保留旧任务和交接材料'); return;
    }
    if (event.type === 'action_result') {
      const action = this.s.store.action(event.actionId || null);
      if (!action || action.taskId !== task.id || action.relayId !== a.relayId) return;
      if (!['sending', 'sent', 'uncertain'].includes(action.state)) return;
      if (event.outcome === 'sent') {
        action.state = 'confirmed'; action.turnId = event.turnId;
        if (a.actionId === action.id) { a.actionId = null; a.dueAt = null; }
        this.s.record(task, 'desktop_continued', action.kind === 'replace' ? '已向原 Codex 中的新任务发送交接材料' : '已通过原 Codex 通道发送一次继续', { data: { actionId: action.id, turnId: event.turnId } });
      } else if (event.outcome === 'skipped') {
        if (action.kind === 'continue') {
          task.totalAutoAttempts = Math.max(0, task.totalAutoAttempts - 1);
          if (action.incidentId === task.incident.id) {
            task.incident.autoAttempts = Math.max(0, task.incident.autoAttempts - 1);
            task.incident.attemptsWithoutOutput = Math.max(0, task.incident.attemptsWithoutOutput - 1);
          }
        }
        action.state = 'cancelled';
        if (a.actionId === action.id) { a.actionId = null; a.dueAt = null; if (a.phase === 'sending') a.phase = 'idle'; }
        this.s.record(task, 'desktop_yielded', '已避让用户的新操作，取消本次续发');
      } else { action.state = 'uncertain'; this.block(task, 'desktop_result_unknown', '原窗口续发未确认成功，请人工核对'); }
      this.s.store.saveAction(action); return;
    }
    if (event.type === 'approval_result') {
      const item = this.s.store.records('approvals', task.id).find(v => v.desktopKey === event.key);
      if (item) { item.status = event.outcome === 'uncertain' ? 'uncertain' : 'answered'; item.source = event.outcome; item.answeredAt = now; this.s.store.saveRecord('approvals', item, task.id); }
      if (event.outcome === 'automatic') { task.totalAutoApprovals = (task.totalAutoApprovals || 0) + 1; this.s.record(task, 'desktop_approved', '已在原 Codex 中自动批准本次请求'); }
      if (event.outcome === 'uncertain') this.block(task, 'desktop_approval_unknown', '原窗口批准结果未确认，请人工核对');
      a.waiting = Math.max(0, (a.waiting || 0) - 1);
      if (a.phase === 'waiting_user' && !a.waiting) { a.phase = a.active ? 'running' : 'idle'; if (task.outputMonitor.suspendedAt !== null) { task.outputMonitor.sinceAt += now - task.outputMonitor.suspendedAt; task.outputMonitor.suspendedAt = null; } }
      if (event.outcome === 'manual' || event.outcome === 'resolved') this.recovered(task, 'approval', event.at);
      return;
    }
    if (event.type === 'approval_manual') {
      const item = this.s.store.records('approvals', task.id).find(v => v.desktopKey === event.key);
      if (item) { item.status = 'manual_desktop'; this.s.store.saveRecord('approvals', item, task.id); }
      return;
    }
    if (['user_change', 'user_stop', 'unloaded'].includes(event.type)) {
      a.generation = event.generation; this.cancel(task, '用户操作或会话卸载');
      if (event.type === 'user_stop') { this.recovered(task, 'user', event.at); a.phase = 'stopped'; a.userStopped = true; }
      if (event.type === 'unloaded') { a.phase = 'closed'; a.active = false; a.sessionActive = false; }
      if (event.type === 'user_change') { a.userStopped = false; a.userTurnPending = !event.method || ['turn/start', 'turn/steer'].includes(event.method); }
      return;
    }
    if (event.type === 'user_accepted') {
      a.userTurnPending = false; a.userStopped = false;
      task.incident = newIncident(); task.isFallbackFirstTurn = false;
      this.recovered(task, 'user', event.at);
      if (!a.blocked) task.outputMonitor = newOutputMonitor(now);
      return;
    }
    if (event.type === 'user_rejected') { a.userTurnPending = false; return; }
    if (event.type === 'started') {
      this.cancel(task, '原任务已开始新回合');
      a.turnId = event.turnId; a.generation = event.generation; a.active = true; a.phase = 'running'; task.turnId = event.turnId;
      task.turnStartedAt = now; task.meaningfulProgress = false;
      task.outputMonitor.buffers = [];
      if (a.userTurnPending) {
        this.recovered(task, 'user', event.at);
        task.incident = newIncident(); a.sessionActive = false; a.userTurnPending = false; task.isFallbackFirstTurn = false;
      }
      if (!a.sessionActive) { task.outputMonitor = newOutputMonitor(now); a.sessionActive = true; }
      return;
    }
    if (event.turnId && a.turnId && event.turnId !== a.turnId) return;
    if (event.type === 'agent_lifecycle' && ['completed', 'interrupted', 'shutdown', 'notFound'].includes(event.status)) {
      if (event.status === 'completed') this.recovered(task, 'completed', event.at);
      a.phase = event.status; a.active = false; a.sessionActive = false; this.cancel(task, '子代理已结束'); return;
    }
    if (event.type === 'status') {
      if (event.status?.type === 'active') {
        a.active = true;
        if (!a.blocked && !a.waiting) a.phase = event.status.activeFlags?.length ? 'waiting_user' : 'running';
      }
      return;
    }
    if (event.type === 'waiting') { a.waiting = (a.waiting || 0) + 1; a.phase = 'waiting_user'; task.outputMonitor.suspendedAt ??= now; return; }
    if (event.type === 'output') {
      if (a.active && observeAgentOutput(task, event.itemId, event.text, now, event.complete !== false)) {
        this.recovered(task, 'progress', event.at); task.lastActivityAt = now;
      }
      if (a.active && event.complete !== false) task.lastOutput = redact(event.text || '', 12000);
      return;
    }
    if (event.type === 'tool') { if (a.active && observeToolOutput(task, event.item, now)) this.recovered(task, 'progress', event.at); return; }
    if (event.type !== 'terminal') return;
    if (a.lastTerminalKey === `${task.threadId}:${event.turnId}`) return;
    a.lastTerminalKey = `${task.threadId}:${event.turnId}`;
    a.active = false; a.phase = event.status; a.generation = event.generation;
    if (event.status !== 'failed') {
      if (event.status === 'completed') this.recovered(task, 'completed', event.at);
      this.cancel(task, '原回合正常结束或被用户中断'); task.incident = newIncident(); a.sessionActive = false; a.waiting = 0; task.isFallbackFirstTurn = false; return;
    }
    if (!a.autoContinue || a.blocked || a.userStopped || event.at < a.enabledAt) return;
    const error = classifyError(event.error || {}); task.lastError = error;
    const decision = decideFailure(task, error, now, this.s.random); task.incident = decision.incident;
    if (!['continue', 'replace'].includes(decision.action)) {
      this.block(task, decision.code, decision.code === 'replacement_failed_immediately' ? '新任务首次运行立即失败，自动辅助已停止，请人工处理' : `原任务停止自动续发：${error.label || error.message}`); return;
    }
    const id = randomUUID(), action = { id, key: `desktop:${decision.action}:${task.threadId}:${event.turnId}`, taskId: task.id, kind: decision.action,
      state: 'planned', relayId: a.relayId, threadId: task.threadId, failedTurnId: event.turnId, generation: event.generation, incidentId: task.incident.id,
      dueAt: decision.dueAt || now + task.policy.baseDelayMs, createdAt: now, message: `继续。请从上次异常中断处接续原任务，核对已完成工作，避免重复执行。原有权限与用户约束继续有效。\n[AutoCodex:${id}]` };
    if (this.s.store.actions(task.id).some(v => v.key === action.key)) return;
    if (decision.action === 'replace') {
      let history, warning;
      try { history = await this.s.adapter.readThread(task.threadId); } catch (e) { warning = e.message; }
      try {
        const packet = buildHandoff(task, history, this.s.store.records('checkpoints', task.id)[0], this.s.origin, now, warning);
        packet.desktopUrl = `codex://threads/${task.threadId}`;
        packet.filePath = persistHandoff(this.s.store.directory, packet); this.s.store.saveRecord('handoffs', packet, task.id);
        action.message = `原 Codex 任务：${packet.desktopUrl}\n${handoffPrompt(packet)}\n[AutoCodex:${id}]`;
      } catch (e) { this.block(task, 'handoff_failed', `交接材料保存失败：${redact(e.message)}`); return; }
    }
    this.s.store.saveAction(action); a.actionId = id; a.dueAt = action.dueAt; a.phase = 'retry_wait';
    this.s.record(task, 'desktop_retry_scheduled', decision.action === 'replace' ? '原任务连续失败，已安排在原 Codex 中新建接续任务' : '原任务异常结束，已安排通过原 Codex 继续');
  }
  async approve(input) {
    assert(validId(input.relayId) && typeof input.key === 'string' && input.key.length < 400 && input.request?.method, '批准数据无效');
    let selected = this.s.store.tasks().find(t => t.threadId === input.threadId && t.controlMode === 'observe');
    const client = this.clients.get(input.relayId);
    if (!selected && client && this.s.now() - client.at < liveMs && input.state?.id === input.threadId && validId(input.state.parentThreadId)
      && validId(input.threadId) && Number.isSafeInteger(input.state.generation)) {
      // The first child permission request may beat the next 250ms poll.
      await this.s.family.synchronize({ ...client, threads: [...client.threads.filter(t => t.id !== input.threadId), input.state] });
      selected = this.s.store.tasks().find(t => t.threadId === input.threadId && t.parentTaskId);
    }
    if (!selected) return { automatic: false };
    return this.s.exclusive(selected.id, () => {
      const task = this.s.getTask(selected.id), a = task.assist, client = this.clients.get(input.relayId);
      this.s.family.inherit(task);
      if (!this.s.family.enabled(task) || !a?.autoApprove || a.blocked || a.relayId !== input.relayId || !client || this.s.now() - client.at >= liveMs) return { automatic: false };
      const state = input.state || client.threads.find(t => t.id === task.threadId);
      if (!state?.loaded || state.id !== task.threadId || state.generation !== input.generation || input.request.params?.threadId !== task.threadId
        || input.state && (!state.active || state.turnId !== input.request.params?.turnId)) return { automatic: false };
      if (this.s.store.records('approvals', task.id).some(v => v.desktopKey === input.key)) return { automatic: false };
      let decision;
      const context = { ...task, sandbox: state.sandbox || task.sandbox };
      if (input.request.params?.serverName === 'autocodex_recycle') {
        decision = { automatic: false, categories: [], reason: '回收请求需要核对' };
        if (input.recycle) {
          try {
            const prepared = prepareRecycle({ paths: input.recycle.paths }, context, this.s.dnd, this.s.store.directory);
            if (prepared.categories.every(k => this.s.dnd[k])) decision = { automatic: true, categories: prepared.categories,
              reason: '回收目标与开启的目录规则匹配', response: { action: 'accept', content: input.recycle.gate ? {} : { confirm: true } } };
          } catch (e) { decision.reason = e.message; }
        }
      } else decision = evaluateDnd({ request: input.request, item: input.item, task: context, settings: this.s.dnd });
      const item = { id: randomUUID(), taskId: task.id, desktopKey: input.key, method: input.request.method, status: decision.automatic ? 'sending' : 'manual_desktop',
        source: 'desktop', createdAt: this.s.now(), settingsRevision: this.s.dnd.revision, categories: decision.categories, automation: { automatic: decision.automatic, reason: decision.reason },
        preview: safeData({ command: input.request.params?.command, reason: redact(decision.reason, 300) }) };
      if (input.recycle) { item.recycleOperationId = input.recycle.id; item.recycleJournalKey = input.recycle.journalKey; item.preview.paths = input.recycle.paths; }
      this.s.store.saveRecord('approvals', item, task.id);
      this.s.record(task, 'desktop_approval_decision', decision.automatic ? '免打扰规则已匹配原客户端请求' : '原客户端权限请求保留人工决定');
      return decision;
    });
  }
  tick() {
    const now = this.s.now();
    for (const client of this.clients.values()) if (now - client.at > 60000) this.clients.delete(client.id);
    for (const task of this.s.store.tasks().filter(t => t.assist?.connected && now - t.assist.lastSeenAt >= liveMs)) {
      void this.s.exclusive(task.id, () => {
        const current = this.s.getTask(task.id); if (!current.assist.connected || now - current.assist.lastSeenAt < liveMs) return;
        current.assist.connected = false; current.assist.phase = 'offline'; this.cancel(current, '原桌面辅助连接离线');
        if (current.assist.autoContinue || current.assist.autoApprove) this.s.alert(current, 'desktop_offline', '原桌面辅助连接已断开，自动动作暂停；Codex 普通对话仍由原客户端处理', { preserveStatus: true, severity: 'warning' });
        else this.s.record(current, 'desktop_offline', '原桌面辅助连接已断开');
      }).catch(e => this.s.fault(e));
    }
  }
}
