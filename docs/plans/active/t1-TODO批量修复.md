# t1-TODO批量修复：数据安全修复与小修正批量处理

<!--
执行方式：subagent 驱动，按区域分 4 组并行（各自独立 worktree 分支），由主会话合并、整分支 make check 后交负责人验收。
本计划只写意图、涉及文件与验收，不写实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 执行中 |
| 里程碑 | B 阶段收尾（TODO 清理） |
| 设计依据 | 各条目原计划的「决策记录」终审条目（b1、b2、b3b、b3d、b4d 计划）；[TODO](../TODO.md) |
| 分支 | `t1-todo-fixes` |
| 批准记录 | 2026-10-29 负责人：TODO 分类中「又急又容易」与「不急但容易」两组本次一起做 |

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

- [ ] AC1：上述每条都有对应的测试（先失败后通过），或在「决策记录」写明为何只能人工验证
- [ ] AC2：`make check` 在合并后的分支上全绿
- [ ] AC3：TODO 中对应条目移到「已完成」，已处理的 Minor 从原条目中删去

## 任务

### T1：Host 远程与 worktree（完成后见进度）

- G3、G4、G5（Host 侧如有门禁一并加）、标签推送被拒原因、upstream/推送标签/删除远程分支成功提示、「留空不修改」文案
- 涉及：`src/host/git/remote-write.ts`、`src/host/rpc.ts`、worktree 相关 host/client 文件、`src/client/locales/remotes.ts`、远程/Worktree/分支页面

### T2：合并窗口与冲突

- G1、G2、G6、冲突来源文案、块计数失败缓存、B1 测试缺口
- 涉及：`src/host/git/operation.ts`、`src/client/merge/`、`ConflictsPage.tsx`、`src/client/locales/conflict.ts`

### T3：日志、历史、补丁

- G7、`patch.ts` 注释、`[PATCH n/m]`、分支比较 `entry.name`、`historyStore.close()`、`git.blame` Esc
- 涉及：`src/client/pages/GitWorkbench.tsx`、`LogPage.tsx`、log store、`src/host/git/patch.ts`、`blame-page.tsx`、`BranchesPage.tsx`/`ComparePage.tsx`

### T4：控制台、贮藏、B4d 测试

- 控制台 stdinBytes、贮藏未跟踪文件计数、B4d 搁架门控与并发探测组件测试
- 涉及：`src/client/console/`、`src/host/git/stash*.ts`、`test/client/`

## 进度

- 无

## 下一步

- 4 个任务已分派给并行子代理；合并各分支后跑 `make check`，再更新 TODO。

## 决策记录

- 2026-10-29 — 4 组按区域并行，每组独立 worktree 分支，避免同一 checkout 内互相干扰 `make check`；计划文件只由主会话修改。

## 意外与发现

- 无

## 验证记录

- 无

## 阻塞

- 无
