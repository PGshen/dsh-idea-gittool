// T4 rendering: page tabs badge, changes tree rows/menu, title dot states.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { zhT } from '../i18n-helpers.tsx'
import { GitTitleView, titleDot } from '../../../src/client/GitTitle.tsx'
import {
  ChangeContextMenu,
  ChangesTree,
  nextFocus,
  overallCheck,
  visibleFiles,
} from '../../../src/client/pages/ChangesTree.tsx'
import { PageTabs, adjacentPage, badgeText } from '../../../src/client/pages/PageTabs.tsx'
import { buildChangeGroups, collectChanges, createChangesStore } from '../../../src/client/store/changes-store.ts'
import type { BootstrapValue } from '../../../src/shared/protocol.ts'
import { entry, mixedStatus, statusFixture } from './changes-fixtures.ts'

function bootstrap(status: BootstrapValue['status']): BootstrapValue {
  return { sessionId: 's', repoRoot: '/repo', status, writePolicy: { mode: 'read-write' }, version: 1 }
}

describe('PageTabs', () => {
  it('renders log/commit tabs with the badge on commit', () => {
    const html = renderToStaticMarkup(<PageTabs page="log" onChange={() => {}} uncommittedCount={8} />)
    expect(html).toContain('role="tablist"')
    expect(html).toContain('data-page="log"')
    expect(html).toContain('data-page="commit"')
    expect(html).toMatch(/data-page="log"[^>]*>|aria-selected="true"/)
    expect(html).toContain('data-badge="8"')
    expect(html).toContain('>日志<')
    expect(html).not.toContain('分支')
    expect(html).not.toContain('贮藏')
  })

  it('hides the badge at 0 and caps at 99+', () => {
    expect(renderToStaticMarkup(<PageTabs page="commit" onChange={() => {}} uncommittedCount={0} />)).not.toContain('data-badge')
    expect(badgeText(0)).toBeNull()
    expect(badgeText(5)).toBe('5')
    expect(badgeText(120)).toBe('99+')
  })

  it('arrow keys wrap between pages', () => {
    expect(adjacentPage('log', 'ArrowRight')).toBe('commit')
    expect(adjacentPage('commit', 'ArrowRight')).toBe('log')
    expect(adjacentPage('log', 'ArrowLeft')).toBe('commit')
    expect(adjacentPage('log', 'x')).toBeNull()
  })
})

describe('titleDot', () => {
  it('no dot for a clean tree or before the first load', () => {
    expect(titleDot(null, zhT)).toBeNull()
    expect(titleDot(bootstrap(null), zhT)).toBeNull()
    expect(titleDot(bootstrap(statusFixture()), zhT)).toBeNull()
  })

  it('brand dot with the uncommitted count', () => {
    const dot = titleDot(bootstrap(statusFixture({ unstaged: [entry('a', 'M')], staged: [entry('a', 'M')], untracked: [entry('b', '?')] })), zhT)
    expect(dot).toEqual({ tone: 'brand', tooltip: '2 个未提交文件' })
  })

  it('warning dot for conflicts or an operation in progress', () => {
    expect(titleDot(bootstrap(statusFixture({ operation: 'merge', conflicts: [entry('a', 'U'), entry('b', 'U')] })), zhT))
      .toEqual({ tone: 'warning', tooltip: '合并进行中 · 2 个冲突' })
    expect(titleDot(bootstrap(statusFixture({ operation: 'rebase' })), zhT))
      .toEqual({ tone: 'warning', tooltip: '变基进行中' })
  })

  it('GitTitleView renders the dot only when present', () => {
    expect(renderToStaticMarkup(<GitTitleView title="Git" dot={null} />)).toBe('Git')
    const html = renderToStaticMarkup(<GitTitleView title="Git" dot={{ tone: 'warning', tooltip: '变基进行中' }} />)
    expect(html).toContain('data-git-title-dot="warning"')
    expect(html).toContain('title="变基进行中"')
  })
})

