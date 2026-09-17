# 0.7.1 独立窗口 DPI 修复

日期：2026-09-17。问题：0.7.0 的 WinForms 壳未声明高 DPI 支持，Windows 会对窗口执行位图缩放，高缩放屏幕上的文字与图标因此模糊。之前的 GUI 验收只验证功能和网页截图，没有核对原生窗口 DPI awareness。

## 设计与验收

- 通过 .NET Framework 的 `PerMonitorV2` 配置启用逐显示器 DPI 感知，在任何控件创建前初始化视觉样式。窗口外壳、WebView2 和 Windows 缩放保持一致，不用 CSS 放大或固定像素比掩盖问题。
- WinForms 以 96 DPI 为设计基准，使用 DPI 自动布局；启动和 DPI 改变时，窗口边界保持在当前显示器工作区内。
- Windows 10/11 + .NET Framework 4.8+；本机已安装 4.8。发布包必须包含 `AutoCodexWindow.exe.config`，构建时嵌入 Windows 10 兼容清单。不同时在 manifest 中指定 DPI，以免覆盖 WinForms 配置。
- 源码入口根据源码、manifest、config 的时间判断是否需要重编译，不能无限复用 0.7.0 的缓存 exe。
- 增加 `Open-AutoCodexWindow.cmd` 只打开窗口，已有 0.7.0 后台服务可以继续运行。完整接入入口仍核对后台版本；仅修复 GUI 时用窗口入口，避免触发完整接入的版本检查。底部版本号仍显示当前后台版本，服务下次重启后更新。
- 验收真实窗口的 DPI awareness、系统 DPI 与 WebView2 像素比，检查 100%、125%、150%、200% 渲染和布局。模拟比例与真实显示器检查分开记录，不把模拟测试称为多显示器实测。
- 回归独立窗口认证、操作、复用、关闭保留服务；检查发布包携带 DPI 配置及中文空格路径运行。修复只需重新打开监测窗口。

## 接口依据

- [Microsoft：WinForms 高 DPI 支持](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/high-dpi-support-in-windows-forms)：Win10 兼容清单、app.config 的 PerMonitorV2、入口最先调用 EnableVisualStyles。
- [Microsoft：WinForms 配置项](https://learn.microsoft.com/en-us/dotnet/framework/configure-apps/file-schema/winforms/windows-forms-add-configuration-element)：自动缩放及 DPI 变化处理。
- [Microsoft：WebView2 监测屏幕缩放](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.shoulddetectmonitorscalechanges)：由控件跟随原生显示器比例，不手动叠加网页 ZoomFactor。

## 验收结果

本机实际 150% 缩放，旧版窗口 `awareness=0`、DPI=96、网页 DPR=1，内容以 1344px 渲染后被 Windows 拉伸到 2016px。修复版 `awareness=2`、PerMonitorV2、DPI=144、DPR=1.5，2007px 内容直接填充 2007px 物理客户区。旧窗口超出工作区，修复后保持在工作区内。

100%、125%、150%、200% WebView2 隔离比例验证通过：截图宽度等于 CSS 宽度 × DPR，原生客户区与渲染宽度一致，无横向溢出或重复网页缩放。检查所有原生子窗口处于主窗口内，避免仅凭网页截图漏掉原生布局问题。见 [DPI 报告](validation/window-dpi-report.json)。

通过真实 PowerShell 入口打开，并从标题栏最小化、再次运行入口恢复，页面、工具栏、状态栏及原生子控件位置正常。见 [恢复报告](validation/window-dpi-restore-report.json)。Computer Use 的 `activate_window` 恢复曾使测试子窗口产生异常坐标；核对程序原有恢复路径正常，最终验收使用真实入口，未据此修改系统设置。

GUI 认证、对象操作、设置保存、重复启动复用、关闭保留服务回归通过。70 个模块/JSON 检查通过；发布包 DPI 配置及中文空格路径启动、设置保留、正常关闭验证通过，见 [发布运行报告](validation/release-v071-runtime-report.json)。DPI 和 GUI 回归在搬迁后的实际发布 exe 上执行。多显示器间拖动仍需不同物理 DPI 的显示器专项实测；本轮没有更改用户 Windows 缩放设置或重启用户 Codex。
