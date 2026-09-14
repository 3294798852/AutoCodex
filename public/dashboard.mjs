const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const labels = { starting: '启动中', running: '运行中', retry_wait: '等待恢复', recovering: '接续中', waiting_user: '等待用户', needs_attention: '需要处理', completed: '已完成', stopped: '已停止', failed: '接续已终止' };
const busyStates = ['starting', 'running', 'recovering', 'waiting_user'];
const observedLabels = { active_recent: '最近有活动', completed: '本回合已完成', interrupted: '本回合已中断', error: '记录了异常', waiting_user: '等待用户', unknown: '状态待确认', unavailable: '记录不可读' };
const observedPhase = task => task.assist?.connected && ({ running: 'running', retry_wait: 'retry_wait', sending: 'recovering', waiting_user: 'waiting_user', attention: 'needs_attention', completed: 'completed', stopped: 'stopped', failed: 'error' }[task.assist.phase]) || task.observation.phase;
const taskLabel = task => task.controlMode === 'observe' ? task.observation.enabled ? observedLabels[observedPhase(task)] || labels[observedPhase(task)] || '监测中' : '已停止监测' : labels[task.status] || task.status;
let state, selectedId, currentView = 'monitor', detailTab = 'timeline', detailData, eventStream, refreshTimer, toastTimer;
let requestVersion = 0, approvalSignature = '', operationBusy = false, seenAlerts = null;
let installationSettings, installationBusy = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function time(value, full = false) {
  if (!value) return '—';
  const date = new Date(value);
  return full ? date.toLocaleString('zh-CN', { hour12: false }) : date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function badge(task) { return element('span', `badge ${task.controlMode === 'observe' ? task.observation.enabled ? observedPhase(task) : 'stopped' : task.paused ? 'paused' : task.status}`, task.paused ? `${taskLabel(task)} · 已暂停恢复` : taskLabel(task)); }
function currentTask() { return state?.tasks.find(task => task.id === selectedId); }
function toast(text, error = false) {
  const node = $('#toast'); node.textContent = text; node.className = error ? 'toast error' : 'toast'; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, error ? 6500 : 3500);
}
async function api(path, data) {
  const response = await fetch(`/api/v1${path}`, data === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || '操作失败'); error.status = response.status; error.code = result.code; throw error; }
  return result;
}
async function refresh() { renderState(await api('/state')); }
function queueDetail() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void readDetail(), 140);
}
async function readDetail() {
  if (!selectedId) return;
  const id = selectedId, version = ++requestVersion;
  try {
    const result = await api(`/tasks/${id}`);
    if (id !== selectedId || version !== requestVersion) return;
    detailData = result; renderTimeline(result.events); renderHandoffs(result);
  } catch (error) { if (id === selectedId) toast(error.message, true); }
}

function renderState(next) {
  state = next; renderDnd();
  $('#app-version').textContent = `v${state.version}`;
  if (!selectedId || !state.tasks.some(task => task.id === selectedId)) selectedId = state.tasks[0]?.id;
  $('#app').hidden = false; $('#auth-screen').hidden = true;
  $('#mode-notice').hidden = state.mode !== 'demo';
  $('#mode-badge').textContent = state.mode === 'demo' ? '故障演练' : '本机监护';
  $('#mode-badge').className = `badge ${state.mode === 'demo' ? 'demo' : 'neutral'}`;
  $('#fatal-notice').hidden = !state.faulted;
  const alerts = state.alerts.filter(alert => !alert.acknowledgedAt);
  $('#metric-running').textContent = state.tasks.filter(task => ['starting', 'running', 'recovering'].includes(task.status) || task.controlMode === 'observe' && task.observation.enabled && task.observation.phase === 'active_recent').length;
  $('#metric-retries').textContent = state.tasks.reduce((sum, task) => sum + task.totalAutoAttempts, 0);
  $('#metric-alerts').textContent = alerts.length;
  $('#metric-completed').textContent = state.tasks.filter(task => task.status === 'completed' || task.controlMode === 'observe' && task.observation.phase === 'completed').length;
  $('#task-count').textContent = state.tasks.length;
  $('#nav-alert-count').textContent = alerts.length; $('#nav-alert-count').hidden = !alerts.length;
  $('#last-update').textContent = time(Date.now());
  $('#codex-dot').className = `dot ${state.connection.connected ? 'mint' : 'amber'}`;
  $('#codex-status').textContent = state.mode === 'demo' ? '故障演练环境已就绪' : state.connection.connected ? 'Codex 已连接 · 可选择已有会话'
    : state.connection.installation?.found === false ? '未找到 Codex · 请设置安装路径' : '尚未连接 Codex · 启动任务时自动连接';
  $('#codex-status').title = state.connection.detail || '';
  $('#connect-codex').hidden = state.mode === 'demo';
  $('#configure-codex').hidden = state.mode === 'demo';
  $('#existing-tasks').hidden = state.mode === 'demo'; $('#empty-existing').hidden = state.mode === 'demo';
  renderTaskList(); renderTaskDetail(); renderAlerts(); notifyNewAlerts(alerts); queueDetail();
}

