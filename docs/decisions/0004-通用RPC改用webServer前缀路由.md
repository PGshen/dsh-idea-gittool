# ADR 0004：/dsh-git 改用 webServer 前缀路由，不用 connection.rpc.handle

## 元信息

| 项 | 值 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-25 |
| 相关 | [M0 计划](../plans/completed/m0-集成-spike.md)、[可行性调研 §4.2/§6/§13](../references/dsh-integration-feasibility.md)、[ADR 0003](0003-独立双面-bundle-交付形态.md) |

## 背景

[ADR 0003](0003-独立双面-bundle-交付形态.md) 决定浏览器 ↔ Host 用「通用 RPC」，并按可行性调研 §6.2 选择 `ctx.connection.rpc.handle('/dsh-git', handler)` 作为 Host 侧入口。
M0 实机挂载时该入口不可用：`HostConnectionService.register()`（DSH `0.2.1-rc.2` `packages/client/connection/src/rpc-host.ts`）用服务自身的 ctx（app root fiber）执行 `owner.webServer.register(...)`，而 app root fiber 没有 `webServer` inject，插件激活即抛 `cannot get property "webServer" without inject`，整个插件不加载。该版本源码中没有生产代码使用这个入口。

调研 §6.4 已给出备选：`ctx.webServer.register({kind:'prefix'})` + `ctx.connection.requestRejection(req)`，先例是 `ui-open-in-app`。

## 决定

- Host 侧在 `ctx.inject(['webServer'])` 子作用域里注册 `prefix` 路由 `/dsh-git`；每个请求先调 `connection.requestRejection(req)`（与 `/api` 相同的浏览器鉴权），再按 `POST /dsh-git/<endpoint>` 分发。
- 信封由本插件自定：请求体是该端点自己的 JSON payload；响应固定为 `{ ok:true, value }` 或 `{ ok:false, error:{ code, message, details? } }`（`src/shared/protocol.ts` 的 `RpcResult`）。
- 客户端仍只传 `sessionId`，用自己的 `fetch` 调通道（`src/client/git-client.ts`），不依赖 `ctx.connection.rpc.call` 的内部响应形状。
- 端点集合、payload 校验、错误码由插件自己维护；`connection` 服务只用于鉴权，`webServer` 只用于挂路由。

## 考虑过的其他方案

- **继续用 `ctx.connection.rpc.handle` 并给插件加 `webServer` inject**：不选。owner 是 app root fiber，不是调用方 fiber，加 inject 无效（已在 M0 实机验证）。
- **用 `connection.fetch.register`（`/api` 下的 exact Fetch 路由）**：不选。它绑定 `/api` 通道且需要 `/api` 级鉴权与 multipart 语义，超出 M0 需求；调研 §6.4 也只把它当超大响应/流式的后续选项。
- **`ctx.shell` 或自建 HTTP server**：不选。前者是 shell 字符串注入面，后者另起端口会破坏 DSH 的同源与鉴权。
- **改用 Typert Remote 生成**：不可行（生成器要求 DSH workspace 布局，见 [ADR 0003](0003-独立双面-bundle-交付形态.md)）。

## 影响

- 与调研 §6.2 「通用 RPC」的**入口**结论偏离，但保留其「unary JSON + 浏览器鉴权」的实质；调研 §13 已回写实测结论。
- 插件自维护 JSON 信封与端点校验，没有 DSH 的 `rpcId` 关联与 multipart 能力；需要流式/大响应时再按调研 §6.4 加 exact Fetch 路由。
- 升级 DSH 时要复查两个公开点：`webServer.register({kind:'prefix'})` 与 `connection.requestRejection`；以及 `webServer` 服务是否仍以 `ctx.inject(['webServer'])` 暴露。
- 已删除对 `connection.rpc.handle` 的依赖，`src/host/http.ts` 顶部注释记录了原因，避免以后有人「顺手改回去」。
