# b4b-a11y与样式变量：DSH 样式变量全量校正与可访问性打磨

<!--
执行方式（内联 / subagent 驱动）由负责人在批准计划时选择（SOP §3）。
本计划只写意图、契约与验收，不写完整实现代码。
-->

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 执行中 |
| 里程碑 | B4 打磨（第 2 份，共 4 份：B4a 设置页 + Blame 渲染器、**B4b a11y 与样式变量**、B4c 性能、B4d 跨平台/安装升级/文档；拆分 2026-10-28 负责人同意） |
| 设计依据 | [产品设计 v0.2](../../design/2026-10-25-产品设计-v0.2.md) §15.2（Token 使用）、§15.3（提交图配色与对比度）、§15.5（动效与可访问性）；[设计决策 v0.2](../../design/2026-10-25-产品设计决策-v0.2.md) §4（B4 打磨）；[TODO](../TODO.md) 中的样式变量、分支树 roving tabindex、合并窗口 label-in-name 三条 P2；[tech-debt](../../quality/tech-debt.md) TD-18；[B4a 计划](../completed/b4a-设置页与Blame渲染器.md)「不包含」（TD-18 移到 B4b） |
| 分支 | `b4b-a11y-tokens`（从 main 切出） |
| 批准记录 | 2026-10-28 负责人批准计划，待确认 1–4 按推荐；执行方式：当前会话内联执行，最后做一次整分支评审 |

## 目标

所有样式只引用 DSH 运行时真实存在的变量，状态色与等宽字体在 A1–A3 的页面上真正生效，并由静态检查守住；整个工作台只用键盘就能走完主要流程，每个可交互控件都有可见焦点环、与可见文字一致的可访问名称，图形与文字的对比度达到设计 §15.5 的阈值；交互行为（焦点返回、Esc 退一级、方向键导航）有 DOM 级自动化测试兜底，而不再只靠人工走查。

## 现状（2026-10-28 盘点）

- **样式变量**：客户端 51 个 `*.module.css` 共引用 38 个不同的 `--dsw-*` 变量；对照 DSH `packages/client/ui-theme/src/styles/`（`design-platform.css`、`base.css`、`gradient-shadow-text.css`），只有 4 个不存在：`--dsw-alias-state-success`、`--dsw-alias-state-warn`、`--dsw-font-mono`、`--dsw-alias-interactive-bg-selected`。它们分布在 23 个 A1–A3 样式文件里（`ConsoleDrawer` 6 处、`PushRejectedPage` 5 处、`StatusBar`/`StatusLetter`/`document-actions` 各 3 处……）。现有守卫 `test/client/pages/css-tokens.test.ts` 只覆盖 `GUARDED` 正则里的 10 个文件，且只认这 4 个名字。[references 的 Token 表](../../references/dsh-integration-feasibility.md)第 287 行把状态色写成 `success`/`warn`，是这次错误的源头。
- **字面颜色**：0 处（已满足设计 §15.2）。
- **动效**：5 个文件有动画（4 个底部弹层 160ms 滑入、日志骨架屏脉冲），全部已有 `prefers-reduced-motion`；设计 §15.5 的「页面切换 120ms 淡入」「覆盖层 160ms 滑入」只在这 4 个弹层上做了。
- **焦点环**：20 个文件有 `:focus-visible`；6 个文件只有 `outline: none` 没有 `:focus-visible`，都是 `tabIndex={-1}` 的容器根（程序化聚焦用），不是缺陷，但没有检查能区分这两种情况。
- **角色**：日志是 `grid`/`row`/`gridcell` + `aria-selected`；分支树是 `tree`/`treeitem`，每个叶子行一个 Tab 停靠点（TODO P2）；菜单 `menu`/`menuitem`，↑↓ 跳过不可用项。
- **测试环境**：没有 DOM（TD-18），交互只有纯函数与 `renderToStaticMarkup` 测试。

## 范围

**包含：**

