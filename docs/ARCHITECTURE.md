# ARCHITECTURE：模块地图与分层规则

本文件只描述**代码结构**和**依赖方向**，内容必须和代码保持一致（SOP §10）。产品与页面设计见 [产品设计 v0.2](design/2026-10-25-产品设计-v0.2.md)；技术方案见其中 §16 与 [DSH 集成可行性调研](references/dsh-integration-feasibility.md)。

> 状态：2026-10-28，B3、B4a（设置页与 Blame 渲染器）已合并——A1 只读（日志/提交图/详情/diff/分支/状态栏/控制台 + `.git` watch 刷新）、A2 提交闭环、A3 分支/贮藏/冲突（四个 Level 0 页、集成操作、操作控制、冲突列表、贮藏页）、B1 三栏合并（合并模型、合并 store、三栏合并窗口、冲突列表增强与审查更改；`mergeWindow` 默认开启）。B2 历史与 Blame（Host blame/fileHistory/compare 与 diff range、Blame 视图与 `git.blame` 页、文件历史页、比较页、覆盖层返回链、跨 tab 意图队列）。B3a 交互式变基（`rebasePlan`/`interactiveRebase`、共享 todo 规则、变基覆盖页、日志快捷动作；flag `interactiveRebase` 默认开启）与 B3b Diff 增强与提交菜单（并排/词级/忽略空白/完整文件、撤销提交/推送到此/新建标签/Fixup·Squash into/补丁导出与应用；`src/client/settings.ts` 记住 Diff 模式）、B3c 搁架与 Changelist（贮藏页「贮藏 | 搁架」分段、提交页按 Changelist 分组）、B3d Worktree 与远程（远程页、Worktree 页（flag `worktrees` 默认开启）、标签推送/删除、远程分支删除、upstream）。
> 分层规则 R1–R5 已写入 [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs)，由 `make check` 强制执行。

## 1. 仓库顶层

```
dsh-idea-gittool/
  AGENTS.md / CLAUDE.md     # AI 入口地图
  Makefile                  # make check 是唯一质量关口
  .dependency-cruiser.cjs   # R1–R5 分层契约
  build.mjs                 # esbuild 双面产物构建（M0 T1）
  cordis.patch.yml          # 发布用：只插入 Host 行（M0 T1）
  dev.patch.yml             # 开发期 overlay，不随包发布（M0 T2）
  src/
    host/                   # Host half：RPC 路由、RepoResolver、GitExecutor
    client/                 # Client half：Git tab、页面、store、GitClient
    shared/                 # 两端共用的纯类型与 RPC 协议
  test/                     # vitest 单测 + 产物 smoke
  docs/                     # 知识库（设计、SOP、计划、ADR、references、runbooks）
  scripts/                  # 文档检查等开发脚本
  .githooks/                # pre-commit → make check-fast
```

## 2. 模块

