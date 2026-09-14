import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Supervisor } from '../src/core/supervisor.mjs';
import { DemoAdapter } from '../src/adapters/demo.mjs';
import { createDashboardServer } from '../src/server/http.mjs';
import { DND_KEYS } from '../src/core/dnd-policy.mjs';

const require = createRequire(import.meta.url), { chromium } = require(process.env.AUTOCODEX_PLAYWRIGHT_MODULE || 'playwright');
const executablePath = [process.env.AUTOCODEX_BROWSER_PATH, chromium.executablePath(), join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe')].find(path => path && existsSync(path));
assert(executablePath, 'Provide an installed test browser');
mkdirSync('.work', { recursive: true });
const directory = mkdtempSync(resolve('.work/ui-dnd-')), store = new Store(directory), adapter = new DemoAdapter({ stepMs: 50 });
const supervisor = new Supervisor({ store, adapter }), http = createDashboardServer(supervisor, { port: 0 });
const address = await http.listen(), checks = [], errors = [];
let browser;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const poll = async predicate => { const end = Date.now() + 8000; while (!await predicate()) { assert(Date.now() < end, 'Timed out waiting for test condition'); await sleep(25); } };
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  context.setDefaultTimeout(8000);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const open = async page => { await page.goto(address.launchUrl); await page.locator('#app').waitFor({ state: 'visible' }); await page.locator('[data-view="settings"]').click(); };
  await open(page); assert(!page.url().includes('token='));
  const clickSave = async (selector, expectedStatus = 200, target = page) => {
    const [response] = await Promise.all([target.waitForResponse(res => res.url().endsWith('/api/v1/dnd') && res.request().method() === 'POST'), target.locator(selector).click()]);
    assert.equal(response.status(), expectedStatus, await response.text());
    await target.waitForFunction(() => !document.querySelector('#dnd-all').disabled);
  };
  const count = async (number, target = page) => target.waitForFunction(n => document.querySelector('#dnd-count').textContent === '已开启 ' + n + ' / 5', number);
  await count(0); for (const key of DND_KEYS) assert(!await page.locator('#dnd-' + key).isChecked()); checks.push('fresh installation defaults to five disabled switches');
  for (let i = 0; i < DND_KEYS.length; i++) { await clickSave('#dnd-' + DND_KEYS[i]); await count(i + 1); }
  assert(await page.locator('#dnd-all').isChecked()); checks.push('five independent toggles save immediately and update N/5');
  await clickSave('#dnd-all'); await count(0); await clickSave('#dnd-all'); await count(5); checks.push('master switch enables and disables all five options');
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' }); await page.locator('[data-view="settings"]').click(); await count(5); checks.push('saved settings survive browser reload');
  await page.locator('summary').filter({ hasText: '适用范围与工作区外目录' }).click();
  await page.locator('#dnd-roots').fill(directory); await clickSave('#dnd-roots-save');
  assert.deepEqual(supervisor.dnd.outsideRoots, [directory]);
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' }); await page.locator('[data-view="settings"]').click();
  assert.equal(await page.locator('#dnd-roots').inputValue(), directory); checks.push('optional outside directories persist and reload');
  const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message)); await open(second);
  await clickSave('#dnd-all'); await count(0, second); checks.push('SSE synchronizes switch changes to another open page');
  await second.route('**/api/v1/dnd', async route => {
    const body = route.request().postDataJSON();
    supervisor.setDnd({ revision: body.revision, systemTools: true });
    await route.continue();
  });
  await clickSave('#dnd-commonCommands', 409, second);
  await second.unroute('**/api/v1/dnd');
  await second.locator('#dnd-save-status').filter({ hasText: '其他面板' }).waitFor();
  assert(supervisor.dnd.systemTools && !supervisor.dnd.commonCommands); checks.push('stale simultaneous edits are rejected and current state restored');
  await count(1); await clickSave('#dnd-systemTools'); await count(0);
  const create = async name => supervisor.createTask({ name, prompt: '验证免打扰开关与批准记录，不执行真实命令。', cwd: process.cwd(), scenario: 'dnd_approval' });
  const manual = await create('已有请求保持人工'); await poll(() => supervisor.pendingApprovals(manual.id).length === 1);
  await clickSave('#dnd-commonCommands'); await sleep(150);
  assert.equal(supervisor.pendingApprovals(manual.id).length, 1); checks.push('enabling a switch preserves a previously displayed manual request');
  await page.locator('[data-view="monitor"]').click(); await page.locator('[data-task-id="' + manual.id + '"]').click();
  await page.locator('.approval-card').waitFor(); assert((await page.locator('.approval-card').textContent()).includes('未开启'));
  await page.locator('.approval-card button[value="accept"]').click(); await poll(() => store.task(manual.id).status === 'completed'); checks.push('existing manual approval stays usable');
  await page.locator('[data-view="settings"]').click();
  const automatic = await create('常用命令自动批准'); await poll(() => store.task(automatic.id).status === 'completed');
  await page.waitForFunction(() => document.querySelector('#dnd-approved').textContent === '1');
  await page.locator('summary').filter({ hasText: '最近批准记录' }).click();
  assert((await page.locator('#dnd-history').textContent()).includes('自动 · 已处理')); checks.push('subsequent request is approved and shown in the live audit list');
  await clickSave('#dnd-commonCommands'); const blocked = await create('关闭后等待处理'); await poll(() => supervisor.pendingApprovals(blocked.id).length === 1);
  assert.equal(store.task(blocked.id).totalAutoApprovals || 0, 0); checks.push('switch off makes subsequent requests wait for a human');
  await page.locator('[data-view="monitor"]').click(); await page.locator('[data-task-id="' + blocked.id + '"]').click();
  await page.locator('.approval-card button[value="decline"]').click(); await poll(() => store.task(blocked.id).status === 'stopped');
  assert.equal(store.records('approvals', blocked.id)[0].decision, 'decline'); checks.push('manual rejection is recorded without retry');
  await page.locator('[data-task-id="' + automatic.id + '"]').click();
  await page.locator('#timeline').filter({ hasText: '免打扰已处理' }).waitFor(); checks.push('task timeline contains the automatic approval event');
  await page.locator('[data-view="settings"]').click(); await clickSave('#dnd-commonCommands');
  const started = new Map(), decisionSamples = [], panelSamples = [];
  adapter.on('request', request => started.set(String(request.id), performance.now()));
  supervisor.on('change', event => {
    if (event.event?.type === 'approval_automatic') {
      const approval = store.records('approvals', event.taskId).find(a => a.id === event.event.data.approvalId);
      decisionSamples.push(performance.now() - started.get(approval.requestId));
    }
  });
  for (let i = 0; i < 20; i++) {
    const sample = await create('本地延迟样本 ' + (i + 1));
    await page.waitForFunction(n => Number(document.querySelector('#dnd-approved').textContent) >= n, i + 2);
    const approval = store.records('approvals', sample.id)[0]; panelSamples.push(performance.now() - started.get(approval.requestId));
    await poll(() => store.task(sample.id).status === 'completed');
  }
  const stats = samples => { const sorted = samples.map(x => Math.round(x * 10) / 10).sort((a, b) => a - b); return { samples: sorted.length, p50: sorted[9], p95: sorted[18], max: sorted.at(-1), unit: 'ms' }; };
  const decisionLatency = stats(decisionSamples), panelLatency = stats(panelSamples);
  assert(decisionLatency.p95 < 250); assert(panelLatency.p95 < 1000); checks.push('20 wall-clock approval and browser SSE samples meet latency targets');
  await clickSave('#dnd-outsideWorkspace'); await count(2);
  await page.locator('summary').filter({ hasText: '适用范围与工作区外目录' }).click();
  mkdirSync('docs/assets', { recursive: true });
  await page.locator('summary').filter({ hasText: '最近批准记录' }).click();
  await page.screenshot({ path: 'docs/assets/dnd-settings.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'docs/assets/dnd-settings-narrow.png', fullPage: true }); checks.push('desktop and 390px layout render without horizontal overflow');
  assert.deepEqual(errors, []);
  const report = { testedAt: new Date().toISOString(), version: supervisor.snapshot().version, checks, browserErrors: errors, decisionLatency, panelLatency, desktop: '1500x1100', narrow: '390x844', modelRequests: 0 };
  mkdirSync('docs/validation', { recursive: true }); writeFileSync('docs/validation/dnd-ui-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(JSON.stringify({ message: error.message, checks, errors })); throw error; }
finally { await browser?.close(); await supervisor.close(); await http.close(); store.close(); }
