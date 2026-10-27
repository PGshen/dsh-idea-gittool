// 统一模式 diff 主体（设计 §9.2/§9.5）：hunk 头可折叠、旧/新行号列、+/- 标记、
// 增删行用 --dsw-alias-file-diff-* token；行按固定行高虚拟化，只渲染可视区附近的行。
import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { CodeHighlighter, HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import type { KeyboardEvent } from 'react'
import type { DiffHunk, DiffLine } from '../../shared/protocol.ts'
import { changeAnchors, foldContext, pairChanges, splitRows } from '../diff/diff-views.ts'
import type { SplitRow } from '../diff/diff-views.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import css from './DiffHunks.module.css'

/** 固定行高（px）：虚拟化按它估算总高度。 */
export const DIFF_ROW_HEIGHT = 20
/** 可视区上下额外渲染的行数。 */
const OVERSCAN = 20

export interface DiffHunkRow {
  kind: 'hunk'
  hunkIndex: number
  header: string
  collapsed: boolean
  lineCount: number
}

export interface DiffLineRow {
  kind: 'line'
  hunkIndex: number
  lineIndex: number
  line: DiffLine
  /** B3b: changed-word ranges of this line. */
  words?: [number, number][]
}

/** B3b: a folded run of unchanged lines (`start` is the line index in the hunk). */
export interface DiffFoldRow {
  kind: 'fold'
  hunkIndex: number
  start: number
  count: number
}

/** B3b: one side-by-side row. */
export interface DiffSplitRowData {
  kind: 'split'
  hunkIndex: number
  row: SplitRow
  leftWords?: [number, number][]
  rightWords?: [number, number][]
}

export type DiffRow = DiffHunkRow | DiffLineRow | DiffFoldRow | DiffSplitRowData

export interface DiffRowOptions {
  mode?: 'unified' | 'split'
  /** Opened folds as `<hunkIndex>:<start>`. */
  expandedFolds?: ReadonlySet<string>
}

/**
 * 把 hunk 列表展开成虚拟列表的行：每个 hunk 一行头，未折叠时跟着它的代码行（B3b：长段未改内容折叠、
 * 并排模式成对、行内变更词）。
 * @param hunks - 服务端返回的 hunk。
 * @param collapsed - 已折叠的 hunk 下标。
 * @returns 扁平行数组。
 */
export function buildDiffRows(hunks: readonly DiffHunk[], collapsed: ReadonlySet<number>, options: DiffRowOptions = {}): DiffRow[] {
  const rows: DiffRow[] = []
  const expanded = options.expandedFolds ?? new Set<string>()
  hunks.forEach((hunk, hunkIndex) => {
    const isCollapsed = collapsed.has(hunkIndex)
    rows.push({ kind: 'hunk', hunkIndex, header: hunk.header, collapsed: isCollapsed, lineCount: hunk.lines.length })
    if (isCollapsed) return
    const words = pairChanges(hunk.lines)
    const opened = new Set([...expanded].filter(key => key.startsWith(`${String(hunkIndex)}:`)).map(key => Number(key.split(':')[1])))
    const segments = foldContext(hunk.lines, opened)
    const pairs = options.mode === 'split' ? splitRows(hunk.lines) : []
    for (const segment of segments) {
      if (segment.kind === 'fold') {
        rows.push({ kind: 'fold', hunkIndex, start: segment.start, count: segment.count })
        continue
      }
      if (options.mode === 'split') {
        for (const row of pairs) {
          const at = row.leftIndex ?? row.rightIndex ?? -1
          if (at < segment.start || at >= segment.end) continue
          const data: DiffSplitRowData = { kind: 'split', hunkIndex, row }
          const left = row.leftIndex === undefined || row.left === row.right ? undefined : words.get(row.leftIndex)
          const right = row.rightIndex === undefined || row.left === row.right ? undefined : words.get(row.rightIndex)
          if (left !== undefined) data.leftWords = left
          if (right !== undefined) data.rightWords = right
          rows.push(data)
        }
        continue
      }
      for (let lineIndex = segment.start; lineIndex < segment.end; lineIndex += 1) {
        const line = hunk.lines[lineIndex]
        if (line === undefined) continue
        const row: DiffLineRow = { kind: 'line', hunkIndex, lineIndex, line }
        const marked = words.get(lineIndex)
        if (marked !== undefined) row.words = marked
        rows.push(row)
      }
    }
  })
  return rows
}

/** Row indexes where a change block starts (targets of `n` / `p`). */
export function anchorRows(rows: readonly DiffRow[], hunks: readonly DiffHunk[]): number[] {
  const anchors = new Map(hunks.map((hunk, index) => [index, new Set(changeAnchors(hunk.lines))]))
  const result: number[] = []
  rows.forEach((row, index) => {
    const lineIndex = row.kind === 'line' ? row.lineIndex : row.kind === 'split' ? (row.row.leftIndex ?? row.row.rightIndex) : undefined
    if (lineIndex !== undefined && anchors.get(row.hunkIndex)?.has(lineIndex) === true) result.push(index)
  })
  return result
}

/** The anchor `n` (delta 1) or `p` (delta -1) moves to from row `current`; stays at the ends; null without anchors. */
export function nextAnchorRow(anchors: readonly number[], current: number, delta: 1 | -1): number | null {
  if (anchors.length === 0) return null
  if (delta === 1) return anchors.find(anchor => anchor > current) ?? anchors.at(-1) ?? null
  return [...anchors].reverse().find(anchor => anchor < current) ?? anchors[0] ?? null
}

export interface HunkHeaderRowProps {
  t: Translate
  hunkIndex: number
  header: string
  collapsed: boolean
  lineCount: number
  onToggle: (hunkIndex: number) => void
  style?: CSSProperties
}

/**
 * hunk 头行：点击折叠/展开该 hunk（无 hook）。
 * @param props - hunk 下标、原始头、折叠状态与切换回调。
 * @returns hunk 头按钮。
 */
export function HunkHeaderRow({ t, hunkIndex, header, collapsed, lineCount, onToggle, style }: HunkHeaderRowProps): ReactNode {
  return (
    <button
      type="button"
      className={css.hunkHeader}
      style={style}
      data-hunk-header={hunkIndex}
      aria-expanded={!collapsed}
      title={t(collapsed ? 'diff.hunk.expand' : 'diff.hunk.collapse')}
      onClick={() => onToggle(hunkIndex)}
    >
      <span className={css.chevron} aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      <span className={css.hunkText}>{header}</span>
      {collapsed ? <span className={css.hunkCount}>{t('diff.hunk.lines', { count: lineCount })}</span> : null}
    </button>
  )
}

const MARKER: Record<DiffLine['type'], string> = { add: '+', del: '-', context: ' ' }
const LINE_CLASS: Record<DiffLine['type'], string | undefined> = {
  add: css.added,
  del: css.deleted,
  context: undefined,
}

/** One line of code, highlighted when spans are given (shared with the B2 blame view). */
export function LineCode({ text, spans, words }: { text: string; spans: HighlightSpan[] | undefined; words?: [number, number][] | undefined }): ReactNode {
  const pieces = spans ?? [{ text, style: undefined }]
  if (words === undefined || words.length === 0) {
    if (spans === undefined) return <span className={css.code}>{text}</span>
    return (
      <span className={css.code}>
        {spans.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)}
      </span>
    )
  }
  // B3b: cut syntax spans at the changed-word boundaries so both colors and word marks show.
  const out: ReactNode[] = []
  let offset = 0
  pieces.forEach((span, spanIndex) => {
    const start = offset
    const end = offset + span.text.length
    offset = end
    const cuts = new Set([start, end])
    for (const [from, to] of words) {
      if (from > start && from < end) cuts.add(from)
      if (to > start && to < end) cuts.add(to)
    }
    const points = [...cuts].sort((a, b) => a - b)
    for (let at = 0; at < points.length - 1; at += 1) {
      const from = points[at] ?? start
      const to = points[at + 1] ?? end
      const piece = span.text.slice(from - start, to - start)
      const marked = words.some(([wordStart, wordEnd]) => from >= wordStart && to <= wordEnd)
      const key = `${String(spanIndex)}:${String(from)}`
      out.push(marked
        ? <mark key={key} className={css.word} style={span.style}>{piece}</mark>
        : <span key={key} style={span.style}>{piece}</span>)
    }
  })
  return <span className={css.code}>{out}</span>
}

