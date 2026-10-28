# b4a-设置页与Blame渲染器：Git 设置弹层与可选「Git Blame」文档渲染器

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、契约与验收，不写完整实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 执行中 |
| 里程碑 | B4 打磨（第 1 份，共 4 份：B4a 设置页 + Blame 渲染器、B4b a11y 与样式变量、B4c 性能、B4d 跨平台/安装升级/文档；拆分 2026-10-28 负责人同意） |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §13（设置）、§9.7（可选「Git Blame 渲染器」）、§10.1（自动打开冲突列表「设置可关，默认开」）、§16（轮询 3s）；[B1 计划](../completed/b1-三栏合并.md)「不包含」（自动打开冲突列表/自动应用非冲突更改的开关）；[B2 计划](../completed/b2-历史与Blame.md) 待确认 3（Blame 渲染器移到 B4，默认关）；[B3b 计划](../completed/b3b-Diff增强与提交菜单.md)（Diff 模式已持久化到 `dsh-idea-git.settings.v1`） |
| 分支 | `b4a-settings-blame-renderer`（从 main 切出） |
| 批准记录 | 2026-10-28 负责人批准计划，待确认 1–5 按推荐；执行方式：当前会话内联执行，最后做一次整分支评审 |

## 目标

用户在仓库栏 `⋯` →「设置…」打开 Git 设置弹层，调整自动刷新与间隔、默认 Diff 模式、日志每页条数、提交后行为、日期格式、紧凑模式、自动打开冲突列表、合并窗口自动应用非冲突更改，以及是否启用「Git Blame」文档渲染器；改动立即生效、按浏览器持久化，同一浏览器里其他 DSH 标签页同步。启用 Blame 渲染器后，在文档预览里打开仓库内的代码文件，默认显示带 blame gutter 的只读视图，预览下拉仍可切回内置代码查看器。

## 范围

**包含：**

- **设置模型**：`src/client/settings.ts` 扩展为完整的 `WorkbenchSettings`（校验、钳制、默认值、订阅、跨标签页 `storage` 事件），仍用键 `dsh-idea-git.settings.v1`；现有 `diffMode`、`changelistGrouping` 无缝迁移（旧值原样读出）。
- **设置弹层**：仓库栏 `⋯` 菜单新增「设置…」，打开 Level 2 浮层（设计 §5.3）；「恢复默认」；「确认破坏性操作：始终开启」以只读说明出现（安全底线，设计 §13）。
- **接线**：自动刷新开关持久化（现在是 `GitBody` 内存状态，刷新页面即恢复为开）、刷新间隔 1–10s、日志每页条数 50/100/200、默认 Diff 模式、提交后行为（留在提交页 / 跳到日志）、日期格式（绝对 / 相对）、紧凑模式（日志表）、自动打开冲突列表、合并窗口打开时自动应用非冲突更改。
- **Git Blame 渲染器**：`ctx.documentPreviews.register` + keyed `sidebar.right.tab.document` slot；随设置注册/注销；正文复用 B2 的 Blame 视图组件。
- 文案中英双语（新分区 `locales/settings.ts`）。

**不包含：**

- **git 路径**（设计 §13 标 P1）：需要新增 Host 协议字段，并由 Host 校验可执行文件（否则浏览器里的一个字符串就能决定 Host 启动哪个程序），且主要服务于 Windows/非标准安装——移到 B4d 跨平台一起做（见待确认 2）。
- **默认推送方式**：设计只给了一个取值（当前分支 → upstream，无 upstream 时询问），这就是现有行为，不做成可选项。
- 按仓库覆盖的选项（设计 §13「如作者信息」）、接入 DSH 全局设置页（设计 §6.3 标 P1「接 DSH 设置页」，DSH 没有给插件的设置页扩展点前不做）。
- Blame 渲染器里的「点 gutter 看提交详情 / 双击看 diff」之外的新交互：渲染器只复用 B2 已有的 Blame 视图能力。
- TD-18（没有 DOM 测试环境）在 B4b 处理；本计划的交互仍按惯例用纯函数 + 静态渲染测试 + L4 走查覆盖。

## 待负责人确认

