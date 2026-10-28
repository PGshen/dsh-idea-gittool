// B2 T5：Blame 视图（静态渲染）、hover card、行段菜单项。
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BlameHoverCard } from '../../../src/client/pages/BlameHoverCard.tsx'
import { BlameView, blameSegmentActions, gutterLabel } from '../../../src/client/pages/BlameView.tsx'
import type { BlameViewProps } from '../../../src/client/pages/BlameView.tsx'
import type { BlameState } from '../../../src/client/store/blame-store.ts'
import type { BlameCommit, BlameValue } from '../../../src/shared/protocol.ts'
import { withLocale, zhT } from '../i18n-helpers.tsx'

const A = 'a1b2c3d'.padEnd(40, '0')
const ZERO = '0'.repeat(40)

const commitA: BlameCommit = {
  sha: A, shortSha: 'a1b2c3d', author: 'Alice', email: 'alice@example.com', date: '2026-10-24T10:00:00+08:00',
  subject: 'Add the table', uncommitted: false, boundary: false,
}
const uncommitted: BlameCommit = {
  sha: ZERO, shortSha: '0000000', author: 'Not Committed Yet', email: 'not.committed.yet', date: '2026-10-27T10:00:00+08:00',
  subject: 'Version of f.ts from f.ts', uncommitted: true, boundary: false,
}

function value(extra: Partial<BlameValue> = {}): BlameValue {
  return {
    path: 'src/f.ts', rev: null, totalLines: 3, start: 1, lines: ['one', 'two', 'three'],
    segments: [{ sha: A, start: 1, count: 2 }, { sha: ZERO, start: 3, count: 1 }],
    commits: { [A]: commitA, [ZERO]: uncommitted }, binary: false, tooLarge: false, version: 1, ...extra,
  }
}

function ready(extra: Partial<BlameState> = {}, valueExtra: Partial<BlameValue> = {}): BlameState {
  const v = value(valueExtra)
  return {
    target: { path: 'src/f.ts' }, status: 'ready', value: v,
    rows: [
      { line: 1, text: 'one', sha: A, segmentStart: true },
      { line: 2, text: 'two', sha: A, segmentStart: false },
      { line: 3, text: 'three', sha: ZERO, segmentStart: true },
    ],
    commits: v.commits, loadingMore: false, error: null, selectedSha: null, ...extra,
  }
}

const noop = (): void => undefined

function render(state: BlameState, extra: Partial<BlameViewProps> = {}): string {
  const props: BlameViewProps = {
    state, branch: 'main', compact: false, hovered: null, menu: null, diff: null, now: Date.parse('2026-10-27T12:00:00+08:00'),
    onBack: noop, onToggleCompact: noop, onLoadMore: noop, onRetry: noop, onSelect: noop, onOpenDiff: noop,
    onHover: noop, onMenu: noop, onCloseMenu: noop, onMenuAction: noop, onCloseDiff: noop, onCopyHash: noop,
    onShowInLog: noop, onFileHistory: noop,
    ...extra,
  }
  return renderToStaticMarkup(withLocale(<BlameView {...props} />))
}

describe('gutterLabel', () => {
  it('shows hash, date and author in detailed mode and the hash only in compact mode', () => {
    const now = Date.parse('2026-10-27T12:00:00+08:00')
    expect(gutterLabel(commitA, false, now, zhT)).toMatch(/^a1b2c3d · 10-24 \d\d:\d\d · Alice$/)
    expect(gutterLabel(commitA, true, now, zhT)).toBe('a1b2c3d')
    expect(gutterLabel(uncommitted, false, now, zhT)).toBe('未提交')
    expect(gutterLabel(undefined, false, now, zhT)).toBe('')
  })
})

