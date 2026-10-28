# b4c-性能：性能预算复测、包体积达标与质量关口提速

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、契约与验收，不写完整实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 执行中 |
| 里程碑 | B4 打磨（第 3 份，共 4 份：B4a 设置页 + Blame 渲染器、B4b a11y 与样式变量、**B4c 性能**、B4d 跨平台/安装升级/文档；拆分 2026-10-28 负责人同意） |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §16.8（性能预算）、§16.10（CodeMirror 按需 chunk）；[设计决策 v0.2](../../design/2026-10-25-产品设计决策-v0.2.md) §4（B4 打磨）、§5 S5（真实仓库矩阵）；[verification runbook](../../runbooks/verification.md) L5；[tech-debt](../../quality/tech-debt.md) TD-16；[TODO](../TODO.md)「layout 2000 行 50ms 偶发超时」 |
| 分支 | `b4c-perf`（从 main 切出） |
| 批准记录 | 2026-10-28 负责人批准计划，待确认 1–4 按推荐；执行方式：当前会话内联执行，最后做一次整分支评审 |

## 目标

B1–B4b 加了大量功能之后，重新证明设计 §16.8 的性能预算在 10k 提交仓库上仍然成立，并把唯一超标的「包体积」压回预算内；同时把 `make check` 的全量时长降下来、消除计时类假失败，让后续每个任务的反馈周期变短（负责人 2026-10-28 要求）。

## 现状（2026-10-28 盘点）

- **包体积**：`lib/client.js` 1,285,022 字节，gzip **309,080 字节（约 302 KB）**，超出预算「≤ 250 KB gzip（不含按需加载的 CodeMirror）；首发目标 ≤ 200 KB」。原因：B1 起 CodeMirror 内联进主包（不压缩约 595 KB / gzip 148 KB）；`build.mjs` 只开了 `minifyWhitespace`/`minifySyntax`，**没有压缩标识符**，因为 esbuild 的 `minifyIdentifiers` 会把 local-css 类名缩短成可能与宿主冲突的短名（ADR 0005 依赖 `File_name` 前缀）。`lib/host.js` 280,523 字节（Node 侧，不计入预算）。
- **Host 延迟**：只在 A1（2026-10-25）测过一次，10k 仓库 log 首页 46ms、commit 30ms、diff 39ms、branches 28ms；脚本在当时的会话 scratchpad，**未入库**。B 阶段新增的 status 字段（操作状态、贮藏数、changelist）、blame、文件历史、比较、变基计划都没有测过。
- **客户端渲染**：A1 用独立 harness（`.evidence/a1/harness/`，未入库）测过 2000 行日志每步滚动渲染中位 0.6ms；之后加了紧凑模式、相对日期、分支徽标等，没有复测。
- **轮询**：`src/client/polling.ts` 已串行（进行中只标 dirty），满足「不并发堆积」；单次 bootstrap 耗时未测。
- **内存**：「面板常驻 ≤ 80MB」从未测过。
- **质量关口**：B1 时全量 `make check` 约 4 分 50 秒–5 分 27 秒（94 个测试文件、1780 个测试），B4b 后更多；`vitest` 无配置文件，全部默认（默认 pool、默认并发）。已知计时类假失败两处：TD-16（`watch.test.ts` 嵌套 refs 超时）与 TODO（`layout.test.ts` 2000 行 < 50ms 在全量下实测 58ms）。

## 范围

**包含：**

