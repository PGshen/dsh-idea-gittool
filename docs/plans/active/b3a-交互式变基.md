# b3a-交互式变基：从此处交互式变基、修改提交信息、丢弃与压缩提交

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、契约与验收，不写完整实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 执行中 |
| 里程碑 | B3 高级操作（拆成 4 份，本份为 B3a；拆分见 [TODO](../TODO.md)） |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §5.3（覆盖层）、§6.2（「提交右键菜单」「交互式变基」行）、§8.1.7（P1 菜单项）、§11（Interactive Rebase / Commit Message 对话框）、§14.1（`F2`）、§14.3（拖拽排序）、§17 M5、§18 R13；[设计决策 v0.2](../../design/2026-10-25-产品设计决策-v0.2.md) §4（B3 行、「交互式变基先做 spike/feature flag」）、§5 S3 |
| 分支 | `b3a-interactive-rebase`（独立 worktree） |
| 批准记录 | 2026-10-27 负责人批准计划：待确认 1–5 按推荐执行，执行方式内联（当前会话，executing-plans），收尾做一次整分支评审；同日负责人离开前授权：B3a 完成后自动评审，并接着起草、实现、自评审 B3b–B3d，回来后统一 review 全部 B3 |

## 目标

用户能在日志里对当前分支的一段提交做交互式变基：在 Git tab 的全高覆盖页里看到从起点到 HEAD 的提交列表，逐个选 pick / reword / edit / squash / fixup / drop、拖拽或键盘调整顺序、编辑提交信息，预览后执行；冲突或 `edit` 停下时沿用现有的操作横幅与冲突流程继续或中止。日志提交右键的「修改提交信息…（F2）」「丢弃提交…」「压缩提交…」直接生成对应的变基，不必打开完整列表。

## 范围

**包含：**

- **Host 读端点 `rebasePlan`**：列出起点（不含）到 HEAD 的提交（旧 → 新），附完整提交信息、是否已推送；不能变基时给出原因（范围内有合并提交、起点不是 HEAD 的祖先、detached HEAD、提交过多）。
- **Host 写端点 `interactiveRebase`**：按客户端给的条目生成 todo，经 `GIT_SEQUENCE_EDITOR` 交给 `git rebase -i`；改写的提交信息存成 blob，由 todo 中的 `exec` 行写回（机制见待确认 1，T1 实测定稿）；走写队列、写门禁、智能贮藏；HEAD 在打开列表后变了就拒绝。
- **操作状态扩展**：`operationState` 区分变基停下的原因（冲突 / `edit` / `exec` 失败），横幅与提交页据此给出文案；`edit` 停下时提交页 Amend 可用。
- **Client**：React 无关的变基列表模型与 store；`InteractiveRebasePage` 覆盖页（动作选择、拖拽与 `Alt+↑/↓` 排序、提交信息编辑、todo 预览、已推送警告）。
- **入口**（日志提交右键 + 快捷键）：「从此处交互式变基…」「修改提交信息…」（`F2`）「丢弃提交…」「压缩提交…」（多选连续提交）。后三个用浮层确认/单字段输入，直接调用 `interactiveRebase`。
- **Feature flag** `interactiveRebase`：开发期默认关，负责人验收后默认开（与 B1 `mergeWindow` 同法）。
- 新增文案中英双语（新分区 `locales/rebase.ts`）。

**不包含：**

- `--rebase-merges`（保留合并提交的变基）：范围内有合并提交时禁用并说明原因（IntelliJ 同样不支持在列表里编辑合并提交）。
- 「Fixup / Squash into…」（用当前未提交改动生成 `fixup!` 提交再 autosquash）：依赖提交页，放进 B3b「完整提交菜单」（待确认 3）。
- 「撤销提交」「推送直到此提交」「新建标签」「创建补丁」：B3b。
- 对其他分支（非当前分支）做交互式变基、修改起点（`--onto`）：不做。
- `exec`/`break`/`label` 等用户自定义 todo 行：不暴露。

## 待负责人确认

