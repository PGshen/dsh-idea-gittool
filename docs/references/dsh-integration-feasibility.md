# DSH Web GUI 集成可行性调研（Git 工作台）

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.0（技术调研，结论可用于排期） |
| 日期 | 2026-10-25 |
| 调研对象 | DeepSeek Harness `0.2.1-rc.2`（源码 `/Users/peng/Me/Ai/deepseek-harness`） |
| 运行形态 | 源码启动的 `dsh web`（`http://127.0.0.1:3080`），profile `~/.dsh/profiles/web` |
| 结论适用 | 右侧栏 Git tab（日志 / 提交 / 分支 / 贮藏）的 Host + Client 插件 |
| 配套文档 | [产品设计 v0.2](../design/2026-10-25-产品设计-v0.2.md)（决策见 [设计决策 v0.2](../design/2026-10-25-产品设计决策-v0.2.md)） |

> 本文所有 `文件:行号` 均指 DSH 源码（`/Users/peng/Me/Ai/deepseek-harness`）或该仓库 `docs/` 下的文件；profile 配置指 `~/.dsh/profiles/web/`。行号对应版本 `0.2.1-rc.2`。
>
> **状态**：✅ 已按 DSH `0.2.1-rc.2` 源码核实（2026-10-25）；M0 spike 已实测挂载、产物契约、RPC、沙箱门禁与文档 slot（结论见 §13）；⚠️ HMR 与终端改动刷新尚未手动走查。

---

## 0. 结论（先看这一节）

### 0.1 一句话结论

**可行，且不需要改 DSH 仓库。** 推荐做成一个**独立的双面 bundle 包**（同一个 `package.json` 同时声明 Host 入口、`./client` 浏览器产物和 `dsh.bundle.patch`），用 **`ctx.connection.rpc.handle('/dsh-git', ...)` 通用 RPC** 做浏览器 ↔ Host 通信，Host 用 **`ctx.subprocess` + `ctx.sandbox.confine`** 执行 git（不是 `ctx.shell`，也不是 `child_process.execFile`），cwd 由 Host 从 `sessionId` 解析，变更监听复用 **`workspaceFiles.changes`** Remote 流。唯一必须自建的是 **`__ModuleLoader__` 产物构建**（官方 tsdown preset 无法脱离 DSH 仓库使用）。

### 0.2 两个总体方案与取舍

| | **方案 A（推荐）：独立 bundle 包，源码在本仓库** | **方案 B：作为 DSH 仓库内 `packages/client/ui-sidebar-git` 开发** |
|---|---|---|
| 位置 | `/Users/peng/Me/Ai/vibe-inspiration/dsh-idea-gittool/packages/plugin` | `/Users/peng/Me/Ai/deepseek-harness/packages/client/ui-sidebar-git` |
| 构建 | 自写 `build.mjs`（esbuild + 3 行 banner/intro/footer，复刻产物契约） | 官方 `clientBundle()` preset（`packages/client/tsdown.client.ts:115`） |
| 产物格式 | 手工复刻 `window.__ModuleLoader__.load({id, factory})`（`tsdown.client.ts:663-670`） | preset 自动生成，另含 CSS Modules 哈希/注入、sourcemap 回源、纯净度门禁 |
| 安装 | `dsh plugin --profile web add <path>`（bundle patch 插入 1 行） | 需改 `packages/bundle/web-app/cordis.patch.yml` 与 `package.json`，属"内置插件"，不能作为独立包分发 |
| 客户端热更 | ✅ 可以：`dsh-client-hmr` 轮询每个图行的 `lib/client.js`（`packages/client/hmr/src/index.ts:3,108`；`README.md:32,62`），重写文件即热换 | ✅ 同样可以（`pnpm run dev:web`） |
| Host 侧改代码 | ❌ 需重启 `dsh web` | ❌ 同样需重启 |
| 样式 | esbuild 无 CSS Modules 管线，需自建或退化为前缀类名 | CSS Modules + lightningcss + 哈希，完全合规 |
| 分发 | ✅ npm / tarball / git 均可 | ❌ 只能随 DSH 版本发布 |
| 结论 | **产品化与分发选 A**；A 的样式短板可在 1 天内用两遍 local-css 构建补齐（见 §5.4） | **B 只作为"对照官方产物 / 排查兼容性"的临时手段**；不建议作为主开发形态 |

**折中方案（若必须用官方 preset 构建）**：源码仍是本仓库的唯一真源，在 DSH 仓库内只放一个**开发壳包**（`packages/client/ui-sidebar-git`），其 `src/` 通过**复制脚本**从本仓库同步（不要用 symlink，见 §5.5 的原因）；壳包只用于 `pnpm --filter ... bundle` 产出可比对的 `lib/client.js`，产物再拷回本仓库发布。**不要**把壳包当成真源。

### 0.3 关键结论速查

| 问题 | 结论 |
|---|---|
| 右侧栏能做 tab 吗 | 能，公开两段式注册：`ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab` slot；引导页入口、去重、标题、菜单都是公开 API |
| 宽度/全屏 | 默认 45% 视口、最小 300px、最大 70% 视口；视口 < 768px 自动全屏；产品限制最多两个 dock pane，300px 时不可再分栏 |
| 命令/快捷键 | `ctx.shortcuts.register`，同一 `commandId` 同时驱动引导页胶囊上的按键提示 |
| 主题 | 必须只用 `--dsw-*`；diff 有现成 token；Git lane 只有 6 个静态色系，需用 `color-mix` 与 `label-primary` 混色以自适应深浅色 |
| 能否独立开发 | 能（Host + Client 同一个包），但官方 tsdown preset **不能**脱离 DSH 仓库；需自写产物包装 |
| 通信 | 通用 RPC 够用且解耦；Typert Remote 的代码生成器硬编码 DSH 仓库布局（`findWorkspaceRoot` 要求 `tsconfig.host.json` + `packages/`），外部包不可用 |
| Host 拿 cwd | 从 `sessionId` 解析，不要信客户端传的 cwd；live 会话走 `sessions.get(id).header.cwd` / `workingDirectory.get(session)`，休眠会话走 `sessionPersistence.stat(id).header.cwd`，兜底 `sandboxPolicy.workspaceRoot` |
| 执行 git | `ctx.subprocess.spawn(argv)` + `ctx.sandbox.confine`（写操作必须）；`ctx.shell` 只接受 shell 字符串，注入风险，不选 |
| 变更监听 | `ctx.fs.watch` 只监听目录直接子项（depth 0）；客户端复用 `workspaceFiles.changes` Remote 流（自带重连）+ 防抖 + 可见时刷新 |
| 可复用 UI | `DiffBlock` / `ReadBlock` / `CodeBlock` / `useCodeHighlighter` / `FileTypeIcon` / `IconBranchOutline*` / 菜单、按钮等都在 `ui-primitives`（模块表基线，外部插件可 `require`）；提交图、Git 专属面板需自建 |

---

## 1. 右侧栏扩展机制

### 1.1 原理：一个 tab 类型分两段注册

右侧栏的"类型系统"由 `@deepseek-ai/dsh-client-ui-sidebar-right` 拥有，规则写在 `packages/client/ui-sidebar-right/README.md:79-88`：

1. **类型（stage one）**：`ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, multiple?, keepMounted? })`。
   - `id` 是实现身份（建议用包名），也是 body/title 注册用的 key；
   - `kind` 是打开时用的判别值（`openTab('git')`），同一个 kind 最多一个 `builtin` + 一个 `extension`；
   - 页面类型不写 `patterns`，由 kind 打开；资源类型写 `dsh-resource://` 的 glob；
   - `guide` 贡献引导页入口胶囊。
2. **正文（stage two）**：`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)`；标题另注册到 `sidebar.right.pane.tab.title`（同理 keyed）。

两段都必须包在 `ctx.effect(...)` 里，随插件卸载回收。注册服务本身由插件在 `apply` 顶层提供（`packages/client/ui-sidebar-right/src/client/index.ts:150`，`ctx.reflect.provide('sidebarRightTabs', tabs)`）。

tab 类型定义类型：`packages/client/ui-sidebar-right/src/client/tab-registry.ts:69-120`；优先级默认 `extension`（同文件 `:110`，外部插件的默认档，恰好高于内置 `builtin`）。

### 1.2 最小范例：`ui-sidebar-files`

以 `packages/client/ui-sidebar-files` 为骨架（它是最小的"页面型" tab）：

| 关注点 | 文件 | 要点 |
|---|---|---|
| 类型声明 | `src/client/definition.tsx:25-39` | `id` / `kind: 'files'` / `priority: 'builtin'` / `title()` / `guide[]`（含 `commandId`、`order: 10`、图标） |
| 浏览器装配 | `src/client/index.ts:52,58-96` | `inject` 声明服务；`ctx.shortcuts.register`；`ctx.sidebarRightTabs.register`；`ctx.locale.register`；两个 keyed slot（body + title） |
| 快捷命令实现 | `src/client/index.ts:60-80` | `commandTarget()` 取目标（含当前 pane / 活动 tab），无会话时 `blocked`；有则 `openTabFromTarget('files', target)` |
| 文案 | `src/client/locales.ts:14-64` | `LocaleNamespaceMap` 声明 + zh（key 集真源）+ en（`satisfies Record<Key,string>`） |
| 标题 | `src/client/FilesTitle.tsx:17-24` | `useTabInfo()` 读 tab，图标 + 文案 |
| Host 半边 | `src/index.ts:1-4` | 纯 UI 插件也要有 Host 入口，`apply()` 空实现（`main: lib/index.js`） |
| 产物配置 | `tsdown.config.ts:1-3` | `clientBundle(import.meta.dirname, ['lib/types/index.js'])` |
| manifest | `package.json:14-38` | `main` + `exports['./client']` + `dsh.client.{inject,platform}` |

补充：
- 第二个"外部包注册 tab"的活证据是 `ui-sidebar-documentpreview`（`src/client/definition.ts:45-57`，`priority: 'fallback'` + `patterns: ['dsh-resource://file/[\\s\\S]+']` + `canOpen`），它证明内置与外部包走完全相同的公开路径（`ui-sidebar-right/README.md:81`）。
- 需要"一个类型多实例"时声明 `multiple: true`（终端就是这样，`ui-sidebar-terminal/src/client/index.ts:71-73`）；Git 工作台建议 **不声明**，即每个 pane 只保留一个 Git 页，重复打开聚焦已有 tab（页面类型去重语义，`ui-sidebar-right/README.md:93`）。
- 建议 `keepMounted: true`（`tab-registry.ts:106-108` 字段说明；`README.md:106`）：切到别的 tab 或别的会话再回来时保留滚动位置与选中项，v1 可省掉自建 store 的一部分工作。

### 1.3 引导页入口（右侧栏"开始"页卡片）

```ts
// src/client/definition.tsx
export const GIT_KIND = 'git'
export const GIT_ID = 'dsh-plugin-git-workbench'

export function gitDefinition(t: TranslateNS<'gitWorkbench'>): SidebarRightTabDefinition {
  return {
    id: GIT_ID,
    kind: GIT_KIND,
    priority: 'extension',       // 外部插件可不写；显式写出更清楚
    title: () => t('type.label'),
    keepMounted: true,
    guide: [{
      id: 'log',
      commandId: 'git.openLog' as ShortcutCommandId,   // 胶囊右侧显示有效键位
      order: 40,                                        // files=10, terminal=20, browser=30
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: IconBranchOutlineMedium,                    // ui-primitives/src/icons/index.tsx:164
    }],
  }
}
```

`order` 的现存占用：文件 10（`ui-sidebar-files/src/client/definition.tsx:34`）、终端 20（`ui-sidebar-terminal/src/client/index.ts:73`）、浏览器 30（`ui-sidebar-browser/src/client/definition.tsx:23`）。卡片渲染规则见 `ui-sidebar-right/README.md:113-121`。

### 1.4 打开流程与会话语义（必须知道的细节）

