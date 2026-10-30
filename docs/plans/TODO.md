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
| P2 | 筛选/仓库栏/分支右键菜单改用 ui-primitives `MenuSurface`/`Menu` | A1 走查，2026-10-25 | 当前按 [ADR 0006](../decisions/0006-浮层菜单材质例外.md) 手写菜单材质，迁移后废弃该 ADR |
| P2 | 向 DSH 反馈：`workspace-write` 的 Seatbelt profile 放行 `DARWIN_USER_CACHE_DIR`，否则 osxkeychain 凭据助手在 confine 下不可用 | A2 T1 spike，2026-10-26 | 见 [references §13](../references/dsh-integration-feasibility.md)「写执行与沙箱」；只反馈不改 DSH 仓库，由负责人决定是否提 |
| P2 | 远程分支签出到已存在但落后的本地分支时，提供「签出并重置/变基」（IntelliJ 行为） | A3 T3 评审，2026-10-26 | 当前直接签出本地分支，不看跟踪关系；属 B3 |
| P2 | 工作台在操作进行中挂载时自动打开冲突列表（现在只在 status 观察到 null → 非 null 时开一次，之后靠横幅「解决冲突…」） | A3 T9 裁定，2026-10-26 | A3 有意不做：避免用户关闭后刷新又被弹出；做的话需要记住「用户已关闭」，与自动打开设置开关（B4）一起设计 |
| P2 | 接入远程 CI（GitHub Actions 调用 `make check`） | [ADR 0002](../decisions/0002-技术栈与质量工具链.md) | 当前只用本地关口；仓库推到 GitHub 后再做 |
| P2 | 复核参考项目的 Apache-2.0 复用边界，补 `NOTICE` 与致谢 | [参考项目调研](../references/reference-feature-inventory.md) | 只在确实复用算法/图标时做 |
| P2 | 冲突列表「已解决」组只列本次操作中曾冲突、现已解决的文件；合并干净带入的新文件不应出现（D1） | A3 验收演示，2026-10-26 | 现在 `resolved` = 相对 HEAD 有暂存改动且不在冲突中的路径，见 `src/host/git/operation.ts` |
| P2 | RPC 载荷上限：`mergeApply`/`mergeDraftSave` 的 Result 最多约 8 MiB，未经真实 HTTP 验证宿主 RPC 层能否接受；考虑把上限降到与单侧 2 MiB 相当 | B1 终审，2026-10-27 | `src/host/git/merge-write.ts` `MERGE_APPLY_RESULT_MAX_BYTES`；B1 验收演示实测：卡住的是插件自己 `/dsh-git` 的 256 KiB 请求体上限（宿主未拦），已改为按端点限额（合并写端点 32 MiB，见计划「意外与发现」）；是否把 Result 上限降到 2 MiB 仍待负责人决定 |
| P2 | 贮藏恢复冲突（没有进行中的操作）时保存的草稿永远不会被清理 | B1 终审，2026-10-27 | 清理只挂在 continue/abort/operationCommit；草稿 stages 不会再匹配，无害但残留 ref |
| P2 | 切换 DSH 语言会重挂载三个编辑器（标签参与 effect 依赖），丢失滚动位置与选区 | B1 终审，2026-10-27 | 把 gutter/栏标签改为可更新的 facet，不重建编辑器 |
| P2 | B3a 终审 Minor（剩 4 条，`--root` 分支问题 t2 已修）：squash 组信息清空时客户端不拦、Host 报通用错误；preset 的提交不在计划里（链未加载完）时静默打开无关列表；行动作变化后仍保留之前输入的信息；「压缩所选提交」未检查合并提交 | B3a 终审，2026-10-27 | 细节见 [b3a 计划](completed/b3a-交互式变基.md)「决策记录」终审条目 |
| P2 | B3c 终审 Minor（剩 5 条，选中竞态、refresh 序号、子模块 t2 已修）：拖放/「移到」带上被搜索隐藏或其他列表里的勾选文件；三方合并的路径未分批；重命名后的新路径进活动列表而非原列表；内联编辑 Enter 后可能 blur 再触发一次新增 | B3c 终审，2026-10-28 | 细节见 [b3c 计划](completed/b3c-搁架与Changelist.md)「决策记录」终审条目 |
| P2 | B3d 终审 Minor（剩 2 条，其余 t1/t2 已修）：名字含 `/` 的远程能列出但无法管理；有独立推送 URL 时「改 URL」只改 fetch | B3d 终审，2026-10-28 | 细节见 [b3d 计划](completed/b3d-Worktree与远程.md)「决策记录」终审条目 |
| P2 | B3b 终审 Minor（剩 10 条，`patch.ts` 注释与 `[PATCH n/m]` t1 已修）：勾选的重命名旧路径被当成「勾选外改动」多问一次贮藏；SHA-256 仓库的 mbox 头识别不到；CRLF 普通 diff `apply --check` 失败没有专门提示；`am --abort` 失败未处理；带 revision 推送时「设置 upstream」无效却仍显示；推送页换 revision 不重建 store；父组件换请求时 Diff 选项丢失但开关仍亮；高亮片段与行文本长度不符时词级标记错位；整文件并排的行构建是 O(段×行)；`n`/`p` 跳过折叠的 hunk 没有提示 | B3b 终审，2026-10-28 | 细节见 [b3b 计划](completed/b3b-Diff增强与提交菜单.md)「决策记录」终审条目 |
| P2 | Fixup/Squash 到此提交的自动变基被中止后，`fixup!`/`squash!` 提交留在 HEAD；是否在中止时提示「撤销该提交」 | B3b L4，2026-10-27 | 与 IntelliJ 一致，需负责人决定 |
| P2 | B2 终审 Minor（剩 7 条，分支比较 ref、`git.blame` Esc、卸载关闭 historyStore t1 已修）：Blame 未提交行双击应显示 HEAD→工作区（含已暂存）；修订版 Blame「文件不存在」文案区分修订并给「文件历史」按钮；文件历史第 2 页起合并条目路径退回新名（游标带当前路径）；文档头部 bootstrap 未到时误报「不在仓库」；`openTab` 失败后意图残留在队列；被该提交删除的文件禁用「与工作区比较」；窄头部 `⋯` 点动作/外部/Esc 收起 | B2 终审，2026-10-27 | 细节见 [b2 计划](completed/b2-历史与Blame.md)「决策记录」终审条目 |
| P2 | B4a 终审 Minor（8 条）：Blame 渲染器正文按读完的文本长度作 key（同长度改动可能不刷新、多页文件 blame 请求两次），应改用 `useResource(...).value?.version`；bootstrap 失败或无 `absolutePath` 时正文空白；定义未声明 `wrap: true` 但回退原文读 `wrap`；草稿存在但不可用时不自动应用、Host 判草稿过期时却会；PageUp/PageDown 步长取创建时条数，改设置后与刷新页面后不一致（应固定常量或视口行数）；没打开过日志也会因改条数立即拉一次日志；改刷新间隔立即触发一次刷新、`GitBody` 订阅全部设置；`settings.ts` 读存储中途失败时静默回默认且不通知、写失败后不再写回存储 | B4a 终审，2026-10-28 | 细节见 [b4a 计划](completed/b4a-设置页与Blame渲染器.md)「决策记录」评审条目 |
| P2 | B4b 终审 Minor（6 条）：搜索中对分组头/目录按 ← 会切换被搜索强制展开的存储折叠状态；分支抽屉与推送被拒页滑入方向变为竖向；提交 ▾ 菜单开着时开关被禁用、Esc 还焦失败；菜单内 Tab 的还焦与 APG 不同；`tabbablesOf` 不认 `contenteditable`/`display:none`；reduced-motion 检查不逐个动画核对 | B4b 终审，2026-10-28 | 细节见 [b4b 计划](completed/b4b-a11y与样式变量.md)「决策记录」终审条目 |
| P2 | 「提交后跳到日志」在 10k 仓库上偶发提示「已加载的 100 行中未找到「<新提交>」」，而新提交其实在首行：疑为提交使 version 前进、触发第二次日志重载，`logStore.refresh()` 的结果被丢弃后 `jumpTo` 先执行 | B4c T6 L4，2026-10-28 | `src/client/pages/GitWorkbench.tsx:503`；B4c 未改日志 store，非本计划回归（B4a L4 在小仓库上通过） |
| P2 | B4c 终审 Minor（6 条）：chunk 加载失败后因文件/文案变化重载成功时失败提示不消失；加载期间 pane 容器重挂会用旧宿主节点；`LogRow` memo 后「相对日期」只在行 props 变化时刷新；`pnpm dev` 下 chunk 变化整体重建 client context（可改 `rebuild()`，onEnd 抛错会让 watch 退出）；测试替身对绝对路径 realpath 而真实 provider 不做；Windows 上 `directBinary` 直连 `libexec/git-core/git.exe` 会绕过 `cmd\git.exe` 对 PATH 的补充（B4d 实测，或 win32 默认关闭） | B4c 终审，2026-10-28 | 细节见 [b4c 计划](completed/b4c-性能.md)「决策记录」终审条目 |
| P2 | Windows 上控制台「复制命令」与 blame 命令提示生成的是 POSIX shell 语法（单引号、`cd … &&`），需在 Git Bash 里运行；可按平台改成 PowerShell 引号 | B4d T4 审计，2026-10-29 | `src/host/git/write-support.ts` `shellQuote` |
| P2 | Diff 里只改了行尾（CRLF↔LF）的行看起来与原行相同：Host 如实保留 `\r`，客户端不显示行尾标记 | B4d T4 审计，2026-10-29 | 可在行尾差异时显示 `CRLF`/`LF` 小标记（IntelliJ 行为） |
| P2 | B4d 终审 Minor（剩 3 条，其余 t1/t2 已修）：缓存的工作台在 git 消失后不切到「未找到 git」空状态；`GitBody` 的 `mounted` 引用在 StrictMode 下不恢复；客户端与 Host 的绝对路径判定跨平台不一致 | B4d 终审，2026-10-29 | 细节见 [b4d 计划](completed/b4d-跨平台与安装升级.md)「决策记录」Final 条目 |
| P1 | B 阶段差距待负责人裁定：更多提交选项（author/sign-off/GPG、跳过 hooks）未实现；筛选（日期/路径等）、分支收藏与最近、提交详情 GPG 徽标与「在 N 个分支中」、合并标签、提交页创建补丁与加入 .gitignore、按仓库覆盖设置均未做 | B4d T8 核对表，2026-10-29 | 见 [b4d 计划](completed/b4d-跨平台与安装升级.md)「验证记录」T8 |
| P2 | git 2.25 / 2.38 兼容实测：在 scratchpad 编译旧版 git 后跑 `scripts/compat/run-host-tests.sh`（2.39.5、2.50.1 已全绿） | B4d T5，2026-10-29 | 编译下载的源码被自动模式拦截；负责人 2026-10-29 决定暂不做 |
| P2 | 搁架三方取回产生的冲突：三栏窗口与冲突列表里对方一侧名字仍写「贮藏的改动」；冲突来源只记在客户端内存，刷新页面后说明文字退回贮藏文案 | t1 T2，2026-10-29 | 需把 `origin` 传给 `conflictSides`/`withStashLabel`/`MergeWindow` |
| P2 | 已跟踪的子模块要等 Host 拒绝一次后才在搁置对话框里置灰：status 条目不带子模块标记，可在 `FileEntry` 加可选字段（porcelain v2 的 `S` 标记，协议改动需批准） | t2 评审 M5，2026-10-30 | 见 [ADR 0011](../decisions/) 追记 |
| P2 | 只读会话的「未找到 git」空状态，「设置 git 路径」入口要先被 Host 拒绝一次才隐藏（bootstrap 失败时拿不到 writePolicy）；`gitPathReadOnly` 置位后不复位，会话变可写要重新挂载 | t2 评审 M4，2026-10-30 | 见 [ADR 0014](../decisions/0014-git路径的信任边界.md) 补充；可在 not-found 错误里带 writePolicy（协议改动） |