- **可复现的性能基准**（L5，不进 `make check`）：入库一个脚本，在临时目录用 `git fast-import` 生成 10k 提交仓库（含合并、分支、标签、一个 4500 行文件、一个大 diff），直接调用 Host 处理器测 §16.8 的各项与 B 阶段新端点，输出中位数/p95 表；`pnpm bench` 运行。
- **包体积达标**：先做方案 A（构建后对 JS 单独做标识符压缩，CSS 类名不受影响），量体积；不达标再按待确认 1 做方案 B（CodeMirror 拆成按需加载的第二个产物，需要先 spike DSH 是否能服务额外产物）。`pnpm smoke` 增加体积门槛断言，防止回退。
- **超标项修复**：基准里任何一项超出 §16.8 预算，在本计划内定位并修；修不了的写进「意外与发现」并请负责人裁定。
- **客户端渲染复测**：把 A1 的 2000 行日志滚动 harness 整理入库（`scripts/bench-client/`），复测逐步渲染开销与行 DOM 数；L4 在 DSH 里测面板常驻内存（`performance.memory` / 堆快照）与打开 Git tab 首屏时间。
- **`make check` 提速**：先测出每个测试文件耗时，再按测量结果做（候选：vitest pool/并发配置、Host 集成测试用预建模板仓库代替逐条 `git commit`、合并重复的仓库建立、长路径/2MB 类用例缩规模）；目标见待确认 2。
- **计时类假失败**：TD-16 改为轮询等待 version、不靠固定超时；`layout.test.ts` 的绝对毫秒阈值改为相对基准或放宽到能在全量负载下稳定通过（待确认 3）。

**不包含：**

- TD-7（>4 MiB patch 流式读取前缀）：不在预算指标里（预算要求的是「截断不阻塞」，现状满足），留在 tech-debt。
- 真实 fps 录制：A1 已说明隐藏/后台面板无 rAF，本计划沿用「每步渲染开销 ≤ 18ms 帧预算」的判定方式。
- 跨平台、git 路径、安装升级、文档（B4d）。
- 引入新的运行时依赖；方案 A/B 都只用已有的 esbuild。

## 待负责人确认

1. **包体积方案**：推荐**先 A 后 B**。A：`build.mjs` 在合成 CSS 之后，对 JS 文本再跑一次 esbuild `transform`（`minifyIdentifiers: true`），类名早已定型、不受影响；预计 gzip 下降 20–30%，有望到 ≤ 250 KB，零新依赖、零运行时风险（需验证 `__ModuleLoader__` 包装三行与 smoke 仍成立）。B：CodeMirror + 合并窗口拆成 `lib/merge-window.js`，首次打开合并窗口时加载——设计 §16.10 本来就这么写，但**宿主是否通过 HTTP 暴露 `lib/` 下除 `client.js` 外的文件未验证**（references §「静态资源」一节只说「client-modules 服务 client.js 与 chunk/map」），需要先 spike；不可行时退回 A 的结果并请负责人裁定预算。备选：只做 A，接受 ≤ 250 KB 但不追 200 KB 首发目标。
2. **`make check` 时长目标**：推荐「全量 ≤ 当前测量值的 50%，且绝对值 ≤ 150 秒（负责人这台 Mac）」，先测基线再定死；达不到时把剩余大头列出来请负责人决定是否拆出 `make check-slow`（拆出会削弱关口，红线要求负责人批准）。备选：只要求 ≤ 当前的 70%。
3. **计时类测试**：推荐把「2000 行布局 < 50ms」改为「< 200ms 且记录耗时」（守住数量级回退，不再被负载干扰），真正的预算由 `pnpm bench` 验证；TD-16 改轮询等待。备选：把计时用例移出 `make check`、只在 bench 里跑。
4. **基准仓库**：推荐只用脚本生成的合成仓库（可复现、不含真实数据）；如负责人希望再测一个真实大仓库（例如本机某个开源项目副本），请指定路径，结果只写进计划、不入库。

## 验收标准

