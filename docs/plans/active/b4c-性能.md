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

### T1：基线测量与性能基准脚本（完成）

- **目标**：入库可复现的 Host 基准；同时测出 `make check` 基线与逐文件耗时，作为 T4/T5 的依据。
- **涉及文件**：`scripts/bench/fixture.mjs`、`scripts/bench/host.mjs`、`package.json`（`bench` 脚本）、`test/scripts/bench-fixture.test.ts`（只用 200 提交验证生成器确定性与形状）、`docs/runbooks/verification.md`。
- **接口与要点**：fast-import 生成（A1 用过，10k 提交秒级）；处理器调用方式沿用 `test/host/fixtures.ts` 的真实执行器构造，不经 HTTP；每项预热 1 次 + 7 次计时；生成的仓库放系统临时目录，结束删除。基线：`time make check` ×3、`vitest run --reporter=json` 取每文件耗时 Top 20，写进「验证记录」。
- **测试**：生成器确定性（同参数两次 `rev-parse HEAD` 相同）、包含合并/标签/大文件。
- **完成标准**：`pnpm bench` 输出 AC1/AC2 表；基线数据入计划。
- **验证命令**：`pnpm vitest run test/scripts/bench-fixture.test.ts`、`pnpm bench`、`make check`

### T2：超标项修复（视 T1 结果，可能为空）（完成）

- **目标**：AC1/AC2 中超预算的项定位并修复。
- **涉及文件**：视结果而定（候选：`src/host/git/status.ts` 的多次 git 调用合并或缓存、`src/host/cache.ts` 键带 version）。
- **测试**：每个修复先写行为不变的回归测试；性能本身由 `pnpm bench` 证明（不在 `make check` 里加绝对毫秒断言）。
- **完成标准**：`pnpm bench` 全部达标；T1 无超标时本任务标「完成（无需修改）」并写明。
- **验证命令**：`pnpm bench`、`make check`

### T3：包体积达标（完成，L4 在 T6）

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

- 2026-10-28 — T1 — `scripts/bench/{fixture.mjs,host.ts}` 与 `pnpm bench` 入库；基线测得 `make check` 测试段 480s、8 个超时失败；定位 git 转发层（xcrun）开销（见「意外与发现」）

## 下一步

- T4：`make check` 提速。先让 `test/host/fake-subprocess.ts` 与 `test/host/fixtures.ts` 用真实 git 二进制（`$(git --exec-path)/git`，模块加载时解析一次，找不到退回 `git`），单独跑 `test/host/merge-file.test.ts` 对比 45s 的基线；再跑全量 `vitest run --reporter=json` 看逐文件耗时，决定是否需要 `vitest.config.ts`（pool/并发）。

## 决策记录

