# 参考项目调研：IdeaGitTool v0.4.2 功能与 UI 结构清单

> 调研对象：`/tmp/vs-idea-gittool`（IdeaGitTool v0.4.2，VS Code 扩展，复刻 IntelliJ/Rebased Git 客户端）
> 代码规模：`src/` 下 128 个 TS/TSX/CSS 文件，约 28.9k 行（`wc -l` 统计）；`package.json` 1810 行。
> 引用约定：所有 `文件:行号` 均相对参考仓库根目录，行号以该 v0.4.2 快照为准。
> 目的：为 DSH Git 插件产品设计提供「可迁移能力 / 必须重写部分 / 可砍部分」的判断依据。
>
> **状态**：✅ 已按参考仓库 `v0.4.2` 源码核实（2026-10-25）；⚠️ 各能力在 DSH 中的可移植性待 [M0 spike](../plans/active/m0-集成-spike.md) 之后逐项确认。

---

## 0. 一页速览（结论先行）

1. **形态**：4 个宿主表面 —— ①活动栏侧边「Commit」工具窗口（webview view）②底部「Git」面板（Log，webview view）③编辑器 Tab（Log / 28 种对话框 / 合并窗口 / Local History）④「Worktrees」树视图（原生 TreeView）；另加 5 条**原生编辑器装饰通道**（文件状态色、gutter blame 注解、inline blame、CodeLens、编辑器标题按钮）。
2. **体量**：122 条命令（`package.json:341-975`）、81 个命令面板项、18 条快捷键（`package.json:1596-1699`）、42 个设置（`package.json:48-340`）、28 种对话框、约 25 个 Log UI 偏好（存 `globalState`，非 VS Code 设置）。
3. **数据层 100% 走 git CLI**，无 libgit/NodeGit；所有命令经 `src/git/exec.ts` 镜像到「IdeaGitTool: Git Console」输出面板（`src/host/output.ts`）。核心状态采集在 `src/git/repository.ts:144-277`。
4. **最值得直接复用的不是 UI，而是纯逻辑层**：`src/shared/intellijDiff.ts`、`lineDiff.ts`、`mergeModel.ts`、`mergeResolve.ts`、`branchesTree.ts` 全部零依赖（文件头明确 "keep this file free of imports"），可原样移植到 DSH Host/Client；`src/git/graph.ts`（泳道布局）、`src/features/log/filters.ts`（过滤器→git 参数）也几乎可直接搬。
5. **VS Code 强绑定集中在 5 类**：webview view/panel 承载方式、编辑器 decoration（annotate/inline blame/CodeLens）、`vscode.diff` 编辑器、只读 FS/Content Provider（`ideagittool-git`、`ideagittool-lh`）、workspace 事件与 memento 存储。DSH 无编辑器，这部分必须降级或砍掉（详见 §5）。
6. **对 DSH 的产品判断**：右侧栏窄面板（300–500px）无法承载参考项目的三栏 Log 与 460–850px 对话框；首版应把参考项目的「Log + Commit」合并为**一个单栏 Git 工作台**（默认日志页 + 提交页 + 分支/贮藏内部页），合并窗口与交互式 Rebase 走全屏 pane（详见 §6、§7）。

---

## 1. 产品定位与整体信息架构

### 1.1 定位

- 目标不是「VS Code 的 Git 增强」，而是**把 IntelliJ/Rebased 的 Git 客户端整体搬进 VS Code**：菜单文案、快捷键、图标（IntelliJ New UI expui，`media/icons/`）、三栏合并窗口、迭代式冲突对话框、Shelf/Changelist 概念都按 IntelliJ 还原（`README.zh-CN.md`「功能」「与 Rebased 的差异」；`ARCHITECTURE.md`）。
- 明确承认的宿主限制：VS Code 不能在工作台上方画悬浮弹层、不能在行号栏加菜单，因此**分支弹出菜单被降级为 Commit 工具窗口里的 Branches 标签页**，对话框以编辑器 Tab 形式打开（`README.zh-CN.md`「与 Rebased 的差异」）。这条「宿主能力决定形态」的经验对 DSH 同样适用。

### 1.2 表面与入口总表

| # | 表面 | 注册位置 | 出现条件 | 承载内容 | 代码 |
|---|---|---|---|---|---|
| 1 | 活动栏容器 `ideagittool` + 视图 `ideagittool.commit`（webview） | `package.json:980-1019` | 有仓库（`workspaceContains:.git` / `onStartupFinished`） | Commit / Shelf / Stash / Branches 四个标签页 | `src/features/commit/index.ts:23` |
| 2 | 底部面板容器 `ideagittool-panel`（标题「Git」）+ 视图 `ideagittool.logView` | `package.json:980-1019` | `ideagittool.logInPanel`（即 `log.showInEditor=false`，默认） | Git Log | `src/features/log/index.ts:161`、`:227-233` |
| 3 | 编辑器 Tab `ideagittool.log` | `src/features/log/index.ts:79` | `log.showInEditor=true` 或新开日志标签 | Log / File History / Compare | 同上 |
| 4 | 编辑器 Tab `ideagittool.dialog` | `src/host/dialog.ts:28-40` | 每次 `showDialog(kind,...)` | 28 种对话框，按 `kind` 渲染 | `src/webview/dialog/registry.ts` |
| 5 | 编辑器 Tab `ideagittool.merge` | `src/features/commit/mergeTool.ts:76-83` | 冲突「Resolve Manually」/双击冲突文件 | 三栏合并窗口（CodeMirror） | `src/webview/merge/*` |
| 6 | 编辑器 Tab `ideagittool.localHistory` | `src/features/localHistory/view.ts:45` | Local History 命令 | 活动列表 + diff | `src/webview/localHistory/*` |
| 7 | 面板树视图 `ideagittool.worktrees` | `package.json:996-1019`、`src/features/ops/worktrees.ts:32` | 有仓库，默认折叠 | Worktree 列表 + 右键 | `src/features/ops/worktrees.ts` |
| 8 | 输出面板 `IdeaGitTool: Git Console` | `src/host/output.ts` | 命令 `showConsole` | 所有 git 命令回显 | `src/git/exec.ts` |
| 9 | 原生装饰 | 见 §5 | 编辑器打开/有仓库 | 文件状态色、gutter annotate、inline blame、冲突 CodeLens、编辑器标题按钮 | `src/features/commit/decorations.ts`、`src/features/log/annotate.ts`、`inlineBlame.ts`、`conflictEditor.ts` |
| 10 | QuickPick 菜单 | `src/features/ops/mainMenu.ts:177-181` | Git 菜单 / VCS Operations Popup / Current File | 原生 QuickPick 多级菜单 | `mainMenu.ts:148-176` |
| 11 | 通知 / 进度 | `src/host/ui.ts` | 各操作 | `withProgress`、成功/警告通知、`ask` 确认 | `src/host/ui.ts` |

**没有状态栏组件**：IntelliJ 状态栏上的分支组件被放进 Branches 标签页（`README.zh-CN.md`「与 Rebased 的差异」）。截图中底部的分支/错误计数属于 VS Code 工作台自身，不是本插件。

### 1.3 启动与上下文

- 激活事件：`workspaceContains:.git`、`onStartupFinished`（`package.json` activationEvents）。
- 激活顺序：初始化 webview host → 注册只读 FS `ideagittool-git` → 收拢 `ctx.command` 包装器（统一 try/catch + 通知）→ `for (feature of FEATURES) feature(ctx)` → `repos.scan()` → 更新 context key（`src/extension.ts:16-63`）。
- FEATURES 顺序：`commit → log → ops → localHistory`（`src/features/index.ts:8`）；ops 通过 `ctx.commitView.addHandlers()` 往 Commit webview 注入 Branches 标签页的 RPC（`src/features/commit/view.ts:92-98`）。
- Context keys：`ideagittool.hasRepository`、`multipleRepositories`（`extension.ts:54-59`）、`hasConflicts`、`inOperation`（`src/features/commit/index.ts:268-270`）、`logInPanel`（`log/index.ts:227`）、`annotated`（`annotate.ts:344`）。
- 仓库发现深度 `repositoryScanMaxDepth` 默认 1（设置表），多根工作区会产生多仓库。

### 1.4 命令 / 菜单 / 快捷键全景

| 维度 | 数量 | 证据 |
|---|---|---|
| 命令声明 | 122 | `package.json:341-975`（`contributes.commands`） |
| 命令面板可见项 | 81 | `package.json:1021-1594` 中 `commandPalette` 段 |
| 菜单挂载点 | 12 处（view/title、explorer/context、editor/context、editor/title/context、commandPalette、editor/title、3 个子菜单、editor/lineNumber/context、view/item/context） | 同上 |
| 快捷键 | 18 | `package.json:1596-1699` |
| 子菜单 | 3：`ideagittool.localHistory`、`ideagittool.copyReference`、`ideagittool.git.file` | `package.json:1772-1784` |
| 颜色 token | 7（6 文件状态 + 1 inline blame 前景） | `package.json:1701-1770` |

**IntelliJ 快捷键（可整体关闭 `ideagittool.intellijShortcuts`）**：`Ctrl+K` 提交（仅 Commit 视图聚焦）、`Ctrl+Alt+K` 提交并推送、`Ctrl+T` Update Project、`Ctrl+Shift+K` 推送、`` Ctrl+Shift+` `` 分支菜单、`` Alt+` `` VCS Operations Popup、`Ctrl+Alt+N` 新建分支、`Alt+9` 打开日志、`Ctrl+Alt+Z` Rollback、`Alt+Shift+C` Recent Changes、`Ctrl+Alt+Shift+C` Copy Reference（`package.json:1596-1699`）。

---

## 2. 功能清单（按模块）

### 2.1 Git Log（核心页面）

**入口**：`ideagittool.showLog {root?, branch?, path?}`、`Alt+9`、启动自动打开（`log.openOnStartup` 默认 true）、底部 Git 面板或编辑器 Tab。
**三种模式**（`LogMode = 'log' | 'history' | 'compare'`，`src/shared/logProtocol.ts:96`）：

