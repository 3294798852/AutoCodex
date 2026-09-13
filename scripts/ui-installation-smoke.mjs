import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { resolveCodex } from '../src/adapters/codex-discovery.mjs';

const require = createRequire(import.meta.url), { chromium } = require(process.env.AUTOCODEX_PLAYWRIGHT_MODULE || 'playwright');
const executablePath = [process.env.AUTOCODEX_BROWSER_PATH, chromium.executablePath(), join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe')].find(path => path && existsSync(path));
assert(executablePath, 'Provide an installed test browser');
const runtime = resolveCodex();
mkdirSync(resolve('.work'), { recursive: true });
const directory = mkdtempSync(resolve('.work/ui-installation-'));
const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
// A fresh instance with an empty data directory; this test never creates a task.
const env = { ...process.env }; delete env.AUTOCODEX_CODEX_COMMAND;
const proc = spawn(process.execPath, [resolve('src/main.mjs'), '--data-dir', directory, '--port', String(port)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; proc.stdout.on('data', chunk => { log = (log + chunk).slice(-6000); }); proc.stderr.on('data', chunk => { log = (log + chunk).slice(-6000); });
let connection, browser;
const checks = [], errors = [];
try {
  const connectionFile = join(directory, 'connection.json');
  for (let i = 0; i < 100 && !existsSync(connectionFile); i++) {
    assert.equal(proc.exitCode, null, log); await new Promise(resolve => setTimeout(resolve, 100));
  }
  connection = JSON.parse(readFileSync(connectionFile, 'utf8'));
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${connection.origin}/#token=${connection.token}`);
  await page.locator('#app').waitFor({ state: 'visible' });
  assert(!page.url().includes('token='));
  await page.locator('#configure-codex').click();
  await page.locator('#codex-path-controls').waitFor({ state: 'visible' });
  assert((await page.locator('#codex-current-path').textContent()).includes(runtime.path)); checks.push('automatic installation and source shown');
  await page.locator('#codex-path-input').fill(dirname(runtime.path));
  await page.locator('#codex-detect').click();
  await page.locator('#codex-path-result').filter({ hasText: '找到程序' }).waitFor();
  const save = async () => {
    const [response] = await Promise.all([page.waitForResponse(res => res.url().endsWith('/api/v1/codex') && res.request().method() === 'POST'), page.locator('#codex-save').click()]);
    return response;
  };
  assert((await save()).ok());
  await page.locator('#codex-restart-note').waitFor({ state: 'visible' });
  assert((await page.locator('#codex-current-path').textContent()).includes(runtime.path)); checks.push('manual directory detects and saves without switching the active installation');
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' }); await page.locator('#configure-codex').click();
  await page.locator('#codex-restart-note').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#codex-path-input').inputValue(), dirname(runtime.path)); checks.push('saved path and restart reminder survive page reload');
  const screenshots = resolve('docs/assets'); mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, 'codex-installation.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(screenshots, 'codex-installation-narrow.png'), fullPage: true }); checks.push('installation settings usable at 390px without horizontal overflow');
  await page.locator('#codex-path-input').fill(join(directory, 'missing', 'codex.exe'));
  await page.locator('#codex-detect').click(); await page.locator('#codex-path-result').filter({ hasText: '指定位置未找到' }).waitFor();
  assert.equal((await save()).status(), 400); checks.push('invalid manual path is reported and rejected');
  await page.locator('#codex-path-input').fill(''); assert((await save()).ok());
  await page.locator('#codex-restart-note').waitFor({ state: 'hidden' }); checks.push('blank input restores automatic configuration');
  await page.locator('[data-view="monitor"]').click();
  const [connectResponse] = await Promise.all([page.waitForResponse(res => res.url().endsWith('/api/v1/connect')), page.locator('#connect-codex').click()]);
  assert(connectResponse.ok(), await connectResponse.text());
  await page.locator('#codex-status').filter({ hasText: 'Codex 已连接' }).waitFor(); checks.push('real app-server connection check succeeds without a task');
  const state = await (await fetch(`${connection.origin}/api/v1/state`, { headers: { Authorization: `Bearer ${connection.token}` } })).json();
  assert.equal(state.tasks.length, 0); assert.deepEqual(errors, []);
  const report = { testedAt: new Date().toISOString(), version: state.version, checks, browserErrors: errors, modelGenerationRequested: false, desktop: '1500x1100', narrow: '390x844' };
  writeFileSync(resolve('.work/ui-installation-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await browser?.close();
  if (connection && proc.exitCode === null) {
    await fetch(`${connection.origin}/api/v1/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', Connection: 'close' }, body: '{}', signal: AbortSignal.timeout(5000) }).then(response => response.arrayBuffer()).catch(() => {});
  }
  if (proc.exitCode === null) {
    const timer = setTimeout(() => proc.kill(), 8000);
    await once(proc, 'exit'); clearTimeout(timer);
  }
  proc.stdout.destroy(); proc.stderr.destroy(); proc.unref();
}
