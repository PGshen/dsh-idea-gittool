# 技术债登记表

发现暂时不处理的问题时登记在这里。每个里程碑收尾时，挑一两项处理，或者排进下一个计划。处理完的条目移到「已处理」。
编号 `TD-N` 只增不复用；`scripts/check_docs.py` 检查未处理区编号唯一、且不与「已处理」撞号。

| # | 登记日期 | 位置 | 问题 | 影响 | 建议的处理方式 | 来源 |
|---|---|---|---|---|---|---|
| TD-1 | 2026-10-25 | `build.mjs`、`lib/client.js` | 官方 tsdown preset 无法脱离 DSH 仓库，产物包装（`__ModuleLoader__` banner/intro/footer 与 baseline externals）需自维护 | DSH 升级后产物契约可能漂移，且没有官方纯净度门禁兜底 | build smoke 已覆盖包装与 externals；每次升级 DSH 跑一次 `pnpm smoke` + 安装态冒烟 | [可行性调研](../references/dsh-integration-feasibility.md) §5.3–5.4 |
| TD-2 | 2026-10-25 | `docs/references/` | 调研结论来自 DSH `0.2.1-rc.2` 源码阅读；M0/A1 已实测挂载/产物/RPC/门禁/文档 slot/watch/HMR（§13），其中 `rpc.handle` 与「web 无 fs」两条被推翻 | DSH 升级后结论可能再次过时 | 升级 DSH 后重跑 §13 清单 | [可行性调研](../references/dsh-integration-feasibility.md) §13 |
| TD-7 | 2026-10-25 | `src/host/git/diff.ts` | 单个 patch 超过 4MiB 时执行层只保留尾部，返回空 hunks + `truncated`；staged/commit 范围先跑全树 `--raw`，超大提交（>2MB raw 输出）直接报 `git/output-too-large` 而不是降级（评审 M8）。正则搜索的阻塞风险已于评审 I2 修复 | 超大 patch 看不到已解析前缀；超大提交里打开单文件 diff 会失败 | diff 改为流式读取前缀；`--raw` 改为按路径过滤或流式扫描 | A1 host-rpc 交付报告、A1 代码评审 |
| TD-11 | 2026-10-26 | `src/host/git/branch-write.ts` | `deleteBranch` 先比对 `expectedSha` 再 `branch -D`，两步之间分支被移动则仍会删除（评审 A3 T3） | 极窄竞态下删掉用户没看过的提交（仍可从 reflog 找回） | 改为 `update-ref -d refs/heads/<b> <oldsha>`，由 git 原子比较 | A3 T3 评审 |
| TD-12 | 2026-10-26 | `src/host/git/update.ts` | `resetToRemote` 只检查上游树里与未跟踪/忽略文件同名的路径，不检查文件与目录冲突（目标新增 `a/b`、本地有未跟踪文件 `a`）和大小写不敏感文件系统上的碰撞 | 这两种情况 `reset --hard` 可能覆盖或失败 | 对 `ls-tree` 结果做前缀与大小写折叠比较 | A3 T4 评审 |
| TD-13 | 2026-10-26 | `src/host/watch.ts` | `logs/refs/stash` 不在监听目标内：外部（终端/Agent）删除非栈顶贮藏时只有该文件变化，贮藏列表与 `stashCount` 徽标保持旧数据直到下次 version 变化 | 外部删非栈顶贮藏后短时间显示过期（Host 自己的写会推进 version，不受影响） | 把 `logs/refs/stash` 加入监听目标 | A3 T5 报告 |
| TD-14 | 2026-10-26 | `src/host/git/smart-stash.ts` | 待恢复标记的 `update-ref` 没有旧值检查；新的智能操作覆盖更早的标记（更早的贮藏失去自动恢复，仍在贮藏列表里）；`stash push` 成功到标记写入之间 Host 崩溃同样无自动恢复；无提交的 unborn HEAD 不写标记 | 极端时序下贮藏需要用户在贮藏页手动恢复，不会丢失 | 写标记时带旧值；多标记队列或在贮藏信息里编码 sha | A3 T2 评审 |
| TD-15 | 2026-10-26 | `src/host/git/conflict.ts` | 冲突标记检测只认 7 字符的 `<<<<<<<`，忽略 `conflict-marker-size` 属性 | 自定义标记长度的文件在「标记已解决」时不会触发二次确认 | 读取 `git check-attr conflict-marker-size` 后按长度检测 | A3 T3 评审 |
| TD-16 | 2026-10-26 | `test/host/watch.test.ts`、`make check` | 并行车道/高负载下嵌套 refs 监听用例偶发超时；长路径测试使全量 `make check` 约 100s | 偶发假失败，拉长反馈时间 | 放宽超时并改为轮询等待 version；长路径用例缩小规模或拆出 | A3 T1/T2/T6 报告 |
| TD-17 | 2026-10-26 | `build.mjs` | `lib/` 目录不存在时构建失败（首次 `pnpm build` 需要先建目录） | 干净 checkout 上 `pnpm build` 报错 | 构建前 `mkdir -p lib` | A3 T6 报告 |
| TD-18 | 2026-10-26 | `test/client/` | 没有 DOM 测试环境（未引入 jsdom）：焦点返回、Esc 退一级、双击签出、右键菜单、`Delete` 键等只有纯函数与静态渲染测试，交互靠人工走查 | 交互回归只能靠实机发现 | 评估引入 jsdom/happy-dom 或浏览器级测试（需新依赖，另行批准） | A3 T6–T11 报告 |
| TD-19 | 2026-10-27 | `src/host/git/merge-file.ts`、`src/host/git/status.ts` | 冲突类型有两份映射：`kindFromStages`（按索引 stage 1/2/3 是否存在）与 status 的 `CONFLICT_KINDS`（按 porcelain XY） | 两处规则若改一处忘另一处，冲突列表与合并窗口对同一文件给出不同类型 | 统一为按 stage 推导，或加一条两者一致的表驱动测试 | B1 终审 |
| TD-20 | 2026-10-27 | `src/host/git/merge-file.ts` `hashWorktree` | 「工作区文件不存在」靠匹配 `git hash-object` 的 stderr 英文文本判断 | git 改措辞或本地化 stderr 时会把缺失文件当成错误抛出，`mergeFile` 失败 | 先 `lstat` 判断存在性，或用 `ls-files`/`diff-files` 判定 | B1 终审 |