1. **驱动 `git rebase -i` 的机制**（设计 S3 只说「Host 生成 todo + `GIT_SEQUENCE_EDITOR` 脚本」）。推荐：
   - todo 走 stdin：`GIT_SEQUENCE_EDITOR='cat >'`（git 以 `sh -c '<editor> "$@"'` 调用，等价于把 stdin 写进 todo 文件），todo 文本经现有 executor 的 `stdin` 管道传入。不写临时文件、不拼路径，只有一个固定字符串进 shell。
   - 改写的提交信息先 `git hash-object -w --stdin` 存成 blob，todo 里在对应 `pick` / `fixup` 组之后加一行 `exec git cat-file blob <blob> | git commit --amend --no-verify --allow-empty -F -`。进 shell 的只有十六进制 sha，没有用户文本，无注入面；作者与作者时间保留。
   - `GIT_EDITOR` 维持现有的 `true`（squash 不会打开编辑器）。
   - T1 实测：macOS Seatbelt confine 下可用、`edit`/冲突停下后 `--continue` 仍执行后续 `exec`、git 版本下限（`--update-refs` 需 ≥2.38，作为可选项）。Windows 无法在本机实测，记为 B4 跨平台验证项。
   - 备选：Host 用 `node:fs` 把 todo 与信息写进 `<gitDir>/dsh-git/` 再让编辑器 `cp`——要在 confine 之外写仓库、还要处理路径引号，不推荐。
2. **已推送提交**：范围内有已推送到任一远程的提交时**不禁止**，显示「这会改写已推送的历史」警告并要求勾选风险确认（与 Amend 的处理一致，§8.2.4）。推荐同意。
3. **范围裁剪**：「Fixup / Squash into…」放到 B3b（见「不包含」）。推荐同意。
4. **快捷动作也走变基**：「修改提交信息」对 HEAD 也走 `interactiveRebase`（单条 reword），不复用 A2 的 `amendMessage`（后者要求索引干净、语义不同）。好处是一条代码路径、行为一致。推荐同意。
5. **执行方式**：推荐 subagent 驱动——T1 契约冻结后 T2/T3（Host）与 T4（Client 模型）互不依赖可并行；改写历史的操作出错代价高，逐任务独立评审值得。

## 验收标准

- [x] AC1：`rebasePlan` 列出的提交与 `git rev-list --reverse --first-parent <base>..HEAD` 一致（`base` 为空时到根），每条带完整信息与 `pushed`；范围内有合并提交、`base` 不是 HEAD 的祖先、detached HEAD、超过 500 条时返回对应 `blocked` 原因且不列提交（真实仓库测试）。
- [x] AC2：pick / reword / edit / squash / fixup / drop 与重排的任意组合执行后，结果历史与等价的手工 `git rebase -i` 一致：提交顺序、树、信息、作者与作者时间（真实仓库测试，至少覆盖：单条 reword、HEAD reword、drop 中间提交、两次重排、squash 链改信息、fixup 链保留首条信息、全部 drop 以外的边界）。
- [x] AC3：提交信息含引号、`$()`、反引号、换行、中文、`#` 开头的行时原样写入，不经 shell 解释、不被当注释删掉（Host 单测）。
- [x] AC4：条目不是计划提交的排列（多出、缺少、重复）、第一条有效条目是 squash/fixup、reword 缺信息、`base` 以 `-` 开头时返回 `git/invalid-payload`；打开列表后 HEAD 变了返回 `git/stale-target`；有进行中操作返回 `git/operation-in-progress`（Host 单测）。
- [x] AC5：工作区有改动时走现有智能贮藏询问，变基完成后自动恢复；中途停下时贮藏保留为待恢复，`continue` 到结束或 `abort` 后恢复（真实仓库测试）。
- [x] AC6：冲突停下 → 横幅显示「变基 3/7 · 冲突」并可打开冲突列表；`edit` 停下 → 横幅显示「已停在 abc1234，可修改后继续」，提交页 Amend 可用；`exec` 失败（如写回信息失败）→ 横幅说明并给出控制台入口；三种情况 `继续`/`跳过`/`中止` 都可用（Host 单测 + 组件测试）。
- [x] AC7：覆盖页可用鼠标拖拽与 `Alt+↑/↓` 调整顺序，`p`/`r`/`e`/`s`/`f`/`d` 切换当前行动作；squash 组的信息默认是组内各条信息拼接（fixup 的不计入）；预览显示将执行的 todo（与 Host 生成的一致）；不合法状态（第一条是 squash/fixup、reword 信息为空）时主按钮禁用并说明原因（模型单测 + 组件测试）。
- [x] AC8：日志右键「从此处交互式变基…」「修改提交信息…」「丢弃提交…」「压缩提交…」按设计出现与禁用：不在当前分支祖先链上、合并提交、只读模式、有进行中操作、flag 关闭时禁用或隐藏并给出原因；「压缩提交」只在选中多于一个且在 first-parent 链上连续时可用；`F2` 打开修改提交信息（组件测试）。
- [x] AC9：flag 关闭时上述入口全部不出现，已有功能不变；`localStorage` `dsh-git.feature.interactiveRebase` = `'1'`/`'0'` 覆盖默认值（单测）。
- [x] AC10：实机 L4：在真实仓库完成一次「重排 + reword + squash + drop」与一次「edit 停下 → 修改 → 继续」，截图放 `.evidence/b3a/`；`make check` 绿，产物 smoke 通过并记录 `lib/client.js` 体积增量；新增文案中英键集一致。

