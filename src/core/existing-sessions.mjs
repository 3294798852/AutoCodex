import { readRollout } from '../adapters/rollout-reader.mjs';
import { uid, assert, boundedText, redact } from './util.mjs';
import { newIncident } from './policy.mjs';
import { newOutputMonitor } from './progress.mjs';
import { classifyError } from './classify.mjs';
import { ownershipError } from './ownership.mjs';

export const OBSERVATION_FRESH_MS = 30000;
const idText = value => {
  const id = boundedText(value, '会话 ID', 180);
  assert(/^[a-zA-Z0-9_-]+$/.test(id), '会话 ID 格式不正确'); return id;
};
const textContent = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(c => ['Text', 'text', 'output_text'].includes(c?.type)).map(c => c.text || '').join('\n') : '';

// Convert supported persisted events to observation evidence; never execute their contents.
export function observationEvidence(record) {
  const p = record?.payload;
  const at = Date.parse(record?.timestamp);
  if (!p || !Number.isFinite(at)) return null;
  const base = { at, turnId: p.turn_id || p.turnId || null };
  if (record.type === 'token_usage_record') return { ...base, kind: 'activity' };
  if (record.type === 'response_item') {
    if (p.type === 'message' && p.role === 'assistant' && p.channel !== 'analysis') {
      const text = textContent(p.content);
      if (text) return { ...base, kind: 'output', text };
    }
    return null;
  }
  if (record.type !== 'event_msg') return null;
  if (['task_started', 'turn_started'].includes(p.type)) return { ...base, kind: 'started' };
  if (['task_complete', 'task_completed'].includes(p.type)) return { ...base, kind: p.error ? 'failed' : 'completed', text: p.last_agent_message,
    ...(p.error ? { error: { message: p.error.message || 'Codex 回合异常结束', codexErrorInfo: p.error.codex_error_info || p.error.codexErrorInfo } } : {}) };
  if (p.type === 'turn_aborted') return { ...base, kind: 'interrupted' };
  if (['error', 'stream_error'].includes(p.type)) return { ...base, kind: 'error', error: { message: p.message || p.error?.message || 'Codex 记录了异常', codexErrorInfo: p.codex_error_info || p.codexErrorInfo } };
  if (['exec_approval_request', 'apply_patch_approval_request', 'request_user_input'].includes(p.type)) return { ...base, kind: 'waiting_user' };
  if (p.type === 'agent_message') return { ...base, kind: 'output', text: p.message || '' };
  if (p.type === 'exec_command_end') return { ...base, kind: 'tool', failed: Number.isInteger(p.exit_code) && p.exit_code !== 0, title: '命令执行' };
  if (['item_completed', 'item_started'].includes(p.type) && p.item) {
    const item = p.item, type = String(item.type || '').toLowerCase();
    if (type === 'agentmessage') return { ...base, kind: 'output', text: textContent(item.content) || item.text || '' };
    if (['commandexecution', 'filechange', 'mcptoolcall', 'dynamictoolcall'].includes(type)) return { ...base, kind: 'tool', failed: item.status === 'failed' || Number.isInteger(item.exit_code) && item.exit_code !== 0,
      title: type === 'commandexecution' ? '命令执行' : type === 'filechange' ? '文件修改' : '工具调用' };
    return { ...base, kind: 'activity' }; // Reasoning content is deliberately never copied.
  }
  if (['token_count', 'agent_reasoning', 'exec_command_begin'].includes(p.type)) return { ...base, kind: 'activity' };
  return null;
}

