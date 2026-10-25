# dsh-idea-gittool

DSH Web GUI 右侧栏的 **IntelliJ 风格 Git 工作台**：看提交图与历史，审 Agent 改动的 diff，按文件勾选提交，顺手管分支、贮藏和冲突。

以**独立双面 bundle 插件**交付（Host + Client 同包），通过 `dsh plugin --profile web add` 安装，不修改 DSH 仓库。

## 当前状态

M0 集成 spike 已完成并验收：独立双面 bundle 可在 DSH Web 挂载，`/dsh-git` RPC、写能力门禁、文档预览动作与刷新兜底都有实测证据（见 [M0 计划](docs/plans/completed/m0-集成-spike.md) 与 [调研 §13](docs/references/dsh-integration-feasibility.md)）。下一步是按里程碑拆分 A1 计划。

## 从这里开始

| 你是 | 先读 |
|---|---|
| AI 开发者（Claude Code / Codex） | [AGENTS.md](AGENTS.md) |
| 人 / 负责人 | [产品设计速览](docs/design/2026-10-25-产品设计速览.md)、[SOP](docs/SOP.md) |
| 想了解技术方案 | [产品设计 v0.2](docs/design/2026-10-25-产品设计-v0.2.md) §16、[DSH 集成可行性调研](docs/references/dsh-integration-feasibility.md) |

## 常用命令

```bash
make setup    # 启用 pre-commit hook；有 package.json 后安装依赖
make check    # 唯一质量关口：文档 + lint + 类型 + 分层契约 + 测试
```

环境搭建、本地挂载与安装态复验见 [dev-setup](docs/runbooks/dev-setup.md)；自验证方法见 [verification](docs/runbooks/verification.md)。

## 约定

- 文档、提交说明用中文；代码标识符与注释用英文。
- 不修改 DSH checkout，不直接改 `~/.dsh/profiles/web`，不 push / 不发布，不把密钥与真实仓库数据放进 git。
- `make check` 为绿是每个任务完成的前提。
