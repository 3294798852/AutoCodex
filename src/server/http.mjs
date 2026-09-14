import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, assert, redact } from '../core/util.mjs';
import { SCENARIOS } from '../adapters/demo.mjs';
import { summarizeHistory } from '../core/handoff.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.mjs', ['dashboard.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

function constantEqual(value, expected) {
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function body(req) {
  assert(req.headers['content-type']?.split(';')[0].trim() === 'application/json', '请求必须使用 JSON', 415);
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false;
    const parts = [];
    req.on('data', chunk => { size += chunk.length; if (size > 65536) tooLarge = true; else parts.push(chunk); });
    req.on('end', () => {
      if (tooLarge) { reject(new AppError('请求内容超过 64 KiB', 413)); return; }
      try {
        const value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
        assert(value && typeof value === 'object' && !Array.isArray(value), 'JSON 请求必须是对象');
        resolve(value);
      } catch (error) { reject(new AppError(error instanceof AppError ? error.message : 'JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

export function createDashboardServer(supervisor, { port = 3210, onShutdown, codexSettings } = {}) {
  const connectionPath = join(supervisor.store.directory, 'connection.json');
  let token = randomBytes(32).toString('hex');
  let pluginToken = randomBytes(32).toString('hex');
  if (existsSync(connectionPath)) {
    try { const saved = JSON.parse(readFileSync(connectionPath, 'utf8')); if (/^[a-f0-9]{64}$/.test(saved.token)) token = saved.token; if (/^[a-f0-9]{64}$/.test(saved.pluginToken)) pluginToken = saved.pluginToken; } catch { /* A new token replaces an invalid local connection file. */ }
  }
  const clients = new Set();
  const backpressure = new Map();
  let origin, host, updateTimer, closing = false;
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
  const send = (res, status, value) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const authorized = req => {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('autocodex_session='))?.slice('autocodex_session='.length);
    if (constantEqual(bearer, token) || constantEqual(cookie, token)) return 'admin';
    return constantEqual(bearer, pluginToken) ? 'plugin' : null;
  };

  const forgetClient = res => {
    clients.delete(res);
    const pending = backpressure.get(res);
    if (pending) { clearTimeout(pending.timer); res.off('drain', pending.onDrain); backpressure.delete(res); }
  };
  const writeFrame = (res, frame) => {
    if (res.destroyed || res.writableEnded) { forgetClient(res); return; }
    if (res.write(frame)) return;
    // false means buffered, not failed. Wait for drain before sending another frame.
    const pending = { dirty: false };
    pending.onDrain = () => {
      clearTimeout(pending.timer); backpressure.delete(res);
      if (pending.dirty && clients.has(res)) pushSnapshot(res);
    };
    pending.timer = setTimeout(() => { forgetClient(res); res.destroy(); }, 10000);
    pending.timer.unref(); backpressure.set(res, pending); res.once('drain', pending.onDrain);
  };
  const pushSnapshot = res => {
    const pending = backpressure.get(res);
    if (pending) { pending.dirty = true; return; }
    const state = { ...supervisor.snapshot(), scenarios: supervisor.adapter.mode === 'demo' ? SCENARIOS : [] };
    writeFrame(res, `event: snapshot\ndata: ${JSON.stringify(state)}\n\n`);
  };
  const onChange = () => {
    if (closing || updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      for (const res of clients) { try { pushSnapshot(res); } catch { forgetClient(res); res.destroy(); } }
    }, 100);
  };
  supervisor.on('change', onChange);

  const server = createServer(async (req, res) => {
    try {
      assert(req.headers.host === host, '不接受此主机名', 403);
      assert(!req.headers.origin || req.headers.origin === origin, '不接受跨站请求', 403);
      assert(!['cross-site'].includes(req.headers['sec-fetch-site']), '不接受跨站请求', 403);
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (req.method === 'GET' && (assets.has(path) || /^\/history\/[a-zA-Z0-9_-]+$/.test(path))) {
        const [file, mime] = assets.get(path) || assets.get('/');
        res.writeHead(200, { ...headers, 'Content-Type': mime });
        res.end(readFileSync(join(ROOT, file)));
        return;
      }
      if (req.method === 'GET' && path === '/healthz') { send(res, 200, { ok: !supervisor.faulted, mode: supervisor.adapter.mode }); return; }
      if (req.method === 'POST' && path === '/api/v1/session') {
        const input = await body(req);
        assert(constantEqual(input.token, token), '访问口令不正确，请使用本机打开面板文件', 401);
        res.setHeader('Set-Cookie', `autocodex_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        send(res, 200, { ok: true }); return;
      }
      const role = authorized(req);
      assert(role, '需要本机访问口令，请通过启动器打开面板', 401);
      if (role === 'plugin') {
        const permitted = req.method === 'GET' && (path === '/api/v1/state' || /^\/api\/v1\/(tasks|handoffs|history)\/[a-zA-Z0-9_-]+$/.test(path))
          || req.method === 'POST' && /^\/api\/v1\/tasks\/[a-zA-Z0-9_-]+\/checkpoint$/.test(path);
        assert(permitted, '插件连接仅允许查询与保存检查点', 403);
      }
      if (req.method === 'GET' && path === '/api/v1/state') {
        send(res, 200, { ...supervisor.snapshot(), scenarios: supervisor.adapter.mode === 'demo' ? SCENARIOS : [] }); return;
      }
      if (req.method === 'GET' && path === '/api/v1/events') {
        assert(clients.size < 20, '面板连接过多', 429);
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        clients.add(res); pushSnapshot(res);
        res.on('close', () => forgetClient(res)); return;
      }
      if (req.method === 'POST' && path === '/api/v1/connect') { await body(req); send(res, 200, await supervisor.adapter.connect()); return; }
      if (req.method === 'GET' && path === '/api/v1/codex') {
        send(res, 200, codexSettings?.snapshot() || { enabled: false, message: '当前运行环境不支持安装设置' }); return;
      }
      if (req.method === 'POST' && (path === '/api/v1/codex' || path === '/api/v1/codex/detect')) {
        assert(codexSettings, '当前运行环境不支持安装设置', 405);
        const input = await body(req);
        send(res, 200, path.endsWith('/detect') ? codexSettings.detect(input.command) : codexSettings.save(input.command)); return;
      }
      if (req.method === 'POST' && path === '/api/v1/tasks') {
        assert(supervisor.store.tasks().filter(task => !['completed', 'stopped', 'failed'].includes(task.status)).length < 20, '本机最多同时监护 20 个任务', 409);
        const input = await body(req);
        if (supervisor.adapter.mode === 'demo') assert(SCENARIOS.some(s => s.id === (input.scenario || 'intermittent')), '未知演练场景');
        send(res, 201, await supervisor.createTask(input)); return;
      }
      const taskRoute = path.match(/^\/api\/v1\/tasks\/([a-zA-Z0-9_-]+)(?:\/(control|checkpoint))?$/);
      if (taskRoute) {
        const [, id, action] = taskRoute;
        if (req.method === 'GET' && !action) {
          send(res, 200, { task: supervisor.getTask(id), events: supervisor.store.events({ taskId: id, limit: 200 }),
            actions: supervisor.store.actions(id), checkpoint: supervisor.store.records('checkpoints', id)[0] || null,
            handoffs: supervisor.store.records('handoffs', id) }); return;
        }
        if (req.method === 'POST' && action === 'control') { const input = await body(req); send(res, 200, await supervisor.control(id, input.action, input)); return; }
        if (req.method === 'POST' && action === 'checkpoint') { const input = await body(req); send(res, 200, supervisor.checkpoint(id, input.text)); return; }
      }
      const historyRoute = path.match(/^\/api\/v1\/history\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && historyRoute) {
        const task = supervisor.store.taskByThread(historyRoute[1]);
        assert(task, '此会话不在本机监护记录中', 404);
        let history, warning = null;
        try { history = summarizeHistory(await supervisor.adapter.readThread(historyRoute[1]), 80000); }
        catch (error) {
          history = supervisor.store.records('handoffs', task.id).find(h => h.source.threadId === historyRoute[1])?.history || [];
          warning = `实时历史不可用，显示已保存快照：${redact(error.message)}`;
        }
        send(res, 200, { threadId: historyRoute[1], taskId: task.id, name: task.name, history, warning }); return;
      }
      const handoffRoute = path.match(/^\/api\/v1\/handoffs\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && handoffRoute) {
        const handoff = supervisor.store.records('handoffs').find(item => item.id === handoffRoute[1]);
        assert(handoff, '交接材料不存在', 404); send(res, 200, handoff); return;
      }
      const ack = path.match(/^\/api\/v1\/alerts\/([a-zA-Z0-9_-]+)\/ack$/);
      if (req.method === 'POST' && ack) { await body(req); send(res, 200, supervisor.acknowledge(ack[1])); return; }
      const approval = path.match(/^\/api\/v1\/approvals\/([a-zA-Z0-9_-]+)\/respond$/);
      if (req.method === 'POST' && approval) { send(res, 200, await supervisor.respondApproval(approval[1], await body(req))); return; }
      if (req.method === 'GET' && path === '/api/v1/dnd') { send(res, 200, supervisor.dndSnapshot()); return; }
      if (req.method === 'POST' && path === '/api/v1/dnd') { send(res, 200, supervisor.setDnd(await body(req))); return; }
      if (req.method === 'POST' && path === '/api/v1/settings') { const input = await body(req); send(res, 200, supervisor.setDefaults(input.policy || {})); return; }
      if (req.method === 'POST' && path === '/api/v1/shutdown') {
        await body(req); assert(typeof onShutdown === 'function', '此运行环境不支持关闭接口', 405);
        send(res, 202, { ok: true }); setImmediate(onShutdown); return;
      }
      if (req.method === 'GET' && path === '/api/v1/export') {
        res.setHeader('Content-Disposition', 'attachment; filename="autocodex-report.json"');
        send(res, 200, { exportedAt: new Date().toISOString(), ...supervisor.snapshot(), events: supervisor.store.events({ limit: 500 }) }); return;
      }
      throw new AppError('未找到此接口', 404);
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: redact(error.message), code: error.code || 'server_error' });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  const heartbeat = setInterval(() => {
    for (const res of clients) if (!backpressure.has(res)) writeFrame(res, ': heartbeat\n\n');
  }, 15000);
  heartbeat.unref();

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      host = `127.0.0.1:${server.address().port}`;
      origin = `http://${host}`;
      supervisor.origin = origin;
      const connection = { origin, token, pluginToken, mode: supervisor.adapter.mode, pid: process.pid };
      writeFileSync(connectionPath, JSON.stringify(connection, null, 2), { mode: 0o600, flush: true });
      const launchUrl = `${origin}/#token=${token}`;
      const launchPath = join(supervisor.store.directory, 'open-panel.html');
      writeFileSync(launchPath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>打开 AutoCodex</title><meta http-equiv="refresh" content="0;url=${launchUrl}"><a href="${launchUrl}">打开本机监测面板</a></html>`, { mode: 0o600 });
      return { origin, launchUrl, launchPath, connectionPath };
    },
    async close() {
      closing = true;
      supervisor.off('change', onChange);
      clearInterval(heartbeat); clearTimeout(updateTimer);
      for (const res of clients) { forgetClient(res); res.destroy(); } clients.clear();
      server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