function renderTaskList() {
  const query = $('#task-search').value.toLocaleLowerCase(), filter = $('#task-filter').value;
  const tasks = state.tasks.filter(task => {
    if (query && !`${task.name} ${task.cwd}`.toLocaleLowerCase().includes(query)) return false;
    if (filter === 'active') return [...busyStates, 'retry_wait', 'observing'].includes(task.status);
    if (filter === 'attention') return ['needs_attention', 'failed', 'waiting_user'].includes(task.status) || task.observation?.enabled && ['error', 'waiting_user', 'unavailable', 'unknown'].includes(task.observation.phase);
    return filter !== 'completed' || task.status === 'completed' || task.controlMode === 'observe' && task.observation?.phase === 'completed';
  });
  const list = $('#task-list'); list.replaceChildren();
  if (!tasks.length) { list.append(element('div', 'empty-list', state.tasks.length ? '没有符合筛选条件的任务' : '还没有监护任务\n点击“已有会话”选择正在使用的会话')); return; }
  for (const task of tasks) {
    const button = element('button', `task-card${selectedId === task.id ? ' selected' : ''}`);
    button.type = 'button'; button.dataset.taskId = task.id; button.setAttribute('aria-label', `${task.name}，${taskLabel(task)}`);
    button.setAttribute('aria-pressed', String(selectedId === task.id));
    const top = element('div', 'task-card-top'); top.append(element('span', 'task-glyph', task.threadChain.length > 1 ? '↗' : '⌘'), element('span', 'task-title', task.name));
    const path = element('div', 'task-card-path', task.cwd); path.title = task.cwd;
    const bottom = element('div', 'task-card-bottom'); bottom.append(badge(task));
    if (task.totalAutoAttempts) bottom.append(element('span', 'retry-count', `↻ ${task.totalAutoAttempts}`));
    const when = element('time', '', time(task.updatedAt).slice(0, 5)); when.dateTime = new Date(task.updatedAt).toISOString(); bottom.append(when);
    button.append(top, path, bottom);
    button.addEventListener('click', () => selectTask(task.id)); list.append(button);
  }
}

function selectTask(id) {
  selectedId = id; approvalSignature = ''; detailData = null;
  $('#checkpoint-text').value = '';
  delete $('#checkpoint-text').dataset.dirty;
  setView('monitor'); renderTaskList(); renderTaskDetail(); void readDetail();
}

function renderTaskDetail() {
  const task = currentTask();
  $('#detail-empty').hidden = !!task; $('#task-detail').hidden = !task;
  if (!task) return;
  $('#detail-name').textContent = task.name;
  const status = badge(task); status.id = 'detail-status'; $('#detail-status').replaceWith(status);
  $('#detail-cwd').textContent = `⌁ ${task.cwd}`;
  $('#detail-model').textContent = task.mode === 'demo' ? '模拟 Codex 会话' : task.model || 'Codex 默认模型';
  $('#detail-objective').textContent = task.prompt;
  const observe = task.controlMode === 'observe';
  $('#managed-toolbar').hidden = observe; $('#managed-recovery').hidden = observe && !task.assist?.autoContinue;
  $('#observation-info').hidden = !observe; $('#observation-toolbar').hidden = !observe;
  $('#desktop-assist').hidden = !observe;
  if (observe) {
    const o = task.observation;
    $('#observation-info').textContent = `${o.enabled ? '正在跟踪原会话的本机记录。' : '监测已停止。'}最近活动：${time(o.lastActivityAt, true)}；最近检查：${time(o.checkedAt, true)}。${o.phase === 'unknown' ? '目前无法确认是否仍在执行，请结合原客户端查看。' : ''}${o.phase === 'error' ? task.lastError?.message || '' : ''}${o.readError || ''}${o.coverage || ''}${o.lastControlError ? '上次移交未成功，监测状态已保留。' : ''}`;
    const a = task.assist || {}, phases = { running: '运行中', retry_wait: '等待续发', sending: '正在续发', waiting_user: '等待用户', attention: '需要核对', completed: '本轮完成', stopped: '已停止', failed: '本轮异常', idle: '已连接' };
    $('#desktop-assist-status').textContent = !o.enabled ? '监测已停止' : !a.connected ? '未连接原窗口' : a.blocked ? '需要核对' : phases[a.phase] || '已连接';
    $('#assist-continue').checked = !!a.autoContinue; $('#assist-approve').checked = !!a.autoApprove;
    $('#assist-continue').disabled = operationBusy; $('#assist-approve').disabled = operationBusy;
    $('#assist-reset').hidden = !a.blocked; $('#assist-reset').disabled = operationBusy;
    $('#assist-detail').textContent = a.reason || (!a.connected ? '原桌面辅助连接未就绪' : `自动续发 ${task.totalAutoAttempts} 次 · 同类错误 ${task.incident.consecutiveSame}/${task.incident.threshold} · 已开启免打扰 ${state.dnd.enabledCount}/5`);
    $('#observation-toggle').textContent = o.enabled ? '停止监测' : '恢复监测';
    for (const selector of ['#observation-refresh', '#observation-toggle', '#observation-adopt']) $(selector).disabled = operationBusy;
    $('#observation-refresh').disabled ||= !o.enabled;
  }
  $('#pause-task').textContent = task.paused ? '恢复监护' : '暂停恢复';
  const active = busyStates.includes(task.status) || task.status === 'retry_wait';
  $('#pause-task').disabled = operationBusy || !active || task.outputMonitor?.blocked;
  $('#continue-task').disabled = operationBusy || active || !task.threadId || !!task.pendingActionId;
  $('#replace-task').disabled = operationBusy || active || !task.threadId || !!task.pendingActionId;
  $('#reconcile-task').disabled = operationBusy || !task.threadId || ['completed', 'stopped', 'failed', 'waiting_user'].includes(task.status);
  $('#stop-task').disabled = operationBusy || ['completed', 'stopped', 'failed'].includes(task.status);
  if (document.activeElement !== $('#task-strategy')) $('#task-strategy').value = task.policy.strategy;
  $('#task-strategy').disabled = operationBusy;
  const incident = task.status === 'completed' ? task.lastIncident || task.incident : task.incident;
  const threshold = incident.threshold || (incident.version === 2 ? 3 : 2);
  $('#retry-budget').textContent = `累计继续 ${incident.autoAttempts} · 无输出期间 ${incident.attemptsWithoutOutput ?? incident.autoAttempts}/${task.policy.maxAutoAttempts} · ${incident.version === 2 ? '同类错误' : '旧规则续发失败'} ${incident.consecutiveSame}/${threshold}`;
  const match = incident.match;
  $('#failure-evidence').textContent = match?.enough
    ? match.triggered ? `已满足判定：最近 ${threshold} 次${match.withinWindow ? `发生在 ${Math.round(match.spanMs / 1000)} 秒内` : '之间没有有效输出'}。`
      : `最近 ${threshold} 次跨越 ${Math.round(match.spanMs / 60000)} 分钟且期间有有效输出，继续观察。`
    : `普通错误连续 3 次；容量不足、临时限流连续 5 次。包含首次错误，且需在 ${task.policy.errorWindowMs / 60000} 分钟内发生或期间无有效输出。`;
  $('#session-count').textContent = `会话 ${task.threadChain.length} 个`;
  const steps = [
    ['1', '异常确认', !!task.lastError || incident.autoAttempts > 0],
    ['2', `自动继续 ${incident.autoAttempts}`, incident.autoAttempts > 0],
    ['3', `同类错误 ${incident.consecutiveSame}/${threshold}`, !!incident.match?.triggered],
    ['4', task.threadChain.length > 1 ? '新会话接续' : '按策略处理', task.threadChain.length > 1 || ['needs_attention', 'failed'].includes(task.status)],
  ];
  $('#recovery-track').replaceChildren(...steps.map(([number, title, done], index) => {
    const current = task.status === 'retry_wait' && (task.retryPlan === 'replace' ? index === 3 : index === 1);
    const node = element('div', `recovery-step${done ? ' done' : ''}${current ? ' current' : ''}`);
    node.append(element('i', '', done && !current ? '✓' : number), element('span', '', title)); return node;
  }));
  $('#latest-output').textContent = task.lastOutput || '尚无助手输出。工具执行和恢复活动会显示在事件时间线中。';
  renderRetry(); renderApprovals(task);
}

