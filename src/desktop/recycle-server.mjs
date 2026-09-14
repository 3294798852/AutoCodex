import { createInterface } from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prepareRecycle, recyclePaths, RECYCLE_TOOL } from '../core/recycle.mjs';
import { DEFAULT_DND } from '../core/dnd-policy.mjs';
import { signRecycle } from './recycle-protocol.mjs';

const config = JSON.parse(readFileSync(process.env.AUTOCODEX_RECYCLE_CONFIG, 'utf8'));
const secret = process.env.AUTOCODEX_RECYCLE_SECRET;
if (!secret) throw new Error('Missing recycle connection identity');
const directory = dirname(config.connectionFile), journals = join(directory, 'desktop-recycle-journal');
mkdirSync(journals, { recursive: true });
const pending = new Map(), replies = new Map(), running = new Map();
let closed = false;
const send = message => { if (!closed) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };
function ask(params, signal) {
  const id = randomUUID();
  return new Promise(resolve => {
    const finish = value => { clearTimeout(timer); pending.delete(id); signal.removeEventListener('abort', cancel); resolve(value); };
    const cancel = () => finish(null), timer = setTimeout(cancel, 300000);
    pending.set(id, { resolve: finish, timer }); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted || closed) cancel(); else send({ id, method: 'elicitation/create', params });
  });
}
function result(value, isError = false) {
  return { isError, content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: { ...value, _meta: { autocodexRecycle: value, autocodexSignature: signRecycle(value, secret) } } };
}
async function recycle(args, signal) {
  let operation, journal, lock, lockPath, executing = false;
  try {
    const task = { cwd: process.cwd(), sandbox: 'workspace-write' };
    const prepared = prepareRecycle(args, task, DEFAULT_DND, directory);
    const journalKey = createHash('sha256').update(JSON.stringify([...prepared.paths].sort())).digest('hex');
    journal = join(journals, journalKey + '.json');
    if (existsSync(journal) && ['executing', 'uncertain'].includes(JSON.parse(readFileSync(journal, 'utf8')).state)) {
      return result({ success: false, state: 'uncertain', journalKey, message: 'Previous recycle result is unresolved. Review the files and restore assistance in AutoCodex before retrying.' }, true);
    }
    operation = { id: randomUUID(), paths: prepared.paths, journalKey };
    const answer = await ask({ mode: 'form', message: 'Move these files or folders to the Windows Recycle Bin?\n' + prepared.paths.join('\n'),
      requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Move to Recycle Bin' } }, required: ['confirm'] },
      _meta: { autocodexRecycle: operation, autocodexSignature: signRecycle(operation, secret) } }, signal);
    if (closed || signal.aborted || answer?.action !== 'accept' || answer.content?.confirm !== true) return result({ ...operation, success: false, state: 'cancelled', message: 'No files changed.' });
    lockPath = journal + '.lock';
    try { lock = openSync(lockPath, 'wx'); writeFileSync(lock, JSON.stringify({ pid: process.pid, id: operation.id }), { flush: true }); }
    catch { return result({ ...operation, success: false, state: 'uncertain', message: 'Another recycle operation requires review.' }, true); }
    if (existsSync(journal) && ['executing', 'uncertain'].includes(JSON.parse(readFileSync(journal, 'utf8')).state)) {
      return result({ ...operation, success: false, state: 'uncertain', message: 'Previous recycle result requires review.' }, true);
    }
    prepareRecycle({ paths: prepared.paths }, task, DEFAULT_DND, directory);
    writeFileSync(journal, JSON.stringify({ ...operation, state: 'executing', at: Date.now() }), { flush: true });
    executing = true;
    const outcome = await recyclePaths(prepared.paths, { signal });
    const value = { ...operation, ...outcome, state: outcome.success ? 'completed' : 'uncertain' };
    writeFileSync(journal, JSON.stringify(value), { flush: true });
    return result(value, !outcome.success);
  } catch (error) {
    const value = { ...operation, success: false, state: executing ? 'uncertain' : 'rejected', message: error.message };
    if (executing && journal) writeFileSync(journal, JSON.stringify(value), { flush: true });
    return result(value, true);
  } finally {
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}
async function receive(message) {
  if (message.method === 'notifications/cancelled') { running.get(message.params?.requestId)?.abort(); return; }
  if (!message.method) {
    const entry = pending.get(message.id);
    if (entry) { clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message.result); }
    return;
  }
  if (!Object.hasOwn(message, 'id')) return;
  if (replies.has(message.id)) { send(replies.get(message.id)); return; }
  if (running.has(message.id)) return;
  const controller = new AbortController(); running.set(message.id, controller);
  let response;
  if (message.method === 'initialize') response = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'autocodex_recycle', version: '1.0.0' },
    instructions: 'For file deletion, prefer the recycle tool. It moves explicit local paths to the Windows Recycle Bin, requests approval when needed, and never falls back to permanent deletion. An uncertain result requires manual inspection, not a retry.' };
  else if (message.method === 'tools/list') response = { tools: [{ name: 'recycle', description: RECYCLE_TOOL.description, inputSchema: RECYCLE_TOOL.inputSchema, annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false } }] };
  else if (message.method === 'tools/call' && message.params.name === 'recycle') response = await recycle(message.params.arguments, controller.signal);
  else if (message.method === 'ping') response = {};
  const reply = response ? { id: message.id, result: response } : { id: message.id, error: { code: -32601, message: 'Unsupported method' } };
  running.delete(message.id); replies.set(message.id, reply);
  if (replies.size > 500) replies.delete(replies.keys().next().value);
  send(reply);
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => { try { void receive(JSON.parse(line)).catch(e => process.stderr.write(e.message + '\n')); } catch { /* Invalid input has no request identity. */ } });
input.on('close', () => { closed = true; for (const controller of running.values()) controller.abort(); });
process.stdout.on('error', () => { closed = true; for (const controller of running.values()) controller.abort(); });
