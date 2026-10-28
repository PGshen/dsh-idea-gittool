# 自验证方法

SOP 的第 4 阶段（自验证）要求：**每条验收标准都有实际运行的证据**。证据的层级如下，按需选用，越往下越接近真实使用。

| 层级 | 方法 | 什么时候用 |
|---|---|---|
| L1 | `make check` | 每个任务都要跑；当前包含文档检查 + lint + 类型 + 分层契约 + 单测 + 构建与产物 smoke（B4c 起） |
| L2 | 针对性测试（`pnpm vitest run test/host/...`），用临时 git 仓库做集成 | 验证解析、门禁、刷新等内部流程 |
| L3 | 直接调用 RPC 处理器，或浏览器 Network 面板查看 `/dsh-git` 请求/响应 | 验证 Host 契约与错误封装 |
| L4 | 在本地 DSH Web GUI 中操作并截图 | 验证 tab、覆盖页、文档头部动作、只读横幅（单测看不出布局） |
| L5 | 性能基准（`pnpm bench`、`pnpm bench:client`，B4c）与真实仓库矩阵（B4d 补），都不进默认 `make check` | 10k 提交、脏工作区、冲突中、仓库根在沙箱外、Windows CRLF |

## 记录证据

- 在计划的「验证记录」一节，逐条写明：验收标准编号、执行的命令或操作、输出摘要、结论。
- 截图和日志放在 `.evidence/<计划 id>/`（已进 `.gitignore`），计划里写明路径。
- 如果某条验收标准无法验证（例如需要 GUI 交互但没有可用浏览器），就明确写出"未验证"和原因，不能写成"通过"。

## 走查与冒烟的约定

- L4 走查用当前本地 DSH（`pnpm dsh web --patch ...`），不碰真实用户 profile；需要安装态时才执行 `dsh plugin add`，并先征得负责人同意。
- 冒烟测试用临时目录建仓库，不碰本仓库或用户仓库；用完删除临时目录。
- L5 真实仓库矩阵要在本机仓库副本或专门创建的测试仓库上跑，绝不 force push、不删分支、不改写历史。
- 证据只放 `.evidence/`，不提交进 git。

## 三栏合并窗口实机验证（B1，L4）

单测没有 DOM（CodeMirror 挂载、滚动同步、gutter 点击、宿主全屏、焦点都只能实机看）。由控制者在本地 DSH 上按下面的步骤走一遍，截图存 `.evidence/b1/`。

### 准备

1. `pnpm build`；按「本地挂载」启动 DSH（3081 端口，不占用负责人的 3080）。
2. 隔离的 DSH（临时 HOME、未登录、无 API Key）每次加载页面都会弹出宿主的「开始使用」登录对话框（`ui-primitives` `Modal`），它的遮罩是透明的、盖住整页（含右侧栏），点遮罩只会关掉对话框。所以刷新后先按 Esc 或点 × 关掉它，再操作 Git tab，否则第一次点击会被吞掉（B1 L4 误报过一次「第一次点『解决冲突…』没反应」，原因就是这个）。
3. flag：`MERGE_WINDOW_DEFAULT` 自 2026-10-27 验收通过后为 `true`，无需操作；要对照 A3 行为时在控制台执行 `localStorage.setItem('dsh-git.feature.mergeWindow', '0')` 后刷新（`removeItem` 恢复默认）。
4. 建冲突仓库（临时目录，用完删除）：

```bash
d=$(mktemp -d) && cd "$d" && git init -q -b main
printf 'l1\nl2\nl3\nl4\nl5\nl6\n' > f.txt; printf 'a\nb\nc\n' > g.txt; printf 'x\0y\n' > bin.dat; printf 'base\n' > gone.txt
git add . && git commit -qm base
git checkout -qb feature
printf 'F1\nl2\nl3\nl4\nfeature5\nl6\n' > f.txt; printf 'a\nfeature\nc\n' > g.txt; printf 'f\0y\n' > bin.dat; printf 'feature edit\n' > gone.txt
git commit -qam feature
git checkout -q main
printf 'l1\nl2\nM3\nl4\nmain5\nl6\n' > f.txt; printf 'a\nmain\nc\n' > g.txt; printf 'm\0y\n' > bin.dat; git rm -q gone.txt
git commit -qam main
git merge feature   # stops with conflicts: f.txt UU, g.txt UU, bin.dat binary, gone.txt DU
```

   变基两步冲突仓库（步骤 12 用，另建一个临时目录）：