| 模式 | 触发 | 差异 |
|---|---|---|
| `log` | 主日志 / 新标签 | 全量功能；左 Branches 面板；过滤器 User/Date/Paths/Graph Options；多仓库合并 |
| `history` | 文件历史（`showFileHistory`）、选区历史（`-L`） | 隐藏 Branches 面板与 User/Date/Paths；工具条换成 Refresh / Show Diff / Show All Affected Files / View Options / Show in VCS Log；`--follow` 单文件线性图（`src/webview/log/filterBar.tsx:277-292`、`src/features/log/filters.ts:41-64`） |
| `compare` | `compareRefs {ref, with}` | 顶部横幅「Commits in A that are not in B」+ Swap Branches / Show Files Diff（`src/webview/log/main.tsx:82-101`） |

**布局**（宽屏，参考截图 `docs/image/20261019175704.jpg`）：

```text
┌ 左：Branches 面板 (min 140, 默认 220) ┬ 中：日志区 ────────────────────────────┬ 右：变更/详情 (min 160, 默认 360) ┐
│ ┌──┐ ┌────────────────────────────┐ │ ┌ 过滤栏 ────────────────────────────┐ │ ┌ 工具条 ──────────────────────┐ │
│ │◀ │ │ 🔍 Search                  │ │ │ [🔍 Text or hash][Branch: x ×]      │ │ │ [Diff][Revert][History↑][👁] │ │
│ │＋ │ ├────────────────────────────┤ │ │ [User][Date][Paths][IntelliSort ▾]  │ │ │             [⤢][⤡]           │ │
│ │↻ │ │ HEAD (Current Branch)      │ │ │ [＋ New Tab Alt+G][↻][🍒][👁][🔍]   │ │ └──────────────────────────────┘ │
│ │🗑 │ │ ▾ Local                    │ │ └─────────────────────────────────────┘ │ ┌ 变更树 ──────────────────────┐ │
│ │⇄ │ │   ▾ feat                   │ │ ┌ 提交表格 ──────────────────────────┐ │ │ ▾ 11 files                   │ │
│ │🔍 │ │     codex-runtime    ›     │ │ │ ◉─┬ feat(canvas): 画布...  peng 10/17│ │ │   ▾ backend 5 files          │ │
│ │⭐ │ │   ▾ chore                  │ │ │ │ ├ fix(settings): ...      peng 10/17│ │ │   ▾ src/studio 3 files       │ │
│ │⇣ │ │     ★ main  origin/main ↑2 │ │ │ ...（行高 26px，虚拟滚动）           │ │ └──────────────────────────────┘ │
│ │◎ │ │     canvas-layout    ›     │ │ └─────────────────────────────────────┘ │ ┌ 提交详情 ────────────────────┐ │
│ │⚙ │ │ ▾ Remote ▸ ▾ Tags ▸        │ │  （空态：No commits matching filters） │ │ subject / body / hash 作者日期 │ │
│ │⤢ │ └────────────────────────────┘ │                                         │ │ 签名 / refs / In N branches    │ │
│ └──┘                                │                                         │ └──────────────────────────────┘ │
└─────────────────────────────────────┴─────────────────────────────────────────┴──────────────────────────────────┘
```

**关键结构**：
- 三栏用 `Split` 嵌套：`Branches | (center + RightPanel)`，右栏可再套 diff 预览（`src/webview/log/main.tsx:170-227`）；宽度持久化在 `LogUiSettings.branchesWidth/rightWidth`。
- 中心 = `FilterBar` + 可选横幅（操作中 / compare）+ `LogTable`，可选底部或右侧 Diff 预览（`main.tsx:177-204`）。
- 表格行高 `ROW_H = 26`（`src/webview/log/graph.tsx:7`），行虚拟化：宿主按 `PAGE=500` 分页、webview 按 `CHUNK=200` 拉取（`src/features/log/model.ts:12`、`src/webview/log/store.ts:6`、`:133-163`）。
- 列：graph + subject（+refs）+ author(+committer 星号) + date + hash(默认关) + GPG 签名列（默认关），列宽可拖拽（`table.tsx:185-215`、`:277-292`；默认见 `logProtocol.ts:64-94`）。
- 多仓库日志：按 commit date 合并、行首仓库色块（IntelliJ NEW_UI_ROOT_COLORS），`MergedStream`（`src/features/log/model.ts:20-60`、`table.tsx:18-28`、`:260-268`）。
- 截图 `docs/image/20261019175704.jpg` 验证：活动栏 Commit 工具窗口与底部 Git 面板可同屏并存；Branches 标签页占左侧栏，Log 占底部面板；右侧同时显示 `11 files` 变更树与提交元信息（hash/作者/日期/`In 3 branches: HEAD, main, origin/main`）。

**过滤栏**（`src/webview/log/filterBar.tsx:55-101`、`:247-294`）：
- 文本/哈希搜索：600ms 防抖、Enter 立即、Esc 清空、Regex 切换、Match Case 切换；`Ctrl+L` 聚焦、`Ctrl+F` 打开 GoTo。
- 过滤器 chip：Branch（HEAD/Favorites/Recent/Local/Remote-by-remote/Tags + Select… 多选）、User（me/Recent/作者列表 + 逗号分隔输入）、Date（Last 24h / Last 7 days / 区间）、Paths（选择器/Recent/多仓库 Roots 勾选）。
- Graph Options（IntelliSort 图标）：By Commit Date / Topologically、First Parent、No Merges、Collapse/Expand Linear Branches。
- 右侧动作：Refresh(`Ctrl+F5`)、Cherry-Pick（选中项不在 HEAD 时可用）、View Options（眼睛菜单）、Go To Hash/Branch/Tag(`Ctrl+F`)、New Tab(`Alt+G`)。

**提交表格键盘**（`table.tsx:126-183`）：↑/↓、PageUp/PageDown、Home/End、← = Go to Child、→ = Go to Parent、Enter/F4/Ctrl+D = Show Diff、F2 = Edit Commit Message、Ctrl+C 复制哈希、Ctrl+A 全选、右键 = 提交菜单。

**提交右键菜单**（`src/webview/log/menus.ts:18-78`，约 30 项，按上下文禁用）：

| 分组 | 项 |
|---|---|
| 顶部 | Copy Revision Number (Ctrl+C)、Create Patch…、Cherry-Pick |
| 检出/比较 | Checkout ▸（每个分支/Revision 'hash'）、Show Repository at Revision、Compare Versions（仅 2 项）、Compare with Local |
| 改写 | Reset Current Branch to Here…、Revert Commit(s)、Undo Commit…、Edit Commit Message… (F2)、Fixup…、Squash Into…、Drop Commit(s)、Squash Commits…、Interactively Rebase from Here… |
| 推送 | Push All up to Here…、Add Commits to Remote Branch… |
| 引用 | 每个 ref 一个子菜单 `Branch 'x'` / `Tag 'x'`（内容见下）；New Branch…、New Tag… |
| 导航 | Go to Child Commit (←)、Go to Parent Commit (→) |
| 外链 | Open on GitHub/GitLab/Bitbucket/Browser（从 remote URL 推导） |

可编辑条件：`inHead && operation === 'none'`；改写类再要求无 merge commit（`menus.ts:25-26`、`:55-64`）。File History 模式下换成 15 项专用菜单（`menus.ts:81-105`）。

**引用（分支/标签）子菜单**（`menus.ts:108-173`）：
- tag：Checkout、New Branch from 'x'…、Compare with 'cur'、Show Diff with Working Tree、Merge 'x' into 'cur'、Push Tag…、Delete。
- 当前分支：New Branch from…、Update、Push…(Ctrl+Shift+K)、Tracked Branch…、Rename…(F2)、收藏。
- 其他本地分支：Checkout、New Branch from…、Checkout and Rebase onto 'cur'、Compare with 'cur'、Show Diff with Working Tree、Rebase 'cur' onto 'x'、Merge 'x' into 'cur'、Update/Push/Tracked/Rename/Delete/收藏。
- 远程分支：Checkout→new branch、New Branch from…、Compare、Show Diff、Rebase/Merge、Pull into 'cur' Using Rebase/Merge、Delete、收藏。

**Branches 面板**（`src/webview/log/branches.tsx`）：
- 左侧竖向工具条 12 个按钮：Hide、New Branch(`Ctrl+Alt+N`)、Update Selected、Delete Branch(es)、Compare with Current(`Ctrl+D`)、Show My Branches、Fetch、Mark Favorite、Navigate to Head、Settings、Expand All、Collapse All（`:204-246`）。
- 树：HEAD（`HEAD (Current Branch)` / `HEAD (detached at abc12345)`）、Local（可按目录、按仓库分组）、Remote（按 remote 分组）、Tags；行尾 `↑ahead ↓behind` + upstream（`:56-145`）。
- 单击行为可配：Update Branch Filter / Navigate Log to Branch Head / 无；双击 = filterBy；右键 = Update Branch Filter / Navigate / 引用菜单；多选 = Compare Branches、Show Files Diff、Update Selected、Delete Branches（`:262-318`）。
- 键盘：Delete 删除、F2 重命名（`:270-280`）。

**右侧变更 + 详情**（`src/webview/log/changes.tsx`）：
- 工具条：Show Diff(Ctrl+D)、Revert Selected Changes、History Up to Here、Show Only Affected Changes（有 Paths 过滤时出现）、View Options（Group By Directory/Repository + Configure Layout）、Expand/Collapse All（`:314-327`）。
- 变更树：按目录/仓库分组，文件状态色；双击打开 diff；单击跟随 Diff 预览（`followDiff`）；Ctrl+D diff、F4 Edit Source、Ctrl+C 复制路径（`:156-194`）。
- 文件右键菜单 15 项：Show Diff、Compare with Local、Compare Before with Local、Edit Source(F4)、Open Repository Version、Revert Selected Changes、Cherry-Pick Selected Changes、Drop Selected Changes、Extract Selected Changes to Separate Commit…、Create Patch…、Get、History Up to Here、Copy Path、Copy Absolute Path、Show Changes to Parents（merge）（`menus.ts:182-222`）。
- 详情面板：subject/body（URL 自动链接）、hash（点击复制）、作者/邮箱/日期、committer 差异、GPG 签名状态、refs 标签、`In N branches: ... Show all`（超过 3 个截断）（`changes.tsx:198-297`）。

