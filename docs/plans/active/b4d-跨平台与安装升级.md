# b4d-跨平台与安装升级：git 可执行文件与版本、跨平台审计、安装/升级验证与用户文档

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、契约与验收，不写完整实现代码。
B4c 合并到 main 之后再开工（同一时间只执行一份计划）。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 进行中 |
| 里程碑 | B4 打磨（第 4 份，共 4 份：B4a 设置页 + Blame 渲染器、B4b a11y 与样式变量、B4c 性能、**B4d 跨平台/安装升级/文档**；拆分 2026-10-28 负责人同意） |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §7.2（「找不到 git」空状态）、设置表「git 路径（P1）」、§16.2（插件形态与安装）、§16.7 错误分类（`git/not-found`、`git/unsupported-version`）、§16.9「兼容」；[设计决策 v0.2](../../design/2026-10-25-产品设计决策-v0.2.md) §4、§5 S3/S4/S5；[references](../../references/dsh-integration-feasibility.md) R1、§13；tech-debt TD-1、TD-2、TD-17 |
| 分支 | `b4d-platform-install`（B4c 合并后从 main 切出） |
| 批准记录 | 2026-10-28 负责人：待确认 1–4 按推荐，B4c 合并后再开工；2026-10-29 执行方式：当前会话内联执行，最后做一次整分支评审 |

## 目标

用户在任何受支持的平台上安装插件后，要么能正常使用，要么得到一句能照着做的提示：找不到 git 时说「未找到 git」并能设置路径、git 太旧时说出最低版本、DSH 版本不匹配时安装或启动就报清楚。安装、升级、卸载都有走通过的步骤；README 从「开发者状态页」改成用户能照着装、照着用、照着排障的说明。B 阶段收尾的「真实仓库矩阵」在这里一次跑完。

## 现状（2026-10-28 盘点）

- **git 可执行文件**：`src/host/git-executor.ts` 每次都 `subprocess.resolveExecutable('git')`，失败时抛 `git/exec-failed`（或取消/超时）。协议里**没有** `git/not-found`、`git/unsupported-version`（设计 §16.7 列了），客户端没有「未找到 git」空状态，设置里没有 git 路径。
- **git 版本**：从未检测。代码用到的较新特性：`rebase --update-refs`（2.38，B3a 交互式变基）、`--pathspec-from-file`（2.25/2.26）、`switch`/`restore`（2.23）、`worktree` 多个子命令；本机只有 Apple Git 2.50.1，设计 §16.9 要求覆盖 2.25 / 2.38 / 2.40。
- **跨平台**：只在 macOS 上开发和测试。Host 有 12 个文件 `import 'node:path'`；`diff.ts` 已识别 Windows 盘符绝对路径；交互式变基用 `GIT_SEQUENCE_EDITOR='cat >'`（依赖 git 自带的 sh，在 Git for Windows 上未实测，设计 S3）；`write-support.ts` 有 POSIX 单引号转义；CRLF 有 autocrlf 合并测试，其余未专项测。
- **安装/升级**：开发期用 `dev.patch.yml`；安装态只按 runbook 用本地目录 `dsh plugin add <path>`（记成 `link:`，改代码不需重装），**从未用打包产物（tarball）装过、从未测过升级与卸载**，`engines.dsh` 不匹配时的表现未知。`package.json` 版本 0.1.0。
- **构建**：TD-17 已在 `build.mjs` 里 `mkdirSync('lib')` 修掉（写法见 `emitClientBundle`），tech-debt 表里还没移到「已处理」，Host 产物路径需复核。
- **文档**：README「当前状态」还停在 M0；没有面向用户的安装、功能、设置、快捷键、排障说明。

## 范围

**包含：**

