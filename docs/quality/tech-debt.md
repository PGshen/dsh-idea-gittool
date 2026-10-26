# 技术债登记表

发现暂时不处理的问题时登记在这里。每个里程碑收尾时，挑一两项处理，或者排进下一个计划。处理完的条目移到「已处理」。
编号 `TD-N` 只增不复用；`scripts/check_docs.py` 检查未处理区编号唯一、且不与「已处理」撞号。

| # | 登记日期 | 位置 | 问题 | 影响 | 建议的处理方式 | 来源 |
|---|---|---|---|---|---|---|
| TD-1 | 2026-10-25 | `build.mjs`、`lib/client.js` | 官方 tsdown preset 无法脱离 DSH 仓库，产物包装（`__ModuleLoader__` banner/intro/footer 与 baseline externals）需自维护 | DSH 升级后产物契约可能漂移，且没有官方纯净度门禁兜底 | build smoke 已覆盖包装与 externals；每次升级 DSH 跑一次 `pnpm smoke` + 安装态冒烟 | [可行性调研](../references/dsh-integration-feasibility.md) §5.3–5.4 |
| TD-2 | 2026-10-25 | `docs/references/` | 调研结论来自 DSH `0.2.1-rc.2` 源码阅读；M0/A1 已实测挂载/产物/RPC/门禁/文档 slot/watch/HMR（§13），其中 `rpc.handle` 与「web 无 fs」两条被推翻 | DSH 升级后结论可能再次过时 | 升级 DSH 后重跑 §13 清单 | [可行性调研](../references/dsh-integration-feasibility.md) §13 |
| TD-7 | 2026-10-25 | `src/host/git/diff.ts` | 单个 patch 超过 4MiB 时执行层只保留尾部，返回空 hunks + `truncated`；staged/commit 范围先跑全树 `--raw`，超大提交（>2MB raw 输出）直接报 `git/output-too-large` 而不是降级（评审 M8）。正则搜索的阻塞风险已于评审 I2 修复 | 超大 patch 看不到已解析前缀；超大提交里打开单文件 diff 会失败 | diff 改为流式读取前缀；`--raw` 改为按路径过滤或流式扫描 | A1 host-rpc 交付报告、A1 代码评审 |
| TD-8 | 2026-10-26 | `src/host/git/rollback.ts` | `deleteUntracked=true` 时 Host 删除请求路径中「执行那一刻未跟踪」的文件，而不是用户在确认框里看到的那批；客户端状态可能落后约 3s（评审 M2） | 极少数情况下（Agent 刚把某个勾选的已跟踪文件移出索引）会删掉用户以为是「回滚改动」的文件 | 协议加 `confirmedUntracked: string[]`，Host 只删交集 | A2 代码评审 |
| TD-9 | 2026-10-26 | `src/host/git/{commit-write,rollback}.ts` | 路径全部放在 argv 里，上限 `WRITE_PATHS_MAX=2000`；超出时客户端只看到通用 invalid-payload，极长路径可能触及 macOS ARG_MAX（评审 M4） | 一次勾选上千个文件提交会失败且提示不清 | 客户端在勾选数超限时给出明确提示；Host 改用 `--pathspec-from-file=-`（需要 stdin 支持）或分批。**Host 部分 2026-10-26 A3 T1 已完成**（路径走 stdin、`clean`/`status` 每批 ≤200，2000 个 600 字节路径实测通过）；客户端超限提示待 A3 T11 | A2 代码评审 |
| TD-10 | 2026-10-26 | `src/host/git/push.ts` | `--force-with-lease` 不带期望值，以远程跟踪引用为准；该引用会被 Push Rejected 的 fetch 和任何后台 fetch 刷新（评审 M5） | 用户看过远程新提交后选择强推时，若期间远程又被更新且有后台 fetch，lease 失去保护 | 协议加 `expectedRemoteSha`（来自 Push Rejected 页展示的远程提交），改为 `--force-with-lease=refs/heads/<b>:<sha>`；`--force-if-includes` 与「看过即覆盖」的交互冲突，不直接加 | A2 代码评审 |

## 已处理

| # | 处理日期 | 说明 |
|---|---|---|
| TD-5 | 2026-10-26 | A3 T1：`watchRepo` 启动时枚举 `refs/heads`、`refs/remotes`、`refs/tags` 下全部子目录逐个挂监听，任一 refs 目录变化时重新枚举补挂/释放（串行）；上限 `NESTED_REF_DIRS_MAX=256`，超出记 `watch-limit` 并降级（客户端 3s 轮询兜底）；`test/host/watch.test.ts` 覆盖嵌套分支新建/删除与 `refs/remotes/origin/feature/x` 更新 |
| TD-3 | 2026-10-25 | A1 T2 采用 esbuild local-css + 单文件内联 CSS（[ADR 0005](../decisions/0005-自建CSS-Modules管线.md)）；T9 修正 HMR 时样式不更新（factory 重跑时替换 `<style>` 内容），smoke 覆盖 |
| TD-4 | 2026-10-25 | 根因是适配器把路径字符串传给 `fs.watch`（需 `resolve()` 出的 FsTarget），web 组合其实有 `fs`；修正后 version 正常递增，终端改动 1.2–1.3s 反映；嵌套 refs 的残余缺口另登记 TD-5 |
| TD-6 | 2026-10-26 | A2 T7：A1/A2 全部可见文案进入 `gitWorkbench` 命名空间（`src/client/locales/*.ts` 分区，`en` 以 `satisfies` 强制键集一致）；组件经 `I18nProvider`/`useT()` 取 slot 注入的 `t`，store 与纯函数返回 `LocalizedText` 或接收 `t`；只读横幅按 `reasonCode` 本地化；`test/client/locales.test.ts` 静态扫描源码中的 CJK 字面量，`locales-render.test.tsx` 断言英文渲染无中文残留 |