## 契约（T1 冻结）

新增读端点 `rebasePlan`、写端点 `interactiveRebase`（进 `WRITE_ENDPOINTS`）；`OperationStateValue` 增加一个可选字段。类型写在 `src/shared/protocol.ts`。

| 端点 | 请求 | 响应 |
|---|---|---|
| `rebasePlan` | `RebasePlanRequest { base: string \| null /* null = 从根开始（--root） */ }` | `RebasePlanValue` |
| `interactiveRebase` | `InteractiveRebaseRequest extends SmartWriteRequest { base: string \| null; head: string /* 打开列表时的 HEAD sha */; entries: RebaseEntry[]; updateRefs?: boolean }` | `InteractiveRebaseValue` |

```ts
// 形状约定（字段名冻结，注释写进 protocol.ts）
type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop'
interface RebasePlanCommit extends CommitSummary { message: string /* 完整信息 */; pushed: boolean; branches: string[] /* 指向它的其他本地分支，--update-refs 用（T1 追加） */ }
type RebaseBlockedReason = 'merge-commit' | 'not-ancestor' | 'detached' | 'too-many' | 'empty'
interface RebasePlanValue { base: string | null /* 解析后的 sha */; head: string; branch: string; commits: RebasePlanCommit[] /* 旧 → 新 */; blocked?: RebaseBlockedReason; supportsUpdateRefs: boolean; version?: number }
interface RebaseEntry { sha: string; action: RebaseAction; message?: string /* reword 必填；squash 组的首条可带，作为整组最终信息 */ }
interface InteractiveRebaseValue extends SmartStashOutcome { head: string; completed: boolean; stop?: RebaseStop; version?: number }
type RebaseStop = 'conflict' | 'edit' | 'exec-failed'
// OperationStateValue 增加：rebaseStop?: RebaseStop（仅 operation === 'rebase'）
```

Host 约束（各任务共用）：