function renderRetry() {
  const task = currentTask();
  if (!task) return;
  const monitor = task.outputMonitor;
  if (monitor) {
    const elapsed = Math.max(0, (monitor.suspendedAt ?? Date.now()) - monitor.sinceAt);
    $('#output-watch').textContent = monitor.blocked ? '长期无输出保护已触发：自动恢复保持停止，请核对后手动接续。'
      : ['completed', 'stopped', 'failed', 'needs_attention'].includes(task.status) || task.controlMode === 'observe' && !task.assist?.sessionActive ? `最后有效输出：${time(monitor.lastEffectiveAt, true)}`
      : `无有效输出 ${Math.floor(elapsed / 60000)} 分 ${Math.floor(elapsed / 1000) % 60} 秒 / ${task.policy.noOutputTimeoutMs / 60000} 分钟${monitor.suspendedAt !== null ? ' · 等待用户期间计时暂停' : ''}`;
    $('#output-watch').className = monitor.blocked ? 'recovery-note danger-text' : 'recovery-note';
  }
  if (task.controlMode === 'observe') {
    $('#retry-banner').hidden = !task.assist?.dueAt || task.assist.blocked || !task.observation.enabled;
    $('#retry-message').textContent = `${Math.max(0, Math.ceil(((task.assist?.dueAt || Date.now()) - Date.now()) / 1000))} 秒后在原 Codex 接续`;
    return;
  }
  $('#retry-banner').hidden = task.status !== 'retry_wait';
  if (task.status !== 'retry_wait') return;
  const remaining = Math.max(0, Math.ceil((task.retryDueAt - Date.now()) / 1000));
  const action = task.retryPlan === 'replace' ? '创建新会话并接续' : task.retryPlan === 'reconcile' ? '重新连接并核对历史' : '自动发送继续';
  $('#retry-message').textContent = task.paused ? `自动恢复已暂停 · 原计划：${action}` : `${remaining} 秒后${action}`;
}

function renderTimeline(events) {
  const list = $('#timeline'); list.replaceChildren();
  if (!events.length) { list.append(element('li', 'muted', '还没有事件')); return; }
  for (const event of [...events].reverse()) {
    const level = ['completed', 'checkpoint_saved', 'handoff_saved'].includes(event.type) ? 'success' : event.level;
    const row = element('li', `timeline-event ${level}`);
    const body = element('div'); body.append(element('div', 'timeline-message', event.message));
    const extra = element('div', 'timeline-extra');
    if (event.data?.error?.message) {
      const details = element('details'); details.append(element('summary', '', '查看错误详情'), element('pre', '', event.data.error.message)); extra.append(details);
    } else if (event.type === 'agent_message' && event.data.text) extra.textContent = event.data.text.slice(0, 180);
    if (extra.childNodes.length || extra.textContent) body.append(extra);
    const when = element('time', '', time(event.createdAt)); when.title = time(event.createdAt, true);
    row.append(element('span', 'timeline-dot'), body, when); list.append(row);
  }
}

function renderHandoffs(data) {
  const task = currentTask(); if (!task) return;
  $('#thread-chain').replaceChildren(...task.threadChain.map((thread, index) => {
    const row = element('div', 'thread-entry');
    const label = element('div', '', `${index === 0 ? '原始会话' : `接续会话 ${index}`}${task.threadId === thread.id ? ' · 当前' : ''}`);
    label.append(element('small', '', thread.id));
    const view = element('button', 'text-button', '查看历史 ↗'); view.type = 'button'; view.addEventListener('click', () => void showHistory(thread.id));
    row.append(element('span', 'mint-text', index === 0 ? '○' : '↳'), label, view); return row;
  }));
  $('#handoff-list').replaceChildren(...data.handoffs.map(packet => {
    const card = element('div', 'handoff-card', `交接材料已保存 · ${time(packet.createdAt, true)}`);
    const button = element('button', 'text-button', '阅读交接内容 ↗'); button.type = 'button';
    button.addEventListener('click', () => showPacket(packet)); card.append(button); return card;
  }));
  if (data.checkpoint && document.activeElement !== $('#checkpoint-text') && !$('#checkpoint-text').dataset.dirty) $('#checkpoint-text').value = data.checkpoint.text;
}

