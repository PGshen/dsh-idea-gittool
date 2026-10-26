# 待办

记录**还没有写成计划**的工作：下一个里程碑、子项目、负责人交代的零散事项。
已经开工的工作看 `active/` 中的计划；技术债的细节写在 [tech-debt.md](../quality/tech-debt.md)，这里只放需要排期的条目并链接过去。

## 使用规则

- **会话开始**：`active/` 中没有计划时，从这里挑下一件事；有计划时以计划为准，这里只作参考。
- **新增**：负责人交代的、或执行中发现但不属于当前计划的事项，加到「待办」末尾，写明来源和日期。
- **开工**：条目写成计划后，在条目后标注计划文件名；计划完成后把条目移到「已完成」。
- **优先级**：P0 阻塞后续工作，P1 下一步要做，P2 有空再做。顺序和优先级由负责人决定，AI 可以建议，不自行调整。
- 每条一两行，细节放进设计文档、ADR、技术债或计划，这里只放链接。

## 待办

| 优先级 | 事项 | 来源 | 备注 |
|---|---|---|---|
| P1 | 按 B1 → B2 → B3 → B4 依次拆分计划（A3 代码已合并，待走查与验收） | [设计决策 v0.2](../design/2026-10-25-产品设计决策-v0.2.md) §4 | 每个里程碑一份计划，执行前批准；A3：[a3-分支贮藏冲突](active/a3-分支贮藏冲突.md)（执行中，T12 走查与评审后转待验收，验收通过前仍为执行中） |
| P2 | 筛选/仓库栏/分支右键菜单改用 ui-primitives `MenuSurface`/`Menu` | A1 走查，2026-10-25 | 当前按 [ADR 0006](../decisions/0006-浮层菜单材质例外.md) 手写菜单材质，迁移后废弃该 ADR |
| P2 | 向 DSH 反馈：`workspace-write` 的 Seatbelt profile 放行 `DARWIN_USER_CACHE_DIR`，否则 osxkeychain 凭据助手在 confine 下不可用 | A2 T1 spike，2026-10-26 | 见 [references §13](../references/dsh-integration-feasibility.md)「写执行与沙箱」；只反馈不改 DSH 仓库，由负责人决定是否提 |
| P2 | 控制台抽屉显示 `ConsoleRecord.stdinBytes`（「stdin: N bytes」），让走 stdin 的路径/提交信息在控制台里可见其存在 | A3 T1，2026-10-26 | Host 已记录字段；A3 未做 UI |
| P2 | 远程分支签出到已存在但落后的本地分支时，提供「签出并重置/变基」（IntelliJ 行为） | A3 T3 评审，2026-10-26 | 当前直接签出本地分支，不看跟踪关系；属 B3 |
| P2 | 工作台在操作进行中挂载时自动打开冲突列表（现在只在 status 观察到 null → 非 null 时开一次，之后靠横幅「解决冲突…」） | A3 T9 裁定，2026-10-26 | A3 有意不做：避免用户关闭后刷新又被弹出；做的话需要记住「用户已关闭」，与自动打开设置开关（B4）一起设计 |
| P2 | 接入远程 CI（GitHub Actions 调用 `make check`） | [ADR 0002](../decisions/0002-技术栈与质量工具链.md) | 当前只用本地关口；仓库推到 GitHub 后再做 |
| P2 | 复核参考项目的 Apache-2.0 复用边界，补 `NOTICE` 与致谢 | [参考项目调研](../references/reference-feature-inventory.md) | 只在确实复用算法/图标时做 |

## 已完成

| 完成日期 | 事项 | 计划 |
|---|---|---|
| 2026-10-26 | A2 提交闭环：写执行层（confine/写队列/门禁）、按文件提交、Amend、回滚、加入 VCS、推送与 Push Rejected、中英双语（TD-6）；AI 评审与负责人验收通过 | [a2-提交闭环](completed/a2-提交闭环.md) |
| 2026-10-25 | A1 核心只读：日志/提交图/详情/diff/分支/状态栏/控制台、`.git` watch 刷新、CSS Modules 管线；AI 评审与负责人验收通过 | [a1-只读日志](completed/a1-只读日志.md) |
| 2026-10-25 | ARCHITECTURE 模块地图按 A1 实际代码回写（pages/store/graph/console/ui、host/git、watch） | [a1-只读日志](completed/a1-只读日志.md) |
| 2026-10-25 | 初始化 harness 工程：入口地图、SOP、计划/ADR/质量/技术债/references 结构、`make check`、pre-commit | — |
| 2026-10-25 | M0 集成 spike：双面 bundle 挂载、产物契约、`/dsh-git` RPC、写门禁、文档动作、刷新兜底 | [m0-集成-spike](../plans/completed/m0-集成-spike.md) |
| 2026-10-25 | 归置既有产品设计文档到 `docs/design/`，调研文档到 `docs/references/` | — |