- `base` 先经 `resolveRevision`（[ADR 0010](../../decisions/0010-修订号先解析为sha.md)）；`entries[].sha` 必须精确等于计划中的 sha（不接受缩写），否则 `git/invalid-payload`。
- 是否已推送：`for-each-ref refs/remotes` 的 tip 集合上 `rev-list` 求可达性，一次命令完成，不逐提交查询。
- 提交上限 500（`REBASE_PLAN_MAX_COMMITS`），超过返回 `blocked: 'too-many'`。
- todo 由纯函数生成（便于单测与客户端预览共用同一规则），写端点里不再拼接字符串。
- 停下原因判定读 `rebase-merge/`（T1 实测定稿，[git-behavior §4](../../references/git-behavior.md)）：索引有 unmerged 条目 → `conflict`；`done` 末行以 `edit ` 开头且有 `amend` 文件 → `edit`；`done` 末行以 `exec ` 开头 → `exec-failed`。**是否完成不能看退出码**（`edit` 停下时退出 0），一律看 `rebase-merge/` 是否还在。
- `--update-refs`：`cat >` 覆盖了 git 生成的 todo，`update-ref` 行必须由 `buildTodo` 写出——每个被计划提交上的 `branches[i]` 在该提交所在组（含其后的 squash/fixup 与 `exec` 写回行）结束后写一行 `update-ref refs/heads/<b>`；提交被 drop 时仍写在原位置（分支落到此时的 HEAD）。不勾选 `updateRefs` 时不写。
- 条目全部为 `drop` 时照常执行（todo 只有 drop 行可行）；不会出现空 todo（`entries` 非空）。

## 任务

<!-- 状态：待开始 / 进行中 / 完成 / 阻塞 -->

### T1：契约冻结 + 机制 spike（完成）

- **目标**：冻结上面的类型；用实测回答待确认 1 的问题，结论写进 [git-behavior](../../references/git-behavior.md)（注明日期、git 版本）与本计划「意外与发现」。
- **涉及文件**：`src/shared/protocol.ts`、`src/host/rpc.ts`（两个端点先返回 `not implemented`）、`src/client/git-client.ts`（两个方法）、`src/client/features.ts`（`interactiveRebase`，默认 `false`）、`src/client/pages/workbench-overlay.ts`（新覆盖层 `{ kind: 'interactiveRebase'; base: string | null; preset?: RebasePreset }`，`RebasePreset` 见 T4）。
- **spike 问题**（在临时仓库用脚本跑，脚本放 scratchpad，不进仓库）：(a) `GIT_SEQUENCE_EDITOR='cat >'` + stdin 能写入 todo，且在 `sandbox.confine` 下可用（经插件 Host 实测一次）；(b) `exec git cat-file blob … | git commit --amend --no-verify --allow-empty -F -` 保留作者与作者时间，信息含 AC3 中的字符时原样；(c) 冲突/`edit` 停下后 `rebase --continue` 继续执行后续 `exec`；(d) 三种停下状态下 `rebase-merge/` 的文件，用于判定 `rebaseStop`；(e) `--update-refs` 在当前 git 下的行为。
- **测试**：协议层新端点存在、`interactiveRebase` 在 `WRITE_ENDPOINTS`、`rebasePlan` 不在；`git-client` 两个方法的 URL 与请求体断言；路由返回 `not implemented`；flag 默认值与 localStorage 覆盖。
- **完成标准**：类型冻结；spike 五问有实测结论；若 (a)/(b) 不成立，按 SOP §6.3 停下问人；`make check` 绿。

### T2：Host `rebasePlan`（完成）

- **目标**：实现计划端点。
- **涉及文件**：新建 `src/host/git/rebase-plan.ts`、`test/host/git/rebase-plan.test.ts`；修改 `src/host/rpc.ts`；从 `log.ts` 复用提交格式解析（不改其行为）。
- **接口**：`readRebasePlan(run: GitRunner, cwd: string, request: RebasePlanRequest, options: { signal?; gitVersion? }): Promise<RebasePlanValue>`（与 B2 读端点同形；T2 落地时改）；`supportsUpdateRefs(version)`。
- **测试**（真实临时仓库）：线性分支 5 个提交 → 顺序与信息正确；`base: null` 包含根提交；部分提交已推送到本地 bare 远程 → `pushed` 正确；范围内有合并提交、`base` 在另一分支、detached HEAD、501 个提交 → 对应 `blocked`；`base` 以 `-` 开头 → `git/invalid-payload`。
- **完成标准**：AC1 有测试；`make check` 绿。

### T3：Host `interactiveRebase` 与停下状态（完成）

