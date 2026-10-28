// B3b T5: enhanced diff viewer — split rows, folding, word marks, n/p stepping, options, persisted mode.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DiffHunks, buildDiffRows, displayColumns, nextAnchorRow, widestLines } from '../../../src/client/pages/DiffHunks.tsx'
import { DiffViewerHeader, diffContentKey } from '../../../src/client/pages/DiffViewer.tsx'
import { DIFF_SETTINGS_KEY, readDiffMode, writeDiffMode } from '../../../src/client/settings.ts'
import { createDiffStore, createDiffViewerController } from '../../../src/client/store/diff-store.ts'
import type { DiffHunk, DiffLine, DiffRequest, DiffFileValue, RpcResult } from '../../../src/shared/protocol.ts'
import { withLocale, zhT } from '../i18n-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const ctx = (text: string, oldLine: number, newLine: number): DiffLine => ({ type: 'context', text, oldLine, newLine })

function longHunk(): DiffHunk {
  const lines: DiffLine[] = [
    ...Array.from({ length: 12 }, (_, index) => ctx(`c${String(index)}`, index + 1, index + 1)),
    { type: 'del', text: 'const total = price * count', oldLine: 13 },
    { type: 'add', text: 'const total = price * amount', newLine: 13 },
    { type: 'add', text: 'const extra = 1', newLine: 14 },
    ctx('end', 14, 15),
  ]
  return { header: '@@ -1,14 +1,14 @@', oldStart: 1, oldLines: 14, newStart: 1, newLines: 14, lines }
}

describe('buildDiffRows (B3b)', () => {
  it('folds long context, expands on demand, and carries word ranges in unified mode', () => {
    const rows = buildDiffRows([longHunk()], new Set())
    expect(rows.map(row => row.kind)).toEqual(['hunk', 'fold', 'line', 'line', 'line', 'line', 'line', 'line', 'line'])
    expect(rows[1]).toMatchObject({ kind: 'fold', hunkIndex: 0, start: 0, count: 9 })
    const del = rows.find(row => row.kind === 'line' && row.line.type === 'del')
    expect(del).toMatchObject({ words: [[22, 27]] })
    const expanded = buildDiffRows([longHunk()], new Set(), { expandedFolds: new Set(['0:0']) })
    expect(expanded.filter(row => row.kind === 'line')).toHaveLength(16)
  })

  it('pairs deletions and additions side by side in split mode', () => {
    const rows = buildDiffRows([longHunk()], new Set(), { mode: 'split' })
    const pair = rows.find(row => row.kind === 'split' && row.row.left?.type === 'del')
    expect(pair).toMatchObject({ kind: 'split', row: { left: { text: 'const total = price * count' }, right: { text: 'const total = price * amount' } }, leftWords: [[22, 27]], rightWords: [[22, 28]] })
    expect(rows.filter(row => row.kind === 'split')).toHaveLength(6)
  })
})

describe('nextAnchorRow', () => {
  it('steps between change blocks without leaving the ends', () => {
    expect(nextAnchorRow([3, 10, 20], 0, 1)).toBe(3)
    expect(nextAnchorRow([3, 10, 20], 3, 1)).toBe(10)
    expect(nextAnchorRow([3, 10, 20], 20, 1)).toBe(20)
    expect(nextAnchorRow([3, 10, 20], 12, -1)).toBe(10)
    expect(nextAnchorRow([3, 10, 20], 3, -1)).toBe(3)
    expect(nextAnchorRow([], 5, 1)).toBeNull()
  })
})

describe('DiffHunks rendering (B3b)', () => {
  it('renders word marks, a fold button and split halves', () => {
    const unified = renderToStaticMarkup(withLocale(<DiffHunks hunks={[longHunk()]} viewportHeight={600} />))
    expect(unified).toContain('data-fold')
    expect(unified).toContain('展开 9 行未改内容')
    expect(unified).toContain('<mark')
    const split = renderToStaticMarkup(withLocale(<DiffHunks hunks={[longHunk()]} viewportHeight={600} mode="split" />))
    expect(split).toContain('data-split-row')
    expect(split).toContain('data-pad')
  })
})

describe('DiffViewerHeader toggles (B3b)', () => {
  const base = {
    t: zhT, path: 'a.ts', status: undefined, source: [], files: [], position: { index: -1, total: 0, hasPrev: false, hasNext: false },
    onClose: () => {}, onPrev: () => {}, onNext: () => {}, onSelectFile: () => {}, onCopy: () => {},
  }
  it('offers unified/split, ignore whitespace and full file; split is disabled when narrow', () => {
    const narrow = renderToStaticMarkup(withLocale(
      <DiffViewerHeader {...base} options={{ mode: 'unified', splitAvailable: false, ignoreWhitespace: true, fullFile: false }} onOptions={() => {}} />,
    ))
    expect(narrow).toMatch(/<button[^>]*disabled=""[^>]*title="需要更宽的面板（可用右上角全屏）"[^>]*>并排/)
    expect(narrow).toMatch(/aria-pressed="true"[^>]*>忽略空白/)
    expect(narrow).toContain('完整文件')
  })
})

