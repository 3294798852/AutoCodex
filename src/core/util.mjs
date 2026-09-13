import { randomUUID } from 'node:crypto';

export const uid = () => randomUUID();
export const clone = value => structuredClone(value);
export const iso = (time = Date.now()) => new Date(time).toISOString();

export function redact(value, limit = 4000) {
  return String(value ?? '')
    .replace(/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[=:]\s*["']?)[^\s"',;&]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|key|auth)=)[^&#\s]+/gi, '$1[REDACTED]')
    .slice(0, limit);
}

export function safeData(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.slice(0, 80).map(v => safeData(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k, v]) => [
      k, /^(authorization|api.?key|.*token|password|secret)$/i.test(k) ? '[REDACTED]' : safeData(v, depth + 1),
    ]));
  }
  return value;
}

export class AppError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function assert(condition, message, status = 400, code) {
  if (!condition) throw new AppError(message, status, code);
}

export function boundedText(value, name, max, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  assert(typeof value === 'string' && value.trim().length > 0, `${name}不能为空`);
  assert(value.length <= max, `${name}不能超过 ${max} 个字符`);
  return value.trim();
}