- [ ] AC1：`pnpm bench` 在 10k 合成仓库上输出下列指标（7 次中位数与 p95），全部达标：log 首页 ≤ 500ms、commit 详情 ≤ 200ms、单文件 diff ≤ 300ms、bootstrap（状态轮询一次）≤ 50ms、branches ≤ 100ms；另记录（不设门槛、超 500ms 需说明）：blame 4500 行文件、文件历史首页、分支比较、变基计划 50 条、贮藏列表、搜索扫完 10k。结果表写进「验证记录」并与 A1 数据对比。
- [ ] AC2：大文件 diff（> 256 KiB）返回 `truncated` 且耗时 ≤ 300ms；单响应不超过 4 MiB（bench 断言）。
- [ ] AC3：`lib/client.js` gzip ≤ 250 KB（若选 B：主包不含 CodeMirror 时 ≤ 250 KB，合并窗口产物另记）；`pnpm smoke` 断言该门槛并通过；`__ModuleLoader__` 包装与 CSS 注入、HMR 重跑替换 `<style>` 的既有 smoke 全部仍通过；L4 在 DSH 里打开日志、提交页、合并窗口、Blame 正常，控制台无错误。
- [ ] AC4：2000 行日志逐步滚动：每步渲染中位 ≤ 2ms、最大 ≤ 18ms，行 DOM 数 ≤ 60（harness 入库，含紧凑模式一轮）。
- [ ] AC5：L4（隔离 DSH）：打开 Git tab 到第一页日志可见 ≤ 500ms（已有缓存时首屏 ≤ 150ms）；日志滚到 2000 行、打开并关闭 5 次大 diff 后，面板 JS 堆 ≤ 80 MB 且关闭 diff 后回落（记录数值与方法）。
- [ ] AC6：`make check` 全量时长达到待确认 2 的目标（记录优化前后各 3 次的时长与机器负载）；测试数量不减少（记录前后测试文件数与用例数），无新增 skip/xfail。
- [ ] AC7：连续 3 次全量 `make check` 无计时类假失败；TD-16 移入「已处理」，TODO「layout 偶发超时」移入已完成。
- [ ] AC8：`docs/runbooks/verification.md` 的 L5 一节写明 `pnpm bench` 与客户端 harness 的用法、预算对照表；AGENTS.md「常用命令」加 `pnpm bench`。

## 契约（T1 冻结）

```ts
// scripts/bench/fixture.mjs —— 生成合成仓库，返回路径；同一参数生成的历史逐字节一致
export function createBenchRepo(dir: string, options?: { commits?: number /* 10_000 */ }): Promise<{ root: string; bigFile: string; hugeDiffSha: string; mergeSha: string }>

// scripts/bench/host.mjs —— 直接调 lib/host.js 导出的处理器（或 src 经 esbuild 打包），不起 DSH
// 输出：Markdown 表 + JSON（.evidence/b4c/bench-<日期>.json）；任一门槛项超标时退出码 1
```

## 任务

<!-- 状态：待开始 / 进行中 / 完成 / 阻塞 -->

### T1：基线测量与性能基准脚本（待开始）

- **目标**：入库可复现的 Host 基准；同时测出 `make check` 基线与逐文件耗时，作为 T4/T5 的依据。
- **涉及文件**：`scripts/bench/fixture.mjs`、`scripts/bench/host.mjs`、`package.json`（`bench` 脚本）、`test/scripts/bench-fixture.test.ts`（只用 200 提交验证生成器确定性与形状）、`docs/runbooks/verification.md`。
- **接口与要点**：fast-import 生成（A1 用过，10k 提交秒级）；处理器调用方式沿用 `test/host/fixtures.ts` 的真实执行器构造，不经 HTTP；每项预热 1 次 + 7 次计时；生成的仓库放系统临时目录，结束删除。基线：`time make check` ×3、`vitest run --reporter=json` 取每文件耗时 Top 20，写进「验证记录」。
- **测试**：生成器确定性（同参数两次 `rev-parse HEAD` 相同）、包含合并/标签/大文件。
- **完成标准**：`pnpm bench` 输出 AC1/AC2 表；基线数据入计划。
- **验证命令**：`pnpm vitest run test/scripts/bench-fixture.test.ts`、`pnpm bench`、`make check`

### T2：超标项修复（视 T1 结果，可能为空）（待开始）

- **目标**：AC1/AC2 中超预算的项定位并修复。
- **涉及文件**：视结果而定（候选：`src/host/git/status.ts` 的多次 git 调用合并或缓存、`src/host/cache.ts` 键带 version）。
- **测试**：每个修复先写行为不变的回归测试；性能本身由 `pnpm bench` 证明（不在 `make check` 里加绝对毫秒断言）。
- **完成标准**：`pnpm bench` 全部达标；T1 无超标时本任务标「完成（无需修改）」并写明。
- **验证命令**：`pnpm bench`、`make check`

