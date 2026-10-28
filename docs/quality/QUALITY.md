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
| `src/host/` | B | A1 只读端点全部真实临时仓库测试，10k 仓库实测均在预算内；A2 写执行层与提交/回滚/推送/拉取端点用真实仓库 + bare 远程测试，3081 端到端确认写命令经 `sandbox.confine`。A3 新增智能贮藏/操作控制/分支写/冲突解决/集成操作/更新项目/贮藏模块，均用真实临时仓库与 bare 远程测试（含 UU/AA/DU/UD、变基进度、被强推的上游、贮藏按 sha 定位），每个任务经独立评审并修复；嵌套 refs 监听（TD-5）、回滚确认（TD-8）、大批量路径（TD-9）、lease 期望值（TD-10）已收掉。缺口：正则 ReDoS 与 >4MiB patch（TD-7）；删除分支竞态、重置到远程的文件/目录冲突、`logs/refs/stash` 未监听、标记 `update-ref` 无旧值检查、冲突标记长度（TD-11–TD-15）；`watch.test.ts` 高负载超时（TD-16）；osxkeychain 在 confine 下不可用（references §13，TODO 反馈 DSH） | 2026-10-26 |
| `src/client/` | B | 提交图布局、各 store、页面静态渲染与纯函数有单测；A3 新增写动作框架（`action-store`）、单覆盖层路由、分支/贮藏/冲突/集成操作各页，store 与动作可用性矩阵有单测，中英双语由 CJK 静态扫描与英文渲染测试守护。A1/A2 三档宽度/筛选/详情/diff/控制台实机走查；A3 已在 3081 走查并通过负责人验收演示。缺口：没有 DOM 交互测试（焦点返回、Esc、双击、右键、Delete 键只有纯函数测试，TD-18）、菜单未用 `MenuSurface`（TODO）、build.mjs 缺 `lib/` 时失败（TD-17） | 2026-10-26 |
| `src/shared/` | B | 协议常量/类型与 isRpcResult 有单测；A3 在 T1 冻结全部端点类型（`RpcEndpointTypes` 逐端点编译期穷举、`WRITE_ENDPOINTS`），之后只追加；`git/hook-failed`、`git/would-overwrite`、`git/dirty-worktree` 等错误的 `details` 键已有类型，其余少数键仍只在 Host 实现里约定 | 2026-10-26 |
| `build.mjs` | B | 双面产物 + smoke（含 HMR 重跑时样式替换）；契约漂移风险见 TD-1 | 2026-10-25 |
| 文档与 harness | B | 计划/ADR 校验已机器化；references §13 已回写 M0/A1 实测（watch、HMR、fs）；升级 DSH 后需重跑（TD-2） | 2026-10-25 |
| `src/client/merge/`（B1 合并模型） | A | 行级 Myers diff、diff3 分块、块状态机、简单冲突、编辑映射、草稿往返、已解决文件重放均为纯函数，单测覆盖主要路径与边界；经 `test/host/merge-e2e.test.ts` 与真实 Host 数据串联验证。缺口：超大文件走粗分块降级，只给提示不细分 | 2026-10-27 |
| `src/client/store/merge-store.ts`（B1 合并 store） | B | 打开（新建/草稿恢复/作废）、动作与撤销、保存草稿、应用、只读与 stale、旧响应丢弃有单测，并在 e2e 中接真实 Host 跑通合并/变基/拣选/autocrlf/草稿/还原链路。缺口：已解决文件「保存并关闭」后再次打开不恢复未应用的改动（T7 关注点 5）；无 DOM 的真实时序（StrictMode 双挂载）靠实机 | 2026-10-27 |
| `src/client/pages/MergeWindow*`（B1 合并窗口） | B | 视图用静态渲染测，编辑器适配用 `EditorState` 测，全屏决策与转换为纯函数单测；`createMergePane`、滚动同步、gutter DOM、焦点、宿主全屏时序没有 DOM 测试（TD-18 同类），由 2026-10-27 负责人验收演示在真实 DSH 中覆盖（AC1–AC14、22 张截图）；滚轮同步仅脚本验证 | 2026-10-27 |
| `src/host/git/merge-*.ts`（B1 Host 合并端点） | A | `mergeFile`/`mergeDraftSave`/`mergeApply`/`unresolveConflict` 用真实临时仓库测试：三方字节一致、autocrlf、可执行位、stale 工作区/索引、草稿作废与清理（含变基换步）、二进制/超限/删除类、受限 ref 存草稿。缺口：删除类冲突的「还原冲突解决」只能提示在终端处理（计划「意外与发现」第 2 条，待决定）；子模块冲突未覆盖 | 2026-10-27 |
| `src/host/git/{blame,file-history,compare,revision}.ts`（B2 只读端点） | A | 真实临时仓库测试覆盖：行段与 `git blame` 逐行一致、未提交行、分页拼接、CRLF/无末尾换行/空文件、二进制/过大/未跟踪/缺失、浅克隆边界、textconv 不生效；文件历史跨重命名与旧路径 diff、短哈希、游标；比较的提交/差异文件与 `git log`/`git diff` 一致、交换、无公共祖先、range 只扫描本文件；路径/修订号注入。缺口：文件历史第 2 页起合并条目路径（TODO Minor） | 2026-10-27 |
| `src/client/store/{blame,file-history,compare}-store.ts`（B2 store） | A | 分页、过期响应丢弃、version 变化重载、中止、交换、按旧路径取 diff 均有单测 | 2026-10-27 |
| `src/client/pages/{BlameView,FileHistoryPage,ComparePage}`、`blame-page`、`document-actions`（B2 视图与入口） | B | 静态渲染、菜单可用性矩阵、键盘判定、头部宽度量法有单测；DOM 时序（hover 延迟、焦点、滚动恢复、ResizeObserver）没有 DOM 测试（TD-18 同类），由 L4 走查与 2026-10-27 负责人验收演示覆盖。缺口：终审与 L4 的 11 条 Minor 在 TODO | 2026-10-27 |
| `src/host/git/{rebase-plan,interactive-rebase}.ts`、`src/shared/rebase-todo.ts`（B3a） | A | 真实临时仓库测试覆盖：计划与 `rev-list --first-parent` 一致、已推送、分支、五种阻塞；pick/reword/edit/squash/fixup/drop/重排/从根/--update-refs 的结果历史、信息原样（shell 元字符、`#` 行、中文）、作者与作者时间保留；三种停下原因、edit 停下时提交/Amend、智能贮藏完成与停下两种路径、HEAD 过期与非法条目。缺口：Windows（Git for Windows sh）未实测 | 2026-10-27 |
| `src/client/{rebase/rebase-model.ts,store/rebase-store.ts,pages/InteractiveRebasePage.tsx}`（B3a） | B | 模型（分组、默认 squash 信息、改写已推送判定、预览即 Host todo）与 store（过期响应、防重复提交）有单测；视图静态渲染与键盘判定有单测；拖拽、焦点、下拉的 DOM 行为只由 L4 覆盖 | 2026-10-27 |
| `src/host/git/{tag-write,patch,fixup}.ts`、`diff.ts` 选项、`push.ts` revision（B3b） | A | 真实临时仓库测试覆盖：`-w` 四种 scope、整文件上下文、轻量/附注标签与重名/非法名、推送到祖先提交与拒绝非祖先、`format-patch` 一致与合并提交拒绝、`am` 预览/应用/失败回滚、`apply --index` 与不能应用时不留痕、fixup 与 squash（含勾选外改动的贮藏顺序）。缺口：推送直到此提交未经 L4 | 2026-10-27 |
| `src/client/{diff/diff-views.ts,settings.ts}`、`DiffHunks`/`DiffViewer` 增强、`CommitMenuSheets`（B3b） | B | 纯函数（并排配对、词级、折叠、锚点）与静态渲染有单测；宽度门槛、滚动跳转、下载只由 L4 覆盖 | 2026-10-27 |
| `src/host/git/shelf.ts`（B3c） | A | 真实临时仓库测试覆盖：部分搁置（已暂存/未暂存/二进制/未跟踪）与回滚、补丁重建、干净取回/保留/删除、拒绝不干净、三方合并（含未暂存的本地改动）、id 与路径校验 | 2026-10-28 |
| `src/client/{changelists/*,store/shelf-store.ts}`、`ShelfPanel`、`ChangelistView`（B3c） | B | 模型（增删改、活动、移动、同步、持久化与损坏回退）与 store、静态渲染有单测；拖放只有处理函数共用、未经 L4 | 2026-10-28 |
| `src/host/git/{remote-write,worktree}.ts`、`tag-write.ts` 推送/删除（B3d） | A | 真实临时仓库 + 本地 bare 远程测试覆盖：标签推送与删除（只本地/本地+远程/不存在）、远程分支删除与跟踪 ref、upstream 设置与取消、远程增改删重命名与凭据脱敏、以 `-` 开头的名字与 URL 被拒；worktree 列表/从已有或新分支新增/重复签出拒绝/有改动需 force/清理/不能删当前/仓库外路径被拒 | 2026-10-28 |
| `RemoteSheets`、`RemotesPages`、`branch-actions` 新项（B3d） | B | 菜单可用性、flag 关闭时入口消失、静态渲染有单测；表单交互与布局由 L4 覆盖 | 2026-10-28 |
| `src/client/{settings.ts,blame-renderer.tsx}`、`SettingsSheet`（B4a） | B | 设置模型（默认值、逐字段回退、钳制、未知键保留、写失败退回内存、同页与跨标签页订阅）、控件到补丁的映射、渲染器注册绑定（开/关/再开/重复 id）、正文状态判定与回退视图有单测；L4（隔离 DSH 3082）走查 AC1–AC8：弹层、紧凑/相对日期、刷新间隔与持久化、提交后跳日志、自动打开冲突列表开关、合并自动应用与撤销、Blame 渲染器开关与跨标签页同步。缺口：未装文档预览插件时的跳过只按 cordis 语义推断、未实机验证；并排 Diff 默认值未在 ≥900px 面板实机看 | 2026-10-28 |
