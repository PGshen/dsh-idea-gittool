# 更新日志

本文件记录本项目的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

`1.0.0-rc.1` 是首个公开预览版：功能已按设计与计划完成，先在真实使用中收一轮反馈，再发 `1.0.0`。

## [Unreleased]

### 新增

- 设置页新增「显示语言」：跟随 DSH（默认）、中文、English；只影响 Git 工作台，切换即时生效。

## [1.0.0-rc.1] - 2026-10-30

### 新增

- 日志与提交图：分支/标签徽标、按文本/正则/分支/作者筛选、提交详情与变更文件、统一/并排 diff、词级高亮、忽略空白、完整文件视图。
- 提交：按文件勾选提交（只提交勾选的文件）、Amend、提交并推送、回滚、按 Changelist 分组。
- 分支与远程：本地/远程分支树、智能签出（有本地改动时可先贮藏）、合并、变基、重命名、删除、设置 upstream、远程管理与标签推送/删除。
- 历史与审查：文件历史、Blame（含可选的「Git Blame」文档查看器）、与工作区/任意修订比较。
- 冲突与合并：三栏合并窗口（逐块接受、应用非冲突更改、草稿保存）、冲突列表、继续/中止 merge、rebase、cherry-pick、revert。
- 高级操作：交互式变基（改写信息、丢弃、压缩）、提交右键菜单（撤销提交、回滚、拣选、重置、推送到此、Fixup/Squash、创建/应用补丁）、搁架（可三方合并取回）、Worktree 页。
- 工作台：Git 控制台（查看插件执行过的每条 git 命令）、设置页（自动刷新、每页条数、日期格式、紧凑模式、默认 Diff、提交后跳转、合并选项、Blame 渲染器、git 路径）。
- 安装与运行：独立双面 bundle（Host + Client 同包），通过 `dsh plugin` 安装；中英双语；git 版本门控（最低 2.25）与「未找到 git / 版本过低」空状态。
- 性能：10k 提交仓库的首屏与刷新基准；客户端合并编辑器按需 chunk，`client.js` gzip 约 182 KB。

### 安全

- 所有写操作在 DSH 会话沙箱内执行，只读会话或沙箱不可用时工作台只读；每次写之前重新检查工作区包含关系。
- RPC 请求体按端点限额；Git 控制台与远程列表对凭据脱敏。

### 已知限制

- Windows、Linux 只做了静态审计与单元测试，未在真机上验证；macOS 已实测。
- 未实测 git 2.25 与 2.38（2.39.5、2.50.1 已全绿）；部分功能要求 git 2.38 / 2.43。
- 不支持子模块与 Git LFS 的专门操作。
- Diff 里只改了行尾（CRLF ↔ LF）的行看起来与原行相同。
- 其余已知问题见 [TODO](docs/plans/TODO.md)。

[Unreleased]: https://github.com/PGshen/dsh-idea-gittool/compare/v1.0.0-rc.1...HEAD
[1.0.0-rc.1]: https://github.com/PGshen/dsh-idea-gittool/releases/tag/v1.0.0-rc.1
