// B2 T6：文件历史页与比较页（静态渲染与行动作项）。
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ComparePageView } from '../../../src/client/pages/ComparePage.tsx'
import type { ComparePageViewProps } from '../../../src/client/pages/ComparePage.tsx'
import { FileHistoryPageView, historyRowActions } from '../../../src/client/pages/FileHistoryPage.tsx'
import type { FileHistoryPageViewProps } from '../../../src/client/pages/FileHistoryPage.tsx'
import type { CompareState } from '../../../src/client/store/compare-store.ts'
import type { FileHistoryState } from '../../../src/client/store/file-history-store.ts'
import type { CommitSummary, FileHistoryEntry } from '../../../src/shared/protocol.ts'
import { withLocale } from '../i18n-helpers.tsx'

const A = 'a1b2c3d'.padEnd(40, '0')
const B = 'b2c3d4e'.padEnd(40, '0')
const NOW = Date.parse('2026-10-27T12:00:00+08:00')
const noop = (): void => undefined

function entry(sha: string, extra: Partial<FileHistoryEntry> = {}): FileHistoryEntry {
  return {
    sha, shortSha: sha.slice(0, 7), parents: [], author: 'Alice', email: 'a@x', date: '2026-10-24T10:00:00+08:00',
    subject: `subject ${sha.slice(0, 3)}`, path: 'src/new.ts', status: 'M', additions: 3, deletions: 1, ...extra,
  }
}

function historyState(extra: Partial<FileHistoryState> = {}): FileHistoryState {
  return {
    target: { path: 'src/new.ts' }, status: 'ready',
    entries: [entry(A), entry(B, { status: 'R', origPath: 'src/old.ts', path: 'src/new.ts', additions: 0, deletions: 0 })],
    followedRename: true, loadingMore: false, error: null, selectedSha: null, ...extra,
  }
}

function renderHistory(state: FileHistoryState, extra: Partial<FileHistoryPageViewProps> = {}): string {
  const props: FileHistoryPageViewProps = {
    state, diff: null, now: NOW, menu: null,
    onBack: noop, onLoadMore: noop, onRetry: noop, onSelect: noop, onMenu: noop, onCloseMenu: noop, onAction: noop,
    ...extra,
  }
  return renderToStaticMarkup(withLocale(<FileHistoryPageView {...props} />))
}

describe('FileHistoryPageView', () => {
  it('lists entries with subject, author, status and line counts, and the file in the title', () => {
    const html = renderHistory(historyState())
    expect(html).toContain('文件历史：src/new.ts')
    expect(html).toContain('subject a1b')
    expect(html).toContain('Alice')
    expect(html).toContain('data-status="R"')
    expect(html).toContain('+3')
    expect(html).toContain('−1')
    expect(html).toContain('src/old.ts → src/new.ts')
    expect(html).toContain('← 返回')
  })

  it('warns that history across a rename may be incomplete', () => {
    expect(renderHistory(historyState())).toContain('历史可能不连续')
    expect(renderHistory(historyState({ followedRename: false }))).not.toContain('历史可能不连续')
  })

  it('offers loading more, and explains empty, loading and error states', () => {
    expect(renderHistory(historyState({ next: 'v1:x:50' }))).toContain('加载更多')
    expect(renderHistory(historyState({ entries: [] }))).toContain('没有找到改动过这个文件的提交')
    expect(renderHistory({ ...historyState(), status: 'loading', entries: [] })).toContain('正在加载文件历史')
    const failed = renderHistory({ ...historyState(), status: 'error', entries: [], error: { code: 'git/exec-failed', message: 'boom' } })
    expect(failed).toContain('boom')
  })

  it('marks the selected entry and shows its diff below with the row actions', () => {
    const html = renderHistory(historyState({ selectedSha: A }), {
      diff: { request: { sessionId: 's', path: 'src/new.ts', scope: 'commit', sha: A }, status: 'ready', value: { oldPath: 'src/new.ts', newPath: 'src/new.ts', status: 'M', binary: false, hunks: [], truncated: false }, error: null },
    })
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('data-history-diff')
    expect(html).toContain('Blame（此版本）')
    expect(html).toContain('与工作区比较')
  })
})

