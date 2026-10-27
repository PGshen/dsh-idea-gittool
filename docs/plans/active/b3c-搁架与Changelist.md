# b3c-搁架与Changelist：Shelf（命名搁置改动）与 Changelist（改动分组）

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、契约与验收，不写完整实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 执行中 |
| 里程碑 | B3 高级操作（第 3 份，共 4 份；拆分见 [TODO](../TODO.md)） |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §6.2（「Changelist、拖放、Shelve/Unshelve」「Shelf（命名补丁）」行）、§8.2.2（P1 Changelist 分组）、§8.4.1（`Stash \| Shelf` 分段）、§13（按仓库覆盖的选项单独存）、§14.3（拖入/拖出 changelist）；[参考项目调研](../../references/reference-feature-inventory.md) §2.3（IntelliJ Shelf 语义） |
| 分支 | `b3c-shelf-changelist`（独立 worktree，从 `b3b-diff-commit-menu` 切出） |
| 批准记录 | 2026-10-27 负责人离开前授权：由 AI 自行起草、执行、自评审 B3b–B3d，回来统一 review。本计划「待确认」按推荐执行，验收时可推翻 |

## 目标

用户可以把一部分未提交改动「搁置」成一个有名字的搁架条目（从工作区移走、随时取回），在贮藏页的「搁架」分段里预览、取回、删除；提交页可以把改动分到多个 Changelist（例如「这次要提交的」与「调试用的」），按 Changelist 分组显示、拖放或右键移动、按组勾选提交。

## 范围

**包含：**

- **Host 搁架端点**：`shelfList`（读）、`shelfPatch`（读，取某条的补丁文本）、`shelfCreate`（写：名字 + 路径，含未跟踪文件；先存再回滚这些路径）、`shelfApply`（写：先 `apply --check`，能干净应用就应用；否则返回 `git/conflict` 风格的「不能干净应用」，用户可选「三方合并应用」）、`shelfDrop`（写）。
- **存储**：每条搁架是一个提交对象，树里放 `patch`（`git diff --binary` 文本）与 `meta.json`（名字、创建时间、来源分支、基准 HEAD、文件列表），挂在受限 ref `refs/worktree/dsh-git/shelf/<id>` 下（沿用 [ADR 0008](../../decisions/0008-待恢复贮藏标记用受限-ref.md) 的做法；新写 ADR 0011）。
- **Client**：`shelf-store`；贮藏页顶部分段「贮藏 | 搁架」，搁架列表（名字、分支、文件数、时间）+ 选中预览补丁 + 「取回」「取回并保留」「删除」；提交页工具栏/右键「搁置…」浮层（名字、将搁置的文件）。
- **Changelist**：纯客户端（每个浏览器、按仓库根），`localStorage` 键 `dsh-idea-git.changelists.v1:<repoRoot>`；默认列表「Changes」不可删；新出现的改动进入活动列表；提交页「按 Changelist 分组」开关、组头三态勾选、组头右键（设为活动 / 重命名 / 删除）、文件右键「移到 Changelist…」与拖放到组头；已不在改动里的路径自动清掉。
- 文案中英双语（新分区 `locales/shelf.ts`）。

**不包含：**

- 「最近删除」的搁架回收站（IntelliJ 的 Recently Deleted）：删除即删除（有确认）。
- 跨浏览器/跨机器同步 Changelist（设计 §13 只要求本地持久化）。
- Changelist 与 Shelf 的联动（按列表一键搁置）：可用「勾选组 → 搁置」完成。

## 待负责人确认（按推荐执行，验收时可推翻）

1. **搁架存哪里**：推荐存在仓库的 git 对象里（受限 ref，`git gc` 不回收、不进推送、按 worktree 隔离），而不是 `.idea/shelf` 式的工作区文件——后者需要 Host 在 confine 之外写文件，且会被 Agent 看到/改动。代价：`git worktree prune` 之类的清理不会删它们，需要在列表里手动删。
2. **取回冲突**：推荐默认只做干净应用（`apply --check` 通过才应用，不留半截状态）；不能干净应用时说明原因并提供「三方合并应用」（`apply --3way`，冲突文件进入现有冲突列表，不会产生「操作进行中」状态）。
3. **Changelist 只存在浏览器里**：推荐同意（设计 §13）。换浏览器或清站点数据会回到默认列表，不影响任何 git 状态。

## 验收标准