- **控制器**：`ctx.sidebarRight.openTab(kind, options?)` / `openResource(address, options?)`（`ui-sidebar-right/src/client/service.ts:180-260`）。打开会**自动展开**侧栏，并记录一条历史。`openTab` 的目标 pane 优先级：`replaceTab` → `paneId` → 当前活动 docked pane。
- **命令入口**：从快捷命令进入时用 `ctx.sidebarRight.commandTarget(element)`（`service.ts:516-520`）+ `openTabFromTarget(kind, target)`（`service.ts:534`）。`target` 捕获了会话、pane、tab 与导航版本；执行前会 `isTargetCurrent` 校验，避免把内容开进已变化的上下文。
- **页面地址**：页面 tab 记录在 `sidebar://<kind>`（`ui-sidebar-right/src/client/contract/seed.ts:45-47`），`title(address)` 收到的就是这个地址；标题在打开时捕获，**要动态标题（分支名）必须注册 `sidebar.right.pane.tab.title`**（`README.md:84,108`）。
- **正文可见性**：`useTabInfo().tab.visible` 只在当前前台会话且侧栏展开时为真（漂浮浮层在折叠时仍可见，`README.md:104`）；后台会话的 body 可能已挂载但 `visible === false`。**轮询/监听应按 `visible` 开关**，不要按组件挂载。
- **生命周期**：`tab.signal` 只在 tab 记录被移除或插件卸载时 abort，切会话/折叠侧栏不会 abort（`contract/slots.ts:161-190`）。异步请求与监听都挂在它上面。
- **面板与会话**：每个会话一份布局（localStorage `dsh.sidebar-right.v1.<sessionId>`，`README.md:74`）；`ctx.sidebarRight.mounted` 是"屏上会话"的快照，`undefined` 表示没有会话（hero 页），此时打开会抛错，命令应 `blocked`。
- **没有会话**：右侧栏不渲染（`README.md:142`）。命令与引导页入口都要处理"无会话"。

### 1.5 最小客户端骨架（可直接改）

```ts
// src/client/index.ts
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { GIT_ID, gitDefinition } from './definition.tsx'
import { GitBody } from './GitBody.tsx'
import { GitTitle } from './GitTitle.tsx'
import { en, zh } from './locales.ts'

const NS = 'gitWorkbench'

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'shortcuts', 'connection']

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'git: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register(gitDefinition(t)), 'git: tab type')

  ctx.effect(() => ctx.shortcuts.register({
    id: 'git.openLog' as ShortcutCommandId,
    label: () => t('command.open'),
    aliases: ['git', 'git log', 'git workbench'],
    defaults: {
      'desktop:macos': { code: 'KeyG', modifiers: ['primary', 'shift'] },
      'desktop:windows': { code: 'KeyG', modifiers: ['primary', 'shift'] },
      'web:macos': { code: 'KeyG', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyG', modifiers: ['primary', 'shift'] },
      // Linux Web 依惯例不绑定默认键（files/terminal/browser 同此约定）
    },
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve: ({ target: element }) => {
      const target = ctx.sidebarRight.commandTarget(element)
      if (target === undefined) return { status: 'blocked', reason: t('noSession') }
      return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget(GIT_KIND, target) } }
    },
  }), 'git: shortcut')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: GIT_ID, locale: NS },
    GitBody,
  )), 'git: body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: GIT_ID, locale: NS },
    GitTitle,
  )), 'git: title')
}
```

Body 的 props 直接用框架派生类型（`PropsRuntime<'sidebar.right.pane.tab'>` 含 `sessionId`、`useTabInfo`、`useSessions`），不要手写。参考 `FilesBody.tsx:25-32,141-147`。

---

## 2. 右侧栏宽度与全屏

### 2.1 硬约束（源码事实）

| 事实 | 值 | 出处 |
|---|---|---|
| 右栏最小宽度 | **300px** | `packages/client/ui-layout/src/client/columns.ts:25` |
| 右栏最大宽度 | **70% 视口** | `columns.ts:27` |
| 首次打开宽度 | **45% 视口** | `columns.ts:29` |
| 中间列保护 | 400px（有右栏轨道时） | `columns.ts:11,52-59` |
| 自动全屏阈值 | **视口 < 768px** | `ui-sidebar-right/src/client/shell/SidebarRight.tsx:360` |
| 全屏实现 | `width: 100vw` + `--dsh-sidebar-width: 100vw` | `SidebarRight.tsx:302-311` |
| 产品 pane 数 | 最多 **2** 个水平 pane，分割比 20%–80% | `ui-sidebar-right/README.md:121`；`stores.ts:291,391,417` |
| 再分栏所需宽度 | 每半 ≥ 固定控件宽 + 一个 100px 最小 chip | `ui-dockkit/src/engine/geometry.ts:104-140` |
| 漂浮面板最小尺寸 | 220×140 | `ui-dockkit/src/engine/constraints.ts:19` |

即：1440px 视口下正常态约 **300–648px**（默认 648px）；1280px 下默认 576px；300px 时两个 pane 都放不下（拆分被 `room` 规则拒绝，`service.ts:602-612,709-711`）。

### 2.2 建议设计宽度

> 产品设计 D4 的"窄屏单列 / 中屏上下分栏 / 宽屏三栏"在数值上是成立的，但**不要依赖 dockkit 分栏**来实现内部布局——那是"面板再切一半"，在 300px 下必然被拒。

| 面板宽度 | 布局 |
|---|---|
| **300–359px** | 单列：仓库栏 + 分段导航 + 列表；点提交/文件**全屏覆盖**（面板内 overlay 或请求全屏）显示详情与 diff |
| **360–519px** | 上下分栏：上图/列表，下详情（可拖动）；diff 用 overlay |
| **≥ 520px** | 三栏/两栏混合：分支面板（可折叠）+ 提交图 + 详情；diff 与详情并排 |
| **全屏** | 提交图 + 详情 + diff 三栏，或三栏合并视图 |

### 2.3 何时切全屏

- **不自动切**：视口 < 768px 时 DSH 自己就是全屏模式（`SidebarRight.tsx:360-367`），此时再调 `toggleFullscreen` 反而会**关闭面板**（`service.ts:618-625`：`autoFullscreen` 为真时执行 `setExpanded(false)`）。所以只在"宽屏且用户显式点全屏"时调用。
- **推荐交互**：
  - 面板头部（或操作条）放一个"全屏"按钮，调用 `ctx.sidebarRight.toggleFullscreen(target)`，`target` 用 `ctx.sidebarRight.commandTarget(element)` 捕获；
  - **冲突解决 / 三栏合并 / 大 diff** 默认请求全屏（这是产品 J5 的合理场景）；
  - 全屏切换不会重挂载 tab（`README.md:39`），状态保留。
- **注意全屏下的安全区**：Windows Electron 有标题栏内缩（`SidebarRight.module.css:82`），macOS 全屏有红绿灯避让（同文件 `:90+`），插件不要自己写 `position: fixed` 到窗口左上角。

---

## 3. 命令与快捷键

### 3.1 机制

DSH Web 没有独立的"命令面板"，**快捷命令目录就是命令注册表**：`ctx.shortcuts.register(...)`，命令会出现在设置 → 快捷键（`ui-shortcuts`），引导页胶囊可读取同一 `commandId` 显示有效键位（`ui-sidebar-right/README.md:50,113-115`）。

注册契约：`packages/client/shortcuts/src/client/types.ts:20-32`（`id / label / aliases / defaults / regions / modals / resolve`）。

- `defaults` 的 profile 键是显式的：`desktop:macos|windows|linux`、`web:macos|windows|linux`；**省略即不绑定**。
- `resolve(context)` 返回 `handled` + `run`，或 `blocked` + 本地化 `reason`。
- 冲突检测在注册时进行：重复 id、同一 profile 下重叠组合会被拒绝（`shortcuts/README.md`）。
- 命令随插件 fiber 卸载消失，用户自定义覆盖保留（同上）。

### 3.2 如何加 "Git: 打开日志"

按 §1.5 的 `ctx.shortcuts.register`：

- `id: 'git.openLog'`（`ShortcutCommandId` 断言）；
- `label: () => t('command.open')`，中文写 `'Git: 打开日志'`；
- 键位建议 **`Mod+Shift+G`**：
  - `Mod+Alt+G` 已被"重命名会话"占用（`packages/client/ui-workspace/src/client/shortcuts.ts:90`）；
  - `Mod+Shift+G` 在现有注册表里未占用；
  - Web 端允许 `Mod+Shift` 组合（`ui-open-in-app/src/client/index.ts:69-70` 已用 `Mod+Shift+O`）；
  - Linux Web 依现有约定不设默认键（files/terminal/browser 都如此）；
- `resolve` 里用 `commandTarget`：无会话 → `blocked` + `t('noSession')`；有会话 → `openTabFromTarget('git', target)`；
- 引导页 `guide[].commandId = 'git.openLog'`，胶囊自动显示当前键位，无需另写提示。

> 不需要用 `ctx.commandUi`（`/` 斜杠命令）：那是 composer 的 host 命令体系（`packages/client/ui-commands/README.md`），与"打开侧栏页"不是一类入口，且会引入 Host 命令注册的额外耦合。

---

## 4. 主题与样式

### 4.1 硬规则

`docs/web-styling.md`：

| 规则 | 行号 |
|---|---|
| `ui-theme` 拥有 `--dsw-*` 静态色阶、语义别名、字体、动效、阴影、滚动条、明暗偏好 | `:7-11` |
| 组件样式放组件旁的 **CSS Modules**；共享色/字号/高度/动效归主题包 | `:11` |
| 用 CSS Modules + `clsx`，禁止组件库 / Tailwind | `:17` |
| 功能组件只用 `--dsw-alias-*` 语义 token，**禁止字面颜色** | `:18` |
| 功能组件 CSS 里**不要写主题选择器**（明暗覆盖归主题所有者） | `:19` |
| 等宽内容不换行时用共享滚动条样式 | `:24` |

明暗切换的实现是 `<body data-ds-dark-theme>`（`ui-theme/src/styles/design-platform.css:284`；`ui-layout/src/client/theme-presenter.ts:17`），不要自己读 `prefers-color-scheme`。

### 4.2 Git 相关可直接用的 token

| 用途 | token |
|---|---|
| 背景层 | `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3`（`design-platform.css:167-173`） |
| 正文/次级/说明 | `--dsw-alias-label-` 的 `primary` / `secondary` / `tertiary` / `caption`（`:222-225,214`） |
| 边框 | `--dsw-alias-border-` 的 `l1` / `l2` / `l3` / `l4`（`:185-189`，中性实线用 **0.5px**，见样式文档 `:29`） |
| 交互反馈 | `--dsw-alias-interactive-bg-hover`、`-active`（`:213,209`） |
| 状态色 | `--dsw-alias-state-` 的 `success` / `warn` / `error-primary`（`:250-258`） |
| 行内 diff 背景 | `--dsw-alias-code-diff-added`、`-deleted`（明 `:242-243`，暗 `:360-361`） |
| 文件级 diff | `--dsw-alias-file-diff-{added,deleted}-{bg,gutter,marker}`（明 `:244-249`，暗 `:362-367`） |
| 链接 | `--dsw-alias-link` |

`ui-deliverables/src/client/FileDiff.module.css:24-25` 是这些 token 的标准用法（**.add/.del 只换 token 不改结构**）。

### 4.3 Git 图 lane 颜色：深浅色同时适配

**事实**：主题里只有 6 个色系（`design-platform.css:5-40` 的 static 段：`amber / blue / deepseek / green / neutral / red`），**没有**分类色板（chart/categorical）token。

**推荐做法（不加主题选择器、不写字面颜色）**：以静态色为"色相源"，与当前主题的 `label-primary` 做 `color-mix`。`label-primary` 在浅色下近黑、深色下近白，混色后对比度自动跟随主题：

```css
.graph {
  --git-lane-1: color-mix(in oklab, var(--dsw-static-blue-500)   68%, var(--dsw-alias-label-primary));
  --git-lane-2: color-mix(in oklab, var(--dsw-static-green-500)  68%, var(--dsw-alias-label-primary));
  --git-lane-3: color-mix(in oklab, var(--dsw-static-amber-500)  68%, var(--dsw-alias-label-primary));
  --git-lane-4: color-mix(in oklab, var(--dsw-static-red-600)    68%, var(--dsw-alias-label-primary));
  --git-lane-5: color-mix(in oklab, var(--dsw-static-deepseek-500) 68%, var(--dsw-alias-label-primary));
  --git-lane-6: color-mix(in oklab, var(--dsw-static-blue-400)   55%, var(--dsw-alias-label-primary));
  /* 第 7 条起：复用色相 + 虚线/点线区分，不要新增字面色 */
}
.graph path[data-lane] { stroke: var(--git-lane-1); stroke-width: 1.5; fill: none; }
```

取舍与限制：

- **最多 6 条能靠色相区分的 lane**；超过 6 条时建议"色相循环 + 线型/透明度区分"，并在图例里同时给分支名——不引入未登记的色板。
- 如果设计坚持 8–10 色：把完整色板登记为**插件自有自定义属性**（`.graph { --git-lane-* }`），并同时给明暗两组值（在 `body[data-ds-dark-theme] .graph` 下覆盖）。这是对 `web-styling.md:19` 的**显式例外**，必须在插件 README 记录理由；不要把它写进全局样式。
- 对比度自检：lane 线在 `bg-base` 上 ≥ 3:1（非文本图形），选中态加粗到 2.5px + `label-primary` 描边，不只靠颜色区分。
- 提交图节点：`<circle>` 用同色填充 + `bg-base` 描边 1.5px，避免线和节点糊在一起。