## 已完成

| 完成日期 | 事项 | 计划 |
|---|---|---|
| 2026-10-30 | TODO 第二组：交互式变基 `--root` 前导 drop 的分支保持不动；搁架提示条绑定条目、refresh 序号、拒绝子模块；新建 worktree 做 realpath 包含性检查（含 Windows 分隔符）；只读会话不能设置 git 路径、每个写操作取 git 快照（ADR 0014 补充）；整分支评审 I1/I2、M1–M3、M6 已修 | [t2](active/t2-TODO设计类修复.md) |
| 2026-10-29 | TODO 批量修复：数据安全 7 条（草稿只在成功/推进后清理、合并窗口 `beforeunload`、`<remote>/HEAD` 删除 `--no-deref`、`remoteList` 脱敏、主/锁定 worktree 禁删、保存失败询问可再答与关窗按取消、改写历史后清空消失的选中）与文案/小修正/小功能/测试 15 条；顺带修复并发设置 git 路径时旧请求生效 | [t1](completed/t1-TODO批量修复.md) |
| 2026-10-28 | `layout.test.ts`「2000 行 < 50ms」高负载偶发超时：阈值改为 200ms 只防数量级回退（满载实测 52–62ms），真实渲染预算由 B4c 客户端 harness 测量 | [b4c](completed/b4c-性能.md) T5 |
| 2026-10-29 | B4d 跨平台与安装升级（B4 打磨四份全部完成）：git 版本门控（最低 2.25，`--update-refs` 2.38、搁架三方 2.43）、「未找到 git / 版本过低」空状态与设置页 git 路径（Host 内存采用，校验见 [ADR 0014](../decisions/0014-git路径的信任边界.md)）；跨平台审计（win32 路径校验、沙箱包含判断、Windows 不直连 git）；`scripts/compat`（2.39.5 全绿）；1.0.0-rc.1 打包清单 + tarball 安装/升级/卸载/engines 实测；`pnpm matrix` 12 种仓库；README 改写为用户文档；B 阶段核对表；终审 I1 与 M2–M7 已修，负责人验收通过 | [b4d](completed/b4d-跨平台与安装升级.md) |
| 2026-10-29 | B4c 性能：10k 合成仓库基准 `pnpm bench`（§16.8 各项达标，bootstrap 稳态 285→15ms）与 2000 行日志滚动 harness `pnpm bench:client`（每步中位 5.4→0.4ms）；Host 与测试直连真实 git 绕过 xcrun 转发层；CodeMirror 拆成按需 chunk `lib/client.merge.js` 并压缩标识符（client.js gzip 305→175 KB，[ADR 0013](../decisions/0013-客户端产物拆分按需chunk与标识符后压缩.md)）；`LogRow` memo；`make check` 约 488s→30s 并纳入 build + smoke；TD-16 与 layout 计时假失败处理；整分支终审 C1/I2/I3 已修，负责人验收通过 | [b4c](completed/b4c-性能.md) |
| 2026-10-28 | B4b a11y 与样式变量：DSH 变量全量校正与样式检查（变量快照、无字面色、reduced-motion、`outline:none` 例外、状态/静态色文字混色，[ADR 0012](../decisions/0012-样式变量快照与状态色文字混色.md)）；happy-dom DOM 测试（TD-18）；分支树单一 Tab 停靠点；全部手写菜单键盘统一、不可用项可聚焦并读出原因；模态对话框 Tab 圈定；两套主题对比度实测达标；内容区动效；验收走查的贮藏选择/写后还焦、合并窗口 gutter 还焦；整分支终审 I1 已修，负责人验收通过（顺带处理：分支树 roving、合并窗口 label-in-name 误报、「应用非冲突更改 ▾」外部点击、A1–A3 样式变量、干净文件状态点文案、变基列表标签对比度） | [b4b](completed/b4b-a11y与样式变量.md) |
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
