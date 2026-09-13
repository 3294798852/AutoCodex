# Git 仓库使用与维护

更新：2026-09-13。适用于 AutoCodex Guard 0.3.0 源码项目。

## 仓库信息

| 项目 | 当前设置 |
|---|---|
| GitHub 仓库 | [3294798852/AutoCodex](https://github.com/3294798852/AutoCodex) |
| 可见性 | 私有；访问者需要相应仓库权限 |
| 远程名称 | `origin` |
| 远程地址 | `https://github.com/3294798852/AutoCodex.git` |
| 默认分支 | `main` |
| 本地上游 | `origin/main` |
| 首次源码提交 | `e243b0125e7da32c2d192c1e12ca93692f1dafa0` |

已使用本机现有 GitHub 登录完成推送，并核对远程 `main` 与本地提交编号一致。GitHub CLI 不是本项目的运行依赖。

## 获取源码与日常提交

在另一台已获得仓库访问权限的电脑上，使用 Git 克隆：

```powershell
git clone https://github.com/3294798852/AutoCodex.git
cd AutoCodex
```

首次访问私有仓库时，按 Git 凭据管理器提示完成 GitHub 登录。程序启动与 Codex 路径配置见 [使用说明](09-user-guide.md)。

修改完成后，在项目目录检查并提交：

```powershell
git status
git add -- .
git diff --cached
git diff --cached --check
git commit -m '说明本次修改'
git push
```

提交前检查暂存差异，确保只包含本次预期改动。启动器会重写 `plugins/autocodex-guard/.mcp.json`；发布源码时应保留 `{"mcpServers":{}}` 空模板，避免把本机生成的绝对路径作为通用配置提交。

## 代理与本机设置

本次直连在执行环境中失败，检测到本机 Clash HTTP 代理 `127.0.0.1:7890`，经此代理验证 GitHub API 正常并完成推送。代理只配置在此仓库，不会随源码克隆到其他电脑。

查看当前仓库代理：

```powershell
git config --local --get remote.origin.proxy
```

如果本机代理端口改变，可替换下面的示例值；此端口是当前电脑的检测结果，不是软件的固定要求：

```powershell
git config --local remote.origin.proxy http://127.0.0.1:7890
```

不再需要代理时，移除此仓库设置：

```powershell
git config --local --unset remote.origin.proxy
```

当前电脑的 Git 已信任 `C:/My_Projects/AutoCodex` 这个确切路径，以兼容仓库由 Codex 沙箱账户初始化的所有权。新电脑正常克隆通常无需此设置；遇到所有权警告时先核实目录来源。

## 提交范围与核对

源码、测试、使用说明、设计文档和验证截图已纳入版本管理。运行数据、数据库、日志、缓存、连接口令及 `dist/` 发布包由 `.gitignore` 排除。本机环境文件 `.env` / `.env.*` 也被排除；`.env.example` 和 `.env.sample` 可提交，但应只包含示例值。

本次没有创建 GitHub Release。已有 ZIP 保存在本机 `dist/`；需要发布安装包时另行执行打包与 Release 流程。

核对同步状态：

```powershell
git status --short --branch
git remote -v
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

最后两条命令显示的提交编号应一致；有未推送提交或工作区修改时，先检查差异再继续。