### 4.4 构建期的样式方案（与 §5 相关）

DSH 官方 preset 的做法：CSS Modules 由 lightningcss 编译成 hashed class map，并在 factory 执行时注入 `<style data-plugin-css=…>`（`packages/client/tsdown.client.ts:41-61,540-575`）。独立构建见 §5.4 的两种选择。

---

## 5. 打包与安装

### 5.1 外部包的形态：一个包，两半，一层 patch

真实先例（已装在你的 web profile 里）：`~/.dsh/profiles/web/node_modules/@cocofhu/skillhub/package.json`

```jsonc
{
  "name": "@cocofhu/skillhub",
  "type": "module",
  "main": "lib/host.js",                       // Host 入口（Loader 行导入）
  "exports": {
    ".": "./lib/host.js",
    "./client": "./lib/client.js",             // 浏览器产物（必须存在，否则组合报错）
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime", "..."] }
  }
}
```

它的 `cordis.patch.yml` 只有一行插入（`- insert: [{ id: skillhub, name: '@cocofhu/skillhub' }]`），`lib/client.js` 的首行就是产物契约：

```js
window.__ModuleLoader__.load({ id: "@cocofhu/skillhub", factory: (require) => { /* … */ return { inject, apply }; } });
```

即：**一个 Loader 行同时带来 Host 与 Client**。`client-modules` 的 Host 半边扫描**已启用 Loader 行**对应的 package.json，读 `dsh.client`，要求 `exports['./client']` 存在，否则显式报错（`packages/client/modules/src/index.ts:866-868`）；`platform` 必须是 `'web'`（同上 `:861-865`）。行名也可以是**绝对路径**（`name: '/abs/.../lib/host.js'`）：扫描会向上找最近的、名字匹配的 `package.json`（`index.ts:900-950`），所以开发期可以完全不安装、只用 `--patch` overlay 挂上去。

### 5.2 最小 `package.json`（推荐版）

```jsonc
{
  "name": "dsh-plugin-git-workbench",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/host.js",
  "exports": {
    // types 可选：用 tsc --emitDeclarationOnly 产出；不产出就删掉 types 字段（运行时不读它）
    ".": { "types": "./lib/host.d.ts", "default": "./lib/host.js" },
    "./client": { "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      // 仅声明信息性包级依赖（HMR diff / 预检展示），不决定激活顺序
      "inject": [
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-shortcuts"
      ]
    }
  },
  "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" },
  "scripts": {
    "build": "node build.mjs",
    "watch": "node build.mjs --watch"
  },
  "devDependencies": {
    // 只用于类型检查/构建，运行时不依赖（见下）。
    // 版本必须与运行中的 DSH 一致；最省事的做法是直接 link 当前源码 checkout：
    "@deepseek-ai/cordis": "link:/Users/peng/Me/Ai/deepseek-harness/vendor/cordis",
    "@deepseek-ai/dsh-client-ui-slots": "link:/Users/peng/Me/Ai/deepseek-harness/packages/client/ui-slots",
    "@deepseek-ai/dsh-client-ui-sidebar-right": "link:/Users/peng/Me/Ai/deepseek-harness/packages/client/ui-sidebar-right",
    "@deepseek-ai/dsh-client-ui-primitives": "link:/Users/peng/Me/Ai/deepseek-harness/packages/client/ui-primitives",
    "@deepseek-ai/dsh-client-shortcuts": "link:/Users/peng/Me/Ai/deepseek-harness/packages/client/shortcuts",
    "@deepseek-ai/dsh-session": "link:/Users/peng/Me/Ai/deepseek-harness/packages/core/session",
    "@deepseek-ai/dsh-subprocess": "link:/Users/peng/Me/Ai/deepseek-harness/packages/subprocess/subprocess",
    "@deepseek-ai/dsh-sandbox": "link:/Users/peng/Me/Ai/deepseek-harness/packages/sandbox/sandbox",
    "esbuild": "^0.25.0",
    "typescript": "^5.9.0"
  }
}
```

要点：

- devDependencies 里 `link:` 的是当前 checkout 的包（保证类型与运行时同源）。如果这些包在 npm 上能取到同一版本，可以把 `link:` 换成显式版本号——**但必须与运行中的 DSH 完全一致**，不要混用。
- **运行时零依赖是刻意的**：Host 只 import `node:*`，DSH 能力全部从 `ctx` 取（类型用 `import type`，编译后擦除）。这样不碰 profile 的 peer 解析，也不会因 DSH 小版本升级而炸（profile 是 `autoInstallPeers: false`，见 `~/.dsh/profiles/web/pnpm-workspace.yaml:5`）。
- `dsh.client.inject` 是**信息性**的包名边（`packages/client/AGENTS.md` 的模块图小节；`modules/src/client/manifest.ts:169-190` 只做格式校验）——**不要**把服务依赖写进来，服务依赖用 Cordis `inject`。
- 需要 DSH 的运行时库（例如 `dsh-timeout`）时，按 `docs/user/develop/basic/publish.md:94-108` 同时放进 `peerDependencies` + `devDependencies`，让 profile 解析到运行安装的同一份实例；但本项目不需要。
- `engines.dsh` 会被安装与启动校验（`publish.md:66`）；不写则退化为检查 `@deepseek-ai/dsh*` peer 范围。

### 5.3 官方 tsdown preset 能否脱离 DSH 仓库？

**不能（结论明确）**，原因是硬编码的相对路径与仓库级门禁：

| 依赖 | 位置 | 外部后果 |
|---|---|---|
| `./modules/src/client/manifest.ts`、`./web/src/platform.ts`、`../../scripts/*` | `packages/client/tsdown.client.ts:14-25` | 在 DSH 仓库外无法解析 |
| `REPOSITORY_ROOT = new URL('../..', import.meta.url)` | 同文件 `:88` | 永远指向 DSH 仓库根 |
| `BundleInputIsolation(REPOSITORY_ROOT, …)` 断言所有输入在仓库内 | `:675-720`（`clientInputIsolation`） | 外部源码路径会被纯净度/隔离门禁拒绝 |
| `defineConfig` 期望 workspace 级 `DSH_BUILD_FACE` 环境 | `:120-136` | 需要 DSH 的根 `tsdown.config.ts` 编排 |
| 产物内联 `PLATFORM_MODULES` 基线 | `web/src/platform.ts:8-15` | 基线列表与新版本同步依赖仓库源码 |

所以外部构建要**自己复刻产物契约**，但契约本身非常小（3 行）：

