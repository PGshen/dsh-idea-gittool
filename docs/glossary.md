# 术语表

代码、文档和对话中统一使用下面的术语。英文一列是代码中的命名。

| 术语 | 英文 | 含义 |
|---|---|---|
| Git 工作台 | Git workbench | 本插件提供的右侧栏 Git 面板，包含日志/提交/分支/贮藏四个平级页 |
| 宿主 | Host / DSH | DeepSeek Harness，本插件的运行环境；其 checkout 只读 |
| Host 半边 | Host half | 插件在 Node 侧的部分，负责 RPC、仓库解析、执行 git |
| Client 半边 | Client half | 插件在浏览器侧的部分，负责 UI、store、RPC 调用 |
| 双面 bundle | dual-face bundle | 同一个 npm 包同时导出 Host 入口与 `./client` 浏览器产物 |
| 产物包装 | `__ModuleLoader__` wrapper | `window.__ModuleLoader__.load({ id, factory })` 三行加载契约 |
| patch / overlay | patch | `cordis.patch.yml`（发布）或 `dev.patch.yml`（开发）插入的插件行 |
| 仓库根 | repo root | `git rev-parse --show-toplevel` 的结果；写能力门禁的判定对象 |
| 写能力门禁 | write gate | 依据仓库根与会话 workspaceRoot 的关系决定可读/可写，fail closed |
| 只读模式 | read-only mode | 仓库根在沙箱外时的降级：历史/diff 可用，写按钮禁用并说明 |
| 会话工作目录 | session cwd | DSH 为每个会话记录的工作目录，Host 由 `sessionId` 解析得到 |
| RPC | RPC | 浏览器与 Host 之间的一元 JSON 请求 `/dsh-git`，无服务端推送 |
| 刷新版本 | version | 每个仓库单调递增的计数器；用于丢弃过期响应 |
| 泳道 | lane | 提交图中一条分支线的横向位置；最多 6 条色相区分 |
| 三栏合并 | three-way merge | 冲突解决的全屏窗口：左侧/右侧/结果三栏，可逐块 Accept |
| Blame 视图 | Blame view | 独立的只读逐行注解页，不是编辑器内联 blame |
| spike | spike | 一次性的技术验证，目标是回答问题并记录结论，不追求产品完成度 |
| feature flag | feature flag | 高风险功能（三栏合并、交互式变基、Worktree）的默认开关 |
