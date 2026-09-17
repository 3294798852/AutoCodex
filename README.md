# AutoCodex Guard

本机运行的 Codex 异常恢复守护服务、中文监测面板和 Codex 插件。

源码仓库：[3294798852/AutoCodex](https://github.com/3294798852/AutoCodex)（当前为私有仓库，需要访问权限）。

**当前版本 0.7.0。** 已实现原 Codex 中的自动续发和免打扰：你照常聊天，辅助层通过原通信连接处理异常和权限，不抢占会话、不操作输入框或剪贴板。

1. 首次接入时，在方便的时候从 Codex“文件”菜单正常退出。
2. 双击 **`Start-AutoCodex.cmd`**，同时打开 Codex 和监测面板。
3. 面板“已有会话 → 加入监测”，开启“异常自动续发”和“原窗口免打扰”。免打扰类别在“自动辅助设置”按需开启，首次默认全关。

之后继续在 Codex 中使用即可。已有历史任务同样支持；不需要填写 ID、重新描述任务或移交所有权。需要自动新任务接续时，在该任务的“恢复进度”选择“达到阈值 · 新会话接续”。[完整中文使用说明](docs/09-user-guide.md) 包含安装、路径选择和排错。

新增“自动辅助设置 → 免打扰”：工作区外文件、常用命令、回收站删除、系统工具、明确确认五个独立开关，以及全部开/关和实时批准记录。默认全关，保存后对新请求立即生效，重启保留。具体支持范围见 [免打扰使用说明](docs/09-user-guide.md#61-免打扰权限自动批准)。

首次异常后自动发送“继续”。普通错误按连续三次同类判定，包含首次错误及两次重试；容量不足和临时限流放宽为五次、四次重试。最近三/五次需在默认 5 分钟内发生，或期间没有有效输出，才按重复故障处理。可以选择人工处理或新会话接续；新会话首轮立即失败会完全停止。

默认连续 10 分钟无有效输出时，必须告警并停止后续自动恢复。时间窗口和无输出时限可在面板配置；有效输出重置无输出计时及对应重试预算，累计次数保留。重试提示、心跳和内部思考不能重置时钟；暂停或等待用户决定期间不计时。

**已有会话可直接监测**：持续跟踪原客户端的活动、输出、完成和异常。带辅助入口启动后，同一通信通道承担自动动作，Codex 保持唯一 writer。服务离线时普通聊天继续，未自动批准的请求回到原窗口。没有辅助连接时仍可只读监测。手机 APP 是下一阶段；本版仅监听本机。

本版新增人工处理后自动解除对应告警、活跃子代理监测与进展汇总，以及独立 GUI 窗口。左侧“监测对象”查看所有连接和任务，随时加入/移除监测。子代理结束自动释放，再次运行自动加入；手动移除的对象保持排除。独立窗口默认使用 WebView2，网页版入口为 `Start-AutoCodexBrowser.cmd`。

![监测对象](docs/assets/objects-v070.png)

## 快速开始

需要 Node.js 24 或以上；真实运行还需要已安装并配置好的 Codex CLI。本项目已核对 Node 24.18.0 和 Codex CLI 0.153.4。核心服务不需要 `npm install`。

在项目目录的 PowerShell 中运行：

```powershell
# 演练：不调用模型，不修改任务项目文件
.\Start-AutoCodex.ps1 -Demo

# 只检查本机 Codex 的位置、版本与连接，不请求模型生成
.\Start-AutoCodex.ps1 -CheckCodex

# 原 Codex 中正常对话，后台自动辅助（也可双击同名 .cmd）
.\Start-AutoCodexDesktop.ps1

# 仅打开监测面板
.\Start-AutoCodex.ps1
```

启动器会隐藏后台窗口并在默认浏览器打开本机面板。**再次运行启动脚本会重开已有面板**，不会重复启动或清空任务；真正启动失败时直接显示原因。演练与真实模式默认都使用 3210 端口；同时运行时为其中一个指定 `-Port 3211`。每种模式有自己的数据目录，同一数据目录只允许一个实例。

Codex 不在常见位置时，在真实面板“自动辅助设置 → Codex 安装”输入 CLI 文件或安装目录，检测、保存后重启；也可以在启动时明确指定：

```powershell
.\Start-AutoCodex.ps1 -CodexPath 'D:\应用\Codex CLI'

# 桌面程序也支持自动发现或手动指定文件 / 安装目录
.\Start-AutoCodexDesktop.ps1 -DesktopPath 'D:\应用\Codex' -CodexPath 'D:\应用\Codex CLI'
```

上面是示例位置，可替换为任意实际安装路径。优先级为启动参数、`AUTOCODEX_CODEX_COMMAND`、面板保存的路径、自动发现。自动发现检查 PATH、额外搜索目录、npm、用户安装及桌面版可能附带的 CLI；不会把桌面主程序当成可用 CLI。高级路径和扩展方法见使用说明第 3 节。

Windows 发布包解压后在 `autocodex-guard` 根目录运行以上脚本；无需安装 npm 依赖。可以使用 `-DataDir` 选择独立数据目录，升级时继续使用该目录，停止时也传相同参数。

如果希望看到服务输出，使用 `-Foreground`；也可以直接运行：

```powershell
npm run demo
# 或 npm start
```

直接运行后，打开终端提示的 `open-panel.html` 文件即可连接，无须手动复制口令。前台运行可按 Ctrl+C 关闭；后台运行可使用：

```powershell
.\Stop-AutoCodex.ps1 -Demo
.\Stop-AutoCodex.ps1
```

## 使用流程

已有会话使用“已有会话 → 加入监测”，开启原窗口的两个辅助开关后继续在 Codex 中工作。关闭某个开关只影响对应功能；“移除监测”取消后续自动动作，不中断原任务。若显示“未连接原窗口”，确认已使用新入口启动，并在 Codex 中打开一次该任务。下面的面板代管流程仍作为可选高级用法保留。

1. 在“新建监护任务”填写目标和本机工作目录。模型留空会使用现有 Codex 配置，并保存实际选用的模型和上游标识供接续时使用。
2. 选择反复错误后“人工处理”或“自动新会话接续”。默认人工处理。
3. 在时间线查看运行、内部重试、插件继续、会话接续和告警。
4. 在“自动辅助设置 → 免打扰”按需开启自动批准；未开启或未识别的操作及普通问题，在任务详情人工处理。
5. 可暂停自动恢复、停止任务、核对派发结果、手动继续或创建接续会话。

“暂停恢复”保留当前正在运行的工作，同时暂停后续自动派发和自动批准。“停止任务”取消自动计划并请求 Codex 中断当前回合。确认告警不会恢复任务。

## 插件

源码插件目录为 `plugins/autocodex-guard`。包含经过校验的兼容插件 manifest、技能及 stdio MCP 服务，提供：

| 工具 | 用途 |
|---|---|
| `guard_status` | 读取指定受管任务、恢复次数和未确认告警 |
| `guard_checkpoint` | 保存已完成、待办和约束等工作检查点 |
| `guard_read_handoff` | 读取旧对话链接、原目标、检查点和近期历史 |

启动器会调用 `Configure-LocalPlugin.ps1` 生成当前电脑的绝对路径配置；移动项目或解压到新目录后，重新运行启动器即可。它只写此插件的 `.mcp.json`，不修改用户全局 Codex 设置，不自动安装市场。

先启动服务生成本机配置，再通过你的 Codex 插件安装流程接入此目录。初始 `.mcp.json` 为未配置模板，不含开发机路径；移动目录后需要重新生成，并更新客户端已保存的 MCP 注册或插件缓存。[使用说明第 10 节](docs/09-user-guide.md#10-可选接入-codex-插件工具) 提供读取实际配置、注册独立 MCP 的完整命令。注册是可选操作，会修改用户的 Codex MCP 配置。

插件查询/检查点使用独立口令，不能用它调用继续、停止、创建、路径配置或批准接口。

## 校验与打包

以下开发校验命令在源码项目目录执行。解压发布包后使用启动/停止脚本；如本机限制执行 PowerShell 脚本，可进入包内 `runtime` 目录直接运行 `npm run demo` 或 `npm start`，按 Ctrl+C 关闭。

```powershell
npm test               # 规则、持久化、并发、协议、API、MCP 与 SSE
npm run check          # 源文件语法与 JSON
npm run smoke:codex    # 真实 Codex 握手，不请求模型生成
npm run diagnose:codex # 路径、版本与连接诊断
npm run smoke:faults   # 真实 Codex + 本机故障上游，无付费模型请求
npm run smoke:dnd      # 真实 Codex 命令批准与 Windows 回收站工具，本机测试上游
npm run smoke:existing # 两个真实 Codex 进程验证原会话观察，本机测试上游
npm run smoke:desktop  # 原生转接 + 真实 CLI：续发、新任务、批准、回收和离线透传
npm run smoke:ui-desktop # 原窗口辅助面板的浏览器验收，需要 Playwright
npm run smoke:recycle  # 临时文件/目录入回收站，再恢复并核对内容
npm run package        # 生成 dist/autocodex-guard 及 Windows ZIP
```

发布包携带插件、完整本机服务、启动/停止脚本及文档。服务放在包内 `runtime/`；启动器会自动识别这个目录。ZIP 不包含连接口令、数据库、任务历史、日志或开发缓存。`SHA256SUMS.json` 可用于核对文件。

自动测试覆盖恢复规则、安装发现、免打扰分类、持久化、断线与重复请求；真实 CLI、Windows 回收站、界面和发布包的实际结果见 [验证报告](docs/06-validation.md)。历次证据保留在报告中。

详细设计与实际验证结果：

- [需求及验收指标](docs/01-requirements.md)
- [实现架构](docs/02-architecture.md)
- [分阶段计划](docs/03-implementation-plan.md)
- [Codex 框架核实记录](docs/04-protocol-evidence.md)
- [操作与恢复指南](docs/05-operations.md)
- [验证报告](docs/06-validation.md)
- [接口与维护说明](docs/07-development.md)
- [三次/五次判定与长期无输出设计](docs/08-recovery-policy-v2.md)
- [使用说明](docs/09-user-guide.md)
- [安装发现与发布设计](docs/10-installation-design.md)
- [Git 仓库使用与维护](docs/11-git-publishing.md)
- [免打扰需求指标](docs/12-dnd-requirements.md)
- [免打扰实现方案](docs/13-dnd-implementation.md)
- [项目接续记录](PROJECT_STATE.md)

## 已知边界

- app-server 是 Codex 的实验性集成接口，未来版本需要重新验证。
- 原窗口自动辅助适用于经新启动器接入、并已加入监测的本机桌面任务。首次需正常退出 Codex 一次；不能热接入已经运行的桌面进程。原任务须已在桌面加载。
- 发送结果未知时先核对，无法唯一确认就停下来等待人工处理，避免重复执行。
- 静默不等于断流；仅长时间没输出会告警，不强制中断工具。
- 免打扰覆盖原通道和受管任务的可识别请求；全关不撤销沙箱本来已允许的操作。未知命令、Windows UAC、登录及其他软件弹窗保留人工。带辅助入口启动后，原桌面新旧任务均可加载专用回收工具；普通删除命令不改写为回收操作。
- 浏览器桌面通知需要用户授权，并保持面板打开；服务停机期间没有监护。当前没有系统托盘、自启动安装器或手机推送。
- 真实 Codex 的本机故障注入已验证；真实付费上游的长时间稳定性、不同账号策略及后续版本仍需实际项目验收。

- [已有会话监测需求与实现](docs/14-existing-sessions.md)

- [重复启动处理与验证](docs/15-launcher-reuse.md)
- [原客户端监测模式与桌面辅助可行性](docs/16-monitor-mode-feasibility.md)
- [原桌面透明通信辅助层与验收指标](docs/17-desktop-relay.md)