function LineRow({ line, spans, words, style }: { line: DiffLine; spans: HighlightSpan[] | undefined; words?: [number, number][] | undefined; style: CSSProperties }): ReactNode {
  const typeClass = LINE_CLASS[line.type]
  return (
    <div
      className={typeClass === undefined ? css.line : `${css.line} ${typeClass}`}
      style={style}
      data-line-type={line.type}
      data-old-line={line.oldLine}
      data-new-line={line.newLine}
    >
      <span className={css.gutter}>{line.oldLine ?? ''}</span>
      <span className={css.gutter}>{line.newLine ?? ''}</span>
      <span className={css.marker} data-marker>{MARKER[line.type]}</span>
      <LineCode text={line.text} spans={spans} words={words} />
    </div>
  )
}

/** One half of a split row: its line number, marker and code, or an empty pad. */
function SplitHalf({ line, number, spans, words }: { line: DiffLine | undefined; number: number | undefined; spans: HighlightSpan[] | undefined; words: [number, number][] | undefined }): ReactNode {
  if (line === undefined) return <span className={`${css.half} ${css.pad}`} data-pad />
  const typeClass = LINE_CLASS[line.type]
  return (
    <span className={typeClass === undefined ? css.half : `${css.half} ${typeClass}`} data-line-type={line.type}>
      <span className={css.gutter}>{number ?? ''}</span>
      <span className={css.marker}>{MARKER[line.type]}</span>
      <LineCode text={line.text} spans={spans} words={words} />
    </span>
  )
}

