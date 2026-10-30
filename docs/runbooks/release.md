# 发布与分发（R1）

面向维护者：从版本号到 GitHub Release 的完整流程、给收件人的安装方式，以及撤回办法。收件人只看 [README](../../README.md) 即可；安装/升级/卸载的实测记录在 [install-upgrade](install-upgrade.md)。

> 红线：`git push`、打 tag、GitHub Release 上传、npm 发布都由**负责人确认后执行**；AI 只准备产物和命令。

## 分发形态

| 形态 | 用不用 | 说明 |
|---|---|---|
| GitHub Release 附件 tarball | **首发用这个** | 收件人 `dsh plugin --profile web add <URL>`；不需要构建权限 |
| 本地 tgz 文件 | 备用 | 内网/邮件传文件，收件人用绝对路径安装 |
| npm registry | 后续再定 | 用户按包名安装；要补 `prepublishOnly` 与 registry 配置 |
| `dsh plugin add github:PGshen/dsh-idea-gittool` | **不要写进文档** | `lib/` 不入库、没有 `prepare` 脚本，用户还要在 `pnpm-workspace.yaml` 放行构建脚本 |
| 插件市场 Discover | 后续再定 | 索引里的安装目标只能是 npm 或 `git+commit`，依赖 npm 发布 |

## 版本策略

- 遵循 SemVer，tag 与 `package.json` 版本一致，写作 `v<version>`。
- `1.0.0-rc.1` 是首个公开预览。满足以下条件再发 `1.0.0`：没有阻断安装或丢数据的问题；至少一轮真实仓库使用反馈；CHANGELOG 已汇总 rc 期间的修复。
- `engines.dsh` 当前是 `>=0.2.1-rc.2 <0.3.0`。DSH 升到 0.3 前必须发一个兼容版本并实测；不要靠 `allow-version` 让用户冒险豁免。
- 每个发布在 `CHANGELOG.md` 增加一条；rc 期间也照记。

## 发布前检查

- [ ] `make check` 全绿
- [ ] `package.json` 版本与 `CHANGELOG.md` 首条一致
- [ ] 工作树干净（`git status --short` 无输出）
- [ ] README 的安装段、平台支持、DSH 版本范围与本次发布一致
- [ ] `make dist` 通过，记下输出的 sha256
- [ ] 隔离 HOME 安装复验通过（见下文）

## 步骤

1. **改版本与 CHANGELOG**：`package.json` 的 `version`、`CHANGELOG.md` 新增一节；commit 写作 `chore(release): <版本>`。
2. **打产物**：

   ```bash
   make dist
   # dist/dsh-idea-gittool-<版本>.tgz + dist/SHA256SUMS
   ```

3. **隔离 HOME 复验**（不碰负责人的 profile 与 3080）：按 [install-upgrade](install-upgrade.md)「在隔离 HOME 里验证」准备，把 tarball 换成 `dist/` 里的文件；确认安装、重启、Git 标签、升级、卸载都正常。
4. **合并与 tag**（负责人执行）：

   ```bash
   git switch main && git merge --ff-only r1-release
   git tag -a v<版本> -m "dsh-idea-gittool <版本>"
   git push origin main
   git push origin v<版本>
   ```

5. **GitHub Release**（负责人在网页执行）：标题 `dsh-idea-gittool <版本>`；Release notes 从 CHANGELOG 对应一节摘；上传 `dist/dsh-idea-gittool-<版本>.tgz` 与 `dist/SHA256SUMS`；预览版（rc）勾选 **Set as a pre-release**。
6. **发布后**：README 不需要改（安装 URL 用 `latest` 之外的具体 tag 时再更新）；把 Release 链接发给收件人；收集反馈，决定 `1.0.0` 或下一个 rc。

## 给收件人的命令

```bash
# 全局安装了 DSH CLI 的机器
dsh plugin --profile web add https://github.com/PGshen/dsh-idea-gittool/releases/download/v<版本>/dsh-idea-gittool-<版本>.tgz

# 从 DSH checkout 运行
pnpm dsh plugin --profile web add https://github.com/PGshen/dsh-idea-gittool/releases/download/v<版本>/dsh-idea-gittool-<版本>.tgz

# 校验下载的附件
shasum -a 256 -c SHA256SUMS

# 安装后重启
dsh web
```

Web 侧边栏 **Plugins → Add plugin** 也接受同一个 URL，或本地 tgz 的绝对路径。

## 撤回

| 情况 | 做法 |
|---|---|
| 刚发布，还没人装 | Release 改为 pre-release 或删除附件；必要时删 tag：`git push --delete origin v<版本>`（负责人执行） |
| 已有人安装 | **不要**删 tag 重发同一版本；发补丁版本（`-rc.2` 或 `1.0.0`），在 Release notes 说明问题与修复 |
| npm（未来） | `npm deprecate` 标注问题版本，不 `unpublish` |

## 安全约定

- 只发布可信产物：DSH 插件的 Host 代码在 DSH 进程内运行，不受 workspace 沙箱约束。
- 附件必须带 `SHA256SUMS`；README/Release 里给出校验命令。
- `.evidence/`、`dist/`、`.env` 不入库；发布前用 `git ls-files` 抽查。
- 发布用的 token、证书不写进仓库与 Release 说明。