- **git 可执行文件与版本**：Host 启动后（以及「重新检测」时）解析并缓存 git 路径与版本；新增 `git/not-found`、`git/unsupported-version` 两个错误码；bootstrap 带上 git 信息；客户端按设计 §7.2 显示「未找到 git 命令」+ 安装说明 +「重新检测」/「设置 git 路径」，版本过低时显示最低版本；低于某特性所需版本时只隐藏/禁用该特性并说明（如 `--update-refs`）。
- **git 路径设置**（设计设置表 P1）：设置页加「git 路径」，存储与传递方式按待确认 1；Host 校验（绝对路径、可执行、`--version` 输出以 `git version` 开头）后才采用。
- **跨平台审计**：逐个过 Host 的路径拼接/比较、换行、引号与环境变量；用 `path.win32`/CRLF 输入补单元测试；交互式变基在 Windows 上的 sequence editor 方案写明并有测试（见待确认 3）。
- **git 版本兼容测试**：在能拿到的旧版 git 上跑一遍 Host 集成测试（方式见待确认 2）。
- **安装/升级/卸载验证**（隔离 HOME，不碰负责人的 `~/.dsh/profiles/web`）：`pnpm pack` 产物内容校验（只含 `lib/`、`cordis.patch.yml`、`README.md`、`package.json`，进 smoke）；tarball 安装 → 重启 → 冒烟；版本 A → 版本 B 升级 → 冒烟（设置与 changelist 等 localStorage 数据保留）；卸载后 DSH 正常启动、无残留 slot；`engines.dsh` 不匹配时的行为记录进 references。新增 `docs/runbooks/install-upgrade.md`。
- **真实仓库矩阵（L5）**：10k 提交（复用 B4c `pnpm bench` 的生成器）、脏工作区、冲突进行中、仓库根在沙箱外（只读）、子目录会话、CRLF/autocrlf 仓库、浅克隆、worktree、空仓库、非仓库目录，逐项走主要流程并记录。
- **用户文档**：重写 README（是什么、系统要求、安装/升级/卸载、功能一览、设置项、快捷键、只读模式与沙箱说明、排障、已知限制）；开发者入口保留一行链接到 AGENTS.md；`docs/glossary.md` 补新术语。
- **整个 B 阶段收尾**：对照设计决策 §2.1 P0/P1 清单与 §4 B 阶段验收逐项核对，差距列表请负责人裁定。

**不包含：**

- 发布 npm 包、`git push`、打 tag（红线：由负责人执行）；版本号改到 1.0.0 与否按待确认 4，本计划最多改 `package.json`，不发布。
- 在 Windows/Linux 真机上做完整 L4 走查（没有现成机器，见待确认 3）；子模块、LFS（设计 P2）。
- TODO 中各计划终审遗留的 Minor 条目（另行排期）。

## 待负责人确认

1. **git 路径的存储与传递**：推荐「客户端存、Host 只在内存里采用」：设置存 `localStorage`（设计原文），客户端挂载时与修改时调用新端点 `gitExecutable { path: string | null }`，Host 校验通过后只在**当前进程内存**中替换解析结果（不写文件），返回解析后的绝对路径与版本；Host 重启后回到 PATH 解析，直到客户端再次发送。理由：符合设计「本地持久化」、Host 不需要新的持久化位置；`path` 只能是绝对路径且必须通过 `--version` 校验，降低把任意程序当 git 执行的风险。备选 A：Host 用环境变量 `DSH_GIT_PATH` 覆盖（只在启动时读，客户端只读显示），安全面最小但用户要改启动方式。备选 B：Host 持久化到插件自己的数据目录（需要确认 DSH 给插件的存储 API，可能要新调研）。
2. **最低 git 版本与兼容测试方式**：推荐最低 **2.25**（设计 §16.9 的下限），`--update-refs` 等 2.38 特性在低版本上禁用并说明；兼容测试用本机 Homebrew/源码编译出 2.25、2.38 两个版本放到临时目录，通过新的「git 路径」机制让 Host 集成测试跑一轮（只跑 `test/host`，不进 `make check`）。如果本机装不出旧版本，记「未实测」并只保留版本门控的单元测试。备选：最低提到 2.38，不做低版本降级（实现最简单，Ubuntu 22.04 自带 2.34 会被拒）。
3. **Windows / Linux**：本计划推荐「静态审计 + 单元测试 + 文档注明未实测」；交互式变基在 Windows 上沿用 `cat >`（Git for Windows 的 sequence editor 由其自带 sh 执行），但加一个不依赖 shell 的退路（例如 Host 先把 todo 写进 `.git/` 下的临时文件、`GIT_SEQUENCE_EDITOR` 用 `git` 自己能执行的命令复制）只在审计发现 `cat` 不可用时做。如负责人有 Windows 或 Linux 机器/虚拟机可用，请告诉我，T5 会加一轮真机冒烟。
4. **版本号**：推荐本计划把 `package.json` 改为 `1.0.0-rc.1`（设计「最终只发 1.0.0」，rc 供负责人验收），升级验证用 `0.1.0` → `1.0.0-rc.1` 两个 tarball；正式 1.0.0 与发布由负责人在验收后决定。备选：保持 0.x，升级验证用 0.1.0 → 0.2.0。

