# b3b-Diff增强与提交菜单：并排/词级/忽略空白/折叠、撤销提交、推送到此、新建标签、Fixup/Squash into、补丁

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、契约与验收，不写完整实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 执行中 |
| 里程碑 | B3 高级操作（第 2 份，共 4 份；拆分见 [TODO](../TODO.md)） |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §6.2（「日志：变更文件 + diff」「提交右键菜单」「Diff」「其他：创建/应用补丁」行）、§8.1.7（P1 项）、§9.2–9.4（并排、词级、忽略空白、折叠、`n`/`p`）、§11（New Tag、Create Patch）、§13（默认 Diff 模式）、§14.2（多选「创建补丁」）；[设计决策 v0.2](../../design/2026-10-25-产品设计决策-v0.2.md) §4 B3 行 |
| 分支 | `b3b-diff-commit-menu`（独立 worktree，从 `b3a-interactive-rebase` 切出；B3a 尚未合并） |
| 批准记录 | 2026-10-27 负责人离开前授权：B3a 完成后由 AI 自行起草、执行、自评审 B3b–B3d，回来统一 review。本计划的「待确认」按推荐执行，负责人验收时可推翻 |

## 目标

审改动时 Diff 查看器可以切到并排模式、看到行内变更词、忽略空白重算、展开完整文件并折叠长段未改内容，用 `n`/`p` 在变更块之间跳；日志提交右键补齐 IntelliJ 的常用项：撤销最新提交、推送到此提交、在此提交新建标签、把当前改动 Fixup/Squash 进某个旧提交、把提交导出为补丁；工作台可以应用一个补丁文件。

## 范围

**包含：**

- **Diff 查看器**：`DiffRequest` 增加 `ignoreWhitespace`（`-w`）与 `context: 'full'`（整文件上下文，仍受现有截断规则）；客户端并排视图（del/add 成对对齐、空白填充）、词级高亮（统一与并排都有）、长段未改内容折叠（>8 行，可展开）、`n`/`p` 跳变更块；工具栏「统一/并排」「忽略空白」「完整文件」；并排需要 Diff 区宽度 ≥ 900px（不够时按钮禁用并说明），模式记在 `localStorage` `dsh-idea-git.settings.v1` 的 `diffMode`。
- **提交右键菜单**：「撤销提交…」（仅 HEAD、非合并、有父提交；`reset --soft HEAD~1`，复用 `reset` 端点）、「推送直到此提交…」（推送页带 `revision`）、「新建标签…」（浮层：名称、可选附注信息）、「Fixup 到此提交…」「Squash 到此提交…」（用提交页已勾选的文件生成 `fixup!`/`squash!` 提交并 autosquash）、「创建补丁…」（单选或多选提交）。
- **补丁**：只读端点 `formatPatch`（`format-patch --stdout`）→ 浏览器下载 `.patch` 或复制；写端点 `applyPatch`（粘贴或选择文件，先 `--check` 预览再应用；`git am`（邮件格式）或 `git apply --3way --index`）。
- 文案中英双语（新分区 `locales/diffmenu.ts`）。

**不包含：**

- 标签推送/删除、标签列表管理：B3d。
- 图片 diff、行内语法高亮之外的富渲染（P2）。
- 设置页（B4）；本计划只记住 Diff 模式。
- 补丁写到磁盘路径（设计写的是「输出路径」）：改为浏览器下载，见待确认 2。

## 待负责人确认（按推荐执行，验收时可推翻）

1. **Fixup/Squash into 的语义**：IntelliJ 的同名动作是「用当前改动做一个 `fixup!`/`squash!` 提交，然后 autosquash 变基」。推荐照此实现，改动取提交页**已勾选**的文件（没有勾选时菜单项禁用并说明）；目标提交须在当前分支 first-parent 链上、非合并；autosquash 走 B3a 的同一套变基执行与停下处理。备选：只生成 `fixup!` 提交、不自动变基——不推荐，用户还得再开一次变基。
2. **补丁输出**：推荐浏览器下载（文件名 `<短哈希>-<主题>.patch`，多提交为 `<n>-commits.patch`）+「复制到剪贴板」，Host 不写任何文件；设计里的「输出路径」需要 Host 在 confine 之外写仓库目录，不推荐。
3. **应用补丁**：推荐入口放在仓库栏「⋯」菜单；内容来自文件选择或粘贴；≥ 1 个 `From <sha>` 邮件头时用 `git am --3way`（保留作者与信息），否则 `git apply --3way --index`（改动进暂存区，不自动提交）；请求体上限 8 MiB（按端点限额，[ADR 0009](../../decisions/0009-请求体按端点限额.md)）。
4. **并排的宽度门槛**：设计写「≥900px 或全屏」；推荐量 Diff 内容区宽度（ResizeObserver），不足时禁用按钮并提示「需要更宽的面板（可用右上角全屏）」，已在并排时缩窄自动退回统一但保留选择。

