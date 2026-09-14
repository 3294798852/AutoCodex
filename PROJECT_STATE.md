# AutoCodex 项目接续记录

更新：2026-09-14；当前版本：0.4.1；本轮状态：启动入口跨站误拦已修复；P9 免打扰功能保留。

## P10 本地启动入口修复

用户从 Start-AutoCodex.ps1 打开面板立刻收到“不接受跨站请求”。实测本地 open-panel.html 的 meta refresh 会发送 Sec-Fetch-Site=cross-site、mode=navigate、dest=document；原全局校验误拦页面，过去浏览器测试直接打开 HTTP URL，未覆盖该链路。

现只对公开 HTML 顶层 GET 导航放行此标记，Host/Origin、API、认证交换、资源和嵌入页面校验保持。新增 HTTP 边界测试与 scripts/ui-launch-smoke.mjs，从实际生成的本地文件验证跳转、认证、刷新和无口令访问。已重启用户源码目录下的空闲真实服务并重新打开面板，版本 0.4.1；任务为空、本机 CLI 自动发现成功，既有数据与本机生成的插件配置保留。发布包为 dist/autocodex-guard-0.4.1.zip；证据见 docs/06-validation.md 和 docs/validation/launcher-ui-report.json。

## P9 免打扰权限自动批准

已按照图片实现五项独立开关、全部开/关、已开启 N/5、目录范围、近期批准记录和任务次数。需求见 docs/12-dnd-requirements.md，方案见 docs/13-dnd-implementation.md，操作见 docs/09-user-guide.md 第 6.1 节。默认关闭，设置即时持久化；已显示的请求保持人工。原始请求用于判断和回答，脱敏预览用于界面/审计；批准前落盘、按连接/回合去重、结果不明锁定自动续发/换会话，跨迟到终态和重启保持。

本机 CLI 0.153.4 实验证实 dynamicTools 与 approvalsReviewer=user；新建 Windows 会话提供 autocodex_recycle，旧会话 resume 不能新增该工具。Windows IFileOperation 实际回收中文/空格文件与目录，并从回收站还原核对内容；没有永久删除兜底。真实 Codex 使用隔离本机 SSE 上游验证命令批准、动态工具注册、回收执行和结果回传，测试对象已还原。4 次本机协议请求、0 付费请求。

114 项自动测试通过（新增 30 项），42 个模块语法/JSON 检查通过；原八组真实故障场景回归通过。界面 15 项验收覆盖五开关、总开关、保存刷新、双页同步/409冲突、旧请求保留、后续自动批准、关闭后人工、记录与桌面/390px布局，零页面异常。20 次墙钟样本及截图记录在 docs/validation/dnd-ui-report.json、docs/assets/dnd-settings*.png。最终样本批准 p95 7.9 ms、面板 p95 88.6 ms。

交付：dist/autocodex-guard-0.4.0.zip；插件/随附技能格式校验通过；发布包中文搬迁、哈希、默认开关、重启保留、自动发现/手动路径及正常关闭已通过。报告见 docs/06-validation.md 和 docs/validation/release-v04-runtime-report.json。后续按新的需求继续，无需重做 P9；Git 提交及同步状态以 git log/status 与 origin/main 为准。用户真实任务免打扰设置及全局 Codex 配置未更改。

## P8 Git 仓库与 GitHub 发布（2026-09-13）

