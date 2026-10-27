# b2-历史与Blame：文件历史、Blame 视图、比较模式与文档头部动作

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、契约与验收，不写完整实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 执行中 |
| 里程碑 | B2：历史与 Blame |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §5.2–5.3（覆盖层）、§6.2（日志/分支/Diff 的 P1 行）、§8.1.5 第 10 条（变更文件右键）、§8.1.7（与此提交比较）、§8.3.4（与当前分支/工作区比较）、§9.6、§9.7、§14.2（多选比较）；[设计决策 v0.2](../../design/2026-10-25-产品设计决策-v0.2.md) §3.3–3.5、§4（B2 行） |
| 分支 | `b2-history-blame`（独立 worktree） |
| 批准记录 | 2026-10-27 负责人批准计划：待确认 1–5 按推荐执行，执行方式内联（当前会话，executing-plans），收尾做一次整分支评审 |

## 目标

用户能在 Git tab 里看一个文件的完整历史（跨重命名）、逐行段的 Blame（谁在哪个提交改了这几行，点一下看那个提交），比较两个分支/提交（「A 中有而 B 中没有的提交」+ 差异文件），以及把任意分支/提交和工作区比较。打开 DSH 文档预览时，头部的「Blame / 历史 / Diff」三个动作都可用，状态徽标点击可跳到提交页。

## 范围

**包含：**

- **Host 读端点**（全部只读，不经写队列与写门禁）：`blame`、`fileHistory`、`compare`；`diff` 增加 `scope: 'range'`（两个修订之间、或修订与工作区之间的单文件 diff）。
- **Client store**（React 无关）：`blame-store`、`file-history-store`、`compare-store`；`git-client` 新方法。
- **页面**：`BlameView`（Git tab 覆盖层 + `git.blame` 页两处承载，见待确认 1）、`FileHistoryPage`、`ComparePage`；覆盖层可带 `back`，「← 返回」回到来源覆盖层。
- **入口**：提交详情变更文件右键（新增菜单）、提交页变更树右键（追加项）、日志提交右键「与工作区比较」与多选两个提交时「比较」、分支/标签右键「与当前分支比较」「与工作区比较」、文档预览头部「历史」「Diff」与状态徽标点击、Blame 行段右键。
- **跨 tab 意图**：文档头部与 `git.blame` 页要让 Git tab 打开某个覆盖层/在日志中定位提交，经同一 bundle 内的按会话意图队列传递（Git tab 未挂载时先排队）。
- 全部新增文案中英双语（新分区 `locales/history.ts`），替换 M0 的 `blame.*` 占位文案。

**不包含：**

- 可选的「Git Blame 渲染器」（`documentPreviews.register`）：设计要求默认关、靠设置开启，移到 B4 与设置页一起做（待确认 3）。
- 逐行历史 `-L` / 选区历史（设计 §9.6 明确不做）、「Blame 上一版本」（IntelliJ 的 Annotate Previous Revision）。
- 词级高亮、并排 diff（B3）；三方比较。
- 文件树行状态色（宿主无 slot）。
- Feature flag：B2 全部是只读视图，不加 flag（与 B1 不同，B1 有写回）。

## 待负责人确认

1. **Blame 的承载位置**。设计 §5.2 把 Blame 列为 Git tab 覆盖层，§9.7/决策 §3.3 又写成独立页 `git.blame`（M0 已注册空页）。**推荐两处承载同一个 `BlameView` 组件**：从 Git tab 内进入（提交详情、文件历史、变更树）时作为覆盖层，「← 返回」回到来源；从文档预览头部进入时打开 `git.blame` 页（与设计 §3.3 一致）。`git.blame` 页内点行段在页内显示提交详情、双击看该提交对该文件的 diff，「在日志中显示」切到 Git tab 定位。备选：全部改成 Git tab 覆盖层、`git.blame` 退役——需要改已批准的设计，不推荐。
2. **Blame 的版本**。推荐：从文档头部、变更树进入时 blame 工作区内容（未提交行显示「未提交」）；从提交详情、文件历史进入时 blame 该提交的版本（顶部显示 `@ 7f3a2c1`）。
3. **「Git Blame 渲染器」移到 B4**（见「不包含」），与设置项「使用 Git Blame 渲染器作为默认代码视图」（默认关）一起做。推荐同意。
4. **比较模式的范围**。推荐：分支/标签「与当前分支比较」「与工作区比较」；日志提交「与工作区比较」；日志恰好选中两个提交时「比较」（多于两个时禁用并说明原因）。比较页提交列表 = `right..left`（左边有而右边没有），可「交换」；差异文件 = `right...left`（以合并基为起点，即左边自分叉以来的改动）；与工作区比较时只有差异文件（`<left>` 对工作区），没有提交列表。点差异文件在比较页内分栏显示 diff，不另开覆盖层。
5. **执行方式**：推荐 subagent 驱动（与 B1 一致）。T1 先做并冻结契约；之后 T2、T3（Host）与 T4（Client store）可并行；T5 → T6 → T7 串行。