async function showHistory(threadId) {
  $('#history-title').textContent = '会话历史'; $('#history-content').replaceChildren(element('p', 'muted', '正在读取历史…')); $('#history-dialog').showModal();
  try {
    const result = await api(`/history/${encodeURIComponent(threadId)}`);
    $('#history-title').textContent = result.name;
    const container = $('#history-content'); container.replaceChildren();
    if (result.warning) container.append(element('p', 'settings-note', result.warning));
    container.append(element('p', 'panel-description', `会话 ID：${threadId}`));
    for (const entry of result.history) {
      const row = element('article', `history-entry ${entry.role}`);
      const role = { userMessage: '用户', agentMessage: 'Codex', commandExecution: '命令执行', fileChange: '文件修改', error: '错误' }[entry.role] || '工具';
      row.append(element('strong', '', role), element('pre', '', entry.text)); container.append(row);
    }
    if (!result.history.length) container.append(element('p', 'muted', '暂无可用的会话历史，可在任务时间线查看已保存事件。'));
  } catch (error) { $('#history-content').replaceChildren(element('p', 'form-error', error.message)); }
}

function showPacket(packet) {
  $('#history-title').textContent = '会话交接材料';
  const container = $('#history-content'); container.replaceChildren();
  for (const [title, text] of [
    ['旧对话链接', packet.source.url], ['原始目标', packet.objective], ['最新检查点', packet.checkpoint?.text || '没有显式检查点'],
    ['接续约束', packet.boundaries], ['近期历史', packet.history.map(item => `${item.role}\n${item.text}`).join('\n\n')],
  ]) { const section = element('article', 'history-entry'); section.append(element('strong', '', title), element('pre', '', text)); container.append(section); }
  $('#history-dialog').showModal();
}

function renderAlerts() {
  const list = $('#alerts-list'); list.replaceChildren();
  if (!state.alerts.length) { list.append(element('div', 'empty-list', '暂无告警。新的异常与处理建议会显示在这里。')); return; }
  for (const alert of state.alerts) {
    const row = element('article', `alert-card${alert.acknowledgedAt ? ' acknowledged' : ''}`);
    const body = element('div', 'alert-body'); body.append(element('div', 'alert-title', alert.title));
    const task = state.tasks.find(task => task.id === alert.taskId);
    const meta = element('div', 'alert-meta'); meta.append(element('span', '', task?.name || '监护任务'), element('time', '', time(alert.createdAt, true)), element('span', '', alert.acknowledgedAt ? '已确认' : '尚未确认')); body.append(meta);
    const actions = element('div', 'alert-actions');
    const view = element('button', 'button compact', '查看任务'); view.addEventListener('click', () => selectTask(alert.taskId)); actions.append(view);
    if (!alert.acknowledgedAt) {
      const ack = element('button', 'button compact secondary', '确认告警');
      ack.addEventListener('click', async () => { try { await api(`/alerts/${alert.id}/ack`, {}); await refresh(); } catch (error) { toast(error.message, true); } }); actions.append(ack);
    }
    row.append(element('span', 'alert-indicator', alert.severity === 'warning' ? '◇' : '!'), body, actions); list.append(row);
  }
}