## 验收标准

- [ ] AC1：PATH 中没有 git 时（测试里注入一个找不到 git 的 subprocess）bootstrap 返回 `git/not-found`；客户端显示「未找到 git 命令」、安装说明链接、「重新检测」「设置 git 路径」；设置一个有效绝对路径后无需重启 DSH 即恢复正常（单测 + DOM 测试 + L4）。
- [ ] AC2：git 路径校验：相对路径、不存在、不可执行、`--version` 输出不是 git 的程序都被拒绝并给出原因；校验通过后控制台记录的命令使用该路径（Host 单测）。
- [ ] AC3：版本低于最低版本时返回 `git/unsupported-version`（带当前与最低版本），客户端显示升级提示；版本介于最低与 2.38 之间时交互式变基的 `--update-refs` 不出现/不传，说明文案可见（版本解析覆盖 `2.25.0`、`2.39.3 (Apple Git-146)`、`2.45.1.windows.1` 等格式）。
- [ ] AC4：跨平台审计清单（文件、风险、处理方式）写进「验证记录」；新增的 `path.win32`、CRLF、含空格/引号/中文路径的单元测试通过；Windows/Linux 真机按待确认 3 的结论记录「已实测」或「未实测 + 原因」。
- [ ] AC5：git 兼容：按待确认 2，在 2.25 与 2.38 上 `test/host` 全绿，或记录失败用例与处理（修复 / 版本门控 / 登记技术债）。
- [ ] AC6：`pnpm pack` 产物只含 `lib/host.js`、`lib/client.js`（及 B4c 若拆出的产物）、`lib/client.css`（如有）、`cordis.patch.yml`、`README.md`、`package.json`（smoke 断言）；干净 checkout 上 `pnpm install && pnpm build && pnpm smoke` 通过（TD-17 复核后移入已处理）。
- [ ] AC7：隔离 HOME 下：tarball 安装 → 重启 `dsh web` → Git tab 可用；升级到新版本 tarball → 重启 → 可用且设置、changelist、合并草稿保留；卸载 → DSH 正常启动、文档预览头部无 Git 动作；`engines.dsh` 不满足时的提示原文记入 references（截图 `.evidence/b4d/`）。
- [ ] AC8：真实仓库矩阵 11 种仓库逐项通过或记录差距（表格写进「验证记录」）。
- [ ] AC9：README 按范围重写并经负责人通读；`docs/runbooks/install-upgrade.md` 新增；AGENTS.md 命令表与链接有效；`scripts/check_docs.py` 通过。
- [ ] AC10：B 阶段核对表（设计决策 §2.1 每一项 → 已实现的计划/未实现原因）写进「验证记录」，负责人裁定差距。

## 契约（T1 冻结）

```ts
// src/shared/protocol.ts（追加，不改已有端点）
type GitErrorCode = ... | 'git/not-found' | 'git/unsupported-version'
interface GitExecutableInfo { path: string; version: string /* '2.50.1' */; raw: string /* 原始 --version 输出 */; source: 'path' | 'setting' }
interface BootstrapValue { ...; git?: GitExecutableInfo }          // 可选字段，旧客户端忽略
// 新端点（待确认 1 选推荐时）：
gitExecutable: { request: RpcRequest & { path: string | null; redetect?: boolean }; value: GitExecutableInfo }
// details：git/unsupported-version → { current: string; minimum: string }

// src/host/git-version.ts
export const GIT_MIN_VERSION = '2.25.0'
export function parseGitVersion(raw: string): { major: number; minor: number; patch: number } | null
export function gitSupports(version: ParsedGitVersion, feature: 'updateRefs' | 'pathspecFromFileStash'): boolean
```

