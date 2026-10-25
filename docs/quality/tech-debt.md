# 技术债登记表

发现暂时不处理的问题时登记在这里。每个里程碑收尾时，挑一两项处理，或者排进下一个计划。处理完的条目移到「已处理」。
编号 `TD-N` 只增不复用；`scripts/check_docs.py` 检查未处理区编号唯一、且不与「已处理」撞号。

| # | 登记日期 | 位置 | 问题 | 影响 | 建议的处理方式 | 来源 |
|---|---|---|---|---|---|---|
| TD-1 | 2026-10-25 | `build.mjs`、`lib/client.js` | 官方 tsdown preset 无法脱离 DSH 仓库，产物包装（`__ModuleLoader__` banner/intro/footer 与 baseline externals）需自维护 | DSH 升级后产物契约可能漂移，且没有官方纯净度门禁兜底 | build smoke 已覆盖包装与 externals；每次升级 DSH 跑一次 `pnpm smoke` + 安装态冒烟 | [可行性调研](../references/dsh-integration-feasibility.md) §5.3–5.4 |
| TD-2 | 2026-10-25 | `docs/references/` | 调研结论来自 DSH `0.2.1-rc.2` 源码阅读；M0 已实测挂载/产物/RPC/门禁/文档 slot，但 `rpc.handle` 结论被推翻（见调研 §13），HMR 与刷新仍未手动走查 | 设计与实现可能基于过时行为 | 按 §13 的 ✅/⚠️/❌ 继续跟进：补 HMR/刷新走查；升级 DSH 后重跑 §13 清单 | [可行性调研](../references/dsh-integration-feasibility.md) §13 |
| TD-4 | 2026-10-25 | `src/host/{watch,rpc}.ts` | web profile 未挂载 `fs` 服务，`ctx.fs.watch` 不可用 → Host watch 降级、仓库 `version` 恒 0，只能靠 1s TTL 缓存 + 3s 轮询兜底 | 终端操作后最长约 4s 才反映；无法用 version 丢弃跨请求的旧响应 | A1 时二选一：复用 `workspaceFiles.changes` 的 Host 侧 watcher，或在 Host 侧换用可用的文件监听能力；同时补一次真实刷新走查 | [M0 验证记录](../plans/active/m0-集成-spike.md#验证记录) |
| TD-3 | 2026-10-25 | `src/client/*.tsx`、`build.mjs` | esbuild 的 `.css` loader 是 text 不是 CSS Modules，M0 全部用内联样式（语义 token 正确，但没有哈希类名与样式复用） | A1 起组件增多后样式难维护，且与 DSH 的 CSS Modules 规范不一致 | 在 A1 计划里决定 v2 构建：两遍 local-css 生成 class map 或改用官方 preset 对照产物 | [可行性调研](../references/dsh-integration-feasibility.md) §4.4、§5.4 |

## 已处理

| # | 处理日期 | 说明 |
|---|---|---|
