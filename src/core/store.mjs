import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { uid, safeData, redact } from './util.mjs';

export class Store {
  constructor(directory, { lock = true } = {}) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.directory, 'supervisor.lock');
    if (lock) this.acquireLock();
    try {
      this.db = new DatabaseSync(join(this.directory, 'guard.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, type TEXT NOT NULL,
          level TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
        CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, dedupe_key TEXT UNIQUE NOT NULL,
          state TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkpoints (task_id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);`);
      const version = this.getMeta('schemaVersion');
      if (version !== undefined && version !== 1) throw new Error(`不支持数据库版本 ${version}`);
      this.setMeta('schemaVersion', 1);
    } catch (error) { this.db?.close(); this.releaseLock(); throw error; }
  }

  acquireLock() {
    const take = () => {
      const fd = openSync(this.lockPath, 'wx', 0o600);
      this.lockNonce = uid();
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: this.lockNonce }));
      fsyncSync(fd);
      closeSync(fd);
    };
    try { take(); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(readFileSync(this.lockPath, 'utf8')); }
      catch { throw new Error('数据目录锁无法读取，请确认没有实例运行后移除 supervisor.lock'); }
      try { process.kill(previous.pid, 0); }
      catch (probe) {
        if (probe.code === 'ESRCH') { unlinkSync(this.lockPath); take(); return; }
        throw new Error('无法确认已有守护进程状态，拒绝重复启动');
      }
      throw new Error(`此数据目录已由进程 ${previous.pid} 使用`);
    }
  }

  releaseLock() {
    if (!this.lockNonce) return;
    try { if (JSON.parse(readFileSync(this.lockPath, 'utf8')).nonce === this.lockNonce) unlinkSync(this.lockPath); }
    catch { /* Already removed by an operator. */ }
    this.lockNonce = null;
  }

  transaction(fn) {
    if (this.transactionDepth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth = 0; }
  }

  getMeta(key) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  tasks() { return this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all().map(row => JSON.parse(row.data)); }
  task(id) { const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  taskByThread(id) { return this.tasks().find(task => task.threadId === id || task.threadChain.some(thread => thread.id === id)) || null; }
  saveTask(task) { this.db.prepare('INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id, JSON.stringify(task)); }

  receipt(key, now) { return this.db.prepare('INSERT OR IGNORE INTO receipts VALUES (?,?)').run(key, now).changes > 0; }

  event(taskId, type, message, { level = 'info', data = {}, now = Date.now() } = {}) {
    const clean = safeData(data);
    const result = this.db.prepare('INSERT INTO events(task_id,type,level,message,data,created_at) VALUES(?,?,?,?,?,?)')
      .run(taskId, type, level, redact(message, 1600), JSON.stringify(clean), now);
    return { id: Number(result.lastInsertRowid), taskId, type, level, message: redact(message, 1600), data: clean, createdAt: now };
  }
  events({ taskId = null, after = 0, limit = 150 } = {}) {
    const bounded = Math.min(500, Math.max(1, limit));
    const rows = taskId
      ? this.db.prepare('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id DESC LIMIT ?').all(taskId, after, bounded)
      : this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id DESC LIMIT ?').all(after, bounded);
    return rows.reverse().map(row => ({ id: row.id, taskId: row.task_id, type: row.type, level: row.level, message: row.message, data: JSON.parse(row.data), createdAt: row.created_at }));
  }

  saveAction(action) {
    this.db.prepare('INSERT INTO actions VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data')
      .run(action.id, action.taskId, action.key, action.state, JSON.stringify(action));
  }
  action(id) { const row = this.db.prepare('SELECT data FROM actions WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  actions(taskId) { return this.db.prepare('SELECT data FROM actions WHERE task_id=? ORDER BY rowid').all(taskId).map(row => JSON.parse(row.data)); }

  saveRecord(table, record, taskId) {
    if (!['alerts', 'checkpoints', 'handoffs', 'approvals'].includes(table)) throw new Error('Invalid table');
    if (table === 'checkpoints') {
      this.db.prepare('INSERT INTO checkpoints VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data').run(taskId, JSON.stringify(record));
    } else this.db.prepare(`INSERT INTO ${table} VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(record.id, taskId, JSON.stringify(record));
  }
  records(table, taskId = null) {
    if (!['alerts', 'checkpoints', 'handoffs', 'approvals'].includes(table)) throw new Error('Invalid table');
    return (taskId ? this.db.prepare(`SELECT data FROM ${table} WHERE task_id=? ORDER BY rowid DESC`).all(taskId)
      : this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`).all()).map(row => JSON.parse(row.data));
  }
  close() { this.db?.close(); this.db = null; this.releaseLock(); }
}