## 已处理

| # | 处理日期 | 说明 |
|---|---|---|
| TD-8 | 2026-10-26 | A3 T5/T11：`RollbackRequest.confirmedUntracked`，Host 只删除「执行时未跟踪 ∩ 确认列表」，其余进 `skipped`；不传视为空集；客户端发送确认框里的路径，`skipped` 非空时提示 |
| TD-9 | 2026-10-26 | A3 T1/T11：路径走 stdin `--pathspec-from-file`（`clean`/`status` 每批 ≤200），2000 个 600 字节路径实测通过；客户端勾选超过 `WRITE_PATHS_MAX` 时提交按钮禁用并提示 |
| TD-10 | 2026-10-26 | A3 T4/T11：`PushRequest.expectedRemoteSha` → `--force-with-lease=refs/heads/<b>:<sha>`，`PushRejectedDetails.remoteSha` 来自被拒时的远程 tip；客户端强推带用户看到的 sha，缺失时与 A2 行为相同 |
| TD-5 | 2026-10-26 | A3 T1：`watchRepo` 启动时枚举 `refs/heads`、`refs/remotes`、`refs/tags` 下全部子目录逐个挂监听，任一 refs 目录变化时重新枚举补挂/释放（串行）；上限 `NESTED_REF_DIRS_MAX=256`，超出记 `watch-limit` 并降级（客户端 3s 轮询兜底）；`test/host/watch.test.ts` 覆盖嵌套分支新建/删除与 `refs/remotes/origin/feature/x` 更新 |
| TD-3 | 2026-10-25 | A1 T2 采用 esbuild local-css + 单文件内联 CSS（[ADR 0005](../decisions/0005-自建CSS-Modules管线.md)）；T9 修正 HMR 时样式不更新（factory 重跑时替换 `<style>` 内容），smoke 覆盖 |
| TD-4 | 2026-10-25 | 根因是适配器把路径字符串传给 `fs.watch`（需 `resolve()` 出的 FsTarget），web 组合其实有 `fs`；修正后 version 正常递增，终端改动 1.2–1.3s 反映；嵌套 refs 的残余缺口另登记 TD-5 |
| TD-6 | 2026-10-26 | A2 T7：A1/A2 全部可见文案进入 `gitWorkbench` 命名空间（`src/client/locales/*.ts` 分区，`en` 以 `satisfies` 强制键集一致）；组件经 `I18nProvider`/`useT()` 取 slot 注入的 `t`，store 与纯函数返回 `LocalizedText` 或接收 `t`；只读横幅按 `reasonCode` 本地化；`test/client/locales.test.ts` 静态扫描源码中的 CJK 字面量，`locales-render.test.tsx` 断言英文渲染无中文残留 |