1. **Blame 渲染器开关语义**：推荐按设计 §9.7 做成两档——关（不注册，默认）/ 开（以 `priority: 'extension'` 注册，成为仓库内代码文件的默认查看器；预览工具栏下拉仍可逐 tab 切回内置「代码」查看器，DSH 会记住每个 tab 的选择）。DSH 注册表实测：`extension` 档总是排在 `builtin` 前面（`matchingDocumentPreviews`）。备选「开但不设为默认」需要以 `builtin` 档注册，排序就取决于插件加载顺序，不可靠，不推荐。
2. **git 路径移到 B4d**：理由见「不包含」。推荐同意。
3. **日期格式**：设计写「跟随 DSH」，但 DSH 没有公开给插件的日期格式偏好（T1 再核实一次，核实结果写进 references）。推荐两档：绝对（默认，即现在日志列 `MM-DD HH:mm` 的行为）/ 相对（「3 小时前」，复用 `ui-primitives` 的 `relativeTime`，与提交详情 `title` 里的相对时间一致）；作用于日志日期列与提交详情。
4. **紧凑模式**：推荐日志表行高 26px → 24px，隐藏作者列和哈希列（保留提交图、主题、日期；hover 主题仍能看到全文）；其他页面不受影响。
5. **自动应用非冲突更改默认关**：B1 的决定是 Result 从 base 开始、所有改动逐块处理（与 IntelliJ 一致）；开启后打开合并窗口时自动执行一次「应用非冲突更改（全部）」，可用撤销退回。推荐默认关。

## 验收标准

- [ ] AC1：设置模型对缺失/损坏/越界的存储值回退到默认或钳制（刷新间隔 1–10s，每页条数只接受 50/100/200），旧的 `diffMode`/`changelistGrouping` 原样保留；存储不可用时设置在当前页面仍生效；写入后同一页面订阅者和其他标签页（`storage` 事件）都收到新值（单测）。
- [ ] AC2：仓库栏 `⋯` 有「设置…」，弹层列出全部设置项与当前值、「恢复默认」、破坏性操作的只读说明；`Esc`/点外部关闭并把焦点还给触发按钮（静态渲染 + L4）。
- [ ] AC3：关闭自动刷新后刷新页面仍为关；间隔改为 N 秒后轮询按 N 秒触发（轮询器假时钟单测 + L4 观察控制台/网络）。
- [ ] AC4：每页条数改变后日志按新条数重新加载；日期格式切换后日志日期列与提交详情同时变化；紧凑模式下日志行高 24px、无作者/哈希列，提交图连线不错位（单测 + L4 截图）。
- [ ] AC5：提交后行为为「跳到日志」时，提交成功后切到日志页并选中新提交；为「留在提交页」时行为同现在（单测 + L4）。
- [ ] AC6：关闭「自动打开冲突列表」后，操作停在冲突时不自动打开，横幅「解决冲突…」仍可用；开启（默认）时行为同现在（单测）。
- [ ] AC7：开启「自动应用非冲突更改」后，打开合并窗口时非冲突块已应用、冲突块仍待处理，撤销可退回；默认关时行为同现在（合并窗口控制器单测）。
- [ ] AC8：Blame 渲染器默认不注册；开启后立即出现在仓库内代码文件的预览下拉里并成为默认，关闭后立即注销、已打开的 tab 回到内置查看器；仓库外文件、未跟踪文件、`documentPreviews` 不存在（文档预览插件未装）时不报错——前两者显示原文并说明原因，后者不注册（单测 + L4）。
- [ ] AC9：L4 截图 `.evidence/b4a/`；`make check` 绿；中英文案键集一致。

## 契约（T1 冻结）