function renderApprovals(task) {
  if (task.controlMode === 'observe') {
    $('#dnd-task-info').textContent = `原窗口自动批准 ${task.totalAutoApprovals || 0} 次 · ${task.assist?.connected ? '回收站工具已接入' : '辅助连接未就绪'}`;
    $('#approval-list').replaceChildren(); return;
  }
  $('#dnd-task-info').textContent = '免打扰自动处理 ' + (task.totalAutoApprovals || 0) + ' 次 · 回收站工具' + (task.recycleToolAvailable ? '已接入' : state.mode === 'demo' ? '仅演练' : '需在本版本新建会话接入');
  const requests = state.approvals.filter(request => request.taskId === task.id);
  const signature = `${task.id}:${requests.map(request => request.id).join(',')}`;
  if (signature === approvalSignature) return;
  approvalSignature = signature;
  const list = $('#approval-list'); list.replaceChildren();
  for (const request of requests) {
    const form = element('form', 'approval-card'); form.append(element('h3', '', '需要你的决定'));
    if (request.automation?.reason) form.append(element('p', 'settings-note', '保留人工：' + request.automation.reason));
    if (request.previewLimited) form.append(element('p', 'settings-note', '此预览含脱敏或省略内容，请先核对原始操作再决定是否批准。'));
    form.append(element('p', '', request.params.reason || request.params.message || 'Codex 正在等待此项操作。'));
    const questionFields = new Map(), contentFields = new Map();
    const isQuestion = request.method.endsWith('requestUserInput');
    const isElicitation = request.method === 'mcpServer/elicitation/request';
    if (isQuestion) {
      for (const question of request.params.questions || []) {
        const label = element('label', '', question.question);
        const input = element('input'); input.type = question.isSecret ? 'password' : 'text'; input.required = true; input.autocomplete = 'off';
        if (question.options?.length) input.placeholder = question.options.map(option => option.label).join(' / ');
        label.append(input); form.append(label); questionFields.set(question.id, input);
      }
    } else if (isElicitation && request.params.mode !== 'url') {
      for (const [name, property] of Object.entries(request.params.requestedSchema?.properties || {})) {
        const label = element('label', '', property.title || property.description || name), input = element('input');
        input.type = property.type === 'boolean' ? 'checkbox' : property.type === 'number' || property.type === 'integer' ? 'number' : 'text';
        input.required = request.params.requestedSchema.required?.includes(name) && input.type !== 'checkbox';
        label.append(input); form.append(label); contentFields.set(name, input);
      }
    }
    if (!isQuestion) {
      const preview = request.method === 'item/tool/call' ? '移入回收站：\n' + JSON.stringify(request.params.arguments?.paths || [], null, 2) : request.params.command || request.item?.command || JSON.stringify(request.params.permissions || request.item?.changes || request.params, null, 2);
      const details = element('details'); details.open = !!request.params.command;
      details.append(element('summary', '', '查看具体操作'), element('pre', '', preview)); form.append(details);
      if (isElicitation && request.params.mode === 'url') form.append(element('p', 'settings-note', '这是外部授权流程，请核对具体操作中的链接并在原服务完成授权。'));
    }
    const buttons = element('div', 'approval-buttons');
    const choices = isQuestion ? [['answered', '提交答案']] : [['accept', isElicitation ? '确认' : '仅批准本次'], ['decline', '拒绝'], ...(request.method === 'item/permissions/requestApproval' ? [] : [['cancel', '取消']])];
    for (const [decision, title] of choices) {
      if (!isQuestion && request.params.availableDecisions && !request.params.availableDecisions.includes(decision)) continue;
      const button = element('button', `button compact${decision === 'decline' ? '' : ' secondary'}`, title); button.type = 'submit'; button.value = decision; button.name = 'decision';
      if (decision === 'decline' || decision === 'cancel') button.formNoValidate = true;
      buttons.append(button);
    }
    form.append(buttons);
    form.addEventListener('submit', async event => {
      event.preventDefault(); const decision = event.submitter?.value || (isQuestion ? 'answered' : 'accept');
      const data = isQuestion ? { answers: Object.fromEntries([...questionFields].map(([id, input]) => [id, input.value])) }
        : { decision, ...(isElicitation ? { content: Object.fromEntries([...contentFields].map(([name, input]) => [name, input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value])) } : {}) };
      for (const button of buttons.querySelectorAll('button')) button.disabled = true;
      try { await api(`/approvals/${request.id}/respond`, data); toast('已提交你的决定'); await refresh(); }
      catch (error) { toast(error.message, true); for (const button of buttons.querySelectorAll('button')) button.disabled = false; }
    });
    list.append(form);
  }
}

function setView(view) {
  currentView = view;
  for (const item of $$('.view')) item.hidden = item.id !== `view-${view}`;
  for (const button of $$('.nav-item')) button.classList.toggle('active', button.dataset.view === view);
  $('#page-title').textContent = { monitor: '运行监测', alerts: '告警中心', settings: '恢复设置' }[view];
  $('#page-subtitle').textContent = { monitor: '掌握任务进展，让每一次异常都有记录。', alerts: '查看需要留意的异常，决定下一步如何继续。', settings: '按你的工作习惯，设定自动恢复的边界。' }[view];
  if (view === 'settings') { fillSettings(); void loadCodexSettings(); }
}

function renderCodexSettings(settings) {
  installationSettings = settings;
  $('#codex-config-note').textContent = settings.message;
  $('#codex-path-controls').hidden = !settings.enabled;
  $('#codex-installation-badge').textContent = !settings.enabled ? '演练无需安装' : settings.installation?.found ? '已找到程序' : '需要配置';
  if (!settings.enabled) return;
  $('#codex-source').textContent = [settings.source, settings.installation?.source].filter(Boolean).join(' · ');
  $('#codex-current-path').textContent = settings.installation?.path || settings.installation?.error || '未找到 Codex CLI';
  if (!$('#codex-path-input').dataset.dirty) $('#codex-path-input').value = settings.locked ? settings.activeCommand : settings.savedCommand;
  $('#codex-save').disabled = settings.locked || installationBusy;
  $('#codex-detect').disabled = installationBusy;
  $('#codex-restart-note').hidden = !settings.restartRequired;
}

async function loadCodexSettings() {
  try { renderCodexSettings(await api('/codex')); }
  catch (error) { $('#codex-config-note').textContent = error.message; }
}

async function updateCodexPath(save) {
  if (installationBusy) return;
  installationBusy = true; renderCodexSettings(installationSettings);
  const resultNode = $('#codex-path-result');
  resultNode.className = 'installation-result'; resultNode.textContent = '正在检测…';
  try {
    const result = await api(save ? '/codex' : '/codex/detect', { command: $('#codex-path-input').value });
    if (save) {
      delete $('#codex-path-input').dataset.dirty; renderCodexSettings(result);
      resultNode.textContent = result.restartRequired ? '已保存，请重启守护服务后使用新路径。' : '设置已保存，与本次启动配置相同。';
    } else {
      resultNode.textContent = result.found ? `找到程序：${result.path}（${result.source}）。保存并重启后，可在运行监测页“检查连接”。` : result.error;
      resultNode.classList.toggle('danger-text', !result.found);
    }
  } catch (error) { resultNode.textContent = error.message; resultNode.classList.add('danger-text'); }
  finally { installationBusy = false; renderCodexSettings(installationSettings); }
}

function fillSettings() {
  renderDnd();
  if (!state) return;
  const policy = state.defaultPolicy;
  $('#setting-strategy').value = policy.strategy; $('#setting-attempts').value = policy.maxAutoAttempts;
  $('#setting-delay').value = policy.baseDelayMs / 1000; $('#setting-max-delay').value = policy.maxDelayMs / 1000;
  $('#setting-window').value = policy.immediateFailureMs / 1000;
  $('#setting-error-window').value = policy.errorWindowMs / 60000;
  $('#setting-no-output').value = policy.noOutputTimeoutMs / 60000;
  notificationStatus();
}

