import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/core/store.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';
import { DemoAdapter } from '../src/adapters/demo.mjs';
import { createDashboardServer } from '../src/server/http.mjs';

const require = createRequire(import.meta.url), { chromium } = require(process.env.AUTOCODEX_PLAYWRIGHT_MODULE || 'playwright');
const executablePath = [process.env.AUTOCODEX_BROWSER_PATH, chromium.executablePath(), join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe')].find(path => path && existsSync(path));
assert(executablePath, 'Provide an installed test browser');
mkdirSync('.work', { recursive: true });
const directory = mkdtempSync(resolve('.work/ui-launch-')), store = new Store(directory);
const supervisor = new Supervisor({ store, adapter: new DemoAdapter() }), http = createDashboardServer(supervisor, { port: 0 });
const address = await http.listen(), checks = [], errors = [], navigation = [], headerReads = [];
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ locale: 'zh-CN' }); context.setDefaultTimeout(10000);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().split('#')[0] === address.origin + '/' && response.request().isNavigationRequest()) {
      headerReads.push(response.request().allHeaders().then(headers => {
        navigation.push({ status: response.status(), site: headers['sec-fetch-site'], mode: headers['sec-fetch-mode'], destination: headers['sec-fetch-dest'] });
      }));
    }
  });
  // Use the actual generated file that Start-AutoCodex.ps1 opens, including its meta refresh.
  await page.goto(pathToFileURL(address.launchPath).href);
  await page.waitForURL(address.origin + '/**');
  await page.locator('#app').waitFor({ state: 'visible' });
  assert(!page.url().includes('token=')); checks.push('generated local launcher redirects and authenticates without a 403');
  const state = await page.evaluate(async () => { const response = await fetch('/api/v1/state'); const body = await response.json(); return { status: response.status, tasks: body.tasks?.length, version: body.version }; });
  assert.equal(state.status, 200); assert.equal(state.tasks, 0); checks.push('same-origin API session works without creating model work');
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' }); checks.push('reload keeps the authenticated dashboard usable');
  const clean = await browser.newContext(); const direct = await clean.newPage();
  await direct.goto(address.origin); await direct.locator('#auth-screen').waitFor({ state: 'visible' });
  checks.push('direct entry without a token still requires authentication');
  assert.deepEqual(errors, []);
  await Promise.all(headerReads);
  const report = { testedAt: new Date().toISOString(), version: state.version, checks, launcherNavigation: navigation, browserErrors: errors, modelRequests: 0 };
  mkdirSync('docs/validation', { recursive: true }); writeFileSync('docs/validation/launcher-ui-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(JSON.stringify({ message: error.message, navigation, errors })); throw error; }
finally { await browser?.close(); await supervisor.close(); await http.close(); store.close(); }
