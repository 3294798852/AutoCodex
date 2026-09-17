import { uid, redact } from './util.mjs';
import { newIncident } from './policy.mjs';
import { newOutputMonitor, observeToolOutput } from './progress.mjs';

const ended = new Set(['completed', 'interrupted', 'shutdown', 'notFound']);

// Persist membership, not ownership: never load, stop or unsubscribe a Codex task.
export class TaskFamily {
  constructor(supervisor) { this.s = supervisor; }
  ancestors(task) {
    const result = [], seen = new Set([task.id]);
    while (task.parentTaskId && result.length < 32) {
      task = this.s.store.task(task.parentTaskId);
      if (!task || seen.has(task.id)) break;
      seen.add(task.id); result.push(task);
    }
    return result;
  }
  enabled(task) {
    if (!task.observation?.enabled) return false;
    let child = task;
    for (const parent of this.ancestors(task)) {
      if (child.parentThreadId !== parent.threadId || !(parent.observation?.enabled || parent.parentTaskId && parent.releasedAt && !parent.monitorExcluded)) return false;
      child = parent;
    }
    return true;
  }
  descendants(id) { return this.s.store.tasks().filter(t => this.ancestors(t).some(p => p.id === id)); }
  inherit(task) {
    const parent = task.parentTaskId && this.ancestors(task).at(-1);
    if (!parent) return;
    task.policy = { ...parent.policy, strategy: 'manual' }; // A replacement would detach from the parent agent's wait target.
    task.assist ||= { revision: 0, phase: 'idle', connected: false };
    task.assist.autoContinue = !!parent.assist?.autoContinue;
    task.assist.autoApprove = !!parent.assist?.autoApprove;
    task.assist.enabledAt = parent.assist?.enabledAt || this.s.now();
  }
  async synchronize(client, events = []) {
    for (const selected of this.s.store.tasks().filter(t => t.parentTaskId && t.observation.enabled && !this.enabled(t))) {
      await this.s.exclusive(selected.id, () => {
        const task = this.s.getTask(selected.id);
        if (task.observation.enabled && !this.enabled(task)) this.release(task, '父任务的监测范围已变更');
      });
    }
    // Iterate to a fixed point so grandchildren can precede parents in the wire snapshot.
    for (let depth = 0; depth < 32; depth++) {
      let added = false;
      for (const state of client.threads) {
        if (!state.parentThreadId || state.parentThreadId === state.id) continue;
        const tasks = this.s.store.tasks(), parent = tasks.find(t => t.threadId === state.parentThreadId && t.controlMode === 'observe');
        const parentCovered = parent && this.enabled(parent.observation.enabled ? parent : { ...parent, observation: { ...parent.observation, enabled: !!parent.releasedAt && !parent.monitorExcluded } });
        if (!parentCovered || parent.assist?.relayId && parent.assist.relayId !== client.id) continue;
        const active = state.loaded && (state.active || ['running', 'pendingInit', 'errored'].includes(state.agentStatus));
        const justRan = events.some(e => e.threadId === state.id && ['started', 'output', 'tool'].includes(e.type) && e.at >= (parent.assist?.enabledAt || parent.observation.attachedAt));
        if ((!active || ended.has(state.agentStatus)) && !justRan) continue;
        const existing = tasks.find(t => t.threadId === state.id);
        if (existing) {
          if (!existing.parentTaskId || existing.monitorExcluded) continue;
          await this.s.exclusive(existing.id, () => {
            const child = this.s.getTask(existing.id);
            if (child.monitorExcluded || !this.enabled({ ...child, observation: { ...child.observation, enabled: true } })) return;
            if (!child.observation.enabled && (child.releasedTurnId !== state.turnId || !ended.has(state.agentStatus))) {
              child.observation.enabled = true; child.status = 'observing'; child.releasedAt = null;
              child.assist.sessionActive = false; child.assist.lastTerminalKey = null;
              this.s.record(child, 'subagent_resumed', '子代理再次运行，已恢复监测');
            }
            this.inherit(child); this.s.store.saveTask(child);
          });
          continue;
        }
        if (tasks.filter(t => t.parentTaskId && t.observation?.enabled).length >= 100) {
          if (!this.s.store.records('alerts', parent.id).some(a => a.code === 'subagent_limit' && !a.resolvedAt))
            this.s.alert(parent, 'subagent_limit', '活跃子代理超过 100 个，超出部分暂停自动辅助', { preserveStatus: true });
          return;
        }
        const now = this.s.now();
        const task = { id: uid(), name: redact(state.agentNickname || state.name || '子代理', 120), prompt: '跟随父任务监测活跃子代理',
          cwd: state.cwd || parent.cwd, model: state.model, modelProvider: state.modelProvider, sandbox: state.sandbox || parent.sandbox,
          mode: parent.mode, controlMode: 'observe', status: 'observing', paused: false, stopRequested: false,
          parentTaskId: parent.id, parentThreadId: parent.threadId, rootTaskId: parent.rootTaskId || parent.id,
          threadId: state.id, threadChain: [{ id: state.id, createdAt: now, reason: 'subagent' }], turnId: null,
          incident: newIncident(), totalAutoAttempts: 0, lastError: null, lastOutput: '', lastActivityAt: null,
          outputMonitor: newOutputMonitor(now), createdAt: now, updatedAt: now,
          observation: { enabled: true, phase: 'unknown', evidence: null, path: state.path, cursor: null, attachedAt: now, checkedAt: now },
          assist: { revision: 0, phase: 'idle', connected: false, relayId: client.id } };
        this.inherit(task); this.s.record(task, 'subagent_added', `自动加入子代理监测，继承父任务“${parent.name}”的开关`); added = true;
      }
      if (!added) break;
    }
    if (this.s.store.tasks().filter(t => t.parentTaskId && t.observation?.enabled).length < 100) {
      for (const task of this.s.store.tasks().filter(t => !t.parentTaskId)) this.s.resolveAlerts(task, ['subagent_limit'], '活跃子代理数量已恢复到支持范围');
    }
  }
  release(task, reason, { excluded = false } = {}) {
    if (!task.parentTaskId) return;
    task.observation.enabled = false; task.status = 'stopped'; task.releasedAt = this.s.now(); task.releasedTurnId = task.assist?.turnId;
    task.monitorExcluded ||= excluded;
    this.s.desktop.cancel(task, reason); task.assist.connected = false; task.assist.sessionActive = false;
    task.outputMonitor.buffers = []; task.outputMonitor.recentHashes = [];
    task.lastOutput = (task.lastOutput || '').slice(-1200);
    this.s.existing.due.delete(task.id); this.s.existing.published.delete(task.id);
    this.s.record(task, 'subagent_released', reason);
  }
  async releaseEnded(client) {
    for (const selected of this.s.store.tasks().filter(t => t.parentTaskId && t.observation.enabled && t.assist?.relayId === client.id)) {
      const state = client.threads.find(t => t.id === selected.threadId);
      if (!state && !['closed', ...ended].includes(selected.assist.phase) || state?.loaded && !ended.has(state.agentStatus)) continue;
      await this.s.exclusive(selected.id, () => {
        const task = this.s.getTask(selected.id);
        if (task.observation.enabled) this.release(task, '子代理已结束，已释放监测；再次运行时自动加入');
      });
    }
  }
  async progress(task, at) {
    for (const selected of this.ancestors(task)) {
      await this.s.exclusive(selected.id, () => {
        const parent = this.s.getTask(selected.id);
        if (!this.enabled(parent) || !this.enabled(task)) return;
        if (!observeToolOutput(parent, { id: `child:${task.threadId}:${task.turnId}:${task.outputMonitor.sequence}`, type: 'dynamicToolCall', status: 'completed' }, at)) return;
        parent.familyProgress = { at, threadId: task.threadId, name: task.name };
        this.s.desktop.recovered(parent, 'progress', at);
        this.s.record(parent, 'subagent_progress', `子代理“${task.name}”有新进展`);
      });
    }
  }
  async stopDescendants(id) {
    for (const selected of this.descendants(id)) await this.s.exclusive(selected.id, () => {
      const child = this.s.getTask(selected.id);
      if (child.observation.enabled) this.release(child, '父任务已移除监测');
    });
  }
}