function openCreate() {
  $('#create-form').reset(); $('#create-error').textContent = '';
  $('#adopt-fields').hidden = true; $('#create-thread').required = false;
  $('#create-cwd').value = currentTask()?.cwd || state.defaultCwd || '';
  $('#create-strategy').value = state.defaultPolicy.strategy;
  $('#scenario-field').hidden = state.mode !== 'demo';
  $('#create-mode').disabled = state.mode === 'demo';
  $('#create-scenario').replaceChildren(...(state.scenarios || []).map(scenario => { const option = element('option', '', scenario.name); option.value = scenario.id; return option; }));
  if (state.mode === 'demo') { $('#create-name').value = '恢复流程演练'; $('#create-prompt').value = '演练 Codex 遇到异常后的自动继续、告警和会话接续流程。'; }
  $('#create-dialog').showModal(); $('#create-name').focus();
}

async function control(action, extra = {}) {
  if (operationBusy || !selectedId) return;
  operationBusy = true; renderTaskDetail();
  try { await api(`/tasks/${selectedId}/control`, { action, ...extra }); await refresh(); toast('任务操作已完成'); }
  catch (error) { toast(error.message, true); }
  finally { operationBusy = false; renderTaskDetail(); }
}

let existingCursor = null, existingLoading = false, existingQuery = '', existingArchived = false, adoptTaskId = null;
async function loadExisting(more = false) {
  if (existingLoading) return;
  existingLoading = true; $('#existing-refresh').disabled = true; $('#existing-more').disabled = true;
  $('#existing-error').textContent = ''; $('#existing-status').textContent = '正在读取本机 Codex 会话…';
  if (!more) { existingCursor = null; existingQuery = $('#existing-search').value.trim(); existingArchived = $('#existing-archive').value === 'true'; $('#existing-list').replaceChildren(); }
  try {
    const query = new URLSearchParams({ search: existingQuery, archived: String(existingArchived), ...(more && existingCursor ? { cursor: existingCursor } : {}) });
    const page = await api('/threads?' + query);
    for (const thread of page.data) {
      const row = element('article', 'existing-row'), description = element('div');
      description.append(element('strong', '', thread.name), element('small', '', thread.cwd || '未记录工作目录'), element('small', '', `更新于 ${time(thread.updatedAt, true)} · ${thread.model || thread.source}`));
      const button = element('button', 'button compact secondary', thread.taskId ? '查看监测' : '加入监测'); button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true; $('#existing-error').textContent = '';
        try {
          const taskId = thread.taskId || (await api('/observations', { threadId: thread.id })).id;
          await refresh(); $('#existing-dialog').close(); selectTask(taskId); toast('已打开原会话监测');
        } catch (error) { $('#existing-error').textContent = error.message; }
        finally { button.disabled = false; }
      });
      row.append(description, button); $('#existing-list').append(row);
    }
    existingCursor = page.nextCursor;
    $('#existing-more').hidden = !existingCursor;
    $('#existing-status').textContent = $('#existing-list').children.length ? '点击加入后，原会话下次活动也会持续更新。' : '未找到会话。可更换搜索词或会话范围；若使用了其他 Codex 数据目录，请用相同的 CODEX_HOME 启动本服务。';
  } catch (error) { $('#existing-error').textContent = error.message; $('#existing-status').textContent = '读取失败，可点击“查找 / 刷新”重试。'; }
  finally { existingLoading = false; $('#existing-refresh').disabled = false; $('#existing-more').disabled = false; }
}
function openExisting() { $('#existing-dialog').showModal(); void loadExisting(); }

function notificationStatus() {
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const enabled = localStorage.getItem('autocodex-notifications') === 'on';
  $('#notification-status').textContent = permission === 'granted' && enabled ? '已开启 · 仅新告警触发通知' : permission === 'denied' ? '浏览器已阻止通知，可在网站设置中修改' : permission === 'unsupported' ? '此浏览器不支持桌面通知' : '关闭时，告警仍会保存在面板';
  $('#notification-toggle').textContent = permission === 'granted' && enabled ? '关闭桌面通知' : '开启桌面通知';
}
function notifyNewAlerts(alerts) {
  if (seenAlerts === null) { seenAlerts = new Set(alerts.map(alert => alert.id)); return; }
  for (const alert of alerts) if (!seenAlerts.has(alert.id)) {
    seenAlerts.add(alert.id);
    if ('Notification' in window && Notification.permission === 'granted' && localStorage.getItem('autocodex-notifications') === 'on') {
      const notification = new Notification('AutoCodex 监护提醒', { body: alert.title, tag: alert.id });
      notification.onclick = () => { window.focus(); selectTask(alert.taskId); notification.close(); };
    }
  }
}