```ts
// src/client/settings.ts
export const SETTINGS_KEY = 'dsh-idea-git.settings.v1'   // 现名 DIFF_SETTINGS_KEY，保留为别名直到引用全部迁移
export interface WorkbenchSettings {
  autoRefresh: boolean                    // true
  refreshIntervalSec: number              // 3，整数，钳制到 1..10
  diffMode: DiffMode                      // 'unified'
  logPageSize: 50 | 100 | 200             // 100
  afterCommit: 'stay' | 'log'             // 'stay'
  dateFormat: 'absolute' | 'relative'     // 'absolute'
  compact: boolean                        // false
  autoOpenConflicts: boolean              // true
  mergeAutoApplyNonConflicting: boolean   // false
  blameRenderer: boolean                  // false
  changelistGrouping: boolean             // false（B3c，不在弹层里显示，由提交页开关控制）
}
export const DEFAULT_SETTINGS: Readonly<WorkbenchSettings>
export function parseSettings(raw: unknown): WorkbenchSettings          // 纯函数：未知键保留在存储里但不进类型；非法值回退默认
export function readSettings(): WorkbenchSettings
export function writeSettings(patch: Partial<WorkbenchSettings>): WorkbenchSettings  // 合并写入，保留存储中的未知键
export function resetSettings(): WorkbenchSettings                       // 回到默认，但保留 changelistGrouping
export function subscribeSettings(listener: (next: WorkbenchSettings) => void): () => void  // 同页写入 + 跨标签页 storage 事件
export function useSettings(): WorkbenchSettings                         // useSyncExternalStore 包装
// readDiffMode/writeDiffMode/readChangelistGrouping/writeChangelistGrouping 保留，改为基于上面实现
```

## 任务

### T1：设置模型（完成）

- **目标**：完整的设置读写、校验与订阅，旧值兼容。
- **涉及文件**：`src/client/settings.ts`、`test/client/settings.test.ts`（新）；核实 DSH 是否有日期格式偏好，结论写进 `docs/references/dsh-integration-feasibility.md`。
- **接口与要点**：见「契约」。`parseSettings` 是纯函数，`readSettings` 缓存解析结果、存储原始串变化时才重新解析（`useSyncExternalStore` 要求快照引用稳定）。跨标签页只认 `event.key === SETTINGS_KEY`（以及 `key === null` 的 `clear()`）。存储读写全部 `try/catch`，失败时内存值继续生效。
- **测试**：默认值；每个字段的非法值（错类型、越界、非白名单）；`refreshIntervalSec` 小数取整与钳制；保留未知键；旧格式 `{ diffMode: 'split', changelistGrouping: true }` 原样读出；`resetSettings` 保留 `changelistGrouping`；同页订阅收到写入；模拟 `storage` 事件触发订阅；`getItem`/`setItem` 抛错时读写不抛、内存值生效；快照在无变化时引用不变。
- **完成标准**：`settings.test.ts` 全绿，现有引用 `readDiffMode` 等的测试不变。
- **验证命令**：`make check`

### T2：设置弹层与入口（待开始）

- **目标**：仓库栏 `⋯` →「设置…」打开弹层，可编辑全部设置项。
- **涉及文件**：`src/client/pages/SettingsSheet.tsx`（+ `.module.css`，新）、`src/client/pages/RepoBar.tsx`（新菜单项 `data-repo-settings`、`onSettings?: (trigger) => void`）、`src/client/pages/GitWorkbench.tsx`（打开/关闭、焦点返还）、`src/client/locales/settings.ts`（新）与 `src/client/locales.ts`、`test/client/pages/settings-sheet.test.tsx`（新）。
- **接口与要点**：`SettingsSheetView({ settings, onChange(patch), onReset, onClose })` 是可静态渲染的纯视图；容器用 `useSettings()` + `writeSettings`。控件：开关用 `role="switch"`；刷新间隔为数字输入（1–10，失焦/回车时钳制）且自动刷新关时禁用；每页条数、Diff 模式、提交后行为、日期格式用分段按钮或单选组；「确认破坏性操作」只读一行；Blame 渲染器一行附说明「开启后成为仓库内代码文件的默认预览，可在预览下拉中切回」。浮层材质沿用现有 Sheet（同 `BranchSheets`），不新建菜单材质。样式只用 DSH 存在的变量（`test/client/pages/css-tokens.test.ts` 的 `GUARDED` 加上新文件）。
- **测试**：静态渲染每个设置项与当前值；`onChange` 收到的补丁正确（纯函数 `settingsPatchFor(control, value)` 单测）；自动刷新关时间隔输入 `disabled`；仓库栏菜单含「设置…」；中英键集一致（现有 `locales.test.ts` 自动覆盖）。
- **完成标准**：L4 能打开弹层、改值、恢复默认、`Esc` 关闭焦点回到 `⋯`。
- **验证命令**：`make check`

