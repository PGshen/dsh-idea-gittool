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
| [DSH 集成可行性调研](dsh-integration-feasibility.md) | 独立双面 bundle、`__ModuleLoader__` 产物、通用 RPC、`ctx.subprocess` + 沙箱、安装/热更、文档预览扩展点 | ✅ 已按 DSH `0.2.1-rc.2` 源码核实（2026-10-25）；⚠️ 构建、挂载与热更行为待 M0 实测 |
| [参考项目功能清单](reference-feature-inventory.md) | IdeaGitTool v0.4.2 的功能、UI 结构、可移植纯逻辑层与 VS Code 强绑定部分 | ✅ 已按参考仓库 `v0.4.2` 源码核实（2026-10-25）；移植可行性待 M0 后逐项确认 |
| [assets/reference-ideagittool-log.jpg](assets/reference-ideagittool-log.jpg) | 参考项目日志页截图（产品设计 §8.1 引用） | 截图证据，无版本标记 |

## 本项目待验证清单

M0 spike 需要逐条确认，完成后在对应文档内改状态并写日期：

- [ ] `build.mjs` 产物能被 `__ModuleLoader__` 加载（包装三行契约）
- [ ] `dev.patch.yml` 绝对路径行能被 client-modules 扫描到
- [ ] `ctx.connection.rpc.handle` / `rpc.call` 的一元 JSON 契约与错误封装
- [ ] `ctx.subprocess` + `ctx.sandbox.confine` 的组合行为（含 `danger-full-access`）
- [ ] `workspaceFiles.changes` 与 `.git` watch 的可用性、降级路径
- [ ] `sidebar.right.tab.document.actions` slot 与 `openTab('git.blame')` 在当前版本可用
- [ ] client 产物热更、Host 改动重启的实际边界