- **样式变量全量校正**：23 个文件里的 4 个错误变量按 `MISSING_TOKENS` 映射替换；守卫从「拒绝 4 个已知错误名」改为「只允许 DSH 中确实定义的名字」（允许清单 = 从 DSH ui-theme 源码提取的快照，带 DSH 版本与日期），扫描全部 `*.module.css`；同时守住「无字面颜色」「有动画就有 reduced-motion」。修正 references 的 Token 表。
- **DOM 测试环境**（TD-18，见待确认 1）：引入一个 DOM 实现，只给需要的测试文件按文件开启；补焦点返回、Esc 退一级、菜单/树/日志的方向键导航测试。
- **键盘与焦点**：分支树改为单一 Tab 停靠点（roving tabindex）；菜单不可用项的方向键行为按待确认 2；全工作台焦点环审计与补齐；焦点环检查（交互元素的 `outline: none` 必须同文件有 `:focus-visible` 替代）。
- **可访问名称**：合并窗口底栏与头部按钮 label-in-name（WCAG 2.5.3，TODO P2）；全局审计「可见文字 ≠ 可访问名称」的按钮并统一改为 `aria-label` 不覆盖可见文字、说明放 `title`/`aria-describedby`；干净文件状态位「·」的提示从 M0 的「Git 状态待接入」改为「没有未提交的改动」（B2 L4）。
- **对比度**：在 DSH 亮/暗两套主题下实测提交图 lane 线（≥3:1）、正文（≥4.5:1）、次要文字/状态字母/分支标签（≥3:1）；不达标的调混色比例或换 token（含 B3a L4「变基列表分支名标签对比弱」）。
- **动效**（见待确认 3）：按设计 §15.5 给页面切换补 120ms 淡入、其余覆盖层补 160ms 滑入，统一尊重 `prefers-reduced-motion`。
- 文案中英双语；新增/修改的键在 `en` 中 `satisfies` 一致。

**不包含：**

- 迁移到 ui-primitives `MenuSurface`/`Menu`（TODO P2，ADR 0006）：改动面大且会改变菜单材质与行为，单独排期；本计划只修现有手写菜单的键盘行为。
- 读屏软件（VoiceOver/NVDA）全流程实测：本计划用可访问性树检查（浏览器 `read_page`）+ DOM 测试代替，读屏实测列为可选的负责人验收项。
- 引入 axe-core 等自动化审计库（另一个新依赖，见待确认 1 备选）。
- 性能（B4c）、跨平台与 git 路径（B4d）。

## 待负责人确认

1. **DOM 测试依赖**：推荐只加 `happy-dom`（devDependency），测试文件用 `// @vitest-environment happy-dom` 按文件开启，渲染用 `react-dom/client` + React 18 的 `act`，不引入 `@testing-library/*`（自写 30 行左右的 `render`/`press`/`click` 辅助放 `test/client/dom.tsx`）。理由：体积小、启动快、vitest 原生支持，全量 `make check` 时长影响最小。备选 A：`jsdom`（更完整但慢 2–3 倍）。备选 B：再加 `@testing-library/react`+`user-event`（写法更顺，多两个依赖）。备选 C：不加依赖，维持 TD-18 现状（本计划的交互验收全部退回 L4 走查）。
2. **菜单方向键与不可用项**：推荐按 WAI-ARIA APG：不可用项**可聚焦**、带 `aria-disabled="true"`，原因通过 `aria-describedby` 读出（现在原因只在 `title` 里，读屏听不到）；Enter/点击无效。备选：保持跳过不可用项（现状），原因不可被读屏访问。
3. **动效范围**：推荐做——页面切换（Log/Commit/Branches/Stash 等主页面互切）120ms 淡入、所有覆盖层（Blame、历史、比较、变基、合并……）160ms 滑入，统一放进一个共享样式 `ui/motion.module.css`，`prefers-reduced-motion: reduce` 时全部为 0。备选：不做，只保留现有 4 个弹层动画（设计 §15.5 这条就留作已知差距）。
4. **允许清单的来源**：推荐把 DSH ui-theme 定义的全部 `--dsw-*` 名字作为快照写进 `test/client/dsh-tokens.ts`（附 DSH 版本、提取命令与日期），测试只读快照，不在测试时读 DSH 仓库（DSH 在 CI 里不存在）；DSH 升级时按 TD-2 的流程重新提取。备选：只允许本仓库当前已用的 34 个名字（更严，但每次用新 token 都要改清单）。

## 验收标准

