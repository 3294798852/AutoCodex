import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const moduleRoot = process.env.AUTOCODEX_PLAYWRIGHT_MODULE;
if (!moduleRoot) throw new Error('Set AUTOCODEX_PLAYWRIGHT_MODULE to an installed Playwright module or its package directory');
const require = createRequire(resolve('package.json'));
const { chromium } = require(moduleRoot);
const connectionFile = resolve(process.argv[2] || '.autocodex/demo/connection.json');
const connection = JSON.parse(readFileSync(connectionFile, 'utf8'));
assert.equal(connection.mode, 'demo', 'Browser fault scenarios run in demo mode only');
const candidates = [process.env.AUTOCODEX_BROWSER_PATH, chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];
const executablePath = candidates.find(path => path && existsSync(path));
if (!executablePath) throw new Error('No test browser found; set AUTOCODEX_BROWSER_PATH');
const browser = await chromium.launch({ headless: true, executablePath });
const errors = [], checks = [];
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const state = async () => {
  const response = await fetch(`${connection.origin}/api/v1/state`, { headers: { Authorization: `Bearer ${connection.token}` } });
  return response.json();
};
async function post(path, data) {
  const response = await fetch(`${connection.origin}/api/v1${path}`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert(response.ok); return response.json();
}
async function waitState(predicate, label, timeout = 35000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await state(); if (predicate(snapshot)) { checks.push(label); return snapshot; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
const names = {
  intermittent: '项目检查 · 偶发断流恢复', repeated: '接口修复 · 等待人工处理', failover: '构建验证 · 新会话接续',
  fallback_fails: '启动异常 · 已停止接续', approval: '变更检查 · 等待你的决定',
  capacity: '容量不足 · 五次错误后告警', rate_limit: '临时限流 · 五次错误后告警',
};
async function create(scenario, name) {
  await page.locator('#new-task').click();
  await page.locator('#create-scenario').selectOption(scenario);
  await page.locator('#create-name').fill(name);
  await page.locator('#create-cwd').fill(process.cwd());
  await page.locator('#create-prompt').fill('核对项目已有成果，完成剩余实现并验证结果。此任务仅用于本机故障演练。');
  await page.locator('#create-submit').click();
  await page.locator('#create-dialog').waitFor({ state: 'hidden', timeout: 10000 });
}

try {
  await page.goto(`${connection.origin}/#token=${connection.token}`);
  await page.locator('#app').waitFor({ state: 'visible' });
  assert(!page.url().includes('token=')); checks.push('fragment token removed after cookie exchange');
  assert(await page.locator('#mode-notice').isVisible()); checks.push('demo mode explicitly displayed');
  await post('/settings', { policy: { baseDelayMs: 100, maxDelayMs: 200, rateLimitDelayMs: 100 } });
  for (const [scenario, name] of Object.entries(names)) await create(scenario, name);
  const snapshot = await waitState(snapshot => Object.entries(names).every(([scenario, name]) => {
    const task = snapshot.tasks.find(task => task.name === name);
    return task?.status === ({ intermittent: 'completed', repeated: 'needs_attention', failover: 'completed', fallback_fails: 'failed', approval: 'waiting_user', capacity: 'needs_attention', rate_limit: 'needs_attention' }[scenario]);
  }), 'all seven terminal/approval recovery scenarios reached expected states');
  const failed = snapshot.tasks.find(task => task.name === names.fallback_fails);
  assert.equal(failed.totalAutoAttempts, 2); assert.equal(failed.threadChain.length, 2); checks.push('new-session startup failure stopped at one replacement');
  const repeated = snapshot.tasks.find(task => task.name === names.repeated);
  assert.equal(repeated.totalAutoAttempts, 2); assert.equal(repeated.incident.consecutiveSame, 3); checks.push('three same-type failures include E0 and exactly two retries');
  for (const scenario of ['capacity', 'rate_limit']) {
    const task = snapshot.tasks.find(task => task.name === names[scenario]);
    assert.equal(task.totalAutoAttempts, 4); assert.equal(task.incident.consecutiveSame, 5);
  }
  checks.push('capacity and rate limits allow four retries, stopping at five errors');
  const silent = await post('/tasks', { name: '连接停滞 · 无有效输出保护', prompt: '本机演练持续无输出，请勿调用模型。', cwd: process.cwd(), scenario: 'no_output', policy: { strategy: 'new_session', noOutputTimeoutMs: 1500 } });
  await waitState(snapshot => snapshot.tasks.find(task => task.id === silent.id)?.outputMonitor.blocked, 'live silent turn triggers independent output deadline');
  await page.locator(`[data-task-id="${silent.id}"]`).click();
  await page.locator('#output-watch').filter({ hasText: '长期无输出保护已触发' }).waitFor();
  assert(await page.locator('#pause-task').isDisabled());
  const silentState = (await state()).tasks.find(task => task.id === silent.id);
  assert.equal(silentState.totalAutoAttempts, 0); assert.equal(silentState.threadChain.length, 1);
  await page.locator('#stop-task').click();
  await waitState(snapshot => snapshot.tasks.find(task => task.id === silent.id)?.status === 'stopped', 'user can stop the silent running turn after the alert');
  const approval = snapshot.tasks.find(task => task.name === names.approval);
  await page.locator(`[data-task-id="${approval.id}"]`).click();
  await page.locator('#approval-list').getByRole('button', { name: '仅批准本次' }).click();
  await waitState(snapshot => snapshot.tasks.find(task => task.id === approval.id)?.status === 'completed', 'explicit approval completes without auto-retry');
  await page.locator(`[data-task-id="${repeated.id}"]`).click();
  await page.locator('[data-detail="handoff"]').click();
  await page.locator('#checkpoint-text').fill('核心恢复规则已验证；下一步接入实际项目任务。');
  await page.locator('#checkpoint-form').getByRole('button', { name: '保存检查点' }).click();
  await page.locator('#thread-chain').getByRole('button', { name: '查看历史 ↗' }).first().click();
  await page.locator('.history-entry').first().waitFor();
  await page.locator('#history-dialog .close-dialog').click(); checks.push('checkpoint and old-thread history usable from the panel');

  await page.locator('[data-view="settings"]').click();
  await page.locator('#setting-attempts').fill('5');
  await page.locator('#setting-error-window').fill('6');
  await page.locator('#setting-no-output').fill('12');
  await page.locator('#settings-form').getByRole('button', { name: '保存默认规则' }).click();
  await waitState(snapshot => snapshot.defaultPolicy.maxAutoAttempts === 5 && snapshot.defaultPolicy.errorWindowMs === 360000 && snapshot.defaultPolicy.noOutputTimeoutMs === 720000, 'error window and no-output timeout settings saved');
  await page.locator('#setting-attempts').fill('6'); await page.locator('#setting-error-window').fill('5'); await page.locator('#setting-no-output').fill('10');
  await page.locator('#setting-delay').fill('2'); await page.locator('#setting-max-delay').fill('30');
  await page.locator('#settings-form').getByRole('button', { name: '保存默认规则' }).click();
  await waitState(snapshot => snapshot.defaultPolicy.noOutputTimeoutMs === 600000 && snapshot.defaultPolicy.errorWindowMs === 300000, 'default five-minute window and ten-minute watchdog restored');
  await post('/settings', { policy: { rateLimitDelayMs: 15000 } });
  const screenshots = resolve('docs/assets'); mkdirSync(screenshots, { recursive: true });
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(screenshots, 'recovery-settings.png'), fullPage: true });
  await page.locator('[data-view="monitor"]').click();
  await page.locator('[data-detail="timeline"]').click();
  await page.locator('#task-filter').selectOption('attention');
  assert(await page.locator('#task-list .task-card').count() >= 2); checks.push('state filtering works');
  await page.locator('#task-filter').selectOption('all');

  assert((await page.locator('#retry-budget').textContent()).includes('同类错误 3/3'));
  assert((await page.locator('#failure-evidence').textContent()).includes('已满足判定'));
  checks.push('detail shows the actual threshold, time/output evidence and watchdog');
  await page.locator('#timeline .timeline-event').first().waitFor();
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(screenshots, 'dashboard.png'), fullPage: true });
  await page.locator('[data-view="alerts"]').click();
  const pendingBefore = (await state()).alerts.filter(alert => !alert.acknowledgedAt).length;
  await page.getByRole('button', { name: '确认告警' }).first().click();
  await waitState(snapshot => snapshot.alerts.filter(alert => !alert.acknowledgedAt).length === pendingBefore - 1, 'acknowledgment does not resume a task');
  await page.screenshot({ path: join(screenshots, 'alerts.png'), fullPage: true });
  await page.locator('[data-view="monitor"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile viewport must not overflow horizontally');
  await page.screenshot({ path: join(screenshots, 'mobile-layout.png'), fullPage: true }); checks.push('390px layout has no horizontal overflow');
  assert.deepEqual(errors, []); checks.push('no uncaught browser errors');
  const report = { testedAt: new Date().toISOString(), version: (await state()).version, browser: 'Chromium / local installed browser', checks, browserErrors: errors, desktop: '1600x1100', narrow: '390x844', screenshots: ['dashboard.png', 'alerts.png', 'mobile-layout.png', 'recovery-settings.png'] };
  writeFileSync(resolve('.work/ui-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { await browser.close(); }
