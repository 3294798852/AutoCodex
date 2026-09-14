import { redact } from './util.mjs';
import { isWriterConflict, WRITER_CONFLICT_MESSAGE } from './ownership.mjs';

const normalize = value => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/** Classify failures only. Completion/interruption and tool failures are handled upstream. */
export function classifyError(error = {}) {
  if (typeof error === 'string') error = { message: error };
  const info = error.codexErrorInfo ?? error.data?.codexErrorInfo;
  const tag = typeof info === 'string' ? info : Object.keys(info || {})[0];
  const detail = info && typeof info === 'object' ? info[tag] : null;
  const kind = normalize(tag || error.kind || error.code);
  const raw = `${error.message || ''} ${error.additionalDetails || ''}`;
  const text = raw.toLowerCase();
  // Custom providers can emit `other` without a structured status, even for HTTP 503.
  // Only parse explicit HTTP status phrases, never arbitrary numbers in tool messages.
  const textStatus = raw.match(/\b(?:unexpected\s+status|http(?:\/\d(?:\.\d)?)?(?:\s+(?:status|error))?)\s*[:=]?\s*([45]\d\d)\b/i)?.[1];
  const rawStatus = detail?.httpStatusCode ?? info?.httpStatusCode ?? error.httpStatusCode ?? error.status ?? textStatus;
  const status = rawStatus === undefined || rawStatus === null ? null : Number(rawStatus);
  const retryAfterMs = Math.min(300_000, Math.max(0, Number(error.retryAfterMs) || 0));
  const result = (category, label, recoverable) => ({
    category, label, recoverable, message: redact(error.message || '未提供错误说明', 1600),
    httpStatus: Number.isInteger(status) ? status : null, retryAfterMs, sourceType: tag || error.kind || error.code || null,
  });

  if (isWriterConflict(error)) return { ...result('conflict', '原会话被其他客户端占用', false), message: WRITER_CONFLICT_MESSAGE };

  // Fatal inner causes must win over transient stream/connection wrappers.
  if (kind.includes('misalignment') || kind.includes('cyberpolicy') || /policy violation|safety policy|安全策略|策略拒绝/.test(text))
    return result('policy', '策略限制，需要人工处理', false);
  if (kind.includes('unauthorized') || status === 401 || /invalid api.?key|unauthori[sz]ed|authentication failed|invalid.*token|认证失败/.test(text))
    return result('auth', '认证失败', false);
  if (kind.includes('sandbox') || status === 403 || /permission denied|access denied|forbidden|权限不足|权限拒绝/.test(text))
    return result('permission', '权限或沙箱限制', false);
  if (/usagelimitexceeded|sessionbudgetexceeded/.test(kind) || status === 402 || /insufficient.quota|quota.exceeded|usage limit|budget.exceeded|额度耗尽|预算耗尽/.test(text))
    return result('quota', '额度或预算耗尽', false);
  if (kind.includes('contextwindow') || /context.{0,15}(exceed|limit)|maximum context|上下文.{0,8}(超|满)/.test(text))
    return result('context', '上下文容量不足', false);
  if (kind.includes('activeturn') || /turn.*(already|in.progress)|already.*(running|active)/.test(text))
    return result('conflict', '会话仍在运行', false);
  if (kind.includes('badrequest') || (status >= 400 && status < 500 && status !== 408 && status !== 429))
    return result('bad_request', '请求或配置错误', false);
  if (kind === 'processdisconnected' || kind === 'processexit')
    return result('process_exit', '受管 Codex 进程断开', true);
  if (kind.includes('ratelimit') || status === 429 || /rate.limit|too many requests|临时限流|请求超过限速|请求过于频繁|请求频率.{0,8}(超|限制)/.test(text))
    return result('rate_limit', '上游临时限流', true);
  if (/serveroverloaded|overloadederror|modelatcapacity|modelcapacityexceeded|insufficientcompute/.test(kind) || error.code === -32001 || /server overloaded|overloaded_error|model[_ -]+at[_ -]+capacity|model\b.{0,100}\bat capacity\b|insufficient (?:compute|capacity)|capacity (?:exceeded|unavailable)|算力不足|模型.{0,12}(容量不足|繁忙|满载)/.test(text))
    return result('server_overloaded', '上游容量不足或服务过载', true);
  if (status >= 500 && status <= 599 || kind.includes('internalservererror'))
    return result('upstream_5xx', '上游服务异常', true);
  if (status === 408 || /timeout|timed out|etimedout|超时/.test(text))
    return result('timeout', '连接或响应超时', true);
  if (kind.includes('responsestreamdisconnected') || /stream.*(disconnect|closed|ended.*before)|断流/.test(text))
    return result('stream_disconnected', '响应流中断', true);
  if (/httpconnectionfailed|responsestreamconnectionfailed/.test(kind) || /econnreset|econnrefused|eai_again|connection (reset|closed|failed)|network.*(error|failed)|连接失败/.test(text))
    return result('connection_failed', '连接失败', true);
  if (kind.includes('responsetoomanyfailedattempts') || /retry limit|retries exhausted|重试耗尽/.test(text))
    return result('retry_exhausted', 'Codex 内部重试耗尽', true);
  return result('unknown', '未识别异常，需要人工核对', false);
}