- 2026-10-28 T1 — Ruling: 基准脚本写成 `scripts/bench/host.ts`（契约写的是 `.mjs`），用 Node 24 的 `--experimental-transform-types` 直接运行 `src/host` 的 TypeScript — 直接复用真实处理器与 `test/host` 的 subprocess 替身，不需要先打包、也不加依赖（`tsx` 等）；`src/host` 有参数属性，strip-only 模式跑不了 — 若错：Node 升级后该 flag 变化，`bench` 脚本改一行。
- 2026-10-28 T1 — Ruling: 每个样本用新的处理器（不吃缓存），先不计时地调一次 `bootstrap` 预热仓库解析；bootstrap 另测「同一处理器、时钟每次前进 3s」的稳态轮询（这才是 §16.8「状态轮询每次 ≤50ms」的场景），首个请求只记录 — 若错：稳态口径偏乐观，首个请求另有一行可对照。
- 2026-10-28 T1 — Ruling: 合成仓库的合并放在每 50 个提交的第 25 个，保证最近 24 个提交不含合并，变基计划可测；变基计划项是 24 条而非计划写的 50 条 — 若错：50 条的计划没测到，但耗时与条数近似线性。
- 2026-10-28 T2 — Ruling: 超标的根因是进程启动开销（不是 git 本身），修法是执行器可选的 `directBinary`：第一次运行时用 PATH 解析出的 git 执行 `--exec-path`，`<目录>/git`（Windows `git.exe`）经 `ctx.subprocess.resolveExecutable` 校验通过就固定用它，否则继续用 PATH 的结果；探测被中止/超时不缓存、下次重试。默认关闭、只在 `src/host/index.ts` 打开 — 默认开启会让每个测试的 spawn 列表多一条探测，几十处断言要改；生产只有一个入口 — 若错：沙箱 confine 下直接执行 Xcode 内的 git 若被 Seatbelt 拒绝，写命令会失败（T6 的 L4 必须在 confine 下做一次提交验证），且 B4d 的 git 路径设置要在这个解析结果之上叠加。
- 2026-10-28 T2 — Ruling: 计划里预想的「两次 `rev-parse` 合一」不做 — 开启 `directBinary` 后 bootstrap 稳态 15ms，已远低于 50ms，再改仓库解析会动到每个端点的公共路径，收益不值风险 — 若错：极慢的文件系统上 bootstrap 仍可能超预算，届时再合并。
- 2026-10-28 T2 — Ruling: `index.ts` 的接线没有单测（Host 入口没有测试替身），由执行器的 4 个单测 + `pnpm bench`（与 `index.ts` 同参数）+ T6 L4 覆盖 — 若错：有人删掉这个参数不会被 `make check` 发现，只会在基准里变慢。
- 2026-10-28 T3 — Ruling: 方案 A（标识符后压缩）后 gzip 272 KB 仍超标，按待确认 1 推荐继续做方案 B；spike 结论为可行（DSH client-modules 原生支持包内按需 chunk，references §17），所以 B 不是新机制，而是用宿主公开契约 — 若错：DSH 升级改了 chunk 契约，合并窗口打不开（会显示加载失败 + 重试），smoke 只能校验形态、不能校验宿主行为（T6 L4 补）。
- 2026-10-28 T3 — Ruling: 只把 `merge-editor.ts`（CodeMirror 封装，无样式）拆进 chunk，合并窗口组件、样式、store 留在主包；窗口在 effect 里异步拿到编辑器模块后创建三栏，已加载过则同步创建；渲染期要用的 `resultEditable` 移到无 CodeMirror 的 `merge-pane-state.ts`（`merge-editor.ts` 再导出，旧测试不改） — 若错：首次打开合并窗口时三栏会空一瞬（本地请求，预计几十毫秒）。
- 2026-10-28 T3 — Ruling: 主包在 banner 之后加一行 `// client.merge.js <哈希>` 注释，而不是把哈希作为 define 常量 — 常量在压缩时被常量折叠掉了，起不到带动包版本的作用（实测）；注释在 banner 区，不经过压缩 — 若错：DSH 若改为忽略注释计算版本（目前按文件内容），只改 chunk 时浏览器会用旧 chunk，直到主包也变化。
- 2026-10-28 T3 — Ruling: 模块体进 IIFE 后，esbuild 输出的 `"use strict"` 成为该函数的指令（以前在 banner 变量之后，不是指令），代码改在严格模式下运行 — 源码全是 TS/ES 模块、按严格模式编写，第三方依赖（CodeMirror、lezer）也是 ES 模块；smoke 在 vm 里执行两个 factory 通过 — 若错：某处依赖非严格语义（如给未声明变量赋值）会在运行时抛错，T6 L4 走查各页面兜底。
- 2026-10-28 T3 — 写了 [ADR 0013](../../decisions/0013-客户端产物拆分按需chunk与标识符后压缩.md)：产物形态变化影响后续所有用 CodeMirror 的代码与 B4d 安装验证。
- 2026-10-28 T1 — Ruling: 本计划各任务的关口先用「针对性测试 + lint/typecheck/layers」，全量 `make check` 放在 T4（提速）之后跑 — 基线全量 8 分钟且有 8 个负载超时，在 T4 解决之前每任务跑全量既慢又不会更可信；负责人本次会话开头也要求先跳过 — 若错：T2/T3 的回归要到 T4 后才被全量发现，届时回退定位成本略高。

## 意外与发现

- 2026-10-28 T1 — **git 转发层开销**：本机 `git` 是 `/usr/bin/git`（Xcode 命令行转发器，内部走 xcrun）。从普通 shell/node 启动一次约 8ms，直接调真实二进制（`xcrun -f git` 或 `$(git --exec-path)/git`）约 2.6ms；而**在 pnpm 启动的进程里（`pnpm exec`、`pnpm run`、vitest 都是）**，经转发器启动一次约 45ms（xcrun 慢了约 8 倍；去掉 PATH 就恢复，但同一个 PATH 在普通 node 里不慢，根因未完全查清，时间盒到此为止）。影响：(1) `make check` 的 Host 集成测试每次 spawn 多付约 40ms，是测试段 480s 的主因之一（CPU 总计只用了 238s，大部分时间在等进程启动）；(2) 开发期 `pnpm dsh web` 下 Host 每条 git 命令同样多付约 40ms，`pnpm bench` 中 bootstrap 285ms、commit 223ms、branches 188ms 全部超预算，而直接用 node 运行时只有 bootstrap 一项（50.4ms）略超。处理：T2 在 Host 里解析一次真实二进制；T4 在测试 fixtures 里同样处理。
- 2026-10-28 T1 — 基线 `make check` 并非全绿：8 个用例在全量负载下超时（`git command exceeded 8000 ms` 或 30s 用例超时：`merge-file` 2、`merge-write` 2、`operation` 2、`pull` 1、`rpc` 1），单独跑都通过；与 TD-16 同类，T4/T5 一起解决。

## 阻塞

- 无

## 验证记录