describe('historyRowActions', () => {
  it('offers blame at the revision, compare with worktree, show in log and copy path', () => {
    expect(historyRowActions(entry(A)).map(item => [item.id, item.disabledReason?.key])).toEqual([
      ['blameRevision', undefined], ['compareWorktree', undefined], ['showInLog', undefined], ['copyPath', undefined],
    ])
  })

  it('cannot blame the revision that deleted the file', () => {
    const items = historyRowActions(entry(A, { status: 'D' }))
    expect(items.find(item => item.id === 'blameRevision')?.disabledReason?.key).toBe('history.disabled.deleted')
  })
})

function commit(sha: string): CommitSummary {
  return { sha, shortSha: sha.slice(0, 7), parents: [], author: 'Bob', email: 'b@x', date: '2026-10-25T10:00:00+08:00', subject: `commit ${sha.slice(0, 3)}` }
}

function compareState(right: string | null, extra: Partial<CompareState> = {}): CompareState {
  return {
    target: { left: 'feature', right },
    status: 'ready',
    value: { left: { input: 'feature', sha: A }, right: right === null ? null : { input: right, sha: B }, commits: right === null ? [] : [commit(A)], files: [{ path: 'src/a.ts', status: 'M', additions: 2, deletions: 0 }], filesTruncated: false },
    commits: right === null ? [] : [commit(A)],
    files: [{ path: 'src/a.ts', status: 'M', additions: 2, deletions: 0 }, { path: 'src/b.ts', origPath: 'src/old-b.ts', status: 'R' }],
    loadingMore: false, error: null, selectedPath: null, ...extra,
  }
}

function renderCompare(state: CompareState, extra: Partial<ComparePageViewProps> = {}): string {
  const props: ComparePageViewProps = {
    state, leftLabel: 'feature', rightLabel: state.target?.right ?? null, diff: null, now: NOW,
    onBack: noop, onSwap: noop, onLoadMore: noop, onRetry: noop, onSelectFile: noop, onShowInLog: noop,
    ...extra,
  }
  return renderToStaticMarkup(withLocale(<ComparePageView {...props} />))
}

describe('ComparePageView', () => {
  it('says which side has the commits, lists them and the changed files, and offers swap', () => {
    const html = renderCompare(compareState('main'))
    expect(html).toContain('feature 中有而 main 中没有的提交')
    expect(html).toContain('commit a1b')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('src/old-b.ts → src/b.ts')
    expect(html).toContain('交换')
    expect(html).toContain('差异文件（2）')
  })

  it('compares with the worktree: files only, no swap', () => {
    const html = renderCompare(compareState(null))
    expect(html).toContain('feature 与工作区的差异文件')
    expect(html).not.toContain('交换')
    expect(html).not.toContain('commit a1b')
  })

  it('explains no commits, no files, truncation and errors', () => {
    expect(renderCompare(compareState('main', { commits: [] }))).toContain('没有 feature 有而 main 没有的提交')
    expect(renderCompare(compareState('main', { files: [] }))).toContain('没有差异文件')
    const truncated = compareState('main')
    const html = renderCompare({ ...truncated, value: truncated.value === null ? null : { ...truncated.value, filesTruncated: true } })
    expect(html).toContain('只显示前')
    const failed = renderCompare({ ...compareState('main'), status: 'error', value: null, error: { code: 'git/invalid-payload', message: 'bad rev' } })
    expect(failed).toContain('bad rev')
  })

  it('shows the selected file diff in place', () => {
    const html = renderCompare(compareState('main', { selectedPath: 'src/a.ts' }), {
      diff: { request: { sessionId: 's', path: 'src/a.ts', scope: 'range', from: B, to: A, mergeBase: true }, status: 'loading', value: null, error: null },
    })
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('data-compare-diff')
  })
})
