# happy-dom：DOM 测试环境的已验证行为

B4b T2 引入（TD-18），版本 `happy-dom@21.0.4`，vitest `5.0.5`，React `18.3.1`。只有 `*.dom.test.tsx` 在文件首行写 `// @vitest-environment happy-dom` 时使用；辅助函数在 `test/client/dom.tsx`。

| 行为 | 状态 | 说明 |
|---|---|---|
| `react-dom/client` 的 `createRoot` + React 18 `act` 可用 | ✅ 已验证（2026-10-28 实测） | 需 `globalThis.IS_REACT_ACT_ENVIRONMENT = true`，否则 act 告警 |
| `element.focus()` 改变 `document.activeElement`；`keydown` 冒泡到 React 的 `onKeyDown` | ✅ 已验证（2026-10-28） | `test/client/pages/repo-bar-menu.dom.test.tsx`、`log-keyboard.dom.test.tsx` |
| 没有布局：`clientWidth/clientHeight/offsetHeight` 都是 0 | ✅ 已验证（2026-10-28） | `@tanstack/react-virtual` 用 `scrollElement.clientHeight` 算可视区（`virtual-core` `getRect`），为 0 时一行都不渲染；`initialRect` 只在首次测量前生效。测试里用 `stubLayout({ width, height })` 桩住原型上的 `clientWidth/clientHeight` |
| 默认文档无 doctype（quirks mode） | ✅ 已验证（2026-10-28） | ui-primitives 引入的 KaTeX 会打印 quirks mode 告警；`dom.tsx` 在加载时插入 `<!doctype html>` |
| `:focus-visible` 选择器匹配 | ⚠️ 待验证 | B4b T3 验证 |

## 安装注意（pnpm 11）

`pnpm add -D happy-dom` 在 pnpm 11.28 下因 `esbuild` 构建脚本未批准（`ERR_PNPM_IGNORED_BUILDS`）中途退出，且**摘掉了 `node_modules/@deepseek-ai/*` 的 link 依赖**，之后 `pnpm install` 一直报「Already up to date」。恢复办法：删掉 `node_modules/.pnpm-workspace-state-v1.json`，再 `pnpm install --prefer-offline --config.strict-dep-builds=false`（2026-10-28 实测；`--force` 会重新下载全部平台的可选二进制，很慢，不要用）。