- **目标**：实现写端点与 `operationState.rebaseStop`。
- **涉及文件**：新建 `src/host/git/rebase-todo.ts`（纯函数）、`src/host/git/interactive-rebase.ts` 与对应测试；修改 `src/host/git/operation.ts`（`rebaseStop`）、`src/host/rpc.ts`。
- **接口**：
  - `validateEntries(plan: { commits: { sha: string }[] }, entries: RebaseEntry[]): RebaseEntry[]`（不合法时抛 `invalidPayload`，原因见 AC4）；
  - `buildTodo(entries: RebaseEntry[], blobs: ReadonlyMap<number, string> /* 条目下标 → 信息 blob sha */): string`；
  - `interactiveRebaseOperation: WriteOperation<InteractiveRebaseRequest, Omit<InteractiveRebaseValue, 'version'>>`，沿用 `integrate.ts` 中 `rebaseOperation` 的写法与 `withSmartStash`；HEAD 与 `request.head` 不同 → `git/stale-target`；`updateRefs` 只在 `supportsUpdateRefs` 时加 `--update-refs`。
- **测试**：`buildTodo` 各动作与组合的快照（含 squash 组带信息时 `exec` 行位置）；`validateEntries` 的 AC4 各情形；真实仓库跑 AC2 列出的组合并与手工 `rebase -i` 的结果逐项比较（树 sha、信息、作者、作者时间）；AC3 字符集；冲突停下 / `edit` 停下 / `exec` 失败三种 `stop` 与 `operationState.rebaseStop`；AC5 的智能贮藏路径；HEAD 变化与进行中操作的拒绝。
- **完成标准**：AC2–AC5、AC6 的 Host 部分有测试；`make check` 绿。

### T4：Client 变基列表模型与 store（完成）

- **目标**：React 无关的列表模型（纯函数）与加载/提交 store。
- **涉及文件**：新建 `src/client/rebase/rebase-model.ts`、`src/client/store/rebase-store.ts` 与测试；`.dependency-cruiser.cjs` 若需允许 `store → rebase`，同步改 ARCHITECTURE。
- **接口**：
  - 模型：`RebaseRow { sha; action; message; originalMessage }`；`fromPlan(plan, preset?)`、`setAction(rows, index, action)`、`move(rows, from, to)`、`setMessage(rows, index, text)`、`groups(rows)`（squash/fixup 归组）、`defaultSquashMessage(group)`、`validate(rows): LocalizedText | null`、`toEntries(rows): RebaseEntry[]`、`previewTodo(rows): string`（与 Host `buildTodo` 同规则，`exec` 行用占位 `<message>` 表示）。
  - `RebasePreset = { kind: 'reword'; sha: string } | { kind: 'drop'; sha: string } | { kind: 'squash'; shas: string[] }`：快捷动作用同一模型生成条目。
  - store：`createRebaseStore(deps: { client: GitClient; sessionId: string })`：`open(base, preset?)`、`update(fn)`、`submit(options: { updateRefs: boolean; confirmPushed: boolean })`、`dispose()`；状态 `{ plan, rows, loading, error, submitting, invalidReason }`；提交经现有 `action-store`（智能贮藏询问与错误码映射）。
- **测试**：动作切换、移动、squash 组默认信息（fixup 不计入）、`validate` 各不合法情形、`previewTodo` 与 Host `buildTodo` 对同一输入的结构一致（用共享夹具）、preset 三种生成的条目；store 旧响应丢弃、`dispose` 中止、提交中重复点击只发一次。
- **完成标准**：AC7 的模型部分有测试；`make check` 绿。

### T5：`InteractiveRebasePage` 覆盖页（完成）

