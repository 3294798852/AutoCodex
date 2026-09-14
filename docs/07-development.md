# 开发与接口说明

## 项目布局

```text
src/core/       错误归一化、恢复决策、有效输出计时、事务存储、监护编排、交接
src/adapters/   Codex JSONL/stdio 与故障演练
src/server/     本机认证、HTTP API、SSE 与静态面板
src/native/     Windows 回收站原生调用
public/         中文原生网页界面
plugins/        可校验的 Codex 插件、MCP 桥和技能
test/           行为、持久化、进程、API 与并发测试
scripts/        检查、真实 CLI 故障注入、浏览器验证和打包
docs/           分阶段设计、证据、运维和验收
```

所有运行模块使用 Node.js 内置库。浏览器验证需要开发环境外部提供 Playwright 和浏览器；插件 manifest/skill 校验使用系统技能附带的 Python 校验器，仅开发阶段需要 PyYAML。

0.4 Windows 回收站运行后端依赖系统自带 Windows PowerShell 与 Shell COM，无额外 npm 运行依赖。

## API v1

监听 `127.0.0.1`。管理接口接受 Bearer 口令或 HttpOnly SameSite=Strict cookie。浏览器从 URL fragment 交换 cookie 后清除 fragment。跨源 Origin、异常 Host、超大/非 JSON 请求均拒绝。仅公开页面 HTML 的顶层 GET 导航允许 Sec-Fetch-Site=cross-site，使本地 open-panel.html 跳转正常工作；API、认证交换、资源跨站请求和 iframe 不适用此例外。禁止远程跨域、外部脚本和 frame 嵌入。

启动入口回归：`npm run smoke:ui-launch` 在浏览器中打开服务实际生成的本地 HTML 文件，经过 meta refresh、口令交换、页面刷新后验证正常访问。它不直接跳到 HTTP URL，不创建模型任务；浏览器依赖配置与其他 UI 测试相同。

| 方法与路径 | 功能 |
|---|---|
| `GET /healthz` | 最小公开存活信息 |
| `POST /api/v1/session` | 口令换浏览器 cookie |
| `GET /api/v1/state` | 权威任务/告警/待处理请求快照 |
| `GET /api/v1/events` | SSE snapshot；自动重连后重新发送权威状态 |
| `POST /api/v1/connect` | 只做 Codex 连接与初始化 |
| `GET /api/v1/codex` | 当前选择、解析位置、保存路径及重启提示，仅面板管理员 |
| `POST /api/v1/codex/detect` | `{ command: "路径或空串" }`，只检查文件布局，不保存、不启动模型 |
| `POST /api/v1/codex` | 校验并持久化下次启动路径；空串重置自动发现；覆盖锁定时 409 |
| `POST /api/v1/tasks` | 创建任务或明确移交停止的历史线程 |
| `GET /api/v1/tasks/:id` | 任务、最近 200 事件、动作、检查点和交接 |
| `POST /api/v1/tasks/:id/control` | pause/resume/stop/continue/new_session/reconcile/policy |
| `POST /api/v1/tasks/:id/checkpoint` | 保存检查点 |
| `GET /api/v1/history/:threadId` | 受管历史或已保存快照 |
| `GET /api/v1/handoffs/:id` | 有界交接包 |
| `POST /api/v1/approvals/:id/respond` | 显式批准/拒绝或回答问题 |
| `GET /api/v1/dnd` | 免打扰设置、启用数、批准计数和近期记录，仅管理员 |
| `POST /api/v1/dnd` | 更新开关/工作区外目录；必须附当前 revision，冲突返回 409 |
| `POST /api/v1/alerts/:id/ack` | 确认告警，不恢复任务 |
| `POST /api/v1/settings` | 后续新任务的默认恢复规则 |
| `GET /api/v1/export` | 导出状态和最近 500 个事件 |
| `POST /api/v1/shutdown` | 正常关闭服务，仅独立主程序支持 |

接口输入限制为 64 KiB；错误返回 `{ error, code }` 和适当 HTTP 状态码。SSE 100 ms 合并推送、15 秒心跳，背压时等待 drain 并合并最新状态；10 秒无法排空才断开慢客户端。内部文本缓冲和指纹不随快照发送。首版无历史删除接口，数据库内事件保留；页面和导出默认取最近有限条数。

免打扰更新示例：`{"revision":0,"commonCommands":true}`。字段为 outsideWorkspace、commonCommands、recycleDeletes、systemTools、confirmationPrompts 五个布尔值，以及最多 20 项绝对路径 outsideRoots。返回 settings、enabledCount、recycleSupported、autoApproved、recent；原始审批内容不会替换为脱敏内容发送给 Codex。reviewer=user、实验动态工具与具体批准载荷见 04-protocol-evidence.md。

