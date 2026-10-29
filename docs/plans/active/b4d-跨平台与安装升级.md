# b4d-跨平台与安装升级：git 可执行文件与版本、跨平台审计、安装/升级验证与用户文档

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、契约与验收，不写完整实现代码。
B4c 合并到 main 之后再开工（同一时间只执行一份计划）。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 已批准（B4c 合并后开工） |
| 里程碑 | B4 打磨（第 4 份，共 4 份：B4a 设置页 + Blame 渲染器、B4b a11y 与样式变量、B4c 性能、**B4d 跨平台/安装升级/文档**；拆分 2026-10-28 负责人同意） |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §7.2（「找不到 git」空状态）、设置表「git 路径（P1）」、§16.2（插件形态与安装）、§16.7 错误分类（`git/not-found`、`git/unsupported-version`）、§16.9「兼容」；[设计决策 v0.2](../../design/2026-10-25-产品设计决策-v0.2.md) §4、§5 S3/S4/S5；[references](../../references/dsh-integration-feasibility.md) R1、§13；tech-debt TD-1、TD-2、TD-17 |
| 分支 | `b4d-platform-install`（B4c 合并后从 main 切出） |
| 批准记录 | 2026-10-28 负责人：待确认 1–4 按推荐，B4c 合并后再开工；执行方式开工时确认 |

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

### T1：git 版本解析与特性门控（待开始）

- **目标**：AC3 的 Host 部分；冻结契约。
- **涉及文件**：`src/host/git-version.ts`（新）、`src/shared/protocol.ts`、`src/host/git/interactive-rebase.ts`（`--update-refs` 门控）、`test/host/git-version.test.ts`。
- **接口与要点**：版本在 Host 首次需要时解析并缓存（`resolveExecutable` 结果 + 一次 `git --version`），之后每次命令复用；特性表集中在 `git-version.ts`，不在各端点散落判断版本。
- **测试**：版本字符串表驱动（Apple/Windows/rc 后缀/垃圾输入）；低版本下变基计划不带 `--update-refs`。
- **验证命令**：`pnpm vitest run test/host/git-version.test.ts`、`make check`

### T2：`git/not-found` 与 git 路径（Host）（待开始）

- **目标**：AC1、AC2 的 Host 部分。
- **涉及文件**：`src/host/git-executor.ts`、`src/host/rpc.ts`、`src/host/git-version.ts`、`test/host/git-executor.test.ts`、`test/host/fake-subprocess.ts`。
- **接口与要点**：`resolveExecutable` 失败（非取消/超时）→ `git/not-found`；`gitExecutable` 端点按待确认 1；校验通过后清空版本缓存；控制台记录实际使用的程序路径。
- **测试**：找不到 git、有效/无效路径、`--version` 输出非 git、切换路径后命令使用新路径、重新检测。
- **验证命令**：`pnpm vitest run test/host/git-executor.test.ts`、`make check`

### T3：客户端空状态与设置项（待开始）

- **目标**：AC1、AC3 的客户端部分。
- **涉及文件**：`src/client/settings.ts`（`gitPath: string | null`）、`src/client/pages/SettingsSheet.tsx`、`src/client/GitBody.tsx`（空状态分支）、`src/client/locales/*.ts`、对应 `*.dom.test.tsx`。
- **接口与要点**：空状态沿用现有「不是 Git 仓库」等空状态的组件与样式；安装说明链接到 git-scm.com；设置里显示 Host 返回的解析路径与版本（只读），输入框只接受绝对路径。
- **测试**：DOM 测试覆盖空状态按钮、设置路径成功/失败、版本过低提示；中英文键集一致。
- **验证命令**：`make check`

### T4：跨平台审计与单元测试（待开始）

- **目标**：AC4。
- **涉及文件**：Host 中 `import 'node:path'` 的 12 个文件、`src/host/git/write-support.ts`、`src/host/git/interactive-rebase.ts`、`src/host/repo-resolver.ts`；测试放各自现有测试文件。
- **接口与要点**：审计清单逐文件列出「路径来源（git 输出 / 会话 cwd / 用户输入）、拼接方式、比较方式（大小写）」；只修真实风险，其余记录。git 输出的路径一律是 `/` 分隔，Host 内部保持 repo 相对 POSIX 路径（设计 §16.5），只有与会话 cwd、worktree 绝对路径交互的地方需要按平台处理。
- **测试**：`path.win32` 下的 repo 根/子目录解析、含空格/引号/中文的路径、CRLF 输出解析。
- **验证命令**：`make check`

### T5：git 兼容测试（待开始）

- **目标**：AC5（按待确认 2）。
- **涉及文件**：`scripts/compat/run-host-tests.sh`（用指定 git 跑 `test/host`）、`docs/runbooks/verification.md`。
- **要点**：旧版 git 放临时目录，不装进系统；测试通过环境变量指定 git 路径（`test/host/fixtures.ts` 读取），不影响 `make check` 默认行为。
- **验证命令**：`scripts/compat/run-host-tests.sh <git 路径>`

### T6：打包、安装、升级、卸载验证（待开始）

- **目标**：AC6、AC7。
- **涉及文件**：`test/bundle.smoke.mjs`（pack 内容断言）、`package.json`（版本，按待确认 4）、`docs/runbooks/install-upgrade.md`（新）、`docs/runbooks/dev-setup.md`、`docs/references/dsh-integration-feasibility.md`（engines 行为）、`docs/quality/tech-debt.md`（TD-17）。
- **要点**：全部在隔离 HOME（复制 profile 的做法见 verification runbook B2 一节）里执行，端口 3081/3082；真实 `~/.dsh/profiles/web` 不动（红线）。
- **验证命令**：`pnpm pack`、`pnpm smoke`、L4 走查

### T7：真实仓库矩阵（L5）（待开始）

- **目标**：AC8。
- **涉及文件**：`scripts/matrix/`（建 11 种仓库的脚本，复用 B4c 生成器）、`docs/runbooks/verification.md` L5 一节。
- **要点**：仓库全部在临时目录生成，不用真实仓库数据；每种仓库走：打开 tab、日志、详情/diff、提交页、（可写时）一次提交与撤销。
- **验证命令**：矩阵脚本 + L4 走查

### T8：用户文档与 B 阶段收尾（待开始）

- **目标**：AC9、AC10；整分支评审；收尾清单（QUALITY、tech-debt、references、TODO、ARCHITECTURE）。
- **涉及文件**：`README.md`、`docs/glossary.md`、`AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/quality/QUALITY.md`。
- **验证命令**：`make check`、`python3 scripts/check_docs.py`

## 进度

- 无

## 下一步

- B4c 合并到 main 后从 `main` 切 `b4d-platform-install`，从 T1 开始。

## 决策记录

- 无

## 意外与发现

- 无

## 阻塞

- 无

## 验证记录

- 无