## 验收标准

- [ ] AC1：Blame 行段与 `git blame --line-porcelain -- <path>`（或 `<rev> -- <path>`）逐行一致：每段的提交、起止行号正确，同一提交的连续行合成一段；未提交行显示「未提交」；浅克隆边界提交带边界标记（真实仓库测试）。
- [ ] AC2：大于 2000 行的文件分页，「加载更多」后行号连续、不重不漏；顶部显示总行数；二进制文件显示「二进制文件，无法逐行注解」；超过 8 MiB 显示「文件过大」+ 可复制的终端命令（Host 单测 + 组件测试）。
- [ ] AC3：Blame 行段 hover 显示提交主题、作者、时间、「复制哈希」「在日志中显示」；单击显示该提交详情；双击显示该提交对该文件的 diff；行段右键有「复制哈希」「在日志中显示」「文件历史」（组件测试 + 实机截图）。
- [ ] AC4：文件历史只列改过该文件的提交，跨重命名（`--follow`）继续；每行显示主题、作者、日期、该文件状态（M/A/D/R）与增删行数；选中一行在页内显示该提交对该文件的 diff，重命名前的提交按当时的路径取 diff；跨过重命名时显示「历史可能不连续」；分页加载（真实仓库测试 + 组件测试）。
- [ ] AC5：文件历史行动作「Blame（此版本）」「与工作区比较」「在日志中显示」「复制路径」可用；从文件历史打开 Blame 后「← 返回」回到文件历史且选中与滚动恢复（组件测试）。
- [ ] AC6：比较两个分支时提交列表等于 `git log right..left`，差异文件等于 `git diff --name-status right...left`；「交换」后两者对应互换；点差异文件显示该文件的合并基 diff（真实仓库测试 + 组件测试）。
- [ ] AC7：「与工作区比较」（分支、标签、提交）只显示差异文件，等于 `git diff --name-status <rev>`；点文件显示 `<rev>` 对工作区的 diff（真实仓库测试）。
- [ ] AC8：日志选中两个提交时右键/详情出现「比较」；选中一个或多于两个时「比较」不可用并说明原因（组件测试）。
- [ ] AC9：文档预览头部「Blame」打开 `git.blame` 页并显示该文件的工作区 Blame；对另一个文件再点「Blame」时页面切到新文件（不会停在旧文件）；「历史」「Diff」切到 Git tab 并打开该文件的文件历史/工作区 diff（Git tab 未打开过时也生效）；状态徽标点击切到提交页并选中该文件；文件不在仓库内时三个动作不可用并说明原因（组件测试 + 实机截图）。
- [ ] AC10：路径或修订号含空格、中文、或以 `-` 开头时，Host 不把它当作 git 选项：合法路径正常返回，以 `-` 开头的修订号返回 `git/invalid-payload`；路径含 `..` 或为绝对路径时拒绝（Host 单测）。
- [ ] AC11：加载中切换文件/修订、或仓库 version 变化时，旧响应被丢弃，不出现旧文件内容闪回；关闭覆盖层时中止未完成请求（store 单测）。
- [ ] AC12：`make check` 绿；产物 smoke 通过，记录 `lib/client.js` 体积增量；新增文案中英键集一致，组件内无中文字面量（现有静态扫描覆盖）。

## 契约（T1 冻结）

新增读端点 3 个，`diff` 扩展 1 个 scope。类型写在 `src/shared/protocol.ts`，加入 `RPC_ENDPOINTS` 与 `RpcEndpointTypes`，**不进** `WRITE_ENDPOINTS`。