```bash
d=$(mktemp -d) && cd "$d" && git init -q -b main
printf 'l1\nl2\nl3\n' > f.txt && git add . && git commit -qm base
git checkout -qb feature
printf 'l1\nT1\nl3\n' > f.txt && git commit -qam topic1
printf 'l1\nT2\nl3\n' > f.txt && git commit -qam topic2
git checkout -q main
printf 'l1\nMAIN\nl3\n' > f.txt && git commit -qam main
git checkout -q feature && git rebase main   # stops at topic1; after continue, topic2 conflicts on f.txt again
```

   把该目录作为 DSH 的工作目录打开 Git tab。变基/拣选各另建一份（`git rebase main` 在 feature 上；`git cherry-pick feature` 在 main 上）。再备一个 `core.autocrlf=true` 且文件为 CRLF 的冲突仓库。

### 步骤与检查项（括号内为验收标准）

| # | 操作 | 检查 | 截图 |
|---|---|---|---|
| 1 | 打开冲突列表 | 文本冲突行显示 `已解决块/总块`；二进制/删除类没有块计数（AC6） | `01-conflict-list.png` |
| 2 | 点 `f.txt` 行 | 自动进入宿主全屏；三栏挂载；标题为具体分支名 `main（当前分支）`/`feature（被合并）`，tooltip 写明 ours/theirs；左右栏内容与 `git show :2:f.txt`/`:3:f.txt` 一致；Result 从 base 开始（AC2、AC10） | `02-window-fullscreen.png` |
| 3 | 窗口宽度小于 768px（缩窗或开发者工具） | 不调用 `toggleFullscreen`，面板不塌；恢复宽度后再测 | `03-narrow.png` |
| 4 | 滚动任一栏 | 三栏同步、块对齐，无回环抖动（AC11） | — |
| 5 | 点 gutter 的 `»`/`«`/`×`；`Ctrl/Cmd+点击` | 逐块接受/忽略；Ctrl/Cmd+点击整块解决并忽略另一侧；按钮可 Tab 聚焦、有 aria-label；点击不抢走编辑器焦点（AC4） | `04-gutter.png` |
| 6 | 在 Result 里手动改一块 | 该块标「已编辑」，「解决简单冲突」「应用非冲突更改」不再动它；`Cmd/Ctrl+Z` 撤销块动作与手改（AC5） | `05-edited.png` |
| 7 | 底栏「应用非冲突更改 ▾」左/全部/右；「解决简单冲突」 | 只动非冲突块/简单冲突块并提示处理数；整文件「接受左侧/右侧」 | — |
| 8 | `F7` / `Shift+F7` | 跳到下/上一个未解决块；到末尾提示跳下一个文件。同时确认 `F7`、`Cmd/Ctrl+S`、`Esc` 没有被 DSH 快捷键系统先截走；编辑器里第一次 `Esc` 可能只是收起选区（AC11） | — |
| 9 | 还有未解决块时点「应用更改」 | 出现二次确认「N 处改动尚未采用，应用后这些位置保持共同祖先版本」；还有非冲突改动没采用时多一个「先应用非冲突更改」（应用后若都已解决则直接写回，否则按剩余数再问）；「仍然应用」后写回（裁定 21） | `06-apply-confirm.png` |
| 10 | 应用后回列表 | `f.txt` 进已解决；`git show :f.txt` 与工作区等于 Result（AC3） | `07-resolved.png` |
| 11 | 改动后「保存并关闭」；刷新页面；重新打开 `g.txt` | Result 与每块状态完全恢复；`git for-each-ref refs/worktree/dsh-git/merge-draft/` 有一条（AC7） | — |
| 12 | 用变基冲突仓库（建法见下方「变基两步冲突仓库」）：在第一步的 `f.txt` 窗口改动后「保存并关闭」；终端执行 `git checkout --ours f.txt && git add f.txt && git rebase --continue`（或 `git rebase --skip`）进入第二步冲突；重新打开 `f.txt` | 打开时提示草稿已作废、从 base 重新开始（索引三方变了）。旧草稿 ref 可能还在，直到操作经 DSH 继续/跳过/中止/提交时才清理（AC7） | — |
| 13 | 窗口有未保存改动时点横幅「解决冲突…」/ 仓库栏「获取」「推送」 | 先出现 保存/丢弃/取消；取消后留在窗口；`Esc` 同理（AC11） | `08-leave-guard.png` |
| 14 | 打开 `bin.dat`、`gone.txt` | 只有二选一 + 「在终端解决」，与 A3 列表行为一致（AC8） | `09-binary-fallback.png` |
| 15 | 列表「全部简单冲突」 | 提示「已解决 N 个文件，M 个文件需要手动处理」；只写回全部块可自动解决的文件，且标「未审查」（AC6、AC14） | `10-resolve-all-simple.png` |
| 16 | 底部按钮三态 | 选中未解决 → 「逐个解决」；只剩未审查 → 「审查更改」；都审查过 → 隐藏，提示「所有冲突都已解决」，「接受并完成」为主按钮；队列按 选中 → 未解决 → 已解决未审查 依次开窗，应用后自动下一个，在某个窗口返回即停止（AC14） | `11-review-queue.png` |
| 17 | 已解决行右键与 `Shift+F10` →「还原冲突解决」 | 先出现确认「还原「path」的冲突解决？当前已解决的内容会被冲突标记替换…这里无法撤销」（裁定 20），取消/`Esc` 不改动；确认后回到未解决、工作区恢复冲突标记；菜单位置/焦点/`Esc` 回行正常；删除类在确认条里提示「请在终端处理」（AC9） | `12-unresolve.png` |
| 18 | 重新打开已解决文件 | Result 等于工作区（自动合并/采用一侧保留块状态，手改的全部「已编辑」）；CRLF/autocrlf 仓库与末行无换行文件重点看 | — |
| 19 | 另一终端在窗口打开后改写同一文件，再点「应用更改」 | 提示文件已变化请重新加载，且不覆盖终端的写入（AC12） | `13-stale.png` |
| 20 | 打开一个超 2 MiB 或 20 000 行的冲突文件 | 降级为二选一 + 「在终端解决」（AC12）；差异极大的大文件是否出现粗分块提示 | — |
| 21 | 变基、拣选冲突各走一遍 | 变基：左栏为目标分支并提示「Git 的 ours 是目标分支」，应用后「继续变基」；拣选：右栏标题为短哈希，应用后「继续拣选」；合并：「接受并完成」（AC1、AC2） | `14-rebase.png`、`15-cherry-pick.png` |
| 22 | autocrlf 仓库应用一个文件 | 工作区为 CRLF、`git show :path` 为 LF（AC3） | — |
| 23 | 操作结束（继续/中止/提交）后 | `git for-each-ref refs/worktree/dsh-git/merge-draft/` 为空（AC7） | — |
| 24 | 打开窗口**之前**在终端把 `g.txt` 改成不含冲突标记的内容（模拟手改 / Agent / rerere），再打开 `g.txt` | 窗口顶部警示「工作区里的这个文件已被修改（不再含冲突标记），应用会覆盖这些修改」；即使全部块已解决，「应用更改」也先确认（裁定 19）；列表「全部简单冲突」把它计入「需要手动处理」且不写回 | `16-overwrite-warning.png` |
| 25 | 已解决文件存过草稿（「审查更改」打开 → 改动 → 保存并关闭），再在终端改它的工作区内容后重新打开 | Result 为草稿内容，提示「草稿与工作区不同，应用后以草稿为准」（裁定 20） | — |
| 26 | 符号链接冲突（两侧把同一个链接指向不同目标）、子模块冲突 | 不挂编辑器：符号链接给「采用 …」+「在终端解决」，子模块只有「在终端解决」；降级视图里「保存并关闭」禁用 | — |

