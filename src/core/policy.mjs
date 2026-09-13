import { assert, uid } from './util.mjs';
import { noOutputExpired } from './progress.mjs';

export const DEFAULT_POLICY = Object.freeze({
  strategy: 'manual',
  maxAutoAttempts: 6,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  rateLimitDelayMs: 15000,
  immediateFailureMs: 30000,
  staleAfterMs: 300000,
  errorWindowMs: 300000,
  noOutputTimeoutMs: 600000,
  jitterRatio: 0.2,
});

export function validatePolicy(input = {}, base = DEFAULT_POLICY) {
  assert(input && typeof input === 'object' && !Array.isArray(input), '恢复策略格式错误');
  for (const key of Object.keys(input)) assert(key in DEFAULT_POLICY, `未知恢复设置：${key}`);
  const p = { ...DEFAULT_POLICY, ...base, ...input };
  assert(['manual', 'new_session'].includes(p.strategy), '无效的接续策略');
  for (const [key, min, max] of [
    ['maxAutoAttempts', 2, 30], ['baseDelayMs', 50, 60000], ['maxDelayMs', 50, 300000],
    ['rateLimitDelayMs', 50, 300000], ['immediateFailureMs', 100, 120000], ['staleAfterMs', 1000, 3600000],
    ['errorWindowMs', 1000, 3600000], ['noOutputTimeoutMs', 1000, 86400000],
  ]) assert(Number.isInteger(p[key]) && p[key] >= min && p[key] <= max, `${key} 必须在 ${min}–${max} 之间`);
  assert(Number.isFinite(p.jitterRatio) && p.jitterRatio >= 0 && p.jitterRatio <= 0.5, '抖动比例必须在 0–0.5 之间');
  assert(p.maxDelayMs >= p.baseDelayMs, '最大等待不能小于首次等待');
  return p;
}

export function newIncident() {
  return { version: 2, id: uid(), autoAttempts: 0, attemptsWithoutOutput: 0, consecutiveSame: 0,
    lastErrorCategory: null, recentErrors: [], threshold: 3, match: null, replacements: 0 };
}

export function errorThreshold(error) {
  return ['rate_limit', 'server_overloaded'].includes(error.category) ? 5 : 3;
}

/** E0 counts. Match the most recent N consecutive failures using time OR output. */
export function decideFailure(task, error, now, random = Math.random) {
  const incident = { ...task.incident, recentErrors: [...task.incident.recentErrors] };
  incident.consecutiveSame = incident.lastErrorCategory === error.category ? incident.consecutiveSame + 1 : 1;
  if (incident.lastErrorCategory !== error.category) incident.recentErrors = [];
  incident.lastErrorCategory = error.category;
  incident.threshold = errorThreshold(error);
  incident.recentErrors.push({ at: now, outputSequence: task.outputMonitor?.sequence ?? 0 });
  incident.recentErrors = incident.recentErrors.slice(-incident.threshold);
  const oldest = incident.recentErrors[0];
  const enough = incident.recentErrors.length === incident.threshold;
  incident.match = { enough, spanMs: Math.max(0, now - oldest.at),
    withinWindow: enough && now - oldest.at <= task.policy.errorWindowMs,
    noOutputBetween: enough && oldest.outputSequence === (task.outputMonitor?.sequence ?? 0) };
  incident.match.triggered = incident.match.withinWindow || incident.match.noOutputBetween;
  if (task.isFallbackFirstTurn && !task.meaningfulProgress && now - task.turnStartedAt <= task.policy.immediateFailureMs)
    return { incident, action: 'halt', code: 'replacement_failed_immediately' };
  if (!error.recoverable) return { incident, action: 'manual', code: error.category };
  if (noOutputExpired(task, now)) return { incident, action: 'manual', code: 'no_effective_output' };
  if (incident.match.triggered) {
    const canReplace = task.policy.strategy === 'new_session' && incident.replacements < 1;
    return { incident, action: canReplace ? 'replace' : 'manual', code: 'repeated_error' };
  }
  if (incident.attemptsWithoutOutput >= task.policy.maxAutoAttempts)
    return { incident, action: 'manual', code: 'retry_budget_exhausted' };
  const base = Math.min(task.policy.maxDelayMs, task.policy.baseDelayMs * 2 ** Math.min(incident.attemptsWithoutOutput, 10));
  const jitter = base * task.policy.jitterRatio * Math.min(1, Math.max(0, random()));
  const delay = Math.max(Math.round(base + jitter), error.retryAfterMs || 0,
    errorThreshold(error) === 5 ? task.policy.rateLimitDelayMs : 0);
  return { incident, action: 'continue', code: 'transient_error', dueAt: now + Math.min(delay, 300000) };
}