**顶部横幅**：`Rebasing 'x' is in progress` / `Merging` / `Cherry-picking` / `Reverting` / `Bisecting` / `Applying patches` + Continue / Skip(rebase) / Abort；多仓库时每个仓库一条（`main.tsx:103-140`）。

**文件历史 / 比较 / 预览**：
- 文件历史：`git log --follow --name-status -z --format=...`（`src/features/log/logTab.ts:600`），线性图；`Get` / `Show File at Revision` / `Annotate` / `Show in VCS Log`。
- 选区历史：`git log -L start,end:path -s`（`filters.ts:56`）。
- 变更 diff：`vscode.diff` 编辑器（`src/host/gitContent.ts` 提供 revision 内容），单击变更树可让已打开的 diff 跟随。
- 内置 Diff 预览：自绘并排/统一视图，F7/Shift+F7 跳块、折叠未变区块、Open in Editor、Jump to Source（`src/webview/log/diffView.tsx:140-216`）。
- 长连线折叠、GPG 签名列、`Not Cherry-Picked Commits` 调暗、`Show My Branches`、按仓库着色/分组（README 功能列表；实现见 `menus.ts:282-308`、`logTab.ts:454-470`）。

### 2.2 Commit 工具窗口

**四个标签页**（`src/webview/commit/main.tsx:14`、`:41-92`）：Commit / Shelf / Stash（**仅有 stash 时出现**，`:35`、`:50-54`）/ Branches。右上 `⋮` 菜单：Show Diff/Source on Double-Click、Show Git Console、Show Git Log。

**Commit 页布局**：

```text
┌ Commit ┬ Shelf ┬ Stash ┬ Branches ──────────────────────────── ⋮ ┐
├ [↻][↶ Rollback][⇄][Changelists][Shelve][👁] │ [◎][⤢][⤡]         ┤
├ ⚠ Rebasing feature onto main        [Continue][Skip][Abort]     ┤
├ 变更树（带三态勾选，split 初始 290）────────────────────────────┤
│ ▾ Merge Conflicts  2 files                     Resolve          │
│ ▾ Changes  3 files                                              │
│   ▾ src  2 files                                                │
│     ☑ M app.ts                                                  │
│ ▾ Unversioned Files  1 file                                     │
│ ▾ Ignored Files  （默认隐藏）                                    │
├ 提交面板（固定底部，min 120）───────────────────────────────────┤
│ ☐ Amend   [last commit ▾]                     [🕘 history]      │
│ ┌ Commit Message ─────────────────────────────────────────────┐ │
│ └──────────────────────────────────────────────────────────────┘ │
│ [Commit] [Commit and Push…]                               ⚙    │
└──────────────────────────────────────────────────────────────────┘
```

- 分组：Merge Conflicts（带 `Resolve` 链接）、Changelists（可多个，默认 `Changes`）、Unversioned Files、Ignored Files；每组显示文件数、目录树可展开；首次出现的组自动展开，状态持久化（`src/webview/commit/commitTab.tsx:58-141`）。
- 勾选三态、拖放移动到 changelist（`:161-167`、`:428-434`）。
- 工具条 9 个动作：Refresh、Rollback(`Ctrl+Alt+Z`)、Show Diff(`Ctrl+D`)、Changelists 菜单、Shelve Silently(`Ctrl+Shift+H`)、View Options、Select Opened File、Expand(`Ctrl+=`)/Collapse(`Ctrl+-`)（`:344-372`）。
- 操作中横幅：`Rebasing x onto y` / `Merging x into main` / `Cherry-picking x` / `Reverting` / `Applying patches` / `Bisecting` + Resolve…（有冲突时）/ Continue / Skip / Abort（`:373-406`）。
- 提交面板：Amend 复选框 + 可改**更早提交**（下拉列最近 10 个提交，`view.ts:244-255`）、Commit Message History（最近 25 条，`Ctrl+M`）、消息 textarea（500ms 防抖保存草稿）、Commit(`Ctrl+Enter`/`Ctrl+K`)、Commit and Push…(`Ctrl+Alt+K`)、Commit Options 齿轮(`Ctrl+O`)（`commitPanel.tsx:21-182`）。
- Commit Options 弹层：Author 覆盖、Sign-off commit、Create extra commit with file movements（`:184-211`）。
- 快捷键：Ctrl+D/F4/Enter（打开 diff/source）、Delete、Ctrl+Alt+Z、Ctrl+Alt+A、Alt+Shift+M、F2/changelist、Ctrl+Space 设为 active、Ctrl+Shift+H（`commitTab.tsx:290-317`）。
- 文件右键菜单约 20 项（含 `Git` 与 `Local History` 两个子菜单）（`:173-280`）：Merge…、Accept Theirs/Yours、Commit File(s)…、Rollback…、Rollback File…、Move to Another Changelist…、Show Diff、Jump to Source、Copy Path/Reference 子菜单、Delete、Add to VCS、Add to .gitignore、Remove from VCS、New/Delete/Set Active/Edit Changelist、Create Patch from Local Changes…、Copy as Patch to Clipboard、Shelve Changes…、Refresh、Local History ▸、Git ▸（Annotate/Compare with Revision/Compare with Branch/Show History/Rollback/Resolve Conflicts…/Revert Resolved）。不适用的项直接隐藏（`hideDisabled`，`:278-279`）。
- 双栏分隔可拖；Persist 在 webview localStorage。

### 2.3 Shelf（IntelliJ 搁置）

- 存储：`<storage>/shelf/<id>.patch` + `shelf.json`（`src/features/commit/shelf.ts:9-40`）；分类「Active / Recently Deleted」。
- UI：工具条（Unshelve Silently `Ctrl+Alt+U`、Show Diff `Ctrl+D`、View Options、Expand/Collapse）、树（shelf → 目录 → 文件）、右键 11 项：Unshelve…(`Ctrl+Shift+U`)、Unshelve Silently、Restore（已删除）、Show Diff、Compare with Local、Create Patch…、Copy as Patch、Import Patches…、Rename…(F2)、Delete(Delete)、Clean Already Unshelved…（`src/webview/commit/shelfTab.tsx:106-148`）。
- 关键语义：Shelve = 生成 patch 后 **rollback 工作区**（`shelf.ts:65-88`）；Unshelve 可选择文件/目标 changelist/是否删除 shelf（`view.ts:587-627`），冲突时进入冲突对话框（`context: "Conflicts during unshelving X"`）。
- View Options：Group by Directory、Show Already Unshelved。

### 2.4 Stash

- 仅当存在 stash 时显示标签页；上下列表：stash 列表（`stash@{n}`、message、branch、date）+ 选中 stash 的文件树 + `Apply` / `Pop` 按钮（`src/webview/commit/stashTab.tsx:120-164`）。
- 右键：Pop、Apply、Unstash…（走对话框）、Drop、Clear（多仓库按仓库）、Show Diff(Ctrl+D)、Compare with Local（`:78-87`）。
- 文件右键：Show Diff、Compare with Local、Compare Before with Local、Edit Source(F4)（`:95-106`）。
- 键盘：Delete = Drop、Ctrl+Enter = Apply（`:131-136`）。
- 对话框：`commit.stash`（勾选文件 + 仓库选择，520 宽）、`commit.unstash`（选择 stash + 是否删除，620 宽）（`src/webview/dialog/dialogs/commit/stashDialogs.tsx:36-120`）。

### 2.5 Branches 标签页（IntelliJ 分支弹窗的替代形态）

- 结构 = 顶部搜索（匹配字符高亮、支持「字母顺序模糊匹配」`MinusculeMatcher` 风格）+ Fetch + 设置齿轮；顶部动作区；Recent / Local / Remote / Tags 分组，组内可按目录、按仓库分组；行尾 `›` 打开操作菜单（`src/shared/branchesTree.ts:73-160`、`src/webview/commit/branchesTab.tsx:43-50`）。
- 设置菜单：Add in Search Results ▸ Actions、Group by Directory、Group by Repository（多仓库）、Execute Branch Operations on All Roots、Show Recent Branches、Show Tags（`branchesTab.tsx:308-325`）。
- 顶部动作（来自 `BranchesState.top`）：Update Project…(⌃T)、Commit…(⌃K)、Push…(⇧⌃K)、New Branch…(⌥⌃N)、Checkout Tag or Revision…，以及操作中时的 Abort/Continue（README；`src/features/ops/branchesTab.ts`）。
- 交互：**单击 = 打开操作菜单**（不直接 checkout），**双击 = checkout**，右键 = 同一菜单；键盘 ↑/↓/PageUp/PageDown/Enter/←/→/Esc，输入字母转入搜索（`branchesTab.tsx:160-266`）。
- 菜单内容按引用类型生成（同 §2.1 refActions），host 侧 `refActionsFor`（`src/features/ops/branches.ts:63-66`）。

### 2.6 冲突解决（迭代式对话框）

**触发**：合并、变基、cherry-pick、revert、pull、update、checkout、Unstash、Unshelve 出现冲突时**主动弹出**（不是等用户点通知）；编辑器内也有入口（见 §5）。
**对话框 `commit.conflicts`（850×470/570）**（`src/webview/dialog/dialogs/commit/conflictsDialog.tsx:189-313`）：

```text
┌ Conflicts ───────────────────────────────────────────────────────── ✕ ┐
│ Merging branch feature into branch main                               │
│ [✨ Resolve All Simple Conflicts]   Resolving Conflicts…        👁    │
│ ┌───────────────────────────────────────────────────────────────────┐ │
│ │ ▾ Unresolved   2 files                                            │ │
│ │   src/a.ts     1/3   Modified    [Accept]   Modified   [Accept]   │ │
│ │   src/b.ts     0/2   Modified    [Accept]   Deleted              │ │
│ │ ▸ Resolved     0 files                                            │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                          [Close] [Accept and Finish] [Resolve Manually]│
└────────────────────────────────────────────────────────────────────────┘
```