| 端点 | 请求 | 响应 |
|---|---|---|
| `blame` | `BlameRequest { path; rev?: string; start?: number /* 1 起，缺省 1 */; limit?: number /* 缺省与上限 2000 */ }` | `BlameValue` |
| `fileHistory` | `FileHistoryRequest { path; rev?: string /* 缺省 HEAD */; cursor?: LogCursor; limit?: number /* 同 log 缺省 50、上限 200 */ }` | `FileHistoryValue` |
| `compare` | `CompareRequest { left: string; right: string \| null /* null = 工作区 */; cursor?: LogCursor; limit?: number }` | `CompareValue` |
| `diff`（扩展） | `DiffRequest` 增加 `scope: 'range'`，配 `from: string; to: string \| null; mergeBase?: boolean` | 不变（`DiffFileValue`） |

```ts
// 形状约定（字段名冻结，注释写进 protocol.ts）
interface BlameCommit { sha; shortSha; author; email; date /* ISO 作者时间 */; subject; uncommitted: boolean; boundary: boolean; previous?: { sha: string; path: string } }
interface BlameSegment { sha: string; start: number; count: number; origPath?: string }   // start 为本页内的绝对行号
interface BlameValue {
  path: string; rev: string | null /* 解析后的完整 sha；工作区为 null */
  totalLines: number; start: number; lines: string[] /* 本页文本，不含行尾 */
  segments: BlameSegment[]; commits: Record<string, BlameCommit>
  next?: number /* 下一页起始行 */; binary: boolean; tooLarge: boolean; terminalCommand?: string; version?: number
}
interface FileHistoryEntry extends CommitSummary { path: string /* 该提交时的路径 */; origPath?: string; status: FileStatusCode; additions?: number; deletions?: number; binary?: boolean }
interface FileHistoryValue { path: string; entries: FileHistoryEntry[]; next?: LogCursor; followedRename: boolean; truncated: boolean; version?: number }
interface CompareRev { input: string; sha: string }
interface CompareValue { left: CompareRev; right: CompareRev | null; commits: CommitSummary[]; next?: LogCursor; files: FileEntry[]; filesTruncated: boolean; version?: number }
```

Host 约束（各任务共用）：

- 修订号一律先 `rev-parse --verify --end-of-options <rev>^{commit}` 解析成 sha，以 `-` 开头直接 `git/invalid-payload`；后续 git 调用只传解析后的 sha。路径校验复用 `diff` 现有规则（拒绝绝对路径与 `..`），路径一律放在 `--` 之后。
- Blame：先判二进制与大小（修订：`cat-file -s` + blob 内容；工作区：复用 `merge-file.ts` 中 lstat/realpath 守卫的只读读取，必要时把它提到共用模块），> 8 MiB 为 `tooLarge`；行数由同一份内容数出；每页用 `blame --line-porcelain -L <start>,+<limit>`，未提交行的 sha 为全 0（按仓库哈希长度）。
- 文件历史：`log --follow -M --raw --numstat -z --format=…`（与 `log.ts` 同一套提交格式与游标 `v1:<headSha>:<offset>`）；`followedRename` 在任一条目带 `origPath` 时为 true。
- 比较：提交列表复用 `log.ts` 的格式与游标；差异文件 `diff --name-status -M -z`，上限复用 `STATUS_ENTRY_LIMIT`。

## 任务

<!-- 状态：待开始 / 进行中 / 完成 / 阻塞 -->

### T1：契约冻结 + 宿主 spike（待开始）

- **目标**：冻结上面的类型与端点；用实测回答两个宿主问题，结论写进 references 与本计划「意外与发现」。
- **涉及文件**：`src/shared/protocol.ts`、`src/host/rpc.ts`（三个端点先返回 `not implemented`）、`src/client/git-client.ts`（三个方法 + `diff` 透传新字段）、`src/client/pages/workbench-overlay.ts`（新增三种覆盖层，见 T5/T6 接口）、`docs/references/dsh-integration-feasibility.md`。
- **spike 问题**：(a) `git.blame` 页已打开时再 `openTab('git.blame', { params })` 换文件，`useTabInfo().navigation.params` 是否更新为新值——若不更新，改用 `replaceTab` 指向已有页或 `openResource`，选定方案记入决策记录；(b) 文档头部 `openTab('git')` 在 Git tab 未打开/已打开两种情况下都能切过去。
- **测试**：协议层 `RPC_ENDPOINTS` 包含新端点且不在 `WRITE_ENDPOINTS`；`git-client` 新方法的 URL 与请求体断言；新端点在 Host 返回 `not implemented` 的路由测试。
- **完成标准**：类型冻结、spike 两问有实测结论（截图放 `.evidence/b2/`）；`make check` 绿。

