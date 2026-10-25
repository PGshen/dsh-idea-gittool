# m0-集成-spike：M0 集成 spike

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图与验收，不写完整实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 已完成（2026-10-25 负责人验收通过；AC5 部分验证，遗留见 TD-4） |
| 里程碑 | M0：设计确认 + 集成 spike |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §16、§17 M0；[设计决策 v0.2](../../design/2026-10-25-产品设计决策-v0.2.md) §4；[DSH 集成可行性调研](../../references/dsh-integration-feasibility.md) |
| 分支 | `m0-spike`（2026-10-25 创建） |
| 执行方式 | Agent Teams 并行：Lead 负责 T1/T2/T7 与接线；队友 `host-git` 负责 T3/T4 与 T5 的 rpc 接线；队友 `refresh` 负责 T5 模块；队友 `client-docs` 负责 T6 组件 |
| 批准记录 | 2026-10-25 负责人在会话中批准计划与「Agent Teams 并行执行」方式 |
| 验收记录 | 2026-10-25 负责人回复「验收通过」 |

## 目标

用最小可运行骨架验证「独立双面 bundle 能否在 DSH 里挂载、读 git、按沙箱写」这条技术路线，并留下可复用的构建、RPC、刷新和验证记录。
M0 只做技术验证与骨架，不实现 A1 的完整日志页。

## 范围

**包含：**

- 包骨架：`package.json`、`tsconfig.json`、eslint、dependency-cruiser、`build.mjs`、`src/host`、`src/client`、`src/shared`、`cordis.patch.yml`。
- 开发期挂载：`dev.patch.yml` + `pnpm dsh web --patch`，引导页卡片与右侧栏 tab。
- 最小 RPC：`bootstrap`（status + 首屏 log）、`status`、`log`；sessionId → 仓库根 → cwd 解析。
- 写能力门禁：仓库根与沙箱 workspaceRoot 的关系判定；只读模式与禁用写按钮。
- 刷新：`.git` 关键文件 watch / `workspaceFiles.changes` / 可见时 3s 轮询、version 丢弃过期响应。
- 文档预览头部动作 + `git.blame` 空页（验证 slot / openTab API）。
- 产物 smoke（`__ModuleLoader__` 包装、externals 清单）与延迟、体积、升级风险记录。

**不包含：**

- A1 的完整日志 UI（提交图、筛选、详情、diff 渲染）。
- 提交/分支/贮藏等写操作闭环（只验证门禁，不实现业务写流程）。
- 打包发布、`npm publish`、`git push`、修改 DSH 仓库或 profile 安装（安装态复验放到 M0 末尾由负责人确认后执行）。

## 验收标准

- [ ] AC1：`pnpm build` 产出 `lib/host.js` 与 `lib/client.js`；产物 smoke 校验 `window.__ModuleLoader__.load({ id: "dsh-idea-gittool", ... })` 三行包装与 externals 清单；记录 client 产物 gzip 体积（验证方式：`pnpm build && node test/bundle.smoke.mjs`）
- [ ] AC2：从 DSH checkout 以 `--patch` 启动后，引导页出现「Git 工作台」卡片，右侧栏能打开 Git tab；无活动会话时显示 blocked 文案而不是报错（验证方式：浏览器操作 + `.evidence/m0/` 截图）
- [ ] AC3：`/dsh-git` 的 `bootstrap`/`status`/`log` 在真实仓库返回结构化数据；错误一律返回 `{ ok:false, error:{ code, message } }` 而非 HTTP 500 文本；记录 10k 提交仓库的首屏耗时（验证方式：vitest 集成测试 + 浏览器 Network 面板）
- [ ] AC4：写能力门禁三种场景（cwd 在仓库子目录 / 仓库根在 workspaceRoot 外 / `danger-full-access`）判定正确；仓库根在沙箱外时进入只读模式、写按钮禁用并有说明，`confine` 失败 fail closed（验证方式：临时仓库矩阵测试 + UI 截图）
- [ ] AC5：在终端修改仓库后，页面 ≤3s 内刷新；过期响应被 version 丢弃；重建 `lib/client.js` 触发热更无需刷新，Host 改动确认需要重启（验证方式：手动操作 + 计划验证记录）
- [ ] AC6：文档预览头部动作显示 `M/A/D/U` 与「Blame/历史/Diff」；点击打开 `git.blame` 空页；若当前 DSH 无该 slot，降级为 Git tab 入口并在 references 记录版本（验证方式：浏览器操作）
- [ ] AC7：`make check` 全绿（文档 + lint + 类型 + 分层 + 测试）；新增结论以 ✅/⚠️/❌ + 日期回写 `docs/references/`；TD-1/TD-2 状态更新（验证方式：`make check` 输出）