## 验收标准

- [ ] AC1：`ignoreWhitespace: true` 时只有空白差异的文件显示「没有文本差异（忽略空白）」，混合改动只剩非空白行；四种 scope 都生效（Host 真实仓库测试）。
- [ ] AC2：`context: 'full'` 返回整文件为一个 hunk（行号连续），超过现有截断上限时仍截断并提示（Host 测试）。
- [ ] AC3：并排视图把每段连续 del/add 成对对齐，多出的一侧用空白行填充；左右行号与统一视图一致；词级高亮只标出行内变化的词，整行替换不做词级（纯函数单测 + 静态渲染）。
- [ ] AC4：长于 8 行的未改片段折叠为「展开 N 行未改内容」，点击展开；`n`/`p` 在变更块之间移动并滚动到位，首尾不越界（单测 + L4）。
- [ ] AC5：并排按钮在内容区 < 900px 时禁用并说明；模式选择在刷新后保留（单测 + L4）。
- [ ] AC6：「撤销提交」只在 HEAD 上可用；执行后 HEAD 回到父提交、改动留在暂存区；已推送时警告（组件测试 + Host 复用测试）。
- [ ] AC7：「推送直到此提交」推送页显示将推送的提交只到该提交为止；推送后远程分支指向该提交；该提交不在 HEAD 祖先链或已在远程时禁用（Host 真实仓库测试 + 组件测试）。
- [ ] AC8：「新建标签」创建轻量/附注标签；同名时报「标签已存在」；名称经 `check-ref-format` 校验（Host 测试 + 组件测试）。
- [ ] AC9：「Fixup/Squash 到此提交」用勾选文件生成 `fixup! <主题>`/`squash! <主题>` 并 autosquash，结果中目标提交包含这些改动、其余未勾选改动仍在工作区；冲突/停下沿用 B3a 横幅（Host 真实仓库测试）。
- [ ] AC10：「创建补丁」对单个/多个提交得到与 `git format-patch --stdout` 相同的文本，可下载与复制；「应用补丁」先预览将改动的文件，`am` 与 `apply` 两种格式都能应用，失败时不留下半应用状态（`am --abort`）（Host 测试 + L4）。
- [ ] AC11：L4 走查截图放 `.evidence/b3b/`；`make check` 绿；新增文案中英一致。

## 契约（T1 冻结）

| 端点 | 请求 | 响应 |
|---|---|---|
| `diff`（扩展） | `DiffRequest` 增加 `ignoreWhitespace?: boolean`、`context?: 'default' \| 'full'` | 不变 |
| `push`（扩展） | `PushRequest` 增加 `revision?: string`（完整 sha；推送 `<sha>:refs/heads/<branch>`） | 不变 |
| `pushPreview`（扩展） | 请求可带 `revision?: string`；预览提交列表截到该提交 | 不变 |
| `createTag`（写，新） | `CreateTagRequest extends WriteRequest { name: string; target: string /* 完整 sha */; message?: string }` | `{ name: string; target: string; version? }` |
| `fixupCommit`（写，新） | `FixupCommitRequest extends SmartWriteRequest { target: string; paths: string[]; kind: 'fixup' \| 'squash'; message?: string /* squash 时的附加信息 */ }` | `InteractiveRebaseValue` |
| `formatPatch`（读，新） | `{ shas: string[] /* 1–100，完整 sha */ }` | `{ patch: string; fileName: string; truncated: boolean }` |
| `applyPatch`（写，新） | `ApplyPatchRequest extends WriteRequest { patch: string; check?: boolean }` | `{ format: 'mbox' \| 'diff'; files: string[]; applied: boolean; commits?: number; version? }` |

## 任务

### T1：契约冻结（完成）
- 协议、`git-client` 方法、路由占位校验、`bodyLimitFor('applyPatch')` = 8 MiB、覆盖层 `{ kind: 'createTag'; sha }`、`{ kind: 'undoCommit'; sha }`、`{ kind: 'fixupInto'; sha; mode }`、`{ kind: 'patch'; shas }`、`{ kind: 'applyPatch' }`、`push` 覆盖层增加 `revision?`。
- 测试：协议登记、读写分类、客户端请求体、http 限额。

### T2：Host diff 选项（完成）
- `src/host/git/diff.ts`：`-w`、`--unified=<大数>`（整文件）；测试 AC1/AC2。