### 宿主全屏与编辑器专项（T6 遗留）

- **CodeMirror 挂载与 HMR**：窗口正常渲染；改动 `lib/client.js` 触发热换后窗口不白屏、不重复注入 `<style>`、旧编辑器被销毁（控制台无 CodeMirror/React 警告）。
- **进入全屏**：`useTabInfo().sidebar.fullscreen` 在 `toggleFullscreen` 后及时更新；开发模式 StrictMode 下的双重挂载不会连续切换两次（最终状态为全屏，且只记为「窗口自己进入」一次）。
- **退出全屏**：只有窗口自己进入的全屏才在关闭时退出；用户在窗口打开期间自己点面板按钮退出了全屏，关闭窗口时不再切换（过期标志退出路径）；原本就是全屏或视口 <768px 时关闭窗口不动全屏状态。
- **焦点**：打开后焦点在 Result；关闭回到触发它的列表行；gutter 按钮 Tab 可达。
- **主题**：亮/暗主题下块色带与文字对比度可读。
- 控制台 `read_console_messages` 全程无错误；`read_network_requests` 看 `mergeFile`/`mergeApply` 请求/响应与错误码。

### 尚未覆盖、负责人验收时补（B1 终审，2026-10-27）

控制者 L4 走查（面板隐藏、未截图）之外，以下几项只有单测或完全没有实测，验收演示时逐项看：

