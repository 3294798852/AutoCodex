import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { redact } from '../core/util.mjs';
import { VERSION } from '../version.mjs';

export class RpcError extends Error {
  constructor(message, { code, data, uncertain = false } = {}) {
    super(message);
    this.code = code;
    this.data = data;
    this.uncertain = uncertain;
  }
}

export class JsonlRpcClient extends EventEmitter {
  constructor({ command, args = [], env, cwd, timeoutMs = 30000 }) {
    super();
    this.options = { command, args, env, cwd, timeoutMs };
    this.pending = new Map();
    this.nextId = 1;
    this.connected = false;
    this.closing = false;
  }

  async connect() {
    const { command, args, env, cwd } = this.options;
    this.closing = false;
    this.proc = spawn(command, args, { env, cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    this.proc.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (buffer.length > 32 * 1024 * 1024) {
        this.fail(new RpcError('Codex 协议消息超过大小上限', { uncertain: true }));
        this.proc.kill();
        return;
      }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.emit('diagnostic', { message: '忽略一条非 JSON 协议输出', level: 'warning' }); }
      }
    });
    this.proc.stderr.on('data', chunk => this.emit('diagnostic', { message: redact(chunk.toString(), 1200), level: 'warning' }));
    this.proc.stdin.on('error', error => this.fail(new RpcError(error.message, { uncertain: true })));
    this.proc.on('error', error => this.fail(new RpcError(`无法启动 Codex：${error.message}`, { code: error.code })));
    this.proc.on('exit', (code, signal) => this.fail(new RpcError(`Codex 进程已退出 (${code ?? signal})`, { code: 'processDisconnected', uncertain: true })));
    await new Promise((resolve, reject) => {
      this.proc.once('spawn', resolve);
      this.proc.once('error', reject);
    });
    const initialization = await this.request('initialize', {
      clientInfo: { name: 'autocodex_guard', title: 'AutoCodex Guard', version: VERSION },
    });
    this.notify('initialized', {});
    this.connected = true;
    return initialization;
  }

  receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.method && Object.hasOwn(message, 'id')) { this.emit('request', message); return; }
    if (message.method) { this.emit('notification', message); return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new RpcError(message.error.message || 'Codex 拒绝请求', message.error));
    else pending.resolve(message.result);
  }

  send(message) {
    if (!this.proc || this.proc.exitCode !== null || !this.proc.stdin.writable)
      throw new RpcError('Codex 通道不可写', { code: 'processDisconnected', uncertain: false });
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = this.options.timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`Codex 请求 ${method} 等待响应超时；执行结果尚不确定`, { code: 'rpc_timeout', uncertain: true }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) { this.send({ method, params }); }
  respond(id, result) { this.send({ id, result }); }
  reject(id, message = '此客户端不支持该请求') { this.send({ id, error: { code: -32601, message } }); }

  fail(error) {
    this.connected = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new RpcError(error.message, { code: error.code, uncertain: true }));
    }
    this.pending.clear();
    if (!this.closing && !this.failureEmitted) { this.failureEmitted = true; this.emit('disconnect', error); }
  }

  async close() {
    this.closing = true;
    if (!this.proc) return;
    const proc = this.proc;
    this.fail(new RpcError('守护服务关闭连接', { uncertain: true }));
    if (proc.exitCode === null) {
      await new Promise(resolve => {
        const timeout = setTimeout(() => { proc.kill(); resolve(); }, 1500);
        proc.once('exit', () => { clearTimeout(timeout); resolve(); });
        proc.stdin.end();
      });
    }
    // Descendant helpers may retain inherited handles briefly after the server exits.
    proc.stdout.destroy(); proc.stderr.destroy(); proc.stdin.destroy();
    proc.unref();
  }
}