- [ ] AC1：客户端所有 `*.module.css` 中的 `var(--dsw-*)`（无 fallback 时）都在 DSH 快照清单内；4 个错误变量 0 处；无字面颜色；凡有 `animation`/`transition` 的文件都有 `prefers-reduced-motion` 规则（`css-tokens.test.ts` 扩展后全量扫描）。L4：在 DSH 亮/暗主题下，状态栏、控制台、推送被拒页、状态字母的成功/警告色与等宽字体实际生效（`getComputedStyle` 读到非空值 + 截图）。
- [ ] AC2：凡有 `outline: none`/`outline: 0` 的选择器，要么是 `tabIndex={-1}` 的容器根（显式登记在检查的例外表里），要么同文件有对应的 `:focus-visible` 规则（静态检查）；L4 只用键盘走完「日志选提交 → 看 diff → 提交页勾选文件 → 提交 → 分支页签出 → 贮藏页恢复 → 合并窗口应用更改」，每一步焦点可见（截图）。
- [ ] AC3：分支树只有一个 Tab 停靠点（选中行，无选中时首行为 `tabIndex=0`，其余 `-1`）；↑↓ 移动、→ 展开/进入子项、← 折叠/回到父项、Home/End 到首尾；外部刷新后停靠点仍在原分支或回到首行（DOM 测试）。
- [ ] AC4：菜单方向键行为符合待确认 2 的选择；不可用项的原因能从可访问性树读到（DOM 测试 + `read_page`）。
- [ ] AC5：覆盖层与弹层：打开时焦点进入、`Esc` 退一级、关闭后焦点回到触发元素——至少覆盖仓库栏 ⋯ 设置弹层、提交右键菜单、Blame 覆盖层、合并窗口、回滚弹层（DOM 测试）。
- [ ] AC6：合并窗口底栏与头部按钮的可访问名称包含可见文字；全局再无「`aria-label`/`title` 作为名称且不含可见文字」的按钮（DOM 测试按可见文字 `getByRole` 能找到；审计清单写进「验证记录」）；干净文件状态位提示为「没有未提交的改动 / No uncommitted changes」。
- [ ] AC7：亮/暗两套主题下：lane 线、选中行描边对 `bg-base` ≥3:1；正文 ≥4.5:1；次要文字、状态字母、分支/标签徽标、变基列表分支标签 ≥3:1（L4 脚本在浏览器里读计算后颜色并算对比度，结果表写进「验证记录」）。
- [ ] AC8（如待确认 3 选做）：页面切换 120ms 淡入、覆盖层 160ms 滑入；系统开启「减少动态效果」时无动画（T1 静态检查 + 在浏览器里用 `matchMedia` 模拟后读 `animation-name` 为 `none`）。
- [ ] AC9：L4 截图 `.evidence/b4b/`；`make check` 绿且全量时长增幅 ≤15%（记录前后时长）；中英文案键集一致；TD-18 移入「已处理」（如待确认 1 选 C 则保留并注明）。

## 契约（T1/T2 冻结）

```ts
// test/client/dsh-tokens.ts —— DSH ui-theme 定义的变量名快照
export const DSH_TOKENS_SOURCE: { dshVersion: string; extractedAt: string; command: string }
export const DSH_TOKENS: ReadonlySet<string>          // 例如 '--dsw-alias-bg-base'

// test/client/pages/css-tokens.test.ts —— 扩展为全量扫描
//   - 每个无 fallback 的 var(--dsw-*) ∈ DSH_TOKENS
//   - 无 #hex / rgb() / hsl() 字面颜色
//   - 有 animation|transition ⇒ 同文件有 @media (prefers-reduced-motion: reduce)
//   - outline:none 的选择器 ⇒ 同文件有 :focus-visible，或在 FOCUS_EXEMPT（容器根）中
export const FOCUS_EXEMPT: ReadonlyArray<{ file: string; selector: string; reason: string }>

// test/client/dom.tsx —— DOM 测试辅助（待确认 1 选推荐方案时）
export function render(ui: ReactElement): { container: HTMLElement; unmount(): void; rerender(ui: ReactElement): void }
export function press(target: Element, key: string, init?: KeyboardEventInit): void   // 包在 act() 里派发 keydown
export function click(target: Element): void
export function byRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement   // 名称按 aria-labelledby > aria-label > 文字内容计算
```

```ts
// src/client/pages/tree-focus.ts —— 分支树 roving tabindex 的纯模型（T4）
export interface TreeRow { id: string; parentId: string | null; expandable: boolean; expanded: boolean }
export function tabStop(rows: readonly TreeRow[], selectedId: string | null, previousStop: string | null): string | null
export function moveFocus(rows: readonly TreeRow[], currentId: string, key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'):
  { focus: string } | { toggle: string } | null
```

## 任务