## 任务

<!-- 状态：待开始 / 进行中 / 完成 / 阻塞 -->

### T1：git 版本解析与特性门控（完成）

- **目标**：AC3 的 Host 部分；冻结契约。
- **涉及文件**：`src/host/git-version.ts`（新）、`src/shared/protocol.ts`、`src/host/git/interactive-rebase.ts`（`--update-refs` 门控）、`test/host/git-version.test.ts`。
- **接口与要点**：版本在 Host 首次需要时解析并缓存（`resolveExecutable` 结果 + 一次 `git --version`），之后每次命令复用；特性表集中在 `git-version.ts`，不在各端点散落判断版本。
- **测试**：版本字符串表驱动（Apple/Windows/rc 后缀/垃圾输入）；低版本下变基计划不带 `--update-refs`。
- **验证命令**：`pnpm vitest run test/host/git-version.test.ts`、`make check`

### T2：`git/not-found` 与 git 路径（Host）（完成）

- **目标**：AC1、AC2 的 Host 部分。
- **涉及文件**：`src/host/git-executor.ts`、`src/host/rpc.ts`、`src/host/git-version.ts`、`test/host/git-executor.test.ts`、`test/host/fake-subprocess.ts`。
- **接口与要点**：`resolveExecutable` 失败（非取消/超时）→ `git/not-found`；`gitExecutable` 端点按待确认 1；校验通过后清空版本缓存；控制台记录实际使用的程序路径。
- **测试**：找不到 git、有效/无效路径、`--version` 输出非 git、切换路径后命令使用新路径、重新检测。
- **验证命令**：`pnpm vitest run test/host/git-executor.test.ts`、`make check`

### T3：客户端空状态与设置项（完成）

- **目标**：AC1、AC3 的客户端部分。
- **涉及文件**：`src/client/settings.ts`（`gitPath: string | null`）、`src/client/pages/SettingsSheet.tsx`、`src/client/GitBody.tsx`（空状态分支）、`src/client/locales/*.ts`、对应 `*.dom.test.tsx`。
- **接口与要点**：空状态沿用现有「不是 Git 仓库」等空状态的组件与样式；安装说明链接到 git-scm.com；设置里显示 Host 返回的解析路径与版本（只读），输入框只接受绝对路径。
- **测试**：DOM 测试覆盖空状态按钮、设置路径成功/失败、版本过低提示；中英文键集一致。
- **验证命令**：`make check`

### T4：跨平台审计与单元测试（完成）

- **目标**：AC4。
- **涉及文件**：Host 中 `import 'node:path'` 的 12 个文件、`src/host/git/write-support.ts`、`src/host/git/interactive-rebase.ts`、`src/host/repo-resolver.ts`；测试放各自现有测试文件。
- **接口与要点**：审计清单逐文件列出「路径来源（git 输出 / 会话 cwd / 用户输入）、拼接方式、比较方式（大小写）」；只修真实风险，其余记录。git 输出的路径一律是 `/` 分隔，Host 内部保持 repo 相对 POSIX 路径（设计 §16.5），只有与会话 cwd、worktree 绝对路径交互的地方需要按平台处理。
- **测试**：`path.win32` 下的 repo 根/子目录解析、含空格/引号/中文的路径、CRLF 输出解析。
- **验证命令**：`make check`

### T5：git 兼容测试（部分完成：2.39.5 实测通过；2.25 / 2.38 待负责人决定）

- **目标**：AC5（按待确认 2）。
- **涉及文件**：`scripts/compat/run-host-tests.sh`（用指定 git 跑 `test/host`）、`docs/runbooks/verification.md`。
- **要点**：旧版 git 放临时目录，不装进系统；测试通过环境变量指定 git 路径（`test/host/fixtures.ts` 读取），不影响 `make check` 默认行为。
- **验证命令**：`scripts/compat/run-host-tests.sh <git 路径>`

### T6：打包、安装、升级、卸载验证（完成）