| 模块 | 职责 | 可以依赖 |
|---|---|---|
| `src/client/` | 右侧栏 Git tab、四个平级页（日志/提交/分支/贮藏）、单一覆盖层、UI store、`git-client.ts`（fetch RPC，覆盖全部 A3/B1 端点）、`features.ts`（feature flag：默认值 + localStorage 覆盖；B1 `mergeWindow` 自 2026-10-27、B3 `interactiveRebase`/`worktrees` 自 2026-10-28 默认开启，可用 `'0'` 关闭）、`bootstrap-cache.ts`（每会话快照/去重/丢旧 version）、`use-bootstrap.ts`（快照与状态字母 hook）、`polling.ts`（可见时轮询）、`focus.ts`（覆盖层关闭后的焦点返回，纯函数）、`operations.ts`（共享的操作事实，如可跳过的操作集合 `SKIPPABLE`）、`workbench-intents.ts`（B2：按会话的意图队列，文档头部与 `git.blame` 页让 Git tab 打开覆盖层/定位提交，Git tab 未挂载时排队）、文档预览头部动作（`document-actions.tsx`：状态徽标跳提交页、Blame、历史、Diff，窄头部收进 ⋯）与 `git.blame` 页（`blame-page.tsx`：承载 `BlameOverlay`，跟随 tab navigation 换文件）、`settings.ts`（B4a：设计 §13 全部查看者偏好，单个 localStorage 键 `dsh-idea-git.settings.v1`，逐字段校验、写失败退回内存、同页订阅 + 跨标签页 `storage` 事件、`useSettings`）、`blame-renderer.tsx`（B4a：可选「Git Blame」文档渲染器，`ctx.inject(['documentPreviews'], …)` 内随设置注册/注销定义，正文复用 `BlameOverlay`，仓库外/未跟踪显示原文） | `src/shared/`；DSH baseline external（React、`@deepseek-ai/dsh-client-*`、`@tanstack/react-virtual`） |
| `src/client/pages/` | `GitWorkbench.tsx` 组装工作台并持有唯一的 `overlay` 状态；`workbench-overlay.ts`（覆盖层联合类型 + `useWorkbenchOverlay`：同一时刻一个覆盖层、Esc 退一级、焦点回到触发控件）；`PageTabs`（日志/提交/分支/贮藏，贮藏徽标）；日志：`LogPage`/`FilterBar`/`LogTable`/`LogRow`/`RefChips`/`CommitContextMenu`（提交右键菜单）；详情与 diff：`CommitDetail`/`ChangedFilesTree`/`DiffViewer`/`DiffHunks`/`DiffFileList`；提交页：`CommitPanel`/`ChangesTree`/`CommitMessage`（含合并/拣选/变基操作模式）；推送与回滚：`PushPage`/`PushRejectedPage`/`RollbackSheet`；分支：`BranchesPage`、`BranchPanel`+`branch-store`、`branch-actions`（动作项纯函数）、`BranchSheets`（新建/重命名/删除/签出修订号）、`SmartCheckoutSheet`；集成操作：`MergePage`（合并/变基共用）/`PullPage`/`UpdateProjectPage`/`ResetSheet`/`FetchSheet`/`CommitOpSheet`（拣选/回滚确认），配合 `integrate-actions`/`commit-actions`/`integrate-parts`/`use-loaded`；操作与冲突：`OperationBanner`、`ConflictsPage`、`operation-actions`；贮藏：`StashPage`/`StashCreateSheet`/`stash-actions`；`DirtyWorktreeSheet`（智能操作询问）、`ActionNotice`、`menu-position.ts`（菜单渲染后测量，收进视口与 Git 面板，行尾菜单右对齐/上翻）、`menu-focus.ts`（整行焦点与菜单键盘决策，JetBrains 式）、`RepoBar`/`StatusBar`；B1 三栏合并窗口：`MergeWindow`（容器 + 可静态渲染的视图）/`MergeWindowParts`（顶栏、底栏、确认条、二选一降级视图）、`merge-editor`（CodeMirror 6 适配：Result 同步与编辑提取、块着色、gutter 按钮、同步滚动）、`merge-window-controller`（键盘、F7 导航、离开询问、应用确认，React 无关）、`merge-fullscreen`（宿主全屏进入/退出决策与 hook）、`merge-review-wiring`（工作台对合并窗口与 Review Changes 队列的接线：应用后下一个、跳过不可审查的已解决文件、返回/切文件即停止，React 无关）；B2 历史与 Blame：`BlameView`（`BlameOverlay` 容器 + 可静态渲染的视图：行段 gutter、hover card `BlameHoverCard`、底部提交事实/页内 diff、行段菜单、分页、键盘）、`FileHistoryPage`、`ComparePage`（共用 `HistoryPages.module.css` 与页内 diff）、`ActionMenu`（通用浮层操作菜单，`CommitContextMenu` 委托它）、`file-actions`（文件动作可用性矩阵）、`list-keys`（列表键盘判定）；`workbench-overlay` 的覆盖层可带一级 `back`（关闭回到来源，`dismiss()` 一次退到页面）；B3d：`RemotesPages`（远程页、Worktree 页）、`RemoteSheets`（推送/删除标签、删除远程分支、upstream、新建 Worktree） | 同 `src/client/`；`merge-editor` 另依赖 `@codemirror/{state,view,commands}`（esbuild 内联）；页面只接收注入的 store/回调，不直接发 RPC（`GitWorkbench` 除外） |
| `src/client/store/` | React-free 的 `log-store`（分页/筛选/选择/键盘）、`detail-store`、`diff-store`；`changes-store`（分组/三态勾选）、`commit-store`（提交状态机、草稿/历史、`normal/merge/sequencer/rebase` 模式）、`push-store`（推送表单、被拒处理、回滚）；A3：`action-store`（写动作统一入口：requestId、同目标去重、智能操作 dirty 询问与贮藏重发、错误码映射）、`integrate-store`（合并/拉取/获取等表单默认值与记忆）、`conflict-store`（未解决/已解决、按具体分支名采用一侧；B1：内存中的已审查状态、块计数懒加载与缓存、`manualButton`/`reviewQueue`/`nextSelection`）、`merge-store`（合并窗口：打开/草稿恢复、块动作与撤销、保存草稿、应用、已解决文件重放）、`stash-store`、`pending-stash-store`（操作在 UI 外结束后检查待恢复贮藏）（贮藏列表/选择/门禁）；B2：`blame-store`（分页拼接、跨页段首、version 变化回到第一页）、`file-history-store`（翻页，选中条目按当时路径取 diff）、`compare-store`（交换、提交分页、按解析后的 sha 取范围 diff 并带旧路径）；`useSyncExternalStore` 订阅 | `src/shared/`、`src/client/graph/`、`src/client/merge/` |
| `src/client/graph/` | 提交图增量布局（lane/颜色/边，纯函数）与 `GraphCell` 渲染 | `src/shared/` |
| `src/client/changelists/` | B3c Changelist：纯模型（`changelist-model`：列表增删改、活动列表、移动、跟随当前改动、按仓库持久化）与 React 接线（`use-changelists`） | `src/client/` 内部 |
| `src/client/diff/` | B3b Diff 查看器增强的纯函数（`diff-views`：并排配对、词级范围、长段未改内容折叠、变更块锚点） | `src/shared/`、`src/client/merge/line-diff.ts` |
| `src/client/rebase/` | B3a 交互式变基列表的纯模型（`rebase-model`：行、动作/移动/改信息、squash 分组与默认信息、`toEntries`、校验、改写已推送判定、`previewTodo` 复用 `src/shared/rebase-todo.ts`） | `src/shared/`、`src/client/localized-text.ts` |
| `src/client/merge/` | B1 三栏合并的纯模型（无 React、无 CodeMirror）：`line-diff`（保留行尾的分行、Myers 行 diff）、`diff3`（三方分块、按词的简单冲突合并）、`merge-model`（不可变模型：块状态机、逐块/整文件动作、编辑映射、计数、草稿往返、`coarse` 粗分块标记）、`resolved-replay`（已解决文件：以 `mergeFile.worktreeText` 为 Result，草稿/自动合并/整文件采用与之相同时保留块状态，否则全部块标 edited） | `src/shared/` |
| `src/client/console/` | Git 控制台抽屉与 store（轮询 `console` 端点、客户端兜底脱敏） | `src/shared/`、`src/client/polling.ts` |
| `src/client/{i18n.tsx,localized-text.ts,locales.ts,locales/}` | 中英双语（A2 T7）：`GitBody` 把 slot 注入的 `t` 经 `I18nProvider` 下发，组件用 `useT()`；store 里只存 `LocalizedText`（键 + 参数），渲染时翻译；`locales/{core,common,shell,log,detail,document,commit,push,actions,branch,integrate,conflict,stash,merge}.ts` 按区域拆分，`en` 以 `satisfies` 强制键集一致；静态扫描测试禁止组件内出现中文字面量 | React |
| `src/client/ui/` | A1 基础组件：Button/Chip/StatusLetter/EmptyState（CSS Modules，ADR 0005） | React |
| `src/host/` | `/dsh-git` HTTP 路由（webServer prefix + `requestRejection` 鉴权，**不用** `connection.rpc.handle`）、RPC 处理器、sessionId → 仓库根解析、git 进程执行与解析、写能力门禁、缓存与刷新 | `src/shared/`；`node:*`；DSH 能力只从 `ctx` 取 |
| `src/host/http.ts` | 自注册 `/dsh-git/<endpoint>` 前缀路由、JSON 信封与错误映射；请求体按端点限额（合并写端点 32 MiB，其余 256 KiB，超限 413，见 [ADR 0009](decisions/0009-请求体按端点限额.md)）；原因见 references §13 | 同上 |
| `src/host/git/` | 读取器：`status`（含贮藏数/操作步骤/冲突类型）、`log`（Host 侧筛选与 v1/v2 游标）、`refs`、`branches`、`commit`、`diff`（结构化 hunk、截断规则）、`regex-worker`（用户正则在 `worker_threads` 中限时匹配）；A2 写操作：`commit-write`（只提交勾选、仅改信息 Amend、加入 VCS）、`rollback`（只删确认过的未跟踪文件）、`push`（推送预览、被拒分类、带期望 sha 的 force-with-lease）、`pull`，共用 `write-support`（路径经 stdin `--pathspec-from-file`，不支持该选项的 `clean`/`status` 每批 ≤200）；A3：`smart-stash`（`withSmartStash` 与待恢复贮藏标记，标记为 `refs/worktree/dsh-git/*` 受限 ref，见 [ADR 0008](decisions/0008-待恢复贮藏标记用受限-ref.md)）、`operation`（`operationState`/`operationControl`/`operationCommit`）、`branch-write`（签出/新建/重命名/删除）、`conflict`（逐文件解决、终端命令）、`integrate`（合并/变基/拣选/回滚提交/重置与预览）、`update`（获取/拉取/更新项目/重置到远程）、`stash`（贮藏读写，按 sha 定位）；B2 只读：`revision`（修订号先 `rev-parse --verify --end-of-options` 解析成 sha，拒绝以 `-` 开头）、`blame`（`--line-porcelain --root --no-textconv` 分页，未提交行、浅克隆边界、未跟踪/缺失空状态）、`file-history`（`log --follow --raw --numstat`，条目带当时路径）、`compare`（`right..left` 提交 + 合并基差异文件，无公共祖先退回两点）、`worktree-read`（只读工作区文件，lstat/realpath 守卫，`merge-file` 共用）；`diff` 增加 `range` scope（只扫描本文件与旧路径）；B3a：`rebase-plan`（交互式变基计划）、`interactive-rebase`（todo 经 stdin 交给 `GIT_SEQUENCE_EDITOR='cat >'`，信息存 blob 由 exec 写回）；`status`/`operation` 读出 `rebaseStop`；`commit-write` 在 edit 停下时放行；B3b：`tag-write`（新建标签）、`patch`（`format-patch` 导出、`am`/`apply --index` 应用）、`fixup`（`fixup!`/`squash!` 提交 + autosquash，复用 `rebaseOutcome`）；`diff` 增加 `-w` 与整文件上下文，`push` 增加 `revision`；B3c：`shelf`（搁架：`refs/worktree/dsh-git/shelf/<id>` 下的提交对象，见 [ADR 0011](decisions/0011-搁架存为受限ref下的提交对象.md)）；B3d：`remote-write`（远程列表脱敏、增改删重命名、删除远程分支、设置/取消 upstream）、`tag-write` 增加推送与删除（可同时删远程）、`worktree`（列表、新增、删除、清理；路径限定在仓库内） | `src/shared/`、`git-executor.ts` |
| `src/host/{git-executor,console}.ts` | `ctx.subprocess` 执行 git（固定环境、超时、输出上限；A3 起可选 stdin（`stdin: 'pipe'`，写完即关；seam 未给管道时终止子进程并失败），控制台只记 `stdinBytes`；B3a `todoFromStdin` 改用 `GIT_TODO_STDIN_ENV`）；A2 起分 read/write/network 三种模式（8/60/180s），写与网络命令必须带 `GitConfiner`（`sandbox.confine` 或 danger 模式下不 confine），否则拒绝且不 spawn；`instrumentGitRunner` 把每次调用写进控制台环形缓冲（脱敏/截断） | `src/shared/` |
| `src/host/{write-queue,sandbox-gate}.ts` | 每仓库写队列（串行、`requestId` 去重）；写门禁 `resolveWriteAccess` 每次写请求重新判定并给出 confiner，只读原因带稳定 `reasonCode` | `src/shared/`、`git-executor.ts` |
| `src/host/{watch,cache}.ts` | `.git` 关键目标经 `ctx.fs`（先 `resolve()` 再 `watch()`）防抖监听，另枚举 `refs/{heads,remotes,tags}` 的嵌套子目录逐个监听（≤256，超出降级），递增每仓库 version 使缓存失效；无 `fs` 时降级为 1s TTL + 客户端 3s 轮询 | `node:path`、`node:fs/promises`（只读枚举嵌套 refs 目录） |
| `src/shared/` | `rebase-todo.ts`（B3a：todo 校验与生成，Host 执行与客户端预览共用的纯函数）；RPC 方法与 payload 类型（`RpcEndpointTypes` 逐端点穷举；`WRITE_ENDPOINTS` 为写端点子集；A3 契约在 T1 冻结）、文件状态与 diff 数据结构、错误码 | 无（只放两端都能内联的类型与常量） |
| `build.mjs` | 产出 `lib/host.js` / `lib/client.js`，复刻 `window.__ModuleLoader__` 契约与 baseline externals | `package.json`；以 `src/` 为构建输入 |
| `scripts/check_docs.py` | 文档链接、计划/ADR 章节、技术债编号、AGENTS.md 行数检查 | 无（仅 Python 标准库） |

## 3. 分层规则

| # | 规则 | 原因 |
|---|---|---|
| R1 | `src/client/**` 不得 import `src/host/**` | 两者是独立产物，客户端里没有 Host 代码 |
| R2 | `src/host/**` 不得 import `src/client/**` | Host 不加载浏览器端代码 |
| R3 | `src/shared/**` 不得 import `src/host/**` 或 `src/client/**` | shared 是叶子层，两端都能安全内联 |
| R4 | `src/host/**` 不得**运行时** import `node_modules` 中的包（只允许 `import type`） | Host 运行时零依赖：能力全部从 `ctx` 取，避免 profile peer 解析问题 |
| R5 | `src/client/**` 与 `src/shared/**` 不得 import `node:*` 内置模块 | 产物运行在浏览器，Node 模块不存在 |

补充约定（由产物 smoke 覆盖，不在 dependency-cruiser 中）：

- Client 只能 import baseline externals 清单中的宿主包；其余依赖由 esbuild 内联。
- Host 只 `import 'node:*'` 与 `import type`；两条规则合起来就是「运行时零依赖」。
- `src/shared/` 不允许出现两端行为不一致的运行时逻辑；分叉逻辑放回 host/client。
