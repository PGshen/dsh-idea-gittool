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
| P1 | B4 打磨，拆成 4 份按序做：B4a 设置页 + Blame 渲染器（2026-10-28 已完成，见下方「已完成」）；B4b a11y 与样式变量；B4c 性能；B4d 跨平台/安装升级/文档（含 git 路径设置） | [设计决策 v0.2](../design/2026-10-25-产品设计决策-v0.2.md) §4 | 2026-10-28 负责人同意拆分；下一份 B4b |
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
| P2 | B3a 终审 Minor（5 条）：`--root` 下首条 drop 的提交上若有分支，`--update-refs` 会把它指到 git 的空根提交；squash 组信息清空时客户端不拦、Host 报通用错误；preset 的提交不在计划里（链未加载完）时静默打开无关列表；行动作变化后仍保留之前输入的信息；「压缩所选提交」未检查合并提交 | B3a 终审，2026-10-27 | 细节见 [b3a 计划](completed/b3a-交互式变基.md)「决策记录」终审条目 |
| P2 | B3c 终审 Minor（7 条）：版本刷新换了选中条目后「三方合并应用」作用到新条目；`shelf-store.refresh` 无序号；拖放/「移到」带上被搜索隐藏或其他列表里的勾选文件；三方合并的路径未分批；重命名后的新路径进活动列表而非原列表；内联编辑 Enter 后可能 blur 再触发一次新增；子模块 gitlink 只回滚索引 | B3c 终审，2026-10-28 | 细节见 [b3c 计划](completed/b3c-搁架与Changelist.md)「决策记录」终审条目 |
| P2 | B3d 终审 Minor（9 条）：`remoteBranchDelete` 对 `HEAD` 未用 `--no-deref`（直接 RPC 可误删 `origin/main` 跟踪 ref）；名字含 `/` 的远程能列出但无法管理；标签推送被拒时只显示「failed to push some refs」；Worktree 页对主工作区/锁定 worktree 也可点删除；`.worktrees` 为指向仓库外的符号链接时新 worktree 落在仓库外；`remoteList` 失败未脱敏；「留空不修改」文案与行为不符；有独立推送 URL 时「改 URL」只改 fetch；推送标签/删除远程分支/upstream 成功无提示 | B3d 终审，2026-10-28 | 细节见 [b3d 计划](completed/b3d-Worktree与远程.md)「决策记录」终审条目 |
| P2 | 没有进行中操作时冲突列表固定说「这些冲突来自恢复贮藏」，搁架三方合并取回时也显示这句 | B3c L4，2026-10-28 | 文案应区分来源（贮藏 / 搁架） |
| P2 | B3b 终审 Minor（12 条）：勾选的重命名旧路径被当成「勾选外改动」多问一次贮藏；SHA-256 仓库的 mbox 头识别不到；`patch.ts` 头注释与实现不符（写着 `--3way`）；CRLF 普通 diff `apply --check` 失败没有专门提示；`am --abort` 失败未处理；导出补丁是逐提交 `[PATCH]` 而非 `[PATCH n/m]`；带 revision 推送时「设置 upstream」无效却仍显示；推送页换 revision 不重建 store；父组件换请求时 Diff 选项丢失但开关仍亮；高亮片段与行文本长度不符时词级标记错位；整文件并排的行构建是 O(段×行)；`n`/`p` 跳过折叠的 hunk 没有提示 | B3b 终审，2026-10-28 | 细节见 [b3b 计划](completed/b3b-Diff增强与提交菜单.md)「决策记录」终审条目 |
| P2 | Fixup/Squash 到此提交的自动变基被中止后，`fixup!`/`squash!` 提交留在 HEAD；是否在中止时提示「撤销该提交」 | B3b L4，2026-10-27 | 与 IntelliJ 一致，需负责人决定 |
| P2 | 交互式变基等改写历史的操作之后，日志详情区仍显示改写前选中的旧提交（选中项已不在日志里）；变基列表里的分支名标签与背景对比弱 | B3a L4，2026-10-27 | 前者是 A1 的既有行为：选中 sha 不在新日志里时应清空或跟随 HEAD |
| P2 | B2 终审 Minor（10 条）：Blame 未提交行双击应显示 HEAD→工作区（含已暂存）；修订版 Blame「文件不存在」文案区分修订并给「文件历史」按钮；文件历史第 2 页起合并条目路径退回新名（游标带当前路径）；文档头部 bootstrap 未到时误报「不在仓库」；`openTab` 失败后意图残留在队列；分支比较传 `entry.ref` 而非 `entry.name`（同名标签）；被该提交删除的文件禁用「与工作区比较」；窄头部 `⋯` 点动作/外部/Esc 收起；`git.blame` 页无返回时不吞 Esc；GitWorkbench 卸载时 `historyStore.close()`；（L4）干净文件的状态位「·」提示仍是 M0 的「Git 状态待接入」，应改为「没有未提交的改动」 | B2 终审，2026-10-27 | 细节见 [b2 计划](completed/b2-历史与Blame.md)「决策记录」终审条目 |
| P2 | B4a 终审 Minor（8 条）：Blame 渲染器正文按读完的文本长度作 key（同长度改动可能不刷新、多页文件 blame 请求两次），应改用 `useResource(...).value?.version`；bootstrap 失败或无 `absolutePath` 时正文空白；定义未声明 `wrap: true` 但回退原文读 `wrap`；草稿存在但不可用时不自动应用、Host 判草稿过期时却会；PageUp/PageDown 步长取创建时条数，改设置后与刷新页面后不一致（应固定常量或视口行数）；没打开过日志也会因改条数立即拉一次日志；改刷新间隔立即触发一次刷新、`GitBody` 订阅全部设置；`settings.ts` 读存储中途失败时静默回默认且不通知、写失败后不再写回存储 | B4a 终审，2026-10-28 | 细节见 [b4a 计划](completed/b4a-设置页与Blame渲染器.md)「决策记录」评审条目 |
| P2 | `test/client/graph/layout.test.ts`「lays out 2000 branchy rows in under 50ms」在全量 `make check` 高负载下偶发超时（实测 58ms），单独跑稳定通过；与 TD-16 同类，考虑放宽阈值或改为相对基准 | B4a 合并后 `make check`，2026-10-28 | 重跑全绿；B4a 未改布局算法 |

