# ARCHITECTURE：模块地图与分层规则

本文件只描述**代码结构**和**依赖方向**，内容必须和代码保持一致（SOP §10）。产品与页面设计见 [产品设计 v0.2](design/2026-10-25-产品设计-v0.2.md)；技术方案见其中 §16 与 [DSH 集成可行性调研](references/dsh-integration-feasibility.md)。

> 状态：2026-10-25，A1 核心只读已落地（日志/提交图/详情/diff/分支/状态栏/控制台 + `.git` watch 刷新）；HMR 与终端刷新已实机走查。
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
| `src/client/` | 右侧栏 Git tab、四个平级页、覆盖页栈、UI store、`git-client.ts`（fetch RPC）、`bootstrap-cache.ts`（每会话快照/去重/丢旧 version）、`use-bootstrap.ts`（快照与状态字母 hook）、`polling.ts`（可见时轮询）、文档预览头部动作与 `git.blame` 页 | `src/shared/`；DSH baseline external（React、`@deepseek-ai/dsh-client-*`、`@tanstack/react-virtual`） |
| `src/client/pages/` | `GitWorkbench.tsx` 组装工作台；`LogPage`/`FilterBar`/`LogTable`/`LogRow`/`RefChips`（日志）、`CommitDetail`/`ChangedFilesTree`（详情）、`DiffViewer`/`DiffHunks`/`DiffFileList`（统一 diff 覆盖层）、`BranchPanel`+`branch-store`、`RepoBar`/`StatusBar`/`OperationBanner` | 同 `src/client/`；页面只接收注入的 store/回调，不直接发 RPC（`GitWorkbench` 除外） |
| `src/client/store/` | React-free 的 `log-store`（分页/筛选/选择/键盘）、`detail-store`、`diff-store`；`useSyncExternalStore` 订阅 | `src/shared/`、`src/client/graph/` |
| `src/client/graph/` | 提交图增量布局（lane/颜色/边，纯函数）与 `GraphCell` 渲染 | `src/shared/` |
| `src/client/console/` | Git 控制台抽屉与 store（轮询 `console` 端点、客户端兜底脱敏） | `src/shared/`、`src/client/polling.ts` |
| `src/client/ui/` | A1 基础组件：Button/Chip/StatusLetter/EmptyState（CSS Modules，ADR 0005） | React |
| `src/host/` | `/dsh-git` HTTP 路由（webServer prefix + `requestRejection` 鉴权，**不用** `connection.rpc.handle`）、RPC 处理器、sessionId → 仓库根解析、git 进程执行与解析、写能力门禁、缓存与刷新 | `src/shared/`；`node:*`；DSH 能力只从 `ctx` 取 |
| `src/host/http.ts` | 自注册 `/dsh-git/<endpoint>` 前缀路由、JSON 信封与错误映射；原因见 references §13 | 同上 |
| `src/host/git/` | 每个端点一个读取器：`status`（含贮藏数/操作状态）、`log`（Host 侧筛选与 v1/v2 游标）、`refs`、`branches`、`commit`、`diff`（结构化 hunk、截断规则） | `src/shared/`、`git-executor.ts` |
| `src/host/{git-executor,console}.ts` | `ctx.subprocess` 执行 git（固定环境、超时、输出上限）；`instrumentGitRunner` 把每次调用写进控制台环形缓冲（脱敏/截断） | `src/shared/` |
| `src/host/{watch,cache}.ts` | `.git` 关键目标经 `ctx.fs`（先 `resolve()` 再 `watch()`）防抖监听，递增每仓库 version 使缓存失效；无 `fs` 时降级为 1s TTL + 客户端 3s 轮询 | `node:path` |
| `src/shared/` | RPC 方法与 payload 类型、文件状态与 diff 数据结构、错误码 | 无（只放两端都能内联的类型与常量） |
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
