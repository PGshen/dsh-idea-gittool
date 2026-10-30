# 安装、升级与卸载（B4d T6）

面向负责人和验证者：用打包产物（tarball）安装插件，以及升级、卸载、版本不匹配时的表现。开发期用 `link:` 安装或 `dev.patch.yml`，见 [dev-setup](dev-setup.md)。

> 红线：负责人的 `~/.dsh/profiles/web` 只通过 `dsh plugin` 命令修改，并且要负责人确认后执行。验证一律在隔离 HOME 里做（见下文）。

## 打包

```bash
make dist
```

- 产物 `dist/dsh-idea-gittool-<版本>.tgz` 只含 `lib/host.js`、`lib/client.js`、`lib/client.merge.js`（合并窗口的按需 chunk）、`cordis.patch.yml`、`LICENSE`、`NOTICE`、`README.md`、`package.json`，旁边生成 `SHA256SUMS`。`make dist` 会先构建并跑 `pnpm smoke`；`pnpm smoke` 用 `pnpm pack --dry-run --json` 校验这份清单。
- `lib/client.css`（构建时的样式副本，DSH 不读取）与 `lib/host.js.map` 不进包。
- 版本号、tag、GitHub Release 与撤回流程见 [release](release.md)。

## 安装、升级、卸载

在 DSH checkout 里运行（`dsh plugin` 把参数原样转给 profile 目录里的 pnpm）：

```bash
pnpm dsh plugin --profile web add /绝对路径/dsh-idea-gittool-<版本>.tgz
pnpm dsh plugin --profile web remove dsh-idea-gittool
```

- 安装会写 profile 的 `dependencies`（`file:<tarball>`）并把包名加进 `dsh.profile.bundles`；卸载把两处都去掉。之后都要**重启 `dsh web`**（Host 只在启动时加载）。
- **升级**：直接 `add` 新版本的 tarball，pnpm 会替换旧版本（旧版本多出的文件也会消失）。浏览器里的设置（`dsh-idea-git.settings.v1`）、Changelist（`dsh-idea-git.changelists.v1:<仓库根>`）和导航历史都存在 localStorage，按 DSH 页面的源（端口）保存，升级后保留；合并草稿与搁架存在仓库自己的 ref 里，与插件版本无关。
- **卸载后**：如果卸载前 Git 标签开着，DSH 会恢复这个标签，但显示「这类内容还没有可用的查看方式。」，关掉即可；不加载插件的模块与样式，文档预览头部没有 Git 动作。
- **版本不匹配**（`engines.dsh` 不满足当前 DSH）：`add` 直接拒绝，提示插件与当前 DSH 版本不兼容、运行可能崩溃或丢数据，并自动还原 profile 的 `package.json`、lockfile 与 `node_modules`；确实要装时，提示里给出 `dsh plugin --profile web allow-version <包>@<版本> --dsh-version <DSH 版本> --accept-risk`（按精确版本豁免）。

## 在隔离 HOME 里验证（不碰负责人的 profile 与 3080）

1. `H=<scratchpad>/dsh-home`；`mkdir -p $H/.dsh/profiles && cp -R ~/.dsh/profiles/web $H/.dsh/profiles/web`。要有工作区和会话时，按 [verification](verification.md)「准备隔离 DSH」第 4 步准备 `$H/.dsh/storages`。
2. **pnpm 的 store 要指回原来的**：换了 HOME 后 pnpm 默认用 `$H/Library/pnpm/store`，与复制来的 `node_modules` 不一致，`dsh plugin` 会报 store 不匹配。每条命令都带 `pnpm_config_store_dir=$HOME_REAL/Library/pnpm/store`（pnpm 11 不认 `npm_config_store_dir`）。
3. 复制来的 profile 若是 `link:` 安装的，先 `remove` 再 `add` tarball。
4. 启动：`HOME=$H pnpm dsh web --no-open --port 3082`。
5. 模拟「找不到 git」：用不含 git 的 PATH 启动，例如 `PATH=<node 所在目录>:/bin:/usr/sbin:/sbin`（macOS 的 git 在 `/usr/bin`，Homebrew 的 `/opt/homebrew/bin` 默认没有 git）。

## 2026-10-29 实测（DSH 0.2.1-rc.2，10k 合成仓库）

| 步骤 | 结果 |
|---|---|
| `add` 0.1.0 tarball（main 上的 B4c 代码）→ 重启 | Git 标签可用，状态栏 `Git 2.50.1` |
| 设置里开紧凑模式 → `add` 1.0.0-rc.1 → 重启 | 设置（`compact: true`）与 Changelist 数据保留；包内旧的 `client.css`、`host.js.map` 消失 |
| 设置页填 `/bin/ls` | 显示「该程序不是 git…」，设置不保存 |
| 设置页填 Command Line Tools 的 git | 不重启即切换，状态栏 `Git 2.39.5`，设置页显示「来自设置」 |
| 清空路径 → 无 git 的 PATH 重启 | Git 标签显示「未找到 git 命令」空状态 |
| 空状态里「设置 git 路径…」→ 填路径 | 不重启即恢复，日志正常 |
| 再次无 git 的 PATH 重启并刷新 | 挂载时重发已存路径，直接可用 |
| `remove` → 重启 | DSH 正常启动，不加载插件模块/样式；残留的 Git 标签显示 DSH 的占位文案 |
| `engines.dsh: ">=9.0.0"` 的 tarball | 安装被拒并自动还原 profile |