### T3：刷新、日志与显示类设置接线（待开始）

- **目标**：自动刷新/间隔、每页条数、默认 Diff 模式、日期格式、紧凑模式生效。
- **涉及文件**：`src/client/GitBody.tsx`（`autoRefresh` 改读写设置，`intervalMs = refreshIntervalSec * 1000` 进 effect 依赖）、`src/client/pages/GitWorkbench.tsx`（`createLogStore({ pageSize: settings.logPageSize })`，条数变化时重建 store 并 dispose 旧的）、`src/client/pages/LogRow.tsx`（`formatLogDate` 增加 `format` 参数；相对格式复用 `CommitDetail.formatRelativeTime`）、`src/client/pages/CommitDetail.tsx`（日期主显示按格式，`title` 显示另一种）、`src/client/pages/LogTable.tsx` 与 `src/client/graph/layout.ts`/`GraphCell.tsx`（行高由常量改为参数：`ROW_HEIGHT = 26`、新增 `COMPACT_ROW_HEIGHT = 24`；紧凑时隐藏作者与哈希列）、`src/client/pages/DiffViewer.tsx`（仍读 `readDiffMode`，设置弹层改的就是同一个值，无需改动，只补测试）。
- **接口与要点**：`formatLogDate(iso, now, format: 'absolute' | 'relative' = 'absolute', t?)`；`LogTable` 新 prop `compact?: boolean`；`GraphCell` 已有 `height` 参数，`edgePath` 已接受 `height`，只需把行高传下去。重建日志 store 时保留当前选中 sha（重新加载后若仍在则选中）。
- **测试**：`polling.test.ts` 增加「间隔变更后按新间隔触发」（假时钟）；`formatLogDate` 两种格式与跨年；`edgePath(edge, 24)` 的坐标；紧凑模式静态渲染无作者/哈希单元格、行高 24；日志 store 用 `pageSize: 50` 时请求 `limit: 50`（已有选项，补一条接线测试即可）。
- **完成标准**：AC3、AC4 有单测；L4 截图紧凑/非紧凑、绝对/相对对比。
- **验证命令**：`make check`

### T4：行为类设置接线（待开始）

- **目标**：提交后行为、自动打开冲突列表、合并窗口自动应用非冲突更改生效。
- **涉及文件**：`src/client/pages/GitWorkbench.tsx`（`onCommitted` 在 `afterCommit === 'log'` 时切到日志页并发出「选中提交」意图；`autoOpen.observe(...)` 为真且 `settings.autoOpenConflicts` 时才 `openOverlay`）、`src/client/pages/merge-window-controller.ts`（新依赖 `autoApplyNonConflicting: boolean`，模型首次就绪时 dispatch `applyNonConflicting('all')`，并且只做一次：重新加载/草稿恢复不重复应用）、对应测试。
- **接口与要点**：跳到日志后选中新提交复用现有的 `WorkbenchIntent` `{ kind: 'showCommit'; sha }`（B2「在日志中显示」）；日志尚未包含新提交时依赖已有的「刷新后定位」逻辑。自动应用只对没有草稿的文件生效：有草稿（用户已处理过）时不覆盖。
- **测试**：`onCommitted` 两种设置下的路由结果（纯函数 `afterCommitRoute(setting, result)`）；自动打开在设置关时不调用 `openOverlay`（抽出判断函数单测）；控制器：开启时初始模型已应用非冲突块、`merge-store.undo()` 回到 base、有草稿时不应用、关闭时与现在一致。
- **完成标准**：AC5–AC7 有单测。
- **验证命令**：`make check`

### T5：Git Blame 渲染器（待开始）