<!-- 状态：待开始 / 进行中 / 完成 / 阻塞 -->

### T1：样式变量全量校正与静态守卫（待开始）

- **目标**：A1–A3 的状态色/等宽字体生效；任何不存在的 DSH 变量、字面颜色、缺 reduced-motion 的动画都会让 `make check` 失败。
- **涉及文件**：`test/client/dsh-tokens.ts`（新）、`test/client/pages/css-tokens.test.ts`、上文 23 个 `*.module.css`、`docs/references/dsh-integration-feasibility.md`（Token 表第 283–290 行附近，补全 4 个正确名字与快照来源）。
- **要点**：快照用 `grep -hoE '^\s*--dsw-[a-z0-9-]+' packages/client/ui-theme/src/styles/*.css`（在 DSH 仓库只读执行）生成；`--dsw-font-markdown-code-block`（简写 `font:`）与 `-font-family` 都在快照里。替换时 `--dsw-font-mono` → `--dsw-font-markdown-code-block-font-family`，保留原有 `monospace` 回退。删除旧的 `GUARDED`/`MISSING_TOKENS`，但把映射表搬进测试的失败信息（报错时提示正确名字）。
- **测试**：先把守卫改为全量扫描并运行，确认列出 23 个文件的违例（失败）；替换后通过。另写一条反例单测：喂一段含 `var(--dsw-nope)`、`#fff`、无 reduced-motion 的 `animation` 的 CSS 字符串，三条规则各报一次。
- **完成标准**：`make check` 绿；L4 在两套主题下截图状态栏、控制台、推送被拒页。
- **验证命令**：`pnpm vitest run test/client/pages/css-tokens.test.ts`、`make check`

### T2：DOM 测试环境（TD-18）（待开始）

- **目标**：按待确认 1 引入 DOM 实现与 `test/client/dom.tsx` 辅助；用它为两个现有交互补第一批测试，证明环境可用。
- **涉及文件**：`package.json`/`pnpm-lock.yaml`、`vitest.config.*`（如需）、`test/client/dom.tsx`（新）、`test/client/pages/repo-bar-menu.dom.test.tsx`（新）、`docs/references/` 新增一节记录 happy-dom 已验证行为（焦点、`KeyboardEvent`、`ResizeObserver` 是否可用、`@tanstack/react-virtual` 在零尺寸下的表现）。
- **要点**：只对 `*.dom.test.tsx` 开 DOM 环境，其余测试仍跑 node 环境；DSH slot 注入的 `t` 用 `test/client/i18n-helpers.tsx` 现有辅助。虚拟列表在 DOM 环境下没有布局尺寸——需要时 mock 容器尺寸，结论写进 references。
- **测试**：先写「仓库栏 ⋯ → 设置… → Esc 关闭后焦点回到 ⋯」与「日志 ↑↓ 改变 `aria-selected`」两条，确认在环境缺失时失败、引入后通过。
- **完成标准**：两条 DOM 测试通过；`make check` 全量时长记录（基线 vs 现在）写进「验证记录」。
- **验证命令**：`pnpm vitest run test/client/pages/repo-bar-menu.dom.test.tsx`、`make check`

### T3：焦点环审计与焦点检查（待开始）

- **目标**：每个可交互控件键盘聚焦时可见焦点环，风格统一。
- **涉及文件**：`test/client/pages/css-tokens.test.ts`（`FOCUS_EXEMPT` 与规则）、缺 `:focus-visible` 的交互样式文件（审计后列出）、可能新增 `src/client/ui/focus.module.css`（共享 `.focusRing`：`outline: 2px solid var(--dsw-alias-link)` 或审计时找到的 DSH 焦点 token，`outline-offset: -2px` 用于行）。
- **要点**：先在 DSH 主题里找有没有焦点环 token（T3 开始时查 `design-platform.css` 与 ui-primitives `Button` 的实现），有就用，结论写进 references；容器根（`tabIndex={-1}`）登记到 `FOCUS_EXEMPT` 并写理由。
- **测试**：先写焦点检查规则（失败：列出缺失项），补样式后通过；DOM 测试抽查日志行、分支行、提交页文件勾选框聚焦后匹配 `:focus-visible` 选择器（happy-dom 不支持时降为断言 class/属性，并记入 references）。
- **完成标准**：静态检查绿；L4 键盘走查截图（AC2 的流程）。
- **验证命令**：`make check`

### T4：分支树 roving tabindex（待开始）

