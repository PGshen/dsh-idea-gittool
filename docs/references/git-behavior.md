# Git 行为实测：resolve-undo、还原冲突解决与经索引写回（B1 T1 spike）

- 日期：2026-10-26
- git：`git version 2.50.1 (Apple Git-155)`，macOS（Darwin 24.6.0）
- 来源：本机实测 + git 官方文档（`git-checkout(1)` 的 `-m`、`git-update-index(1)` 的 `--unresolve`/`--cacheinfo`、`git-ls-files(1)` 的 `--resolve-undo`、`gitformat-index(5)` 的 resolve-undo 扩展）
- 方法：与 A3 T1 相同（[可行性调研 §13](dsh-integration-feasibility.md)「stdin 与长路径」）：按 `dsh-sandbox-local` 的 `seatbeltProfileArgs` + `dsh-sandbox` 的 `writableRoots` 拼出 `workspace-write` 的 SBPL，用 Node `spawn('/usr/bin/sandbox-exec', ['-p', profile, '--', 'git', '--no-pager', '-c', 'core.fsmonitor=false', ...])` 执行，stdin 用 `'pipe'` + `end()`；环境变量与 `GIT_WRITE_ENV` 一致（`GIT_LITERAL_PATHSPECS=1`、`LC_ALL=C`、`GIT_CONFIG_COUNT=0` 等）。造冲突的准备步骤不受限执行，**被验证的命令全部在 confine 下执行**。仍是等价复现，不是经 3081 Host 的端到端调用（端到端放在 T3 真实仓库测试 + T6 实机）。
- 脚本 `.evidence/b1/spike.mjs`，输出 `.evidence/b1/spike.log`（`.evidence/` 不入库；重跑 `node .evidence/b1/spike.mjs`，最后一行应为 `RESULT: all expectations met`）。

## 1. resolve-undo 与「还原冲突解决」

| 结论 | 状态 | 证据 |
|---|---|---|
| 冲突文件用 `git add`（A3「标记已解决」/「采用 …」都走 add）解决后，`git ls-files --resolve-undo` 列出该路径原来的 1/2/3 stage（`<mode> <sha> <stage>\t<path>`，与 `ls-files -u` 同格式），`cat-file blob <sha>` 能读出内容。Review Changes 打开已解决文件时三方可以从这里取 | ✅ 2026-10-26 | spike S1e/S1f |
| **合并**：`git add` 之后 `git checkout -m -- <path>` 退出 0，索引恢复 1/2/3 stage，工作区重新写入冲突标记 | ✅ 2026-10-26 | spike S1g |
| **变基**：同上（第 1 步冲突、`add` 后 `checkout -m` 恢复） | ✅ 2026-10-26 | spike S2b |
| **拣选**：同上 | ✅ 2026-10-26 | spike S7 |
| 用 `git rm` 解决的 **UU**（「删除文件」）同样能被 `checkout -m` 恢复（三方都在） | ✅ 2026-10-26 | spike S1j |
| `checkout -m` 写出的标记标签是字面的 `<<<<<<< ours` / `>>>>>>> theirs`，不是分支名（与合并当时 git 写的 `<<<<<<< HEAD` / `>>>>>>> feature` 不同）。窗口只读索引三方（决策 D2），不受影响 | ✅ 2026-10-26 | spike S1g 输出 |
| **删除类冲突 `checkout -m` 不能恢复**：DU 用 `git rm` 解决、UD 用 `checkout --ours` + `add` 解决后，`checkout -m -- <path>` 退出 1：`error: path '<p>' does not have all necessary versions`。失败后索引不变（仍是已解决）、resolve-undo 记录**保留** | ✅ 2026-10-26 | spike S1h/S1i |
| 删除类冲突可以用 `git update-index --unresolve -- <path>` 恢复索引的 unmerged 条目（DU 恢复 1/3、UD 恢复 1/2；会消耗该路径的 resolve-undo 记录），工作区不动；再 `git checkout --theirs`（或 `--ours`，取存在的那一侧）把文件写回工作区，索引保持未解决 | ✅ 2026-10-26 | spike S1k/S1l/S1m；`update-index --unresolve` 对 UU 也有效但不改工作区 |
| resolve-undo **不随操作结束而清除**：合并提交之后、再做普通提交之后，`ls-files --resolve-undo` 仍列出旧条目；切换分支（`checkout`，unpack_trees）会清掉；**开始下一次合并**、**变基进入下一步**（`rebase --continue`）时也是空的 | ✅ 2026-10-26 | spike S1 尾部、S1'、S2 |