- **目标**：AC6、AC7。
- **涉及文件**：`test/bundle.smoke.mjs`（pack 内容断言）、`package.json`（版本，按待确认 4）、`docs/runbooks/install-upgrade.md`（新）、`docs/runbooks/dev-setup.md`、`docs/references/dsh-integration-feasibility.md`（engines 行为）、`docs/quality/tech-debt.md`（TD-17）。
- **要点**：全部在隔离 HOME（复制 profile 的做法见 verification runbook B2 一节）里执行，端口 3081/3082；真实 `~/.dsh/profiles/web` 不动（红线）。
- **验证命令**：`pnpm pack`、`pnpm smoke`、L4 走查

### T7：真实仓库矩阵（L5）（完成）

- **目标**：AC8。
- **涉及文件**：`scripts/matrix/`（建 11 种仓库的脚本，复用 B4c 生成器）、`docs/runbooks/verification.md` L5 一节。
- **要点**：仓库全部在临时目录生成，不用真实仓库数据；每种仓库走：打开 tab、日志、详情/diff、提交页、（可写时）一次提交与撤销。
- **验证命令**：矩阵脚本 + L4 走查

### T8：用户文档与 B 阶段收尾（待开始）

- **目标**：AC9、AC10；整分支评审；收尾清单（QUALITY、tech-debt、references、TODO、ARCHITECTURE）。
- **涉及文件**：`README.md`、`docs/glossary.md`、`AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/quality/QUALITY.md`。
- **验证命令**：`make check`、`python3 scripts/check_docs.py`

## 进度

- 2026-10-29 — T1 — `src/host/git-version.ts`（解析、最低 2.25.0、`updateRefs` 门控）；协议加 `git/not-found`、`git/unsupported-version`、`GitExecutableInfo`；仓库 bootstrap 在 git < 2.25 时返回 `git/unsupported-version`；交互式变基在 git < 2.38 时不传 `--update-refs`
- 2026-10-29 — T2 — `src/host/git-executable.ts`（PATH / 设置路径、校验、`info()` 缓存）；执行器解析失败（非取消/超时）→ `git/not-found`，有设置路径时每条命令都跑它；`gitExecutable` 端点；bootstrap 带 `git`
- 2026-10-29 — T3 — 设置项 `gitPath`（只收绝对路径，恢复默认时保留）；`git-path.ts`（客户端绝对路径检查、Host 拒绝原因文案、Host 采用后才保存）；`git-missing.tsx` 空状态（未找到 / 版本过低、安装说明、重新检测、设置路径）；设置页「git 路径」行（正在使用的路径与版本、未生效提示）；Git 标签挂载时把已存路径交给 Host；变基页在 git < 2.38 且范围内有其他分支时说明不会移动它们。L4（AC1「无需重启即恢复」）并入 T6 的隔离 DSH 走查
- 2026-10-29 — T4 — 跨平台审计（清单见「验证记录」）；修了两处真实风险：win32 上 `validateRepoPath` 放过 `..\x`、`C:foo`；win32 默认关闭 `directBinary`。`isWithinRoot` 用 `path.win32`/`posix` 补测
- 2026-10-29 — T5 — `scripts/compat/run-host-tests.sh` + `DSH_GIT_TEST_BINARY`；用本机 Apple Git 2.39.5（CommandLineTools）跑 `test/host`：首轮 9 个失败，其中 1 个是真实缺口（搁架三方取回用的 `merge-file --object-id` 需 2.43，已加门控），其余是测试绑死新版 git 输出（已改为按版本断言）；修后 2.39.5 与 2.50.1 都是 762/762
- 2026-10-29 — T6 — `package.json` 版本 `1.0.0-rc.1`、`files` 改为显式清单（不再带 `client.css` 与 `host.js.map`）；smoke 校验 `pnpm pack` 内容；隔离 HOME 走通 tarball 安装 → 升级 → 设置 git 路径 → 无 git 空状态与恢复 → 卸载 → engines 不匹配（逐项见 [install-upgrade](../../runbooks/install-upgrade.md)「实测」）；TD-17 复核后移入已处理
- 2026-10-29 — T7 — `scripts/matrix/host.ts`（`pnpm matrix`）12 种仓库全部通过（表见「验证记录」）；L4：空仓库在真实沙箱下从提交页做出第一个提交

