import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

const CHUNK = 1024 * 1024;
const INITIAL = 2 * CHUNK;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function bytesAt(file, offset, size) {
  const buffer = Buffer.alloc(size);
  const { bytesRead } = await file.read(buffer, 0, size, offset);
  return buffer.subarray(0, bytesRead);
}
async function anchorAt(file, offset) { return hash(await bytesAt(file, Math.max(0, offset - 64), Math.min(64, offset))); }

// The path comes only from Codex metadata. This reader never resumes or writes a thread.
export async function readRollout(path, threadId, previous = null) {
  if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.jsonl')) throw new Error('此会话没有可读取的本机 JSONL 记录');
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('会话记录不是普通文件');
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    const reset = !previous || previous.identity !== identity || previous.offset > info.size
      || previous.anchor !== await anchorAt(file, previous.offset);
    let cursor = previous ? { ...previous } : null;
    if (reset) {
      const head = await bytesAt(file, 0, Math.min(info.size, INITIAL));
      const end = head.indexOf(10);
      if (end < 0) throw new Error('会话记录头尚未完整写入或格式不受支持');
      let meta;
      try { meta = JSON.parse(head.subarray(0, end).toString('utf8')); } catch { throw new Error('无法识别会话记录头'); }
      if (meta.type !== 'session_meta' || meta.payload?.id !== threadId) throw new Error('会话记录身份不匹配');
      cursor = { identity, cycle: randomUUID(), offset: Math.max(0, info.size - INITIAL), discarding: info.size > INITIAL };
    }
    const end = Math.min(info.size, cursor.offset + (reset ? INITIAL : CHUNK));
    const buffer = await bytesAt(file, cursor.offset, end - cursor.offset);
    const records = [];
    let start = 0, dropped = 0;
    while (start < buffer.length) {
      const boundary = buffer.indexOf(10, start);
      if (boundary < 0) break;
      if (cursor.discarding) cursor.discarding = false;
      else if (boundary - start > CHUNK) dropped++;
      else {
        try {
          const record = JSON.parse(buffer.subarray(start, boundary).toString('utf8'));
          records.push({ record, key: `${cursor.cycle}:${cursor.offset + start}` });
        } catch { dropped++; }
      }
      start = boundary + 1;
    }
    cursor.offset += start;
    // Keep ordinary partial lines on disk until complete, including partial UTF-8.
    if (buffer.length - start >= CHUNK) { cursor.offset += buffer.length - start; cursor.discarding = true; dropped++; }
    cursor.anchor = await anchorAt(file, cursor.offset);
    return { cursor, records, reset, truncated: reset && info.size > INITIAL, dropped, pendingBytes: Math.max(0, info.size - cursor.offset) };
  } finally { await file.close(); }
}
