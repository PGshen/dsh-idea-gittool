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
