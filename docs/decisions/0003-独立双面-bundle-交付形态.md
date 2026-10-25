# ADR 0003：独立双面 bundle 的交付形态

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-25 |
| 相关 | [设计决策 v0.2](../design/2026-10-25-产品设计决策-v0.2.md) C1、[产品设计 v0.2](../design/2026-10-25-产品设计-v0.2.md) §16.2、[可行性调研](../references/dsh-integration-feasibility.md) §5 |

## 背景

Git 工作台需要同时提供右侧栏 UI（浏览器）和 git 执行能力（Host），并且要能独立开发、安装和热更。
DSH 官方插件的内置形态要求修改 DSH 仓库的 `packages/` 与 bundle patch，不适合作为独立产品分发；同时本仓库不能修改 DSH checkout。

## 决定

- 一个 npm 包、两半产物：`package.json` 的 `main` 指向 `lib/host.js`，`exports["./client"]` 指向 `lib/client.js`。
- 通过 `dsh.bundle.patch` 指向 `cordis.patch.yml`，由 `dsh plugin --profile web add <path>` 安装；patch 只插入一行 Host 入口，不改 DSH 源码。
- 开发期用 `dev.patch.yml`（绝对路径行）+ `pnpm dsh web --patch ./dev.patch.yml` 挂载，不先安装。
- `engines.dsh` 锁定兼容范围（首发 `>=0.2.1-rc.2 <0.3.0`），升级 DSH 时先跑产物 smoke 与安装态冒烟。
- 浏览器 ↔ Host 用通用 RPC：`ctx.connection.rpc.handle('/dsh-git', ...)` 与 `ctx.connection.rpc.call(...)`；不用 Typert Remote。
- 运行时能力全部从 `ctx` 取：`ctx.subprocess` + `ctx.sandbox.confine` 执行 git，不直接使用 `node:child_process` 或 `ctx.shell`。
- Client 侧 `lib/client.js` 重建可被 `dsh-client-hmr` 热换；Host 改动、首次安装与 `engines.dsh` 变化需要重启 `dsh web`。

## 考虑过的其他方案

- **内置插件（改 DSH 仓库）**：不选。违反「不修改 DSH 仓库」红线，不能独立分发与版本化。
- **独立 Electron/本地 Git 客户端**：不选。产品定位是「对话旁边的 Git 面板」，离开 DSH 会话 cwd 与沙箱就失去核心价值。
- **用 Typert Remote 生成通信层**：不选。生成器要求 DSH 仓库布局，外部包不可用（调研 §5）。
- **用 `ctx.shell` 执行 git**：不选。它接受 shell 字符串，提交信息与路径会变成注入面；`ctx.subprocess` 走 argv 且能被沙箱约束。

## 影响

- 必须自维护产物包装与 externals 清单（技术债 TD-1），并在 DSH 升级时回归。
- 首次安装与 Host 改动需要重启，开发文档和验收必须写清这一差异。
- 写操作受沙箱约束：仓库根在会话 workspaceRoot 之外时进入只读模式，不静默放宽。
- 不修改 DSH 仓库，意味着文档预览 slot / registry 等公开 API 变化时只能降级或等宿主升级；对应风险与降级路径见设计决策 v0.2 风险 S4。