## 下一步

- T8：README 重写、B 阶段核对表、整分支评审与收尾文档。
- 待负责人：是否允许在 scratchpad 编译 git 2.25.5 / 2.38.5（源码已下载到 scratchpad，编译被自动模式拦截），用于补跑 T5。

## 决策记录

- T1 Ruling：契约里的 `pathspecFromFileStash` 特性不做——`stash push` 从不传 pathspec，`add`/`commit`/`reset`/`restore` 的 `--pathspec-from-file` 在 2.25 已有，被最低版本覆盖；`GitFeature` 只有 `updateRefs`。代价：若 T5 实测发现 2.25 上某命令缺该选项，再加特性项。
- T1 Ruling：`gitExecutable` 端点与 `BootstrapValue.git` 在 T2 与实现一起加进协议（端点表是穷举映射，先加类型会让处理器表不完整）；T1 只冻结 `GitExecutableInfo`、`UnsupportedVersionDetails` 与两个错误码。代价：无，T2 按契约补。
- T1 Ruling：交互式变基在操作内自己跑一次 `git --version` 决定是否传 `--update-refs`，不接 runtime 的版本缓存（`WriteContext` 不带 runtime）；不符合时静默不传，而不是报错（页面本就隐藏该选项）。代价：每次变基多一次约 3ms 的进程；T2 把版本缓存移进执行器后可复用。
- T1 Ruling：版本门控只在「是仓库」的 bootstrap 上做；不在仓库时照旧返回只读空状态。代价：非仓库目录里 git 过旧不提示，但那里也不跑任何 git 操作。
- T1 Ruling：保留已有的 `BootstrapValue.gitVersion`（状态栏用），不改名。
- T2 Ruling：去掉契约里的 `redetect` 参数——`set(path)` 每次都重新校验、清缓存并重新探测，「重新检测」就是重发当前设置。代价：无。
- T2 Ruling：校验失败用 `git/invalid-payload` + `details.reason`（`not-absolute`/`not-found`/`not-executable`/`not-git`）；版本过低用 `git/unsupported-version`；被拒时保留原来的路径。代价：客户端按 reason 出文案（T3）。
- T2 Ruling：有设置路径时每条命令前用 `resolveExecutable(path)` 复核、原样运行该路径，不再走 `directBinary` 探测（用户指定的就是要跑的程序）。代价：若用户指向 macOS 的 `/usr/bin/git` 会重新付 xcrun 开销。
- T2 Ruling：`info().path` 报 PATH 解析出的 `git`，而不是 `directBinary` 实际运行的 `--exec-path` 下的程序。代价：设置页显示的路径与真实子进程 argv[0] 可能不同（同一个 git 安装）。
- T2 Ruling：已有测试「spawn lookup failure → `git/exec-failed`」改为 `git/not-found`——这正是设计 §16.7 要的行为变化。控制台仍显示 `git <参数>`，不显示程序路径；AC2「使用该路径」以子进程 argv[0] 断言。
- T3 Ruling：「恢复默认」保留 `gitPath`（与 Changelist 分组一样）：它描述 git 装在哪里，不是偏好；清空要在设置页留空后点「应用」。代价：想一键清掉路径的用户要多一步。
- T3 Ruling：已存路径只在 Git 标签挂载时交给 Host 一次（之后的改动走设置页/空状态）；挂载时没有设置就不发请求，Host 保持 PATH。代价：Host 重启而页面不刷新时，直到下次挂载才恢复设置路径（设置页会显示「未生效」提示）。
- T3 Ruling：设置页与空状态共用 `GitPathField`；空状态在没有已存路径、也没有错误时先只给「设置 git 路径…」按钮，点开后输入框获得焦点。
- T3 Ruling：AC3「说明文案可见」落在变基页：git < 2.38 且范围内有其他分支时显示一句说明（列出分支名），没有其他分支时不显示（不相关）。
- T4 Ruling：Windows 上默认关闭 `directBinary`（`directBinaryByDefault`）：直接启动 `libexec/git-core/git.exe` 不会带上 `cmd\git.exe` 补进 PATH 的 `usr\bin`（`GIT_SEQUENCE_EDITOR='cat >'` 的 `sh`/`cat`、ssh、凭据助手）。没有 Windows 真机可测，按「宁可慢、不可坏」处理（B4c 终审 Minor 之一由此关闭）。代价：Windows 上每次 git 调用多付 `cmd\git.exe` 的转发开销（未测量）。
- T4 Ruling：`validateRepoPath` 按平台判定：win32 上 `\` 也是分隔符、任何 `C:` 前缀都拒绝；POSIX 上文件名里的 `\` 仍是合法字符。代价：无（git 在 Windows 上不产生含 `\` 的路径）。
- T4 Ruling：沙箱根包含判断抽成纯函数 `isWithinRoot`，顺带修正 `/repo/..cache` 这类以 `..` 开头的子目录被误判为「在外面」的问题。
- T4 Ruling：diff 行文本保留 CRLF 文件的 `\r`（如实反映内容，浏览器里不可见），只记录不改；「只改了行尾」的 diff 看起来像相同的行，登记 TODO。
- T5 Ruling：搁架三方取回在 git < 2.43 上直接拒绝（`git/unsupported-version` + `feature`），而不是改写成「临时文件 + `merge-file -p` + `hash-object`」的降级：后者要把 blob 当文本读进 Node，会弄坏二进制文件。版本探测失败时不拦，让 git 自己报错。代价：2.25–2.42 的用户不能三方取回搁架（普通取回不受影响），客户端显示的是 Host 的英文消息。
- T5 Ruling：兼容运行里依赖新版输出的测试改为按 `GIT_TEST_VERSION` 分支断言（不跳过）：`fetch` 计数（2.41）、搁架三方（2.43）；与版本无关的写法替换：`git var GIT_SEQUENCE_EDITOR` → shell 别名、`%aI` → `%at`、`directBinary` 期望值从 `GIT_BINARY` 的 `--exec-path` 推出。
- T5 阻塞：编译 2.25.5 / 2.38.5 源码被自动模式（Code from External）拦截；按指令不绕过，记「未实测」，请负责人决定是否放行。下载的源码包在 scratchpad `compat/src/`。
- T6 Ruling：包里不放 `lib/client.css`（构建时的样式副本，DSH 不读取，样式已内联进 `client.js`）与 `lib/host.js.map`；`files` 用显式清单，smoke 用 `pnpm pack --dry-run --json` 比对。代价：Host 出错时安装态没有 source map（开发态 `lib/` 里仍有）。
- T6 Ruling：升级验证的旧版本用 `b4c-perf` worktree（= main 的代码）打的 0.1.0 包，新版本用本分支打的 1.0.0-rc.1 包；engines 不匹配用改了 `engines.dsh` 与版本号的 1.0.0-rc.99 临时包（只在 scratchpad）。
- T6 Ruling：卸载后 DSH 恢复的「Git」占位标签不由插件处理（插件已不在，无法清理 DSH 的布局存储），写进 install-upgrade runbook 与 README 排障。
- T7 Ruling：矩阵在 Host 层跑（真实 RPC 处理器 + 真实 git + 直通 confine），不逐个开 DSH 走 UI；UI 只补此前各计划 L4 没覆盖过的空仓库。代价：矩阵不覆盖客户端渲染差异（例如浅克隆边界提交在提交图里的画法）。
- T7 Ruling：计划写的「11 种」实际做了 12 种：linked worktree 拆成「在 `.worktrees/` 下、工作区为主仓库」（可写）与「主仓库在工作区外」（只读）两种，后者是 fail closed 的设计行为（共同 `.git` 在沙箱外，写也会被沙箱拒），不是缺陷；另加了「路径含空格/中文/引号」。

## 意外与发现

- 无

## 阻塞

- T5：git 2.25 / 2.38 兼容实测需要在本机编译源码，自动模式拦截，等负责人决定（不阻塞 T6–T8）

## 验证记录

### T4 跨平台审计（AC4，2026-10-29，静态审计 + 单元测试；Windows/Linux 真机**未实测**：没有可用机器，按待确认 3）

| 位置 | 路径/文本来源 | 风险 | 处理 |
|---|---|---|---|
| `git/diff.ts` `validateRepoPath`（diff、worktree、blame、文件历史等 20 处入口） | 客户端 | win32 上 `..\x`、`a\..\..\b`、`C:foo` 未被拒绝，`path.join` 会离开仓库 | **已修**：按平台分隔符与盘符判定；`diff.test.ts` 补 win32 用例 |
| `sandbox-gate.ts` `isInside` | 会话 cwd、沙箱根、git 输出 | `startsWith('..')` 把 `/repo/..cache` 判成仓库外；win32 大小写/分隔符 | **已修**：抽成 `isWithinRoot`，按段比较；`path.win32` 用例覆盖大小写、`/` 与 `\` 混用、跨盘 |
| `git-executor.ts` `directBinary` | `git --exec-path` | Windows 上绕过 `cmd\git.exe` 的 PATH 补充 | **已修**：win32 默认关闭 |
| `repo-resolver.ts`、`rpc.ts` gitDirs、`watch.ts`、`status.ts`/`operation.ts`/`shelf.ts`/`smart-stash.ts` 的 `join(gitDir, …)` | git 输出（Windows 上为 `C:/…`） | 与 `\` 混用 | 无需改：win32 的 `join`/`relative`/`isAbsolute` 都接受两种分隔符；仓库根始终来自 git 输出，作为缓存键前后一致；多行输出都先 `trim()` |
| `write-support.ts` `shellQuote`（控制台「复制命令」、blame 命令提示） | 仓库根、参数 | 生成的是 POSIX shell 语法 | 记录：Windows 上复制的命令要在 Git Bash 里运行；登记 TODO |
| `interactive-rebase.ts` `GIT_SEQUENCE_EDITOR='cat >'` | 固定 | Git for Windows 用自带 `sh` 执行编辑器 | 记录：经 `cmd\git.exe` 启动时 `usr\bin` 在 PATH 上（为此关闭 `directBinary`）；未实测 |
| 所有 git 调用 | — | 含空格/引号/中文的路径 | 无风险：一律 argv（无 shell），路径列表走 `--pathspec-from-file` + NUL；`status`/`commit-write`/`rollback`/`diff` 测试已覆盖特殊字符，`git-executable.test.ts` 的临时目录名含空格与 `✓` |
| `diff.ts` 内容行、`blame.ts` | 文件内容 | CRLF | diff 保留 `\r`（如实），blame 去掉行尾 `\r`；只改行尾的 diff 难以分辨，登记 TODO |

### T7 真实仓库矩阵（AC8，2026-10-29，`pnpm matrix`，git 2.50.1）

| 仓库 | 结果 | 记录 |
|---|---|---|
| 10k 合成提交（含合并/大文件/脏工作区） | 通过 | 日志 100 行；25 处改动；提交 + 撤销 |
| 脏工作区（修改/暂存/未跟踪/重命名） | 通过 | 4 处改动；提交 + 撤销 |
| 合并冲突进行中 | 通过 | `operation: merge`、1 个冲突（提交走 operationCommit，不在矩阵里） |
| 仓库根在沙箱外 | 通过 | 只读；读操作正常 |
| 子目录会话 | 通过 | 仓库根解析到顶层；提交子目录里的文件 + 撤销 |
| CRLF + `core.autocrlf` | 通过 | 提交 + 撤销 |
| 浅克隆（`--depth 3`） | 通过 | 最早一行（边界）读作无父提交，详情列出整棵树 |
| linked worktree（`.worktrees/` 下，工作区为主仓库） | 通过 | 分支 `feature`；提交 + 撤销 |
| linked worktree（主仓库在工作区外） | 通过 | 只读 `repo-outside-workspace`（fail closed） |
| 空仓库 | 通过 | 日志 0 行；第一个提交（没有父提交可撤销）；L4 在真实沙箱下从提交页提交成功，日志显示「没有父提交（根提交）」 |
| 非仓库目录 | 通过 | 只读空状态 |
| 路径含空格/中文/引号 | 通过 | 提交 `文档/说明 "引号" it's.md` + 撤销 |