- **目标**：分支树单一 Tab 停靠点与完整方向键导航（AC3）。
- **涉及文件**：`src/client/pages/tree-focus.ts`（新，纯模型）、`src/client/pages/BranchPanel.tsx`、`test/client/pages/tree-focus.test.ts`（新）、`test/client/pages/branch-tree.dom.test.tsx`（新）。
- **要点**：`tabStop` 优先选中行 → 上一次停靠点（仍存在时）→ 首行；折叠的目录下的行不可见、不参与移动；→ 在已展开目录上移到首个子项，← 在叶子上回到父目录；目录行 Enter/空格切换展开（保持现有行为）；双击签出、右键菜单、`Delete` 不变。焦点移动用 `ref.focus()`，不用 `aria-activedescendant`（与日志表保持一致：查看现有日志表实现后确认，选择写进决策记录）。
- **测试**：纯模型表驱动（空树、单行、全折叠、选中行被删除、刷新后行重排）；DOM 测试 Tab 只停一次、↓↓→← 的焦点路径。
- **完成标准**：AC3 测试通过；TODO 中对应条目移到「已完成」（本计划收尾时一起移）。
- **验证命令**：`pnpm vitest run test/client/pages/tree-focus.test.ts test/client/pages/branch-tree.dom.test.tsx`、`make check`

### T5：菜单键盘与不可用项原因（待开始）

- **目标**：AC4；手写菜单（`ActionMenu`、分支右键菜单、`useFloatingMenu` 使用方、合并窗口「应用非冲突更改 ▾」）行为一致。
- **涉及文件**：`src/client/pages/ActionMenu.tsx`、`src/client/pages/menu-position.ts`（`useFloatingMenu`）、`src/client/pages/BranchPanel.tsx`、合并窗口菜单所在文件、`test/client/pages/action-menu.dom.test.tsx`（新）。
- **要点**：按待确认 2；原因文字放进菜单项内一个视觉隐藏的元素并用 `aria-describedby` 引用（`title` 保留给鼠标）；顺手修 TODO「应用非冲突更改 ▾ 点外部不关闭」（复用 `useFloatingMenu` 的外部点击处理）。
- **测试**：DOM：↓ 依次经过项（含/不含不可用项按选择）、Home/End、Esc 关闭并还焦、外部点击关闭；不可用项 Enter 不触发回调。
- **完成标准**：AC4 测试通过。
- **验证命令**：`make check`

### T6：覆盖层焦点管理（待开始）

- **目标**：AC5——覆盖层与弹层的进入焦点、Esc、还焦统一并有测试。
- **涉及文件**：各覆盖层组件（设置弹层、提交右键菜单、Blame 覆盖层、合并窗口、回滚弹层、`DirtyWorktreeSheet`、`BranchSheets`）；若现有实现分散，抽 `src/client/pages/use-overlay-focus.ts`（`useOverlayFocus(ref, { initialFocus?, returnFocus: Element | null, onEscape })`）；对应 `*.dom.test.tsx`。
- **要点**：只统一行为，不改视觉；对话框类加焦点圈定（Tab 不逃出 `role="dialog"`），非模态覆盖层（Blame、历史）不圈定，只保证 Esc 与还焦。
- **测试**：每个覆盖层一条 DOM 测试：打开 → `document.activeElement` 在覆盖层内 → Esc → 焦点回触发元素；对话框 Tab 循环。
- **完成标准**：AC5 测试通过。
- **验证命令**：`make check`

### T7：可访问名称（label-in-name）与文案（待开始）

- **目标**：AC6。
- **涉及文件**：合并窗口头部/底栏组件、审计出的其他按钮、`src/client/locales/*.ts`（干净文件状态位提示）、`test/client/pages/accessible-names.dom.test.tsx`（新）。
- **要点**：审计方法——DOM 渲染主要页面，遍历 `button, [role=menuitem], [role=tab]`，比较计算出的可访问名称与可见文字，不含可见文字的列出来；结果清单写进「验证记录」。修复方式：可见文字作名称，补充说明移到 `title`（或 `aria-describedby`）；纯图标按钮保持 `aria-label`。
- **测试**：上述遍历本身作为测试（对主要页面断言违例列表为空）。
- **完成标准**：违例清单为空；中英键集一致。
- **验证命令**：`make check`

### T8：对比度实测与修正（待开始）

