import { EventEmitter } from 'node:events';
import { uid, clone } from '../core/util.mjs';

export const SCENARIOS = [
  { id: 'intermittent', name: '偶发断流后恢复', description: '首次断流，自动继续后完成' },
  { id: 'repeated', name: '连续同类错误', description: '首次错误及两次重试均断流，等待人工' },
  { id: 'capacity', name: '容量不足的五次豁免', description: '首次错误及四次重试后才报告容量不足' },
  { id: 'rate_limit', name: '临时限流的五次豁免', description: '临时限流按五次同类错误处理' },
  { id: 'no_output', name: '持续无输出保护', description: '回合保持运行，达到无输出时限后告警' },
  { id: 'failover', name: '新会话接续成功', description: '旧会话反复失败，新会话完成工作' },
  { id: 'fallback_fails', name: '新会话立即失败', description: '新会话首轮报错，最终停止并告警' },
  { id: 'alternating', name: '交替错误达到上限', description: '不同错误交替出现，验证总次数保护' },
  { id: 'dnd_approval', name: '免打扰自动批准', description: '演练常用命令批准：开关开启后自动完成' },
  { id: 'approval', name: '等待用户批准', description: '等待用户决定，不触发自动继续' },
  { id: 'healthy', name: '正常执行', description: '显示持续输出和正常完成' },
  { id: 'interrupted', name: '用户中断保护', description: '中断后停止自动恢复' },
];

const streamError = () => ({ message: '演练：response stream disconnected before completion', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } });

export class DemoAdapter extends EventEmitter {
  constructor({ stepMs = 650 } = {}) {
    super();
    this.mode = 'demo';
    this.state = { connected: true, mode: 'demo', detail: '本机故障演练 · 不调用模型' };
    this.stepMs = stepMs;
    this.threads = new Map();
    this.requests = new Map();
    this.timers = new Set();
    this.taskThreads = new Map();
  }
  async connect() { return this.state; }
  later(fn, delay) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, delay);
    this.timers.add(timer);
    return timer;
  }
  emitNotification(method, params) { this.emit('notification', { method, params: clone(params) }); }
  async createThread(task) {
    const index = this.taskThreads.get(task.id) || 0;
    this.taskThreads.set(task.id, index + 1);
    const thread = { id: `demo-${uid()}`, cwd: task.cwd, status: { type: 'idle' }, turns: [], scenario: task.scenario, replacement: index > 0 };
    this.threads.set(thread.id, thread);
    return clone(thread);
  }
  async readThread(id) {
    const thread = this.threads.get(id);
    if (!thread) throw new Error('演练会话只在当前进程中运行；历史事件仍保存在面板，可新建演练');
    return clone(thread);
  }
  async resumeThread(task) { return this.readThread(task.threadId); }
  async startTurn(task, text) {
    const thread = this.threads.get(task.threadId);
    if (!thread) throw new Error('演练会话不存在');
    const turn = { id: uid(), status: 'inProgress', items: [{ id: uid(), type: 'userMessage', content: [{ type: 'text', text }] }], error: null };
    thread.turns.push(turn);
    thread.status = { type: 'active', activeFlags: [] };
    const active = () => turn.status === 'inProgress';
    this.emitNotification('turn/started', { threadId: thread.id, turn });
    const finish = (status, error = null) => {
      if (!active()) return;
      turn.status = status; turn.error = error; thread.status = { type: 'idle' };
      if (error) this.emitNotification('error', { threadId: thread.id, turnId: turn.id, error, willRetry: false });
      this.emitNotification('turn/completed', { threadId: thread.id, turn });
    };
    const scenario = thread.scenario;
    let fails = ['repeated', 'failover', 'fallback_fails', 'alternating', 'capacity', 'rate_limit'].includes(scenario) || scenario === 'intermittent' && thread.turns.length === 1;
    if (thread.replacement && scenario === 'failover') fails = false;
    if (scenario === 'no_output') { /* Intentionally keep a live turn without effective output. */ }
    else if (scenario === 'interrupted') this.later(() => finish('interrupted'), this.stepMs * 2);
    else if (fails) {
      const error = scenario === 'capacity' ? { message: 'The model is at capacity. Please try again later.' }
        : scenario === 'rate_limit' ? { message: 'Too many requests', codexErrorInfo: 'rateLimitExceeded' }
        : scenario === 'alternating' && thread.turns.length % 2 === 0
        ? { message: '演练：upstream request timed out', codexErrorInfo: 'other' } : streamError();
      this.later(() => finish('failed', error), this.stepMs * 2);
    } else if (['approval', 'dnd_approval'].includes(scenario)) {
      this.later(() => {
        if (!active()) return;
        const request = { id: uid(), method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: turn.id, itemId: uid(), command: scenario === 'dnd_approval' ? 'npm test' : '运行项目测试（演练）', cwd: task.cwd, reason: '演练人工批准流程', availableDecisions: ['accept', 'decline', 'cancel'] } };
        this.requests.set(String(request.id), { request, finish, turn, thread });
        this.emit('request', request);
      }, this.stepMs);
    } else {
      const chunks = ['正在读取项目记录，核对上次完成的工作。\n', '已确认已有文件，继续处理剩余步骤。\n', '验证已完成，正在整理本次结果。\n'];
      chunks.forEach((delta, i) => this.later(() => { if (active()) this.emitNotification('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: 'demo-message', delta }); }, this.stepMs * (i + 1)));
      this.later(() => {
        if (!active()) return;
        const item = { id: uid(), type: 'commandExecution', command: '项目检查（演练）', status: 'completed', exitCode: 0 };
        turn.items.push(item); this.emitNotification('item/completed', { threadId: thread.id, turnId: turn.id, item });
      }, this.stepMs * 3);
      this.later(() => {
        if (!active()) return;
        const item = { id: uid(), type: 'agentMessage', text: '演练任务已完成。已有工作得到保留，恢复流程与验证均已结束。', phase: 'final_answer' };
        turn.items.push(item); this.emitNotification('item/completed', { threadId: thread.id, turnId: turn.id, item });
        finish('completed');
      }, this.stepMs * 5);
    }
    return clone(turn);
  }
  async interrupt(threadId, turnId) {
    const thread = this.threads.get(threadId);
    const turn = thread?.turns.find(item => item.id === turnId);
    if (turn?.status === 'inProgress') {
      turn.status = 'interrupted'; thread.status = { type: 'idle' };
      this.emitNotification('turn/completed', { threadId, turn });
    }
  }
  respond(requestId, result) {
    const pending = this.requests.get(String(requestId));
    if (!pending) throw new Error('演练请求已失效');
    this.requests.delete(String(requestId));
    this.emitNotification('serverRequest/resolved', { threadId: pending.thread.id, requestId });
    this.later(() => pending.finish(result.decision === 'accept' ? 'completed' : 'interrupted'), this.stepMs);
  }
  reject(requestId) { const p = this.requests.get(String(requestId)); if (p) { this.requests.delete(String(requestId)); p.finish('interrupted'); } }
  async close() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
}