- 行内 `Accept` 按钮仅在 hover 行/唯一选中行出现；徽标 `resolved/total`；Yours/Theirs 列头按冲突来源动态命名（`Yours (main)` / `Theirs (feature)`，rebase 时反转）（`src/features/commit/conflicts.ts:137-217`）。
- 右键：Accept 'Yours' / Accept 'Theirs' / Revert Conflict Resolution。
- 底部按钮：Close、Accept and Finish（全部 resolved 才可用）、Resolve Manually / Review Changes（全部看过且 resolved 后主按钮切换语义）。
- **迭代语义**：每个文件持有一个 `MergeModel`；在合并窗口 `Save and Close` 只写工作区文件（`saved=true`），`Accept and Finish` 才 `git add` 标记解决（`conflicts.ts:72-83`、`:276-280`；README 同）。
- 从 stash/shelf 恢复导致的冲突用 `ConflictContext` 定制文案与左右标题：`Uncommitted changes that were saved before merge have conflicts with files from feature`，左「Uncommitted changes from the stash」右「Changes from feature」，且 `reverse` 语义（`conflicts.ts:52-65`、`:619-626`）。
- 二进制 / 一边删除：降级为 Accept Left / Accept Right（`mergeable=false`，`conflicts.ts:170-173`）。

### 2.7 合并窗口（三栏，CodeMirror）

**入口**：冲突对话框 Resolve Manually / 双击冲突文件；独立 `ideagittool.merge` 编辑器 Tab（`src/features/commit/mergeTool.ts:55-136`）。