- **目标**：全高覆盖页 UI。
- **涉及文件**：新建 `src/client/pages/InteractiveRebasePage.tsx`、`InteractiveRebasePage.module.css`、`src/client/locales/rebase.ts`；修改 `GitWorkbench.tsx`（承载覆盖层）、`src/client/locales.ts`。
- **要点**：每行显示动作选择、短哈希、主题、作者、已推送标记；拖拽排序（原生 HTML5 DnD，不引入依赖）与 `Alt+↑/↓`；`p/r/e/s/f/d` 切换动作；reword 与 squash 组首行展开多行信息编辑；底部「预览」切换显示 todo；有已推送提交时显示警告与风险确认勾选；`supportsUpdateRefs` 时显示「同时更新指向这些提交的分支（--update-refs）」；主按钮「开始变基」，不合法时禁用并显示原因；`blocked` 时整页显示原因与终端命令；提交多时用 `@tanstack/react-virtual`（>200 行）。样式只用 DSH 已有变量（`test/client/pages/css-tokens.test.ts` 把新文件加入 `GUARDED`）。
- **测试**：组件测试覆盖 AC7 的交互；`blocked` 各原因文案；已推送风险确认未勾选时主按钮禁用；Esc 返回且焦点回到触发控件。
- **完成标准**：AC7 有测试；`make check` 绿。

### T6：入口、快捷动作与停下横幅（完成）

- **目标**：接上日志右键、`F2`、浮层确认与操作横幅。
- **涉及文件**：修改 `src/client/pages/commit-actions.ts`（新动作 `interactiveRebaseFrom`/`reword`/`drop`/`squashSelected` 与可用性矩阵）、`CommitContextMenu.tsx`、`LogTable.tsx`（`F2`）、`OperationBanner.tsx` 与 `operation-actions.ts`（`rebaseStop` 文案）、`CommitPanel`/`commit-store`（`edit` 停下时 Amend 可用）；新建 `src/client/pages/RebaseQuickSheet.tsx`（reword 的单字段多行输入、drop/squash 的确认，squash 带合并后信息编辑）。
- **要点**：可用性需要知道提交是否在 HEAD 的 first-parent 链上——由日志已加载数据判断（从 HEAD 沿 `parents[0]` 走），链未完全加载时「从此处交互式变基」仍可用（由 `rebasePlan` 最终判定），其余快捷动作同理；所有入口在 flag 关闭时不出现。
- **测试**：AC8 的可用性矩阵（纯函数单测）；`F2` 打开 reword；快捷动作提交的 `entries` 正确；AC6 横幅三种文案与按钮；AC9 flag 关闭时菜单无新项。
- **完成标准**：AC6、AC8、AC9 有测试；`make check` 绿。

### T7：自验证与文档（完成）

- **目标**：L4 实机走查与收尾文档。
- **涉及文件**：`docs/runbooks/verification.md`（B3a 走查步骤）、`docs/references/git-behavior.md`、`docs/ARCHITECTURE.md`、`docs/quality/QUALITY.md`、本计划「验证记录」。
- **要点**：按 runbook 用 `dev.patch.yml` 挂载，临时打开 flag，完成 AC10 的两条流程并截图；记录体积增量。
- **完成标准**：AC10 有证据；`make check` 绿。

## 进度

- 2026-10-27 — T1 — spike 五问实测通过（Seatbelt 等价复现），契约冻结：`rebasePlan`/`interactiveRebase` 登记、`interactiveRebase` 的 payload 校验、客户端两个方法、`interactiveRebase` flag（默认关）、覆盖层 `interactiveRebase`、`RebasePreset` 类型

## 下一步

- 整分支评审（`git merge-base main HEAD`..HEAD），按评审结果修复；之后等负责人统一验收（负责人授权：B3a 后接着做 B3b–B3d）。

## 决策记录