export interface DiffHunksProps {
  hunks: DiffHunk[]
  /** 语法高亮器（ui-primitives 的 useCodeHighlighter）；返回 undefined 时纯文本。 */
  highlighter?: CodeHighlighter
  /** 初始折叠的 hunk 下标。 */
  initialCollapsedHunks?: number[]
  /** 首帧（含 SSR/测试）假定的可视高度；真实 DOM 挂载后以测量为准。 */
  viewportHeight?: number
  /** 初始滚动位置（切回文件时恢复，设计 §9.4「每个文件独立」）。 */
  initialScrollTop?: number
  onScrollTopChange?: (scrollTop: number) => void
  /** B3b：统一或并排。 */
  mode?: 'unified' | 'split'
}

/**
 * 渲染统一模式 diff 主体（自带滚动容器，只渲染可视行）。
 * @param props - hunk、高亮器与折叠/滚动初值。
 * @returns 虚拟化的 diff 列表。
 */
export function DiffHunks({
  hunks,
  highlighter,
  initialCollapsedHunks,
  viewportHeight = 600,
  initialScrollTop = 0,
  onScrollTopChange,
  mode = 'unified',
}: DiffHunksProps): ReactNode {
  const t = useT()
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set(initialCollapsedHunks ?? []))
  const [expandedFolds, setExpandedFolds] = useState<ReadonlySet<string>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(() => buildDiffRows(hunks, collapsed, { mode, expandedFolds }), [hunks, collapsed, mode, expandedFolds])
  const anchors = useMemo(() => anchorRows(rows, hunks), [rows, hunks])

  // 每个 hunk 作为一个片段整体高亮（保留跨行语法状态），按需计算并缓存。
  const highlightCache = useMemo(() => new Map<number, HighlightSpan[][] | undefined>(), [hunks, highlighter])
  const spansFor = (hunkIndex: number, lineIndex: number): HighlightSpan[] | undefined => {
    if (highlighter === undefined) return undefined
    if (!highlightCache.has(hunkIndex)) {
      const hunk = hunks[hunkIndex]
      highlightCache.set(hunkIndex, hunk === undefined ? undefined : highlighter(hunk.lines.map(line => line.text).join('\n')))
    }
    return highlightCache.get(hunkIndex)?.[lineIndex]
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DIFF_ROW_HEIGHT,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: viewportHeight },
    initialOffset: initialScrollTop,
  })

  // B3b `n` / `p` (design §9.4): next / previous change block from the first visible row.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'n' && event.key !== 'p')) return
    const first = virtualizer.getVirtualItems().find(item => item.start >= (scrollRef.current?.scrollTop ?? 0))?.index ?? 0
    const target = nextAnchorRow(anchors, first, event.key === 'n' ? 1 : -1)
    if (target === null) return
    event.preventDefault()
    virtualizer.scrollToIndex(target, { align: 'start' })
  }

  const toggle = (hunkIndex: number): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(hunkIndex)) next.delete(hunkIndex)
      else next.add(hunkIndex)
      return next
    })
  }

  return (
    <div
      ref={scrollRef}
      className={css.scroller}
      data-diff-hunks
      data-row-count={rows.length}
      data-mode={mode}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={onScrollTopChange === undefined ? undefined : event => onScrollTopChange(event.currentTarget.scrollTop)}
    >
      <div className={css.canvas} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (row === undefined) return null
          const style: CSSProperties = { transform: `translateY(${item.start}px)`, height: DIFF_ROW_HEIGHT }
          if (row.kind === 'hunk') {
            return (
              <HunkHeaderRow
                key={`h${row.hunkIndex}`}
                t={t}
                hunkIndex={row.hunkIndex}
                header={row.header}
                collapsed={row.collapsed}
                lineCount={row.lineCount}
                onToggle={toggle}
                style={style}
              />
            )
          }
          if (row.kind === 'fold') {
            const key = `${String(row.hunkIndex)}:${String(row.start)}`
            return (
              <button
                key={`f${key}`}
                type="button"
                className={css.fold}
                style={style}
                data-fold={key}
                onClick={() => { setExpandedFolds(current => new Set([...current, key])) }}
              >
                {t('diff.fold.expand', { count: row.count })}
              </button>
            )
          }
          if (row.kind === 'split') {
            const { left, right, leftIndex, rightIndex } = row.row
            return (
              <div key={`s${row.hunkIndex}:${String(leftIndex ?? '')}:${String(rightIndex ?? '')}`} className={css.splitRow} style={style} data-split-row>
                <SplitHalf line={left} number={left?.oldLine} spans={leftIndex === undefined ? undefined : spansFor(row.hunkIndex, leftIndex)} words={row.leftWords} />
                <SplitHalf line={right} number={right?.newLine} spans={rightIndex === undefined ? undefined : spansFor(row.hunkIndex, rightIndex)} words={row.rightWords} />
              </div>
            )
          }
          return (
            <LineRow
              key={`l${row.hunkIndex}:${row.lineIndex}`}
              line={row.line}
              spans={spansFor(row.hunkIndex, row.lineIndex)}
              words={row.words}
              style={style}
            />
          )
        })}
      </div>
    </div>
  )
}