- **目标**：AC7。
- **涉及文件**：`graph/graph.module.css`（混色比例）、状态字母/徽标/变基列表分支标签样式；`docs/runbooks/verification.md`（新增「对比度测量」一节：浏览器里运行的测量脚本放 `scripts/contrast-probe.js`，不进产物）。
- **要点**：脚本对选定元素取 `getComputedStyle` 的 `color`/`stroke` 与有效背景，换算 sRGB 相对亮度算 WCAG 比值；在 DSH 亮/暗主题各跑一次。不达标时先调 `color-mix` 比例，仍不够再换 token，不写字面颜色、不写主题选择器（设计 §15.3）。
- **测试**：对比度换算函数放在 `scripts/contrast-probe.js` 里并导出，配一条单测 `test/scripts/contrast-probe.test.ts` 验证已知值（黑/白 = 21、`#777`/白 ≈ 4.48）；不进产物。
- **完成标准**：两套主题结果表写进「验证记录」，全部达标或逐条说明例外并经负责人确认。
- **验证命令**：`make check`；L4 按 runbook 运行测量脚本

### T9：动效（按待确认 3）（待开始）

- **目标**：AC8。
- **涉及文件**：`src/client/ui/motion.module.css`（新）、主页面容器与覆盖层容器；现有 4 个弹层的 `@keyframes` 收拢到共享样式。
- **要点**：页面切换只在主页面 key 变化时淡入（不在每次数据刷新时触发）；覆盖层滑入方向与现有弹层一致。
- **测试**：T1 的 reduced-motion 静态规则覆盖；DOM 测试断言页面切换后容器带动效 class。
- **完成标准**：L4 截图/录屏片段；reduced-motion 下无动画。
- **验证命令**：`make check`

### T10：自验证、整分支评审与收尾文档（待开始）

- **目标**：逐条 AC 附证据；整分支评审修复；文档同步。
- **涉及文件**：本计划「验证记录」、`docs/quality/QUALITY.md`（客户端各模块 a11y 评级）、`docs/quality/tech-debt.md`（TD-18 → 已处理）、`docs/runbooks/verification.md`（DOM 测试与对比度测量）、`docs/ARCHITECTURE.md`（如新增 `ui/motion`、`tree-focus`、`use-overlay-focus`）、`docs/plans/TODO.md`。
- **完成标准**：AC1–AC9 全部有证据；`make check` 绿；等待负责人验收。
- **验证命令**：`make check`、`pnpm build && pnpm smoke`

## 进度

<!-- 每完成一步追加一行：日期 — 任务 — 结果（commit 短哈希） -->

- 2026-10-28 — 基线 `make check` 绿：124 文件 / 2162 测试，耗时 480.6s（AC9 时长增幅以此为基准）
- 2026-10-28 — T1 完成：4 个错误变量全量替换，样式检查改为按 DSH 快照（403 个名字）扫描全部 CSS Modules（3f12ad4）
- 2026-10-28 — T2 完成：happy-dom + `test/client/dom.tsx`；日志 ↑↓、仓库栏 ⋯ Esc 还焦两条 DOM 测试；修复 ⋯ 菜单 Esc 后焦点丢失（ee66462）
- 2026-10-28 — T3 完成：`outline: none` 一律须登记 `FOCUS_EXEMPT`（17 条：11 个 tabIndex=-1 容器根、6 个有替代指示的输入/列表）；11 处菜单项/行/拖拽条改用 DSH 全局焦点环（内缩 `--dsw-focus-ring-width`）（2add967）
- 2026-10-28 — T4 完成：`tree-focus.ts` 纯模型 + `use-tree-roving.ts`；分支面板与分支页的树都是单一 Tab 停靠点，分组头改为 level-1 treeitem 参与导航；删除不再使用的 `moveTreeFocus`/`treeStepIndex`（09e54ef）
- 2026-10-28 — T5 完成：`useMenuKeyboard` 从 `useFloatingMenu` 抽出，仓库栏 ⋯、提交 ▾、合并窗口「应用非冲突更改 ▾」、文件右键菜单、Changelist「移到」都接入（取得焦点、↑↓ 环绕、Home/End、Esc/Tab/← 关闭并还焦、外部点击关闭）；不可用项可聚焦，`MenuItemButton` 用 `aria-labelledby`/`aria-describedby` 分开名称与原因（5646681）
- 2026-10-28 — T6 完成：`focus-trap.ts` 的 `trapTab` 接到全部 `aria-modal` 对话框（SheetFrame 及其 8 个使用方、回滚、未提交改动、智能签出、分支表单、分支抽屉）；DOM 测试覆盖设置弹层/未提交改动询问的进入焦点 + Esc + Tab 圈定、覆盖层控制器还焦、提交右键菜单 Esc 还焦（df8b24b）
- 2026-10-28 — T7 完成：`nameViolations` 审计（2.5.3 label-in-name + 4.1.2 无名控件）覆盖仓库栏、分支面板、分支页、状态栏、设置弹层、合并窗口头部/底栏、操作菜单、日志页（中英各一遍），全部合规；干净文件状态点提示改为状态原因（「文件没有未提交的改动」/「不在仓库中」）（9b23c9e）
- 2026-10-28 — T8 完成：L4 实测两套主题对比度；成功/警告色和静态色作文字时往 `label-primary` 混 60%（浅色 2.2 → 5.3+），样式检查新增「状态/静态色不得直接作文字色」；`scripts/contrast-probe.mjs` + 单测 + runbook「对比度测量」