推论（给 T2/T3/T7）：

- resolve-undo 只在「有操作进行中，且路径在本次操作的已解决列表里」时才可信；操作结束后的残留条目不能拿来恢复冲突（契约已规定 `unresolveConflict` 的路径必须在已解决列表里，否则 `git/stale-target`）。
- A3 的 `operationState.resolved` 定义是「已无冲突、相对 HEAD 有暂存改动」，会包含**自动合并、从未冲突过**的路径；这些路径没有 resolve-undo，`mergeFile` 读不到三方、`unresolveConflict` 只能走 `git/exec-failed`。T2/T7 需要区分「已解决（有 resolve-undo）」与「仅有暂存改动」。
- 删除类冲突的还原：按契约当前写法（只用 `checkout -m`）会得到 `git/exec-failed`；若要支持，需改为 `update-index --unresolve` + `checkout --ours|--theirs`（见 T1 报告的选项，待负责人/控制者决定，T1 不改契约）。

## 2. 经索引写回（mergeApply 链路）

| 结论 | 状态 | 证据 |
|---|---|---|
| confine 下 `hash-object -w --stdin --path=<p>`（stdin 写入 Result）→ `update-index --cacheinfo <mode>,<sha>,<p>` → `checkout-index -f -- <p>` 全部退出 0；`--cacheinfo` 写入 stage 0 的同时清掉 1/2/3 stage，`ls-files -u` 为空 | ✅ 2026-10-26 | spike S3 |
| 写回后工作区内容等于 Result；`status --porcelain=v2` 只剩 `1 M.`（已暂存），没有工作区改动——`checkout-index -f` 同时刷新了索引的 stat 信息 | ✅ 2026-10-26 | spike S3 |
| **`update-index --cacheinfo` 也会记录 resolve-undo**（和 `add` 一样），所以经窗口「应用更改」的文件之后同样能用 `checkout -m` 还原 | ✅ 2026-10-26 | spike S3 末尾 |
| `core.autocrlf=true`：Result 用 LF 传入时，索引 blob 为 LF、工作区为 CRLF；Result 已是 CRLF 时 `hash-object --path` 经 clean filter 得到**同一个** LF blob | ✅ 2026-10-26 | spike S4 |
| stage 2 的 mode 为 `100755` 时，用它做 `--cacheinfo` 的 mode，索引保持 `100755`、`checkout-index` 写出的文件带执行位 | ✅ 2026-10-26 | spike S5 |
| workspaceRoot 是仓库子目录（`.git` 在 confine 边界外）时，`update-index` 被拒：`fatal: Unable to create '<repo>/.git/index.lock': Operation not permitted`（退出 128），与 A2/A3 的沙箱拒绝形态一致 | ✅ 2026-10-26 | spike S6 |

## 3. 未覆盖、留给后续任务

- 带 `filter=lfs` 等外部 clean/smudge 过滤器的仓库（`hash-object --path` 会调用过滤器进程，confine 下过滤器写缓存目录可能失败）：⚠️ 未实测，T3 遇到再补。
- `merge.conflictStyle=zdiff3`、非默认 `conflict-marker-size`：窗口不读标记（D2），只影响 `checkout -m` 写回工作区的标记样式，不影响功能。
- 经 3081 Host 的端到端调用：T3 真实仓库测试 + T6 实机复验。

## 4. 交互式变基的驱动方式（B3a T1 spike）

