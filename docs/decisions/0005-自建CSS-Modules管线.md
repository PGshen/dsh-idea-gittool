# ADR 0005：自建 CSS Modules 管线（esbuild local-css + 运行时注入）

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-25 |
| 相关 | [A1 计划 T2](../plans/active/a1-只读日志.md)、[技术债 TD-3](../quality/tech-debt.md)、[可行性调研 §4.4/§5.4](../references/dsh-integration-feasibility.md) |

## 背景

M0 为了尽快验证链路，客户端样式全部用内联 `style` 对象（语义 token 正确，但没有类名复用、没有 CSS Modules 作用域）。DSH 的 `docs/web-styling.md` 要求组件样式放在组件旁的 CSS Modules、只用 `--dsw-*` 语义 token。A1 的日志表格、diff、分支面板、控制台会显著增加样式量，内联样式不可维护（TD-3）。

官方 tsdown preset 无法在 DSH 仓库外使用（[ADR 0003](0003-独立双面-bundle-交付形态.md)），所以必须自建管线；构建产物仍必须是单个 `lib/client.js`（`__ModuleLoader__` 契约）。

## 决定

- `build.mjs` 用 esbuild 的 `local-css` 处理 `*.module.css`：class 名由 esbuild 生成带哈希的稳定映射，组件通过 `import styles from './X.module.css'` 拿到 class map。
- 构建期收集所有 CSS 文本，作为一段字符串内联进 bundle；`apply` 时只注入一次 `<style data-plugin-css="dsh-idea-gittool">`（幂等、重复加载复用同一个节点）。这样产物仍是单个 `lib/client.js`，不依赖 DSH 的静态目录。
- 样式规则沿用 DSH：只用 `--dsw-alias-*` / `--dsw-static-*`，不写字面色、不写主题选择器；组件级样式只放组件旁的 `.module.css`。
- `test/bundle.smoke.mjs` 增加断言：client.js 内含 `data-plugin-css` 注入逻辑与至少一条 class 映射；CSS 文本不出现字面色值（正则粗检 `#[0-9a-f]{3,8}` / `rgb(` / `hsl(`）。

## 考虑过的其他方案

- **保留内联样式**：不选。A1 的样式量会让组件不可维护，且无法复用 hover/焦点/滚动条等状态。
- **全局前缀类名 + 手写 CSS**：不选。没有作用域隔离，类名冲突只能靠纪律；与 DSH 的 CSS Modules 规范不一致。
- **CSS-in-JS（emotion 等）**：不选。会引入新运行时依赖与体积开销，且与基线 externals 的零依赖目标冲突。
- **官方 tsdown preset**：不可行（仓库绑定，见调研 §5.3）。
- **把 CSS 作为独立文件随包发布**：不选。外部 bundle 的 `lib/` 不作为 HTTP 静态目录暴露，只能内联。

## 影响

- `build.mjs` 增加一个约 60 行的样式插件与 smoke 断言；构建时间略增，但产物仍单文件。
- 组件作者必须遵循 `.module.css` 与 token 规则；`src/client/styles/` 只放全局基础（字体、滚动条）样式。
- 内联样式迁移到 CSS Modules 后，TD-3 关闭；后续若 DSH 提供官方外部构建工具链，再评估切回。
- 注入的 style 节点在插件卸载后保留（无害）；插件重新加载会复用同一节点，避免重复样式。