- **AC7 重启恢复**：「保存并关闭」后**重启 DSH 进程**（不只是刷新页面），再打开同一文件，Result 与块状态完全恢复。
- **AC7 三方变化作废提示**：步骤 12 的「草稿已作废」提示在 UI 上出现（目前只有 store/Host 测试）。
- **AC9 `Shift+F10` 键盘菜单**：已解决行聚焦后按 `Shift+F10`（或 ContextMenu 键）打开菜单、↑↓/Enter 可用、`Esc` 回行。
- **AC11 `Cmd/Ctrl+S`**：在窗口里按下后保存草稿（提示「草稿已保存」），浏览器「保存网页」对话框不出现、DSH 快捷键系统没有先截走。
- **AC10 StrictMode 与过期标志**：开发模式双重挂载只切换一次全屏；窗口打开期间用户手动退出全屏，关闭窗口时不再切换。
- **截图**：至少 AC1（合并/变基/拣选完成）与 AC10（进入/退出全屏、<768px）存 `.evidence/b1/`。
- **RPC 载荷**：经真实 HTTP 应用一个接近上限的文件（Result 接近 2 MiB / 单侧 20 000 行；`mergeApply` 上限 8 MiB），确认请求不被宿主 RPC 层拒绝、耗时可接受（见 TODO「RPC 载荷上限」）。

### 记录

走完后在计划「验证记录」写明：每个 AC 的实测结论（通过 / 不通过 / 未验证及原因）、截图路径、`lib/client.js` 体积。发现问题登记进计划「意外与发现」或 TODO。

## 历史与 Blame 实机验证（B2，L4）

### 准备隔离 DSH（不碰负责人的 profile 与 3080）

1. 在 worktree 里 `pnpm build`（worktree 内运行 pnpm 要带 `pnpm_config_verify_deps_before_run=false`，否则 lockfile 会被改写，见 b2 计划决策记录）。
2. 临时 HOME：`H=<scratchpad>/dsh-home`，`mkdir -p $H/.dsh/profiles && cp -R ~/.dsh/profiles/web $H/.dsh/profiles/web`；把复制件里的 `node_modules/dsh-idea-gittool` 软链和 `package.json` 的 `link:` 改成 worktree 的绝对路径。
3. `cd /Users/peng/Me/Ai/deepseek-harness && HOME=$H pnpm dsh web --no-open --port 3081`，日志里取带 token 的地址打开；先按 Esc 关掉「开始使用」对话框。
4. 工作区指向走查仓库：「添加工作区」是原生目录选择器，自动化选不了。停掉 DSH，改 `$H/.dsh/storages/workspace.json` 里某个工作区的 `path`/`title`，以及 `storages/session_projcache/sessions/<会话>.json` 里的 `cwd`，再启动；在该工作区里新建会话，Cmd+Shift+G 打开 Git tab。Host 代码改动要重启 DSH，Client 改动 `pnpm build` 后热更。
5. 内置浏览器截图常滞后一帧：判断以 DOM/文本读取为准，截图连截两张取第二张。