describe('ChangesTree', () => {
  function render(setup: (store: ReturnType<typeof createChangesStore>) => void = () => {}, writeDisabled = false): string {
    const store = createChangesStore({ initialChecked: 'none' })
    setup(store)
    return renderToStaticMarkup(
      <ChangesTree state={store.getState()} store={store} writeDisabled={writeDisabled} onOpenDiff={() => {}} />,
    )
  }

  it('shows loading before the first status and empty state for a clean tree', () => {
    expect(render()).toContain('读取中…')
    expect(render(store => store.setStatus(statusFixture()))).toContain('没有未提交的改动')
  })

  it('renders groups in order, rows with status letter, counts (not for untracked)', () => {
    const html = render(store => store.setStatus(mixedStatus()))
    const order = ['conflicts', 'modified', 'added', 'deleted', 'renamed', 'untracked'].map(kind => html.indexOf(`data-change-group="${kind}"`))
    expect(order.every((at, index) => at > -1 && (index === 0 || at > (order[index - 1] ?? 0)))).toBe(true)
    expect(html).toContain('data-path="src/client/log/LogTable.tsx"')
    expect(html).toContain('+128 −32')
    expect(html).toContain('data-status="?"')
    const untrackedRow = html.slice(html.indexOf('data-path="scratch.md"'))
    expect(untrackedRow.slice(0, untrackedRow.indexOf('</div>'))).not.toContain('+')
    expect(html).toContain('title="docs/old.md → docs/renamed.md"')
  })

  it('conflict rows have a disabled checkbox with the hint', () => {
    const html = render(store => store.setStatus(mixedStatus()))
    const conflictRow = html.slice(html.indexOf('data-path="src/merge.ts"'))
    expect(conflictRow).toMatch(/^[^]*?disabled=""[^>]*title="冲突文件需要先解决/)
  })

  it('tri-state checkboxes reflect checks (mixed on partially checked dirs)', () => {
    const html = render((store) => {
      store.setStatus(mixedStatus())
      store.toggleFile('src/both.ts')
    })
    expect(html).toContain('aria-checked="mixed"')
    expect(html).toContain('已选 1')
  })

  it('search without matches shows the no-match hint', () => {
    const html = render((store) => {
      store.setStatus(mixedStatus())
      store.setSearch('zzz')
    })
    expect(html).toContain('没有路径包含「zzz」的文件')
  })

  it('visibleFiles / nextFocus / overallCheck', () => {
    const changes = collectChanges(mixedStatus())
    const groups = buildChangeGroups(changes, { checked: new Set(['README.md']) })
    const rows = visibleFiles(groups)
    expect(rows.map(row => row.entry.path)[0]).toBe('src/merge.ts')
    expect(nextFocus(rows, null, 'ArrowDown')).toBe('src/merge.ts')
    expect(nextFocus(rows, 'src/merge.ts', 'ArrowDown')).toBe(rows[1]?.entry.path)
    expect(nextFocus(rows, 'src/merge.ts', 'ArrowUp')).toBe('src/merge.ts')
    expect(nextFocus(rows, null, 'End')).toBe('scratch.md')
    expect(nextFocus(rows, null, 'a')).toBeNull()
    expect(overallCheck(groups)).toBe('some')
    expect(overallCheck(buildChangeGroups(changes, { checked: new Set() }))).toBe('none')
  })
})

describe('ChangeContextMenu', () => {
  const changes = collectChanges(mixedStatus())
  const find = (path: string) => {
    const found = changes.find(change => change.path === path)
    if (found === undefined) throw new Error(path)
    return found
  }
  const noop = () => {}

  it('tracked file: commit, rollback, copy (no add to VCS)', () => {
    const html = renderToStaticMarkup(
      <ChangeContextMenu entry={find('README.md')} writeDisabled={false} onCommitFile={noop} onRollback={noop} onAddToVcs={noop} onCopyPath={noop} />,
    )
    expect(html).toContain('提交此文件…')
    expect(html).toContain('回滚此文件…')
    expect(html).toContain('复制路径')
    expect(html).not.toContain('加入 VCS')
    expect(html).not.toMatch(/data-menu="commit"[^>]*disabled|disabled=""[^>]*data-menu="commit"/)
  })

  it('untracked file offers add to VCS; write actions disabled when read-only', () => {
    const html = renderToStaticMarkup(
      <ChangeContextMenu entry={find('scratch.md')} writeDisabled onCommitFile={noop} onRollback={noop} onAddToVcs={noop} onCopyPath={noop} />,
    )
    expect(html).toContain('加入 VCS')
    for (const name of ['commit', 'rollback', 'add']) expect(html).toMatch(new RegExp(`disabled=""[^>]*data-menu="${name}"`))
    expect(html).not.toMatch(/disabled=""[^>]*data-menu="copy"/)
  })

  it('conflict file cannot be committed or rolled back here', () => {
    const html = renderToStaticMarkup(
      <ChangeContextMenu entry={find('src/merge.ts')} writeDisabled={false} onCommitFile={noop} onRollback={noop} onCopyPath={noop} />,
    )
    expect(html).toMatch(/disabled=""[^>]*data-menu="conflict"/)
    expect(html).toMatch(/disabled=""[^>]*data-menu="rollback"/)
    expect(html).not.toContain('提交此文件…')
  })
})
