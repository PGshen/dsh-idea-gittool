# 技术债登记表

发现暂时不处理的问题时登记在这里。每个里程碑收尾时，挑一两项处理，或者排进下一个计划。处理完的条目移到「已处理」。
编号 `TD-N` 只增不复用；`scripts/check_docs.py` 检查未处理区编号唯一、且不与「已处理」撞号。

| # | 登记日期 | 位置 | 问题 | 影响 | 建议的处理方式 | 来源 |
|---|---|---|---|---|---|---|
| TD-1 | 2026-10-25 | `build.mjs`、`lib/client.js` | 官方 tsdown preset 无法脱离 DSH 仓库，产物包装（`__ModuleLoader__` banner/intro/footer 与 baseline externals）需自维护 | DSH 升级后产物契约可能漂移，且没有官方纯净度门禁兜底 | build smoke 已覆盖包装与 externals；每次升级 DSH 跑一次 `pnpm smoke` + 安装态冒烟 | [可行性调研](../references/dsh-integration-feasibility.md) §5.3–5.4 |
| TD-2 | 2026-10-25 | `docs/references/` | 调研结论来自 DSH `0.2.1-rc.2` 源码阅读；M0/A1 已实测挂载/产物/RPC/门禁/文档 slot/watch/HMR（§13），其中 `rpc.handle` 与「web 无 fs」两条被推翻 | DSH 升级后结论可能再次过时 | 升级 DSH 后重跑 §13 清单 | [可行性调研](../references/dsh-integration-feasibility.md) §13 |
| TD-5 | 2026-10-25 | `src/host/watch.ts` | `fs.watch` 目录只看直接子项：带 `/` 的分支名（`refs/heads/feature/x`）与 `refs/remotes/<remote>/` 下的变化不会递增 version（fetch 由 `FETCH_HEAD` 兜住） | 终端里新建/删除嵌套分支后，日志与分支面板要等手动刷新 | 按 refs 实际子目录动态挂 watch，或改为监听 `logs/` reflog；A3 分支写操作前处理 | [A1 计划](../plans/completed/a1-只读日志.md) 意外与发现 |
| TD-6 | 2026-10-25 | `src/client/pages/**`、`src/client/console/**` | A1 页面文案硬编码中文，没有走 `gitWorkbench` locale 命名空间 | 英文界面下 Git tab 仍显示中文 | 统一抽到 `locales.ts`，组件经注入的 `t()` 取文案 | A1 log-ui/shell-ui 交付报告 |
| TD-7 | 2026-10-25 | `src/host/git/diff.ts` | 单个 patch 超过 4MiB 时执行层只保留尾部，返回空 hunks + `truncated`；staged/commit 范围先跑全树 `--raw`，超大提交（>2MB raw 输出）直接报 `git/output-too-large` 而不是降级（评审 M8）。正则搜索的阻塞风险已于评审 I2 修复 | 超大 patch 看不到已解析前缀；超大提交里打开单文件 diff 会失败 | diff 改为流式读取前缀；`--raw` 改为按路径过滤或流式扫描 | A1 host-rpc 交付报告、A1 代码评审 |

## 已处理

| # | 处理日期 | 说明 |
|---|---|---|
| TD-3 | 2026-10-25 | A1 T2 采用 esbuild local-css + 单文件内联 CSS（[ADR 0005](../decisions/0005-自建CSS-Modules管线.md)）；T9 修正 HMR 时样式不更新（factory 重跑时替换 `<style>` 内容），smoke 覆盖 |
| TD-4 | 2026-10-25 | 根因是适配器把路径字符串传给 `fs.watch`（需 `resolve()` 出的 FsTarget），web 组合其实有 `fs`；修正后 version 正常递增，终端改动 1.2–1.3s 反映；嵌套 refs 的残余缺口另登记 TD-5 |