### 走查要点

| # | 操作 | 期望 |
|---|---|---|
| 1 | 日志选提交 → 变更文件右键 | 显示 Diff / 文件历史 / Blame（此版本）/ 与工作区比较 / 复制路径 |
| 2 | 改过名的文件「文件历史」→ 选重命名前的提交 | M/R/A 都在，「历史可能不连续」，diff 按旧路径取，短哈希 |
| 3 | 「Blame（此版本）」→「← 返回」 | 回到文件历史，选中与 diff 保留 |
| 4 | 提交页变更树右键有改动的文件 →「Blame」 | 未提交行显示「未提交」，与 `git blame --root -s` 一致；hover card 不透明；双击底部显示该提交改动 |
| 5 | 4500 行文件 Blame →「加载更多」到底 → Esc | 行号连续到 4500，按钮消失，Esc 仍能关闭 |
| 6 | 二进制 / 空文件 / CRLF 的 Blame | 「二进制文件…」不显示行数 / 「空文件」/ 3 行不丢最后一行 |
| 7 | 分支右键「与当前分支比较」→ 点文件 →「交换」；「与工作区比较」 | 与 `git log right..left`、`git diff --name-status right...left`、`git diff --name-status <rev>`（同一 HOME）一致 |
| 8 | 日志 Cmd+点击选两个提交 → 右键 | 「比较所选的两个提交」可用；只选一个时禁用并说明 |
| 9 | 文件页打开文件预览 → 头部 Blame / 历史 / Diff / 状态徽标；换一个文件再点 Blame | 同一个 Blame 标签换内容；历史、Diff 切到 Git tab；徽标切到提交页选中该文件；干净文件 Diff 禁用；宽头部不收进 ⋯ |

## 交互式变基实机验证（B3a，L4）

准备同 B2（隔离 HOME、3081）。补充：

- 工作区记录要带 `createdAt`/`updatedAt`（ISO 字符串），否则 `workspaceRegistry` 报 `does not match its schema`，整个工作区服务挂起（2026-10-27 实测）。
- flag 自 2026-10-28 默认开启，无需操作；要对照关闭时的行为，在控制台执行 `localStorage.setItem('dsh-git.feature.interactiveRebase', '0')` 后刷新（`removeItem` 恢复默认）。
- 走查仓库：`git init -b main` 后连做 5 个提交（每个改一个文件），`git branch mid HEAD~2`。

| # | 操作 | 期望 |
|---|---|---|
| 1 | 日志右键任一提交 | 末组出现「从此处交互式变基…」「修改提交信息…（F2）」「丢弃提交…」（危险色）「压缩所选提交…」（只选一个时禁用并说明） |
| 2 | 「从此处交互式变基…」 | 覆盖页按旧→新列出该提交及之后的提交，`mid` 标在对应行；没改动时「开始变基」禁用并显示「没有任何改动」 |
| 3 | 列表上按 `d`、`Alt+↑`、`s`、`r`，在信息框改 reword 的信息（含 `"` 与 `$(…)`）；「预览 todo」 | 动作与顺序随按键变化；squash 组的默认信息是两条信息拼接；预览里写回信息的 exec 行显示为「# 写回上面这组的提交信息」，squash 行变成 fixup |
| 4 | 勾选 `--update-refs` →「开始变基」 | 覆盖页关闭、日志刷新；`git log` 与列表一致、信息原样、`mid` 移到合并后的提交 |
| 5 | 日志选中提交按 `F2`，把动作改成 edit →「开始变基」 | 横幅「正在变基 1/2」+「已在 edit 处停下…」；提交页回到普通模式，可勾选文件 + Amend |
| 6 | 改文件 → 提交页 Amend → 横幅「继续」 | 被 edit 的提交包含改动；变基结束、横幅消失 |