export class ExistingSessions {
  constructor(supervisor) { this.s = supervisor; this.pending = new Set(); this.due = new Map(); this.published = new Map(); }
  async list(input = {}) {
    assert(this.s.adapter.listThreads, '当前运行模式不提供本机会话列表', 405);
    const searchTerm = boundedText(input.searchTerm, '搜索文字', 200, { optional: true });
    const cursor = boundedText(input.cursor, '分页位置', 4000, { optional: true });
    const page = await this.s.adapter.listThreads({ searchTerm, cursor, archived: input.archived === true });
    const tasks = this.s.store.tasks();
    return { data: page.data.map(t => ({ id: t.id, name: redact(t.name || t.preview || '未命名会话', 180),
      cwd: t.cwd || '', updatedAt: t.updatedAt * 1000, model: t.model || null, modelProvider: t.modelProvider || null,
      source: typeof t.source === 'string' ? t.source : 'appServer',
      taskId: tasks.find(task => task.threadId === t.id)?.id || null })), nextCursor: page.nextCursor || null };
  }
  countCheck() { assert(this.s.store.tasks().filter(t => !['completed', 'stopped', 'failed'].includes(t.status)).length < 20, '本机最多同时监护 20 个任务', 409); }
  async add(input) {
    const threadId = idText(input.threadId);
    return this.s.exclusive('observation:add', async () => {
      const existing = this.s.store.tasks().find(t => t.threadId === threadId || t.adoptThreadId === threadId);
      if (existing) return existing;
      this.countCheck();
      assert(this.s.adapter.readThreadSummary, '当前运行模式不支持已有会话监测', 405);
      const thread = await this.s.adapter.readThreadSummary(threadId);
      const batch = await readRollout(thread.path, threadId);
      const concurrent = this.s.store.tasks().find(t => t.threadId === threadId || t.adoptThreadId === threadId);
      if (concurrent) return concurrent;
      this.countCheck();
      const now = this.s.now();
      const task = { id: uid(), name: redact(thread.name || thread.preview || '已有会话', 120), prompt: redact(thread.preview || '监测原会话的后续活动', 16000),
        cwd: thread.cwd || '', model: thread.model || null, modelProvider: thread.modelProvider || null, sandbox: 'workspace-write',
        policy: { ...this.s.defaultPolicy }, mode: this.s.adapter.mode, controlMode: 'observe',
        status: 'observing', paused: false, stopRequested: false, threadId, threadChain: [{ id: threadId, createdAt: now, reason: 'observed' }],
        turnId: null, pendingActionId: null, incident: newIncident(), totalAutoAttempts: 0, retryDueAt: null, retryPlan: null,
        lastError: null, lastActivityAt: null, lastOutput: '', outputMonitor: newOutputMonitor(now), createdAt: now, updatedAt: now,
        observation: { enabled: true, phase: 'unknown', evidence: null, path: thread.path, cursor: null, checkedAt: now,
          lastRecordAt: null, attachedAt: now, staleAlerted: false, readError: null, coverage: null } };
      this.s.store.transaction(() => { this.apply(task, batch, true); this.s.record(task, 'observation_added', '已加入原会话监测；后续在原客户端继续工作也会更新'); });
      return this.s.getTask(task.id);
    });
  }
  apply(task, batch, baseline = false) {
    const o = task.observation, now = this.s.now();
    if (batch.reset) { o.evidence = null; o.lastRecordAt = null; o.lastActivityAt = null; o.staleAlerted = false; task.turnId = null; task.lastOutput = ''; task.lastError = null; }
    if (batch.truncated || batch.dropped) o.coverage = '仅显示可识别的近期记录；较早记录或不完整、超大记录可能未包含。';
    if (batch.reset && !baseline && o.cursor) this.s.record(task, 'observation_reset', '记录文件已变化，重新建立近期观察基线');
    let changed = batch.reset || o.readError || batch.dropped;
    o.readError = null;
    for (const { record, key } of batch.records) {
      const evidence = observationEvidence(record);
      if (!evidence) continue;
      // Ignore timestamps far in the future and late events from a previous turn.
      if (evidence.at > now + 5000 || evidence.at < (o.lastRecordAt || 0)) continue;
      if (evidence.kind !== 'started' && evidence.turnId && task.turnId && evidence.turnId !== task.turnId) continue;
      if (!task.turnId && evidence.turnId) task.turnId = evidence.turnId;
      o.lastRecordAt = evidence.at; changed = true;
      const terminal = ['completed', 'interrupted', 'failed'].includes(o.evidence);
      if (evidence.kind === 'started') { task.turnId = evidence.turnId; o.staleAlerted = false; task.lastError = null; }
      if (['started', 'completed', 'interrupted', 'failed', 'error', 'waiting_user'].includes(evidence.kind)) o.evidence = evidence.kind;
      else if (!terminal && o.evidence !== 'waiting_user' || evidence.kind === 'output' || evidence.kind === 'tool') {
        if (!terminal) o.evidence = 'activity';
      }
      if (!terminal || evidence.kind === 'started') { o.lastActivityAt = evidence.at; task.lastActivityAt = evidence.at; }
      if (evidence.text) task.lastOutput = redact(evidence.text, 12000);
      if (evidence.error) task.lastError = classifyError(evidence.error);
      if (baseline || batch.reset || evidence.kind === 'activity') continue;
      if (!this.s.store.receipt(`observation:${task.id}:${key}`, now)) continue;
      const messages = { started: '原会话开始新回合', completed: '原会话已明确完成本回合', interrupted: '原会话记录了中断', waiting_user: '原会话正在等待用户处理', output: '原会话输出已更新' };
      if (evidence.error && task.assist?.connected && task.assist.autoContinue) this.s.record(task, 'observed_error', `原会话记录异常：${redact(evidence.error.message, 300)}`, { level: 'warning' });
      else if (evidence.error) this.s.alert(task, 'observed_error', `原会话记录异常：${redact(evidence.error.message, 300)}；请在原客户端核对`, { preserveStatus: true });
      else if (evidence.kind === 'tool' && evidence.failed) this.s.record(task, 'observed_tool_failure', `${evidence.title}失败；继续观察会话后续处理`, { level: 'warning' });
      else if (messages[evidence.kind]) this.s.record(task, `observed_${evidence.kind}`, messages[evidence.kind], { now: evidence.at });
    }
    o.cursor = batch.cursor; o.checkedAt = now; o.pendingBytes = batch.pendingBytes;
    const phase = o.evidence === 'failed' ? 'error' : ['completed', 'interrupted', 'error', 'waiting_user'].includes(o.evidence) ? o.evidence
      : o.lastActivityAt && now - o.lastActivityAt <= OBSERVATION_FRESH_MS ? 'active_recent' : 'unknown';
    changed ||= phase !== o.phase; o.phase = phase;
    if (!baseline && !o.staleAlerted && (phase === 'unknown' || o.evidence === 'error')
      && now - Math.max(o.attachedAt, o.lastActivityAt || 0) >= task.policy.noOutputTimeoutMs) {
      o.staleAlerted = true;
      this.s.alert(task, 'observation_stale', '原会话较长时间没有新活动记录，运行状态待确认，请到原客户端核对', { preserveStatus: true, severity: 'warning' });
    }
    this.s.store.saveTask(task);
    if (changed || now - (this.published.get(task.id) || 0) >= 5000) {
      this.published.set(task.id, now); this.s.emit('change', { taskId: task.id, type: 'observation_updated' });
    }
  }
  async poll(id) {
    const task = this.s.getTask(id), o = task.observation;
    if (task.controlMode !== 'observe' || !o.enabled) return;
    try {
      if (o.readError && this.s.now() >= (o.metadataRetryAt || 0)) {
        o.metadataRetryAt = this.s.now() + 30000;
        const summary = await this.s.adapter.readThreadSummary(task.threadId);
        o.path = summary.path;
      }
      const batch = await readRollout(o.path, task.threadId, o.cursor);
      this.s.store.transaction(() => this.apply(task, batch));
    } catch (error) {
      if (/SQLITE/.test(String(error.code || ''))) throw error;
      const first = !o.readError;
      o.phase = 'unavailable'; o.readError = redact(error.message, 500); o.checkedAt = this.s.now();
      if (first) this.s.alert(task, 'observation_unavailable', '原会话记录暂时无法读取；监测会自动重试', { preserveStatus: true, severity: 'warning' });
      else this.s.store.saveTask(task);
    }
  }
  tick() {
    for (const task of this.s.store.tasks()) {
      if (task.controlMode !== 'observe' || !task.observation.enabled || this.pending.has(task.id) || this.s.now() < (this.due.get(task.id) || 0)) continue;
      this.due.set(task.id, this.s.now() + 1000); this.pending.add(task.id);
      this.s.exclusive(task.id, () => this.poll(task.id)).catch(error => this.s.fault(error)).finally(() => this.pending.delete(task.id));
    }
  }
  async control(task, action, input) {
    const o = task.observation;
    if (action === 'observe_stop' || action === 'observe_start') {
      if (action === 'observe_start' && !o.enabled) this.countCheck();
      o.enabled = action === 'observe_start'; task.status = o.enabled ? 'observing' : 'stopped';
      if (!o.enabled) this.s.desktop.cancel(task, '用户停止监测');
      this.s.record(task, action, o.enabled ? '已恢复原会话监测' : '已停止监测；原会话继续由原客户端管理');
      if (o.enabled) await this.poll(task.id);
    } else if (action === 'observe_refresh') await this.poll(task.id);
    else if (action === 'adopt') {
      assert(input.ownershipConfirmed === true, '请先确认原客户端已释放会话连接；仅停止回复还不能移交', 409);
      if (!o.enabled) this.countCheck();
      const message = boundedText(input.message || '继续。从上次停止处接续原任务，先核对已有成果，避免重复执行。', '继续消息', 16000);
      const thread = await this.s.adapter.readThread(task.threadId);
      assert(thread.status?.type !== 'active' && !thread.turns?.some(t => t.status === 'inProgress'), '原会话仍在运行，请先在原客户端停止', 409);
      // Resume is the ownership handshake. Do not switch control mode or send until it succeeds.
      const candidate = { ...task, cwd: thread.cwd || task.cwd };
      this.s.rememberThreadSettings(candidate, thread);
      let resumed;
      try { resumed = await this.s.adapter.resumeThread(candidate); }
      catch (error) {
        const failure = ownershipError(error);
        if (failure.code === 'thread_in_use' && o.lastControlError?.code !== failure.code) {
          o.lastControlError = { code: failure.code, message: failure.message, at: this.s.now() };
          this.s.record(task, 'adoption_blocked', failure.message, { level: 'warning' });
        }
        throw failure;
      }
      task.cwd = candidate.cwd;
      this.s.rememberThreadSettings(task, candidate);
      this.s.rememberThreadSettings(task, resumed);
      o.lastControlError = null;
      task.controlMode = 'managed'; o.enabled = false; task.recycleToolAvailable = false;
      task.incident = newIncident(); task.outputMonitor = newOutputMonitor(this.s.now());
      task.stopRequested = false; task.paused = false; task.turnId = null;
      this.s.record(task, 'thread_adopted', '原会话已移交本服务，将接续原任务并启用恢复规则');
      await this.s.sendTurn(task, message, 'manual', `adopt:${uid()}`);
    } else assert(false, '此任务正在观察原会话，请使用监测操作或先移交控制', 409);
    return this.s.getTask(task.id);
  }
}