### T1 基线（2026-10-28，负责人这台 Mac，10 核，Apple Git 2.50.1，Node 24.11.0）

`make check` 各段（同时还有一个小基准在跑，影响很小）：lint 3.0s、typecheck 3.5s、layers 1.0s、**测试 480.3s**（user 133s、sys 105s）；134 个测试文件、2230 个用例，2222 通过、8 个超时失败（见「意外与发现」）。逐文件墙钟 Top 10（并发运行，单位 s）：`merge-file` 338、`operation` 311、`merge-write` 272、`rpc` 245、`push` 216、`branch-write` 211、`pull` 210、`update` 205、`smart-stash` 202、`interactive-rebase` 199，前 25 名全部是 `test/host/*`。单独跑 `merge-file.test.ts`：45s 墙钟、7.4s user，23 个用例每个 1–4s。

`pnpm bench`（10k 合成仓库，7 次）——两种跑法差异来自 git 转发层：

| 项 | 预算 | `pnpm bench` 中位 | 直接 node 中位 | A1（2026-10-25） |
|---|---|---|---|---|
| bootstrap 稳态轮询 | 50 | 285（首个请求口径） | 50.4（p95 121） | — |
| log 首页 | 500 | 174 | 52 | 46 |
| commit 详情 / 合并提交 | 200 | 223 / 256 | 39 / 38 | 30 / 31 |
| 单文件 diff（工作区 / 4500 行 / >256 KiB 截断） | 300 | 141 / 237 / 236 | 28 / 48 / 47 | 39 |
| branches | 100 | 188 | 36 | 28 |
| blame 4500 行首页 | — | 247 | 54 | — |
| 文件历史首页 | — | 188 | 68 | — |
| 分支比较 | — | 290 | 65 | — |
| 变基计划 24 条 | — | 517 | 98 | — |
| 贮藏列表 | — | 99 | 19 | — |
| 无命中搜索扫完 10k | — | 570 | 272 | 260 |

>256 KiB 文件 diff 返回 `truncated`、响应 358 KB（< 4 MiB）。JSON 在 `.evidence/b4c/`。

### T2 修复后（2026-10-28，`pnpm bench`，`directBinary` 开启，同一台机器）

| 项 | 预算 | 中位 | p95 | 修复前（`pnpm bench`） |
|---|---|---|---|---|
| bootstrap 稳态轮询 / 首个请求 | 50 / — | 15.0 / 20.4 | 15.8 / 20.9 | 285（首个请求） |
| log 首页 50 / 200 | 500 | 33.1 / 33.3 | 34.7 / 33.7 | 174 |
| commit 详情 / 合并提交 | 200 | 13.8 / 14.1 | 14.2 / 22.5 | 223 / 256 |
| diff 工作区 / 4500 行 / >256 KiB（truncated，358 KB） | 300 | 8.9 / 16.6 / 16.0 | 10.3 / 17.3 / 16.8 | 141 / 237 / 236 |
| branches | 100 | 11.7 | 12.8 | 188 |
| blame 4500 行首页 | — | 24.0 | 26.7 | 247 |
| 文件历史首页 | — | 48.4 | 48.9 | 188 |
| 分支比较 | — | 23.8 | 24.5 | 290 |
| 变基计划 24 条 | — | 30.6 | 34.2 | 517 |
| 贮藏列表 | — | 4.9 | 5.4 | 99 |
| 无命中搜索扫完 10k | — | 206.6 | 220.8 | 570 |

全部通过（AC1、AC2 的 Host 部分）。

### T3 包体积（2026-10-28）

| 产物 | 原始 | gzip | 说明 |
|---|---|---|---|
| 改动前 `lib/client.js` | 1,294,454 B | 312,256 B | smoke 新断言 RED：「gzip 312256 字节，超出预算 256000」 |
| 只做标识符后压缩 | 959.5 KB | 272,249 B | 仍超 |
| 最终 `lib/client.js` | 684.6 KB（含 95.7 KB CSS） | **179,552 B（175.3 KB）** | ≤ 250 KB 预算、≤ 200 KB 首发目标 |
| `lib/client.merge.js`（按需） | 276.8 KB | 93,018 B | 只在打开合并窗口时加载 |

`pnpm smoke` 通过：包装三行、CSS 注入与 HMR 替换、无短类名、体积门槛、chunk 注册（`id` + `chunk: 'client.merge.js'`）、chunk 只 require 基线模块并导出 `createMergePane`、主包含 `require.async("./client.merge.js")` 且不含 CodeMirror、哈希行与 chunk 一致；删掉 chunk 时报「缺少 lib/client.merge.js」。`pnpm dev` 实测：给 `merge-editor.ts` 加一行代码，chunk 与主包哈希行都更新（`bcf2a4f8cccd → 659666883f1d`），改回后恢复。`vitest run test/client` 95 个文件 1502 个用例全绿；typecheck、lint、layers 通过。
