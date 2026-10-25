#!/usr/bin/env python3
"""Mechanical checks for the docs knowledge base (see docs/SOP.md §10).

Checks:
  1. Relative markdown links resolve to existing files.
  2. Plans in docs/plans/{active,completed}/ contain all required sections.
  3. ADRs in docs/decisions/ follow the naming pattern, have unique numbers
     and contain all required sections.
  4. AGENTS.md stays short enough to be a map.
  5. Open entries in docs/quality/tech-debt.md have unique TD numbers that do
     not collide with resolved ones.

Stdlib only, so it runs before any project dependency is installed.
Missing optional files are skipped, so a repository can adopt the harness step by step.
Adjust the constants below when the docs language or layout differs.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "data",
    "dist",
    "build",
    ".pytest_cache",
    ".superpowers",
}

PLAN_SECTIONS = [
    "元信息",
    "目标",
    "范围",
    "验收标准",
    "任务",
    "进度",
    "下一步",
    "决策记录",
    "意外与发现",
    "阻塞",
    "验证记录",
]
ADR_SECTIONS = ["元信息", "背景", "决定", "考虑过的其他方案", "影响"]
ADR_NAME = re.compile(r"^(\d{4})-.+\.md$")
AGENTS_MAX_LINES = 120
DEBT_RESOLVED_HEADING = "## 已处理"

LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)\)")
FENCE = re.compile(r"^\s*(```|~~~)")
# Tolerates missing spaces ("|TD-60|"); a suffix such as "（部分）" marks a partial fix
# that legitimately shares its number with an open entry.
TD_ROW = re.compile(r"^\|\s*(TD-\d+)\s*(\S*?)\s*\|")


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def markdown_files() -> list[Path]:
    files = []
    for path in ROOT.rglob("*.md"):
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        files.append(path)
    return sorted(files)


def strip_code(text: str) -> str:
    """Drop fenced code blocks and inline code so example links are ignored."""
    out, in_fence = [], False
    for line in text.splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(re.sub(r"`[^`]*`", "", line))
    return "\n".join(out)


def h2_headings(text: str) -> set[str]:
    return {m.group(1).strip() for m in re.finditer(r"^## (.+)$", strip_code(text), re.M)}


def check_links(path: Path, text: str) -> list[str]:
    errors = []
    for target in LINK.findall(strip_code(text)):
        if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("#"):
            continue
        target_path = target.split("#", 1)[0]
        if target_path and not (path.parent / target_path).exists():
            errors.append(f"{rel(path)}: 链接目标不存在：{target}")
    return errors


def check_sections(path: Path, text: str, required: list[str]) -> list[str]:
    missing = [s for s in required if s not in h2_headings(text)]
    if missing:
        return [f"{rel(path)}: 缺少必需章节：{'、'.join(missing)}"]
    return []


def debt_ids(block: str) -> list[tuple[str, str]]:
    rows = []
    for line in block.splitlines():
        m = TD_ROW.match(line)
        if m:
            rows.append((m.group(1), m.group(2)))
    return rows


def check_tech_debt_ids(path: Path, text: str) -> list[str]:
    open_part, _, resolved_part = text.partition(DEBT_RESOLVED_HEADING)
    errors: list[str] = []
    seen: set[str] = set()
    for td, _suffix in debt_ids(open_part):
        if td in seen:
            errors.append(f"{rel(path)}: 技术债编号 {td} 重复")
        seen.add(td)
    resolved_whole = {td for td, suffix in debt_ids(resolved_part) if not suffix}
    for td in sorted(seen & resolved_whole):
        errors.append(f"{rel(path)}: 未处理的 {td} 与「已处理」中的条目撞号")
    return errors


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []

    for path in markdown_files():
        # Templates contain links written for the location of the files created from them.
        if path.name == "TEMPLATE.md":
            continue
        errors += check_links(path, path.read_text(encoding="utf-8"))

    plans_dir = ROOT / "docs" / "plans"
    for sub in ("active", "completed"):
        for path in sorted((plans_dir / sub).glob("*.md")):
            errors += check_sections(path, path.read_text(encoding="utf-8"), PLAN_SECTIONS)
    active = list((plans_dir / "active").glob("*.md"))
    if len(active) > 1:
        warnings.append(f"docs/plans/active/ 中有 {len(active)} 份计划，SOP 建议同一时间只有一份")

    seen: dict[str, Path] = {}
    for path in sorted((ROOT / "docs" / "decisions").glob("*.md")):
        if path.name in ("TEMPLATE.md", "README.md"):
            continue
        m = ADR_NAME.match(path.name)
        if not m:
            errors.append(f"{rel(path)}: ADR 文件名应为 NNNN-标题.md")
            continue
        if m.group(1) in seen:
            errors.append(f"{rel(path)}: ADR 编号 {m.group(1)} 与 {seen[m.group(1)].name} 重复")
        seen[m.group(1)] = path
        errors += check_sections(path, path.read_text(encoding="utf-8"), ADR_SECTIONS)

    debt = ROOT / "docs" / "quality" / "tech-debt.md"
    if debt.exists():
        errors += check_tech_debt_ids(debt, debt.read_text(encoding="utf-8"))

    agents = ROOT / "AGENTS.md"
    if agents.exists():
        lines = len(agents.read_text(encoding="utf-8").splitlines())
        if lines > AGENTS_MAX_LINES:
            errors.append(f"AGENTS.md 有 {lines} 行，超过 {AGENTS_MAX_LINES} 行上限；细节应移到 docs/")
    else:
        warnings.append("没有 AGENTS.md")

    for w in warnings:
        print(f"警告：{w}")
    for e in errors:
        print(f"错误：{e}")
    if errors:
        print(f"文档检查失败：{len(errors)} 个错误")
        return 1
    print("文档检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