### T2：Host `blame`（待开始）

- **目标**：实现 `blame` 端点与解析。
- **涉及文件**：新建 `src/host/git/blame.ts`、`test/host/git/blame.test.ts`；修改 `src/host/rpc.ts`；必要时把工作区只读读取从 `merge-file.ts` 提到 `src/host/git/worktree-read.ts`。
- **接口**：`readBlame(ctx, request: BlameRequest, signal): Promise<BlameValue>`；纯函数 `parseLinePorcelain(output: string): { lines: string[]; segments: BlameSegment[]; commits: Record<string, BlameCommit> }`（便于单测）。
- **测试**（真实临时仓库，沿用 `test/host/git/` 的仓库夹具）：三个提交改不同行 → 段与提交正确；工作区未提交修改 → 全 0 sha 段 `uncommitted: true`；4500 行文件分三页，拼起来与一次 `git blame` 一致；CRLF 文件、无末尾换行、空文件的行数；二进制、> 8 MiB、未跟踪文件（返回 `git/not-found` 类错误还是空 blame，按现有错误码选一并写决策记录）；`--follow` 无关；浅克隆 `boundary`；路径/修订注入（AC10）。
- **完成标准**：AC1、AC2（Host 部分）、AC10 的 blame 部分有测试；`make check` 绿。

### T3：Host `fileHistory`、`compare` 与 `diff` range（待开始）

- **目标**：实现文件历史、比较与范围 diff。
- **涉及文件**：新建 `src/host/git/file-history.ts`、`src/host/git/compare.ts` 及对应测试；修改 `src/host/git/diff.ts`（`parseScope` 接受 `range`，`rangeArgs` 生成 `[from]` / `[from, to]` / `--merge-base from to`）、`src/host/rpc.ts`；从 `log.ts` 导出共用的提交格式解析与游标工具（不改其行为）。
- **接口**：`readFileHistory(ctx, request, signal): Promise<FileHistoryValue>`、`readCompare(ctx, request, signal): Promise<CompareValue>`。
- **测试**：重命名后再修改的文件，历史两段都在、旧条目 `path` 为旧名、`followedRename` 为 true，用旧条目的 `path` 调 `diff scope=commit` 成功；分页游标与 `log` 一致；比较两个分叉分支的提交列表与 `git log right..left` 一致、文件与 `right...left` 一致；`right: null` 时 `commits` 为空、文件等于 `git diff --name-status <left>`；`diff scope=range` 三种形态；不存在的修订、以 `-` 开头的修订（AC10）。
- **完成标准**：AC4/AC6/AC7 的 Host 部分有测试；`make check` 绿。

### T4：Client store（待开始）

- **目标**：三个 React 无关的 store，负责加载、分页、选择、丢弃过期响应与中止。
- **涉及文件**：新建 `src/client/store/{blame-store,file-history-store,compare-store}.ts` 与测试；新建 `src/client/workbench-intents.ts`（按会话的意图队列）与测试。
- **接口**：
  - `createBlameStore(deps: { client: GitClient; sessionId: string })`：`open(path, rev?)`、`loadMore()`、`select(sha | null)`、`dispose()`；状态 `{ target, value, rows: BlameRow[], loading, error, selectedSha }`，`BlameRow` 为渲染用的行（行号、文本、所属段、是否段首）。
  - `createFileHistoryStore(deps)`：`open(path, rev?)`、`loadMore()`、`select(sha)`；选中后经现有 `diff-store` 取 `scope: 'commit'` + 该条目 `path` 的 diff。
  - `createCompareStore(deps)`：`open(left, right)`、`swap()`、`loadMore()`、`selectFile(path)`；文件 diff 用 `scope: 'range'`（分支比较 `mergeBase: true`，工作区比较 `to: null`）。
  - `workbench-intents.ts`：`type WorkbenchIntent = { kind: 'fileHistory'; path: string } | { kind: 'worktreeDiff'; path: string } | { kind: 'selectChange'; path: string } | { kind: 'showCommit'; sha: string }`；`postIntent(sessionId, intent)`、`subscribeIntents(sessionId, listener): () => void`（订阅时先交付已排队的意图，再清空）。
