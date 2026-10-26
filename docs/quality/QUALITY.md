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
| `src/client/pages/MergeWindow*`（B1 合并窗口） | C | 视图用静态渲染测，编辑器适配用 `EditorState` 测，全屏决策与转换为纯函数单测；`createMergePane`、滚动同步、gutter DOM、焦点、宿主全屏时序没有 DOM 测试（TD-18 同类），等待 L4 实机走查，flag 默认仍关。通过实机验收后上调 | 2026-10-27 |
| `src/host/git/merge-*.ts`（B1 Host 合并端点） | A | `mergeFile`/`mergeDraftSave`/`mergeApply`/`unresolveConflict` 用真实临时仓库测试：三方字节一致、autocrlf、可执行位、stale 工作区/索引、草稿作废与清理（含变基换步）、二进制/超限/删除类、受限 ref 存草稿。缺口：删除类冲突的「还原冲突解决」只能提示在终端处理（计划「意外与发现」第 2 条，待决定）；子模块冲突未覆盖 | 2026-10-27 |