for (const button of $$('.nav-item')) button.addEventListener('click', () => setView(button.dataset.view));
for (const button of $$('.close-dialog')) button.addEventListener('click', () => button.closest('dialog').close());
for (const button of $$('.detail-tab')) button.addEventListener('click', () => {
  detailTab = button.dataset.detail;
  for (const tab of $$('.detail-tab')) { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); }
  for (const content of $$('.detail-content')) content.hidden = content.id !== `detail-${detailTab}`;
});
$('#task-search').addEventListener('input', renderTaskList); $('#task-filter').addEventListener('change', renderTaskList);
$('#new-task').addEventListener('click', openCreate); $('#empty-create').addEventListener('click', openCreate);
$('#existing-tasks').addEventListener('click', openExisting); $('#empty-existing').addEventListener('click', openExisting);
$('#existing-search-form').addEventListener('submit', event => { event.preventDefault(); void loadExisting(); });
$('#existing-archive').addEventListener('change', () => void loadExisting());
$('#existing-more').addEventListener('click', () => void loadExisting(true));
$('#observation-refresh').addEventListener('click', () => void control('observe_refresh'));
async function saveAssist(input) {
  const task = currentTask(); if (!task || operationBusy) return;
  operationBusy = true;
  try { await api(`/tasks/${task.id}/assist`, { revision: task.assist?.revision || 0, ...input }); await refresh(); }
  catch (error) { toast(error.message, true); await refresh(); }
  finally { operationBusy = false; renderTaskDetail(); }
}
$('#assist-continue').addEventListener('change', event => void saveAssist({ autoContinue: event.target.checked }));
$('#assist-approve').addEventListener('change', event => void saveAssist({ autoApprove: event.target.checked }));
$('#assist-reset').addEventListener('click', () => void saveAssist({ reset: true }));
$('#observation-toggle').addEventListener('click', () => void control(currentTask().observation.enabled ? 'observe_stop' : 'observe_start'));
$('#observation-adopt').addEventListener('click', () => {
  adoptTaskId = selectedId; $('#adopt-form').reset(); $('#adopt-error').textContent = currentTask().observation.lastControlError?.message || '';
  $('#adopt-name').textContent = currentTask().name; $('#adopt-dialog').showModal();
});
$('#adopt-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#adopt-submit').disabled = true; $('#adopt-error').textContent = '';
  try {
    await api(`/tasks/${adoptTaskId}/control`, { action: 'adopt', ownershipConfirmed: $('#adopt-confirm').checked, message: $('#adopt-message').value });
    $('#adopt-dialog').close(); await refresh(); selectTask(adoptTaskId); toast('原会话已移交并接续');
  } catch (error) {
    $('#adopt-error').textContent = error.message;
    if (error.code === 'thread_in_use') await refresh();
  }
  finally { $('#adopt-submit').disabled = false; }
});
$('#pause-task').addEventListener('click', () => void control(currentTask().paused ? 'resume' : 'pause'));
$('#continue-task').addEventListener('click', () => void control('continue'));
$('#replace-task').addEventListener('click', () => void control('new_session'));
$('#stop-task').addEventListener('click', () => void control('stop'));
$('#reconcile-task').addEventListener('click', () => void control('reconcile'));
$('#task-strategy').addEventListener('change', () => void control('policy', { policy: { strategy: $('#task-strategy').value } }));
$('#connect-codex').addEventListener('click', async () => { $('#connect-codex').disabled = true; try { await api('/connect', {}); await refresh(); toast('Codex 连接检查通过'); } catch (error) { toast(error.message, true); } finally { $('#connect-codex').disabled = false; } });
$('#configure-codex').addEventListener('click', () => setView('settings'));
$('#codex-path-input').addEventListener('input', () => { $('#codex-path-input').dataset.dirty = 'true'; });
$('#codex-detect').addEventListener('click', () => void updateCodexPath(false));
$('#codex-path-form').addEventListener('submit', event => { event.preventDefault(); void updateCodexPath(true); });
$('#create-mode').addEventListener('change', () => { const adopt = $('#create-mode').value === 'adopt'; $('#adopt-fields').hidden = !adopt; $('#create-thread').required = adopt; $('#ownership-confirm').required = adopt; });
$('#create-scenario').addEventListener('change', () => { const value = $('#create-scenario').value; $('#create-strategy').value = ['failover', 'fallback_fails'].includes(value) ? 'new_session' : 'manual'; $('#create-name').value = state.scenarios.find(s => s.id === value)?.name || '恢复流程演练'; });
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#create-error').textContent = ''; $('#create-submit').disabled = true;
  const adopt = $('#create-mode').value === 'adopt';
  try {
    const task = await api('/tasks', { name: $('#create-name').value, prompt: $('#create-prompt').value, cwd: $('#create-cwd').value,
      model: $('#create-model').value, sandbox: $('#create-sandbox').value, policy: { strategy: $('#create-strategy').value },
      ...(state.mode === 'demo' ? { scenario: $('#create-scenario').value } : {}),
      ...(adopt ? { threadId: $('#create-thread').value, sourceUrl: $('#create-source-url').value, ownershipConfirmed: $('#ownership-confirm').checked } : {}),
    });
    $('#create-dialog').close(); await refresh(); selectTask(task.id);
    toast(task.status === 'needs_attention' ? '任务已保存，请查看连接或启动错误' : '任务已加入监护');
  } catch (error) { $('#create-error').textContent = error.message; }
  finally { $('#create-submit').disabled = false; }
});
$('#checkpoint-text').addEventListener('input', () => { $('#checkpoint-text').dataset.dirty = 'true'; });
$('#checkpoint-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!selectedId) return;
  try { await api(`/tasks/${selectedId}/checkpoint`, { text: $('#checkpoint-text').value }); delete $('#checkpoint-text').dataset.dirty; toast('检查点已保存'); await readDetail(); } catch (error) { toast(error.message, true); }
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/settings', { policy: { strategy: $('#setting-strategy').value, maxAutoAttempts: Number($('#setting-attempts').value),
      baseDelayMs: Math.round(Number($('#setting-delay').value) * 1000), maxDelayMs: Math.round(Number($('#setting-max-delay').value) * 1000), immediateFailureMs: Math.round(Number($('#setting-window').value) * 1000),
      errorWindowMs: Math.round(Number($('#setting-error-window').value) * 60000), noOutputTimeoutMs: Math.round(Number($('#setting-no-output').value) * 60000) } });
    await refresh(); toast('默认规则已保存，之后创建的任务会使用这些设置');
  } catch (error) { toast(error.message, true); }
});
$('#notification-toggle').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted' && localStorage.getItem('autocodex-notifications') === 'on') localStorage.setItem('autocodex-notifications', 'off');
  else if (await Notification.requestPermission() === 'granted') localStorage.setItem('autocodex-notifications', 'on');
  notificationStatus();
});
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#auth-error').textContent = '';
  try { await api('/session', { token: $('#auth-token').value.trim() }); $('#auth-token').value = ''; await initialize(); } catch (error) { $('#auth-error').textContent = error.message; }
});

