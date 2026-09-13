import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexSettings, readSavedCodexCommand, selectCodexCommand } from '../src/server/codex-settings.mjs';
import { Store } from '../src/core/store.mjs';
import { CodexAdapter } from '../src/adapters/codex.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';
import { createDashboardServer } from '../src/server/http.mjs';
import { tempDirectory } from './helpers.mjs';

test('selection priority is argument, environment, saved path, automatic discovery', () => {
  assert.deepEqual(selectCodexCommand({ command: 'first', env: { AUTOCODEX_CODEX_COMMAND: 'second' }, saved: 'third' }), { command: 'first', source: '启动参数', locked: true });
  assert.equal(selectCodexCommand({ command: '', env: { AUTOCODEX_CODEX_COMMAND: 'second' } }).command, '');
  assert.equal(selectCodexCommand({ env: { AUTOCODEX_CODEX_COMMAND: 'second' }, saved: 'third' }).source, '环境变量');
  assert.equal(selectCodexCommand({ env: {}, saved: 'third' }).source, '面板保存');
  assert.equal(selectCodexCommand({ env: {} }).source, '自动发现');
});

test('saving a valid path persists for restart without switching the current adapter; invalid values keep the saved setting', t => {
  const tmp = tempDirectory('settings-');
  const store = new Store(tmp.directory); t.after(() => { store.close(); tmp.remove(); });
  const binary = join(tmp.directory, 'codex.exe'); writeFileSync(binary, 'fixture');
  const options = { home: join(tmp.directory, 'home'), node: join(tmp.directory, 'node', 'node.exe'), platform: 'win32' };
  const adapter = new CodexAdapter();
  const settings = new CodexSettings({ store, adapter, env: {}, discoveryOptions: options });
  assert.equal(settings.snapshot().installation.found, false);
  const saved = settings.save(binary);
  assert.equal(saved.restartRequired, true); assert.equal(adapter.command, '');
  assert.equal(readSavedCodexCommand(tmp.directory), binary, 'read-only diagnostic can read a running service database');
  assert.throws(() => settings.save(join(tmp.directory, 'missing.exe')), /指定位置/);
  assert.equal(store.getMeta('codexCommand'), binary);
  const restarted = new CodexSettings({ store, adapter: new CodexAdapter(), env: {}, discoveryOptions: options });
  assert.equal(restarted.adapter.command, binary); assert.equal(restarted.snapshot().restartRequired, false);
  assert.equal(restarted.snapshot().source, '面板保存');
  const cleared = restarted.save(''); assert.equal(cleared.restartRequired, true);
  assert.equal(readSavedCodexCommand(tmp.directory), ''); assert.equal(restarted.adapter.command, binary);
});

test('installation API requires admin, supports preview and saving, and exposes no environment secrets', async t => {
  const tmp = tempDirectory('settings-api-');
  const store = new Store(tmp.directory), adapter = new CodexAdapter();
  const options = { home: join(tmp.directory, 'home'), node: join(tmp.directory, 'missing-node'), platform: 'win32' };
  const settings = new CodexSettings({ store, adapter, env: { SECRET: 'hidden-fixture-value' }, discoveryOptions: options });
  const supervisor = new Supervisor({ store, adapter });
  const http = createDashboardServer(supervisor, { port: 0, codexSettings: settings });
  t.after(async () => { await http.close(); await supervisor.close(); store.close(); tmp.remove(); });
  const address = await http.listen();
  const connection = JSON.parse(readFileSync(address.connectionPath, 'utf8'));
  const call = (path, data, token = connection.token) => fetch(address.origin + '/api/v1/codex' + path, {
    method: data ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.equal((await call('', undefined, '')).status, 401);
  for (const [path, data] of [['', undefined], ['/detect', { command: '' }], ['', { command: '' }]]) assert.equal((await call(path, data, connection.pluginToken)).status, 403);
  const binary = join(tmp.directory, '中文 Codex', 'codex.exe'); mkdirSync(join(tmp.directory, '中文 Codex')); writeFileSync(binary, 'fixture');
  const detected = await (await call('/detect', { command: binary })).json(); assert.equal(detected.path, binary);
  assert.equal(store.getMeta('codexCommand'), undefined, 'preview does not save');
  assert.equal((await (await call('', { command: binary })).json()).restartRequired, true);
  assert.equal((await call('', { command: null })).status, 400);
  const state = await (await call('')).text();
  assert(!state.includes('hidden-fixture-value')); assert(!state.includes(connection.token));
  settings.selection.locked = true;
  assert.equal((await call('', { command: '' })).status, 409);
  assert.equal(store.getMeta('codexCommand'), binary);
});

test('diagnostic settings read never creates directories or databases', t => {
  const tmp = tempDirectory('settings-read-'); t.after(() => tmp.remove());
  assert.equal(readSavedCodexCommand(join(tmp.directory, 'absent')), '');
});
