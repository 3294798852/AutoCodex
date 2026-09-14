# Codex 框架核实记录

首次核实：2026-09-12；最新补充：2026-09-14（0.5.2）；本机 Node.js 24.18.0；本机 Codex CLI 0.153.4。

## 官方来源（已检索并读取页面正文）

1. [Codex App Server](https://learn.chatgpt.com/docs/app-server)：stdio JSONL 双向 RPC；初始化；thread/start/read/resume；turn/start/interrupt；error 与 turn/completed；人工批准。app-server/传输仍有实验性边界。
2. [Package your plugin](https://developers.openai.com/plugins/build/plugins)：插件可组合技能、MCP 和生命周期 hooks；本地插件发现与打包；新格式与兼容格式并存。
3. [Hooks](https://learn.chatgpt.com/docs/hooks)：Stop 可返回 block/reason 续发；Interrupt 不能阻止中断或重启回合；非受管 hooks 需要信任。不能据此推断错误断流一定执行 Stop。

## 本机协议核对

执行 `codex app-server generate-json-schema --out .work/codex-schema` 得到此安装版本的实际 schema。开发临时副本不进入发布包。

- `v2/ErrorNotification.json`：必须包含 threadId、turnId、error、willRetry。
- 实际 codexErrorInfo 使用 camelCase；可为字符串，或 `{"responseStreamDisconnected":{"httpStatusCode":null}}` 一类 tagged object。实现需要同时容忍文档中的大小写展示。
- 非恢复分类包含 unauthorized、badRequest、sandboxError、contextWindowExceeded、sessionBudgetExceeded、usageLimitExceeded、cyberPolicy、misalignmentPolicyViolation。
- 恢复分类包含 rateLimitExceeded、serverOverloaded、internalServerError 和四种连接/断流/retry 耗尽对象；HTTP 401/403 等优先分流到人工。
- `thread/start` 支持 cwd、model、modelProvider、sandbox、approvalPolicy、serviceName；0.1–0.3 恢复核心不依赖动态工具，0.4 回收站入口使用实验 dynamicTools。
- `ThreadStartResponse`、`ThreadResumeResponse` 都返回实际 model/modelProvider；`Thread` 也包含可用的历史模型信息。实现将实际选择持久化并传给后续恢复；移交历史会话时先采用已有上游标识，未指定模型时保留其历史模型。
- `codex app-server --help` 确认支持 stdio；本机存在 daemon/proxy，但其存在不能证明可连接当前桌面进程并控制所有活动任务。
- 本机还提供 `codex queue --thread <UUID或名称> --message <文本>` 和 `codex agents`。CLI 帮助将后者定位为共享 app-server daemon 的会话浏览器；首版不把这种显式共享路由等同于桌面全部任务的全局监听。

## 真实故障注入发现与修正

采用隔离 Codex 配置和空工作目录，让实际 CLI 0.153.4 连接本机返回 503 的上游，未使用真实模型服务。发现自定义上游错误可能没有结构化 HTTP 状态，而只在错误 message 中出现 `unexpected status 503 Service Unavailable`。

据此增加严格的 HTTP 状态短语兜底解析，并保持认证/权限/预算/策略错误优先。普通工具日志中的数字（例如 `tool exited with status 503`）不做 HTTP 分类，避免误恢复。

修正后，真实 Codex 验证了：人工策略产生 3 个上游请求（首次 + 两次继续）后暂停；新会话策略产生 4 个上游请求（再加新会话首轮）后最终停止。

另以 HTTP 200 返回 SSE 的 response.created 后直接结束连接，真实 Codex 将其判为流中断；同样在两次自动继续后暂停，总计 3 个本机上游请求。最终机器结果保存在 [真实故障报告](validation/codex-fault-report.json)。

参考：[Codex Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)，已读取正文并核对 provider 的 `request_max_retries`、`stream_max_retries`、`stream_idle_timeout_ms` 与 `supports_websockets`。这些测试覆盖本机假上游，不代表对真实付费上游的长期可用性保证。

## 不作无依据承诺

0.2 补充实测（2026-09-13）：model at capacity 能从可见错误正文归类，连续五次后报告；429 临时限流同样五次。部分 429 会被 CLI 归一化为 `responseTooManyFailedAttempts` 并丢弃原始额度正文，无法在集成端恢复该原因；402/可见额度信息仍直接转人工。SSE 已建立但无有效输出时，独立监护计时能够告警而不强制中断当前回合。八组实际结果见 docs/validation/codex-fault-report.json。

- 已有 Codex 桌面活动任务的跨进程订阅/控制未由所读文档证明，首版只完整管理自己拥有的会话。
- 未找到官方保证所有客户端均可打开的统一 thread 深链格式，因此不会伪造官方分享 URL。用户提供链接时保留原链接；否则用真实本机历史页链接与交接文件。
- 不把 Codex CLI 的内置重试次数当作插件两次续发次数。

## 0.4 批准协议与回收站实测（2026-09-14）

已读取 [官方 App Server approvals](https://learn.chatgpt.com/docs/app-server#approvals)，并核对本机 CLI 0.153.4 实验 JSON schema：初始化 capabilities.experimentalApi=true；受管会话 approvalsReviewer=user。命令/文件仅答 decision=accept；文件权限响应 permissions 为确切请求的子集、scope=turn，未知字段、网络/特殊根权限留人工。该 reviewer 设置只用于受管会话，不修改全局配置。

本机实际命令批准带 environmentId=local、完整 PowerShell 路径及转义的反斜线；availableDecisions 可能是 accept、永久规则对象和 cancel，未必有 decline。实现识别已知安装布局的 shell 完整路径，仅发单次允许，并在人工界面显示宿主实际可用的拒绝/取消选择。

thread/start 的 dynamicTools 注册 autocodex_recycle；item/tool/call 请求包含 tool、arguments、callId、threadId、turnId，返回 success 和 contentItems。thread/resume 不能新增此注册，因此移交旧会话不保证有回收站工具。Windows 实测确认：工具注册、Codex 发起调用、自动批准、本机文件入回收站、执行结果返回测试上游；另以 git status --short 验证真实命令批准与执行，4 次本机模型协议请求、0 付费请求。

记录：[真实批准报告](validation/dnd-codex-report.json)、[原生回收站及还原报告](validation/recycle-report.json)。本机夹具不覆盖真实付费模型选工具的概率、复杂客户端表单或未来 CLI 兼容性。
- 真实模型生成测试会产生上游请求；首版默认验证使用演练/协议夹具及真实 CLI 无生成握手，后续集成结果单独记载。

## 0.5 已有会话观察实证（2026-09-14）

官方 https://learn.chatgpt.com/docs/app-server#threads 明确 read 不加载/订阅、loaded/list 为当前服务内存；list 可按提供方、来源、标题、归档分页。本机 Windows CLI 0.153.4 daemon version 报 only supported on Unix platforms。只读本项目活动会话时，独立 app-server 返回 notLoaded、回合 interrupted，证明不能直接当桌面终态。

隔离两个 Codex 进程实测：观察者从列表发现原进程正在执行的会话；原始日志包含 task_started、item_completed/AgentMessage、task_complete；观察者 loaded/list 始终为空，停止观察不 interrupt，原进程正常完成。HTTP 503 结束写作 task_complete + error（并非独立 error 事件）；解析器已覆盖这一真实形态，显示 error 并告警一次，最终 token_count 不抹除失败。报告 docs/validation/existing-codex-report.json；2 次本机上游请求，0 付费请求。

## 0.5.2 所有权与原客户端辅助边界（2026-09-14）

两个隔离 app-server 证明：原进程回合结束后，另一进程 resume 仍返回 active writer；另一进程 unsubscribe 返回 notLoaded，重试仍冲突。queue/add 成功后观察 2 秒未自动执行，queue/start 拒绝并要求先 resume；测试队列项由原进程删除。原测试进程正常退出后 resume 成功。此处只报告当前版本和试验时序，不推断未来版本行为。

已重新读取 [官方 Hooks 正文](https://learn.chatgpt.com/docs/hooks)。Stop 的 block/reason 能产生继续提示，但文档不保证所有上游失败都调用 Stop；Interrupt 输出不能阻止中断或重启回合。PermissionRequest 可返回 allow/deny 或不作决定，适合原进程权限桥；不需要批准的命令不会触发该钩子。

本机 CLI exec 正常完成时触发 UserPromptSubmit 与 Stop；HTTP 503 和截断 SSE 仅触发 UserPromptSubmit。试验使用独立配置、本机上游，共 5 次本机请求、0 付费请求；记录见 [协议探针](validation/monitor-capability-report.json)。现有受管 RPC 批准测试不代表原桌面 PermissionRequest 已通过接入验证。

桌面 UIA 只读试验可读输入框、停止按钮和重连状态，但未取得可验证的 thread UUID，输入区域几何不可用；随后用户 Esc 停止，未输入或发送。此次不能确定桌面发送可行性，记录见 [桌面摘要](validation/desktop-monitor-feasibility.json)。后续框架与明确门槛见 [16 文档](16-monitor-mode-feasibility.md)。
