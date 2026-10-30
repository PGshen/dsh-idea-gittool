# t2-TODO设计类修复：变基 --root 分支、搁架竞态与子模块、worktree 符号链接、git 路径权限与快照

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、涉及文件、验收与验证，不写实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 已完成 |
| 里程碑 | B 阶段收尾（TODO 第二组：需要设计的问题） |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §419（找不到 git 时的入口）、§1096/§1136（git 路径设置）、§1442/§1539（只读模式下写入口禁用并说明原因）；[ADR 0011](../../decisions/) 搁架；[ADR 0014](../../decisions/0014-git路径的信任边界.md)；b3a、b3c、b3d、b4d 计划的终审条目 |
| 分支 | `t2-design-fixes`（从 main 切出） |
| 批准记录 | 2026-10-30 负责人选定阻塞 1–3 的方案与执行方式，并批准计划；2026-10-30 负责人在 L4 走查后验收通过 |

## 目标

修掉 4 个需要先定方案的问题：交互式变基 `--root` 时分支被移到空根提交；搁架在刷新换选中后作用到别的条目、搁置子模块时报看不懂的错；新建 worktree 经符号链接落到仓库外；只读会话能改全局 git 路径，且改动会插进别的仓库进行中的写操作。

## 现状（2026-10-29 调查，均有 git 2.50.1 实测或代码路径）

- **变基**：`src/shared/rebase-todo.ts:76-79` 对前导 drop 紧跟写 `update-ref`。`--root` 下 git 把它更新到内部的空根提交（空树、无信息、无父），实测 `side` 被改写到这个孤立提交。非 `--root` 时落到 onto，是合理的。Host（`interactive-rebase.ts:112`）与客户端预览（`rebase-model.ts:173`）共用这段逻辑；现有测试 `test/shared/rebase-todo.test.ts:116` 把它固定成了预期。
- **搁架竞态**：`ShelfPanel.tsx:149-150` 的「不能干净应用」与「确认删除」是不绑定条目的布尔状态；刷新（`shelf-store.ts:57-60`）在原条目消失或乱序返回时会把选中换成别的条目，提示条仍在，点击后三方合并或**删除**作用到新条目。`refresh` 无序号。
- **搁架子模块**：TODO 原描述「只回滚索引」与实测不符。实际是 mktree 一步就失败（`object ... is unavailable` 或 `is a commit but specified type was (blob)`），不丢数据，但给出原始 git 报错；若将来绕过 mktree，现有代码会从索引删掉 gitlink。
- **worktree 符号链接**：`worktree.ts:84` 只做字面路径检查，`:92` 直接拼路径交给 git。实测 `.worktrees -> 仓库外` 时 worktree 建在仓库外且报成功。`danger-full-access` 下不受限；`workspace-write` 下仓库是工作区子目录时也拦不住。
- **git 路径**：`rpc.ts:349,607-620` 的 `gitExecutable` 没有任何门禁；`git-executor.ts:316-325` 每条命令都重新读全局 override，`bindWriteContext` 不绑定程序。多步写操作可能前半段用一个 git、后半段用另一个，绕过开头做过的版本门控（如 `--update-refs`）。sessionId 由客户端提供，门禁只防误用，不是安全边界（ADR 0014 已列为残留风险）。

## 范围

**包含：**

- T1 变基 `--root` 前导 drop 上的分支保持不动
- T2 搁架：提示条绑定条目 id、`refresh` 加序号
- T3 搁架：拒绝搁置子模块路径
- T4 worktree：新建前做 realpath 包含性检查
- T5 git 路径：只读会话不能设置；每个写操作取一次 git 快照；ADR

**不包含：**

- RPC Result 上限 8 MiB 是否降到 2 MiB（待负责人另行裁定，见「阻塞」）
- P1「B 阶段差距」各项新功能（规模相当于一个新里程碑，另立计划）
- 子模块搁置的真正支持（需改动子模块仓库，超出 ADR 0011）

## 验收标准