```text
┌ ↑ ↓ │ Compare ▾ │ Collapse │ Apply non-conflicting: [◀ Left][All][Right ▶] │ ✨ │ ↶ │ 2 conflicts │ ⚙ ┐
│ Changes from main          │ Result（可编辑）            │ Changes from feature                        │
│  1 ...                     │  1 ...                      │  1 ...                                      │
│  »/«/×/魔棒 行内操作        │                             │                                             │
├ [Accept Left] [Accept Right]                     [Save and Close / Cancel]   [Apply Changes]           ┤
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- 工具条：上一/下一差异(Shift+F7/F7)、Compare Contents ▾（6 种组合：左中/中右/左右/基左/基中/基右）、Collapse Unchanged Fragments、Apply non-conflicting Left/All/Right、Resolve Simple Conflicts、Revert Conflict Resolution、状态文本（`N changes, M conflicts`）、Settings（`src/webview/merge/main.tsx:270-302`）。
- 设置菜单：Synchronize Scrolling、Automatically Apply Non-Conflicting Changes、Ignore(none/trim/whitespace)、Highlighting(lines/words/none)（`:156-186`）。
- 编辑器右键：Accept / Accept Left Side / Accept Right Side / Resolve using Left|Right / Resolve Automatically / Ignore / Compare with Clipboard / Collapse Unchanged Fragments / Synchronize Scrolling（`src/webview/merge/controller.ts:338-356`）。
- 行内 gutter：`»` `«` `×` `魔棒`，Ctrl+点击一次解决整个冲突；曲线色块连接左右，解决后变虚线；跟踪手动编辑（改动范围随输入调整，已编辑块不再自动解决）；F7/Shift+F7 导航；Ctrl+Enter = Apply Changes；Esc = Cancel（`main.tsx:249-265`、`controller.ts:444-457`）。
- 底部：Accept Left / Accept Right / Save and Close（迭代模式）或 Cancel / Apply Changes。
- 保留 CRLF 与文件末尾换行；二进制冲突走简单选择（README）。

### 2.8 Diff

| Diff 形态 | 实现 | 触发 |
|---|---|---|
| VS Code diff 编辑器 | `vscode.diff` + 只读 `ideagittool-git` 内容 | 变更树双击、提交 diff、比较、Get |
| Multi-diff | `vscode.changes` / `openMultiDiff` | 多文件 diff、commit「Show All Affected Files」 |
| 内置预览（自绘） | 并排/统一、hunk 折叠、词级高亮、F7 跳块 | Log 页 Diff 预览（`showDiffPreview` + location bottom/right） |
| 合并窗口 | CodeMirror 三栏 | 冲突解决 |
| Local History diff | 自绘 diff | Local History |

- 参考项目**已实现了一个可复用的纯文本 diff 视图**（`diffView.tsx` + `shared/lineDiff.ts` + `diffAlign.ts`），对 DSH 价值很高：不依赖编辑器，只需 DOM。
- 内置预览工具栏：Prev/Next Difference、Open in Editor、Jump to Source、Viewer（Side-by-side/Unified）、Collapse Unchanged、文件名 + 差异块计数（`diffView.tsx:140-200`）。

### 2.9 Local History（IntelliJ 本地历史）

- 记录时机：保存、创建、删除、重命名、外部改动；git 操作前打系统标签（如 "Before Update"）（`src/features/localHistory/recorder.ts:60-75`、`src/features/ops/update.ts:39-48`）。
- 存储：`events.jsonl` 追加事件 + 内容寻址 blob（`content/ab/cdef…`），默认保留 5 天（`src/features/localHistory/store.ts:35-49`、设置 `retentionDays`）。
- UI：左侧活动列表（按 Today/Yesterday/日期分组，图标区分 label/system/external/edit，搜索框，Show System Events），右侧 diff（与本地 / 与下一版本切换）+ 工具条（Revert Selected and Later Changes、Revert Selection（选区模式）、Create Patch…、Show Diff、切换 diff 基准）（`src/webview/localHistory/main.tsx:88-164`）。
- 入口：`Show History`（文件/目录）、`Show History for Selection`、`Show Project History`、`Recent Changes`(Alt+Shift+C)、`Put Label…`；右键菜单挂在资源管理器/编辑器标签/编辑器正文/Commit 变更树（`package.json` menus；`src/features/localHistory/index.ts:47-60`）。

### 2.10 Annotate / Blame

- **gutter 注解**（IntelliJ Annotate）：行号区显示作者/日期/版本，按作者或时间分 8 档色阶（alpha 0.32→0.02），悬停提示；关闭时显示「Close Annotate」；选项在行号区右键与编辑器右键（`src/features/log/annotate.ts:180-300`、`:380-405`）。`git blame --line-porcelain`（`:240-260`），可用 `-w`、`-M`、`-C`。
- 选项：Show Author/Date/Revision、Prefer Commit Date、Names(full/first/last/initials/email)、Colors(hide/author/order)、Ignore Whitespaces、Detect Movements Within/Across Files（设置 `ideagittool.annotate.*`）。
- **Inline blame**：光标行尾浅色斜体「作者, 日期, 时间 • subject」，悬停可跳日志或看 diff；编辑时隐藏、光标停顿后重算；`ideagittool.inlineBlame.enabled` + Toggle 命令（`src/features/log/inlineBlame.ts:10-100`）。

### 2.11 Worktree

- 树视图（原生 TreeView，非 webview）：worktree 名称/路径/branch/锁状态；标题栏 + / ↻ / 🗑 / prune；右键 Open、Lock/Unlock、Delete（`package.json` view/title、view/item/context；`src/features/ops/worktrees.ts:250-316`）。
- 命令：create（对话框 `ops.newWorktree` 620 宽）、show、refresh、open（**总是新窗口**）、delete、prune、lock、unlock。
- 数据：`git worktree list --porcelain`（`src/features/ops/engine.ts:541-544`），解析在 `:517-540`。

### 2.12 远程 / 更新 / 克隆 / 其它

- **Push**（`src/features/ops/remote.ts:55-...`）：对话框左侧仓库/提交树（勾选）、右侧选中提交的 message + 变更文件树；顶部 source → remote:target 可编辑；Push tags（All/Current Branch）、Run Git hooks；主按钮 split：Push / Force Push（`--force-with-lease`）。推送被拒 → Push Rejected 对话框（Rebase/Merge/Force Push），支持 `push.autoUpdateOnRejected`。
- **Update Project**（`src/features/ops/update.ts:44-...`）：Merge/Rebase/Branch Default、stash 或 shelve 清理工作区、`Reset to the Remote Branch`、`Update Force-Pushed Branch`（备份分支 + reset --hard + 恢复，`engine.ts:407-493`）。
- **Pull / Fetch / Merge / Rebase** 对话框：选项 chips（Pull：rebase/ff-only/no-ff/squash/no-commit/no-verify；Merge：no-ff/ff-only/squash/-m/no-commit/no-verify/allow-unrelated；Rebase：onto/interactive/update-refs/rebase-merges/keep-empty/root/switch）（`src/webview/dialog/dialogs/ops/mergeRebase.tsx:25-...`、`:100-240`）。
- **Interactive Rebase**：提交列表（Pick/Stop to Edit/Reword/Squash/Fixup/Drop），Alt+↑/↓ 移动、Alt+P/E/R/S/F/D 设动作、Reset、View Git Commands、Ctrl+Enter 执行；右侧选中提交的 message/文件（`interactiveRebase.tsx:38-46`、`:247-410`）。
- **Reset HEAD**：Soft/Mixed/Hard/Keep 四模式 + 目标提交（`simple.tsx:226-275`）。
- **Tag**：名称/Force/Commit/Message（`simple.tsx:169-225`）。
- **Smart Operation 对话框**（checkout/merge/cherry-pick/revert 被本地改动挡住时）：Don't / Force / Smart（stash → 操作 → unstash）；列出阻挡文件（`simple.tsx:30-70`）。
- **Remotes**：列表 + Add/Edit/Remove；**Clone**；**Init**；**Unshallow**（`remote.ts:300-330`、`:395`）。
- **Git Console**：所有子进程的 `$ git ...` + stdout/stderr 镜像（`src/git/exec.ts`）。
- **Git 菜单 / VCS Operations Popup**：QuickPick 多级菜单，内容见 `src/features/ops/mainMenu.ts:52-147`。

### 2.13 设置与外观

42 个设置（`package.json:48-340`）：

| 组 | 设置 |
|---|---|
| 仓库/外观 | `gitPath`、`appearance(vscode/intellij)`、`untrackedFiles(all/normal/hide)`、`showIgnoredFiles`、`repositoryScanMaxDepth`、`dialogs.openInNewWindow`、`fileStatusColors` |
| 提交 | `commit.gpgSign`、`commit.includeActiveChangelist`、`commit.skipHooks` |
| 日志 | `log.showInEditor`、`log.openOnStartup` |
| 快捷键 | `intellijShortcuts`、`intellijShortcutsInEditor` |
| 合并 | `merge.useVsCodeMergeEditor`、`merge.handleConflicts(ask/always/never)`、`merge.contextLines(1/2/4/8/-1)` |
| Local History | `localHistory.enabled`、`localHistory.retentionDays(5)` |
| Annotate | `annotate.showAuthor/showDate/showRevision/preferCommitDate/names/colors/ignoreWhitespace/detectMovementsWithinFile/detectMovementsAcrossFiles` |
| Inline blame | `inlineBlame.enabled` |
| 更新 | `updateMethod(merge/rebase/branchDefault)`、`update.showDialog`、`update.saveChangesPolicy(stash/shelve)` |
| 推送 | `push.tags(none/all/current)`、`push.runHooks`、`push.autoUpdateOnRejected(""/merge/rebase)` |
| 拉取 | `fetch.prune` |
| 分支 | `branches.showRecent/showTags/groupByDirectory/groupByRepository/searchActions/syncControl` |

另有两套「UI 偏好」不走 VS Code 设置：Log 页 25 项 `LogUiSettings`（列、宽度、分组、高亮、预览位置等，`src/shared/logProtocol.ts:27-94`）存 `globalState`；Commit 页 `ViewSettings`（groupByDirectory/Repository、showIgnored、doubleClick、showRecycledShelves）与草稿/历史/选项存 `workspaceState`（`src/features/commit/view.ts:30-35`）。`appearance=vscode` 时全部颜色映射到 `--vscode-*` 变量（`src/webview/lib/vscode.css:1-60`），尺寸完全不变（`scripts/layout-check.mjs` 校验）。

---

## 3. 页面 UI 布局（文字 + ASCII 线框）

### 3.1 Log 页（宽屏完整形态）

见 §2.1 线框。补充尺寸与交互细节：

- 左栏最小 140 / 默认 220；右栏最小 160 / 默认 360；diff 预览底部默认 300 高、右侧最小 200（`main.tsx:190-204`、`logProtocol.ts:64-94`）。
- 表格 graph 列宽 = `min(graphWidth(lanes), max(60, 容器宽 × 0.4))`（`table.tsx:112-113`）；author 默认 120、date 140、hash 80、signature 28。
- 行：仓库色块（可选名字）→ graph → refs（可切左/右）→ subject → author（作者≠committer 时加 `*`）→ date → hash → 签名图标（`table.tsx:260-292`）。
- 选中态、当前分支高亮（仅当日志含当前分支外提交时才高亮，避免遮住选择）、merge/picked 调暗、我的提交/merge 加粗（`table.tsx:233-241`）。
- 底部无插件状态栏；只有顶部 2px loading bar 与空态提示（`No commits matching filters` + `Reset filters` / `No changes committed.` + `Commit local changes`）（`table.tsx:301-321`）。

### 3.2 Commit 页

见 §2.2 线框。树与提交面板用竖直 Split（初始 290，min 120）；消息框高度随面板，`min-height: 40px`（`src/webview/commit/commit.css:63`），按钮行 40px（`:182`）。

### 3.3 Branches 页

```text
┌ 🔍 Search for branches and actions                    [↻ Fetch] [⚙] ┐
├ Update Project…                                          ⌃T         │
├ Commit…                                                  ⌃K         │
├ Push…                                                    ⇧⌃K        │
├ ＋ New Branch…                                           ⌥⌃N        │
├ Checkout Tag or Revision…                                          │
├ ▾ Recent                                                           │
│  ▾ feat                                                            │
│    codex-runtime                                              ›    │
├ ▾ Local                                                            │
│  ▾ chore                                                           │
│    ★ main   origin/main   ↑2 ↓1                               ›    │
├ ▾ Remote                                                           │
├ ▾ Tags                                                             │
└────────────────────────────────────────────────────────────────────┘
```

行高 24px、分隔 9px、缩进 18px（`branchesTab.tsx:11-17`）；行内元素：chevron、ref 图标/星标、名称（匹配高亮）、领先/落后、spacer、`›`。

### 3.4 冲突对话框 / 合并窗口 / Push 对话框 / Local History

见 §2.6、§2.7 线框。Push：

```text
┌ Push Commits to repo ──────────────────────────────────────────────── ✕ ┐
│ source: main → [origin ▾] [main ▾]      ☑ Push tags: [All ▾]  ☑ Run Git hooks │
│ ┌ 提交树 ──────────────┐ ┌ 选中提交 ──────────────────────────────────┐ │
│ │ ▾ repo  3 commits    │ │ subject / body                             │ │
│ │  ☑ abc123 subject    │ │ author <mail> on date                      │ │
│ │  ☑ def456 subject    │ │ 3 files  （变更树）                        │ │
│ └──────────────────────┘ └────────────────────────────────────────────┘ │
│                                        [Cancel] [Push ▾ / Force Push]   │
└──────────────────────────────────────────────────────────────────────────┘
```

Local History：左 340（min 200）活动列表 + 右侧 diff；顶部搜索；行按日分组。

---

## 4. Git 命令与数据模型覆盖

### 4.1 状态采集（Repository）

| 数据 | git 命令 | 证据 |
|---|---|---|
| HEAD / 分支 / ahead-behind / detached / shallow | `symbolic-ref -q --short HEAD`、`rev-parse -q --verify HEAD`、`rev-parse --abbrev-ref --symbolic-full-name @{upstream}`、`rev-list --left-right --count HEAD...@{upstream}`；shallow 看 `.git/shallow` | `src/git/repository.ts:144-176` |
| 操作中状态（状态机输入） | 检测 `.git/rebase-merge`、`rebase-apply/rebasing` 或 `rebase-apply/applying`、`MERGE_HEAD`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`BISECT_LOG` | `repository.ts:178-187` |
| 工作区状态 | `git --no-optional-locks status --porcelain=v2 -z --untracked-files=all/normal/no [--ignored=matching]` → `parseStatusV2` | `repository.ts:189-196` |
| refs / 收藏 / 领先落后 | `for-each-ref --format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(HEAD)%00%(creatordate:unix) refs/heads refs/remotes refs/tags` | `repository.ts:198-233` |
| remotes | `remote -v` | `repository.ts:235-247` |
| stashes | `stash list --format=%gd%x00%H%x00%gs%x00%ct%x01` | `repository.ts:249-262` |
| 文件内容（任意 revision / merge stage） | `show <ref>:<path>`、`cat-file blob` | `repository.ts:264-...` |

### 4.2 日志查询

- 参数构造集中在 `logArgs(filters, options)`（`src/features/log/filters.ts:41-64`）：`--topo-order`/`--date-order`、`--first-parent`、`--no-merges`、`--author=`、`--since/--until`、`--grep= -i -E|--fixed-strings`、`-L start,end:path -s`、`--parents`（路径限定时保持图连通）、`--follow`、分支列表或 `--branches --remotes --tags HEAD`、`-- paths`。
- 多仓库：为每个仓库做 `filtersForRepo` 归一化（分支存在性、绝对/相对路径、Roots 过滤），不存在则跳过该仓库（`filters.ts:79-106`）。
- 分页流式：`LogStream` 用子进程 + 背压，每页 `next(500)`，webview 每 200 行一块（`src/git/logStream.ts:49-120`、`src/features/log/model.ts:12`、`src/webview/log/store.ts:6`、`:133-163`）。
- 图布局：`GraphLayout` 增量算法（泳道、颜色、merge 分叉、长边折叠、隐藏提交虚线），每行返回 `GraphRow {edges, width}`（`src/git/graph.ts:22-100`）。
- 详情：`git show -s --decorate=full --format=<LOG_FORMAT>%x00%B%x00%G?%x00%GS`（body + 签名）；变更 `git diff-tree -r -z --name-status -M --no-commit-id <left> <newest>`；单提交 left=第一父（无父→空树 hash `4b825dc...`）；多提交 left=最旧提交的父；merge 可用「Show Changes to Parents」逐父 diff；包含分支 `git branch -a --contains <hash> --format=%(refname)`（`src/features/log/details.ts:9-81`）。
- 上下文判定：`merge-base --is-ancestor <hash> HEAD`、`@{upstream}`；`contextInfo` 汇总 `inHead/pushed/hasMerges/isHead/refs/webUrl/operation/mixedRoots/hasRemoteBranches`，直接决定右键菜单可用性（`src/features/log/logTab.ts:333-362`）。

### 4.3 写操作覆盖（按模块）

| 动作 | 关键 git 命令 / 机制 | 证据 |
|---|---|---|
| 精确文件提交（无暂存区） | `git add -f <untracked/conflict>` + `git commit -F msg --only --pathspec-from-file=- --pathspec-file-nul`；merge/cherry-pick/revert 中改为 `add -A` 后整体 commit | `src/features/commit/gitOps.ts:59-88` |
| Amend 更早提交 | `commit --amend`（HEAD）或 `commit-tree amend! <hash>` + `rebase -i --autosquash --autostash <hash>~1` | `gitOps.ts:114-121` |
| 文件移动单独成 commit | 临时 index：`read-tree HEAD` + `update-index --index-info` + `write-tree` + `commit-tree` + `update-ref HEAD` | `gitOps.ts:94-112` |
| Rollback | `rm --cached` + `restore --source=HEAD --staged --worktree`；新增文件可删除 | `gitOps.ts:137-165` |
| Shelve / Unshelve | 生成二进制 patch（`diff --cached --binary -M --full-index`）+ rollback；恢复用 `apply --binary`，失败再 `apply --3way`，冲突则进冲突对话框 | `gitOps.ts:183-275` |
| Stash apply/pop/drop/clear | `stash apply/pop/drop/clear`（`index` 可选） | `src/features/commit/view.ts:686-726` |
| Cherry-pick / Revert | `cherry-pick` / `revert`（冲突时弹对话框；本地改动先 stash） | `src/features/ops/history.ts:242-276` |
| Undo Commit | HEAD：`reset --soft HEAD~1`；更早：`update-ref -d HEAD` + 临时分离 + `reset`；要求未推送 | `history.ts:188-211` |
| Reword / Fixup / Squash / Drop | `rebase -i` + 生成 todo（pick/edit/reword/squash/fixup/drop），`GIT_SEQUENCE_EDITOR` 脚本注入；Drop 要求提交未进任何远程分支 | `src/features/ops/engine.ts:590-744`、`:765-812`、`history.ts:79-180` |
| Interactive Rebase | `loadRebaseCommits` → UI → todo 文件 → `rebase -i`（支持 `--update-refs`，Git ≥2.38） | `engine.ts:671-744` |
| Merge | `merge` + 选项（--no-ff/--ff-only/--squash/-m/--no-commit/--no-verify/--allow-unrelated-histories） | `history.ts:369-416`、`mergeRebase.tsx:25-40` |
| Reset | `reset --soft/--mixed/--hard/--keep <target>`（UI 提供四模式说明） | `history.ts:213-240` |
| Branch CRUD / checkout / compare | `checkout [-b] [-B]`、`branch -m/-d/-D`、`branch --set-upstream-to`、`rebase`、`merge` | `engine.ts:142-161`、`branches.ts:173-330` |
| Push | `push --porcelain --progress [--force-with-lease] <remote> <src>:refs/heads/<dst>`，`rev-list --count <target>..<source>` 预计算提交，`rev-parse refs/remotes/...` 判新分支 | `engine.ts:232-330`、`remote.ts:55-...` |
| Update | `fetch` → `merge`/`rebase`（或 branch.<x>.rebase / pull.rebase）；本地改动 `stash -u` 或 Shelve 后恢复 | `engine.ts:332-405`、`update.ts:39-110` |
| Force-pushed 恢复 | 备份分支 `branch <backup> HEAD` → `reset --hard <upstream>` → 恢复 stash → 删备份 | `engine.ts:407-493` |
| Worktree | `worktree add/list --porcelain/remove/prune/lock/unlock` | `engine.ts:494-583` |
| Patch | `diff --binary` 生成；`apply --check` + `apply [--3way]`；剪贴板导入 | `history.ts:516-576` |
| Reflog 最近分支 | `reflog show --format=%gs -n 300 HEAD --` 解析 `checkout: moving from A to B` | `branches.ts:29-49` |
| 文件历史 | `log --follow --name-status -z --format=... HEAD -- <file>`；`Get` = `checkout <rev> -- <path>` | `logTab.ts:600`、`:719-733` |
| Blame | `blame --line-porcelain [-w] [-M] [-C]` | `annotate.ts:240-260` |

### 4.4 状态机与关键流程

1. **操作中状态机**：`none | merge | rebase | cherry-pick | revert | am | bisect`；由 `.git` 目录文件检测；UI 横幅提供 `continue`/`abort`/`skip`（skip 仅 rebase/cherry-pick/revert）。冲突时把控制权交给 Conflicts 对话框，全部解决后自动 `commit`（merge）或 `rebase --continue`（rebase）（README「冲突出现的时机」；`conflicts.ts:287-350`）。
2. **冲突感知执行器** `runConflictAware`：统一分类 `success | conflicts | localChanges | stopped | error`；解析 stderr 的 "would be overwritten" 文件列表 → 触发 Smart Operation（`engine.ts:66-90`、`:52-64`、`:208-230`）。
3. **Smart Operation**：`StashSaver(includeUntracked=true)`：`stash push -u -m ...` → 操作 → `stash pop`；pop 冲突时把 stash 冲突作为「Saved changes」上下文交给冲突对话框，且**不恢复**后续 stash（`engine.ts:162-230`）。
4. **Push 被拒**：解析 porcelain 结果；`push.autoUpdateOnRejected` 或 Push Rejected 对话框 → update(merge/rebase) → 重试 push；Force Push 用 `--force-with-lease`（`engine.ts:273-330`、`remote.ts:180-300`）。
5. **迭代式冲突模型**：`MergeModel`（base/left/right → changes + states）纯逻辑；编辑通过 `updateRangeOnModification` 调整范围；`resolvedCount()/unresolved` 驱动徽标与按钮；`Save and Close` 只写文件，`Accept and Finish` 才 `git add`（`src/shared/mergeModel.ts:213-434`、`src/features/commit/conflicts.ts:72-83`、`:276-280`）。
6. **UI 刷新**：`repo.batch(fn)` 挂起 watcher，完成后统一刷新一次；`schedulePush()` 50ms 去抖推送到 webview（`repository.ts:105-122`、`view.ts:110-120`）。

### 4.5 持久化数据

| 数据 | 位置 | 证据 |
|---|---|---|
| Shelf 元数据 + patch | `<storage>/shelf/shelf.json`、`<id>.patch` | `shelf.ts:9-40` |
| Changelists（列表/active/文件归属/勾选） | `workspaceState['ideagittool.changelists']` | `changelists.ts:17-50` |
| 提交草稿 / 历史（25 条）/ 选项 | `workspaceState`：`ideagittool.commit.draft` / `messageHistory` / `options` | `view.ts:30-33`、`:443-447` |
| Commit 视图设置 | `workspaceState['ideagittool.commitView.settings']` | `view.ts:30-35` |
| Log UI 设置（25 项） | `globalState` | `logTab.ts:359`（`saveSettings`） |
| 分支收藏 | `workspaceState['favorites:<root>']`，默认 main/master | `src/git/manager.ts:80` |
| Local History | `globalStorage`：`events.jsonl` + `content/` | `localHistory/store.ts:35-49` |
| 窗口/对话框偏好 | 各 webview localStorage（`persist/persisted`） | `src/webview/lib/rpc.ts` |

### 4.6 Host ↔ Webview RPC 协议（可作 DSH 传输设计参考）

- 每个 webview 通过 `call(method, params)` / `on(event)` 通信；host 用 `WebviewConnection.handleAll({...})` 注册；异常自动变成通知（`ARCHITECTURE.md`「Conventions」；`src/host/webviewHost.ts`）。
- Log 协议：`rows/setFilters/details/containing/contextInfo/saveSettings/authors/find/commitAction/changeAction/branchAction/command/pickPaths/pickDate/pickBranches/copy/newTab/input/refreshRepo/openUrl/signatures/cherryPicked/myBranches/fileDiff`（`logTab.ts:137-174`）。
- Commit 协议：`ready/refresh/setIncluded/setIncludedExactly/saveDraft/setSettings/setOptions/defaultAuthor/showDiff/openSource/commit/amendMessage/amendCandidates/rollback/deleteFiles/addToVcs/ignore/moveToChangelist/newChangelist/editChangelist/removeChangelist/setActiveChangelist/shelve/shelveSilently/createPatch/copyPatch/copyPath/removeFromVcs/revertResolved/localHistory/showHistory/annotate/resolveConflicts/acceptYours/acceptTheirs/mergeConflict/operation/gitCommand/activeFileKey/... + Shelf/Stash 段`（`view.ts:205-347`）。
- DTO 全部在 `src/shared/*Protocol.ts` + `types.ts`，零 VS Code 依赖，可直接复用为 DSH 的前后端契约（`logProtocol.ts:137-182` 的 `RowData`/`DetailsResult`/`ContextInfo` 尤其完整）。

---

## 5. VS Code 专属能力标注（DSH 必须降级或砍掉）

| 能力 | 用在哪 | 具体 API / 依赖 | DSH 现状 | 处置建议 |
|---|---|---|---|---|
| Webview View（侧边栏） | Commit 工具窗口、底部 Log 面板 | `registerWebviewViewProvider`（`commit/index.ts:23`、`log/index.ts:161`） | 右侧栏 tab 机制（platform-analyst 文档为准） | 改为 DSH 侧栏 tab |
| Webview Panel（编辑器 Tab） | Log（showInEditor）、28 种对话框、合并窗口、Local History | `createWebviewPanel`（`log/index.ts:79`、`dialog.ts:28`、`mergeTool.ts:76`、`localHistory/view.ts:45`） | 无编辑器区 | 改为侧栏内路由/overlay 或全屏 pane |
| 文本编辑器 decoration（gutter） | Annotate | `createTextEditorDecorationType`（`annotate.ts:193-230`） | **无编辑器** | **不做**；降级为「文件 blame 列表」（逐行 blame 表） |
| 文本编辑器 decoration（行尾） | Inline blame | `createTextEditorDecorationType(after...)`（`inlineBlame.ts:12-20`） | **无编辑器** | **不做** |
| CodeLens + 编辑器标题按钮 | 冲突文件「Resolve Conflicts…」 | `registerCodeLensProvider`（`conflictEditor.ts:171-185`）、menus `editor/title` | **无编辑器** | **不做**；冲突入口放在 Git 面板横幅与文件行内按钮 |
| 文件装饰色（Explorer/编辑器 Tab） | 文件 Git 状态 | `registerFileDecorationProvider`（`decorations.ts:22-61`） | 无资源管理器 | **不做**；状态色只用于自绘列表 |
| VS Code Diff 编辑器 | 单文件/多文件 diff、Get、比较 | `vscode.diff`、`vscode.changes`、`openMultiDiff`（`logTab.ts:664-693`、`view.ts:349-368`） | 无编辑器 | 改为自绘 diff（可复用 `diffView.tsx` + `lineDiff.ts`） |
| 只读 FS / Content Provider | revision 内容、Local History 内容 | `registerFileSystemProvider('ideagittool-git')`（`extension.ts:44`）、`registerTextDocumentContentProvider('ideagittool-lh')`（`localHistory/index.ts:27-35`） | 无编辑器 | 不需要；diff 数据直接走 JSON |
| 保存/文件系统事件 | Local History 记录 | `onDidSaveTextDocument`、`onDidCreate/Delete/RenameFiles`、`FileSystemWatcher`（`recorder.ts:62-72`、`repository.ts:47-90`） | Host 可 watch 文件系统（待 platform 文档确认 API） | 若做 Local History，改为 Host 侧 fs watch + 轮询 |
| workspaceState / globalState | 草稿、changelists、UI 设置、收藏 | `ctx.extension.workspaceState/globalState` | 需 DSH 存储 API | 换成 DSH 插件存储；契约层不变 |
| VS Code 设置 + ConfigurationTarget | 42 个设置、冲突 UI 开关 | `workspace.getConfiguration`、`update(..., Global/Workspace)`（`conflictEditor.ts:23-33`、`update.ts:52-60`） | 需 DSH 设置 API | 仅保留 Git 行为类设置；「关掉 VS Code 自带冲突 UI」整段删除 |
| TabGroups 监听 | 检测合并编辑器关闭以标记 resolved | `tabGroups.onDidChangeTabs`（`conflicts.ts:111-117`） | 无编辑器 | 删除；`merge.useVsCodeMergeEditor` 分支整体砍掉 |
| QuickPick 多级菜单 | Git 菜单 / VCS Popup | `createQuickPick`（`mainMenu.ts:148-176`） | 无原生 QuickPick | 改用 webview 自绘菜单/popover |
| 输出通道 | Git Console | `createOutputChannel`（`host/output.ts`） | 可用日志面板/调试视图 | 降级为「命令日志」折叠区 |
| 生命周期/激活 | 扩展模型 | `workspaceContains:.git`、`onStartupFinished` | DSH 插件加载 | 改为插件激活时扫描会话 cwd |

**仍然完全可移植（无 vscode import）**：
`src/shared/types.ts`、`intellijDiff.ts`、`lineDiff.ts`、`mergeModel.ts`、`mergeResolve.ts`、`branchesTree.ts`、`logProtocol.ts`（仅类型）、`commitProtocol.ts`（仅类型）、`branchesProtocol.ts`、`src/git/graph.ts`、`src/features/log/filters.ts`。这是本项目最值得「搬」的资产。

---

## 6. 建议分级：P0 / P1 / P2 / 不做

> 判定依据：DSH 无编辑器、右侧栏窄（300–500px，可全屏）、Host 可执行 git、用户核心诉求是「在 Agent 工作区里快速看懂与操作 git」。参考项目的「IntelliJ 全功能」不是目标，**信息密度与可操作性**才是。

### P0（首版必须）

| # | 能力 | 理由 | 参考实现可复用度 |
|---|---|---|---|
| 1 | 仓库发现 + 工作区状态（branch/HEAD/ahead-behind/operation/change 列表） | 一切功能的地基；DSH 用户在 agent 会话里最需要「现在是什么状态」 | `repository.ts:144-262` 逻辑可平移 |
| 2 | 提交列表（单栏）+ 提交详情 + 文件列表 | 替代 Log 三栏；是阅读历史的最小闭环 | 复用 `RowData`/`DetailsResult`/`details.ts` 查询逻辑 |
| 3 | 提交 diff 查看（自绘统一/并排） | DSH 无 diff 编辑器，必须自绘 | **直接移植** `diffView.tsx` + `lineDiff.ts` |
| 4 | 勾选文件提交（`--only` 精确提交）+ Amend + Commit and Push（简化） | 参考项目最核心的差异点：无暂存区、按文件提交 | `gitOps.ts:59-121` 命令逻辑直接复用 |
| 5 | 分支列表 + checkout / new / delete / merge / rebase / push / pull / fetch | 日常高频；Branches 页可单列 | `branches.ts`/`engine.ts`/`history.ts` 命令层 |
| 6 | 冲突最小闭环：冲突文件列表、Accept Yours/Theirs、标记已解决、continue/abort | 没有冲突解决，Git 面板在 agent 场景不可用 | `conflicts.ts:137-149`（sides）+ `view.ts:728-736`（accept）+ `gitOps.ts:362-375`（checkout --ours/--theirs） |
| 7 | 刷新机制（watch `.git` + 手动刷新）与操作日志 | 保证 UI 不陈旧、可排障 | `repository.ts` watcher 设计可参考 |

### P1（增强，首版后 1–2 迭代）

| # | 能力 | 理由 |
|---|---|---|
| 8 | 提交图（泳道 + 分支/标签标记 + 当前分支高亮） | 参考项目的灵魂 UI；`graph.ts` 可直接移植，成本低于想象 |
| 9 | Log 过滤器（text/hash、branch、user、date、paths）+ Graph Options | 历史变大后必需；`filters.ts` 直接复用 |
| 10 | 多选提交批量操作（cherry-pick、revert、squash、drop、reset） | 高阶但常用；命令层已具备 |
| 11 | Stash 列表 + apply/pop/drop + 文件预览 | 与 shelf 二选一，先做 stash（Git 原生、语义简单） |
| 12 | Shelf（可选：映射到 stash 或自有 patch store） | 只有从 IntelliJ 迁移的用户强需求，优先级低于 stash |
| 13 | Push 对话框（force-with-lease、tags、hooks、目标分支） | 首版可先用简化确认框，P1 补全 |
| 14 | Update/Pull/Merge/Rebase 对话框（选项 chips） | 复杂选项需要解释；对话框宽度 520–640，DSH 需全屏/抽屉 |
| 15 | Interactive Rebase（列表式 todo 编辑） | 参考项目实现完整，纯逻辑可复用；UI 需重写 |
| 16 | 文件历史 + 提交内搜索/GoTo | 定位代码变更的高频路径；可先用「文件历史」而非完整 Log |
| 17 | Blame 列表（按文件/按行段，非 gutter） | DSH 无编辑器，只能做列表；价值仍高 |
| 18 | 提交消息历史 / 草稿 / 模板 | 提升提交体验，成本低 |

### P2（远期）

| # | 能力 | 理由 |
|---|---|---|
| 19 | 多仓库合并日志 + 按仓库分组/着色 | 仅多根工作区需要；DSH 会话通常单 cwd |
| 20 | Worktree 管理 | 低频；DSH 可先只读展示 |
| 21 | Local History | 与 Git 无关的独立子系统（recorder + blob store + 5 天保留），成本高；但「agent 改坏了怎么找回」是真实痛点，可作为差异化远期项 |
| 22 | Patch 导入/导出/剪贴板 | 低频；命令层现成 |
| 23 | Changelists（多变更列表） | IntelliJ 特有概念，DSH 用户认知成本高 |
| 24 | GPG 签名列 / 签名详情 | 小众；数据已在 log format 中 |
| 25 | Compare refs（两分支差异文件列表） | 可由「分支菜单 → 查看差异」覆盖 subset |
| 26 | Add Commits to Remote Branch / Push All up to Here | 高级工作流 |
| 27 | Clone / Init / Unshallow / Remotes 管理 | DSH 面向已存在工作区，非首版场景 |

### 不做（不可行或不划算）

| 项 | 原因 |
|---|---|
| Gutter Annotate / Inline Blame / 冲突 CodeLens / 编辑器标题按钮 | 无编辑器，硬依赖 `TextEditorDecorationType` / `CodeLensProvider` |
| Explorer/编辑器 Tab 文件状态色 | 无 VS Code 资源管理器；自绘列表内保留状态色即可 |
| `vscode.diff` / `vscode.changes` / 合并编辑器集成 | 无编辑器；且「关掉 VS Code 冲突 UI」的设置操纵完全无意义 |
| `intellijShortcuts` 覆盖 VS Code 快捷键 | 宿主不同；DSH 需自己的键位方案（且避免与聊天/输入框冲突） |
| QuickPick 原生菜单 / 输出通道 / 状态栏 | 宿主无对应物；用 webview 菜单与日志区替代 |
| Rebased 差异中提到的「悬浮弹层 / 行号栏菜单」 | 参考项目本身已放弃，DSH 同样不具备 |

---

## 7. 对 DSH 右侧栏窄面板的 UI 适配建议

### 7.1 DSH 右侧栏的真实宽度约束（读自 DSH 源码）

| 事实 | 值 | 证据 |
|---|---|---|
| 右侧栏最小宽度 | **300px** | `packages/client/ui-layout/src/client/columns.ts:25`（`RIGHTBAR_MIN = 300`） |
| 首次打开默认宽度 | 视口 **45%** | `columns.ts:29`（`RIGHTBAR_DEFAULT_RATIO = 0.45`） |
| 最大宽度 | 视口 **70%** | `columns.ts:27`（`RIGHTBAR_MAX_RATIO = 0.7`） |
| 全屏展示 | 支持（`data-sidebar-right-panel='fullscreen'`，宽度 100vw） | `packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css:70-90`、`SidebarRight.tsx:302-311` |
| 浮层/叠加层 | dockkit 提供 float layer（z-index 60） | `SidebarRight.module.css:33-42`（`--dsh-dockkit-float-layer: 60`） |

**结论**：在 1440px 视口下默认约 648px、最小 300px；参考项目的 Log 三栏最小需求约 `140 + 360 + 表格 ≈ 700–820px`，**默认宽度下必然放不下**，必须重排。

### 7.2 参考项目各页面的最小宽度需求（实测自代码）

| 页面 | 参考尺寸 | 最小可用宽度 | 证据 |
|---|---|---|---|
| Log 三栏 | branches ≥140 + 表格 + right ≥160 | ~700px（含 author/date 列） | `main.tsx:190-220`、`table.tsx:112-113`、`logProtocol.ts:64-94` |
| Log 单栏（隐藏右栏、关 author/date） | graph 60 + subject | **~320px** | 同上 |
| Commit 页 | 树 + 底部消息面板（单栏） | **~300–360px** | `commitTab.tsx:407`、`commit.css:63/182` |
| Branches 页 | 单列列表 + 搜索 | **~280px** | `branchesTab.tsx:11-17`、`:289-326` |
| 冲突对话框 | 850 × 470/570 | **~520px**（三列表格） | `conflictsDialog.tsx:191-193` |
| 合并窗口 | 三栏 + gutter + 工具条 | **~900px**（低于此应禁用并排） | `merge/main.tsx:270-351` |
| 普通对话框 | 460–850 宽 | 460 起 | §2/`registerDialog` 各文件 |
| Push 对话框 | `min(1000px, 100vw-32px)` × `min(640px, 100vh-32px)`，双栏 | ~560px | `push.tsx:149-152` |
| Local History | 左 340（min 200）+ diff | ~560px | `localHistory/main.tsx:89` |
| Diff 并排 | 双栏 | ~560px；统一视图 ~320px | `diffView.tsx:140-216` |

### 7.3 建议的默认宽度与呈现模式

| 页面 | DSH 默认宽度建议 | 最小宽度 | 超窄（<360）降级 |
|---|---|---|---|
| **提交/工作区（P0 主页）** | 380–420（占 45% 时自然值） | 300 | 单列树 + 底部消息框折叠为「写提交信息」按钮 → 全屏编辑 |
| **Log 列表** | 420–480 | 320 | 隐藏 author/date/hash 列；graph 限 3 lane；详情改底部抽屉 |
| **提交详情 + 文件** | 作为 Log 的抽屉（底部 40%） | 300 | 全屏子页 |
| **Branches** | 320 | 280 | 搜索 + 单列，动作收进行尾 `›` 菜单 |
| **Diff 预览** | 全宽 / 全屏 pane | 480（并排）/ 320（统一） | 默认统一视图，可切换并排 |
| **冲突列表** | 420（去掉 Yours/Theirs 列，改行内两个图标按钮） | 320 | 单列 + Accept 菜单 |
| **合并窗口** | **全屏 pane** | 720 | 低于 720 强制统一结果编辑 + 逐块 Accept |
| **对话框（Push/Update/Merge 等）** | **全屏 pane 或 overlay** | 480 | 单列表单，选项用 chips 折行 |

### 7.4 布局重排规则（可直接作为验收标准）

1. **断点**：`<560` 三栏 → 两栏；`<420` 两栏 → 单栏 + 抽屉；`<340` 只保留列表与主操作。
2. **Log**：默认只显示「graph + subject + refs」；author/date 作为可开关列；右侧变更/详情合并为一个可折叠底部抽屉（参考项目的 `Split vertical` + `showDetails`，`changes.tsx:331-337`）。
3. **Branches 面板**：不要常驻左栏；改为 Log 工具栏上的分支 chip/按钮唤出 **drawer** 或全屏子视图（参考项目 `branches-stripe` 的折叠设计，`main.tsx:208-217`）。
4. **Commit 页**：天然单列，优先做主页；勾选框 + 目录树必须保留（这是参考项目最有效的交互）；消息框建议固定底部 120–160px，键盘 `Ctrl+Enter` 提交。
5. **对话框**：不要在 300px 栏内做居中 modal。用 ①全屏 pane（表单复杂：Push/Merge/Rebase/交互式 Rebase/合并窗口）或 ②overlay 浮层（简单确认/输入：Stash/New Branch/Tag/Reset）。DSH dockkit 已有 float layer，可直接用（`SidebarRight.module.css:33-42`）。
6. **工具栏溢出**：图标按钮保持 26–28px（参考 `Toolbar`），一行放不下时收进 `⋯` 菜单；过滤 chip 横向滚动或收进「筛选」popover。
7. **多视图组织**：建议只注册 **1 个右侧栏 tab**（如「Git」），内部二级页：`日志 / 提交 / 分支 / 贮藏`（默认日志页）；冲突与合并作为该 tab 的全屏子路由。不要注册 4 个并列 tab（DSH 右栏 tab 条本身会挤）。
8. **键盘**：参考项目大量快捷键与 VS Code 冲突（`intellijShortcuts` 默认覆盖 `Ctrl+T`/`` Ctrl+Shift+` ``）。DSH 中 `Ctrl+K` 等很可能是聊天/命令面板保留键，需重新映射；建议只保留 `Enter`/`Esc`/方向键/F7 这类局部键，全局键交给 DSH 命令系统。
9. **空态与首屏**：无仓库 → 引导选择 cwd；有仓库无提交 → 直接展示工作区变更（参考项目 Log 空态就给了 `Commit local changes` 链接，`table.tsx:311-320`）。
10. **性能**：沿用参考项目的分页（500/页）+ 虚拟滚动（26px 行高）；窄栏下不要一次渲染全部 commit。

### 7.5 视觉与信息密度

- 参考项目的密度参数可直接借用：行高 26px、工具栏 26/28px、树行 24px、正文 12–13px、`mono` 用于哈希/路径、状态色 6 种（`base.css:1-60`、`log.css:28/76/121`、`commit.css:5-36`、`branchesTab.tsx:11-17`）。
- **不要照搬 IntelliJ 皮肤**：DSH 有自身设计 token；应映射为 DSH 语义色（背景/边框/选中/警告/冲突），保留「状态色 + 等宽哈希 + 紧凑行高」这套信息编码即可。
- 窄栏下优先保留：分支/HEAD、ahead/behind、文件状态字母或颜色、提交 subject、时间。可牺牲：author 列、完整 hash、GPG 图标、refs 全名（用 `main`/`origin/main` 短名 + tooltip）。

---

## 8. 复刻风险与缺口清单

1. **合并窗口成本最高**：三栏 + 曲线连接 + 词级高亮 + 范围跟踪（`mergeModel.ts` 488 行 + `mergeResolve.ts` 726 行 + CodeMirror 集成）。逻辑可复用，但 CodeMirror 在 DSH 侧栏是否可接受需验证；否则降级为「逐块 Accept」列表。
2. **交互式 Rebase 的 todo 注入**依赖 `GIT_SEQUENCE_EDITOR` 脚本（`engine.ts:644-665`），Host 侧可行但需处理 Windows/路径/引号；建议首版只做 UI 排序 + 一次生成 todo，不追求交互式中途编辑。
3. **Multi-root / Worktree** 的「打开新窗口」语义在 DSH 中不存在，需改为切换会话 cwd 或只读展示。
4. **Annotation/blame 的性能**：参考项目对每个文件跑 `blame --line-porcelain` 并缓存一个 document version；DSH 无编辑器，改为按需按钮触发 + 结果表格，成本可控。
5. **Local History 是独立子系统**（recorder + watcher + blob store + 保留策略），如果要做，建议单独排期；不要塞进 Git 首版。
6. **对话框数量大**（28 种）：不要 1:1 复刻；首版收敛为 6–8 个（Commit Options、Stash、New Branch、Tag、Reset、Push、Update、Merge/Rebase）。
7. **本地化**：参考项目以英文为源，经 VS Code l10n 提供中文（`l10n/bundle.l10n.zh-cn.json`、`package.nls.zh-cn.json`、`vscode.l10n.t`）。DSH 需自带中英双语，可直接把这两个文件当术语表复用（如 `Yours/Theirs`、`Apply non-conflicting changes`）。

---

## 附录 A：对话框清单（28 种，kind / 尺寸 / 关键控件）

| kind | 尺寸 | 关键控件 |
|---|---|---|
| `commit.conflicts` | 850×470/570 | 冲突表格、Accept 内联按钮、Resolve All Simple Conflicts、Close/Accept and Finish/Resolve Manually |
| `commit.rollback` | 620×520 | 文件勾选树、Delete added files |
| `commit.shelve` | 640×600 | 文件勾选树、名称输入 |
| `commit.unshelve` | 620×540 | 文件勾选、目标 changelist、Remove applied |
| `commit.changelist` | 460 | 名称/注释/Make active（新建与编辑复用） |
| `commit.stash` | 520 | 仓库选择、文件勾选 |
| `commit.unstash` | 620 | stash 选择、Remove after apply |
| `commit.createPatch` | 680×640 | 文件勾选、patch 选项（路径/反向） |
| `log.newCommitMessage` | 600 | 多行消息编辑（reword） |
| `ops.push` | ≤1000×640（响应式，双栏） | 提交树、目标分支、Force Push、tags、hooks |
| `ops.pushRejected` | 520 | Rebase/Merge/Force Push/Cancel |
| `ops.pull` | 580 | remote/branch、选项 chips |
| `ops.merge` | 580 | 分支、merge 选项、message |
| `ops.rebase` | 640 | upstream/onto/switch、选项 chips |
| `ops.interactiveRebase` | 大（列表） | 提交列表、动作按钮、message 编辑、View Git Commands |
| `ops.reset` | 540 | 四模式 + 目标提交 |
| `ops.tag` | 520 | 名称/Force/Commit/Message |
| `ops.newBranch` | 480 | 名称、checkout、overwrite（校验规则） |
| `ops.checkoutRevision` | 480 | ref 组合框 |
| `ops.update` | 520/600 | Merge/Rebase、清理方式、Reset to remote |
| `ops.smartOperation` | 560 | Don't / Force / Smart + 阻挡文件列表 |
| `ops.remotes` | 640 | remote 列表、Add/Edit/Remove |
| `ops.clone` | 640 | URL/目录 |
| `ops.newWorktree` | 620 | 路径/分支/检出 |
| `ops.commitMessage` | 620 | 提交消息（merge/cherry-pick 等） |
| `ops.notFullyMerged` | 620 | 未完全合并分支的提交列表 |
| `ops.createPatch` | 600 | patch 文件路径/数量 |
| `confirm` | 480 | 通用确认 |

## 附录 B：关键文件索引（按移植价值排序）

| 文件 | 行数 | 价值 |
|---|---|---|
| `src/shared/mergeModel.ts` | 488 | 三栏合并状态机（纯逻辑，可移植） |
| `src/shared/mergeResolve.ts` | 726 | IntelliJ magic resolve + 词级三方 diff（纯逻辑） |
| `src/shared/intellijDiff.ts` | 249 | Myers LCS diff（纯逻辑） |
| `src/shared/lineDiff.ts` | 166 | 行 diff（纯逻辑） |
| `src/git/graph.ts` | 299 | 提交图泳道布局（纯逻辑） |
| `src/features/log/filters.ts` | 116 | 过滤器 → git 参数 |
| `src/features/log/details.ts` | 81 | 提交详情/变更查询 |
| `src/features/commit/gitOps.ts` | 375 | 提交/搁置/回滚的 git 命令封装 |
| `src/features/ops/engine.ts` | 837 | 分支/更新/推送/Rebase/Worktree 引擎 |
| `src/host/dialog.ts` | 80 | 对话框承载模式（需重写） |
| `src/webview/log/*` | ~2.4k | Log UI（样式与交互可借鉴，需重写） |
| `src/webview/merge/*` | ~1.3k | 合并窗口（CodeMirror，需重写或降级） |