- 2026-10-27 — B3 拆成 4 份计划，交互式变基先做（负责人选定）：B3a 交互式变基；B3b Diff 增强（并排/词级/忽略空白/折叠）+ 完整提交菜单 + Patch；B3c Shelf + Changelist；B3d Worktree + Remotes + 标签/远程分支/upstream 补齐。
- 2026-10-27 — T1：`RebasePlanCommit` 增加 `branches`（指向该提交的其他本地分支）——spike 发现 `--update-refs` 只认 todo 里的 `update-ref` 行，而 `cat >` 会覆盖 git 生成的那几行，Host 必须自己写；错了的代价：多一个字段。
- 2026-10-27 — T1：`rebasePlan` 在 T1 先校验 `base` 形状再返回 `not implemented`、`interactiveRebase` 在 T1 就实现 `parse`——现有路由测试要求「已登记端点对最小载荷不得回答 not implemented」，形状校验本来也是这两个端点的一部分，不另开例外。
- 2026-10-27 — T2：`readRebasePlan` 签名改为与 B2 读端点一致的 `(run, cwd, request, { signal, gitVersion })`（计划写的是 `(ctx, request, signal)`）；git 版本取 runtime 已有的一次性探测。
- 2026-10-27 — T3：todo 规则（`rebaseTodoProblem`、`buildTodo`）放在 `src/shared/rebase-todo.ts`，而不是计划写的 `src/host/git/rebase-todo.ts`——Host 执行与客户端预览共用同一份纯函数，AC7「预览与 Host 生成的一致」由构造保证，不再靠共享夹具；它只依赖协议类型，符合 R3；错了的代价：挪一个文件。
- 2026-10-27 — T3：校验规则比计划多一条 `misplaced-message`：`message` 只允许出现在 pick/reword 上（edit 停下后用户自己改信息，若再 exec 会覆盖；squash/fixup/drop 上的信息没有意义）。
- 2026-10-27 — T3：有整组信息的 squash 组里，squash 行写成 `fixup`（信息最终由 exec 写回，避免 git 拼接一遍再被覆盖）；没有整组信息时保留 `squash`，由 `GIT_EDITOR=true` 接受 git 拼接的默认信息。
- 2026-10-27 — T3：执行层新增 `todoFromStdin` 选项与 `GIT_TODO_STDIN_ENV`（只把 `GIT_SEQUENCE_EDITOR` 改成 `cat >`）——现有 `GIT_WRITE_ENV` 的 `GIT_SEQUENCE_EDITOR=true` 优先于 `-c sequence.editor`；只对带 stdin 的写调用生效，其余写命令仍是 no-op 编辑器。这是对计划外公共接口（执行层选项）的最小扩展，属于实现细节。
- 2026-10-27 — T4：`createRebaseStore` 的依赖写成 `{ sessionId, load, actions }`（与 B2 store 同形，便于测试），而不是计划的 `{ client, sessionId }`；行带 `originalIndex` 判断是否移动；`rewritesPushed(rows)` 从「第一条被改写的行（含被 squash/fixup 合入的组首）」起算，之后的提交都会被改写；`validate` 在协议问题之外多两条：`unchanged`（没有改动）与 `confirmPushed`；有整组信息之外的 pick 行编辑信息不算改动。
- 2026-10-27 — T5：不做虚拟滚动——计划写「>200 行用 `@tanstack/react-virtual`」，但 `rebasePlan` 上限 500 行、每行一个原生 `<select>`，静态渲染足够；错了的代价：长列表首屏稍慢，可后续加。
- 2026-10-27 — T5：组件先写、测试后补（偏离 TDD）：视图是静态渲染，测试覆盖了 AC7 的可见行为与纯函数（键盘判定、信息编辑目标、预览替换、完成后接线）；记在这里以便评审时重点看。
- 2026-10-27 — T6：快捷动作（修改提交信息 / 丢弃 / 压缩）不另做 `RebaseQuickSheet`，而是以 preset 打开同一个变基页并选中对应行——信息编辑、已推送确认、预览、阻塞说明都只有一份实现；代价是快捷动作多一步「开始变基」，且界面比浮层重。AC8 的可用性要求不受影响。
- 2026-10-27 — T6：`StatusValue` 增加 `rebaseStop`（与 `operationState.rebaseStop` 同一读取函数）——横幅与提交页读的是 status，不是 operationState；属于协议的可选字段追加。
- 2026-10-27 — T6：`edit` 停下时提交页回到普通模式，Host 的 `commitFiles`/`amendMessage` 用 `assertNoOperationUnlessEditStop` 放行（其他停下原因仍是 `git/operation-in-progress`）；这是 A2 写端点行为的有意放宽，只限于 `rebase-merge` 且停在 `edit`。
- 2026-10-27 — T6：可用性按已加载日志沿 HEAD 的 first-parent 链判断；链走出已加载页时视为「可能」，由 `rebasePlan` 最终裁定（计划原意）。
- 2026-10-27 — T1：`RebasePreset` 类型提前在 `src/client/rebase/rebase-model.ts` 定义（覆盖层类型要用）；T4 在同一文件补函数。
- 2026-10-27 — 横幅步数沿用 git 的 `msgnum/end`，包含 `exec`/`update-ref` 行（会比提交数多）；不自行换算，避免和终端里看到的 git 输出不一致。
- 2026-10-27 — 写回信息的 `exec` 用 `--no-verify`：`git rebase -i` 自身 pick 时不跑 pre-commit，改信息时再跑 pre-commit 会在历史提交上触发与当前工作区无关的检查。

