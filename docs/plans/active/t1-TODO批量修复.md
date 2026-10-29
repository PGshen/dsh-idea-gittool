# t1-TODO批量修复：数据安全修复与小修正批量处理

<!--
执行方式：subagent 驱动，按区域分 4 组并行（各自独立 worktree 分支），由主会话合并、整分支 make check 后交负责人验收。
本计划只写意图、涉及文件与验收，不写实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 待验收 |
| 里程碑 | B 阶段收尾（TODO 清理） |
| 设计依据 | 各条目原计划的「决策记录」终审条目（b1、b2、b3b、b3d、b4d 计划）；[TODO](../TODO.md) |
| 分支 | `t1-todo-fixes` |
| 批准记录 | 2026-10-29 负责人：TODO 分类中「又急又容易」与「不急但容易」两组本次一起做；2026-10-29 负责人接受 3 处计划外公共接口新增，要求做整分支评审 |

## 目标

清掉 TODO 中会丢数据、误删、泄露凭据或卡住界面的 7 条小问题，以及一批文案、小修正、小功能与测试缺口。

## 范围

**包含（第一组：数据安全与卡住）：**

- G1 continue/abort 失败时不清理合并草稿（`src/host/git/operation.ts`）
- G2 合并窗口有未保存改动时注册 `beforeunload` 守卫
- G3 `remoteBranchDelete` 删除 `<remote>/HEAD` 时用 `--no-deref`（`src/host/git/remote-write.ts`）
- G4 `remoteList` 失败的错误信息脱敏（`src/host/rpc.ts`）
- G5 Worktree 页对主工作区、锁定 worktree 不提供删除（禁用并说明原因）
- G6 `answerLeave('save')` 保存失败时保留询问可再答；`closeIf` 关窗时按取消回应 `dirtyWorktree`
- G7 改写历史后选中的 sha 不在新日志里时清空日志详情选中

**包含（第三组：文案、小修正、小功能、测试）：**

- 文案：冲突列表说明区分来源（贮藏 / 搁架）；「新的 URL（留空不修改）」与行为一致；推送标签、删除远程分支、设置/取消 upstream 成功后有提示；标签推送被拒时显示具体原因
- 小修正：`patch.ts` 头注释与实现一致；导出补丁为 `[PATCH n/m]`；分支比较传 `entry.name`；GitWorkbench 卸载时 `historyStore.close()`；`git.blame` 页无返回时不吞 Esc
- 小功能：控制台显示「stdin: N bytes」；贮藏列表文件数计入未跟踪文件（`^3`）；冲突列表块计数加载失败按 stages 缓存不重试
- 测试：B1 终审缺口（continue 失败后草稿、忙碌时 dispatch 被忽略、conflict/cancelled 结果文案、`dirtyWorktree` → `cancelStash` 接线、`git-client` 新端点请求体断言）；B4d 搁架门控与并发探测组件测试

**不包含：** TODO 中第二组（需设计）与第四组（不急不易）条目。

## 验收标准

- [x] AC1：上述每条都有对应的测试（先失败后通过），或在「决策记录」写明为何只能人工验证
- [x] AC2：`make check` 在合并后的分支上全绿
- [x] AC3：TODO 中对应条目移到「已完成」，已处理的 Minor 从原条目中删去

## 任务

### T1：Host 远程与 worktree（完成）

- G3、G4、G5（Host 侧如有门禁一并加）、标签推送被拒原因、upstream/推送标签/删除远程分支成功提示、「留空不修改」文案
- 涉及：`src/host/git/remote-write.ts`、`src/host/rpc.ts`、worktree 相关 host/client 文件、`src/client/locales/remotes.ts`、远程/Worktree/分支页面

### T2：合并窗口与冲突（完成）

- G1、G2、G6、冲突来源文案、块计数失败缓存、B1 测试缺口
- 涉及：`src/host/git/operation.ts`、`src/client/merge/`、`ConflictsPage.tsx`、`src/client/locales/conflict.ts`

### T3：日志、历史、补丁（完成）