```ts
// packages/client/tsdown.client.ts
banner: `window.__ModuleLoader__.load({ id: <pkg>, factory: (require) => {`   // :663-667
intro:  'var module = { exports: {} }; var exports = module.exports;'       // :669
footer: 'return module.exports; } });'                                      // :668
```

外部化清单直接抄 `PLATFORM_MODULES`（`web/src/platform.ts:8-15`）：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。其它请求只在 `dsh.client.external` 里声明（本项目不需要）。

另有一个硬事实：**Host 端 Typert 代码生成**也脱离不了仓库——`findWorkspaceRoot` 要求向上找到同时含 `tsconfig.host.json` 与 `packages/` 的目录（`packages/typert/generator/src/workspace.ts:186-194`），这是 §6 选通用 RPC 的决定性理由之一。

### 5.4 方案 A 的构建：`build.mjs`（esbuild，约 60 行）

```js
// build.mjs
import { build, context } from 'esbuild'
import { readFileSync, utimesSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const ID = pkg.name
const BASE = [ // 与 packages/client/web/src/platform.ts:8-15 保持一致
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod',
  '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

/** @type {import('esbuild').BuildOptions} */
const client = {
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: BASE,
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  // 若某个内联依赖探测 import.meta.env，再加一个 esbuild 插件替换（不同 esbuild 版本对
  // define 键 import.meta.* 的支持不一致，不要写进基线）。
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {` },
  intro: 'var module = { exports: {} }; var exports = module.exports;',
  footer: { js: 'return module.exports; } });' },
  plugins: [{
    // HMR 修订号由 mtime/ctime/size 决定（packages/client/hmr/src/index.ts:52-88），写完要戳一下
    name: 'stamp', setup(b) { b.onEnd(() => { const now = new Date(); utimesSync('lib/client.js', now, now) }) },
  }],
}

const host = {
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/host.js',
  bundle: true, format: 'esm', platform: 'node', target: 'node22',
  packages: 'external',          // Host 不内联任何第三方位
  sourcemap: true,
}

if (process.argv.includes('--watch')) {
  const c1 = await context(client); await c1.watch()
  const c2 = await context(host);   await c2.watch()
  console.log('watching…')
} else {
  await build(client)
  await build(host)
}
```

产物自检（不需要浏览器）：用假 `window` 跑一次 `eval`，断言 `factory` 返回对象含 `apply`/`inject`：

```js
// test/bundle.smoke.mjs —— 无需浏览器，也绕开 package.json 的 "type": "module"
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let reg
const win = { __ModuleLoader__: { load: (r) => { reg = r } } }
vm.runInNewContext(readFileSync('lib/client.js', 'utf8'), { window: win, console })
const mod = reg.factory((name) => { throw new Error(`unexpected require ${name}`) })
if (typeof mod.apply !== 'function') throw new Error('client bundle contract broken')
if (!Array.isArray(mod.inject)) throw new Error('client bundle inject contract broken')
// 再断言 id 与包名一致、外部化确实生效（factory 里的 require 没有被内联）
```

**样式**（esbuild 的两个选择）：

| 做法 | 优点 | 代价 |
|---|---|---|
| **v1（spike 推荐）**：`.css` 当 text 读入，apply 时注入一个带 `data-plugin-css` 的 `<style>`；类名用 `git-` 前缀 | 10 分钟可跑通；无哈希管线 | 全局类名，需前缀纪律 |
| **v2（产品）**：esbuild `local-css` 生成 class map，再单独构建一次 CSS 文本注入（同一 hashing 算法，类名对得上） | 与 DSH 的 CSS Modules 语义一致 | 两遍构建 + 需在 spike 里验证哈希稳定 |

如果团队更看重"和 DSH 产物逐字节同源"，就用方案 B 产出构建，再把产物纳入本仓库发布（见 §0.2 折中）。

### 5.5 方案 B 与折中

方案 B 需要动 DSH 仓库的三处（`packages/client/AGENTS.md` 新插件清单）：

1. `packages/client/tsconfig.client.json` 的 `references` 增加一项；
2. `packages/bundle/web-app/cordis.patch.yml` 增加一行（参照 `:283-304` 的 `ui-sidebar-right` / `ui-sidebar-files`）；
3. `packages/bundle/web-app/package.json` 增加依赖。

**不要用 symlink 把外部 `src/` 链进 DSH 包**：`BundleInputIsolation` 会把解析后的真实路径与 `REPOSITORY_ROOT` 比较（`packages/client/tsdown.client.ts:675-720`），外部路径会被拒；官方 `inspect` 类实验包才跳过该门禁（`isExperimentalPackageName`），不要为了绕过门禁改包名。

因此折中只能是"**复制同步**"：本仓库为真源 → 每次构建前用脚本把 `src/` 同步到 DSH 壳包 → 用 preset 产出 `lib/client.js` → 拷回。它只适用于需要逐字节对齐官方产物的排查场景，不适合日常开发。

### 5.6 安装到 web profile 与重启要求

```bash
# 在源码启动场景（当前就是）用 pnpm dsh；已装全局 CLI 则去掉 pnpm
cd /Users/peng/Me/Ai/deepseek-harness
pnpm dsh plugin --profile web add /Users/peng/Me/Ai/vibe-inspiration/dsh-idea-gittool/packages/plugin
# 也可显式写协议：dsh plugin --profile web add file:/abs/path/to/plugin
```

- `dsh plugin` 把参数原样转给 profile 目录里的 pnpm（`docs/user/develop/basic/publish.md:82-85`；`docs/cli-help.md:27,67-73`）。本地目录会记录为 `link:<绝对值>`（`publish.md:92`），因此**后续只改代码不用重新 add**。
- 包声明了 `dsh.bundle`，`dsh` 会把它追加进 `dsh.profile.bundles`（`publish.md:85-92`）——这会写 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组（当前内容见该文件 `:9-18`）。
- 安装前可验证层：`pnpm dsh --profile web --dump-config`（`publish.md:113-115`）。
- **重启矩阵**：

| 改动 | 是否需重启 `dsh web` | 依据 |
|---|---|---|
| Client（`lib/client.js`）重新构建 | **否**，自动热换 | `dsh-client-hmr` 的 Host 半边每 500ms stat 轮询每个图行的 client 产物，mtime/ctime/size 变化即发布 rebuilt 帧（`packages/client/hmr/src/index.ts:3,52-121`；`README.md:32,42,62`） |
| Host（`lib/host.js`）修改 | **是** | Loader 在启动时映射模块，内置 profile 不启用服务端模块 HMR（`packages/boot/app-boot/README.md:63`；"None of the shipped profiles enable server module HMR"） |
| 首次安装 / 改 `cordis.patch.yml` / 增删 bundle | **建议重启**（可靠路径） | 安装映射与本地覆盖要求重启（`app-boot/README.md:199`）；linked 包"重建与重启仍然必要"（`packages/boot/plugin-manager/README.md:50`）。profile 的 `patchReload: live` 只负责配置文件级重载（`~/.dsh/profiles/web/package.json:19`；`app-boot/README.md:63`） |
| 卸载 / 换安装路径 | **是** | `plugin-manager/README.md:52` 的 `restart-required` |

- 开发期更轻的挂载方式（不写 profile，不需要 add）：仓库内放一个 `dev.patch.yml`：

```yaml
- insert:
    - id: dsh-git-dev
      name: '/Users/peng/Me/Ai/vibe-inspiration/dsh-idea-gittool/packages/plugin/lib/host.js'
```

启动：`pnpm dsh web --patch ./dev.patch.yml`。行名是绝对路径时，client-modules 会向上找到我们的 `package.json`（`packages/client/modules/src/index.ts:900-950`），因此 `./client` 仍会被服务。**注意**：`--patch` overlay 只在启动时应用，改它要重启；它只省掉 profile 安装，不省重启（配置 watcher 只盯 profile manifest 与两个用户 patch 文件，见 `packages/boot/app-boot/README.md:63`）。

---

## 6. 浏览器 ↔ Host 通信：Typert Remote vs 通用 RPC

### 6.1 两条路的机制

**Typert Remote（生成式）**

- Host 侧：Service 方法加 `@Remote`，构建期由 `typertPlugin` 生成 `./typert`（Host 反射）与 `./remote`（Client 代码+编解码+schema）；`ctx.remote` 只暴露**被入口 import 并 `$mount()` 过**的命名空间（`docs/subsystems/typert.md:41,45,472-480`；`packages/api/gateway/src/client/index.ts:214-222`）。
- Client 侧：`ctx.remote.<namespace>.<method>(...)`，支持 unary 与 `stream`（`mode: 'stream'`，走 `/api/remote.mux` WebSocket，含 uplink、重连、取消）。
- 生成器在仓库构建里由根 `tsdown.config.ts` 的 `typertPlugin({ mode: 'workspace', faces: ['host'] })` 驱动（`tsdown.config.ts:3-4,35`；`scripts/typert-faces.ts:8`）。

**通用 RPC（Channel）**

- Host 侧：`ctx.connection.rpc.handle('/dsh-git', handler)`（`packages/client/connection/src/rpc-host.ts:105-112`）。注册会挂一个 `webServer` prefix 路由（`:253-289`），请求先过浏览器鉴权/Host-Origin 围栏（`admit`，`:129-137,260-268`），再按 JSON 信封派发（`:304-347`）。
- Client 侧：`ctx.connection.rpc.call('/dsh-git', 'status', payload, signal)`（`packages/client/connection/src/client/rpc.ts:34-80`），POST `${channel}/${endpoint}`，等待 JSON 或 multipart 响应；`rpcId` 双向校验。
- Handler 签名拿到 `(endpoint, payload, signal, peer)`；`signal` 是 `request.signal`（`:342`），浏览器 abort / 关页会传导为取消。

### 6.2 对比与推荐

| 维度 | Typert Remote | 通用 RPC `/dsh-git` |
|---|---|---|
| 类型安全 | ✅ 生成 Zod/schema、参数与结果编解码 | ⚠️ 手写类型守卫（payload 是 `unknown`） |
| 流式 | ✅ 原生 stream + uplink + 重连 | ❌ 仅 unary（`connection/README.md:32`："Binary parameters, events, and streamed binary results are unsupported"） |
| 大负载 | unary 也走 JSON；stream 可分片 | JSON；可返回 multipart 字节附件（`rpc.ts:30-46`；`README.md:32`） |
| 取消 | ✅ signal 全程 | ✅ `request.signal` → `subprocess` kill |
| 鉴权 | ✅ 资源级访问控制（`dsh-api-remote-access`） | ✅ 浏览器 Cookie + Host/Origin 围栏；handler 内可再查 `peer.principal.kind` |
| 外部仓库可用 | ❌ 生成器要求 DSH 形状的 workspace（`typert/generator/src/workspace.ts:186-194`），且要与 Host 版本同源 | ✅ 纯 HTTP 契约，无代码生成 |
| 升级耦合 | 高（descriptor/编解码/schema 与 DSH 版本绑定） | 低（自己定义 JSON） |
| 工作量 | 高（还要在 Client 侧 mount 自己生成的 `/remote`） | 低（一个 handler + 一个 call 封装） |

**推荐：通用 RPC（`/dsh-git`）**，理由：

1. **外部包可独立构建**（决定性）；
2. Git 面板的交互是"请求-响应"型，绝大多数数据（status/log/branches）一次取回即可；
3. 唯一需要的"服务端推送"（工作区变化）已经有现成流：`workspaceFiles.changes`（§9），不必自己实现；
4. 升级 DSH 时不需要重新生成客户端代码。

**限制（必须设计进去）**：

| 限制 | 影响 | 对策 |
|---|---|---|
| 无服务端流 | 不能推送"新提交/工作区变化" | 复用 `workspaceFiles.changes` + 可见时轮询（§9）；需要流式响应时改用 exact Fetch 路由（§6.4） |
| 单请求 JSON、body 缓冲 | 大 diff / 长日志一次性占内存 | Host 侧强制上限：`--max-count`、per-file 文本 ≤ 256KiB、总 ≤ 4MiB，返回 `truncated` 标记 |
| 浏览器同源并发 6 连接 | 同时 status+log+diff+branches 可能排队 | 面板按页懒加载；同页请求串行或合并（一次 `status+head` 合并端点） |
| 无 multipart 请求体 | 不能上传二进制参数 | 本插件不需要（不做 GPG 签名上传） |
| 每个 RPC 是独立 POST | 无法断点续传 | 分页游标（`next` cursor） |
| 取消依赖 fetch abort | Host 侧要真把 `signal` 传到 subprocess | 直接透传给 `spawn({signal})` |
| 失败语义 | handler 抛异常会变成 HTTP 500 文本，客户端只能拿到传输错误 | **永远返回结构化 `{ok:false,error:{code,message,details}}`**，不要 throw |

### 6.3 建议的 RPC 契约（v1）

`POST /dsh-git/<endpoint>`，payload 均含 `sessionId`（**不含 cwd**）：

```ts
type Envelope = { sessionId: string }

// status: 工作区、HEAD、上游、操作态
'status'          → { branch: string | null; detached: boolean; head: string | null;
                      ahead: number; behind: number; upstream: string | null;
                      staged: FileEntry[]; unstaged: FileEntry[]; untracked: FileEntry[];
                      conflicts: FileEntry[]; operation: 'merge'|'rebase'|'cherry-pick'|'revert'|null;
                      truncated: boolean }
// log: 分页提交
'log'   { cursor?: string; limit?: number }
                  → { commits: Commit[]; next?: string; truncated: boolean }
// commit: 详情
'commit' { sha: string } → { commit: Commit; files: FileEntry[]; truncated: boolean }
// diff: 一文件的两侧文本（客户端用 DiffBlock 渲染）
'diff'  { path: string; scope: 'worktree'|'staged'|'commit'; sha?: string; parent?: string }
                  → { oldText: string | null; newText: string | null; binary: boolean; truncated: boolean }
// branches / remotes / stash（v1.5）
```

约定：

- `FileEntry` 只含 repo 相对路径、旧/新路径（重命名）、状态码、增删行数；
- 路径参数只接受 repo 相对 POSIX 路径，Host 侧拒绝绝对路径、`..` 与以 `-` 开头的值，并统一走 `--` 与 `GIT_LITERAL_PATHSPECS=1`；
- `diff` 的文本上限与行数上限写进响应，客户端按 `truncated` 展示"文件过大"；
- 所有端点在 Host 侧先解析 `cwd`，并用 `git rev-parse --show-toplevel` 的结果做根，后续命令都显式 `cwd: root`。

### 6.4 需要流式/大响应时的第三条路（exact Fetch 路由）

通用 RPC 是 JSON unary；如果某个响应确实需要"边算边传"（超大 diff、日志导出），DSH 还有 exact Fetch 路由，两种挂法：

| 挂法 | URL | 鉴权 | 适用 |
|---|---|---|---|
| `ctx.connection.fetch.register({ path: '/api/dsh-git/raw', methods: ['GET'], requestBody: 'buffered', fetch })` | `api/dsh-git/raw`（浏览器用 `path.slice(1)` 的文档相对形式） | `/api` 通道统一鉴权（Cookie + Host/Origin 围栏） | 想留在 `/api` 下、复用统一网关；`fetch` 返回的 `Response` body 可以是 `ReadableStream`，实现流式响应（先例：`packages/client/file-upload/src/index.ts:73`、`packages/client/ui-deliverables/src/present-open.ts:21-44`） |
| `ctx.webServer.register({ kind: 'exact', path: '/dsh-git/raw', handler })` | `/dsh-git/raw`（顶层） | **必须自己调** `ctx.connection.requestRejection(req)`（先例：`packages/host/open-in-app/src/index.ts:193-210`） | 需要独立顶层路径或非 `/api` 前缀；鉴权自己负责，漏写即越权 |

建议：**v1 只用 JSON RPC**；等真实仓库的 diff 体积数据出来后，再为"单文件超阈值"加一条 GET 流式路由（Host 侧用 `ctx.subprocess` 的 `stdio.stdout: 'pipe'` 直接把 `git diff` 的输出接给 Response，避免把整个 patch 读进内存）。

---

## 7. Session cwd：Host 如何解析（不要信客户端）

**原则**：客户端只传 `sessionId`；cwd 由 Host 从会话头部/投影解析。这是 `workspaceFiles` 的既有做法（`packages/api/workspace-files/src/index.ts:203-221`）：先查 live 会话头，再查持久化，兜底 sandbox 根。

```ts
// src/host/cwd.ts
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export async function resolveSessionCwd(ctx: Context, sessionId: SessionId): Promise<string> {
  const live = ctx.get('sessions')?.get(sessionId)
  if (live !== undefined) {
    // 有效目录（可能被 working-directory/change 改过），无记录时回退 header
    return ctx.get('workingDirectory')?.get(live) ?? live.header.cwd ?? ctx.get('sandboxPolicy')?.workspaceRoot ?? process.cwd()
  }
  const stored = await ctx.get('sessionPersistence')?.stat(sessionId)
  const header = stored?.header
  if (header?.cwd !== undefined) return header.cwd
  return ctx.get('sandboxPolicy')?.workspaceRoot ?? process.cwd()
}
```

依据：

| API | 语义 | 出处 |
|---|---|---|
| `ctx.sessions.get(id): Session \| undefined` | 只返回 live 会话 | `packages/core/session/src/index.ts:1353-1356` |
| `session.header.cwd` | 会话创建时的**不可变**绝对工作目录 | `packages/core/session/src/types.ts:95-106`（`cwd` 在 `:105-106`） |
| `ctx.workingDirectory.get(session)` | 当前**有效**目录（投影记录，无 I/O） | `packages/session/working-directory/src/index.ts:122-127` |
| `ctx.sessionPersistence.stat(id)` | 休眠会话的 header | `packages/session/session-persistence/src/index.ts:50-61` |
| `ctx.sandboxPolicy.workspaceRoot` | 无 cwd 时的部署兜底 | `packages/sandbox/sandbox-policy/src/index.ts:122-124,164-171` |
| 先例（终端） | `workingDirectory.get(agent.session)` + `ensure(agent)` | `packages/api/terminal-controller/src/index.ts:121-122,303-321` |
| 先例（工作区文件） | live header → persistence → sandboxPolicy | `packages/api/workspace-files/src/index.ts:209-220` |

注意：

- `inject` 只用**必需**服务（`connection`、`sessions`）；`workingDirectory` / `sessionPersistence` / `sandboxPolicy` 用 `ctx.get()` 取可选项，避免某个 composition 缺服务时整插件 PENDING。
- `sessionId` 仍是外部输入：解析后必须 `stat` 确认是目录，再 `git rev-parse --show-toplevel`；失败返回 `git/not-a-repository` 而不是 500。
- 会话可能**不在仓库里**：这时 Git tab 显示空态（"当前会话目录不在 Git 仓库中"），不要禁用 tab 类型本身（用户可切会话）。

---

## 8. Git 执行：`ctx.subprocess`，不是 `ctx.shell`，也不是 `child_process`

### 8.1 选型结论

| 方案 | 判定 | 理由 |
|---|---|---|
| `node:child_process.execFile('git', argv, {cwd})` | ❌ 不推荐 | 绕开 composition 的执行世界（本地/远程/容器可替换）、绕开凭据清洗与沙箱、没有托管进程范围的终止与 `waitForExit`；DSH 已有 Git 先例都走 `ctx.subprocess`（`packages/deliverables/workspace-changes/src/git.ts:41-81`） |
| `ctx.shell.execute({ command: 'git ...' })` | ❌ 不选 | 请求是**shell 字符串**（`packages/shell/shell/src/types.ts:61-104`），路径/提交信息里的空格与引号会变成注入面；它是服务于模型 `bash`/`pwsh` 工具的 seam，结果按"输出 + 退出标记"的契约交付（`packages/shell/shell/README.md` 的 shared exit-status contract），不是给插件传 argv 的执行接口 |
| **`ctx.subprocess.resolveExecutable` + `spawn({ argv, cwd, env, stdio, signal })`** | ✅ **推荐** | argv 不经 shell；有界 collect、spill、取消、进程范围终止、凭据清洗；与仓库内 Git 用法一致 |
| 写操作再叠加 `ctx.sandbox.confine(argv, policy)` | ✅ 必须 | 写 `.git` / 工作区必须受会话文件策略约束；worktree 包就是 `confine` 后 spawn（`packages/experimental/worktree/src/process.ts:50-67`） |

### 8.2 推荐实现（可直接用）

```ts
// src/host/git.ts
const GIT_ENV = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
].map(key => [key, undefined]))   // 清掉继承的选择器（worktree/src/process.ts:18-24）

