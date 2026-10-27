# b3d-Worktree与远程：Worktree、Remotes、标签推送/删除、远程分支删除、upstream

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、契约与验收，不写完整实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 执行中 |
| 里程碑 | B3 高级操作（第 4 份，共 4 份；拆分见 [TODO](../TODO.md)） |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §6.2（「Worktree 列表/新建/删除」「Remotes」行）、§8.3.4（P1：设为/取消 upstream、在 Worktree 中打开；标签右键：推送标签、删除标签（本地/远程分开确认））、§11（Remotes：URL 脱敏显示凭据）、§17 M5（Worktree 用 feature flag）；[A3 计划](../completed/a3-分支贮藏冲突.md)「不包含」（远程分支删除、远程重命名、标签推送/删除推迟到 B3） |
| 分支 | `b3d-worktree-remotes`（独立 worktree，从 `b3c-shelf-changelist` 切出） |
| 批准记录 | 2026-10-27 负责人离开前授权：由 AI 自行起草、执行、自评审 B3b–B3d，回来统一 review。本计划「待确认」按推荐执行，验收时可推翻 |

## 目标

用户在分支页能推送/删除标签（删除时明确「只删本地」还是「同时删远程」）、删除远程分支、为本地分支设置或取消 upstream；在仓库栏 ⋯ 打开「远程」页管理远程（列表、新增、改 URL、重命名、删除，URL 中的凭据脱敏显示）；打开「Worktree」页查看、新建（从已有分支或新分支）、删除、清理 worktree，并从分支右键「在新 Worktree 中签出…」。

## 范围

**包含：**

- **Host 端点**：`remoteList`（读）、`remoteEdit`（写：`add`/`setUrl`/`rename`/`remove`）、`tagPush`（网络写）、`tagDelete`（写；可选同时删远程，网络）、`remoteBranchDelete`（网络写）、`setUpstream`（写：设置或取消）、`worktreeList`（读）、`worktreeAdd`（写）、`worktreeRemove`（写，含 `force`）、`worktreePrune`（写）。
- **Client**：标签右键「推送标签…」「删除标签…」；远程分支右键「删除远程分支…」；本地分支右键「设置 upstream…」「取消 upstream」「在新 Worktree 中签出…」；`RemotesPage`（覆盖页）；`WorktreesPage`（覆盖页，flag `worktrees`）；对应浮层。
- 文案中英双语（新分区 `locales/remotes.ts`）。

**不包含：**

- 在 DSH 里切换到另一个 worktree 作为会话工作区（宿主没有可用 API）：Worktree 页提供「复制路径」，由用户自己在 DSH 新建工作区。
- 收藏分支、最近分组（P1 的其他分支页增强，B4 视情况）。
- 远程标签列表（`ls-remote --tags`）：删除远程标签时按名字直接删。
- 子模块。

## 待负责人确认（按推荐执行，验收时可推翻）

1. **新 worktree 的默认位置**：推荐默认 `<仓库根>/.worktrees/<分支名>`（在工作区写边界内，`workspace-write` 沙箱下也能创建），路径可改为仓库内的其他相对路径；同级目录（`../repo-branch`）在沙箱下会被拒绝，界面说明原因。代价：主工作区里会出现 `.worktrees/` 目录，需要用户自己加到 `.gitignore`（Host 不替用户改 `.gitignore`，页面给出提示）。
2. **Worktree 用 feature flag**（设计 §17）：`worktrees` 开发期默认关，验收后再开。
3. **删除远程标签/分支**：都要二次确认并写清远程名；删除标签浮层里「同时删除远程 `<remote>` 上的同名标签」默认不勾。
4. **Remotes 的 URL 显示**：列表与表单都只显示脱敏后的 URL（沿用控制台的 `redactCredentials`：整段 userinfo 换成 `***`，即 `https://***@host`）；编辑时如果用户没改 URL 就不发送，避免把脱敏串写回去。

## 验收标准

- [x] AC1：`tagPush` 推送标签到所选远程（`push <remote> refs/tags/<name>`）；`tagDelete` 只删本地，或本地 + 远程（`push <remote> :refs/tags/<name>`），远程失败时本地删除仍生效并如实报告（Host 真实仓库测试，本地 bare 远程）。
- [x] AC2：`remoteBranchDelete` 删除 `origin/<b>` 对应的远程分支，并清掉本地的远程跟踪 ref；不存在时报 `git/stale-target`（Host 测试）。
- [x] AC3：`setUpstream` 设置后 `git rev-parse --abbrev-ref <b>@{upstream}` 等于所选；取消后无 upstream；远程分支不存在时报错（Host 测试）。
- [x] AC4：`remoteList` 返回名字、fetch/push URL（凭据脱敏）；`remoteEdit` 的新增、改 URL、重命名、删除与 `git remote -v` 一致；名字/URL 以 `-` 开头被拒（Host 测试）。
- [x] AC5：`worktreeList` 与 `git worktree list --porcelain` 一致（路径、分支、HEAD、locked、prunable、是否当前）；`worktreeAdd` 能从已有分支或新分支创建，默认路径 `.worktrees/<分支>`；分支已在别处签出时报错；`worktreeRemove` 对有改动的 worktree 要求 `force`；`worktreePrune` 清理已删除目录的记录；不能删除当前 worktree（Host 测试）。
- [x] AC6：分支页菜单按设计出现并说明不可用原因（标签/远程分支/本地分支三类）；Remotes 页与 Worktree 页的列表、表单、确认（组件测试 + L4）。
- [x] AC7：flag `worktrees` 关闭时 Worktree 入口全部不出现（单测）。
- [x] AC8：L4 截图 `.evidence/b3d/`；`make check` 绿；中英文案一致。