- 日期：2026-10-27；git `2.50.1 (Apple Git-155)`，macOS Seatbelt
- 方法：纯 git 脚本 `.evidence/b3a/spike.sh`（停下状态与边界）+ Seatbelt 等价复现 `.evidence/b3a/spike.mjs`（与第 1 节同法，输出 `.evidence/b3a/spike.log`）。仍不是经 3081 Host 的端到端调用（放在 b3a T3 真实仓库测试 + T7 实机）。

| 结论 | 状态 | 证据 |
|---|---|---|
| `GIT_SEQUENCE_EDITOR='cat >'` + stdin 传 todo：git 以 `sh -c 'cat > "$@"'` 调用编辑器，stdin 继承自 git，todo 被原样写入；confine 下可用 | ✅ 2026-10-27 | spike.mjs「rebase -i (reword+reorder+update-ref)」 |
| 信息先 `hash-object -w --stdin` 存 blob，todo 中 `exec git cat-file blob <sha> \| git commit --amend --no-verify --allow-empty -F -` 写回：信息含引号、`$()`、反引号、`#` 开头行、中文时**原样**保存（`-F` 不经编辑器，默认 cleanup 为 whitespace，不删 `#` 行），`$()` 未被执行；作者与作者时间保留 | ✅ 2026-10-27 | spike.sh (a)(b)、spike.mjs `message exact: true`、`pwn file created: false` |
| `edit` 停下时 **`git rebase -i` 退出 0**（不能靠退出码判断完成）；`rebase-merge/` 存在，`done` 末行 `edit <sha>`，有 `amend` 与 `stopped-sha` 文件 | ✅ 2026-10-27 | spike.sh (c)(d) |
| `edit` 停下后 `rebase --continue` 继续执行后续的 `exec` 行（信息写回生效） | ✅ 2026-10-27 | spike.sh (c) |
| `exec` 失败：退出 1，`done` 末行是该 `exec` 行，无 `stopped-sha`/`amend`；HEAD detached；`rebase-merge/no-reschedule-failed-exec` 存在，即 `--continue` 不重跑失败的 `exec` | ✅ 2026-10-27 | spike.sh「exec failure」 |
| 冲突停下：退出 1，`done` 末行是冲突的 `pick`，有 `stopped-sha`，无 `amend`，索引有 unmerged 条目 | ✅ 2026-10-27 | spike.sh「conflict stop」 |
| **`--update-refs` 依赖 todo 中的 `update-ref refs/heads/<b>` 行**：`cat >` 覆盖了 git 生成的 todo，自带的 `update-ref` 行一并被覆盖；todo 不写这一行时，指向被改写提交的其他分支留在旧提交上 | ✅ 2026-10-27 | spike.mjs 两次对照 |
| todo 只含 `drop` 行（全部丢弃）可以执行；todo 为空（无任何命令）时报 `error: nothing to do`、退出 1 | ✅ 2026-10-27 | spike.sh 末两段 |
| `exec`/`update-ref` 行计入 `msgnum`/`end` 步数（「Rebasing (2/5)」），横幅显示的步数比提交数多 | ✅ 2026-10-27 | spike.mjs stderr |
| **环境变量 `GIT_SEQUENCE_EDITOR` 优先于 `-c sequence.editor`**：插件写环境 `GIT_WRITE_ENV` 设了 `GIT_SEQUENCE_EDITOR=true`，此时 `-c sequence.editor='cat >'` 不生效（`git var GIT_SEQUENCE_EDITOR` 输出 `true`），git 用自己生成的 todo。执行层因此用单独的 `GIT_TODO_STDIN_ENV`（只改这一个变量）承载 `rebase -i` | ✅ 2026-10-27 | b3a T3 `test/host/git-executor.test.ts` todoFromStdin |
| Windows（Git for Windows 自带 sh）未实测 | ⚠️ 未实测 | 留给 B4 跨平台验证 |

## 5. Diff 选项、补丁与 autosquash（B3b T3，2026-10-27，git 2.50.1）

