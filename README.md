# dsh-idea-gittool

DSH Web 右侧栏里的 **IntelliJ 风格 Git 工作台**：默认看提交图与历史，一键审 Agent 改动的 diff，按文件勾选提交，顺手管分支、贮藏、冲突、变基和 worktree。

它是一个独立的 DSH 插件（Host + Client 同包），用 `dsh plugin` 安装，不需要改 DSH 本身。

## 系统要求

| 项 | 要求 |
|---|---|
| DSH | `>=0.2.1-rc.2 <0.3.0`（Web；不满足时安装会被拒绝） |
| Node.js | ≥ 22（DSH 自己的要求） |
| git | ≥ 2.25。部分功能要更新的 git：交互式变基「同时更新其他分支」（`--update-refs`）需要 2.38，搁架「三方合并应用」需要 2.43；版本不够时这些功能会隐藏或给出说明，其余功能不受影响 |
| 平台 | macOS 已实测；Windows、Linux 只做了静态审计和单元测试，尚未在真机上验证 |

## 安装、升级、卸载

从 GitHub Release 安装（推荐）：

```bash
dsh plugin --profile web add https://github.com/PGshen/dsh-idea-gittool/releases/download/v1.0.0-rc.1/dsh-idea-gittool-1.0.0-rc.1.tgz
```

- 没有全局 `dsh` 命令时，在 DSH 的 checkout 里把 `dsh` 换成 `pnpm dsh`（`dsh plugin` 只是把参数转给 profile 目录里的 pnpm）。
- 也可以在 Web 侧边栏 **Plugins → Add plugin** 里粘贴上面的 URL，或本地 tgz 的绝对路径。
- 附件旁边通常有 `SHA256SUMS`，下载后可校验：`shasum -a 256 -c SHA256SUMS`。
- 安装或升级后**重启 `dsh web`**。升级就是再 `add` 一次新版本；设置、Changelist 等数据保存在浏览器里，升级后保留。
- 卸载：`dsh plugin --profile web remove dsh-idea-gittool`，然后重启。
- 版本不匹配时安装会被拒绝，换匹配当前 DSH 的版本；确认要冒险时按提示用 `dsh plugin --profile web allow-version …` 按精确版本豁免。
- 版本不匹配的表现、隔离验证方法与发布流程见 [install-upgrade](docs/runbooks/install-upgrade.md) 与 [release](docs/runbooks/release.md)。

**从 GitHub 下载不动时**（`fetch failed`、`release-assets.githubusercontent.com` 连接被重置）：先用浏览器或代理下载 tgz，校验后改为本地安装：

```bash
shasum -a 256 dsh-idea-gittool-1.0.0-rc.1.tgz   # 与 Release 页的 SHA256SUMS 对照
dsh plugin --profile web add /绝对路径/dsh-idea-gittool-1.0.0-rc.1.tgz
```

需要代理时也可以只给这条命令加环境变量，例如 `HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 dsh plugin --profile web add <URL>`；Web 的 Add plugin 走同一套 pnpm 配置。

## 打开

- 右侧栏引导页里的「Git 工作台」卡片；
- 快捷键 `Cmd+Shift+G`（Windows / Linux：`Ctrl+Shift+G`），或命令面板搜索「Git」；
- 文档预览头部的 Git 状态点、「历史」「Diff」与「更多 Git 动作」。

工作台跟随当前会话的目录：会话在仓库的子目录里时，打开的是整个仓库。

## 功能一览

| 页面 | 能做什么 |
|---|---|
| 日志 | 提交图、分支/标签徽标、按文本/正则/分支/作者筛选、提交详情与变更文件、diff（统一/并排、词级高亮、忽略空白、完整文件）；右键菜单：签出、新建分支/标签、撤销提交、回滚此提交、拣选、重置当前分支到此、推送直到此提交、交互式变基（修改信息、丢弃、压缩）、Fixup/Squash 到此提交、创建/应用补丁、比较 |
| 提交 | 按文件勾选提交（只提交勾选的文件，不动其余暂存内容）、Amend、提交并推送、回滚、按 Changelist 分组 |
| 分支 | 本地/远程分支树、签出（遇到本地改动时可智能贮藏）、合并、变基、重命名、删除、设置 upstream、远程管理 |
| 贮藏 | 贮藏与恢复（保留暂存状态）、搁架（把改动按名字存起来，之后再取回，可三方合并） |
| 冲突 | 冲突列表、三栏合并窗口（逐块接受、应用非冲突更改、草稿保存）、继续/中止 merge、rebase、cherry-pick、revert |
| 其他 | 文件历史、Blame（含可选的「Git Blame」文档查看器）、比较、Worktree、推送预览与被拒处理、Git 控制台（看插件跑过的每条 git 命令） |

## 设置

仓库栏 `⋯` →「设置…」。设置保存在当前浏览器，对这台电脑上的所有仓库生效。

| 设置 | 默认 |
|---|---|
| 自动刷新 / 刷新间隔 | 开 / 3 秒 |
| 日志每页条数 | 100 |
| 日期格式（绝对 / 相对） | 绝对 |
| 紧凑模式（24px 行、隐藏作者与哈希列） | 关 |
| 默认 Diff 模式 | 统一 |
| 提交后（留在提交页 / 跳到日志） | 留在提交页 |
| 自动打开冲突列表 | 开 |
| 合并窗口自动应用非冲突更改 | 关 |
| 「Git Blame」文档查看器 | 关 |
| git 路径 | 空（用 PATH 中的 git） |