## 契约（T1 冻结）

```ts
interface RemoteEntry { name: string; fetchUrl: string /* 脱敏 */; pushUrl: string /* 脱敏 */ }
remoteList: RpcRequest → { remotes: RemoteEntry[] }
remoteEdit: WriteRequest & ({ action: 'add'; name: string; url: string } | { action: 'setUrl'; name: string; url: string } | { action: 'rename'; name: string; newName: string } | { action: 'remove'; name: string }) → { remotes: RemoteEntry[] }
tagPush: WriteRequest & { name: string; remote: string } → { name: string; remote: string }
tagDelete: WriteRequest & { name: string; remote?: string } → { name: string; localDeleted: boolean; remoteDeleted: boolean; remoteError?: string }
remoteBranchDelete: WriteRequest & { remote: string; branch: string } → { remote: string; branch: string }
setUpstream: WriteRequest & { branch: string; upstream: string | null /* `origin/x` */ } → { branch: string; upstream: string | null }
interface WorktreeEntry { path: string; head: string | null; branch: string | null; current: boolean; locked: boolean; prunable: boolean; bare: boolean }
worktreeList: RpcRequest → { worktrees: WorktreeEntry[] }
worktreeAdd: WriteRequest & { path: string /* 相对仓库根 */; branch: string; createBranch?: boolean; startPoint?: string } → { worktree: WorktreeEntry }
worktreeRemove: WriteRequest & { path: string; force?: boolean } → { path: string }
worktreePrune: WriteRequest → { pruned: number }
```

## 任务

### T1：契约冻结（完成）
### T2：Host 标签/远程分支/upstream/remotes（完成）
- `src/host/git/remote-write.ts`（`remoteList`、`remoteEdit`、`remoteBranchDelete`、`setUpstream`）、`src/host/git/tag-write.ts` 扩展（`tagPush`、`tagDelete`）；网络命令走 `mode: 'network'` 与现有凭据失败分类。
### T3：Host worktree（完成）
- `src/host/git/worktree.ts`。
### T4：分支页菜单与浮层（完成）
- `branch-actions.ts` 新项与可用性；`TagSheets`（推送/删除）、`RemoteBranchDeleteSheet`、`UpstreamSheet`。
### T5：Remotes 页与 Worktree 页（完成）
### T6：自验证与文档（完成）

## 进度

- 2026-10-28 — T1–T3 — 协议与客户端方法；Host `remote-write`（列表脱敏、增改删重命名、删除远程分支、upstream）、`tag-write`（推送、删除本地/远程）、`worktree`（列表、新增、删除、清理）与路由
- 2026-10-28 — T4+T5 — 分支页新菜单项（标签推送/删除、远程分支删除、设置/取消 upstream、在新 Worktree 中签出）与四个浮层；远程页、Worktree 页（flag `worktrees`）；仓库栏 ⋯「管理远程…」「Worktree…」
- 2026-10-28 — T6 — L4 走查（`.evidence/b3d/`，8 张截图），修复三处布局问题：新建 Worktree 浮层的路径说明挤在标签列、Worktree/远程页行内名字与按钮折行、删除确认行按钮折行；runbook/ARCHITECTURE/QUALITY/references §7

## 下一步

- 整分支评审（`b3c-shelf-changelist..HEAD`），修复 Critical/Important，Minor 进 TODO；然后等负责人统一验收 B3。

## 决策记录

- 2026-10-28 — T4/T5 合并为一次提交，视图组件先写、静态渲染测试后补（同 B3b/B3c 的做法）。新菜单项只在上下文带 `remotes` 时出现（保持旧的可用性矩阵测试不变）。
- 2026-10-28 — T1–T3 合并为一次提交：`remoteList`/`worktreeList` 只需会话参数，占位实现会让路由登记测试失败（与 B3c 同理）。
- 2026-10-28 — 待确认 1–4 按推荐执行（负责人授权 AI 自行推进 B3b–B3d，验收时统一 review）。

## 意外与发现

- 2026-10-28 — 新建 Worktree 后主工作区多出未跟踪的 `.worktrees/`（状态栏「1 个修改」），符合待确认 1 的预期；页面已提示加进 `.gitignore`。

## 阻塞

- 无

## 验证记录

- 2026-10-28 — L4（隔离 DSH，端口 3081，git 2.50.1，Chrome 内置浏览器）：runbook「Worktree 与远程实机验证」1–9 全部通过；每步用 `git ls-remote`/`git worktree list`/`rev-parse @{upstream}` 对照。截图 `.evidence/b3d/01–08`。