## 任务

<!-- 状态：待开始 / 进行中 / 完成 / 阻塞。每个任务结束 make check 必须为绿，并单独 commit。 -->

### T1：包骨架与工具链（完成）

- **目标**：建立可构建、可测试、可检查的包骨架，让 `make check` 开始真正跑代码检查。
- **涉及文件**：`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`eslint.config.mjs`、`build.mjs`、`cordis.patch.yml`、`src/host/index.ts`、`src/client/index.ts`、`src/shared/protocol.ts`、`test/bundle.smoke.mjs`、`.gitignore`、`Makefile` 注释。
- **接口与要点**：
  - `package.json`：`name: dsh-idea-gittool`、`type: module`、`main: lib/host.js`、`exports["."]`/`["./client"]`/`["./package.json"]`、`dsh.bundle.patch`、`dsh.client.platform: web`、`engines.dsh`、`packageManager`。
  - 脚本：`build`、`dev`（watch）、`lint`、`typecheck`、`layers`、`test`、`check`、`check:fast`；与 Makefile 的调用约定一致。
  - `build.mjs`：esbuild 两次构建，Host 保留 `node:*` 与 type-only 擦除，Client 注入三行包装并 external 化 baseline 模块。
- **测试**：先写 `test/bundle.smoke.mjs`（构建后校验包装、`id`、factory 收尾、`lib/host.js` 可 import 且导出 `apply`），再实现构建；`src/shared` 加一个协议常量的单测确认 vitest 可跑。
- **完成标准**：`pnpm install && pnpm build && make check` 全绿；`pnpm run layers` 对空/骨架 `src` 通过。
- **验证命令**：`make check`、`pnpm build`、`node test/bundle.smoke.mjs`。

### T2：开发期挂载与入口（完成）

- **目标**：不安装到 profile，用 `--patch` 把包挂进本地 DSH，确认 Client 半边被加载、引导页入口与 tab 可用。
- **涉及文件**：`dev.patch.yml`、`src/client/index.ts`、`docs/runbooks/dev-setup.md`、计划验证记录。
- **接口与要点**：`dev.patch.yml` 使用绝对路径行；`cordis.patch.yml` 只插 Host 行；Client 注册引导页卡片与 `sidebar.right` tab 类型，无会话时返回 blocked 文案。
- **测试**：客户端入口模块单测校验注册调用参数（可用最小 fake ctx）；挂载本身以手动 L4 走查为准。
- **完成标准**：引导页出现「Git 工作台」卡片；点击/命令面板能打开空 tab；Console 无未处理错误。
- **验证命令**：在 DSH checkout 运行 `pnpm dsh web --patch <本仓库>/dev.patch.yml`，浏览器验证并截图到 `.evidence/m0/`。

### T3：RPC 骨架与 status/log（完成）

- **目标**：打通 sessionId → 仓库根 → git 执行 → 结构化响应，并让 Client 能取到第一页数据。
- **涉及文件**：`src/shared/protocol.ts`、`src/host/rpc.ts`、`src/host/repo-resolver.ts`、`src/host/git-executor.ts`、`src/host/git/{status,log}.ts`、`src/client/git-client.ts`、`test/host/*`。
- **接口与要点**：
  - 方法：`bootstrap`、`status`、`log`；payload 只含 `sessionId` 与业务参数，不含 cwd。
  - 错误封装：处理器永不 throw，返回 `{ ok:true, value }` 或 `{ ok:false, error:{ code, message, details? } }`。
  - git 调用：argv 数组、`ctx.subprocess`、只读命令 `GIT_TERMINAL_PROMPT=0`、`LC_ALL=C`、`--no-pager`、`--no-ext-diff`、`GIT_LITERAL_PATHSPECS=1`；输出超限返回 `git/output-too-large`，绝不解析半截输出。
  - 路径：只接受 repo 相对 POSIX 路径，拒绝绝对路径、`..`、`-` 开头。
- **测试**：临时目录建真实仓库，覆盖 status 解析（分支/upstream/ahead-behind/冲突/未跟踪）、log 分页与过滤、无效 sessionId、非仓库目录、输出超限、取消。
- **完成标准**：真实仓库返回正确数据；错误全部结构化；记录首屏与单次 status 延迟基准。
- **验证命令**：`pnpm vitest run test/host`、`make check`、浏览器 Network 面板。

### T4：写能力门禁（完成）

- **目标**：在任何写操作前判定沙箱边界，保证「能看永远可用，能改只在边界内」。
- **涉及文件**：`src/host/sandbox-gate.ts`、`src/host/rpc.ts`、`src/client/read-only-banner.tsx`、`test/host/sandbox-gate.test.ts`。
- **接口与要点**：`evaluateWritePolicy({ repoRoot, sessionId })` 返回 `{ mode: 'read-write' | 'read-only', reason, workspaceRoot? }`；`repoRoot` 在 workspaceRoot 内或会话为 `danger-full-access` 才允许写；`sandboxPolicy` 不可用或 `confine` 失败时 fail closed（`git/sandbox-denied`）。
- **测试**：三种场景矩阵 + confine 抛错 + 无 sandboxPolicy 服务；断言不静默放宽。
- **完成标准**：只读模式下 UI 顶部横幅 + 写按钮禁用并说明原因；`status`/`log` 在只读模式仍可用；判定结果随 `bootstrap` 返回。
- **验证命令**：`pnpm vitest run test/host/sandbox-gate.test.ts`、`make check`、仓库根在 workspace 外的场景走查。

### T5：刷新与热更（完成）

- **目标**：确认 Agent 改文件、终端 git 操作、手动刷新、client 热更四条路径的可用性与延迟。
- **涉及文件**：`src/host/watch.ts`、`src/host/cache.ts`、`src/client/polling.ts`、`test/host/watch.test.ts`。
- **接口与要点**：watch `.git/HEAD`、`.git/index`、`.git/packed-refs`、`.git/refs/**` 与操作标记文件；250ms 防抖；每仓库 `version` 单调递增，缓存键带 version；面板可见时 3s 轮询，`visibilitychange` 暂停。
- **测试**：假时钟验证防抖与轮询暂停；version 过期响应被丢弃；watch 不可用时降级轮询。
- **完成标准**：终端提交后页面 ≤3s 刷新；重建 client 产物触发热更；Host 改动需重启，行为写进 runbook。
- **验证命令**：`pnpm vitest run test/host/watch.test.ts`、`make check`、手动四路径走查。

### T6：文档预览头部动作与 git.blame 空页（完成）

- **目标**：验证公开 slot 与 `openTab` 能否支撑 Blame 入口，决定 B2 的实现路径或降级路径。
- **涉及文件**：`src/client/document-actions.tsx`、`src/client/blame-page.tsx`、`src/client/index.ts`、`src/client/types.d.ts`（`SidebarRightTabParamsMap` 声明合并）。
- **接口与要点**：`ctx.slots.inject('sidebar.right.tab.document.actions', ...)`，owner 为 `{ absolutePath }`；点击调用 `ctx.sidebarRight.openTab('git.blame', { params })`；不修改 `ui-sidebar-documentpreview` / `ui-sidebar-files` 内部。
- **测试**：动作组件对 `absolutePath` 的映射与空状态渲染单测；slot 注册参数以最小 fake ctx 断言。
- **完成标准**：文档预览头部出现状态字母与三个动作；点击打开空 Blame 页；slot 缺失时有降级入口且 references 记录 DSH 版本。
- **验证命令**：`make check`、浏览器打开任意文件走查、截图到 `.evidence/m0/`。

### T7：记录、回写与收尾（完成）

- **目标**：把 spike 结论变成仓库里的知识，收尾 M0。
- **涉及文件**：`docs/references/{README,dsh-integration-feasibility}.md`、`docs/quality/{tech-debt,QUALITY}.md`、`docs/ARCHITECTURE.md`、`docs/runbooks/*`、本计划的「验证记录」。
- **要点**：逐条给调研结论标 ✅/⚠️/❌ 并写日期；更新 TD-1/TD-2；记录实测延迟、体积、DSH 版本与升级注意；如影响交付形态或工具链，补 ADR。
- **完成标准**：AC1–AC7 每条都有证据；`make check` 全绿；计划状态改为「待验收」并提交负责人验收。
- **验证命令**：`make check`、逐条对照「验证记录」。

## 并行分工

| 执行者 | 任务 | 独占写作用域（其他执行者不碰） |
|---|---|---|
| Lead | T1（已完成）、T2、T6 接线、T7 | `src/client/index.ts`、`dev.patch.yml`、`docs/`、`src/shared/protocol.ts` 的对外约定 |
| `host-git` | T3、T4、T5 的 rpc 接线 | `src/host/{rpc,repo-resolver,git-executor,sandbox-gate}.ts`、`src/host/git/**`、`test/host/**` |
| `refresh` | T5 模块与测试 | `src/host/{watch,cache}.ts`、`src/client/polling.ts`、`test/host/watch.test.ts`、`test/client/polling.test.ts` |
| `client-docs` | T6 组件与注册模块 | `src/client/{document-actions.tsx,blame-page.tsx,register-document-actions.ts,types.d.ts}`、`test/client/**`（文案先用中文字面量，不编辑 `locales.ts`） |

约定：`src/shared/protocol.ts` 的接口变更先由 Lead 合入再通知其他执行者；T5 的接线由 `host-git` 在 T4 完成后进行，`refresh` 不编辑 `rpc.ts`。依赖安装（`pnpm add` / `pnpm install`）只由 Lead 执行，其他执行者不写 `package.json` 与 `pnpm-lock.yaml`。

## 进度

<!-- 每完成一步追加一行：日期 — 任务 — 结果（commit 短哈希） -->

- 2026-10-25 — T1 包骨架与工具链 — `pnpm install && pnpm build && node test/bundle.smoke.mjs && make check` 全绿；client 产物 1263 B（gzip 609 B）；DSH 类型经 `link:` 接入并通过 tsc 探针（见决策记录）
- 2026-10-25 — T2 开发期挂载与入口 — 用 `pnpm dsh web --patch dev.patch.yml --no-open --port 3081` 启动成功；引导页出现「Git 工作台」卡片（order 40、快捷键 ⇧⌘G），`Mod+Shift+G` 打开右侧栏 Git tab；无会话时快捷键返回 blocked 文案（代码路径已接）；控制台无错误；证据 `.evidence/m0/t2-hero.png`、`t2-guide-card.png`、`t2-git-tab.png`
- 2026-10-25 — T5a 模块（refresh 队友） — `src/host/{watch,cache}.ts`、`src/client/polling.ts` 与 31 个假时钟测试通过；导出契约已交给 host-git 接线
- 2026-10-25 — T3 RPC/status/log — 真实临时仓库 + 10k 提交基准（status 中位 101.7ms、log 首页 104.9ms、bootstrap 259.3ms）；结构化错误码全覆盖；commit `0606216`
- 2026-10-25 — T4 写门禁 — fail closed 矩阵 18 测试（子目录/仓库根在 workspace 外/danger-full-access/confine 失败/符号链接）；commit `94436fa`
- 2026-10-25 — T5b 缓存与监听接线 — 每仓库 version 缓存 + 6 个 .git watch + 竞态回写拒绝；commit `e41f949`（含路由修复）
- 2026-10-25 — T6 文档动作与 Blame 空页 — 35 个组件单测；实机 `package.json` 预览头部渲染 `· Blame 历史 Diff`；commit `d9a04dc`
- 2026-10-25 — 客户端数据层与路由修复 — 同源 fetch RPC + bootstrap 快照 + GitBody 数据 + 文档状态字母；`/dsh-git` 改 webServer 路由后 RPC 实机打通（真实会话返回 branch/17 改动/7 提交，read-only）；commit `3fe406c`
- 2026-10-25 — T7 记录与收尾 — references §13 回写 11 条实测结论；ARCHITECTURE/QUALITY/tech-debt（新增 TD-3 样式管线、TD-4 watch 降级）更新；`make check` 绿（14 files / 163 tests）；计划转待验收

## 下一步

1. 负责人已在 2026-10-25 验收通过；本计划归档到 `plans/completed/`，路由方案变更见 [ADR 0004](../../decisions/0004-通用RPC改用webServer前缀路由.md)。
2. 后续工作：按 [设计决策 v0.2](../../design/2026-10-25-产品设计决策-v0.2.md) §4 拆分 A1 计划（提交图 + 日志页 + diff 渲染）；A1 计划里带上 TD-3（样式管线）与 TD-4（watch 降级）的取舍。
3. AC5 剩余的手动走查（HMR、终端改动刷新）并入 A1 的首个任务，用真实界面补证据。
4. 安装态复验（`dsh plugin --profile web add`）仍需负责人确认后执行，不在本轮。

## 决策记录

- 2026-10-25 — 包根即包本体，不建 `packages/plugin` 子目录 — 与 [ARCHITECTURE.md](../../ARCHITECTURE.md) 顶层结构一致；`dsh plugin add <仓库根>` 直接可用，减少一层路径。
- 2026-10-25 — DSH 类型依赖用 `link:/Users/peng/Me/Ai/deepseek-harness/...` 接入 devDependencies — 可行性调研 §5.2 的推荐做法，保证类型与运行中 checkout 同源；锁文件记录相对 link 路径，换机器需重装。
- 2026-10-25 — TypeScript 固定 6.x（当前 6.0.3）— typescript-eslint 8.72 拒绝 TS 7.0（`typescript-eslint does not support TS 7.0`）；等其支持后升级。
- 2026-10-25 — 产物包装的 intro 内容并入 banner — esbuild 0.28 移除了 `intro` 选项（`Invalid option in build() call: "intro"`）；包装语义不变，smoke 覆盖。

## 意外与发现

- 2026-10-25 — **`ctx.connection.rpc.handle` 在 DSH 0.2.1-rc.2 从外部插件不可用**：`HostConnectionService.register()` 用服务自身的 ctx（app root fiber）执行 `owner.webServer.register(...)`，而 app root fiber 没有 `webServer` inject，必抛 `cannot get property "webServer" without inject`；该版本源码里也没有生产代码使用它。已在 `src/host/http.ts` 改为文档 §6.4 的备选路径：`ctx.inject(['webServer'])` + `webServer.register({kind:'prefix'})` + `connection.requestRejection(req)` 鉴权 + 自定义 JSON 信封（与 `ui-open-in-app` 先例一致）。**建议写成 ADR 0004。**
- 2026-10-25 — Loader 行的模块级 `inject` 导出能生效（connection/subprocess 正常），但 `rpc.handle` 的 owner 是 app root，不是调用方 fiber；因此不能靠给插件加 `webServer` inject 解决。
- 2026-10-25 — 未知 sessionId 曾退化到 `sandboxPolicy.workspaceRoot`（实际是 dsh web 进程 cwd，恰好是 DSH checkout），导致把宿主仓库当会话仓库返回；已改为「持久化服务存在但无该会话记录 → no-session」。部署级兜底只在持久化服务缺失时使用。
- 2026-10-25 — web profile 组合里没有 `fs`/`fs-local` 插件条目（bundle patch 与 dump-config 都没有），因此可行性调研 §9.1 的 `ctx.fs.watch` 在 web 下实际不可用；Host watch 静默降级、version 恒 0。已给兜底缓存加 1s TTL，登记 TD-4。
- 2026-10-25 — TS 7.0.2 是当前 latest，但 typescript-eslint 尚不支持；`pnpm add -D typescript` 会装到 7.0.2，必须显式 `typescript@^6`。DSH 版本升级不影响此约束；升级 typescript-eslint 后重新评估。
- 2026-10-25 — esbuild 0.28 移除 `intro`；可行性调研 §5.4 的示例代码需在 T7 回写补充 banner 写法。
- 2026-10-25 — `pnpm install` 报告 esbuild 的 build script 被忽略（`ERR_PNPM_IGNORED_BUILDS`），但 esbuild 0.28 走平台二进制包，构建与 smoke 正常；不需要 `pnpm approve-builds`。

## 阻塞

- 无（触发 SOP §6 时填写：问题、已尝试办法、可选方案与推荐）

## 验证记录

- AC1 产物契约：`pnpm build && node test/bundle.smoke.mjs` 通过（`__ModuleLoader__` 三行包装、id、factory 返回 apply/inject、externals 只含基线模块）；client gzip ≈ 2.1 KB（M0 骨架）。证据：`test/bundle.smoke.mjs` 输出「bundle smoke 通过」。
- AC2 挂载与入口：`pnpm dsh web --patch /Users/peng/Me/Ai/dsh-idea-gittool/dev.patch.yml --no-open --port 3081` 启动无激活警告；引导页出现「Git 工作台」卡片（描述「提交图、历史与工作区改动」、快捷键 ⇧⌘G）；`Mod+Shift+G` 打开右侧栏 Git tab；无会话时命令返回 blocked 文案。证据：`.evidence/m0/t2-guide-card.png`、`t2-git-tab.png`、`t2-hero.png`。
- AC3 RPC：`POST /dsh-git/bootstrap` 带 Cookie 返回结构化数据（真实会话：`repoRoot=/Users/peng/Me/Ai/dsh-idea-gittool`、`branch=m0-spike`、unstaged 17、untracked 6、commits 7、`writePolicy.mode=read-only`）；无 Cookie → 401；未知端点 → 404；未知 sessionId → `git/no-session`；handler 永不 throw。延迟：10k 提交仓库 status 中位 101.7ms、log 首页 104.9ms、bootstrap 259.3ms（T3 记录）。
- AC4 写门禁：`test/host/sandbox-gate.test.ts` 18 个用例（子目录 cwd、仓库根在 workspaceRoot 外、danger-full-access、confine 抛错/partial、无 sandboxPolicy、无 live 会话、符号链接与前缀陷阱）；只读模式 status/log 仍可用；bootstrap 返回 `writePolicy`；GitBody 顶部渲染只读横幅并禁用写按钮（M0 尚无写按钮，横幅已实机可见）。
- AC5 刷新与热更：⚠️ 部分验证。poller 假时钟覆盖可见性暂停/串行/过期丢弃；Host 侧 watch 250ms 防抖与 version+1 有单测；Host 改动需重启已实测（重启 3081 后路由生效）。
  实测发现：**当前 web 组合没有挂载 `fs` 服务**（`pnpm dsh --profile web --dump-config` 与 bundle patch 均无 fs 条目），所以 `ctx.get('fs')` 为 undefined、watch 降级、`version` 恒为 0；`touch .git/index` 后 bootstrap 的 version 仍为 0 验证了这一点。兜底方案：Host 缓存给 1s TTL（3s 轮询仍拿到新数据，突发请求可复用），并把“换用 workspaceFiles.changes / 补 Host watch”登记为 TD-4。重建 `lib/client.js` 的 HMR 仍未手动走查。
- AC6 文档动作：`package.json` 预览头部实机渲染状态徽标 + `Blame 历史 Diff`（历史/Diff disabled 并注明 B2）；slot `sidebar.right.tab.document.actions` 与 owner `absolutePath` 按 DSH 0.2.1-rc.2 契约接线；Blame 点击打开 `git.blame` 空页（type + body slot 注册，单测覆盖）。证据：`.evidence/m0/t6-document-actions.png`。
- AC7 质量关口：`make check` 全绿（lint + tsc + dependency-cruiser + vitest + 文档检查；最近一次 14 files / 163 tests 为提交前基线，收尾以最终输出为准）；本文件与 [references](../../references/dsh-integration-feasibility.md) 已回写实测结论。