## Diff 增强与提交菜单实机验证（B3b，L4）

准备同 B3a。并排模式要求 Diff 内容区 ≥ 900px：内置浏览器默认视口不够时用 `resize_window` 加宽（或负责人用宽屏 + 右侧栏全屏）。

| # | 操作 | 期望 |
|---|---|---|
| 1 | 提交页双击有改动的文件 → 工具栏 | 「统一 / 并排 / 忽略空白 / 完整文件」；窄时「并排」禁用并说明；按下态可见 |
| 2 | 「并排」 | 左右两栏、行号与统一视图一致；刷新后仍是并排 |
| 3 | 只改了空白的文件 →「忽略空白」 | 「没有文本差异（已忽略空白）」 |
| 4 | 「完整文件」 | 整个文件一个 hunk，长段未改内容折叠为「展开 N 行未改内容」；`n`/`p` 跳变更块 |
| 5 | 日志右键 | 「撤销提交…（仅 HEAD）」「推送直到此提交…」「新建标签…」「Fixup / Squash 到此提交…（需先在提交页勾选文件）」「创建补丁…」 |
| 6 | 勾选文件 →「Squash 到此提交…」写说明 | 目标提交包含改动，信息末尾追加说明；未勾选改动先问贮藏、结束后恢复 |
| 7 | 「创建补丁…」→ 下载 / 复制；仓库栏 ⋯「应用补丁…」粘贴 → 预览 → 应用 | 文件名 `<短哈希>-<主题>.patch`；普通 diff 进暂存区，邮件格式用 `git am` |

## 搁架与 Changelist 实机验证（B3c，L4）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 提交页勾选两个文件 → 右键其中一个「搁置…」→ 搁置 | 两个文件回到 HEAD；`git for-each-ref refs/worktree/dsh-git/shelf/` 有一条；`git stash list` 不变 |
| 2 | 贮藏页 →「搁架」分段 | 条目显示名字、分支、文件数、时间；下方是补丁预览 |
| 3 | 把其中一个文件改成别的内容 →「取回」 | 提示不能干净应用、文件不变；「三方合并应用」后进入冲突列表 |
| 4 | 提交页勾「按 Changelist 分组」→ 新建 Changelist → 右键文件「移到 Changelist」 | 文件出现在新列表；组头三态勾选只影响本组；刷新页面后分组与分配保持 |

## Worktree 与远程实机验证（B3d，L4）

准备：走查仓库加一个本地 bare 远程（`git init --bare ../walk-bare && git remote add origin ../walk-bare && git push -u origin main`），推一个 `topic` 分支，再建一个没有 upstream 的本地分支和一个标签。Worktree 入口的 flag `worktrees` 自 2026-10-28 默认开启（`localStorage.setItem('dsh-git.feature.worktrees', '0')` 可关闭对照）。

| # | 操作 | 期望 |
|---|---|---|
| 1 | 仓库栏 ⋯ →「管理远程…」→ 添加 `https://user:pass@example.com/r.git` | 列表只显示 `https://***@example.com/r.git`；页面文本里没有 `pass`；删除后列表恢复 |
| 2 | 分支页标签右键「推送标签…」→ origin | `git ls-remote --tags origin` 出现该标签 |
| 3 | 标签右键「删除标签…」，勾「同时删除远程上的同名标签」（默认不勾） | 本地与远程都没有该标签 |
| 4 | 远程分支 `origin/topic` 右键「删除远程分支…」 | `git ls-remote --heads origin` 与 `git branch -r` 都没有 `topic` |
| 5 | 本地分支右键「设置 upstream…」选 `origin/topic`，再「取消 upstream」 | `git rev-parse --abbrev-ref <b>@{upstream}` 先等于所选，后报无 upstream；分支行右侧同步显示/消失 |
| 6 | 本地分支右键「在新 Worktree 中签出…」 | 默认位置 `.worktrees/<分支>`；创建后 `git worktree list` 多一条 |
| 7 | ⋯ →「Worktree…」：在有改动的 worktree 上「删除…」→「删除」 | 提示有未提交改动，按钮变「仍然删除」；确认后目录消失 |
| 8 | 手动 `rm -rf` 一个 worktree 目录后打开 Worktree 页 →「清理」 | 该行先标「目录已不存在」，清理后消失，提示「已清理 1 条记录」 |
| 9 | 「新建 Worktree…」输入新分支名 | 位置随分支名自动填 `.worktrees/<名>`；创建后新分支指向当前 HEAD |