function subscribe() {
  eventStream?.close();
  eventStream = new EventSource('/api/v1/events');
  eventStream.onopen = () => { $('#connection-notice').hidden = true; $('#stream-status').replaceChildren(element('i', 'dot mint'), document.createTextNode('实时连接')); };
  eventStream.onerror = () => { $('#connection-notice').hidden = false; $('#stream-status').replaceChildren(element('i', 'dot amber'), document.createTextNode('连接重试中')); };
  eventStream.addEventListener('snapshot', event => { try { renderState(JSON.parse(event.data)); } catch { toast('状态更新失败，正在重新读取', true); void refresh().catch(() => {}); } });
}
async function initialize() {
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.has('token')) {
      const token = fragment.get('token');
      history.replaceState(null, '', location.pathname + location.search);
      await api('/session', { token });
    }
    await refresh(); subscribe();
    const historyId = location.pathname.match(/^\/history\/([a-zA-Z0-9_-]+)$/)?.[1];
    if (historyId) await showHistory(historyId);
  } catch (error) {
    if (error.status === 401) { $('#auth-screen').hidden = false; $('#app').hidden = true; }
    else { $('#auth-screen').hidden = false; $('#auth-error').textContent = `无法连接本机服务：${error.message}`; }
  }
}
setInterval(() => { $('#clock').textContent = new Date().toLocaleString('zh-CN', { hour12: false }); renderRetry(); }, 1000);

const dndKeys = ['outsideWorkspace', 'commonCommands', 'recycleDeletes', 'systemTools', 'confirmationPrompts'];
let dndBusy = false;
function renderDnd() {
  if (!state?.dnd) return;
  const dnd = state.dnd, settings = dnd.settings;
  for (const key of dndKeys) { const input = $('#dnd-' + key); input.checked = settings[key]; input.disabled = dndBusy || key === 'recycleDeletes' && !dnd.recycleSupported; }
  const allEnabled = dndKeys.filter(key => key !== 'recycleDeletes' || dnd.recycleSupported).every(key => settings[key]);
  $('#dnd-all').checked = allEnabled;
  $('#dnd-all').indeterminate = dnd.enabledCount > 0 && !allEnabled;
  $('#dnd-all').disabled = dndBusy;
  $('#dnd-all-label').textContent = allEnabled ? '全部关' : '全部开';
  $('#dnd-count').textContent = '已开启 ' + dnd.enabledCount + ' / 5';
  $('#dnd-approved').textContent = dnd.autoApproved;
  $('#dnd-platform').textContent = dnd.recycleSupported ? 'Windows 回收站可用' : '当前平台未提供回收站';
  $('#dnd-roots-save').disabled = dndBusy;
  if (!$('#dnd-roots').dataset.dirty) $('#dnd-roots').value = settings.outsideRoots.join('\n');
  const records = $('#dnd-history'); records.replaceChildren();
  if (!dnd.recent.length) records.append(element('p', 'dnd-hint', '还没有批准记录。'));
  for (const entry of dnd.recent.slice(0, 12)) {
    const row = element('div', 'dnd-history-row');
    const source = entry.source === 'automatic' ? '自动' : entry.source === 'manual' ? '人工' : '待处理';
    const status = { answered: '已处理', uncertain: '结果待核对', pending: '等待决定', sending: '处理中', expired: '已失效', resolved: '已解决' }[entry.status] || entry.status;
    row.append(element('strong', '', source + ' · ' + status), element('time', '', time(entry.createdAt)));
    const task = state.tasks.find(task => task.id === entry.taskId);
    row.append(element('small', '', (task?.name || '历史任务') + ' · ' + (entry.automation?.reason || '用户决定')));
    records.append(row);
  }
  const metric = $('#dnd-monitor-summary');
  if (metric) metric.textContent = '免打扰 ' + dnd.enabledCount + '/5 · 自动处理 ' + dnd.autoApproved + ' 次';
}
async function saveDnd(changes) {
  if (dndBusy || !state?.dnd) return;
  const revision = state.dnd.settings.revision;
  dndBusy = true; renderDnd(); $('#dnd-save-status').textContent = '正在保存…';
  try {
    const result = await api('/dnd', { ...changes, revision });
    state.dnd = result;
    if (changes.outsideRoots) delete $('#dnd-roots').dataset.dirty;
    $('#dnd-save-status').textContent = '已保存，即时生效 · 已显示的待处理请求保持人工决定';
    await refresh();
  } catch (error) { $('#dnd-save-status').textContent = error.message; toast(error.message, true); await refresh().catch(() => {}); }
  finally { dndBusy = false; renderDnd(); }
}
for (const key of dndKeys) $('#dnd-' + key).addEventListener('change', event => { void saveDnd({ [key]: event.target.checked }); });
$('#dnd-all').addEventListener('change', event => { const enable = event.target.checked; void saveDnd(Object.fromEntries(dndKeys.map(key => [key, enable && (key !== 'recycleDeletes' || state.dnd.recycleSupported)]))); });
$('#dnd-roots').addEventListener('input', () => { $('#dnd-roots').dataset.dirty = 'true'; });
$('#dnd-roots-form').addEventListener('submit', event => { event.preventDefault(); void saveDnd({ outsideRoots: $('#dnd-roots').value.split('\n').map(value => value.trim()).filter(Boolean) }); });

void initialize();