- **测试**：分页拼接行号连续；`open` 换目标后旧响应到达被丢弃（AC11）；version 回退的响应被丢弃；`dispose` 中止请求；`swap` 交换后重新加载；意图在订阅前投递也能收到且只交付一次。
- **完成标准**：AC11 有测试；`make check` 绿。

### T5：`BlameView`（覆盖层 + `git.blame` 页）（待开始）

- **目标**：Blame 视图组件及其两处承载。
- **涉及文件**：新建 `src/client/pages/BlameView.tsx`、`BlameView.module.css`、`src/client/pages/BlameHoverCard.tsx`；改写 `src/client/blame-page.tsx`（M0 空页 → 承载 `BlameView` + 页内提交详情/diff）；修改 `src/client/pages/workbench-overlay.ts`、`GitWorkbench.tsx`；新建 `src/client/locales/history.ts`，删除 `locales/document.ts` 中的 M0 `blame.*` 键。
- **接口**：覆盖层 `{ kind: 'blame'; path: string; rev?: string; back?: WorkbenchOverlay }`（Level 1）。`BlameView` props：`store`、`onShowCommit(sha)`、`onShowDiff(sha, path)`、`onShowInLog(sha)`、`onFileHistory(path)`、`highlighter?`。
- **要点**：左 gutter（短哈希 · 日期 / 作者，段首显示一次；「紧凑/详细」切换）+ 行号 + 代码；`@tanstack/react-virtual` 虚拟化；语法高亮复用 `DiffHunks` 已用的 `useCodeHighlighter`；顶部路径、`@ 短哈希`（有 rev 时）、当前分支、总行数；hover card、单击/双击/右键语义见 AC3；样式只用 DSH 中存在的变量（`test/client/pages/css-tokens.test.ts` 的 `GUARDED` 加入新文件）。
- **测试**：组件静态渲染段首/续行的 gutter；分页「加载更多」；空状态（二进制/过大/未跟踪）；hover card 内容；单击、双击、右键回调；`blame-page` 读取参数并在参数变化时 `open` 新文件（依 T1 spike 结论）。
- **完成标准**：AC1–AC3 的 UI 部分、AC9 的 Blame 部分；`make check` 绿。

### T6：`FileHistoryPage` 与 `ComparePage`（待开始）

- **目标**：两个覆盖页，含页内 diff 分栏与返回链。
- **涉及文件**：新建 `src/client/pages/{FileHistoryPage,ComparePage}.tsx` 与 module.css；修改 `workbench-overlay.ts`（返回时若有 `back` 则恢复它，否则回页面；焦点规则不变）、`GitWorkbench.tsx`。
- **接口**：覆盖层 `{ kind: 'fileHistory'; path: string; rev?: string; back?: WorkbenchOverlay }`、`{ kind: 'compare'; left: string; right: string | null; leftLabel: string; rightLabel: string | null; back?: WorkbenchOverlay }`（均 Level 1）。页内 diff 复用 `DiffHunks`。
- **要点**：文件历史行：主题、作者、日期、状态字母、`+N −M`；「历史可能不连续」提示；行动作见 AC5。比较页横幅「`left` 中有而 `right` 中没有的提交」+「交换」；工作区比较只显示文件。返回链只保留一级来源（`back` 本身不再带 `back`），避免无限栈。
- **测试**：两页静态渲染与空状态；选中行/文件触发 diff；「交换」；从文件历史打开 Blame 再返回恢复选中与滚动（AC5）；`Esc` 走同一返回链。
- **完成标准**：AC4–AC8 的 UI 部分；`make check` 绿。

### T7：入口接线（待开始）

