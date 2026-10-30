# make check 是唯一的质量关口（docs/SOP.md）。
# 代码检查命令统一交给 package.json 的脚本，Makefile 不重复定义规则。
# package.json 还不存在时对应检查自动跳过，让 M0 之前的骨架阶段也能保持绿。

SHELL := /bin/bash
PYTHON ?= python3

# AI 工具的沙箱里 PATH 可能不完整，需要时在这里主动定位工具。
# pnpm 建议通过 `corepack enable pnpm` 提供；找不到时 setup/check 会给出明确错误。
PNPM ?= $(shell command -v pnpm 2>/dev/null)

.PHONY: setup check check-fast check-docs check-code check-fast-code dist

setup:
	git config core.hooksPath .githooks
	@if [ -f package.json ]; then \
		if [ -z "$(PNPM)" ]; then echo "错误：找不到 pnpm，请先运行 corepack enable pnpm"; exit 1; fi; \
		$(PNPM) install; \
	else \
		echo "setup：还没有 package.json（M0 T1 建立），暂时只启用 git hooks"; \
	fi

check: check-docs check-code
	@echo "make check 全部通过"

# pre-commit 运行的快速子集：文档检查 + lint/类型检查。
check-fast: check-docs check-fast-code

# 发布产物：构建 → 产物 smoke → 打包 → dist/SHA256SUMS，并打印安装命令（docs/runbooks/release.md）。
dist:
	@if [ -z "$(PNPM)" ]; then echo "错误：找不到 pnpm，请先运行 corepack enable pnpm"; exit 1; fi; \
	$(PNPM) run dist

check-docs:
	@$(PYTHON) scripts/check_docs.py

# package.json 的 `check` 脚本依次运行：lint、类型检查、分层契约、测试、构建与产物 smoke（B4c）。
check-code:
	@if [ ! -f package.json ]; then \
		echo "check-code：尚无 package.json（M0 T1 建立），跳过代码检查"; \
		exit 0; \
	fi; \
	if [ -z "$(PNPM)" ]; then echo "错误：找不到 pnpm，请先运行 corepack enable pnpm"; exit 1; fi; \
	$(PNPM) run check

# package.json 的 `check:fast` 脚本只跑 lint + 类型检查。
check-fast-code:
	@if [ ! -f package.json ]; then \
		echo "check-fast-code：尚无 package.json（M0 T1 建立），跳过"; \
		exit 0; \
	fi; \
	if [ -z "$(PNPM)" ]; then echo "错误：找不到 pnpm，请先运行 corepack enable pnpm"; exit 1; fi; \
	$(PNPM) run check:fast