- **目标**：设置开启时注册「Git Blame」文档渲染器，关闭时注销。
- **涉及文件**：`src/client/blame-renderer.tsx`（新：定义 + 正文）、`src/client/index.ts`（可选注入 `documentPreviews`；订阅设置驱动注册/注销）、`docs/references/dsh-integration-feasibility.md`（新增一节：注册表排序、`DocumentPreviewProps` 字段、`resourceAddress` → 绝对路径的换算、未装文档预览插件时的表现）、`test/client/blame-renderer.test.tsx`（新）。
- **接口与要点**：
  - 定义：`{ id: 'dsh-idea-gittool/blame', extensions: CODE_HIGHLIGHT_EXTENSIONS（来自 ui-primitives）, priority: 'extension', title: () => t('blameRenderer.title'), loading: 'text-pages' }`；正文以同一 `id` 为 key 注册到 `sidebar.right.tab.document`，`locale: 'gitWorkbench'`。slot 组件常驻注册，只有定义随设置增删（定义不在时注册表不会选中它）。
  - `documentPreviews` 是可选依赖：先核实 cordis 可选注入写法（或运行时 `ctx.get('documentPreviews')`），不存在时跳过并在控制台记一条 debug，不抛错；核实结果写 references。
  - 正文 `BlameRendererBody(props: DocumentPreviewProps & injected)`：从 `resourceAddress` 得到绝对路径（换算方式先读 DSH `document/contract.ts` 与现有 `register-document-actions.ts` 的 owner 取值，结论写 references），用 `blameRepoPath` 判断是否在仓库内；在仓库内渲染 B2 的 `BlameOverlay`（去掉返回按钮与全屏，提交级跳转仍经 `openInGit` 意图队列）；仓库外 / 未跟踪 / blame 失败时显示 `content` 原文（等宽、按 `wrap`）+ 一行说明（「不在 Git 仓库中」「文件未被 Git 跟踪」）。
  - 注册/注销放在 `ctx.effect` 里，订阅 `subscribeSettings`；插件卸载时一并注销。
- **测试**：设置关时 `register` 未被调用；开→调用一次、关→disposer 被调用、再开→再注册（假注册表）；`documentPreviews` 缺失时不抛；正文三种状态（仓库内、仓库外、未跟踪）的静态渲染；定义的 `extensions` 与 `priority`。
- **完成标准**：AC8；L4 在真实 DSH 里开关两次，截图预览下拉与 Blame 正文。
- **验证命令**：`make check`

### T6：自验证与文档（待开始）

- **目标**：L4 走查全部验收标准，更新文档。
- **涉及文件**：`docs/runbooks/verification.md`（新增「设置与 Blame 渲染器实机验证」步骤）、`docs/ARCHITECTURE.md`（settings、blame-renderer）、`docs/quality/QUALITY.md`、`docs/plans/TODO.md`、本计划「验证记录」；截图 `.evidence/b4a/`。
- **测试**：无新增；按 runbook 实机执行。
- **完成标准**：AC1–AC9 都有证据；整分支评审（独立子代理）发现逐条处理。
- **验证命令**：`make check`、`pnpm build && pnpm smoke`

## 进度

- 2026-10-28 — T1 — `settings.ts` 扩展为完整 `WorkbenchSettings`（逐字段校验、间隔钳制、未知键保留、写失败退回内存、同页订阅 + 跨标签页 `storage` 事件、`useSettings`）；DSH 无日期格式偏好，写进 references §16

## 下一步

- T2：先写 `test/client/pages/settings-sheet.test.tsx`（`SettingsSheetView` 静态渲染、`settingsPatchFor`、仓库栏「设置…」菜单项），再实现 `SettingsSheet.tsx` 与 `locales/settings.ts`。

## 决策记录

- 2026-10-28 — 计划草稿：git 路径与默认推送方式不进 B4a（理由见「不包含」）；设置仍按设计 §13 存 `localStorage` 键 `dsh-idea-git.settings.v1`，与 B3b/B3c 已写入的值共用。

## 意外与发现

- 2026-10-28 — 读 DSH 源码（`ui-sidebar-documentpreview/src/client/document/registry.ts`）：注册表排序是「`extension` 档在前 → 后缀更长 → 注册顺序」，所以插件以默认的 `extension` 档注册就会压过内置代码查看器；工具栏列出所有匹配实现并按 tab 记住选择。这正是设计 §9.7「默认关闭」的原因，T5 将写进 references。

## 阻塞

- 无

## 验证记录

- 无