已建立本地 Git 仓库，默认分支为 `main`，上游为 `origin/main`；远程为 [3294798852/AutoCodex](https://github.com/3294798852/AutoCodex)，当前可见性为私有。首次源码提交为 `e243b0125e7da32c2d192c1e12ca93692f1dafa0`，73 个文件；推送后已核对远程与本地提交编号一致。

已审查提交清单和常见密钥格式，初始插件 `.mcp.json` 保持空模板。`.gitignore` 排除运行数据、数据库、日志、缓存、发布包和本机环境文件；新增 `.env.*` 忽略规则，保留 `.env.example` / `.env.sample`。

GitHub 直连在当前环境下失败，已通过本机 Clash HTTP 代理 `127.0.0.1:7890` 完成 API 核实和实际推送。代理仅保存为本仓库的 `remote.origin.proxy`，未修改全局网络配置；使用本机已有 GitHub 登录，凭据未写入源码或远程地址。仓库由沙箱账户初始化，本机 Git 已将本项目的确切路径登记为可信目录。

后续直接在此目录提交并 `git push`；首次克隆、代理调整和发布范围见 [Git 仓库使用与维护](docs/11-git-publishing.md)。本轮仅推送源码，现有 ZIP 仍留在本机 `dist/`，未创建 GitHub Release。

## 本轮新增要求与接续点

用户要求撰写当前程序使用说明，且 Codex 路径必须自动发现或手动输入，面向可迁移发布。已保存 `docs/09-user-guide.md` 和 `docs/10-installation-design.md`；实现安装发现模块、面板输入和保存、`-CodexPath` / `-CheckCodex` / `-DataDir`。设置优先级为参数 > 环境变量 > 数据库 > 自动发现，保存路径重启生效。

PATH 外可按当前用户环境发现 npm、用户安装、桌面附带 CLI 的已支持布局；支持额外搜索目录、中文空格和相对路径。显式错误路径不回退，Electron 主程序与 CLI 区分。未改变既有恢复规则。版本集中读取 package.json。

新增 14 项路径、持久化及 API 权限测试通过，累计 84 项；36 个模块检查通过。真实 CLI 0.153.4 的 npm 与 PATH 外桌面附带程序均通过握手，无模型任务。安装界面 7 项检查、八种演练回归、中文/空格解压路径、中文手动 CLI 入口、独立数据目录、MCP 重配置、参数覆盖、保存后重启和正常关闭均通过。

发布脚本采用干净暂存目录及目标机生成 MCP 配置，初始模板不含构建机路径；运行凭据不分发。后台使用 `src/launch.mjs` 分离进程句柄并以 JSON 传参，PowerShell 5.1 中文脚本采用 UTF-8 BOM。插件/技能校验通过。最终包为 `dist/autocodex-guard-0.3.0.zip`，使用手册为 `docs/09-user-guide.md`；最新证据在 `docs/06-validation.md` 的 0.3 节和 `docs/validation/*v03*`、`*installation*`、`release-runtime-report.json`。当前预览为 3218 端口、`.work/ui-v030-final/`，仅演练。

本轮没有剩余实现事项。后续继续验证未来 CLI / 桌面分发兼容、真实付费上游长期运行与用户另行要求的手机接入；不需要重做既有恢复核心。以下 P6 成果为历史证据。

## 用户目标与当前规则

项目提供 Codex 自动续发、可选新会话接续、本机监测及持久化。最新要求已实现：普通错误连续 3 次包含首次错误和 2 次重试；容量/临时限流连续 5 次包含首次和 4 次重试。最近 N 次必须在默认 5 分钟内，或期间无有效输出，才按重复错误处理。

默认 10 分钟无有效输出必告警并锁定自动恢复；跨重试、退避、新会话和服务重启保留。用户暂停/批准等待排除计时。正在执行的回合保留运行；告警确认和迟到输出不解除保护，核对后使用手动继续/新会话。补充重试预算默认 6，改为无有效输出期间计数，有效输出重置预算，累计次数保留。

## 当前成果

- 独立 Node 24 服务、Codex app-server stdio、SQLite WAL/FULL、中文 HTTP/SSE 面板及 MCP 插件。
- progress.mjs 维护有效输出、去重与计时；policy.mjs 保存最近错误时间和输出序号，实现三/五次与时间或输出规则。
- supervisor.mjs 实现独立看门计时、暂停排除、长期无输出保护锁存、迁移及重启核对。
- 新版面板展示三/五阈值、时间/输出判据和计时；可设置 5 分钟窗口及 10 分钟无输出时限。
- 大快照 SSE 改为等待 drain，避免正常大消息被误断开；内部文本缓冲/指纹不随状态推送。
- 70 项自动测试通过；28 个 JavaScript 模块检查通过。
- 实际 Codex CLI 0.153.4 本机故障注入 8 组通过，无付费模型请求。
- 浏览器 8 种场景与设置/人工操作通过，零页面异常，桌面和 390px 布局通过。
- 20 个真实本机 HTTP/SSE 样本：p50 108 ms、p95 112 ms、最大 113 ms。
- 需求、架构、操作和报告已更新；详细修订说明为 docs/08-recovery-policy-v2.md。

## 验证证据

`npm test`：70/70。`npm run smoke:faults`：503、截断 SSE 为 2 次继续；容量/429 为 4 次继续；402 额度为 0；静默活跃连接 1.5 秒测试阈值后告警并禁自动恢复，0 次继续/换会话。时间窗口/10 分钟默认期限的边界用受控时钟验证。

原始报告在 docs/validation/；新版截图在 docs/assets/，包括 recovery-settings.png。当前本机预览使用 3216 端口和 `.work/ui-v020-final/`，仅演练、不调用模型。

## 关键边界

- 实测 CLI 会丢失部分 429 的额度正文，只有 429 时按可见限流有限重试；有明确额度/认证信息则直接转人工。
- 有效文字为启发式识别：完整至少 8 个字母/数字、流式累计至少 24 个；排除已识别重试模板，最近 128 个结果摘要去重。成功工具结果也计有效输出；不记录原始思考。
- 旧版没有时间/输出证据，升级保留累计记录但开启新证据基线；旧待换会话计划转人工，避免凭旧计数错误触发。
- 仅完整管理本服务创建或用户明确移交的停止会话；不宣称全局桌面活动任务接管。
- 不修改用户全局 Codex 配置/插件市场。手机 APP 和真实付费上游长期验收后续另做。

## 交付与后续

已生成 `dist/autocodex-guard/` 及 `dist/autocodex-guard-0.2.0.zip`，41 个文件通过 SHA-256 清单核对，插件/技能格式、解压启动、默认设置、路径重配置、认证访问和正常关闭均通过。本轮没有剩余实现事项；后续按用户新的需求推进，无需重复设计或重写核心。`.work/`、`.autocodex/` 都是本地运行/验证数据，不进入分发包。
