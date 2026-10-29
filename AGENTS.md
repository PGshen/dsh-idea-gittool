# AGENTS.md — dsh-idea-gittool

本文件是给 AI 开发者（Claude Code、Codex）的**入口地图**：只说明去哪里找什么，细节在 `docs/` 里。
保持在 100 行左右（`scripts/check_docs.py` 限制 120 行）；新增内容优先写进对应文档，这里只加链接。

## 项目是什么

在 DSH Web GUI 右侧栏提供 IntelliJ 风格的 **Git 工作台**：默认看提交图与历史，一键审 Agent 改动的 diff，按文件勾选提交，顺手管分支、贮藏和冲突。
交付为**独立的双面 bundle 插件**（Host + Client 同包），通过 `dsh plugin --profile web add` 安装，**不修改 DSH 仓库**。

- 模块地图与分层规则：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 术语表：[docs/glossary.md](docs/glossary.md)
- 产品与架构设计（权威来源）：[产品设计 v0.2](docs/design/2026-10-25-产品设计-v0.2.md)、[设计决策 v0.2](docs/design/2026-10-25-产品设计决策-v0.2.md)
- 一页速览：[产品设计速览](docs/design/2026-10-25-产品设计速览.md)

## 每次会话开始时

1. 读本文件。
2. 读 [docs/SOP.md](docs/SOP.md)，确认当前所处的 SOP 阶段和你的职责。
3. 打开 `docs/plans/active/` 中的计划，先读 **「进度」** 和 **「下一步」** 两节。
4. 读 [docs/plans/TODO.md](docs/plans/TODO.md)。`active/` 中没有计划时，从这里挑下一件事，和负责人确认后再开工。
5. 运行 `make check`，确认基线是绿的。基线不绿时先处理这个问题，或者按升级条件停下来问人。
6. 从计划的「下一步」继续；新发现的、不属于当前计划的事项记进 TODO。

## 常用命令

| 命令 | 作用 |
|---|---|
| `make setup` | 启用 git hooks；有 `package.json` 时安装依赖 |
| `make check` | **唯一的质量关口**：lint、类型检查、分层契约、测试、构建 + 产物 smoke、文档检查。合并前必须全部通过 |
| `make check-fast` | pre-commit 运行的快速子集（文档检查 + lint/类型检查） |
| `pnpm build` / `pnpm dev` | 构建双面产物（`lib/host.js`、`lib/client.js`）；`dev` 为 watch 模式 |
| `pnpm smoke` | 不依赖浏览器的产物契约校验（需先 `build`；含体积门槛与按需 chunk） |
| `pnpm bench` / `pnpm bench:client` | L5 性能基准（10k 合成仓库 Host 延迟 / 日志滚动渲染 harness），不进 `make check` |
| `scripts/compat/run-host-tests.sh <git 绝对路径>` | 用指定版本的 git 跑 `test/host`（L5 兼容，B4d），不进 `make check` |

代码骨架在 M0 计划中建立；之后新增构建/挂载命令时，必须同步更新本表和 runbooks。
运行和自验证的方法见 [docs/runbooks/verification.md](docs/runbooks/verification.md)，环境搭建见 [docs/runbooks/dev-setup.md](docs/runbooks/dev-setup.md)。

## 文档索引

| 需要 | 去哪里 |
|---|---|
| 工作流程、关口、升级条件 | [docs/SOP.md](docs/SOP.md) |
| 当前任务和交接信息 | `docs/plans/active/` |
| 待办（还没写成计划的工作） | [docs/plans/TODO.md](docs/plans/TODO.md) |
| 过去为什么这么决定 | `docs/decisions/` |
| 外部 SDK 和库的已验证行为 | [docs/references/](docs/references/README.md) |
| 模块质量与已知缺口 | [docs/quality/QUALITY.md](docs/quality/QUALITY.md) |
| 技术债 | [docs/quality/tech-debt.md](docs/quality/tech-debt.md) |

## 红线（违反任何一条都要停下来问人）

- 不跳过或削弱 `make check`；不用 skip、xfail、`type: ignore`、`noqa` 等绕过失败，除非计划里写明了理由。
- 不引入计划之外的新依赖，不改变计划之外的公共接口。
- 不修改 `docs/design/` 中已批准的设计；发现设计有问题就走升级流程。
- **不修改 DSH 仓库 checkout**（`/Users/peng/Me/Ai/deepseek-harness` 只读）。需要对照验证时，在临时目录或本仓库内做，不改宿主源码。
- **不直接改 `~/.dsh/profiles/web` 中已安装的内容**；安装/升级只走 `dsh plugin` 命令，且由负责人确认后执行。
- **不执行 `git push`、不发布 npm 包**；推送与发布由负责人确认后执行。
- **不把密钥、凭据、真实仓库数据提交进 git**；`.env`、`.evidence/`、`node_modules/`、`lib/` 均已忽略。

## 工作约定

- **语言**：面向用户的回复、文档、提交说明都用中文；代码标识符和注释用英文。
- **计划的写法**：计划只写结构和意图（目标、涉及的文件、接口、验收标准、验证命令），不写完整的实现代码。
- **测试先行**：每个任务先写失败的测试，再实现。
- **外部 SDK 的知识**：以 `docs/references/` 中已验证的内容为准；训练知识可能已经过时。遇到没有记录的行为，先查官方文档或实测，然后把结论补进 references，注明日期和来源。
- **记录**：计划执行中的决定、意外和发现随时写进计划；影响范围超出当前计划的决定写成 ADR。
- **提交**：每个任务至少一个 commit，说明格式为 `<type>(<scope>): <中文说明>`，例如 `feat(log): 实现日志首屏`。
