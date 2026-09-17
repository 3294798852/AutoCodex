import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { fixture } from './usability-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AUTOCODEX_PLAYWRIGHT_MODULE || 'playwright');
const wait = ms => new Promise(r => setTimeout(r, ms));
const executable = resolve(process.env.AUTOCODEX_WINDOW_EXECUTABLE || '.work/desktop-runtime/AutoCodexWindow.exe');
const baseline = process.env.AUTOCODEX_WINDOW_BASELINE;
const results = [];

async function checkWindow(label, path, scale) {
  const f = await fixture(), listener = createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  let child, browser;
  const errors = [];
  try {
    child = spawn(path, [f.address.connectionPath], {
      windowsHide: label !== 'native', stdio: 'ignore', env: { ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1${scale ? ` --force-device-scale-factor=${scale}` : ''}` },
    });
    await once(child, 'spawn');
    for (let n = 0; n < 80; n++) {
      if (child.exitCode !== null) throw new Error('Native window exited before connecting');
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await wait(150); }
    }
    assert(browser, 'Native WebView2 test target unavailable');
    let page;
    for (let n = 0; n < 60; n++) {
      page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith(f.address.origin));
      if (page) break;
      await wait(100);
    }
    assert(page, 'Dashboard page unavailable');
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#app').waitFor();
    await page.locator('[data-view="settings"]').click();
    await page.locator('#dnd-commonCommands').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const native = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', resolve('scripts/window-dpi-probe.ps1'), '-WindowProcessId', String(child.pid)], { encoding: 'utf8', windowsHide: true }));
    const web = await page.evaluate(() => ({
      dpr: devicePixelRatio, width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, viewportScale: visualViewport.scale,
    }));
    const png = await page.screenshot({ path: `docs/assets/window-dpi-${label}.png`, scale: 'device' });
    const pixels = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    if (label === 'before') {
      assert.equal(native.awareness, 0, 'Baseline must reproduce an unaware window');
    } else {
      assert.equal(native.awareness, 2);
      assert.equal(native.perMonitorV2, true, 'Window must use PerMonitorV2, not system DPI bitmap scaling');
      assert.equal(native.dpi, native.monitorScalePercent * 96 / 100);
      assert.equal(native.insideWorkArea, true, 'High-DPI window must fit the monitor work area');
      for (const control of native.children) {
        assert(control.left >= native.left - 2 && control.top >= native.top - 2 &&
          control.left + control.width <= native.left + native.width + 2 && control.top + control.height <= native.top + native.height + 2,
        `Native control ${control.className} must be inside the window, including after initial placement`);
      }
      const expected = scale || native.dpi / 96;
      assert(Math.abs(web.dpr - expected) < .01, `WebView pixel ratio ${web.dpr} must match ${expected}`);
      assert(Math.abs(pixels.width - web.width * web.dpr) <= 2, 'Rendered image must use device pixels');
      assert(Math.abs(pixels.width - native.clientWidth) <= 2, 'WebView must fill the physical window client width');
      assert(web.scrollWidth <= web.width + 1, 'Settings must not overflow horizontally');
      assert.equal(web.viewportScale, 1, 'No extra page zoom to compensate for DPI');
      assert.deepEqual(errors, []);
    }
    const exit = once(child, 'exit');
    await page.evaluate(() => window.close());
    await Promise.race([exit, wait(5000).then(() => { throw new Error('Window did not close'); })]);
    assert((await fetch(f.address.origin + '/healthz')).ok, 'Closing window must leave service alive');
    const result = { label, mode: scale ? 'WebView2 forced device scale; Windows display unchanged' : 'actual Windows monitor', native, web, pixels, pageErrors: errors };
    results.push(result); console.log(JSON.stringify({ label, perMonitorV2: native.perMonitorV2, dpi: native.dpi, dpr: web.dpr,
      clientWidth: native.clientWidth, renderedWidth: pixels.width, nativeChildren: native.children.length, pageErrors: errors }));
  } finally {
    await browser?.close();
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await f.close();
  }
}

if (baseline) { assert(existsSync(baseline)); await checkWindow('before', resolve(baseline)); }
await checkWindow('native', executable);
for (const scale of [1, 1.25, 1.5, 2]) await checkWindow(String(scale * 100), executable, scale);
writeFileSync('docs/validation/window-dpi-report.json', JSON.stringify({
  testedAt: new Date().toISOString(), executable, results, paidModelRequests: 0,
  coverage: 'Native awareness and monitor ratio plus four isolated WebView2 rendering scales; no OS settings changed. Cross-monitor dragging requires separate physical displays.',
}, null, 2) + '\n');