## 设置与 Blame 渲染器实机验证（B4a，L4）

准备同 B2（隔离 HOME），补充三点（2026-10-28 实测）：

- 3081 可能已被另一个 DSH 占用，换 3082；临时 HOME 下 Corepack 会重新下载 pnpm 并卡在提示，启动时带 `COREPACK_HOME=$HOME_REAL/.cache/node/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0`。
- 复制的 profile 里 `node_modules/dsh-idea-gittool` 是相对软链，复制后会断，改成本仓库绝对路径。
- `storages/workspace.json` 里手写的工作区行必须带 `createdAt`/`updatedAt`（ISO 字符串），否则 workspaceRegistry 校验失败、工作区一直「正在加载」。工作区出现后点它右侧的「+」即可新建该工作区的会话。

设置值可在控制台用 `localStorage.getItem('dsh-idea-git.settings.v1')` 对照；模拟「另一个标签页改了设置」：`setItem` 后 `window.dispatchEvent(new StorageEvent('storage', { key: 'dsh-idea-git.settings.v1' }))`。

| # | 操作 | 期望 |
|---|---|---|
| 1 | 仓库栏 ⋯ →「设置…」；Esc | 弹层列出全部设置、「确认破坏性操作：始终开启」；焦点先落在「自动刷新」，Esc 关闭后回到 ⋯ |
| 2 | 打开紧凑模式、日期格式选相对 | 日志行 24px，无作者/哈希列，日期为「N 分钟前」（面板 <720px 时日期列本来就隐藏） |
| 3 | 刷新间隔 1 秒 / 10 秒，各观察 6 秒 `/dsh-git/bootstrap` 请求数 | 约 6 次 / 0 次 |
| 4 | 关闭自动刷新后刷新页面 | 状态栏自动刷新按钮 `aria-pressed=false`，5 秒内无 bootstrap 轮询 |
| 5 | 「提交后」选跳到日志，在提交页提交一个文件 | 切到日志页并选中新提交 |
| 6 | 关闭「自动打开冲突列表」，终端 `git merge` 出冲突 | 只出现横幅，不弹冲突列表；同一操作中再打开设置也不弹；`merge --abort` 后打开设置再合并 → 自动弹出 |
| 7 | 打开「自动应用非冲突更改」，冲突文件「逐个解决」 | Result 已含两侧独有改动、冲突块仍待处理；「撤销」回到 base |
| 8 | 打开「使用 Git Blame 渲染器」，文件页打开已跟踪文件、未跟踪文件；关掉再打开 | 已跟踪文件默认「Git Blame」带 gutter；未跟踪显示原文与「还没有被 Git 跟踪」；关闭后已开 tab 立即回到「代码」，再打开又回来；控制台无插件错误 |

## 对比度测量（B4b，L4）

在隔离 DSH 里打开 Git tab 后，把 `scripts/contrast-probe.mjs` 去掉 `export ` 关键字贴进页面控制台（或经 `javascript_tool` 执行），然后：

