import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fixture } from './usability-fixture.mjs';

const require = createRequire(import.meta.url), { chromium } = require(process.env.AUTOCODEX_PLAYWRIGHT_MODULE || 'playwright');
const f = await fixture(), listener = createServer();
await new Promise(r => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port; await new Promise(r => listener.close(r));
const executable = resolve('.work/desktop-runtime/AutoCodexWindow.exe');
let child, browser;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  child = spawn(executable, [f.address.connectionPath], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` } });
  await once(child, 'spawn');
  for (let n = 0; n < 60; n++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await wait(200); }
  }
  assert(browser, 'native WebView2 did not expose its isolated test target');
  let page;
  for (let n = 0; n < 40; n++) { page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith(f.address.origin)); if (page) break; await wait(100); }
  assert(page); await page.locator('#app').waitFor(); assert.equal(await page.evaluate(() => window.autocodexDesktop), true);
  await page.locator('[data-view="objects"]').click();
  assert.match(await page.locator('#object-connections').innerText(), /独立窗口/);
  await page.locator('#object-list [data-thread-id="child"]').getByRole('button', { name: '移除监测' }).click();
  await page.waitForFunction(() => document.querySelector('#object-list [data-thread-id="child"]').textContent.includes('加入监测'));
  assert.equal(f.store.tasks().find(t => t.threadId === 'child').monitorExcluded, true);
  const duplicate = spawn(executable, [f.address.connectionPath], { windowsHide: true, stdio: 'ignore' });
  const duplicateExit = await Promise.race([once(duplicate, 'exit'), wait(5000).then(() => { duplicate.kill(); throw new Error('duplicate window failed to reuse'); })]);
  assert.equal(duplicateExit[0], 0);
  await page.screenshot({ path: 'docs/assets/window-v070.png', fullPage: true });
  await page.locator('[data-view="settings"]').click(); await page.locator('#dnd-commonCommands').check();
  await page.waitForFunction(() => !document.querySelector('#dnd-commonCommands').disabled);
  assert.equal(f.supervisor.dnd.commonCommands, true);
  const exit = once(child, 'exit'); await page.evaluate(() => window.close());
  await Promise.race([exit, wait(5000).then(() => { throw new Error('window did not close'); })]);
  assert.equal((await fetch(f.address.origin + '/healthz')).ok, true);
  const report = { testedAt: new Date().toISOString(), runtime: 'Windows x64 native WinForms + WebView2',
    checks: ['native window authenticates and renders the shared dashboard', 'GUI object remove updates the shared monitoring service',
      'duplicate launch reuses existing GUI', 'settings persist to shared store', 'closing GUI exits window but keeps monitor alive'],
    paidModelRequests: 0, testDebugging: 'loopback CDP enabled only in the test child environment' };
  writeFileSync('docs/validation/window-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } await f.close(); }
