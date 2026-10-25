# 开发环境搭建

## 前置依赖

| 依赖 | 用途 | 安装 |
|---|---|---|
| Node.js ≥ 22（当前验证 24.11） | 构建、测试、运行 pnpm | nvm / 官方安装包 |
| pnpm | 依赖管理 | `corepack enable pnpm` |
| git ≥ 2.25 | 插件运行时调用；开发期建临时仓库 | 系统包管理器 |
| Python 3 | `scripts/check_docs.py` 文档检查 | 系统自带或 conda |
| DeepSeek Harness checkout | 本地挂载与调试（只读，不修改） | `/Users/peng/Me/Ai/deepseek-harness` |

## 命令行路径

AI 工具的沙箱中 `PATH` 可能不完整。Makefile 自己定位 pnpm（见 `Makefile` 开头），不依赖调用方的 `PATH`。
cd 到 DSH checkout 运行 `pnpm dsh` 时，用的是 DSH 自己的 pnpm。

## 初始化

```bash
corepack enable pnpm     # 首次
make setup               # 启用 .githooks/pre-commit；有 package.json 后同时安装依赖
make check               # 基线必须全绿
```

当前仓库已有 `package.json`（M0 T1 建立）。`make setup` 会启用 git hooks 并 `pnpm install`；DSH 类型依赖用 `link:` 指向本机 checkout，换机器时先确认路径存在再安装。

常用命令：

```bash
pnpm build        # 产出 lib/host.js 与 lib/client.js
pnpm dev          # esbuild watch（重建 lib/client.js 会触发 DSH 热更）
pnpm smoke        # 产物契约 smoke（需先 build）
make check        # lint + typecheck + 分层契约 + 测试 + 文档检查
```

## 本地挂载（开发期，M0 T2 起）

不安装到 profile，用 overlay 启动 DSH：

```bash
cd /Users/peng/Me/Ai/deepseek-harness
pnpm dsh web --patch /Users/peng/Me/Ai/dsh-idea-gittool/dev.patch.yml
```

- `dev.patch.yml` 用**绝对路径**行把本包挂进 client 图；改它需要重启，不省重启。
- **插件已经 `link:` 安装进 web profile 时不要再加 `--patch`**：会报 `resolves from multiple active Loader sources`。直接 `pnpm dsh web --no-open --port 3081` 即可，安装态就指向本仓库的 `lib/`（2026-10-25 实测）。
- 不要占用负责人正在用的 3080；走查另起 3081 等端口，用完停掉。
- 修改 `lib/client.js` 后由 `dsh-client-hmr` 轮询热换（按内容 rev，只 `touch` 不触发；约 0.5s 生效，CSS 同步替换）；Host 改动、首次安装、`engines.dsh` 变化需要重启 `dsh web`。
- **不要修改 DSH checkout**；需要对照实验时用临时目录或本仓库内的副本。

## 安装态复验（仅负责人在场时执行）

```bash
cd /Users/peng/Me/Ai/deepseek-harness
pnpm dsh plugin --profile web add /Users/peng/Me/Ai/dsh-idea-gittool
# 重启 dsh web 后复验
```

**pnpm 版本坑（2026-10-25 实测）**：本机 web profile 的 `node_modules` 由 pnpm 10.27（store v10）安装，而 DSH checkout 用 pnpm 11（store v11）。直接 `pnpm dsh plugin ...` 会报 `ERR_PNPM_UNEXPECTED_STORE`。用 pnpm 10 的 CLI 绕过（`pnpm dsh` 会把 checkout 的 `node_modules/.bin` 放到 PATH 最前，所以不能靠改 PATH 解决外层）：

```bash
mkdir -p /tmp/pnpm10
printf '#!/bin/sh\nexec node ~/.cache/node/corepack/v1/pnpm/10.27.0/bin/pnpm.cjs "$@"\n' > /tmp/pnpm10/pnpm
chmod +x /tmp/pnpm10/pnpm
cd /Users/peng/Me/Ai/deepseek-harness
PATH=/tmp/pnpm10:$PATH node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add /Users/peng/Me/Ai/dsh-idea-gittool
```

安装会写 profile 的 `dependencies`（`link:`）与 `dsh.profile.bundles`。**不重启正在使用的 3080** 也能复验：另起一个不带 `--patch` 的进程（如 `--port 3082`），检查启动日志无 `did not activate`、页面模块图含 `dsh-idea-gittool/client.js`、`POST /dsh-git/bootstrap` 带 Cookie 返回数据。3080 在下次手动重启后才加载插件。

- 只走 `dsh plugin` 命令，不直接编辑 `~/.dsh/profiles/web` 下的文件。
- 推送、发布 npm 包、force push 都需要负责人明确确认。

## 环境变量与密钥

当前不需要密钥。运行插件时 Host 会主动设置 `GIT_TERMINAL_PROMPT=0`、`LC_ALL=C` 等 git 环境变量（见设计 §16.4），不依赖 `.env`。
若将来需要本地变量，放不进 git 的 `.env`，并提供 `.env.example`。
