import { AppError } from './util.mjs';

export const WRITER_CONFLICT_MESSAGE = '原会话仍被其他 Codex 客户端占用。停止回复并不释放会话连接；若确需移交，请先退出持有该会话的客户端，待连接释放后重试。要继续在原 Codex 中聊天，请保持监测，无需移交。';

export function isWriterConflict(error) {
  return !error?.uncertain && (error?.code === 'thread_in_use' || /\bthread\s+\S+\s+already has an active writer\b/i.test(String(error?.message || '')));
}

export function ownershipError(error) {
  return isWriterConflict(error) ? new AppError(WRITER_CONFLICT_MESSAGE, 409, 'thread_in_use') : error;
}