### T3：Host 新端点（完成）
- `createTag`（`tag [-a -F -] -- <name> <sha>`，`check-ref-format`，已存在 → `git/branch-exists` 同类码 `details.kind: 'tag'`）、`push` 的 `revision`（必须是 HEAD 祖先；预览截断）、`formatPatch`、`applyPatch`（格式识别、`--check` 预览、失败 `am --abort`）、`fixupCommit`（`commit --only --fixup=<sha>`/`--squash=<sha>` + `rebase -i --autosquash <target>^`，复用 B3a 的停下判定与智能贮藏）。
- 测试：真实临时仓库覆盖 AC6–AC10 的 Host 部分；注入（标签名以 `-` 开头、补丁里的路径越界由 git 自己拒绝）。

### T4：Diff 视图纯函数（进行中）
- `src/client/diff/{split-rows,word-diff,fold}.ts`：`splitRows(hunks)`、`wordDiff(oldText, newText)`（按词切分后用 `merge/line-diff.ts` 的 `diffSequences`；改动占比 > 60% 视为整行替换）、`foldContext(lines, minRun = 8)`、`changeAnchors(hunks)`。
- 测试：AC3/AC4 的纯函数部分。

### T5：Diff 查看器 UI（待开始）
- `DiffViewer` 工具栏三个开关、`DiffHunks` 增加并排渲染与词级标记、折叠展开、`n`/`p`、宽度门槛、`diffMode` 持久化（`src/client/settings.ts`，读写都 try/catch）。
- 测试：静态渲染与 controller 单测；AC5。

### T6：提交菜单与浮层（待开始）
- `commit-actions.ts` 六个新项与可用性；`CreateTagSheet`、`UndoCommitSheet`（复用 `ResetSheet` 的确认样式）、`FixupIntoSheet`（显示将带入的勾选文件数）、`PatchPage`（预览 + 下载 + 复制）、`ApplyPatchPage`（文件选择/粘贴 → 预览 → 应用）、推送页 `revision`。
- 测试：可用性矩阵、组件静态渲染、下载文件名。

### T7：自验证与文档（待开始）
- L4 走查（`.evidence/b3b/`）、runbook、ARCHITECTURE、QUALITY、references（`-w` 与 `--unified` 行为、`am --3way` 失败回滚）。

## 进度

- 2026-10-27 — T1 — 协议（`DiffRequest.ignoreWhitespace/context`、`PushRequest.revision`、`PushPreviewRequest`、四个新端点）、客户端方法、`applyPatch` 32 MiB 请求体、五个新覆盖层、三个写端点的 `parse`
- 2026-10-27 — T2 — `diff` 的 `-w` 与整文件上下文（`-U1000000`），四种 scope 与未跟踪文件都生效；RPC 透传并纳入缓存键
- 2026-10-27 — T3 — `createTag`（`check-ref-format`、同名 → `git/branch-exists` + `kind: 'tag'`、附注信息走 stdin）、推送/预览的 `revision`（须为 HEAD 祖先）、`formatPatch`（逐提交 `format-patch -1`，按祖先数排序，拒绝合并提交）、`applyPatch`（mbox → `am --3way`，失败 `am --abort`；diff → 先 `apply --check --index` 再 `apply --index`）、`fixupCommit`（先判断勾选外改动再提交 `fixup!`/`squash!`，`rebase -i --autosquash` 复用 B3a 的 `rebaseOutcome`）

## 下一步

- T4：新建 `src/client/diff/{split-rows,word-diff,fold}.ts` 与 `test/client/diff/*.test.ts`。

## 决策记录

- 2026-10-27 — `plans/active/` 同时有 b3a（待负责人验收）与 b3b 两份计划：b3a 已完成实现与评审，只等验收；b3b 从 b3a 分支切出，验收后按 b3a → b3b 顺序合并。
- 2026-10-27 — T3：普通 diff 补丁不用 `--3way`：`apply --3way` 失败时会在工作区留下冲突标记却没有任何「操作进行中」状态，横幅与冲突列表都接不住；改为先 `--check` 再 `--index`，不能干净应用就整体拒绝并给出 git 输出。mbox 仍用 `am --3way`（失败即 `am --abort`）。
- 2026-10-27 — T3：`formatPatch` 按祖先数（`rev-list --count`）排序而非提交时间——同一秒内的提交按时间排序不稳定（测试里实际出现）。
- 2026-10-27 — T3：B3a 的变基结果判定抽成 `rebaseOutcome`（`interactive-rebase.ts` 导出），fixup 复用，行为不变。
- 2026-10-27 — 待确认 1–4 按推荐执行（负责人授权 AI 自行推进 B3b–B3d，验收时统一 review）。

## 意外与发现

- 无

## 阻塞

- 无

## 验证记录

- 无
