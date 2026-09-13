import { createHash } from 'node:crypto';
import { redact } from './util.mjs';

export function newOutputMonitor(now) {
  return { sequence: 0, sinceAt: now, lastEffectiveAt: null, suspendedAt: null, blocked: false, recentHashes: [], buffers: [] };
}

export function syncOutputSuspension(task, now) {
  const monitor = task.outputMonitor;
  if (!monitor) return;
  const suspended = task.paused || task.status === 'waiting_user';
  if (suspended && monitor.suspendedAt === null) monitor.suspendedAt = now;
  else if (!suspended && monitor.suspendedAt !== null) {
    monitor.sinceAt += Math.max(0, now - monitor.suspendedAt);
    monitor.suspendedAt = null;
  }
}

export function noOutputElapsed(task, now) {
  const monitor = task.outputMonitor;
  if (!monitor) return 0;
  return Math.max(0, (monitor.suspendedAt ?? now) - monitor.sinceAt);
}

export function noOutputExpired(task, now) {
  return !!task.outputMonitor?.blocked || noOutputElapsed(task, now) >= task.policy.noOutputTimeoutMs;
}

function recordOutput(task, key, now) {
  const monitor = task.outputMonitor;
  const hash = createHash('sha256').update(key).digest('hex');
  if (monitor.recentHashes.includes(hash)) return false;
  monitor.recentHashes = [...monitor.recentHashes.slice(-127), hash];
  monitor.sequence++;
  monitor.lastEffectiveAt = now;
  monitor.sinceAt = now;
  if (monitor.suspendedAt !== null) monitor.suspendedAt = now;
  task.incident.attemptsWithoutOutput = 0;
  // A late result is evidence of output, never permission to lift a latched stop.
  return true;
}

export function successfulTool(item) {
  return ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)
    && item.status === 'completed' && (item.exitCode === undefined || item.exitCode === null || item.exitCode === 0)
    && item.success !== false && !item.error;
}

export function observeToolOutput(task, item, now) {
  if (!successfulTool(item)) return false;
  task.meaningfulProgress = true;
  return recordOutput(task, `tool:${task.threadId}:${task.turnId}:${item.id || item.type}`, now);
}

function effectiveText(text, minimum) {
  const normalized = text.normalize('NFKC').trim();
  if ((normalized.match(/[\p{L}\p{N}]/gu) || []).length < minimum) return false;
  if (/^(?:(?:reconnecting|retrying|retry|trying again|thinking|working|正在重试|重试中|重新连接|思考中|稍后重试)[\s\d./()…,:=!-]*)+$/i.test(normalized)) return false;
  if (/^(?:error[:：]\s*)?(?:(?:the\s+)?model\b.{0,80}\bat capacity\b|server overloaded|too many requests|rate.?limit(?: exceeded| reached)?|算力不足|容量不足|请求超过限速|请求过于频繁|临时限流)/i.test(normalized)) return false;
  return true;
}

/** Count new visible business text, not reasoning, retry notices, or token drips. */
export function observeAgentOutput(task, itemId, value, now, complete = false) {
  const monitor = task.outputMonitor;
  const key = `${task.turnId}:${itemId || 'agent'}`;
  let buffer = monitor.buffers.find(entry => entry.key === key);
  if (!buffer) {
    buffer = { key, text: '', consumed: 0, complete: false };
    monitor.buffers = [...monitor.buffers.slice(-7), buffer];
  }
  if (buffer.complete) return false;
  const text = redact(value || '', 12000);
  const next = complete ? text : buffer.text + text;
  if (!next.startsWith(buffer.text)) buffer.consumed = 0;
  buffer.text = next;
  const pending = next.slice(buffer.consumed);
  let changed = false;
  if (effectiveText(pending, complete ? 8 : 24)) {
    const normalized = pending.normalize('NFKC').replace(/\s+/g, ' ').trim();
    changed = recordOutput(task, `text:${normalized}`, now);
    buffer.consumed = next.length;
  }
  if (next.length > 12000) {
    const removed = next.length - 12000;
    buffer.text = next.slice(removed);
    buffer.consumed = Math.max(0, buffer.consumed - removed);
  }
  buffer.complete = complete;
  return changed;
}