describe('diff options in the controller (B3b)', () => {
  it('reopens the current file with the options and keeps them across file switches', async () => {
    const calls: DiffRequest[] = []
    const store = createDiffStore({ load: async (request): Promise<RpcResult<DiffFileValue>> => {
      calls.push(request)
      return { ok: true, value: { oldPath: request.path, newPath: request.path, status: 'M', binary: false, hunks: [], truncated: false } }
    } })
    const files = [{ path: 'a.ts', status: 'M' as const }, { path: 'b.ts', status: 'M' as const }]
    const controller = createDiffViewerController({ store, files, onClose: () => {} })
    await controller.start({ sessionId: 's', path: 'a.ts', scope: 'worktree' })
    await controller.setOptions({ ignoreWhitespace: true, context: 'full' })
    expect(calls.at(-1)).toMatchObject({ path: 'a.ts', ignoreWhitespace: true, context: 'full' })
    await controller.next()
    expect(calls.at(-1)).toMatchObject({ path: 'b.ts', ignoreWhitespace: true, context: 'full' })
    await controller.setOptions({ ignoreWhitespace: false, context: 'default' })
    expect(calls.at(-1)).not.toHaveProperty('ignoreWhitespace')
  })
})

describe('persisted diff mode (B3b)', () => {
  it('reads and writes the mode under the settings key and survives broken storage', () => {
    const values: Record<string, string> = {}
    vi.stubGlobal('localStorage', { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value } })
    expect(readDiffMode()).toBe('unified')
    writeDiffMode('split')
    expect(JSON.parse(values[DIFF_SETTINGS_KEY] ?? '{}')).toMatchObject({ diffMode: 'split' })
    expect(readDiffMode()).toBe('split')
    values[DIFF_SETTINGS_KEY] = 'not json'
    expect(readDiffMode()).toBe('unified')
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    expect(readDiffMode()).toBe('unified')
    expect(() => { writeDiffMode('split') }).not.toThrow()
    expect(DIFF_SETTINGS_KEY).toBe('dsh-idea-git.settings.v1')
  })
})

describe('diff content identity (B3b review I5)', () => {
  it('changes with the diff options so per-file view state resets', () => {
    const base = { sessionId: 's', path: 'a.ts', scope: 'worktree' as const }
    expect(diffContentKey(base)).not.toBe(diffContentKey({ ...base, ignoreWhitespace: true }))
    expect(diffContentKey(base)).not.toBe(diffContentKey({ ...base, context: 'full' }))
    expect(diffContentKey(base)).toBe(diffContentKey({ ...base }))
  })
})

describe('horizontal scrolling', () => {
  const wide = (): DiffHunk => ({
    header: '@@ -1,2 +1,2 @@', oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
    lines: [{ type: 'del', text: 'x', oldLine: 1 }, { type: 'add', text: `${'a'.repeat(200)}中文`, newLine: 1 }, ctx('y', 2, 2)],
  })

  it('counts display columns: tabs to the next stop of 8, wide characters as two', () => {
    expect(displayColumns('abc')).toBe(3)
    expect(displayColumns('中文')).toBe(4)
    expect(displayColumns('\tx')).toBe(9)
    expect(displayColumns('ab\tc')).toBe(9)
    expect(displayColumns('')).toBe(0)
  })

  it('picks the lines worth measuring: the widest by columns, tabs expanded to spaces', () => {
    expect(widestLines(['a', '\tb', 'ccc', '中文中'], 2)).toEqual(['        b', '中文中'])
    expect(widestLines([], 3)).toEqual([])
  })

  it('makes the unified canvas as wide as the longest line, so every row background reaches the end', () => {
    const html = renderToStaticMarkup(withLocale(<DiffHunks hunks={[wide()]} viewportHeight={600} />))
    expect(html).toContain('min-width:calc(124px + 204ch)')
    expect(html).not.toContain('data-diff-hscroll')
  })

  it('gives split mode its own horizontal scrollbar sized to the longest line, with code clipped per half', () => {
    const html = renderToStaticMarkup(withLocale(<DiffHunks hunks={[wide()]} viewportHeight={600} mode="split" />))
    expect(html).toContain('data-diff-hscroll')
    expect(html).toContain('width:calc(50% + 204ch + 76px)')
    expect(html).toContain('data-code-clip')
  })
})