- [x] AC1：`--root` 下 drop 首提交且有分支指向它时，分支保持原 sha，主分支结果正确；预览与执行一致，变基页提示该分支保持不动（真实仓库 Host 测试 + 模型测试）
- [x] AC2：搁架选中因刷新改变后，「三方合并应用」与「确认删除」提示条消失；点击只会作用到用户看到的那个条目；乱序刷新结果被丢弃（happy-dom + store 测试）
- [x] AC3（有偏差，见「意外与发现」）：搁置包含子模块的路径时返回 `reason: 'submodule'`，索引、工作区、ref 都不变；客户端子模块行不可勾选并说明原因（真实仓库测试，子模块用 `protocol.file.allow=always`）
- [x] AC4：`.worktrees`、中间段或目标本身为指向仓库外的符号链接时，新建被拒（`reason: 'path-outside-repository'`），仓库外目录为空、`worktree list` 无新条目；普通路径不受影响
- [x] AC5：只读会话调用 `gitExecutable`（含 `path: null`）返回 `git/sandbox-denied` 且全局状态不变；`workspace-write`、`danger-full-access` 正常；设置页在只读会话中禁用输入并说明原因；挂载时补发被拒不显示错误
- [x] AC6：一个写操作进行中改 git 路径，该写操作所有命令用同一个 git，下一次写才用新路径；快照仍按钉住的文件身份逐条复核（ADR 0014 第 7 步）
- [x] AC7：ADR（追加到 0014 或新开）写明「只读会话不能设置 git 路径」与按写操作快照；`make check` 全绿

## 任务

### T1：变基 --root 前导 drop 的分支（完成）

- **涉及文件**：`src/shared/rebase-todo.ts`（`BuildTodoOptions.root`）、`src/host/git/interactive-rebase.ts`、`src/client/rebase/rebase-model.ts`、变基页提示与 locales
- **测试**：`test/shared/rebase-todo.test.ts` 新增 root 用例（非 root 保持原样）；`test/host/interactive-rebase.test.ts` 真实仓库先红后绿

### T2：搁架提示条绑定条目、refresh 序号（完成）

- **涉及文件**：`src/client/pages/ShelfPanel.tsx`（`notCleanId`、`confirmingDropId`，选中变化时清空）、`src/client/store/shelf-store.ts`
- **测试**：`test/client/shelf/` 下 happy-dom 用例（三方合并与删除两条路径）、store 乱序刷新用例

### T3：搁架拒绝子模块（完成）

- **涉及文件**：`src/host/git/shelf.ts`（create 前置检查；`treeEntry`/`indexEntry` 遇非 blob 显式报错）、`ShelfPanel.tsx` 搁置对话框、locales、`docs/references/` 补 mktree 对 gitlink 的实测
- **测试**：`test/host/shelf.test.ts` 未暂存/已暂存 gitlink、混合路径

### T4：worktree realpath 包含性检查（完成）

- **涉及文件**：`src/host/git/worktree.ts`（找到最深已存在祖先取 realpath，用 `sandbox-gate.ts` 的 `isWithinRoot` 判定；把解析后的路径交给 git；事后再查 `worktree list`，越界只报错不自动删）、`src/client/store/action-store.ts`、`src/client/locales/remotes.ts`
- **测试**：`test/host/remotes-worktrees.test.ts` 四种情形 + 回归；action-store 文案
- **残留风险**：检查之后、git 执行之前在不存在的段上新建符号链接，只能靠 confine 兜底

### T5：git 路径会话级门禁与按写操作快照（完成）

- **涉及文件**：`src/host/sandbox-gate.ts`（会话级判定：会话存活、policy 可用、非 read-only；不看仓库是否在工作区内，因为「找不到 git」与「仓库在沙箱外」都需要靠设置路径自救）、`src/host/rpc.ts`（`handleGitExecutable` 门禁；`handleWrite` 在队列内、门禁后取快照）、`src/host/git-executable.ts`（`snapshot()`）、`src/host/git-executor.ts`（`GitRunOptions.executable`、`resolveProgram`、`bindWriteContext`）、`src/client/GitBody.tsx`、`src/client/git-path.ts`、`SettingsSheet.tsx`、`git-missing.tsx`、locales、ADR
- **测试**：`test/host/rpc.test.ts` 门禁；`test/host/git-executable.test.ts` 快照；写操作中途改路径的 argv[0] 一致性；客户端 DOM 测试

