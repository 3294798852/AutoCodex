import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from './core/store.mjs';
import { Supervisor } from './core/supervisor.mjs';
import { CodexAdapter } from './adapters/codex.mjs';
import { DemoAdapter } from './adapters/demo.mjs';
import { createDashboardServer } from './server/http.mjs';
import { CodexSettings, readSavedCodexCommand, selectCodexCommand } from './server/codex-settings.mjs';
import { diagnoseCodex } from './adapters/codex-diagnostics.mjs';

const { values: args } = parseArgs({ options: {
  demo: { type: 'boolean' }, help: { type: 'boolean' }, 'diagnose-codex': { type: 'boolean' },
  port: { type: 'string' }, 'data-dir': { type: 'string' }, 'codex-command': { type: 'string' },
} });
if (args.help) {
  process.stdout.write('AutoCodex Guard\n  node src/main.mjs [--demo] [--port 3210] [--data-dir PATH] [--codex-command PATH]\n  node src/main.mjs --diagnose-codex [--codex-command PATH] [--data-dir PATH]\n\nPATH 可以是 Codex CLI 文件或安装目录。诊断不会创建任务或请求模型生成。\n');
  process.exit(0);
}
const mode = args.demo ? 'demo' : 'codex';
const port = Number(args.port ?? process.env.AUTOCODEX_PORT ?? '3210');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间');
const directory = resolve(args['data-dir'] || process.env.AUTOCODEX_DATA_DIR || `.autocodex/${mode === 'demo' ? 'demo' : 'live'}`);
if (args['diagnose-codex']) {
  try {
    const selected = selectCodexCommand({ command: args['codex-command'], saved: readSavedCodexCommand(directory) });
    process.stdout.write(JSON.stringify({ ok: true, selectionSource: selected.source, ...await diagnoseCodex(selected.command) }, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message, modelGenerationRequested: false }, null, 2) + '\n');
    process.exitCode = 1;
  }
} else {
const store = new Store(directory);
const adapter = mode === 'demo' ? new DemoAdapter() : new CodexAdapter({ priorWorkerPid: store.getMeta('codexWorkerPid') });
const codexSettings = new CodexSettings({ store, adapter, command: args['codex-command'] });
adapter.on('connected', state => { if (state.workerPid) store.setMeta('codexWorkerPid', state.workerPid); });
const supervisor = new Supervisor({ store, adapter });
const http = createDashboardServer(supervisor, { port, codexSettings, onShutdown: () => void shutdown() });
let exiting = false;

async function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  try { await Promise.all([supervisor.close(), http.close()]); store.close(); }
  finally { process.exitCode = code; }
}

supervisor.on('fatal', error => {
  process.stderr.write(`守护服务已停止派发：${error.message}\n`);
  void shutdown(1);
});
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  const address = await http.listen();
  process.stdout.write(`AutoCodex ${mode === 'demo' ? '故障演练' : '本机监护'}已启动：${address.origin}\n`);
  process.stdout.write(`打开面板：${address.launchPath}\n`);
  if (mode === 'codex') {
    const installation = adapter.state.installation;
    process.stdout.write(installation.found ? `Codex 程序：${installation.path}（${codexSettings.selection.source} / ${installation.source}）\n`
      : `${installation.error}\n面板仍可使用，请配置路径后重启。\n`);
  }
  await supervisor.recover();
  supervisor.start();
} catch (error) {
  process.stderr.write(`启动失败：${error.message}\n`);
  await shutdown(1);
}
}
