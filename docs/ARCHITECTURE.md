# ARCHITECTURE：模块地图与分层规则

本文件只描述**代码结构**和**依赖方向**，内容必须和代码保持一致（SOP §10）。产品与页面设计见 [产品设计 v0.2](design/2026-10-25-产品设计-v0.2.md)；技术方案见其中 §16 与 [DSH 集成可行性调研](references/dsh-integration-feasibility.md)。

> 状态：2026-10-26，A3 代码已合并、走查进行中——A1 只读（日志/提交图/详情/diff/分支/状态栏/控制台 + `.git` watch 刷新）、A2 提交闭环、A3 分支/贮藏/冲突（四个 Level 0 页、集成操作、操作控制、冲突列表、贮藏页）。
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
| `src/client/` | 右侧栏 Git tab、四个平级页（日志/提交/分支/贮藏）、单一覆盖层、UI store、`git-client.ts`（fetch RPC，覆盖全部 A3 端点）、`bootstrap-cache.ts`（每会话快照/去重/丢旧 version）、`use-bootstrap.ts`（快照与状态字母 hook）、`polling.ts`（可见时轮询）、`focus.ts`（覆盖层关闭后的焦点返回，纯函数）、`operations.ts`（共享的操作事实，如可跳过的操作集合 `SKIPPABLE`）、文档预览头部动作与 `git.blame` 页 | `src/shared/`；DSH baseline external（React、`@deepseek-ai/dsh-client-*`、`@tanstack/react-virtual`） |
| `src/client/pages/` | `GitWorkbench.tsx` 组装工作台并持有唯一的 `overlay` 状态；`workbench-overlay.ts`（覆盖层联合类型 + `useWorkbenchOverlay`：同一时刻一个覆盖层、Esc 退一级、焦点回到触发控件）；`PageTabs`（日志/提交/分支/贮藏，贮藏徽标）；日志：`LogPage`/`FilterBar`/`LogTable`/`LogRow`/`RefChips`/`CommitContextMenu`（提交右键菜单）；详情与 diff：`CommitDetail`/`ChangedFilesTree`/`DiffViewer`/`DiffHunks`/`DiffFileList`；提交页：`CommitPanel`/`ChangesTree`/`CommitMessage`（含合并/拣选/变基操作模式）；推送与回滚：`PushPage`/`PushRejectedPage`/`RollbackSheet`；分支：`BranchesPage`、`BranchPanel`+`branch-store`、`branch-actions`（动作项纯函数）、`BranchSheets`（新建/重命名/删除/签出修订号）、`SmartCheckoutSheet`；集成操作：`MergePage`（合并/变基共用）/`PullPage`/`UpdateProjectPage`/`ResetSheet`/`FetchSheet`/`CommitOpSheet`（拣选/回滚确认），配合 `integrate-actions`/`commit-actions`/`integrate-parts`/`use-loaded`；操作与冲突：`OperationBanner`、`ConflictsPage`、`operation-actions`；贮藏：`StashPage`/`StashCreateSheet`/`stash-actions`；`DirtyWorktreeSheet`（智能操作询问）、`ActionNotice`、`RepoBar`/`StatusBar` | 同 `src/client/`；页面只接收注入的 store/回调，不直接发 RPC（`GitWorkbench` 除外） |
| `src/client/store/` | React-free 的 `log-store`（分页/筛选/选择/键盘）、`detail-store`、`diff-store`；`changes-store`（分组/三态勾选）、`commit-store`（提交状态机、草稿/历史、`normal/merge/sequencer/rebase` 模式）、`push-store`（推送表单、被拒处理、回滚）；A3：`action-store`（写动作统一入口：requestId、同目标去重、智能操作 dirty 询问与贮藏重发、错误码映射）、`integrate-store`（合并/拉取/获取等表单默认值与记忆）、`conflict-store`（未解决/已解决、按具体分支名采用一侧）、`stash-store`（贮藏列表/选择/门禁）；`useSyncExternalStore` 订阅 | `src/shared/`、`src/client/graph/` |
| `src/client/graph/` | 提交图增量布局（lane/颜色/边，纯函数）与 `GraphCell` 渲染 | `src/shared/` |
| `src/client/console/` | Git 控制台抽屉与 store（轮询 `console` 端点、客户端兜底脱敏） | `src/shared/`、`src/client/polling.ts` |
| `src/client/{i18n.tsx,localized-text.ts,locales.ts,locales/}` | 中英双语（A2 T7）：`GitBody` 把 slot 注入的 `t` 经 `I18nProvider` 下发，组件用 `useT()`；store 里只存 `LocalizedText`（键 + 参数），渲染时翻译；`locales/{core,common,shell,log,detail,document,commit,push,actions,branch,integrate,conflict,stash}.ts` 按区域拆分，`en` 以 `satisfies` 强制键集一致；静态扫描测试禁止组件内出现中文字面量 | React |
| `src/client/ui/` | A1 基础组件：Button/Chip/StatusLetter/EmptyState（CSS Modules，ADR 0005） | React |
| `src/host/` | `/dsh-git` HTTP 路由（webServer prefix + `requestRejection` 鉴权，**不用** `connection.rpc.handle`）、RPC 处理器、sessionId → 仓库根解析、git 进程执行与解析、写能力门禁、缓存与刷新 | `src/shared/`；`node:*`；DSH 能力只从 `ctx` 取 |
| `src/host/http.ts` | 自注册 `/dsh-git/<endpoint>` 前缀路由、JSON 信封与错误映射；原因见 references §13 | 同上 |
| `src/host/git/` | 读取器：`status`（含贮藏数/操作步骤/冲突类型）、`log`（Host 侧筛选与 v1/v2 游标）、`refs`、`branches`、`commit`、`diff`（结构化 hunk、截断规则）、`regex-worker`（用户正则在 `worker_threads` 中限时匹配）；A2 写操作：`commit-write`（只提交勾选、仅改信息 Amend、加入 VCS）、`rollback`（只删确认过的未跟踪文件）、`push`（推送预览、被拒分类、带期望 sha 的 force-with-lease）、`pull`，共用 `write-support`（路径经 stdin `--pathspec-from-file`，不支持该选项的 `clean`/`status` 每批 ≤200）；A3：`smart-stash`（`withSmartStash` 与待恢复贮藏标记，标记为 `refs/worktree/dsh-git/*` 受限 ref，见 [ADR 0008](decisions/0008-待恢复贮藏标记用受限-ref.md)）、`operation`（`operationState`/`operationControl`/`operationCommit`）、`branch-write`（签出/新建/重命名/删除）、`conflict`（逐文件解决、终端命令）、`integrate`（合并/变基/拣选/回滚提交/重置与预览）、`update`（获取/拉取/更新项目/重置到远程）、`stash`（贮藏读写，按 sha 定位） | `src/shared/`、`git-executor.ts` |
| `src/host/{git-executor,console}.ts` | `ctx.subprocess` 执行 git（固定环境、超时、输出上限；A3 起可选 stdin（`stdin: 'pipe'`，写完即关；seam 未给管道时终止子进程并失败），控制台只记 `stdinBytes`）；A2 起分 read/write/network 三种模式（8/60/180s），写与网络命令必须带 `GitConfiner`（`sandbox.confine` 或 danger 模式下不 confine），否则拒绝且不 spawn；`instrumentGitRunner` 把每次调用写进控制台环形缓冲（脱敏/截断） | `src/shared/` |
| `src/host/{write-queue,sandbox-gate}.ts` | 每仓库写队列（串行、`requestId` 去重）；写门禁 `resolveWriteAccess` 每次写请求重新判定并给出 confiner，只读原因带稳定 `reasonCode` | `src/shared/`、`git-executor.ts` |
| `src/host/{watch,cache}.ts` | `.git` 关键目标经 `ctx.fs`（先 `resolve()` 再 `watch()`）防抖监听，另枚举 `refs/{heads,remotes,tags}` 的嵌套子目录逐个监听（≤256，超出降级），递增每仓库 version 使缓存失效；无 `fs` 时降级为 1s TTL + 客户端 3s 轮询 | `node:path`、`node:fs/promises`（只读枚举嵌套 refs 目录） |
| `src/shared/` | RPC 方法与 payload 类型（`RpcEndpointTypes` 逐端点穷举；`WRITE_ENDPOINTS` 为写端点子集；A3 契约在 T1 冻结）、文件状态与 diff 数据结构、错误码 | 无（只放两端都能内联的类型与常量） |
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