- [ ] AC1：搁置勾选的 2 个已修改文件 + 1 个未跟踪文件后，这 3 个路径回到 HEAD 状态（未跟踪文件被删除），其余改动不变；`shelfList` 出现该条目，文件列表与名字正确；`shelfPatch` 的补丁能用 `git apply` 原样重建改动（含二进制文件）（Host 真实仓库测试）。
- [ ] AC2：取回到干净工作区后改动完全恢复；取回后条目被删除，「取回并保留」不删除；与当前改动冲突时不改动任何文件并返回「不能干净应用」，「三方合并应用」后冲突文件出现在冲突列表（Host 测试）。
- [ ] AC3：搁架 ref 在 `refs/worktree/dsh-git/shelf/` 下；`git stash list` 不受影响；路径注入（`-x`、`..`、绝对路径）被拒绝；名字含引号/中文/换行时原样保存（Host 测试）。
- [ ] AC4：贮藏页「搁架」分段列出条目、选中预览补丁、取回/删除（删除需确认）；提交页「搁置…」只带勾选的文件，没有勾选时禁用并说明（组件测试 + L4）。
- [ ] AC5：Changelist 模型：新增/重命名/删除（默认列表不可删）、设为活动、移动文件、新出现的改动进入活动列表、消失的路径被清掉、存储损坏或不可用时回到默认（单测）。
- [ ] AC6：提交页按 Changelist 分组：每组可折叠、组头三态勾选只影响本组文件、拖放与右键「移到 Changelist…」生效、刷新后分组保持（组件测试 + L4）。
- [ ] AC7：L4 截图 `.evidence/b3c/`；`make check` 绿；中英文案一致。

## 契约（T1 冻结）

| 端点 | 请求 | 响应 |
|---|---|---|
| `shelfList`（读） | `RpcRequest` | `{ shelves: ShelfEntry[]; version? }` |
| `shelfPatch`（读） | `{ id: string }` | `{ patch: string; version? }` |
| `shelfCreate`（写） | `{ name: string; paths: string[] }` | `{ entry: ShelfEntry; version? }` |
| `shelfApply`（写） | `{ id: string; keep?: boolean; threeWay?: boolean }` | `{ applied: boolean; conflicts: string[]; kept: boolean; version? }` |
| `shelfDrop`（写） | `{ id: string }` | `{ id: string; version? }` |

```ts
interface ShelfEntry { id: string /* 时间戳 + 随机，[0-9a-z-]{1,64} */; name: string; createdAt: string; branch: string | null; baseSha: string; files: { path: string; status: FileStatusCode }[] }
```

不能干净应用：`git/conflict`，`details: { reason: 'shelf-not-clean', output }`，不改动任何文件。

## 任务

### T1：契约冻结 + ADR 0011（待开始）
- 协议、客户端方法、路由占位校验、ADR「搁架存为受限 ref 下的提交对象」。

### T2：Host 搁架（待开始）
- `src/host/git/shelf.ts`：生成补丁（已跟踪：`diff --binary HEAD -- <paths>`；未跟踪：`diff --binary --no-index /dev/null <path>` 拼接）、`hash-object`/`mktree`/`commit-tree` 存对象、`update-ref`、回滚路径（复用 `rollback.ts` 的逻辑）、列表（`for-each-ref` + `cat-file`）、应用（`apply --check` / `--3way`）、删除。
- 测试：AC1–AC3。

### T3：搁架 UI（待开始）
- `src/client/store/shelf-store.ts`、贮藏页分段、`ShelfPanel`、`ShelveSheet`、提交页入口。
- 测试：store 单测、静态渲染、可用性。

### T4：Changelist 模型（待开始）
- `src/client/changelists/changelist-model.ts`（纯函数）+ 持久化（读写都 try/catch）。
- 测试：AC5。

### T5：提交页 Changelist 分组（待开始）
- `ChangesTree` 分组模式、组头勾选、右键、拖放、列表管理浮层。
- 测试：AC6 的纯函数与静态渲染部分。

### T6：自验证与文档（待开始）
- L4、runbook、ARCHITECTURE、QUALITY、references。

## 进度

- 无

## 下一步

- 从 T1 开始。

## 决策记录

- 2026-10-27 — 待确认 1–3 按推荐执行（负责人授权 AI 自行推进 B3b–B3d，验收时统一 review）。

## 意外与发现

- 无

## 阻塞

- 无

## 验证记录

- 无
