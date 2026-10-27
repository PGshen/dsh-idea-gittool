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
| P1 | 按 B1 → B2 → B3 → B4 依次拆分计划（下一个：B2 历史与 Blame） | [设计决策 v0.2](../design/2026-10-25-产品设计决策-v0.2.md) §4 | 每个里程碑一份计划，执行前批准 |
| P2 | 筛选/仓库栏/分支右键菜单改用 ui-primitives `MenuSurface`/`Menu` | A1 走查，2026-10-25 | 当前按 [ADR 0006](../decisions/0006-浮层菜单材质例外.md) 手写菜单材质，迁移后废弃该 ADR |
| P2 | 向 DSH 反馈：`workspace-write` 的 Seatbelt profile 放行 `DARWIN_USER_CACHE_DIR`，否则 osxkeychain 凭据助手在 confine 下不可用 | A2 T1 spike，2026-10-26 | 见 [references §13](../references/dsh-integration-feasibility.md)「写执行与沙箱」；只反馈不改 DSH 仓库，由负责人决定是否提 |
| P2 | 分支树改为单一 Tab 停靠点（roving tabindex：选中行或首行为 0，其余 -1）；菜单 ↑↓ 是否停在不可用项上以便读屏听到原因，与负责人确认 | A3 I-1 评审，2026-10-26 | 当前每个叶子行各占一个 Tab 停靠点；↑↓ 跳过不可用项 |
| P2 | 控制台抽屉显示 `ConsoleRecord.stdinBytes`（「stdin: N bytes」），让走 stdin 的路径/提交信息在控制台里可见其存在 | A3 T1，2026-10-26 | Host 已记录字段；A3 未做 UI |
| P2 | 远程分支签出到已存在但落后的本地分支时，提供「签出并重置/变基」（IntelliJ 行为） | A3 T3 评审，2026-10-26 | 当前直接签出本地分支，不看跟踪关系；属 B3 |
| P2 | 工作台在操作进行中挂载时自动打开冲突列表（现在只在 status 观察到 null → 非 null 时开一次，之后靠横幅「解决冲突…」） | A3 T9 裁定，2026-10-26 | A3 有意不做：避免用户关闭后刷新又被弹出；做的话需要记住「用户已关闭」，与自动打开设置开关（B4）一起设计 |
| P2 | 接入远程 CI（GitHub Actions 调用 `make check`） | [ADR 0002](../decisions/0002-技术栈与质量工具链.md) | 当前只用本地关口；仓库推到 GitHub 后再做 |
| P2 | 复核参考项目的 Apache-2.0 复用边界，补 `NOTICE` 与致谢 | [参考项目调研](../references/reference-feature-inventory.md) | 只在确实复用算法/图标时做 |
| P2 | 冲突列表「已解决」组只列本次操作中曾冲突、现已解决的文件；合并干净带入的新文件不应出现（D1） | A3 验收演示，2026-10-26 | 现在 `resolved` = 相对 HEAD 有暂存改动且不在冲突中的路径，见 `src/host/git/operation.ts` |
| P2 | 贮藏列表「N 个文件」把未跟踪文件（`^3`）也计入，或分开显示（D3） | A3 验收演示 / T5 评审，2026-10-26 | 现在只数 `^1..sha` 的已跟踪改动 |
| P2 | 合并窗口底栏与头部按钮的可访问名称改为与可见文字一致（现在是 `title` 全文，如「把 Result 写回工作区并标记为已解决」，可见文字是「应用更改」；WCAG 2.5.3 label-in-name） | B1 L4，2026-10-27 | Minor；可用 `aria-label` = 可见文字、`title` 留作说明，或改用 `aria-describedby` |
| P2 | RPC 载荷上限：`mergeApply`/`mergeDraftSave` 的 Result 最多约 8 MiB，未经真实 HTTP 验证宿主 RPC 层能否接受；考虑把上限降到与单侧 2 MiB 相当 | B1 终审，2026-10-27 | `src/host/git/merge-write.ts` `MERGE_APPLY_RESULT_MAX_BYTES`；B1 验收演示实测：卡住的是插件自己 `/dsh-git` 的 256 KiB 请求体上限（宿主未拦），已改为按端点限额（合并写端点 32 MiB，见计划「意外与发现」）；是否把 Result 上限降到 2 MiB 仍待负责人决定 |
| P2 | 合并窗口有未保存改动时没有 `beforeunload` 守卫：刷新/关闭页面直接丢失改动 | B1 终审，2026-10-27 | 可在窗口 dirty 时注册 `beforeunload` |
| P2 | 贮藏恢复冲突（没有进行中的操作）时保存的草稿永远不会被清理 | B1 终审，2026-10-27 | 清理只挂在 continue/abort/operationCommit；草稿 stages 不会再匹配，无害但残留 ref |
| P2 | continue/abort 失败时仍会清理草稿 | B1 终审，2026-10-27 | `operation.ts` 的清理在失败路径也执行；应只在成功后清理 |
| P2 | 切换 DSH 语言会重挂载三个编辑器（标签参与 effect 依赖），丢失滚动位置与选区 | B1 终审，2026-10-27 | 把 gutter/栏标签改为可更新的 facet，不重建编辑器 |
| P2 | 「应用非冲突更改 ▾」菜单点外部不关闭（只有 Esc 与菜单项会关） | B1 终审，2026-10-27 | 复用 `useFloatingMenu` 的外部点击处理 |
| P2 | 冲突列表块计数加载失败后每次刷新都会重试同一文件 | B1 终审，2026-10-27 | 失败结果按 stages 缓存，或退避 |
| P2 | `answerLeave('save')` 保存失败、或 `closeIf` 关窗时，被拦住的「未提交改动」询问（`dirtyWorktree`）一直挂起 | B1 终审，2026-10-27 | 保存失败时保留询问可再答；`closeIf` 时按取消回应 |
| P2 | 补测试：continue 失败后的草稿、忙碌时 dispatch 被忽略、conflict/cancelled 结果文案、`dirtyWorktree` → `cancelStash` 接线、`git-client` 新端点的请求体断言 | B1 终审，2026-10-27 | B1 终审列出的缺口 |
| P2 | A1–A3 样式引用了 DSH 中不存在的变量（--dsw-alias-state-success/warn、--dsw-font-mono、--dsw-alias-interactive-bg-selected），状态色/等宽字体实际未生效；需负责人确认后全局替换并把静态检查扩到全部样式 | B1 验收演示，2026-10-27 | B1 的 `MergeWindow*.module.css`、`ConflictsPage.module.css` 已替换，静态检查 `test/client/pages/css-tokens.test.ts` 目前只覆盖这两类文件（`GUARDED`） |