## 下一步

- 从 T1 开始：先把 `test/client/pages/css-tokens.test.ts` 改为全量扫描并确认失败。

## 决策记录

<!-- 执行中自行做出的决定：日期 — 决定 — 理由。影响范围超出本计划的，另写 ADR 并在这里链接。 -->

- 2026-10-28 T1 — L4 两套主题截图挪到 T10 统一走查 — 一次构建安装覆盖全部 AC。
- 2026-10-28 T3 — 不新建 `ui/focus.module.css`：DSH ui-theme `focus.css` 已给全局 `:focus-visible` 设颜色与 `--dsw-focus-ring-width`，并在指针输入时隐藏；插件只需不再 `outline: none`，行/菜单项用负 `outline-offset` 画在内侧防止被滚动容器裁掉。焦点检查改为「`outline: none` 必须登记例外」，比「同文件有 :focus-visible」更严也更好判定。
- 2026-10-28 T3 — 不做 happy-dom 里的 `:focus-visible` 匹配测试：测试环境不加载 CSS Modules 的样式，匹配结果说明不了渲染；由静态规则 + T10 L4 键盘走查覆盖。
- 2026-10-28 T4 — 停靠点优先级改为「最近获得焦点的行 → 选中行 → 首行」（契约原写选中行优先）：选中行优先时，方向键移走焦点后一次重渲染就把停靠点拉回选中行，Tab 出去再回来会落在别处。
- 2026-10-28 T4 — 分组头（HEAD/Local/Remote/Tags）从独立按钮改为 `role="treeitem" aria-level=1` 的按钮，参与漫游；叶子行 → 仍打开菜单（A3 I-1 的既定行为，APG 对叶子 → 未定义行为，不冲突）。改动同时作用于分支面板与分支页（两者共用分组模型）；提交页文件树（ChangesTree）早已是漫游实现，不动。
- 2026-10-28 T4 — 改为焦点移动用 `element.focus()`，展开/折叠用 `element.click()` 复用行自身的切换逻辑，不用 `aria-activedescendant`（与 ChangesTree 一致）。
- 2026-10-28 T5 — Home/End 改为到第一/最后一项（含不可用项，APG）；打开菜单时仍聚焦第一个可用项（沿用 I-1，便于直接回车）。原生 `disabled`（无原因、如「刷新中」）仍不可聚焦、导航跳过；有原因的不可用项一律 `aria-disabled`。
- 2026-10-28 T5 — `useMenuKeyboard` 的 `onClose(via)` 区分键盘关闭（还焦到触发按钮/行）与外部点击（不抢焦点）；`boundary` 参数让开关按钮所在的包裹元素不算「外部」，避免按下即关、点击又开。顺手修掉 TODO「应用非冲突更改 ▾ 点外部不关闭」。
- 2026-10-28 T6 — 不新建 `use-overlay-focus.ts`：进入焦点（`useInitialFocus`/各自的 `focus()`）、Esc（`escapeHandler`/各自 handler + 工作台兜底 `handleOverlayEscape`）、还焦（`createOverlayController` + `rememberFocus`）已经统一且行为正确，DOM 测试直接作为回归保护；唯一缺的是模态对话框的 Tab 圈定，补成 `trapTab`。Blame、历史、比较等非模态覆盖层不圈定。合并窗口的焦点行为已有 `merge-window-controller` 单测（`focusIsLost`/`shouldRefocusAfterWrite`），不另写 DOM 测试。
- 2026-10-28 T7 — TODO「合并窗口按钮 label-in-name」核实为误报：这些按钮没有 `aria-label`，名称取可见文字，`title` 只作描述（可访问性树里显示为 description）；审计测试把它锁住。源码粗扫所有「带 `aria-label` 的按钮」，有文字子节点的只有纯符号（▸ ✕ ▾ ⋯），不需要匹配。
- 2026-10-28 T8 — 文字用的成功/警告/静态色统一混 60% `label-primary`（与设计 §15.3 lane 的混色思路一致，不写主题选择器、不写字面色）：浅色下成功 5.6、警告 5.35，暗色下 ≥8。只改作文字色的 `color:`，边框/背景/标记不动（非文本装饰）。
- 2026-10-28 T8 — 走查构建在 scratchpad 的 detached worktree 里做、隔离 HOME、端口 3082：负责人的 web profile 链接到主 checkout 的 `lib/`，在主 checkout `pnpm build` 会把分支代码热更进负责人正在用的 3080；3081 被另一个会话的 DSH 占着。

