import { RECYCLE_TOOL } from '../core/recycle.mjs';
import { EventEmitter } from 'node:events';
import { JsonlRpcClient } from './rpc-client.mjs';
import { resolveCodex, describeCodex } from './codex-discovery.mjs';
export { resolveCodex } from './codex-discovery.mjs';

export class CodexAdapter extends EventEmitter {
  constructor({ command, timeoutMs = 30000, priorWorkerPid = null, environment = {}, discoveryOptions = {} } = {}) {
    super();
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.priorWorkerPid = priorWorkerPid;
    this.environment = environment;
    this.discoveryOptions = discoveryOptions;
    this.mode = 'codex';
    this.loaded = new Set();
    this.state = { connected: false, mode: 'codex', detail: '尚未连接；启动任务时连接 Codex' };
    this.requests = new Map();
  }

  async connect() {
    if (this.client?.connected) return this.state;
    if (this.connecting) return this.connecting;
    if (!this.client && Number.isInteger(this.priorWorkerPid) && this.priorWorkerPid > 0) {
      let alive = true;
      try { process.kill(this.priorWorkerPid, 0); }
      catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error(`上次受管 Codex 进程 ${this.priorWorkerPid} 可能仍在运行；请先核对并退出旧服务，避免并发执行`);
      this.priorWorkerPid = null;
    }
    this.connecting = (async () => {
      if (this.client) await this.client.close();
      const runtime = resolveCodex(this.command, this.discoveryOptions);
      this.state.installation = describeCodex(runtime);
      const client = new JsonlRpcClient({ ...runtime, env: { ...runtime.env, ...this.environment }, args: [...runtime.args, 'app-server', '--listen', 'stdio://'], timeoutMs: this.timeoutMs });
      this.client = client;
      client.on('notification', notification => {
        if (notification.method === 'serverRequest/resolved') this.requests.delete(String(notification.params?.requestId));
        this.emit('notification', notification);
      });
      client.on('request', request => {
        this.requests.set(String(request.id), request);
        this.emit('request', request);
      });
      client.on('diagnostic', diagnostic => this.emit('diagnostic', diagnostic));
      client.on('disconnect', error => {
        this.loaded.clear();
        this.requests.clear();
        this.state = { ...this.state, connected: false, mode: this.mode, detail: error.message };
        this.emit('disconnect', error);
      });
      let result;
      try { result = await client.connect(); }
      catch (error) {
        await client.close();
        this.state = { ...this.state, connected: false, detail: error.message };
        throw error;
      }
      this.state = { ...this.state, connected: true, mode: this.mode, detail: result.userAgent || 'Codex app-server 已连接', workerPid: client.proc.pid };
      this.emit('connected', this.state);
      return this.state;
    })();
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  config(task) {
    return { cwd: task.cwd, ...(task.model ? { model: task.model } : {}),
      ...(task.modelProvider ? { modelProvider: task.modelProvider } : {}),
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: task.sandbox || 'workspace-write' };
  }
  async createThread(task) {
    await this.connect();
    const result = await this.client.request('thread/start', { ...this.config(task), serviceName: 'autocodex_guard', ...(process.platform === 'win32' ? { dynamicTools: [RECYCLE_TOOL] } : {}) });
    this.loaded.add(result.thread.id);
    return { ...result.thread, recycleToolAvailable: process.platform === 'win32', model: result.model || result.thread.model, modelProvider: result.modelProvider || result.thread.modelProvider };
  }
  async readThread(threadId) {
    await this.connect();
    return (await this.client.request('thread/read', { threadId, includeTurns: true })).thread;
  }
  async readThreadSummary(threadId) {
    await this.connect();
    return (await this.client.request('thread/read', { threadId, includeTurns: false })).thread;
  }
  async listThreads({ cursor, searchTerm, archived = false } = {}) {
    await this.connect();
    return this.client.request('thread/list', { limit: 30, cursor: cursor || null,
      searchTerm: searchTerm || null, archived, sortKey: 'updated_at', modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'] });
  }
  async resumeThread(task) {
    await this.connect();
    const result = await this.client.request('thread/resume', { threadId: task.threadId, ...this.config(task) });
    this.loaded.add(task.threadId);
    return { ...result.thread, model: result.model || result.thread.model, modelProvider: result.modelProvider || result.thread.modelProvider };
  }
  async startTurn(task, text) {
    await this.connect();
    if (!this.loaded.has(task.threadId)) await this.resumeThread(task);
    return (await this.client.request('turn/start', { threadId: task.threadId, input: [{ type: 'text', text }] })).turn;
  }
  async interrupt(threadId, turnId) {
    if (!this.client?.connected) throw new Error('Codex 已断开，无法确认远端中断');
    return this.client.request('turn/interrupt', { threadId, turnId });
  }
  async respond(requestId, result) {
    const key = String(requestId);
    if (!this.requests.has(key) || !this.client?.connected) throw new Error('该批准请求已失效');
    await this.client.respond(this.requests.get(key).id, result);
    this.requests.delete(key);
  }
  reject(requestId, message) {
    const request = this.requests.get(String(requestId));
    if (request) { this.client.reject(request.id, message); this.requests.delete(String(requestId)); }
  }
  async close() { await this.client?.close(); this.state.connected = false; }
}