## 进度

- 2026-10-30 — T1 完成（832703a，英文提示改为不分单复数 a091087）
- 2026-10-30 — T2+T3 完成（1e00173、e70e5e2）
- 2026-10-30 — T4 完成（7a3beb1）
- 2026-10-30 — T5 完成（7d571ef、68f7de2、79bfb1c）
- 2026-10-30 — 四组合并到 `t2-design-fixes`（`action-store.ts` 的 `INVALID_REASON_KEY` 冲突，两项都保留），合并后 `make check` 全绿（149 文件 / 2425 测试）
- 2026-10-30 — 整分支评审（独立子代理，无 Critical，「修复后可合并」）；I1、I2、M1、M2、M3、M6 已修，M4、M5 登记 TODO，`make check` 全绿（2429 测试）
- 2026-10-30 — L4 浏览器走查（隔离 DSH 3081，2370ed2 构建）：T1、T3、T4、T5 通过；顺带发现 2 个既有问题登记 TODO（见「意外与发现」）

## 下一步

- 无。2026-10-30 负责人验收通过并合并到 main。遗留项见 [TODO](../TODO.md)。

## 决策记录

- 2026-10-30 — T1 只在勾选 `--update-refs` 时提示「保持不动」（不勾选时分支本来就不动）。
- 2026-10-30 — T2 提示条状态按条目 id 记录，渲染时与当前选中比对；`refresh` 序号检查在成功/失败分支之前，过期的失败结果也丢弃。
- 2026-10-30 — T3 子模块判定：HEAD 或索引中 mode 160000，或工作区目录内有 `.git`；`treeEntry` 遇到 tree 仍返回 null（目录被新文件替换的场景）。客户端不改协议，见「意外与发现」。
- 2026-10-30 — T4 交给 git 的是解析后的真实路径；创建后复查只报错不删除。
- 2026-10-30 — T5 ADR 追加在 0014 末尾，未新开 0015（避免并行分支编号冲突）；只有 `read-only-mode` 会隐藏空状态入口，其他拒绝原因只静默补发错误。
- 2026-10-30 — 整分支评审处理：I1 只读会话「重新检测」无法从「版本过低」恢复（`set(null)` 被门禁拦，`info()` 缓存了旧探测）→ `info()` 不缓存低于最低版本的结果，ADR 0014 补一句；I2 Windows 下 `resolveInsideRepository` 只按 `/` 切分可绕过检查 → 与 `validateRepoPath` 一样按 `[\\/]` 切分（导出函数，带 platform 参数测试）；M1 取回时路径已变成子模块 → 新 reason `submodule-apply` 与取回语境的文案；M2 worktree 拒绝文案涵盖「目标本身是符号链接」；M3 `info/exclude` 写真实位置；M6 格式。
- 2026-10-29 — 本计划的接口变化（预先列出，需随计划批准）：协议层只新增错误 reason（`path-outside-repository`、`submodule`）以及 `gitExecutable` 可能返回已有错误码 `git/sandbox-denied`，请求/返回结构不变；Host 内部接口 `GitExecutable.snapshot`、`GitRunOptions.executable`、`bindWriteContext` 新参数。

## 意外与发现