const READ_ENV = {
  ...GIT_ENV,
  GIT_CONFIG_COUNT: '0',      // 同时清掉 GIT_CONFIG_KEY_n（workspace-changes/src/git.ts:68-69）
  GIT_CONFIG_NOSYSTEM: '1',   // 不读系统级 gitconfig
  GIT_TERMINAL_PROMPT: '0',   // 绝不交互式要密码
  GIT_OPTIONAL_LOCKS: '0',    // 只读命令不刷新 index（同上）
  GIT_LITERAL_PATHSPECS: '1', // 路径按字面匹配
  LC_ALL: 'C',                // 错误信息稳定可解析（同上）
}

async function runGit(ctx, session, cwd, argv, signal, { write = false, maxBytes = 2 * 1024 * 1024 } = {}) {
  // 零运行时依赖：用 Web 平台自带的 AbortSignal 组合，不用 dsh-timeout
  const timeout = AbortSignal.timeout(8000)
  const lifetime = AbortSignal.any([signal, timeout])
  const program = await ctx.subprocess.resolveExecutable('git', undefined, lifetime)
  let command = [program, ...argv]
  if (write) {
    const policy = ctx.sandboxPolicy.resolve({ session })
    if (policy.mode !== 'danger-full-access') {
      command = (await ctx.sandbox.confine(command, policy, lifetime)).argv
    }
  }
  const child = ctx.subprocess.spawn({
    argv: command, cwd,
    env: READ_ENV,
    signal: lifetime,
    graceMs: 2000,
    stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: 64 * 1024 } },
  })
  try {
    const outcome = await child.done
    const out = child.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    return { exitCode: outcome.exitCode, stdout: out.text, lossy: out.lossy,
             stderr: child.collected.stderr?.readFrom(0).text ?? '' }
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}
```

### 8.3 必须处理的策略

| 主题 | 建议 | 依据 |
|---|---|---|
| **沙箱** | v1 全部只读命令（`log/status/diff/show/branch --list`），不 `confine` 也能保证不写；但**仍建议** `confine`，因为 `--stat`/`diff` 可能触发 `core.fsmonitor`、textconv 等仓库配置里的外部进程。写操作用 `sandboxPolicy.resolve(...)` 的 `workspace-write` 并 `confine`；`danger-full-access` 会话才直接跑 | worktree 的写法 `process.ts:50-55`；`sandbox-local/README.md`（不支持时 fail closed） |
| **`.git` 可能在 workspaceRoot 之上** | 会话 cwd 常是仓库子目录，`workspaceRoot = session.header.cwd`（`sandbox-policy/src/index.ts:164-171`）→ 写 `.git` 会被沙箱拒绝。因此：写操作前用 `git rev-parse --show-toplevel` 得到 repo root；若 `repoRoot` 不在 `policy.workspaceRoot` 内，**显式拒绝并提示**（"提交需要整个仓库目录在工作区内"），不要静默放宽 | 沙箱边界语义同上 |
| **超时** | 每条命令 5–10s；`git log` 用 `--max-count`，不要靠超时兜底 | `GitRunner` 用 `AbortSignal.timeout` + `any`（`workspace-changes/src/git.ts:55-57`） |
| **输出截断** | `collected.stdout.lossy` 表示**超出上限且丢掉的是头部**（`git.ts:18-19` 注释）；因此解析型命令必须用 `--max-count`/`-z` 控制体量，`lossy` 时直接返回 `git/output-too-large`，绝不解析半截 | 同上 `:76-79` |
| **locale** | `LC_ALL=C` + 稳定的 `--pretty=format:`/`-z`/`--porcelain=v2 -z`，不要在中文环境里正则匹配人类文案；路径按字节读，输出按 UTF-8 解码（坏字节用替换符） | 同 `git.ts:69`；workspace-changes 用 `LC_ALL:C` 并正则匹配英文 "not a git repository"（`git.ts:130-131`） |
| **凭据 / SSH 交互** | `GIT_TERMINAL_PROMPT=0`（已设）；`stdio.stdin='ignore'` 无 TTY；v1 **不做 fetch/push**，认证失败引导用户去终端。`ctx.subprocess` 会清洗 `KEY/PASSWORD/SECRET/TOKEN` 形状的变量（`packages/subprocess/subprocess/src/index.ts:47,66-80`），`SSH_AUTH_SOCK`/`HOME` 会保留，所以真要支持 push 时 SSH agent 仍可用；HTTPS 凭据走 `HOME` 下的 credential helper | subprocess README 的 "Environment every child starts from" |
| **仓库配置注入** | `-c core.fsmonitor=false`（避免 git 启动仓库配置里的 fsmonitor 进程）、`--no-pager`、`--no-ext-diff`、`--no-textconv`；不要用 `-c` 传用户可控值 | git 的 `core.fsmonitor` 会在 status/diff 时被调用 |
| **macOS 的 `/usr/bin/git` 是 developer-tools stub** | 首次运行可能弹安装器或直接失败。探测 `git --version` 失败时给"未安装 Git / 需要 Xcode 命令行工具"的明确错误 | workspace-changes README 的 Known Limitations |
| **破坏性操作** | `push --force-with-lease`、删除分支/丢弃改动二次确认、`stash` 永不静默；`reset --hard` 只在明确的"丢弃改动"入口出现 | 产品设计 §4 |

**v1 建议范围**：只读（status/log/show/diff/branch list/stash list）。写操作（commit/checkout/stash/push）作为 v1.5 单独里程碑，先补齐沙箱边界与"强制/可逆"交互，再接 UI。

---

## 9. 变更监听

### 9.1 可用能力

| 能力 | 位置 | 语义 |
|---|---|---|
| `ctx.fs.watch(target, changed, signal)` | `packages/fs/fs/src/index.ts:92-104`（契约）<br>`packages/fs/fs-local/src/index.ts:69-89`（本地实现） | **目录只监听直接子项**（chokidar `depth: 0`，`:76`）；文件监听其父目录并过滤；返回异步关闭函数 |
| `ctx.fs` 的 `fs/observed` 事件 + `WorkspaceChangeFeed` | `packages/api/workspace-files/src/changes.ts:17-105` | Host 侧把 watch 包成 `ready` + `change` 帧，错误归一为 `workspace-file/watch-unsupported` |
| Remote `workspaceFiles.changes(sessionId, path, lifetime)` | `packages/api/workspace-files/src/index.ts`（Remote 方法）；客户端用法 `ui-sidebar-files/src/client/face.ts:30-70` | **浏览器可用的流**（WebSocket `/api/remote.mux`），带 `ready`/`change`，自动重连、取消；目录必须在 workspaceRoot 内 |

### 9.2 监听哪些目标

| 目标 | 覆盖的变化 |
|---|---|
| `<gitDir>/HEAD` | 切分支、detached HEAD、rebase/merge 进行中标记 |
| `<gitDir>/refs`（目录，depth 0） | 分支指针更新（但不含 `refs/heads/*` 的嵌套文件！） |
| `<gitDir>/refs/heads`、`<gitDir>/refs/remotes` | 具体分支更新（必要时再挂一层） |
| `<gitDir>/index` | `git add` / `commit` / `checkout` / `reset` |
| `<gitDir>/packed-refs` | `git pack-refs`、部分 fetch |
| 工作区根目录（可选） | 新建/删除顶层文件（**收不到子目录内文件内容修改**） |

结论：**文件级 watch 的 depth 限制决定了它无法覆盖"任意文件被编辑"**。所以"未提交数量"这类数据不能只靠 watch：

- 主路径：`.git/{HEAD,index,refs,packed-refs}` watch（真正改变 Git 状态的动作都会落盘到这些）；
- 兜底 1：tab `visible` 变 true、窗口 focus、用户点刷新时重新拉 `status`；
- 兜底 2：`visible` 时每 5–10s 轻量轮询 `status`（只读、`--porcelain=v2 -z`，开销很小）；不可见时停止；
- 兜底 3：agent 工具执行完（`tool/result`）后刷新——**v1 可不做**（产品非目标里已排除模型工具，但可用 Host 事件监听 `tools/post-execute` 作为增强）。

### 9.3 防抖与并发

```ts
// Host 侧（若自己 watch）或 Client 侧（用 workspaceFiles.changes）
let timer: ReturnType<typeof setTimeout> | undefined
const bump = () => {
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(() => { timer = undefined; void refresh() }, 250)  // 250ms 合并 git 的多文件落盘
}
```

- 一次 `git checkout` 会连续改 HEAD、index、多个 ref → 250ms 防抖能合并成一次 `status+log(第一页)`；
- 刷新时若有请求在飞，标记 `dirty`，等当前完成后再跑（不要并发堆叠）；
- 用 `tab.signal` 统一取消；组件卸载时清 timer + 释放流；
- 监听失败（网络盘、`watch-unsupported`）要**降级为轮询**并在 UI 里保留"手动刷新"。

---

## 10. 可复用 UI 与需要自建的部分

### 10.1 可直接用（`@deepseek-ai/dsh-client-ui-primitives` 是模块表基线，外部 bundle 可 `require`）

`packages/client/web/src/platform.ts:8-15` 已把 `ui-primitives`、`ui-slots`、`ui-store`、`ui-dockkit`、`react`、`react-dom`、`zod`、`@tanstack/react-virtual` 放进冻结模块表；它们是**唯一**允许跨插件复用的运行时身份。

| 需求 | 组件/工具 | 出处 |
|---|---|---|
| diff 渲染（unified） | `DiffBlock`，props `{ diffs: [{ path, oldText, newText }], labels, maxLines }`，内部用 `diff` 包算 hunk，支持折叠与复制 | `ui-primitives/src/DiffBlock.tsx:18-31,38-56`；README `:108-110` |
| 代码高亮 | `languageForPath`、`useCodeHighlighter`（懒加载 Shiki） | README `:77` |
| 代码块/只读文本 | `CodeBlock`、`ReadBlock` | README `:68,108-110` |
| 文件/文件夹图标 | `FileTypeIcon`、`classifyFileType`、`fileExtension` | README `:76` |
| 分支图标 | `IconBranchOutlineRegular` / `IconBranchOutlineMedium` | `ui-primitives/src/icons/index.tsx:159-165` |
| 菜单 | `Menu` / `MenuSurface`（含模糊匹配、键盘导航） | `ui-primitives/README.md:49,127`；`web-styling.md:26` |
| 按钮/输入/气泡/提示 | `Button`、`Tooltip`、`Modal`、`HoverCard`、`Toast`、`DisclosureRow` | README 组件目录 `:39-90` |
| 长列表虚拟化 | `@tanstack/react-virtual`（基线） | `platform.ts:10` |
| 提交图 | ❌ 需自建 | 建议 SVG（lane 用 §4.3 的变量），列表用 `react-virtual` |
| 文件地址（打开现有预览） | `fileAddressFor(sessionId, cwd, absPath)` + `tab.actions.openResource(...)` | `util/workspace-path/src/index.ts:92-99`；`ui-sidebar-files/src/client/FilesBody.tsx:187` |
| 打开目录/文件到本机应用 | ⚠️ **Host 路由可复用、UI 需自建**：用同源 `fetch` 调 `GET /open-in-app/apps?path=…` 与 `POST /open-in-app/open`（常量见 `host/open-in-app/src/shared.ts:11-23`，带会话文件授权）；`ui-open-in-app` 的分割按钮/菜单组件不能跨插件导入 | `ui-open-in-app/README.md`；`host/open-in-app/src/index.ts:195-310` |

### 10.2 不能直接复用

| 对象 | 为什么 |
|---|---|
| `ui-deliverables` 的 `FileDiff` / 变更卡片 | 跨插件禁止值导入（`ui-primitives/README.md:39`；`packages/client/AGENTS.md` 的 export discipline）。可**照抄结构**（`ui-deliverables/src/client/FileDiff.tsx`：并排 diff、行号、Shiki 高亮、5000 行上限），但代码要落在本插件里，或把通用部分上提到 `ui-primitives`（需要 DSH 侧改动，v1 不做） |
| 终端包（`ui-sidebar-terminal` + `terminal-controller`） | 它是 PTY 而非"跑一条命令"；Git 不该走 PTY（会带 shell、有交互风险）。但可参考它的"连接/重连/标题/store"结构 |
| 文件树 tab | 直接复用它的**模式**（root 来自 `useSessions().byId[id].cwd`、点击开 `fileAddressFor`），但组件本身就是"文件树"，Git 面板需要自己的信息架构 |
| Blame / 行内装饰 / CodeLens | DSH 无可扩展代码编辑器（产品 D7），必须用面板视图替代 |

### 10.3 客户端图片/资源

插件的静态资源在构建期应内联为 data URL（DSH preset 把 svg/png/webp 变成 base64，`tsdown.client.ts:38-39,636-650`）；独立 esbuild 用 `loader: { '.svg': 'dataurl', ... }` 保持一致。不要引用运行时相对路径——外部包的 `lib/` 不会作为 HTTP 静态目录暴露（client-modules 只服务 `client.js` 与 chunk/map）。

---

## 11. 关键风险（5 条）

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **独立构建产物契约漂移**：`__ModuleLoader__` 包装、基线模块清单、`dsh.client` 语义随 DSH 版本变化 | 升级后白屏或插件不加载 | 基线清单从 `web/src/platform.ts` 生成（构建时读取或脚本校验）；`engines.dsh` 锁定范围；CI 跑 §5.4 的 bundle smoke + 一次真实 `dsh web` 冒烟；把"升级必查"写进 README |
| R2 | **沙箱边界 ≠ 仓库根**：写 `.git` 被 `workspace-write` 拒绝；只读命令仍可能触发 `core.fsmonitor`/textconv 外部进程 | 提交/切分支失败，或出现难解释的错误 | v1 只读 + `GIT_OPTIONAL_LOCKS=0`；写操作前 `rev-parse --show-toplevel` 并校验与 `policy.workspaceRoot` 的关系；失败给可行动文案；`-c core.fsmonitor=false --no-ext-diff --no-textconv` |
| R3 | **网络与凭据**：fetch/push 需要凭据/SSH agent/无 TTY；托管平台可能二次认证 | 卡住、超时、误报 | v1 不提供网络操作；`GIT_TERMINAL_PROMPT=0` + stdin ignore + 短超时；错误里明确"请在终端完成认证"；后续若做，单独设计凭据与取消 |
| R4 | **大仓库/大 diff 的响应体积**：无流式、JSON 单请求，10k 提交或 5MB patch 会卡页面 | 面板卡死、内存峰值 | 分页 + `--max-count` + 每文件/每响应字节上限 + `truncated` 文案；diff 用两侧文本 + `DiffBlock` 的 5000 行上限；必要时只给 `--numstat` |
| R5 | **变更监听不可靠**：`fs.watch` 在 depth 0、网络盘、Linux inotify 限制、macOS stub 下都可能漏事件 | 状态不更新、用户以为已提交 | 多目标 watch + 250ms 防抖 + `visible` 时轮询 + 手动刷新 + `watch-unsupported` 降级；所有刷新路径共用同一个串行队列 |

---

## 12. 最小验证 spike（0.5–1 天）

**目标**：右侧栏出现 Git tab，能跑 `git status` + `git log` 并渲染；不写业务操作、不画提交图、不做 diff 编辑器。

| 步骤 | 内容 | 时间盒 | 验收 |
|---|---|---|---|
| S0 | 建包骨架：`package.json`（§5.2）、`cordis.patch.yml`、`build.mjs`、`src/host/index.ts`（空 apply + RPC 骨架）、`src/client/index.ts`（§1.5 的注册 + 一个占位 Body）、`locales.ts` | 1h | `npm run build` 产出 `lib/client.js`、`lib/host.js`；bundle smoke 通过（§5.4） |
| S1 | 挂载：`dev.patch.yml` 绝对路径行 + `pnpm dsh web --patch ./dev.patch.yml`；确认 client 图含本包 | 0.5h | 引导页出现"Git 工作台"卡片；快捷键 `Mod+Shift+G` 打开空 tab；无会话时命令显示 blocked 文案 |
| S2 | Host RPC：`/dsh-git` 的 `status` 与 `log`；`resolveSessionCwd`（§7）；`runGit`（§8.2）；返回结构化错误 | 2h | `curl` 不行（有 Cookie），用页面内按钮触发；日志能在面板里列出 50 条（`%h %an %ar %s`，`-z` 或 `--pretty=format` + 分隔符）；`status` 显示分支、ahead/behind、已改/未跟踪数量 |
| S3 | 渲染与刷新：列表 + 详情（点提交看 sha/author/date/subject）；`.git/HEAD` + `.git/index` + `.git/refs` 走 `workspaceFiles.changes`，250ms 防抖；手动刷新按钮 | 2h | 在终端 `git checkout -b x` / `git add .` 后 1s 内面板状态变化；切回 tab 自动刷新；无会话/非仓库/git 缺失三种空态与错误态都有文案 |
| S4 | 安装态复验：`pnpm dsh plugin --profile web add <path>` → 重启 `dsh web` → 再验一遍；再改一次 `lib/client.js` 确认热更 | 1h | 安装态与 overlay 行为一致；client 改动无需重启即生效；Host 改动重启后生效 |
| 合计 | | **6.5h**（余量用于踩坑：产物契约、Cookie/RPC、cwd） | |

**spike 明确不做**：提交/推送/签出/贮藏、提交图 lane、diff 渲染、全屏合并视图、Blame。这些在 S2/S3 的契约稳定后按产品设计的里程碑推进。

**spike 结束时要回答的 3 个问题**（决定后续架构）：

1. 独立产物在"下一次 DSH 升级"后能否无改加载？（记录版本与失败点）
2. `status` + `log` 在真实仓库（10k+ 提交）下的延迟与响应体大小？（决定分页与上限）
3. `workspaceFiles.changes` 在 `.git/*` 上的可靠性（macOS 本地）？（决定是否要 Host 侧 chokidar）

---

## 附录 A：建议目录结构

```text
dsh-idea-gittool/
├── docs/
│   ├── 产品设计-v0.1.md
│   └── research/
│       ├── dsh-integration-feasibility.md   ← 本文
│       └── reference-feature-inventory.md
└── packages/plugin/
    ├── package.json
    ├── cordis.patch.yml                     # - insert: [{ id: dsh-git, name: dsh-plugin-git-workbench }]
    ├── build.mjs
    ├── tsconfig.json
    ├── dev.patch.yml                        # 开发用 overlay（绝对路径行）
    ├── src/
    │   ├── host/
    │   │   ├── index.ts                     # apply + inject + RPC channel
    │   │   ├── rpc.ts                       # 端点分发与 payload 校验
    │   │   ├── cwd.ts                       # sessionId → cwd（§7）
    │   │   ├── git.ts                       # runGit + 只读命令（§8.2）
    │   │   └── parsers.ts                   # porcelain v2 / log -z 解析
    │   └── client/
    │       ├── index.ts                     # inject + 两段注册 + shortcut + locale
    │       ├── definition.tsx               # tab 类型 + guide
    │       ├── GitBody.tsx / GitTitle.tsx
    │       ├── pages/（Log / Commit / Branches / Stash）
    │       ├── graph/（提交图）
    │       ├── rpc.ts                       # connection.rpc.call 封装
    │       ├── locales.ts
    │       └── styles.css
    └── test/bundle.smoke.mjs
```

## 附录 B：证据索引（file:line）

| 主题 | 位置 |
|---|---|
| tab 类型两段式 / 资源 glob / 优先级 | `packages/client/ui-sidebar-right/README.md:79-88`；`src/client/tab-registry.ts:20-120` |
| 控制器 / target / 全屏 / room | `packages/client/ui-sidebar-right/src/client/service.ts:180-260,504-534,602-625,709-711` |
| tab 正文/标题 slot 契约 | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:43-80,150-200` |
| 页面地址 `sidebar://<kind>` | `packages/client/ui-sidebar-right/src/client/contract/seed.ts:26-47` |
| 最小范例（类型/装配/标题/manifest） | `packages/client/ui-sidebar-files/src/client/definition.tsx:15-39`；`src/client/index.ts:52-96`；`src/client/FilesTitle.tsx:17-24`；`package.json:14-38` |
| 外部包注册 tab 的活证据 | `packages/client/ui-sidebar-documentpreview/src/client/definition.ts:45-57` |
| `multiple` / `keepMounted` / close handler | `packages/client/ui-sidebar-terminal/src/client/index.ts:71-101` |
| 宽度常量 / 自动全屏 / 两 pane | `packages/client/ui-layout/src/client/columns.ts:11-29,52-59`；`ui-sidebar-right/src/client/shell/SidebarRight.tsx:302-311,360-361`；`README.md:121` |
| 分栏最小宽度 | `packages/client/ui-dockkit/src/engine/geometry.ts:104-140`；`constraints.ts:10-19` |
| 快捷键注册契约 / 冲突 | `packages/client/shortcuts/src/client/types.ts:20-32`；`README.md` |
| 已占用键位 `Mod+Alt+G` | `packages/client/ui-workspace/src/client/shortcuts.ts:90` |
| 样式规则 / token 所有权 | `docs/web-styling.md:7-19`；`packages/client/ui-theme/src/styles/design-platform.css:5-40,167-260,284-367` |
| diff token 用法 | `packages/client/ui-deliverables/src/client/FileDiff.module.css:24-25` |
| 产物包装契约 / 基线 externals | `packages/client/tsdown.client.ts:1-13,38-61,69,88,115-136,499-670`；`packages/client/web/src/platform.ts:8-15` |
| `dsh.client` 扫描 / `./client` 必需 / 绝对路径行 | `packages/client/modules/src/index.ts:1-10,852-868,900-950`；`src/client/manifest.ts:169-190`；`README.md:32-54` |
| 内置产物必须先构建 | `packages/client/modules/README.md:54` |
| 内置插件三处登记 | `packages/client/AGENTS.md`（New plugin package checklist） |
| 安装/层顺序/持久化/eslint | `docs/user/develop/basic/publish.md:13-16,18-40,64-66,82-92,94-108,120-134,171-185`；`docs/cli-help.md:27,67-73` |
| 重启/热更 | `packages/client/hmr/src/index.ts:3,52-121`；`packages/client/hmr/README.md:32,42,62`；`packages/boot/app-boot/README.md:63,199`；`packages/boot/plugin-manager/README.md:50,52,100` |
| 实际 profile 配置 | `~/.dsh/profiles/web/package.json:9-19`；`cordis.patch.yml:1-21`；`pnpm-workspace.yaml:1-7` |
| 外部 bundle 真实例子 | `~/.dsh/profiles/web/node_modules/@cocofhu/skillhub/{package.json,cordis.patch.yml,lib/client.js}` |
| 通用 RPC（Host/Client/鉴权/取消/附件） | `packages/client/connection/src/rpc.ts:30-46,79-95,136-145,295-305`；`src/rpc-host.ts:105-112,253-347,395-400`；`src/client/rpc.ts:34-80`；`README.md:32-34` |
| Typert 生成器仓库绑定 | `packages/typert/generator/src/workspace.ts:186-194`；`packages/client/tsdown.client.ts:3-4,23`；`packages/api/gateway/src/client/index.ts:110,196-222` |
| Session cwd 解析 | `packages/core/session/src/index.ts:1353-1356`；`src/types.ts:95-106`；`packages/session/working-directory/src/index.ts:76,122-127`；`packages/session/session-persistence/src/index.ts:50-61`；`packages/api/workspace-files/src/index.ts:203-221`；`packages/sandbox/sandbox-policy/src/index.ts:122-124,164-171` |
| Git 执行先例 | `packages/deliverables/workspace-changes/src/git.ts:8-11,18-24,55-80,127-141`；`packages/experimental/worktree/src/process.ts:18-24,38-83` |
| 环境清洗 | `packages/subprocess/subprocess/src/index.ts:47,66-80`；`packages/subprocess/subprocess/README.md`（"Environment every child starts from"） |
| 沙箱 | `packages/sandbox/sandbox-local/README.md`；`packages/sandbox/sandbox-policy/src/index.ts:122-124,164-171` |
| 变更监听 | `packages/fs/fs/src/index.ts:92-104`；`packages/fs/fs-local/src/index.ts:69-89`；`packages/api/workspace-files/src/changes.ts:17-105`；`packages/client/ui-sidebar-files/src/client/face.ts:30-70` |
| 可复用 UI | `packages/client/ui-primitives/README.md:39,49,68,76-77,108-110,127`；`src/DiffBlock.tsx:18-56`；`src/icons/index.tsx:159-165`；`util/workspace-path/src/index.ts:92-99` |


---

## 13. M0 spike 实测结论（2026-10-25，DSH 0.2.1-rc.2）

本节只记录**本仓库实测过**的行为；未标 ✅ 的结论仍以源码阅读为准。

| 结论 | 状态 | 证据 |
|---|---|---|
| 独立双面 bundle 用 `--patch` 绝对路径行挂载，client 产物被服务并进入模块图（向上找到 package.json） | ✅ | `dev.patch.yml` + `pnpm dsh web --patch ...`，页面模块图含 `dsh-idea-gittool/client.js` |
| 产物包装契约（`__ModuleLoader__.load` + factory + `apply`/`inject`）与 baseline externals | ✅ | `test/bundle.smoke.mjs` |
| 右侧栏 tab 两段式注册、引导页卡片（order 40）、`Mod+Shift+G` 快捷键、无会话 blocked 文案 | ✅ | `.evidence/m0/t2-guide-card.png`、`t2-git-tab.png` |
| 文档预览 header 子 slot `sidebar.right.tab.document.actions`（owner `{ absolutePath }`）可注册并渲染 | ✅ | `.evidence/m0/t6-document-actions.png` |
| Host 用 `ctx.subprocess` 执行 git、`ctx.sandbox`/`sandboxPolicy` 判写边界、fail closed | ✅ | `test/host/{git-executor,status,log,sandbox-gate}.test.ts` |
| **`ctx.connection.rpc.handle('/dsh-git', ...)` 从外部插件不可用** | ❌ | 激活即抛 `cannot get property "webServer" without inject`（`rpc-host.ts:274`，owner 是 app root fiber） |
| 替代路径：`ctx.inject(['webServer'])` + `webServer.register({kind:'prefix'})` + `connection.requestRejection(req)` 鉴权 + 自定义 JSON 信封 | ✅ | `src/host/http.ts`；`ui-open-in-app` 同款先例；无 Cookie 401、未知端点 404 |
| 浏览器端同源 `fetch` + Cookie 即可调通；`/dsh-git/bootstrap` 返回结构化数据 | ✅ | 真实会话返回 repoRoot/branch/17 改动/7 提交 |
| 未知 sessionId 不能退化为 `sandboxPolicy.workspaceRoot`（那是 dsh 进程 cwd）；持久化无记录即 `git/no-session` | ✅ | `src/host/repo-resolver.ts`；curl 实测 |
| 文档预览头部历史/Diff 与 Blame 页属产品后续里程碑（B2） | ⏳ | M0 只做空页与 disabled 占位 |
| 重建 `lib/client.js` 触发 HMR：按内容 rev 判断，只 `touch` 不触发；内容变化约 0.5s 内热替换，页面不整页刷新，factory 会**再次执行** | ✅ 2026-10-25 | A1 T9 走查（3081）：探针属性与 CSS 描边热生效/热撤销；`build.mjs` 因此改为复用并替换 `<style data-plugin-css>`，smoke 覆盖 |
| 终端改动后刷新：新建标签 1.3s、新建未跟踪文件 1.2s 反映到 Git tab（watch 递增 version + 1s TTL/3s 轮询） | ✅ 2026-10-25 | A1 T9 走查，见 [A1 计划](../plans/completed/a1-只读日志.md) 验证记录 |
| **web 组合没有 `fs` 服务**（M0 结论） | ❌ 2026-10-25 | `pnpm dsh --profile web --dump-config` 第 403 行有 `fs-sandbox`（base bundle 提供 `fs`）；M0 的 watch 失败实为适配器传错参数（下一行） |
| `ctx.fs.watch(target, changed, signal)` 的 target 是 `fs.resolve(path)` 产出的 `FsTarget`，不接受路径字符串；`changed` 可能带 Error；目录只监听直接子项 | ✅ 2026-10-25 | `packages/fs/fs/src/index.ts:100`、`types.ts:60`；`src/host/watch.ts` `fsWatchFromService` + 实测 version 0→1 |
| 插件已经 `link:` 安装进 web profile 时，再加 `--patch dev.patch.yml` 启动会报 `resolves from multiple active Loader sources`；此时直接不带 patch 启动即可（安装态就指向本仓库 `lib/`） | ✅ 2026-10-25 | A1 走查启动 3081 |
| Host 半边可以用 `new Worker(source, { eval: true })`（`node:worker_threads`）隔离不可信计算；超时后 `terminate()` 能打断死循环，主线程不受影响 | ✅ 2026-10-25 | 评审 I2：3081 上病态正则搜索返回 `git/timeout`，期间其它请求 3ms 返回 |
| 浏览器面板在会话窗口不可见时是后台页：`requestAnimationFrame` 不运行，无法测真实 fps | ✅ 2026-10-25 | A1 AC3 测量记录 |

Git 与构建行为（A1 实测，git 2.50.1）：

| 结论 | 状态 | 证据 |
|---|---|---|
| 贮藏数用 `git stash list --format=%H` 数行：没有贮藏时退出码 0、输出为空。**不要**用 `rev-list --walk-reflogs --count refs/stash`——无贮藏时退出 128，3s 轮询会把控制台刷满红色失败 | ✅ 2026-10-25 | `src/host/git/status.ts` `readStashCount` + `test/host/status.test.ts`（A1 验收演示发现） |
| bisect 进行中以 `.git/BISECT_START` 判定（`bisect reset` 删除） | ✅ 2026-10-25 | 同上 |
| `git --grep` 与 `--author` 是 AND 关系，表达不了「消息或作者或哈希」，搜索改在 Host 内匹配 | ✅ 2026-10-25 | `src/host/git/log.ts` + `test/host/log.test.ts` |
| 凭据脱敏不要用一条全局正则：`/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/` 在长串字母上是平方复杂度（64KB 约 2.1s、2MB 数十分钟），单纯限长后 2MB 仍约 190ms。改为 `indexOf('://')` 定位、只在每处附近的小窗口里检查协议名（≤32）与 userinfo（≤512），2MB 降到毫秒级；超过 512 字符的 userinfo 不脱敏 | ✅ 2026-10-25 | A1 合并前关口：合并树上 `make check` 超时暴露；`src/host/console.ts`、`src/client/console/console-store.ts` 及对应 2MB 性能测试 |
| esbuild local-css 会给 `@container` 名加文件前缀，跨文件容器查询需用匿名 `container-type` | ✅ 2026-10-25 | A1 T4 |
| 单测里 `@deepseek-ai/dsh-client-ui-primitives` 经 `link:` 解析到 DSH 仓库自带的 React 副本，直接调用其 hook 报 invalid hook call；运行时 React 是 external，不受影响 | ✅ 2026-10-25 | A1 T6（DiffViewer 留 `useHighlighter` 注入点） |

写执行与沙箱（A2 T1 spike，2026-10-26，git 2.50.1 / macOS Seatbelt）：

方法：按 `dsh-sandbox-local` 的 `seatbeltProfileArgs` + `dsh-sandbox` 的 `writableRoots` 原样拼出 `workspace-write` 的 SBPL（allow default、deny file-write*、放行 `/dev/null`、workspaceRoot、`/tmp`、`os.tmpdir()`），用 `sandbox-exec -p <profile> -- git ...` 在临时仓库里执行。脚本与输出在 `.evidence/a2/spike.log`。这是对 confine 产物的等价复现，**不是**经 3081 Host 的端到端调用；端到端复验放在 A2 T8。

| 结论 | 状态 | 证据 |
|---|---|---|
| `.git` 在 workspaceRoot 内时，confine 下 `commit --only -- <path>` 成功 | ✅ 2026-10-26 | spike 1a |
| workspaceRoot 是仓库子目录（`.git` 在边界外）时被拒：`fatal: Unable to create '<repo>/.git/index.lock': Operation not permitted`，退出 128，工作区与索引不变。写门禁的「仓库根必须在工作区内」判定与此一致 | ✅ 2026-10-26 | spike 1b/1c |
| **Seatbelt profile 不限制网络**：confine 下 HTTPS `ls-remote` 与 SSH（`BatchMode=yes`，读 `~/.ssh` 私钥与 `known_hosts`）都成功 | ✅ 2026-10-26 | spike 2c/2d；`dsh-sandbox` 源码注释「Network and process visibility are outside this vocabulary」 |
| 推送到**工作区外的本地 bare 仓库**会失败，表现为 porcelain `!` 行 `[remote rejected] (unpacker error)`，stderr `unable to create temporary object directory`。这是沙箱拒绝，不是非快进；分类时必须先于 `git/rejected` 识别为 `git/sandbox-denied`。bare 仓库在工作区内时推送成功 | ✅ 2026-10-26 | spike 2a/2b |
| macOS 自带 git 的 `credential.helper=osxkeychain` 配在 **Xcode 的系统 gitconfig**（`/Applications/Xcode.app/.../git-core/gitconfig`）；读命令用的 `GIT_CONFIG_NOSYSTEM=1` 会让它不可见 | ✅ 2026-10-26 | spike 3a/3b |
| **osxkeychain 在 `workspace-write` confine 下不可用**：`git credential-osxkeychain get` 返回 `failed to get: -67674`（Module Directory Service error）。根因是 Security 框架要写 `getconf DARWIN_USER_CACHE_DIR`（`/private/var/folders/<..>/C`），而 profile 只放行 `os.tmpdir()`（同目录下的 `T`）；只多放行 `C` 即恢复。结果：依赖钥匙串的 HTTPS 推送在 confine 下得到 `could not read Username ...: terminal prompts disabled` | ✅ 2026-10-26 | spike 3c + 二分放行目录 |
| **经 3081 Host 端到端复验**：`workspace-write` 会话里提交、推送到工作区内 bare 远程成功；推送到工作区外 bare 远程得到 `git/sandbox-denied`（`remote unpack failed`），与上面的等价复现一致 | ✅ 2026-10-26 | A2 计划「验证记录」 |
| 同理，hook 或 git 子进程写 `~/.cache`、`~/Library/Caches` 等工作区外目录（pre-commit 框架、prettier 缓存）在 `workspace-write` confine 下会失败；表现为 hook 自身报错 | ⚠️ 2026-10-26 推断，未实测 | A2 代码评审 |
| 无凭据的 HTTPS 认证失败在 `GIT_TERMINAL_PROMPT=0` 下立即返回 `fatal: could not read Username for '<url>': terminal prompts disabled`（退出 128），不会挂起 | ✅ 2026-10-26 | spike 3d |

stdin 与长路径（A3 T1 spike，2026-10-26，git 2.50.1 / macOS Seatbelt，ARG_MAX=1048576）：

方法同上：按 `seatbeltProfileArgs` + `writableRoots` 拼出 `workspace-write` 的 SBPL，用 Node `spawn('/usr/bin/sandbox-exec', ['-p', profile, '--', 'git', ...], { stdio: ['pipe', ...] })` 写入 stdin 后 `end()`（与 DSH subprocess 的 `'pipe'` 模式同形）。脚本 `.evidence/a3/spike.mjs`，输出 `.evidence/a3/spike.log`。仍是等价复现，不是经 3081 Host 的端到端调用。

| 结论 | 状态 | 证据 |
|---|---|---|
| DSH `ctx.subprocess.spawn` 的 `stdio.stdin` 支持 `'ignore' \| 'pipe' \| { data: string }`：`'pipe'` 时 `handle.stdin` 是 `Writable`，调用方 `end(data)`；`{ data }` 由 seam 写完即关。本插件用 `'pipe'` + `end()`（`GitRunOptions.stdin`，可传 `Uint8Array`） | ✅ 2026-10-26 源码 | `packages/subprocess/subprocess/src/types.ts:36,171`；`subprocess-local/src/spawn.ts:382-386,432` |
| **confine 下 stdin 原样到达 git**：`add -N` 与 `commit --only -m … --pathspec-from-file=- --pathspec-file-nul` 处理 2003 个路径（2000 个约 600 字节 + `-dash.txt`、`中文 空格.txt`、`star*.txt`），stdin 共 1,202,038 字节，退出 0，提交恰好含 2003 个文件、工作区干净 | ✅ 2026-10-26 | spike 1、2 |
| 同样的 2003 个路径放进 argv 时 spawn 直接失败 `E2BIG`（总长 >1MiB 超过 ARG_MAX）——这就是 TD-9 的真实失败形态 | ✅ 2026-10-26 | spike 0b |
| `restore --worktree`、`reset -q`、`stash push` 也接受 `--pathspec-from-file=- --pathspec-file-nul`，confine 下成功 | ✅ 2026-10-26 | spike 3、4、8 |
| `git clean`、`git status`、`git diff` **不支持** `--pathspec-from-file`（退出 129 `unknown option`）；改为每批 ≤200 个路径的 argv：200 个约 600 字节路径一次 `clean -f -q --` 在 confine 下成功（200 × PATH_MAX 4096 也低于 1MiB） | ✅ 2026-10-26 | spike 5、6、9 |
| stdin 不影响沙箱拒绝的分类：workspaceRoot 为仓库子目录时同样是 `Unable to create '.../.git/index.lock': Operation not permitted`（退出 128） | ✅ 2026-10-26 | spike 7 |

贮藏命令（A3 T5，2026-10-26，git 2.50.1 本机实测，写环境 `GIT_LITERAL_PATHSPECS=1`；回归测试 `test/host/stash.test.ts`）：

| 结论 | 状态 | 证据 |
|---|---|---|
| **`stash push --keep-index` 在 `GIT_LITERAL_PATHSPECS=1` 下失败**：`pathspec ':/' did not match any file(s)`（退出 1），而且失败发生在贮藏**之后**——改动已进贮藏、工作区已清空、暂存区没被放回。全局选项 `git --no-literal-pathspecs stash push …` 可规避（创建贮藏不传路径，关掉字面模式无副作用） | ✅ 2026-10-26 | 本机复现；`stashCreate` 测试 |
| `stash apply [--index] <sha>` 直接接受贮藏提交 sha；`pop`/`drop` 只接受 reflog 选择子（`stash@{n}`）。`drop` 在 stdout 打印 `Dropped stash@{n} (<完整 sha>)`，可据此核对删掉的是哪条 | ✅ 2026-10-26 | 本机实测 |
| `apply --index` 暂存区补丁打不上时报 `conflicts in index. Try without --index.`（退出 1，工作区不动）；本地改动会被覆盖时报 `would be overwritten by merge`；`-u` 贮藏的未跟踪文件已存在时报 `<path> already exists, no checkout` + `could not restore untracked files from stash`；三者都不改工作区、不删贮藏 | ✅ 2026-10-26 | 本机实测 |
| `stash store` 同一个 sha 重复存入时 reflog 不新增条目；`diff-tree --stdin -r --name-only -z` 读 `<stash> <第一父>` 行，只为有改动的贮藏输出 `<sha>\0<path>\0…` | ✅ 2026-10-26 | 本机实测 |

依赖与类型：DSH 类型用 `link:` 指向本机 checkout；`webServer` 服务的类型包是 **`@deepseek-ai/dsh-host-webserver`**（不是 `dsh-webserver`）；`ctx.connection` 的 Host 半边类型来自 `@deepseek-ai/dsh-client-connection`。

## 14. B1 三栏合并 spike（2026-10-26，DSH checkout `687f282e86`，源码查证）

本节是 B1 T1 的 DSH 侧结论；git 行为（resolve-undo、`checkout -m`、经索引写回）见 [git-behavior.md](git-behavior.md)。浏览器实测按控制者裁定推迟到 B1 T6，标「待 T6 实测」的条目届时更新。

CodeMirror 6（假设 1）：

| 结论 | 状态 | 证据 |
|---|---|---|
| 引入 `@codemirror/state@6.7.6`、`@codemirror/view@6.43.15`、`@codemirror/commands@6.11.1`（devDependencies，esbuild 内联进 `lib/client.js`）。`commands` 会带上 `@codemirror/language` 与 `@lezer/{common,highlight,lr}`，共新增 12 个包 | ✅ 2026-10-26 | `pnpm add -D`；`pnpm-lock.yaml` |
| DSH web 主页面**没有 Content-Security-Policy**：index 由 `frontend-static` 以 `res.writeHead(200, { 'content-type': type })` 返回，不带 CSP 头；`apps/web/index.html` 没有 CSP `<meta>`；注入表本身就渲染内联 `<script>`/`<style>`。仓库里的 CSP 只出现在别的文档上（媒体引用 `sandbox; default-src 'none'`、文档预览 basic-html 的 iframe、桌面端独立页面、账号登录页） | ✅ 2026-10-26 源码 | `packages/host/frontend-static/src/index.ts:104,118`；`apps/web/index.html:4-13`；`packages/host/webserver/src/injections.ts:58-65`；`packages/api/session-controller/src/media-references.ts:19`；`packages/client/ui-sidebar-documentpreview/src/client/html/basic-document.ts:18-19` |
| 因此 `style-mod` 运行时插入的 `<style>`（`StyleSet` 对 document 根走 `createElement("style")` 分支）不受阻；本插件自己的 `<style data-plugin-css>` 也是同一种运行时注入，A1 起在 3081 上一直生效（§13 HMR 行） | ✅ 源码 / ⏳ 待 T6 实测 | `node_modules/style-mod/src/style-mod.js:92-101`；`build.mjs` banner |
| HMR 重跑 factory 时 bundle 内联的是一份**新的** style-mod：它的样式集键是 `Symbol("styleSet")`（非全局），新实例第一次挂载会再插一个 `<style>`，旧的留在 `<head>`（只在开发热更时累积，内容是同一主题规则，不影响显示）；类名计数器键是 `Symbol.for(...)`（全局），新旧实例不会撞名。EditorView 的销毁由 React 卸载时 `view.destroy()` 负责，T5/T6 组件测试覆盖「不重复挂载」 | ✅ 源码 / ⏳ 待 T6 实测 | `style-mod.js:2-3,60-61,82-84` |
| 单测环境没有 DOM（vitest 未配置 jsdom/happy-dom，组件测试都用 `renderToStaticMarkup`），T1 不写挂载测试；引入 DOM 环境属于计划外依赖，T5/T6 需要时另议 | ✅ 2026-10-26 | `package.json` 无 jsdom/happy-dom，`test/client/*.test.tsx` |
| 体积：T1 只登记依赖、尚未 import，`lib/client.js` 726,695 → 726,900 字节（+205，gzip 143,022 → 143,059）。按计划会用到的 API（`EditorState/StateField/StateEffect/RangeSetBuilder`、`EditorView/Decoration/keymap/lineNumbers/ViewPlugin/WidgetType`、`history/defaultKeymap/historyKeymap/undo/redo`）单独打包、与 client 同配置（不压缩）为 **594,973 字节（gzip 147,738）**，压缩后 277,957（gzip 90,539）；大头是 view 321 KB、state 114 KB、lezer/common 49 KB、commands 48 KB、language 34 KB | ✅ 2026-10-26 | `.evidence/b1/probe/build.mjs`；真实增量在 T6 引入后复测 |

宿主全屏（假设 4）：

| 结论 | 状态 | 证据 |
|---|---|---|
| `ctx.sidebarRight` 服务没有公开的「当前是否全屏」读取：公开面只有 `toggleFullscreen(target)`；判定用的 `mountedSurface()` 是 private，`autoFullscreen` 在 `SidebarRightHost` 上、不在服务上 | ✅ 2026-10-26 源码 | `ui-sidebar-right/src/client/service.ts:128-134,618-625,705` |
| **但 tab 正文有公开的读取**：框架注入的 `useTabInfo()` 返回 `sidebar: { expanded, fullscreen }`，其中 `fullscreen = autoFullscreen \|\| layout.mode === 'fullscreen'`（含视口 <768px 的自动全屏），README 把它列为 tab 正文的公开信息。本插件 `GitBody` 已经在用 `useTabInfo()` | ✅ 2026-10-26 源码 / ⏳ 待 T6 实测 | `ui-sidebar-right/src/client/tab-info.ts:15,42`；`shell/SidebarRight.tsx:200-210,360-361`；`ui-sidebar-right/README.md:84`；`src/client/GitBody.tsx:39` |
| 备选判定：面板根元素带 `data-sidebar-right-panel="fullscreen" \| "push"`，全屏时 `style.width = 100vw`。原计划的「面板根元素宽度 ≥ `window.innerWidth - 1`」与此等价但更脆（Windows 标题栏模式下全屏面板会让出侧栏宽度 `--dsh-windows-sidebar-width`，宽度判定会误判为非全屏） | ✅ 源码 / ⏳ 待 T6 实测 | `shell/SidebarRight.tsx:310-313`；`README.md:46` |
| 建议 T6 的判定顺序：`useTabInfo().sidebar.fullscreen` 为主；实测若在 `toggleFullscreen` 之后不及时更新，再退到 DOM 属性，最后才用宽度启发式。AC10 的「视口 <768px 不调用」用 `window.innerWidth < 768` 判断（与 `SidebarRight.tsx:360` 同阈值；那里的 `viewportWidth` 是 frame 宽度，T6 实测两者是否一致） | ⏳ 待 T6 实测 | — |
| `toggleFullscreen(target)` 需要一个当前 dock pane 的 target：`focusedTarget(element)` / `commandTarget(element)` 可以传入本插件的根元素；浮动 pane、过期 target、面板未展开时直接返回不动作；自动全屏时调用会**收起面板**（§2.3 已记）。全屏与普通模式共用同一棵内容树，切换不重挂载 tab（README:39） | ✅ 2026-10-26 源码 | `service.ts:504-534,618-625`；`ui-sidebar-right/README.md:39,55` |

## 15. B2 历史与 Blame spike（2026-10-27，DSH checkout `687f282e86`，源码查证）

本节是 B2 T1 的两问；浏览器实测在 B2 自验证（L4）时补，标「待 L4」的条目届时更新。

| 结论 | 状态 | 证据 |
|---|---|---|
| **(a) 已打开的 `git.blame` 页再 `openTab('git.blame', { params })` 会收到新参数**：`openTab` → `placeTab` → `place`，`openContent` 完成后对落定的 tab 调 `tabDomain.navigate(sessionId, tabId, { address, params })`；已有记录走 `existing.navigation.set({ ...target, revision: revision + 1 })`。正文经 `useTabInfo().tab.navigation` 读到新 `params` 与递增的 `revision`。所以换文件不需要 `replaceTab` 或 `openResource`，正文跟随 `navigation` 变化重新加载即可 | ✅ 源码 / ⏳ 待 L4 | `ui-sidebar-right/src/client/service.ts:398-440`；`tab-domain.ts:136-142`；`README.md:93` |
| 去重范围是**目标 pane 内**（「ordinary page tabs always deduplicate within the target pane」）：`git.blame` 页在另一个 pane 时，会在当前活动 docked pane 再开一个。可接受（与 Git tab 同一规则） | ✅ 源码 | `README.md:93`；`service.ts:443-447`（`findPaneContentTab`） |
| **(b) 文档头部 `openTab('git')`**：未打开时在活动 docked pane 新开并展开侧栏；已打开（同 pane）时聚焦已有 tab；没有会话在屏时 `openTab` 抛错（M0 已处理为头部提示 `document.noSession`）。`params` 同样经 `navigate` 送达，但 B2 不用它传意图：`navigation` 是 tab 记录上的「最近一次导航」，刷新恢复后是否重放未查证，用它传「打开某覆盖层」这类一次性动作有重放风险；意图改走同 bundle 内按会话的队列（计划 T4 `workbench-intents.ts`） | ✅ 源码 / ⏳ 待 L4 | `service.ts:332-357,398-440`；`src/client/register-document-actions.ts` |
