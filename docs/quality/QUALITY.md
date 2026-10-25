# 模块质量评级

每个里程碑收尾时更新。评级标准：

| 评级 | 含义 |
|---|---|
| A | 测试覆盖主要路径和边界情况；文档和实现一致；没有已知问题 |
| B | 主要路径有测试；有少量已知缺口，已登记到 tech-debt |
| C | 能用，但测试或文档明显不足 |
| — | 还没有实现 |

| 模块 | 评级 | 已知缺口 | 更新日期 |
|---|---|---|---|
| `src/host/` | B | A1 只读端点（bootstrap/status/log/branches/refs/commit/diff/console）全部真实临时仓库测试，10k 仓库实测均在预算内；watch 已修复（TD-4）。缺口：嵌套 refs 监听（TD-5）、正则 ReDoS 与 >4MiB patch（TD-7）；写操作在 A2/A3 | 2026-10-25 |
| `src/client/` | B | 提交图布局、各 store、页面静态渲染与纯函数有单测，三档宽度/筛选/详情/diff/控制台实机走查；缺口：没有 DOM 交互测试（未引入 jsdom）、文案未国际化（TD-6）、菜单未用 `MenuSurface`（TODO） | 2026-10-25 |
| `src/shared/` | B | 协议常量/类型与 isRpcResult 有单测；A1 端点契约已稳定，`stashCount`/`bisect`/`gitVersion` 已补 | 2026-10-25 |
| `build.mjs` | B | 双面产物 + smoke（含 HMR 重跑时样式替换）；契约漂移风险见 TD-1 | 2026-10-25 |
| 文档与 harness | B | 计划/ADR 校验已机器化；references §13 已回写 M0/A1 实测（watch、HMR、fs）；升级 DSH 后需重跑（TD-2） | 2026-10-25 |