| 结论 | 状态 | 证据 |
|---|---|---|
| `git diff -w`：只有空白差异的文件在 `--raw` 里仍列为已修改，但补丁没有 hunk；混合改动只保留非空白行 | ✅ 2026-10-27 | `test/host/diff.test.ts`「readDiff options」 |
| `-U<很大的数>` 输出整文件一个 hunk，行号连续 | ✅ 2026-10-27 | 同上 |
| `rebase -i --autosquash` + `GIT_SEQUENCE_EDITOR=true` + `GIT_EDITOR=true`：`fixup!` 静默合入；`squash!` 合入后信息为目标主题 + 空行 + squash 提交的正文（`squash! <主题>` 那一行被注释掉） | ✅ 2026-10-27 | 本机探测 + `test/host/commit-menu-writes.test.ts` |
| `git am --3way` 失败后 `rebase-apply/` 存在；`git am --abort` 恢复 HEAD 与工作区 | ✅ 2026-10-27 | `commit-menu-writes.test.ts`「aborts a mailbox」 |
| `format-patch -1 <merge>` 不输出任何内容（合并提交被跳过），所以导出前要拒绝合并提交 | ✅ 2026-10-27 | 同上 |
| 同一秒内创建的提交按 `log --no-walk=sorted` 排序不稳定；按 `rev-list --count`（祖先数）排序稳定 | ✅ 2026-10-27 | 同上（首次实现即踩到） |

## 6. 搁架用到的底层命令（B3c 终审修复，2026-10-28，git 2.50.1）

| 结论 | 状态 | 证据 |
|---|---|---|
| `git merge-file --object-id <ours> <base> <theirs>` 把结果写成 blob 并打印 oid，退出码是冲突数（git ≥ 2.43）；不需要临时文件 | ✅ 2026-10-28 | 本机探测 + `test/host/shelf.test.ts` |
| `git stash create` 不改工作区，但「新增后在工作区删除」（AD）的文件在它的工作区树里仍然存在——不能用它代表工作区，改为逐文件 `hash-object -w` | ✅ 2026-10-28 | B3c 修复过程 |
| `update-index --index-info` 写入 `<mode> <oid> <stage>\t<path>` 可直接制造 1/2/3 阶段冲突；mode 为 0 的行删除该路径的条目 | ✅ 2026-10-28 | `shelf.test.ts` 三方合并 |
| `checkout-index -f -- <path>` 按索引条目写回工作区（字节精确，含可执行位与符号链接） | ✅ 2026-10-28 | `shelf.test.ts` 非 UTF-8 / 二进制 |

## 7. Worktree 与远程（B3d，2026-10-28，git 2.50.1）

| 结论 | 状态 | 证据 |
|---|---|---|
| `git worktree list --porcelain` 第一条是主工作区，其余按 `.git/worktrees/` 下的目录名排序，不是创建顺序；目录被删后带 `prunable` 行 | ✅ 2026-10-28 | `test/host/remotes-worktrees.test.ts` |
| `git worktree add` 遇到分支已在别处签出时失败（`is already used by worktree`）；`worktree remove` 遇到有改动或未跟踪文件时失败，需要 `--force` | ✅ 2026-10-28 | 同上 |
| 删除远程标签用 `push <remote> :refs/tags/<name>`；删除远程分支用 `push <remote> :refs/heads/<b>`，成功后本地 `refs/remotes/<remote>/<b>` 一并消失 | ✅ 2026-10-28 | 同上 + L4 |
| `branch --set-upstream-to=refs/remotes/<remote>/<b> <branch>`（用完整 ref 避免与同名本地分支歧义）要求远程跟踪 ref 存在；`branch --unset-upstream <branch>` 取消 | ✅ 2026-10-28 | 同上 |
| `remote get-url` 返回带凭据的原始 URL；脱敏在 Host 做，整段 userinfo 换成 `***`（`https://***@host/...`） | ✅ 2026-10-28 | 同上 |