## 意外与发现

- 2026-10-27 T1 spike（详见 [git-behavior §4](../../references/git-behavior.md)）：`edit` 停下时 `git rebase -i` 退出 0；`--update-refs` 依赖 todo 中的 `update-ref` 行（我们的 todo 覆盖了 git 生成的）；`exec` 失败后 `--continue` 不重跑该行（`no-reschedule-failed-exec`），所以写回信息失败后继续会丢掉这次改的信息——横幅文案要说明「继续将保留原信息」；空 todo 报 `nothing to do`。
- `make setup` 在新 worktree 里因 pnpm 的 `ERR_PNPM_IGNORED_BUILDS`（esbuild 构建脚本未批准）退出 1，但依赖已装好、`pnpm build` 正常（esbuild 用平台包的预编译二进制）；与本计划无关，不处理。

## 阻塞

- 无

## 验证记录

- L1：每个任务结束 `make check` 全绿（日志在 `.superpowers/sdd/b3a-交互式变基/t*-check.log`）。
- L2（真实临时仓库）：AC1 `test/host/rebase-plan.test.ts`；AC2/AC3/AC4/AC5/AC6（Host）`test/host/interactive-rebase.test.ts`；`test/shared/rebase-todo.test.ts`；`test/host/git-executor.test.ts` todoFromStdin。
- 组件/模型：AC6（横幅、提交页模式）`operation-banner.test.tsx`、`commit-store.test.ts`；AC7 `rebase-model.test.ts`、`rebase-store.test.ts`、`interactive-rebase-page.test.tsx`；AC8/AC9 `commit-actions.test.ts`、`log-store.test.ts`、`log-page.test.tsx`、`features.test.ts`。
- 机制 spike：`.evidence/b3a/spike.sh`、`spike.mjs`、`spike.log`（Seatbelt 等价复现）。
- L4（2026-10-27，隔离 DSH 3081，临时 HOME，flag 置 1）：
  - 流程 1「重排 + reword + squash + drop + --update-refs」：右键菜单 `01-log-menu.jpg`、覆盖页 `02-rebase-page.jpg`、编辑后与预览 `03-edited-preview.jpg`、结果日志 `03b-after-rebase.jpg`；`git log` 核对：c2 信息原样（含 `"` 与 `$(echo x)`）、c4+c3 合并信息为两条拼接、c5 已丢弃、`mid` 随 `--update-refs` 移到合并后的提交。
  - 流程 2「F2 → 改为 edit → 停下 → Amend → 继续」：横幅 `04-edit-stop-banner.jpg`（「正在变基 1/2」「已在 edit 处停下…」），提交页为普通模式且可 Amend，Amend 后 `rebase-merge` 仍在，「继续」后变基结束，被 edit 的提交包含改动。
  - 走查发现并修复：打开覆盖页后焦点在对话框根上，字母键与方向键要先点一下列表才生效——改为加载后聚焦列表（reword 预设聚焦信息框），实机复验 F2 后焦点在信息框。
  - 走查发现、未修（登记 TODO）：变基改写历史后，日志详情区仍显示改写前选中的旧提交（A1 的既有行为）；列表里分支名标签与背景对比弱。
- 体积：`lib/client.js` 1089.4 KB → 1126 KB（+约 37 KB，含 css +3.6 KB）。
- 未验证：Windows（Git for Windows sh 下的 `cat >` 与 exec 管道）——B4 跨平台。