- `probeContrast([{ name, selector, fg: 'color', min }])`：取首个匹配元素的计算色，叠加到逐层合成的有效背景上，按 WCAG 2 算比值。`fg` 可为 `color`/`stroke`/`fill`/`outline-color`。
- 提交图 lane：在 `.graph_graph` 元素上临时设 `style.color = var(--git-lane-N)` 读计算色（`--git-lane-*` 只在 `.graph` 作用域内定义，放到外面的临时元素读不到）。
- 暗色：`document.body.setAttribute('data-ds-dark-theme', '')` 后再测一遍，测完移除（DSH 的明暗切换就是这个属性）。
- 阈值（设计 §15.5）：正文 ≥4.5，次要文字/状态字母/徽标 ≥3，图形线 ≥3。成功/警告色与 `--dsw-static-*` 直接当文字色在浅色下只有约 2.2:1，样式检查会拦，改用 `color-mix(in oklab, var(<hue>) 60%, var(--dsw-alias-label-primary))`。
- 切换 Git tab 内的页面可用 `[...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.startsWith('提交')).click()`；走查构建要在独立 worktree 里做（负责人的 web profile 链接到主 checkout 的 `lib/`，在主 checkout 构建会热更进负责人的 3080）。

## 性能基准（B4c，L5）

两个脚本都不进 `make check`，结果写进计划「验证记录」，原始 JSON 与截图放 `.evidence/<计划 id>/`。

### Host：`pnpm bench`

- 在系统临时目录用 `git fast-import` 生成 10k 合成仓库（`scripts/bench/fixture.mjs`，同参数逐字节一致：每 50 个提交一次合并、20 个 topic 分支、50 个标签、4500 行的 `big.txt`、>256 KiB 的 `huge.txt`、20 个已修改 + 5 个未跟踪文件），用完删除。`BENCH_COMMITS=300 pnpm bench` 可快速试跑。
- 直接调真实 RPC 处理器（`test/host` 的 subprocess 替身跑真实 git，执行器参数与 `src/host/index.ts` 一致，含 `directBinary`），每项 1 次预热 + 7 次计时；每个样本用新处理器（不吃缓存），bootstrap 另测「同一处理器、时钟每次前进 3s」的稳态轮询。
- 对照设计 §16.8：bootstrap 稳态 ≤ 50ms、log 首页 ≤ 500ms、commit ≤ 200ms、单文件 diff ≤ 300ms（>256 KiB 必须 `truncated`）、branches ≤ 100ms、单响应 ≤ 4 MiB；其余项只记录，超 500ms 要说明。任一门槛项超标时退出码 1。
- **用 `pnpm bench` 跑，不要直接 `node`**：在 pnpm 启动的进程里，macOS `/usr/bin/git`（xcrun 转发器）每次启动多付约 40ms，这正是开发期 `pnpm dsh web` 的真实环境（references §17）。

### 客户端：`pnpm bench:client`

- 构建 `scripts/bench-client/`（真实 `LogPage` + 2000 行合成提交、每 7 个一次合并）到 `.evidence/b4c/harness/`；用静态服务器（如 `python3 -m http.server <端口> --bind 127.0.0.1`，在该目录下运行）打开 `index.html`，控制台执行 `await harness.measure()` 与 `await harness.measure({ compact: true })`。
- 每步：设 `scrollTop`、派发 scroll、用 `MessageChannel` 让出一次、强制布局；共 300 步滚到底。判定：中位 ≤ 2ms、最大 ≤ 18ms、行 DOM ≤ 60、`staleSteps`（渲染出的行没覆盖当前滚动位置的步数）必须为 0——不为 0 说明没有真的滚动（例如选错了滚动容器：滚动容器是 `role="grid"` 元素本身）。
- 后台/隐藏的页面没有 rAF，判断以前台可见页的数据为准。

### L4 补充（隔离 DSH）

- 首屏：关掉 Git 标签后，在页面里挂一个 capture 阶段的 keydown 监听记下 Cmd+Shift+G 的时刻，用 1ms 轮询记录「获取」按钮（仓库栏）与 grid 内 >10 行出现的时刻（MutationObserver 在这里不可靠）。
- 内存：`performance.memory.usedJSHeapSize`，Git 标签关闭时为基线，再加载满 2000 行、5 次双击打开/Esc 关闭 >256 KiB 的 diff（单击文件只选中，双击才打开 diff）。
- 按需 chunk：`performance.getEntriesByType('resource')` 过滤 `client.merge`，打开合并窗口前应为 0 个、打开后 1 个、再次打开不增加。带 `rev` 的 chunk URL 会被缓存，移走 `lib/client.merge.js` 模拟不出加载失败。
