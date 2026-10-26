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
| `src/host/` | B | A1 只读端点全部真实临时仓库测试，10k 仓库实测均在预算内；A2 写执行层（模式/confine/写队列/门禁）与提交/回滚/推送/拉取端点用真实仓库 + bare 远程测试，3081 端到端确认写命令经 `sandbox.confine`。缺口：嵌套 refs 监听（TD-5）、正则 ReDoS 与 >4MiB patch（TD-7）；osxkeychain 在 confine 下不可用（references §13，TODO 反馈 DSH）；分支/贮藏/冲突写操作在 A3 | 2026-10-26 |
| `src/client/` | B | 提交图布局、各 store、页面静态渲染与纯函数有单测，三档宽度/筛选/详情/diff/控制台实机走查；中英双语由源码 CJK 静态扫描与英文渲染测试守护（A2 T7）；缺口：没有 DOM 交互测试（未引入 jsdom）、菜单未用 `MenuSurface`（TODO） | 2026-10-26 |
| `src/shared/` | B | 协议常量/类型与 isRpcResult 有单测；A2 写端点类型、错误码与 `reasonCode` 已补；`git/hook-failed` 等错误的 `details` 键（`output`/`paths`/`command`）只在 Host 实现里约定，尚未写进协议类型 | 2026-10-26 |
| `build.mjs` | B | 双面产物 + smoke（含 HMR 重跑时样式替换）；契约漂移风险见 TD-1 | 2026-10-25 |
| 文档与 harness | B | 计划/ADR 校验已机器化；references §13 已回写 M0/A1 实测（watch、HMR、fs）；升级 DSH 后需重跑（TD-2） | 2026-10-25 |