- G7、`patch.ts` 注释、`[PATCH n/m]`、分支比较 `entry.name`、`historyStore.close()`、`git.blame` Esc
- 涉及：`src/client/pages/GitWorkbench.tsx`、`LogPage.tsx`、log store、`src/host/git/patch.ts`、`blame-page.tsx`、`BranchesPage.tsx`/`ComparePage.tsx`

### T4：控制台、贮藏、B4d 测试（完成）

- 控制台 stdinBytes、贮藏未跟踪文件计数、B4d 搁架门控与并发探测组件测试
- 涉及：`src/client/console/`、`src/host/git/stash*.ts`、`test/client/`

## 进度

- 2026-10-29 — T1 远程与 worktree — 完成（b87d12a）
- 2026-10-29 — T2 合并窗口与冲突 — 完成（1648f21、28fecbd、ad4635f、d42d244）
- 2026-10-29 — T3 日志、历史、补丁 — 完成（61b1ba1、4f94aa9、e9ae332、ea9a53a）
- 2026-10-29 — T4 控制台、贮藏、B4d 测试 — 完成（8285570、1ccb732、24f86ff、e90775d）
- 2026-10-29 — 四个分支合并到 `t1-todo-fixes`（无冲突），合并后 `make check` 全绿（146 文件 / 2378 测试）；TODO 已更新

## 下一步

- 等负责人验收：确认下方「需负责人确认」的两处公共接口新增；验收后按 SOP §8 合并到 main 并把本计划移入 completed。

## 决策记录

- 2026-10-29 — 4 组按区域并行，每组独立 worktree 分支，避免同一 checkout 内互相干扰 `make check`；计划文件只由主会话修改。
- 2026-10-29 — **负责人已接受（计划外的公共接口新增）**：`WorktreeEntry.main`、`TagPushRejectedDetails`（T1）；`StaleTargetDetails.target` 新增 `'git-path'`（T4，修并发 bug 所必需）。均为新增、向后兼容，只在插件 Host/Client 之间使用。
- 2026-10-29 — T2 草稿清理：操作仍在进行时，只在 git 成功或位置（HEAD/变基步号/CHERRY_PICK_HEAD/REVERT_HEAD）推进后清理；操作已结束时照常清理（草稿再也匹配不上）。
- 2026-10-29 — T2 保存失败重新询问只用于外部导航（挂起的智能操作询问），窗口自己的返回/切换文件保持只显示错误。
- 2026-10-29 — T2 冲突来源由客户端 `conflict-store` 记录 `origin`（Host 搁架三方合并不留标记）；块计数失败缓存按「本轮 + 路径」而非 stages（失败时拿不到 stages），新轮次或文件改动时失效。
- 2026-10-29 — T3 「选中提交已消失」不额外请求：刷新到历史末尾，或已加载行数大于「原位置 + 新出现行数」时才判定消失并清空详情；否则保持 A1 I3 行为。分支比较改传完整 ref（`refs/heads/x`），git 解析短名时标签优先。
- 2026-10-29 — T4 贮藏文件数把 `-u` 贮藏的未跟踪文件直接计入「N 个文件」，与详情两个列表之和一致。
- 2026-10-29 — T1 「新的 URL（留空不修改）」：空值本来就无法提交，改文案为「新的 URL」；锁定 worktree 的原因文案提示在终端 `git worktree unlock`（界面无解锁操作）。

## 意外与发现

- T4 补并发测试时发现真 bug：重叠设置 git 路径时先发起的那次会生效；已修（`src/host/git-executable.ts`，被取代的设置返回 `git/stale-target`）。
- T1 确认 `<remote>/HEAD` 删除确实会误删 `origin/main`（修复前测试复现）。
- worktree 中跑 `make check` 会因 pnpm install 改写 `pnpm-lock.yaml`（esbuild build script 被忽略、link 相对路径变化），各子代理均已还原未提交。
- T2 遗留：搁架来源冲突的对方一侧名字仍写「贮藏」，来源只在内存，已登记 TODO。

## 验证记录

- 合并后 `make check`：146 个测试文件 / 2378 个测试通过，lint、类型检查、分层契约、构建与 smoke 通过（2026-10-29）。
- 每项均有单元/DOM/真实仓库 Host 测试；未做浏览器 L4 走查。T2 的 `beforeunload` 测试与实现同时写，未先跑 RED。

## 阻塞

- 无
