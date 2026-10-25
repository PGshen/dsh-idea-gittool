# 技术债登记表

发现暂时不处理的问题时登记在这里。每个里程碑收尾时，挑一两项处理，或者排进下一个计划。处理完的条目移到「已处理」。
编号 `TD-N` 只增不复用；`scripts/check_docs.py` 检查未处理区编号唯一、且不与「已处理」撞号。

| # | 登记日期 | 位置 | 问题 | 影响 | 建议的处理方式 | 来源 |
|---|---|---|---|---|---|---|
| TD-1 | 2026-10-25 | `build.mjs`、`lib/client.js` | 官方 tsdown preset 无法脱离 DSH 仓库，产物包装（`__ModuleLoader__` banner/intro/footer 与 baseline externals）需自维护 | DSH 升级后产物契约可能漂移，且没有官方纯净度门禁兜底 | 保留 build smoke 固定校验三行包装与 externals 清单；每次升级 DSH 跑一次安装态冒烟 | [可行性调研](../references/dsh-integration-feasibility.md) §5.3–5.4 |
| TD-2 | 2026-10-25 | `docs/references/` | 调研结论来自 DSH `0.2.1-rc.2` 源码阅读，尚未在本仓库实测；挂载、RPC、沙箱门禁、热更行为待验证 | 设计与实现可能基于过时行为 | M0 spike 逐条验证，把 ✅/⚠️/❌ 与日期回写到对应调研文档 | [references](../references/README.md) |

## 已处理

| # | 处理日期 | 说明 |
|---|---|---|
