// T7 状态栏：分支/detached、↑↓、工作区摘要、贮藏数、操作进度、刷新时间与自动刷新开关。
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { zhT } from '../i18n-helpers.tsx'
import { render as renderText } from '../../../src/client/localized-text.ts'
import { formatClock, StatusBar, summarizeWorktree } from '../../../src/client/pages/StatusBar.tsx'
import type { StatusBarProps } from '../../../src/client/pages/StatusBar.tsx'
import { statusFixture } from './branch-fixtures.ts'

const AT = new Date(2026, 9, 25, 12, 3, 9).getTime()

function render(overrides: Partial<StatusBarProps> = {}): string {
  const props: StatusBarProps = {
    status: statusFixture(),
    lastRefreshAt: AT,
    autoRefresh: true,
    onToggleAutoRefresh: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(<StatusBar {...props} />)
}

function summary(status: Parameters<typeof summarizeWorktree>[0]): { tone: string; text: string } {
  const value = summarizeWorktree(status)
  return { tone: value.tone, text: renderText(zhT, value.text) }
}

describe('summarizeWorktree', () => {
  it('冲突优先，其次修改数，没有改动给「无改动」', () => {
    expect(summary(statusFixture())).toEqual({ tone: 'changes', text: '3 个修改' })
    expect(summary(statusFixture({ unstaged: [], untracked: [] }))).toEqual({ tone: 'clean', text: '无改动' })
    expect(summary(statusFixture({ conflicts: [{ path: 'a', status: 'U' }, { path: 'b', status: 'U' }] })))
      .toEqual({ tone: 'conflict', text: '2 个冲突' })
  })

  it('截断时显示「n+ 个修改」', () => {
    expect(summary(statusFixture({ truncated: true })).text).toBe('3+ 个修改')
  })

  it('staged 与 unstaged 同一路径只计一次', () => {
    const status = statusFixture({ staged: [{ path: 'src/a.ts', status: 'M' }] })
    expect(summary(status).text).toBe('3 个修改')
  })
})

describe('formatClock', () => {
  it('输出 HH:mm:ss', () => {
    expect(formatClock(AT)).toBe('12:03:09')
  })
})

describe('StatusBar', () => {
  it('常规：分支、↑↓、修改数、刷新时间、自动刷新开关', () => {
    const html = render()
    expect(html).toContain('role="status"')
    expect(html).toContain('main')
    expect(html).toContain('↑1 ↓2')
    expect(html).toContain('3 个修改')
    expect(html).toContain('12:03:09')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('data-tone="changes"')
  })

  it('detached HEAD 用危险色并显示短哈希', () => {
    const html = render({ status: statusFixture({ branch: null, detached: true, head: 'deadbee1111' }) })
    expect(html).toContain('data-detached="true"')
    expect(html).toContain('detached')
    expect(html).toContain('deadbee')
  })

  it('无 ahead/behind 时不显示箭头', () => {
    const html = render({ status: statusFixture({ ahead: 0, behind: 0 }) })
    expect(html).not.toContain('↑')
    expect(html).not.toContain('↓')
  })

  it('冲突状态与操作进度', () => {
    const html = render({ status: statusFixture({ operation: 'rebase', conflicts: [{ path: 'a', status: 'U' }] }) })
    expect(html).toContain('1 个冲突')
    expect(html).toContain('data-tone="conflict"')
    expect(html).toContain('变基中')
  })

  it('贮藏数：未提供时显示占位，有值时显示数量', () => {
    expect(render()).toContain('data-stash="unknown"')
    const html = render({ stashCount: 2 })
    expect(html).toContain('2 个贮藏')
    expect(html).toContain('data-stash="2"')
  })

  it('自动刷新关闭、从未刷新与 Git 版本', () => {
    const html = render({ autoRefresh: false, lastRefreshAt: null, gitVersion: '2.45.1' })
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('尚未刷新')
    expect(html).toContain('Git 2.45.1')
  })

  it('status 为空时只显示占位且不崩', () => {
    const html = render({ status: null })
    expect(html).toContain('role="status"')
    expect(html).toContain('—')
  })
})
