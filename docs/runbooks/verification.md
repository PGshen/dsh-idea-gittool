# 自验证方法

SOP 的第 4 阶段（自验证）要求：**每条验收标准都有实际运行的证据**。证据的层级如下，按需选用，越往下越接近真实使用。

| 层级 | 方法 | 什么时候用 |
|---|---|---|
| L1 | `make check` | 每个任务都要跑；当前包含文档检查 + lint + 类型 + 分层契约 + 单测 |
| L2 | 针对性测试（`pnpm vitest run test/host/...`），用临时 git 仓库做集成 | 验证解析、门禁、刷新等内部流程 |
| L3 | 直接调用 RPC 处理器，或浏览器 Network 面板查看 `/dsh-git` 请求/响应 | 验证 Host 契约与错误封装 |
| L4 | 在本地 DSH Web GUI 中操作并截图 | 验证 tab、覆盖页、文档头部动作、只读横幅（单测看不出布局） |
| L5 | 真实仓库矩阵冒烟（`make smoke`，M0 后补，不进默认 `make check`） | 10k 提交、脏工作区、冲突中、仓库根在沙箱外、Windows CRLF |

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
2. 开启 flag：在 Git tab 所在页面的控制台执行 `localStorage.setItem('dsh-git.feature.mergeWindow', '1')` 后刷新（改回 `'0'` 或 `removeItem` 关闭；`MERGE_WINDOW_DEFAULT` 在验收前保持 `false`）。
3. 建冲突仓库（临时目录，用完删除）：

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
| 9 | 还有未解决块时点「应用更改」 | 出现二次确认「仍有 N 处未解决…」；确认后应用 | `06-apply-confirm.png` |
| 10 | 应用后回列表 | `f.txt` 进已解决；`git show :f.txt` 与工作区等于 Result（AC3） | `07-resolved.png` |
| 11 | 改动后「保存并关闭」；刷新页面；重新打开 `g.txt` | Result 与每块状态完全恢复；`git for-each-ref refs/worktree/dsh-git/merge-draft/` 有一条（AC7） | — |
| 12 | 用变基冲突仓库（建法见下方「变基两步冲突仓库」）：在第一步的 `f.txt` 窗口改动后「保存并关闭」；终端执行 `git checkout --ours f.txt && git add f.txt && git rebase --continue`（或 `git rebase --skip`）进入第二步冲突；重新打开 `f.txt` | 打开时提示草稿已作废、从 base 重新开始（索引三方变了）。旧草稿 ref 可能还在，直到操作经 DSH 继续/跳过/中止/提交时才清理（AC7） | — |
| 13 | 窗口有未保存改动时点横幅「解决冲突…」/ 仓库栏「获取」「推送」 | 先出现 保存/丢弃/取消；取消后留在窗口；`Esc` 同理（AC11） | `08-leave-guard.png` |
| 14 | 打开 `bin.dat`、`gone.txt` | 只有二选一 + 「在终端解决」，与 A3 列表行为一致（AC8） | `09-binary-fallback.png` |
| 15 | 列表「全部简单冲突」 | 提示「已解决 N 个文件，M 个文件需要手动处理」；只写回全部块可自动解决的文件，且标「未审查」（AC6、AC14） | `10-resolve-all-simple.png` |
| 16 | 底部按钮三态 | 选中未解决 → 「逐个解决」；只剩未审查 → 「审查更改」；都审查过 → 隐藏，提示「所有冲突都已解决」，「接受并完成」为主按钮；队列按 选中 → 未解决 → 已解决未审查 依次开窗，应用后自动下一个，在某个窗口返回即停止（AC14） | `11-review-queue.png` |
| 17 | 已解决行右键与 `Shift+F10` →「还原冲突解决」 | 回到未解决、工作区恢复冲突标记、草稿保留；菜单位置/焦点/`Esc` 回行正常；删除类提示「请在终端处理」（AC9） | `12-unresolve.png` |
| 18 | 重新打开已解决文件 | Result 等于工作区（自动合并/采用一侧保留块状态，手改的全部「已编辑」）；CRLF/autocrlf 仓库与末行无换行文件重点看 | — |
| 19 | 另一终端在窗口打开后改写同一文件，再点「应用更改」 | 提示文件已变化请重新加载，且不覆盖终端的写入（AC12） | `13-stale.png` |
| 20 | 打开一个超 2 MiB 或 20 000 行的冲突文件 | 降级为二选一 + 「在终端解决」（AC12）；差异极大的大文件是否出现粗分块提示 | — |
| 21 | 变基、拣选冲突各走一遍 | 变基：左栏为目标分支并提示「Git 的 ours 是目标分支」，应用后「继续变基」；拣选：右栏标题为短哈希，应用后「继续拣选」；合并：「接受并完成」（AC1、AC2） | `14-rebase.png`、`15-cherry-pick.png` |
| 22 | autocrlf 仓库应用一个文件 | 工作区为 CRLF、`git show :path` 为 LF（AC3） | — |
| 23 | 操作结束（继续/中止/提交）后 | `git for-each-ref refs/worktree/dsh-git/merge-draft/` 为空（AC7） | — |

### 宿主全屏与编辑器专项（T6 遗留）

- **CodeMirror 挂载与 HMR**：窗口正常渲染；改动 `lib/client.js` 触发热换后窗口不白屏、不重复注入 `<style>`、旧编辑器被销毁（控制台无 CodeMirror/React 警告）。
- **进入全屏**：`useTabInfo().sidebar.fullscreen` 在 `toggleFullscreen` 后及时更新；开发模式 StrictMode 下的双重挂载不会连续切换两次（最终状态为全屏，且只记为「窗口自己进入」一次）。
- **退出全屏**：只有窗口自己进入的全屏才在关闭时退出；用户在窗口打开期间自己点面板按钮退出了全屏，关闭窗口时不再切换（过期标志退出路径）；原本就是全屏或视口 <768px 时关闭窗口不动全屏状态。
- **焦点**：打开后焦点在 Result；关闭回到触发它的列表行；gutter 按钮 Tab 可达。
- **主题**：亮/暗主题下块色带与文字对比度可读。
- 控制台 `read_console_messages` 全程无错误；`read_network_requests` 看 `mergeFile`/`mergeApply` 请求/响应与错误码。

### 记录

走完后在计划「验证记录」写明：每个 AC 的实测结论（通过 / 不通过 / 未验证及原因）、截图路径、`lib/client.js` 体积。发现问题登记进计划「意外与发现」或 TODO。