- AC3 偏差：status 条目不带子模块标记，计划约定不改协议，所以只有未跟踪的内嵌仓库在对话框打开时就置灰；已跟踪的 gitlink 要等 Host 拒绝一次（整体拒绝，不会搁错）后才置灰。已登记 TODO（需协议改动）。
- 只读空状态偏差：bootstrap 失败时拿不到 writePolicy，「设置 git 路径」入口要先被 Host 拒绝一次才隐藏。已登记 TODO。
- `.claude/worktrees/` 下残留的子代理 worktree 会被不带 `--dir` 的 vitest 扫进去（`make check` 不受影响）。
- 搁架子模块问题的真实表现与 TODO 描述不同（见「现状」）。
- 搁架竞态同样会让「删除」作用到别的条目，比 TODO 原描述的三方合并更危险，一并修。
- L4 发现既有问题（非 t2 引入，`workbench-overlay.ts`、`shelf.ts` 该处本分支未改）：搁架「取回」不能干净应用时 Host 返回 `git/conflict`（`reason: 'shelf-not-clean'`），全局 `onConflict` 随即打开冲突列表，页面停在「读取中…」盖住搁架的提示条，要按「← 返回」才看到「三方合并应用」。已登记 TODO。
- L4 发现既有缺口：提交页开着「按 Changelist 分组」时文件右键菜单只有「移到 Changelist」，没有「搁置…」等条目（`ChangelistView.tsx`）。已登记 TODO。

## 验证记录

- 2026-10-30 合并与评审修复后 `make check`：2429 个测试通过，lint、类型检查、分层契约、构建与 smoke 通过；`pnpm-lock.yaml` 与 edeb88b 相同。
- 各 AC 均有真实仓库 Host 测试或 happy-dom 测试。
- 2026-10-30 L4 浏览器走查（隔离 HOME、DSH 3081、本仓库 2370ed2 构建；走查仓库为 scratchpad 临时仓库，含子模块 `sub`、未跟踪内嵌仓库 `nested/`、指向仓库外的 `.worktrees` 符号链接），截图在 `.evidence/t2/`：
  - AC1（T1）：日志右键根提交「从此处交互式变基…」，把 `commit 1` 设为 drop 并勾选 `--update-refs`，底部提示「first 将保持不动：从根变基时……」（`01-rebase-root-stays-put.jpg`）；开始变基后 `git log --all` 显示 `first` 仍在 ac702fe，main 被重写。通过。
  - AC3（T3）：勾选全部改动「搁置…」，对话框打开即标出「nested/ — 子模块，不能搁置」（`02-shelve-dialog-nested-grey.jpg`）；「搁置」被 Host 整体拒绝，提示子模块不能搁置，`sub` 随即置灰、文件数变 2（`03-shelve-submodule-refused.jpg`）；`git status` 与 `refs/worktree/dsh-git/shelf/` 均无变化。只勾 `f2.txt` 搁置成功；工作区改成别的内容后「取回」被拒、「三方合并应用」作用于该条目并进入冲突列表。通过（tracked gitlink 先拒后灰，与已记偏差一致）。
  - AC2（T2 选中竞态）：未在浏览器构造出刷新换选中的时序，依赖 happy-dom 测试；未验证。
  - AC4（T4）：Worktree 页「新建 Worktree…」分支 `escape`，位置 `.worktrees/escape`（`.worktrees` 链接到仓库外）→ 提示「这个位置要经符号链接，或经符号链接指向仓库外……」（`04-worktree-outside-refused.jpg`），没有新建分支、worktree，仓库外目录为空；换成真实目录后创建成功，`info/exclude` 写入 `/.worktrees/escape/`。通过。
  - AC5（T5）：会话切到「仅可查看」后出现只读横幅；设置页 git 路径输入框与「应用」禁用，提示「只读会话不能修改 git 路径：请在可写会话中设置」（`05-readonly-git-path-disabled.jpg`），客户端不发请求；页面内直接 POST `dsh-git/gitExecutable` 得到 `git/sandbox-denied`（`reasonCode: read-only-mode`）。切回「工作区内修改」后重新打开设置，输入框与按钮恢复可用。通过。未覆盖：「未找到 git」空状态（需要 PATH 上没有 git 启动 DSH）、写操作中途改路径的快照（Host 测试覆盖）。

## 阻塞

- 无。2026-10-30 负责人选择：变基 `--root` 前导 drop 的分支保持不动并提示；子模块行不可勾选、Host 收到含子模块的请求整体拒绝；只读会话的「未找到 git」空状态隐藏「设置 git 路径」入口；执行方式为子代理并行（T1、T2+T3、T4、T5 四组，各自 worktree，主会话合并后整分支评审）。RPC Result 上限保持 8 MiB 留在 TODO。