**git 路径**：填 git 可执行文件的绝对路径并点「应用」。文件名必须是 `git`（Windows 为 `git.exe`），不能放在会话工作区里，也不能是网络路径（[ADR 0014](docs/decisions/0014-git路径的信任边界.md)）。插件会先检查它确实是 git、版本够用，通过后立即生效，不用重启 DSH；Host 只在内存里使用这个路径，每次打开 Git 标签时由页面重新交给 Host。留空并应用就回到 PATH 中的 git。

## 快捷键

只在 Git 标签获得焦点时生效。

| 场景 | 快捷键 | 作用 |
|---|---|---|
| 全局 | `Cmd/Ctrl+Shift+G` | 打开/聚焦 Git 工作台 |
| 日志页 | `Cmd/Ctrl+F` / `Cmd/Ctrl+R` | 聚焦搜索 / 刷新 |
| 日志 | `↑` `↓`（加 `Shift` 多选）、`PgUp` `PgDn`、`Home` `End` | 移动选中 |
| 日志 | `←` / `→` | 跳到子 / 父提交 |
| 日志 | `Enter` | 打开 diff |
| 日志 | `Cmd/Ctrl+C` | 复制选中提交的完整哈希（没有选中文本时） |
| 日志 | `Cmd/Ctrl+A` | 全选已加载的提交 |
| 日志 | `F2` | 修改提交信息 |
| 日志、列表 | `Shift+F10` / 菜单键 | 打开右键菜单 |
| Diff | `n` / `p`、`Esc` | 下一个 / 上一个变更、返回 |
| 提交 | `Cmd/Ctrl+Enter` | 提交 |
| 合并窗口 | `F7` / `Shift+F7` | 下一个 / 上一个冲突 |

## 只读模式与沙箱

所有写操作（提交、签出、合并、推送……）都在 DSH 会话的沙箱里执行，并且每次写之前重新检查：

- 会话的权限是只读，或者沙箱不可用时，工作台只读，顶部横幅写明原因；查看日志、diff、Blame 等读操作不受影响。
- 「工作区可写」模式下，**整个仓库**（包括 `.git` 目录）都必须在会话的工作区里才允许写。例如会话开在一个 linked worktree 里，而主仓库在工作区外，就是只读的——写入会动到主仓库的 `.git`。把 worktree 放在仓库的 `.worktrees/` 下（工作台新建 worktree 的默认位置）、会话开在主仓库，就没有这个问题。
- 推送、拉取等联网操作使用你已有的 git 凭据；插件从不保存凭据。

## 排障

| 现象 | 处理 |
|---|---|
| Git 标签显示「未找到 git 命令」 | 安装 Git 后点「重新检测」；或点「设置 git 路径…」填绝对路径（如 `/usr/local/bin/git`、`C:\Program Files\Git\cmd\git.exe`） |
| 显示「Git 版本过低」 | 升级 git 到 2.25 或更高，或在设置里指向另一个较新的 git |
| 设置页提示「这里设置的路径没有生效」 | 在设置里重新点「应用」，看具体原因（不存在、不可执行、不是 git、版本过低） |
| 一直是只读 | 看横幅里的原因；多数是会话权限为只读，或仓库/`.git` 不在工作区内 |
| 安装时提示与 DSH 版本不兼容 | 换用匹配当前 DSH 的插件版本；确实要装时按提示用 `dsh plugin allow-version` 为这个精确版本豁免 |
| 安装时提示 `fetch failed`，日志里反复 `HEAD https://release-assets.githubusercontent.com/… ECONNRESET` | 到 GitHub Release 附件 CDN 的网络不通，不是版本问题。挂代理后重试；或先用浏览器下载 tgz、校验 `shasum -a 256`，再用绝对路径安装（见安装一节） |
| 卸载后右侧栏还有一个「Git」标签，显示「这类内容还没有可用的查看方式」 | 这是 DSH 恢复的旧标签，直接关掉 |
| 想知道插件跑了什么 git 命令 | 状态栏打开 Git 控制台；命令可复制（复制出的是 POSIX shell 写法，Windows 上在 Git Bash 里运行） |

## 已知限制

- Windows、Linux 未在真机上验证；git 2.25 与 2.38 未实测（2.39 与 2.50 已实测）。
- 不支持子模块与 Git LFS 的专门操作。
- Diff 里只改了行尾（CRLF ↔ LF）的行看起来与原行相同。
- 其余已知问题与计划见 [TODO](docs/plans/TODO.md)。

## 开发者

开发、测试与 AI 协作方式见 [AGENTS.md](AGENTS.md)（入口地图）。设计文档在 [docs/design](docs/design/2026-10-25-产品设计速览.md)。

## 许可证与致谢

本项目以 [Apache-2.0](LICENSE) 许可发布。功能与交互参考 IntelliJ IDEA 的 Git 工作流；需求调研参考了 IdeaGitTool 的公开功能清单。