describe('BlameView', () => {
  it('shows the commit once per segment, line numbers and text, and the header facts', () => {
    const html = render(ready())
    expect(html.match(/a1b2c3d/g)?.length).toBe(1)
    expect(html).toContain('未提交')
    for (const text of ['one', 'two', 'three']) expect(html).toContain(`>${text}<`)
    expect(html).toContain('src/f.ts')
    expect(html).toContain('main')
    expect(html).toContain('3 行')
    expect(html).toContain('data-blame-line="2"')
    expect(html).toContain('← 返回')
  })

  it('names the revision when blaming a commit and hides "back" inside the git.blame page', () => {
    const html = render(ready({}, { rev: A }), { onBack: undefined })
    expect(html).toContain('@ a1b2c3d')
    expect(html).not.toContain('← 返回')
  })

  it('offers "load more" while pages remain', () => {
    expect(render(ready({ next: 4 }, { totalLines: 5000 }))).toContain('加载更多（已显示 3 / 5000 行）')
    expect(render(ready({ next: 4, loadingMore: true }))).toContain('正在加载')
  })

  it('explains binary, too-large, untracked and missing files instead of a blank page', () => {
    expect(render(ready({ rows: [] }, { binary: true }))).toContain('二进制文件，无法逐行注解')
    const large = render(ready({ rows: [] }, { tooLarge: true, terminalCommand: 'git blame -- big.txt' }))
    expect(large).toContain('文件过大')
    expect(large).toContain('git blame -- big.txt')
    expect(render(ready({ rows: [] }, { unavailable: 'untracked' }))).toContain('文件还没有提交过')
    expect(render(ready({ rows: [] }, { unavailable: 'missing' }))).toContain('工作区里没有这个文件')
    expect(render(ready({ rows: [] }, { totalLines: 0 }))).toContain('空文件')
  })

  it('lets the host replace the untracked notice (B4a renderer shows the file text instead)', () => {
    const html = render(ready({ rows: [] }, { unavailable: 'untracked' }), { renderUntracked: () => <pre>RAW TEXT</pre> })
    expect(html).toContain('RAW TEXT')
    expect(html).not.toContain('文件还没有提交过')
  })

  it('shows no line count when the file is not annotated (L4)', () => {
    expect(render(ready({ rows: [] }, { binary: true, totalLines: 0 }))).not.toContain('0 行')
    expect(render(ready({ rows: [] }, { unavailable: 'missing', totalLines: 0 }))).not.toContain('0 行')
    expect(render(ready({ rows: [] }, { totalLines: 0 }))).toContain('0 行')
  })

  it('shows loading and error states', () => {
    expect(render({ ...ready(), status: 'loading', value: null, rows: [] })).toContain('正在加载 Blame')
    const failed = render({ ...ready(), status: 'error', value: null, rows: [], error: { code: 'git/exec-failed', message: 'boom' } })
    expect(failed).toContain('boom')
    expect(failed).toContain('重试')
  })

  it('shows the selected commit with its actions below the lines', () => {
    const html = render(ready({ selectedSha: A }))
    expect(html).toContain('Add the table')
    expect(html).toContain('查看此提交的改动')
    expect(html).toContain('在日志中显示')
    expect(html).toContain('复制哈希')
  })

  it('marks the rows of the selected and hovered segment', () => {
    const html = render(ready({ selectedSha: A }), { hovered: { sha: A, line: 1 } })
    expect(html.match(/data-selected="true"/g)?.length).toBe(2)
    expect(html).toContain('data-blame-hover')
  })

  it('the lines are one tab stop naming the active line (终审 I4)', () => {
    const html = render(ready())
    expect(html).toMatch(/role="listbox"[^>]*tabindex="0"|tabindex="0"[^>]*role="listbox"/u)
    expect(html).toContain('id="blame-line-1"')
  })

  it('renders the segment menu when open', () => {
    const html = render(ready(), { menu: { sha: A, anchor: { kind: 'point', x: 10, y: 20 } } })
    expect(html).toContain('role="menu"')
    expect(html).toContain('文件历史')
  })
})

describe('BlameHoverCard', () => {
  it('shows subject, author, time and the two actions', () => {
    const html = renderToStaticMarkup(withLocale(
      <BlameHoverCard commit={commitA} now={Date.parse('2026-10-27T12:00:00+08:00')} top={40} onCopyHash={noop} onShowInLog={noop} />,
    ))
    expect(html).toContain('Add the table')
    expect(html).toContain('Alice')
    expect(html).toContain('alice@example.com')
    expect(html).toContain('复制哈希')
    expect(html).toContain('在日志中显示')
  })

  it('explains uncommitted lines and offers no log action for them', () => {
    const html = renderToStaticMarkup(withLocale(
      <BlameHoverCard commit={uncommitted} now={0} top={0} onCopyHash={noop} onShowInLog={noop} />,
    ))
    expect(html).toContain('工作区里尚未提交的改动')
    expect(html).not.toContain('在日志中显示')
  })
})

describe('blameSegmentActions', () => {
  it('offers copy hash, show in log and file history; uncommitted lines only file history', () => {
    expect(blameSegmentActions(commitA).map(item => [item.id, item.disabledReason?.key])).toEqual([
      ['copyHash', undefined], ['showInLog', undefined], ['fileHistory', undefined],
    ])
    expect(blameSegmentActions(uncommitted).map(item => [item.id, item.disabledReason?.key])).toEqual([
      ['copyHash', 'blame.disabled.uncommitted'], ['showInLog', 'blame.disabled.uncommitted'], ['fileHistory', undefined],
    ])
  })
})