- **目标**：把所有入口接到 T5/T6 的覆盖层与 `git.blame` 页。
- **涉及文件**：新建 `src/client/pages/file-actions.ts`（文件动作项纯函数，供各处菜单共用）与测试、`src/client/pages/FileContextMenu.tsx`；修改 `ChangedFilesTree.tsx`（新增右键：显示 Diff、文件历史、Blame（此版本）、与工作区比较、复制路径）、`ChangesTree.tsx`（追加：文件历史、Blame）、`commit-actions.ts` / `CommitContextMenu.tsx`（与工作区比较；选中两个时「比较」）、`branch-actions.ts`（`compareWithCurrent`、`compareWithWorktree`）、`document-actions.tsx` / `register-document-actions.ts`（「历史」「Diff」启用、状态徽标可点、窄宽度收进 `⋯`、不在仓库内时禁用并说明）、`GitWorkbench.tsx`（订阅 `workbench-intents`）。
- **接口**：`fileActions(source: 'commitFile' | 'change' | 'historyRow' | 'blameSegment', context): FileActionItem[]`（形状仿 `CommitActionItem`：`id`、`label`、`disabledReason?`、`section`）。「在日志中显示」复用分支动作 `showInLog` 已有的定位路径。
- **测试**：`file-actions` 可用性矩阵（该提交删除的文件：「Blame（此版本）」不可用，原因「此提交删除了该文件」；未跟踪文件：「文件历史」「Blame」不可用，原因「文件还没有提交过」；其余组合在测试里逐条写死）；比较项在 0/1/2/3 个选中时的可用性；文档头部三动作调用 `openTab`/`postIntent` 的参数；Git tab 挂载前投递的意图在挂载后执行（AC9）。
- **完成标准**：AC8、AC9；全部入口在实机可达；`make check` 绿；`pnpm build && pnpm smoke` 通过并记录体积增量（AC12）。

## 评审重点

规格暗示但上面任务的测试最容易漏、最可能伤到用户的五类输入（各自的测试已加到对应任务）：

1. 文件名或修订号含空格、中文、以 `-` 开头 → 不能被当成 git 选项，也不能因转义出错而「找不到文件」（T2、T3）。
2. 跨重命名的文件历史 → 选中重命名前的提交时 diff 用当时的路径，不报文件不存在（T3、T4）。
3. Blame 一个有未提交修改 / 未跟踪 / 已在工作区删除的文件 → 未提交行显示「未提交」，后两者给明确空状态和下一步（例如从文件历史 Blame 旧版本），不白屏（T2、T5）。
4. CRLF、无末尾换行、空文件 → 行数与行号正确、最后一行不丢（T2）。
5. 加载中切换目标或仓库刷新 → 不闪回旧文件、不把旧页拼到新文件后面（T4）。

## 进度

<!-- 每完成一步追加一行：日期 — 任务 — 结果（commit 短哈希） -->

- 无

## 下一步

- 从 T1 开始（worktree `.claude/worktrees/b2-history-blame`，分支 `b2-history-blame`）：先写 `protocol.ts` 新类型与 `git-client` 请求体断言测试，再做 spike 两问。

## 决策记录

<!-- 执行中自行做出的决定：日期 — 决定 — 理由。影响范围超出本计划的，另写 ADR 并在这里链接。 -->

- 2026-10-27 — worktree 内 `node_modules` 软链到主 checkout — `package.json` 的 `link:../deepseek-harness/...` 是相对仓库根的路径，worktree 深度不同导致 `pnpm install --frozen-lockfile` 失败；软链不改 lockfile。
- 2026-10-27 — 用本计划的「进度」「决策记录」作执行账本，不用 executing-plans 的 `task-start`/`task-done` 脚本 — 脚本只认 `Task N` 标题，本仓库计划模板用 `T1`。
- 2026-10-27 — B2 不加 feature flag — 全部为只读视图，没有写回风险；出问题可直接隐藏入口。
- 2026-10-27 — 修订号先解析为 sha 再参与后续 git 调用 — 同时解决参数注入与「同一请求内 ref 移动」的竞态。

## 意外与发现

<!-- 和预期不一致的事、SDK 的新发现（同时写进 references/）、临时绕过的问题（同时登记到 tech-debt）。 -->

- 无

## 阻塞

<!-- 触发 SOP §6 升级条件时填写：问题、已尝试的办法、可选方案和推荐。解决后保留记录，并注明怎么解决的。 -->

- 无

## 验证记录

<!-- 自验证阶段填写：每条验收标准对应的命令、输出摘要、截图路径。 -->

- 无
