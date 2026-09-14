import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../src/core/classify.mjs';
import { validatePolicy } from '../src/core/policy.mjs';
import { redact } from '../src/core/util.mjs';

test('protocol error variants classify inner fatal causes before network wrappers', () => {
  const cases = [
    [{ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }, 'stream_disconnected', true],
    [{ codexErrorInfo: 'ResponseStreamDisconnected' }, 'stream_disconnected', true],
    [{ codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } } }, 'auth', false],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } }, 'permission', false],
    [{ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }, 'rate_limit', true],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }, 'upstream_5xx', true],
    [{ codexErrorInfo: 'usageLimitExceeded' }, 'quota', false],
    [{ codexErrorInfo: 'sessionBudgetExceeded' }, 'quota', false],
    [{ codexErrorInfo: 'contextWindowExceeded' }, 'context', false],
    [{ codexErrorInfo: 'misalignmentPolicyViolation' }, 'policy', false],
    [{ codexErrorInfo: 'cyberPolicy' }, 'policy', false],
    [{ codexErrorInfo: 'sandboxError' }, 'permission', false],
    [{ codexErrorInfo: 'badRequest' }, 'bad_request', false],
    [{ codexErrorInfo: 'serverOverloaded' }, 'server_overloaded', true],
    [{ codexErrorInfo: 'rateLimitExceeded' }, 'rate_limit', true],
    [{ message: 'request timed out' }, 'timeout', true],
    [{ message: 'stream disconnected: insufficient_quota' }, 'quota', false],
    [{ message: 'unknown transport configuration' }, 'unknown', false],
    [{ message: 'unexpected status 503 Service Unavailable: provider offline', codexErrorInfo: 'other' }, 'upstream_5xx', true],
    [{ message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'other' }, 'auth', false],
    [{ message: 'HTTP/1.1 429 Too Many Requests' }, 'rate_limit', true],
    [{ message: 'tool exited with status 503 on line 500' }, 'unknown', false],
    [{ code: -32001, message: 'busy' }, 'server_overloaded', true],
    [{ message: 'The model is at capacity. Please try again later.' }, 'server_overloaded', true],
    [{ message: 'unexpected status 503: model gpt-6 is currently at capacity' }, 'server_overloaded', true],
    [{ code: 'model_at_capacity' }, 'server_overloaded', true],
    [{ message: '请求超过限速，请稍后重试' }, 'rate_limit', true],
    [{ message: '模型算力不足，请稍后重试' }, 'server_overloaded', true],
    [{ status: 429, message: 'insufficient_quota; model at capacity' }, 'quota', false],
    [{ status: 401, message: 'model at capacity' }, 'auth', false],
    [{ message: 'thread thread-1 already has an active writer', code: -32600 }, 'conflict', false],
    [{ code: 'thread_in_use', message: '原会话被其他客户端占用', status: 409 }, 'conflict', false],
  ];
  for (const [input, category, recoverable] of cases) {
    const result = classifyError(input);
    assert.equal(result.category, category, JSON.stringify(input));
    assert.equal(result.recoverable, recoverable);
  }
});

test('random request IDs do not change error type and secrets are redacted', () => {
  assert.equal(classifyError({ message: 'stream disconnected id=123' }).category, classifyError({ message: 'stream disconnected id=999' }).category);
  assert.equal(redact('Authorization: Bearer verysecretvalue'), 'Authorization: [REDACTED] [REDACTED]');
  assert(!redact('api_key=abcdef0123456789&token=qwerty').includes('abcdef'));
});

test('policy validation rejects unsafe values and unknown fields', () => {
  for (const policy of [{ maxAutoAttempts: 0 }, { maxAutoAttempts: 5000 }, { strategy: 'forever' }, { baseDelayMs: -1 }, { jitterRatio: 1 }, { surprise: true }, { errorWindowMs: 0 }, { noOutputTimeoutMs: Infinity }]) assert.throws(() => validatePolicy(policy));
  assert.equal(validatePolicy({ strategy: 'new_session' }).strategy, 'new_session');
});