### T3：包体积达标（待开始）

- **目标**：AC3。先 A（标识符压缩后处理），量体积；不达标且负责人选了 B 时，先做 DSH 额外产物服务的 spike（只读宿主源码 + 隔离 DSH 实测，结论写进 references），可行再拆合并窗口产物。
- **涉及文件**：`build.mjs`、`test/bundle.smoke.mjs`；B 另涉及 `src/client/pages/MergeWindow*.tsx` 的加载入口、`package.json` `files`。
- **接口与要点**：A 在 `emitClientBundle` 合成之后、写文件之前做 `transform(text, { minifyIdentifiers: true, format: undefined })`，保持 banner/footer 三行原样（smoke 已校验首行契约）；`CLIENT_GZIP_MAX = 250 * 1024` 常量放 smoke。B 的加载器必须走宿主公开机制，不自己 `eval` 拉来的文本。
- **测试**：smoke 先加体积断言（RED：当前 309 KB），再实现到 GREEN；包装/CSS/HMR 既有断言不改。
- **完成标准**：AC3 前半；L4 在 T6 一并做。
- **验证命令**：`pnpm build && pnpm smoke`、`make check`

### T4：`make check` 提速（待开始）

- **目标**：AC6。按 T1 的逐文件耗时从大头开始优化。
- **涉及文件**：新增 `vitest.config.ts`（如需 pool/并发/`isolate` 配置）、`test/host/fixtures.ts`（模板仓库：一次建好后 `cp -R`/`git clone --local` 复用）、耗时 Top 文件。
- **接口与要点**：不删测试、不降低断言；任何把测试移出 `make check` 的改动必须先经负责人批准（红线）。每做一项记录前后时长到「决策记录」。
- **测试**：重构前后同一组测试全绿、用例数不变（`--reporter=json` 的计数对比）。
- **完成标准**：达到待确认 2 的目标或列出剩余大头请负责人裁定。
- **验证命令**：`time make check`（×3）

### T5：计时类假失败（待开始）

- **目标**：AC7。TD-16 改轮询等待；`layout.test.ts` 阈值按待确认 3。
- **涉及文件**：`test/host/watch.test.ts`、`test/client/graph/layout.test.ts`、`docs/quality/tech-debt.md`、`docs/plans/TODO.md`。
- **测试**：在人为加负载（并行跑两份 `make check`）下各跑 3 次不失败。
- **完成标准**：AC7。
- **验证命令**：`make check` ×3

### T6：客户端渲染与内存复测（L4）（待开始）

- **目标**：AC4、AC5、AC3 的 L4 部分。
- **涉及文件**：`scripts/bench-client/`（A1 harness 整理入库：真实 `LogPage` + 合成 2000 行）、`docs/runbooks/verification.md`。
- **接口与要点**：harness 只用已有依赖；内存在隔离 DSH（临时 HOME、3081/3082，不碰负责人 profile 与 3080）里测；后台面板无 rAF，判定方式同 A1。
- **完成标准**：AC4/AC5 数值写进「验证记录」，截图 `.evidence/b4c/`。
- **验证命令**：harness 脚本、L4 走查

### T7：自验证、整分支评审与收尾文档（待开始）

- **目标**：AC8；逐条 AC 附证据；独立评审者做整分支评审并处理发现；更新 QUALITY（`build.mjs` 体积、各模块性能已验证）、tech-debt、TODO、AGENTS.md 命令表。
- **验证命令**：`make check`、`pnpm build && pnpm smoke`、`pnpm bench`

## 进度

- 无

## 下一步

- 从 T1 开始（worktree `.claude/worktrees/b4c-perf`，分支 `b4c-perf`）。

## 决策记录

- 无

## 意外与发现

- 无

## 阻塞

- 无

## 验证记录

- 无