## 意外与发现

<!-- 和预期不一致的事、SDK 的新发现（同时写进 references/）、临时绕过的问题（同时登记到 tech-debt）。 -->

- 2026-10-28 T1：BSD grep/sed 不认 `\s`，首版快照漏掉 `--dsw-radius-xs` 等名字；提取命令改用 `[[:space:]]`。日志骨架屏动画用的是 `@media (prefers-reduced-motion: no-preference)` 包裹写法，检查同时接受两种写法。
- 2026-10-28 T2：`pnpm add -D happy-dom` 在 pnpm 11 下摘掉了 DSH link 依赖，恢复办法写进 [references/happy-dom.md](../../references/happy-dom.md) 与 dev-setup runbook。happy-dom 无布局，虚拟列表需 `stubLayout`。
- 2026-10-28 T8：T1 的变量校正让 A1–A3 的成功/警告色第一次真正生效，随之暴露浅色主题下对比度只有 2.2:1（胶囊、状态字母、状态栏等 22 处；B1 之后本来就用对了名字的文件也一样）。不做 T1 就看不到这个问题。
- 2026-10-28 T2：第一条 DOM 测试就抓到真实缺陷——仓库栏 ⋯ 菜单按 Esc 关闭后焦点落到 `body`（A1 起的行为），已修。

## 阻塞

<!-- 触发 SOP §6 升级条件时填写：问题、已尝试的办法、可选方案和推荐。解决后保留记录，并注明怎么解决的。 -->

- 无

## 验证记录

<!-- 自验证阶段填写：每条验收标准对应的命令、输出摘要、截图路径。 -->

### AC7 对比度（2026-10-28，隔离 DSH 3082，`scripts/contrast-probe.mjs`，修正后）

| 对象 | 阈值 | 浅色 | 暗色 |
|---|---|---|---|
| 提交图 lane 1–6 | 3 | 6.64 / 4.63 / 4.40 / 7.65 / 7.29 / 6.76 | 7.84 / 10.44 / 10.88 / 6.91 / 7.17 / 11.01 |
| 日志主题（正文） | 4.5 | 18.9 | 17.45 |
| 日志作者 / 日期·哈希 | 3 | 5.8 / 3.71 | 12.11 / 8.54 |
| 胶囊 HEAD / 本地分支 / 标签 | 3 | 8.45 / 5.6 / 5.35（修正前本地 2.28、标签 2.15） | 6.97 / 9.64 / 9.93 |
| 仓库路径 / 状态栏 | 3 | 3.71 / 5.8 | 8.54 / 12.11 |
| 状态字母 M / ? | 3 | 5.35 / 3.71 | 11.53 / 8.54 |
| 提交页文件名 / 分组头 / 提交信息框 | 4.5 / 3 / 4.5 | 18.9 / 18.9 / 18.9 | 17.45 / 17.45 / 15.03 |
| 分支页分支行 / 当前分支 / 分组头 / 快捷动作 / 计数 | 4.5 / 4.5 / 3 / 4.5 / 3 | 18.9 / 18.9 / 5.8 / 18.9 / 3.71 | 17.45 / 17.45 / 12.11 / 17.45 / 8.54 |
| 变基列表分支标签（含选中行）/ 主题 | 3 / 4.5 | 5.8 / 15.7 | 10.42 / 11.54 |