## 已完成

| 完成日期 | 事项 | 计划 |
|---|---|---|
| 2026-10-27 | B1 三栏合并：Host 合并端点（读三方、草稿 ref、经索引写回、还原冲突解决）、纯合并模型（Myers/diff3/按词简单冲突/草稿往返）、合并 store、CodeMirror 三栏窗口（块操作、同步滚动、宿主全屏、键盘）、冲突列表增强与审查更改；请求体按端点限额（ADR 0009）；AI 逐任务评审 + 整分支终审，负责人验收通过，`mergeWindow` 默认开启 | [b1-三栏合并](completed/b1-三栏合并.md) |
| 2026-10-26 | A3 分支/贮藏/冲突最小闭环：分支页与分支动作（智能签出按 IntelliJ 行为）、合并/变基/拣选/回滚/重置/获取/拉取/更新项目（强推恢复带备份分支）、智能贮藏与待恢复标记（ADR 0008）、操作控制与合并提交、冲突列表、贮藏页、整行焦点；TD-5/8/9/10；AI 逐任务评审 + 整分支评审，负责人验收通过 | [a3-分支贮藏冲突](completed/a3-分支贮藏冲突.md) |
| 2026-10-26 | A2 提交闭环：写执行层（confine/写队列/门禁）、按文件提交、Amend、回滚、加入 VCS、推送与 Push Rejected、中英双语（TD-6）；AI 评审与负责人验收通过 | [a2-提交闭环](completed/a2-提交闭环.md) |
| 2026-10-25 | A1 核心只读：日志/提交图/详情/diff/分支/状态栏/控制台、`.git` watch 刷新、CSS Modules 管线；AI 评审与负责人验收通过 | [a1-只读日志](completed/a1-只读日志.md) |
| 2026-10-25 | ARCHITECTURE 模块地图按 A1 实际代码回写（pages/store/graph/console/ui、host/git、watch） | [a1-只读日志](completed/a1-只读日志.md) |
| 2026-10-25 | 初始化 harness 工程：入口地图、SOP、计划/ADR/质量/技术债/references 结构、`make check`、pre-commit | — |
| 2026-10-25 | M0 集成 spike：双面 bundle 挂载、产物契约、`/dsh-git` RPC、写门禁、文档动作、刷新兜底 | [m0-集成-spike](../plans/completed/m0-集成-spike.md) |
| 2026-10-25 | 归置既有产品设计文档到 `docs/design/`，调研文档到 `docs/references/` | — |