## 已完成

| 完成日期 | 事项 | 计划 |
|---|---|---|
| 2026-10-28 | B4a 设置页与 Blame 渲染器：设置模型（单键 localStorage、逐字段校验、跨标签页同步）、仓库栏 ⋯「设置…」弹层（自动刷新/间隔、日志每页条数、日期格式、紧凑模式、默认 Diff、提交后跳日志、自动打开冲突列表、合并自动应用非冲突更改）、可选「Git Blame」文档渲染器（随设置注册/注销，不接管 DSH 专用查看器的后缀）；⋯ 菜单覆盖层焦点返还修复；整分支评审修复 I1–I3(a)，负责人验收通过 | [b4a](completed/b4a-设置页与Blame渲染器.md) |
| 2026-10-28 | B3 高级操作（拆成 4 份，按序合并）：B3a 交互式变基（变基覆盖页、日志快捷动作、edit 停下）；B3b Diff 增强（并排/词级/忽略空白/完整文件）与完整提交菜单（撤销提交、推送到此、新建标签、Fixup/Squash into、补丁导出与应用）；B3c 搁架（受限 ref 下的提交对象，ADR 0011）与 Changelist；B3d 远程页、标签推送/删除、远程分支删除、upstream、Worktree 页；每份整分支终审 + L4 走查各一轮修复，负责人统一验收通过，`interactiveRebase`、`worktrees` 默认开启 | [b3a](completed/b3a-交互式变基.md)、[b3b](completed/b3b-Diff增强与提交菜单.md)、[b3c](completed/b3c-搁架与Changelist.md)、[b3d](completed/b3d-Worktree与远程.md) |
| 2026-10-27 | B2 历史与 Blame：Host `blame`/`fileHistory`/`compare` 与 `diff` range（修订号先解析成 sha）、三个 store 与跨 tab 意图队列、Blame 视图（Git tab 覆盖层 + `git.blame` 页）、文件历史页、比较页、覆盖层返回链、文件/提交/分支菜单与文档头部「历史」「Diff」；整分支终审 + L4 走查各一轮修复，负责人验收通过 | [b2-历史与Blame](completed/b2-历史与Blame.md) |
| 2026-10-27 | B1 三栏合并：Host 合并端点（读三方、草稿 ref、经索引写回、还原冲突解决）、纯合并模型（Myers/diff3/按词简单冲突/草稿往返）、合并 store、CodeMirror 三栏窗口（块操作、同步滚动、宿主全屏、键盘）、冲突列表增强与审查更改；请求体按端点限额（ADR 0009）；AI 逐任务评审 + 整分支终审，负责人验收通过，`mergeWindow` 默认开启 | [b1-三栏合并](completed/b1-三栏合并.md) |
| 2026-10-26 | A3 分支/贮藏/冲突最小闭环：分支页与分支动作（智能签出按 IntelliJ 行为）、合并/变基/拣选/回滚/重置/获取/拉取/更新项目（强推恢复带备份分支）、智能贮藏与待恢复标记（ADR 0008）、操作控制与合并提交、冲突列表、贮藏页、整行焦点；TD-5/8/9/10；AI 逐任务评审 + 整分支评审，负责人验收通过 | [a3-分支贮藏冲突](completed/a3-分支贮藏冲突.md) |
| 2026-10-26 | A2 提交闭环：写执行层（confine/写队列/门禁）、按文件提交、Amend、回滚、加入 VCS、推送与 Push Rejected、中英双语（TD-6）；AI 评审与负责人验收通过 | [a2-提交闭环](completed/a2-提交闭环.md) |
| 2026-10-25 | A1 核心只读：日志/提交图/详情/diff/分支/状态栏/控制台、`.git` watch 刷新、CSS Modules 管线；AI 评审与负责人验收通过 | [a1-只读日志](completed/a1-只读日志.md) |
| 2026-10-25 | ARCHITECTURE 模块地图按 A1 实际代码回写（pages/store/graph/console/ui、host/git、watch） | [a1-只读日志](completed/a1-只读日志.md) |
| 2026-10-25 | 初始化 harness 工程：入口地图、SOP、计划/ADR/质量/技术债/references 结构、`make check`、pre-commit | — |
| 2026-10-25 | M0 集成 spike：双面 bundle 挂载、产物契约、`/dsh-git` RPC、写门禁、文档动作、刷新兜底 | [m0-集成-spike](../plans/completed/m0-集成-spike.md) |
| 2026-10-25 | 归置既有产品设计文档到 `docs/design/`，调研文档到 `docs/references/` | — |
