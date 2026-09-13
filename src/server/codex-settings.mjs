import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectCodex, normalizeCodexInput, resolveCodex } from '../adapters/codex-discovery.mjs';
import { assert } from '../core/util.mjs';

export function selectCodexCommand({ command, env = process.env, saved = '' } = {}) {
  if (command !== undefined) return { command, source: '启动参数', locked: true };
  if (env.AUTOCODEX_CODEX_COMMAND?.trim()) return { command: env.AUTOCODEX_CODEX_COMMAND, source: '环境变量', locked: true };
  return { command: saved || '', source: saved ? '面板保存' : '自动发现', locked: false };
}

// Diagnostics may read settings while the service is running. Do not acquire
// its single-instance lock or initialize a database just to locate the CLI.
export function readSavedCodexCommand(directory) {
  const path = join(directory, 'guard.sqlite');
  if (!existsSync(path)) return '';
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get('codexCommand');
    return row ? JSON.parse(row.value) || '' : '';
  } finally { db.close(); }
}

export class CodexSettings {
  constructor({ store, adapter, command, env = process.env, discoveryOptions = {} }) {
    this.store = store; this.adapter = adapter;
    this.options = { ...discoveryOptions, env };
    this.selection = selectCodexCommand({ command, env, saved: store.getMeta('codexCommand') });
    this.selection.command = normalizeCodexInput(this.selection.command, this.options);
    this.enabled = adapter.mode === 'codex';
    if (this.enabled) {
      adapter.command = this.selection.command;
      adapter.discoveryOptions = this.options;
      adapter.state.installation = inspectCodex(adapter.command, this.options);
    }
  }

  snapshot() {
    return {
      enabled: this.enabled,
      source: this.selection.source,
      locked: this.selection.locked,
      activeCommand: this.selection.command,
      installation: this.enabled ? this.adapter.state.installation : null,
      savedCommand: this.store.getMeta('codexCommand') || '',
      restartRequired: !this.selection.locked && (this.store.getMeta('codexCommand') || '') !== this.selection.command,
      message: !this.enabled ? '演练模式无需 Codex。请启动真实模式后配置安装路径。' : this.selection.locked
        ? `本次由${this.selection.source}指定 Codex；移除该覆盖并重启后，才能使用面板保存的路径。`
        : '留空使用自动发现。保存后重启守护服务生效；正在运行的任务继续使用原路径。',
    };
  }

  detect(input) {
    assert(this.enabled, '演练模式无需配置 Codex', 409);
    const command = normalizeCodexInput(input, this.options);
    return { ...inspectCodex(command, this.options), requested: command };
  }

  save(input) {
    assert(this.enabled, '演练模式无需配置 Codex', 409);
    assert(!this.selection.locked, '启动参数或环境变量正在覆盖路径。请移除覆盖并重启，再使用面板设置。', 409);
    const command = normalizeCodexInput(input, this.options);
    if (command) resolveCodex(command, this.options); // Invalid explicit paths never replace a working saved value.
    this.store.setMeta('codexCommand', command);
    return this.snapshot();
  }
}
