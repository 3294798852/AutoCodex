import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';
import { uid, clone } from '../src/core/util.mjs';

export const STREAM = { message: 'stream disconnected request=abc', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } };
export const TIMEOUT = { message: 'request timed out', codexErrorInfo: 'other' };

export function tempDirectory(prefix = 'test-') {
  const parent = resolve('.work');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, prefix));
  return {
    directory,
    remove() {
      const target = resolve(directory);
      if (dirname(target) !== parent || !basename(target).startsWith(prefix)) throw new Error('Unsafe test cleanup path');
      rmSync(target, { recursive: true, force: true });
    },
  };
}

export class ControlledAdapter extends EventEmitter {
  constructor() {
    super(); this.mode = 'demo'; this.state = { connected: true, mode: 'demo' };
    this.threads = new Map(); this.sent = []; this.replies = []; this.rejections = [];
  }
  async connect() { this.state.connected = true; return this.state; }
  async createThread(task) {
    if (this.createError) throw this.createError;
    const thread = { id: uid(), cwd: task.cwd, status: { type: 'idle' }, turns: [] };
    this.threads.set(thread.id, thread); return clone(thread);
  }
  async readThread(id) { if (this.readError) throw this.readError; const t = this.threads.get(id); if (!t) throw new Error('missing thread'); return clone(t); }
  async resumeThread(task) { return this.readThread(task.threadId); }
  async startTurn(task, text) {
    const thread = this.threads.get(task.threadId);
    const turn = { id: uid(), status: 'inProgress', error: null, items: [{ id: uid(), type: 'userMessage', content: [{ type: 'text', text }] }] };
    this.sent.push({ taskId: task.id, threadId: task.threadId, text, turnId: turn.id });
    if (!this.omitHistory) { thread.turns.push(turn); thread.status = { type: 'active' }; }
    if (this.startError) throw this.startError;
    this.notify('turn/started', { threadId: task.threadId, turn: clone(turn) });
    if (this.earlyCompletion) this.finish(task.threadId, 'completed');
    return clone(turn);
  }
  notify(method, params) { this.emit('notification', { method, params: clone(params) }); }
  finish(threadId, status = 'failed', error = STREAM) {
    const thread = this.threads.get(threadId), turn = thread.turns.at(-1);
    turn.status = status; turn.error = status === 'failed' ? clone(error) : null; thread.status = { type: 'idle' };
    this.notify('turn/completed', { threadId, turn });
    return clone(turn);
  }
  async interrupt(threadId, turnId) { this.interrupted = { threadId, turnId }; this.finish(threadId, 'interrupted'); }
  respond(id, result) { this.replies.push({ id, result }); }
  reject(id, message) { this.rejections.push({ id, message }); }
  async close() {}
}

export async function harness(t, options = {}) {
  const temporary = tempDirectory();
  const store = new Store(temporary.directory);
  const adapter = options.adapter || new ControlledAdapter();
  let now = 100000;
  const supervisor = new Supervisor({ store, adapter, now: () => now, random: () => 0 });
  supervisor.on('fatal', error => { throw error; });
  const flush = async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (!supervisor.queues.size) break;
      await Promise.allSettled([...supervisor.queues.values()]);
    }
  };
  t.after(async () => { await supervisor.close(); store.close(); temporary.remove(); });
  return {
    store, adapter, supervisor, directory: temporary.directory, flush,
    now: () => now,
    advance(ms) { now += ms; },
    async create(input = {}) {
      const task = await supervisor.createTask({ name: 'Test task', prompt: 'Finish the implementation', cwd: process.cwd(), policy: { baseDelayMs: 50, maxDelayMs: 200, rateLimitDelayMs: 50 }, ...input });
      await flush(); return store.task(task.id);
    },
    async finish(id, status = 'failed', error = STREAM) { const task = store.task(id); const turn = adapter.finish(task.threadId, status, error); await flush(); return turn; },
    async step(id) {
      const task = store.task(id); now = Math.max(now, task.retryDueAt ?? now);
      supervisor.tick(); await flush(); return store.task(id);
    },
  };
}
