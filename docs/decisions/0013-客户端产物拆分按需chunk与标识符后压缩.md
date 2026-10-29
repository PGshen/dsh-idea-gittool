# 0013：客户端产物拆分按需 chunk 与标识符后压缩

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-28 |
| 相关 | [b4c 计划](../plans/completed/b4c-性能.md) T3；[设计 v0.2](../design/2026-10-25-产品设计-v0.2.md) §16.8 包体积、§16.10「CodeMirror 按需 chunk」；[ADR 0005](0005-自建CSS-Modules管线.md)；[references §17](../references/dsh-integration-feasibility.md) |

## 背景

B1 把 CodeMirror 内联进 `lib/client.js` 后，产物 gzip 约 302–305 KB，超出设计预算「≤ 250 KB gzip（不含按需加载的 CodeMirror）」。构建只压缩空白与语法，不压缩标识符：在 esbuild 构建里开 `minifyIdentifiers` 会把 local-css 类名缩成可能与宿主冲突的短名（ADR 0005）。

## 决定

1. **标识符后压缩**：`build.mjs` 在 CSS 已生成、类名已变成字符串字面量之后，把模块体包进 IIFE，再用 esbuild `transform` 压缩标识符；`__ModuleLoader__` banner/footer 不经过压缩，原样拼回（首行契约逐字不变）。IIFE 带来 `"use strict"` 指令生效（源码本就是 ES 模块，按严格模式编写）。
2. **合并窗口的 CodeMirror 拆成按需 chunk** `lib/client.merge.js`（入口 `src/client/pages/merge-editor.ts`），按 DSH client-modules 的包内 chunk 契约注册；`merge-editor-loader.ts` 在产物里走 `require.async('./client.merge.js')`，在源码/测试里走动态 `import()`（由 define `__DSH_GIT_MERGE_CHUNK__` 区分，主包构建把源码分支的导入标为外部，确保 CodeMirror 不回到主包）。chunk 不允许带 CSS。
3. `client.js` 在 banner 之后记录 chunk 哈希。DSH 的包版本按 `client.js` 的 mtime/ctime/size 计算（不按内容），chunk URL 也带这个版本；哈希行保证「只改了 chunk」时 `client.js` 一定被重写，版本随之前进；`pnpm smoke` 校验主包体积 ≤ 250 KB gzip、chunk 注册形态、哈希一致、主包不含 CodeMirror。

结果：主包 gzip 175 KB（首发目标 ≤ 200 KB），chunk gzip 93 KB。

## 考虑过的其他方案

- **只做标识符后压缩**：gzip 272 KB，仍超预算。
- **按语言拆分文案**：中英文案约 147 KB（未压缩），但切换语言需要异步加载，牵动所有组件的取词时机，收益不如拆 CodeMirror。
- **把整个合并窗口（含组件与样式）作为 chunk**：chunk 要自己注入样式、与主包共享 store/文案，复杂度高；只拆不含样式的编辑器模块就足够。

## 影响

- 合并窗口首次打开多一次本地 HTTP 请求（chunk 93 KB gzip）；加载失败时窗口显示「无法加载合并编辑器」与「重试」，不影响其他页面。
- 以后新增 CodeMirror 的使用点，必须经 `loadMergeEditor()` 取模块，不能直接 `import '@codemirror/*'`（smoke 会因主包出现 `cm-editor` 而失败）。
- 发布包（`files: ["lib", …]`）自动包含 chunk；安装/升级验证（B4d）要确认 chunk 能被宿主服务。
- 开发期 `pnpm dev` 下改 chunk 源码会同时重建主包（哈希行变化），HMR 照常。