新增验证：`npm run smoke:dnd` 使用隔离 CODEX_HOME 和本机 SSE 测试上游，验证真实命令及动态回收工具；`npm run smoke:recycle` 对唯一临时文件/目录执行入回收站及还原；`npm run smoke:ui-dnd` 验证开关、多页面版本冲突、人工/自动批准、桌面/窄屏与 20 次墙钟延迟。后者用 AUTOCODEX_PLAYWRIGHT_MODULE 和可选 AUTOCODEX_BROWSER_PATH 指向开发机已有依赖。不要把开发测试入口分发为生产自动任务。

0.2 policy 增加 `errorWindowMs`（默认 300000）和 `noOutputTimeoutMs`（默认 600000）；旧 policy 自动补默认值。`incident.recentErrors` 保存最近 3/5 次 `{at, outputSequence}`，`incident.match` 给出时间/输出条件，`attemptsWithoutOutput` 区别于累计 `autoAttempts`。`outputMonitor` 保存有效输出序号、时钟、用户等待区间和保护锁存；详见 08-recovery-policy-v2.md。

插件专用口令仅能 GET 状态/指定任务/历史/交接，以及 POST 检查点，不能调用控制或批准。它不是不同 OS 用户之间的隔离机制；同一 OS 用户能读取本机文件。

## 新增适配器

0.3 安装解析独立在 `src/adapters/codex-discovery.mjs`。`resolveCodex` 返回 argv、环境及可见描述；公开接口只返回 `describeCodex` 的路径/来源，不输出环境或认证信息。目录提供者采用有限布局与一层版本目录，可新增提供者或使用 `AUTOCODEX_CODEX_SEARCH_PATHS` 扩展。路径/版本检测不等于上游业务请求成功。

`src/server/codex-settings.mjs` 管理启动参数 > 环境变量 > 数据库设置 > 自动发现的优先级。`codexCommand` 使用既有 meta 表，无 schema 升级。保存不修改当前 adapter 的 command，重启时读入；相对手动路径在保存时转为服务 cwd 下的绝对路径。命令行与环境覆盖锁定面板保存，避免显示已生效但实际被覆盖。

适配器提供 `createThread / readThread / resumeThread / startTurn / interrupt / respond / reject / close`，并发出 `notification / request / disconnect / connected`。协议错误与不确定派发分开处理。

`createThread` 和 `resumeThread` 返回会话对象及其实际 `model`、`modelProvider`，监护器将它们持久化。适配器在新建/恢复会话时应传回已保存的配置，不能因默认设置变化而悄悄切换模型或上游标识。

跨客户端版本扩展前先生成目标 CLI 的 schema。必须验证：

- error.willRetry 与 turn/completed 的关系；具体错误可能仅在 message 中保留 HTTP 状态。
- 通知先于响应、迟到响应、重复终态及客户端重新订阅。
- resume 是否影响另一客户端、是否能可靠判断实时所有权。
- 不能处理的新型 server request 必须明确拒绝/告警，不能自动批准。

CLI 存在 `codex queue --thread ... --message ...`，但它依赖会话路由/共享守护服务，不能仅凭命令存在推断当前桌面全部会话都可监护。桌面共享连接适配器需在明确的版本和运行方式下另做集成验证。

## 测试命令

`npm test` 运行 Node 原生测试。真实连接和故障注入单独执行，以免常规单元测试依赖用户已安装 Codex。

`npm run smoke:faults` 创建 `.work/codex-fault-*` 隔离 Codex 配置与空工作目录，真实 Codex 只向本机假上游请求生成，假上游不产生真实模型输出或费用。测试材料保留在 `.work` 用于调试，不修改用户登录/配置/会话历史。

浏览器验证：设置 `AUTOCODEX_PLAYWRIGHT_MODULE` 指向已有 Playwright 包，可选 `AUTOCODEX_BROWSER_PATH`，然后运行 `node scripts/ui-smoke.mjs <演练 connection.json 路径>`。该脚本只允许演练模式，并会创建演练任务及截图。

`node scripts/ui-installation-smoke.mjs` 为 0.3 路径界面创建独立真实模式服务，仅执行路径设置与协议握手，不创建任务。`scripts/verify-release.ps1 -Startup -WithCodex` 在中文/空格目录验证解压后的启动、MCP 配置、路径覆盖与保存后重启。Windows PowerShell 脚本以带 BOM 的 UTF-8 保存，JSON 明确使用 UTF-8。后台进程参数通过一次性的 JSON 请求传递给 `src/launch.mjs`，使用 detached 进程与独立日志句柄。

发布脚本从白名单组件构建新的暂存目录。替换 `dist/autocodex-guard` 前核对绝对路径、符号链接及运行数据；存在数据时拒绝清理。发布的 `.mcp.json` 是空模板，由目标机器首次启动生成。不要把开发机生成的配置直接复制进 ZIP。

维护任何恢复逻辑时更新行为测试、需求语义与 PROJECT_STATE.md；不把历史既有计划误标记为新的用户授权。
