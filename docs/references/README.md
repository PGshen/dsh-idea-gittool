# references：外部依赖的已验证知识

SDK 和组件库更新很快，AI 的训练知识可能已经过时。本目录记录**查证过或实测过**的行为，写代码时以这里的内容为准。

## 写法约定

每条事实都要标注状态和来源：

| 标记 | 含义 |
|---|---|
| ✅ 已验证 | 查阅过官方文档或实测过；注明日期和来源 |
| ⚠️ 待验证 | 来自推断或旧代码，还没在本项目中确认；注明计划在哪里验证 |
| ❌ 已否定 | 验证后发现不成立；保留记录，免得以后再次误用 |

发现记录已经过期时，直接更新并改日期，不要追加一条相互矛盾的新记录。
技术验证（spike）的结论也写在这里，一个库或一次 spike 一个文件。

## 索引

| 文件 | 内容 | 状态 |
|---|---|---|
| [DSH 集成可行性调研](dsh-integration-feasibility.md) | 独立双面 bundle、`__ModuleLoader__` 产物、通用 RPC、`ctx.subprocess` + 沙箱、安装/热更、文档预览扩展点 | ✅ 已按 DSH `0.2.1-rc.2` 源码核实，并在 §13 记录 M0/A1 实测（构建、挂载、RPC、watch、HMR，2026-10-25） |
| [Git 行为实测](git-behavior.md) | resolve-undo、`checkout -m` 还原冲突解决（合并/变基/拣选、删除类冲突）、经索引写回（`hash-object --path` → `update-index --cacheinfo` → `checkout-index -f`，autocrlf、执行位、confine 拒绝） | ✅ git 2.50.1 本机 + Seatbelt 等价复现（B1 T1，2026-10-26） |
| [happy-dom](happy-dom.md) | DOM 测试环境：act/焦点/键盘事件、无布局与虚拟列表、pnpm 11 安装时摘掉 link 依赖的恢复办法 | ✅ happy-dom 21.0.4 实测（B4b T2，2026-10-28） |
| [参考项目功能清单](reference-feature-inventory.md) | IdeaGitTool v0.4.2 的功能、UI 结构、可移植纯逻辑层与 VS Code 强绑定部分 | ✅ 已按参考仓库 `v0.4.2` 源码核实（2026-10-25）；移植可行性待 M0 后逐项确认 |
| [assets/reference-ideagittool-log.jpg](assets/reference-ideagittool-log.jpg) | 参考项目日志页截图（产品设计 §8.1 引用） | 截图证据，无版本标记 |

## 本项目待验证清单

M0/A1 已逐条确认，结论与证据见 [可行性调研 §13](dsh-integration-feasibility.md)（2026-10-25）：

- [x] `build.mjs` 产物能被 `__ModuleLoader__` 加载（包装三行契约）
- [x] `dev.patch.yml` 绝对路径行能被 client-modules 扫描到（已安装时不要再加 patch）
- [x] `ctx.connection.rpc.handle` 从外部插件不可用（❌），改用 webServer 前缀路由
- [x] `ctx.subprocess` + `ctx.sandbox` 的组合行为与 fail closed 门禁
- [x] `.git` watch：web 组合有 `fs`（fs-sandbox），`fs.watch` 需先 `resolve()`；目录只看直接子项
- [x] `sidebar.right.tab.document.actions` slot 与 `openTab('git.blame')` 可用
- [x] client 产物按内容 rev 热更、factory 重跑；Host 改动需重启 `dsh web`

A2 新增（T1 spike 已用等价 Seatbelt profile 复现，见 §13「写执行与沙箱」）：

- [x] 经 3081 Host 的 `sandbox.confine` 端到端执行 commit/push（2026-10-26，见 A2 计划验证记录）

B1 新增（T1 源码查证，浏览器实测在 B1 T6，见 [可行性调研 §14](dsh-integration-feasibility.md)）：

- [x] DSH web 主页面无 CSP，CodeMirror（style-mod）运行时 `<style>` 不受阻（源码）
- [ ] CodeMirror 6 在右侧栏 tab 内挂载、HMR 后不重复挂载（T6 实机）
- [ ] `useTabInfo().sidebar.fullscreen` 能及时反映 `toggleFullscreen` 结果（T6 实机）

升级 DSH 后重跑 §13、§14 清单；升级 git 后重跑 `.evidence/b1/spike.mjs`（[git-behavior.md](git-behavior.md)）。
