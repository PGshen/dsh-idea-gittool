// 统一模式 diff 主体（设计 §9.2/§9.5）：hunk 头可折叠、旧/新行号列、+/- 标记、
// 增删行用 --dsw-alias-file-diff-* token；行按固定行高虚拟化，只渲染可视区附近的行。
import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { CodeHighlighter, HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DiffHunk, DiffLine } from '../../shared/protocol.ts'
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
}

export type DiffRow = DiffHunkRow | DiffLineRow

/**
 * 把 hunk 列表展开成虚拟列表的行：每个 hunk 一行头，未折叠时跟着它的代码行。
 * @param hunks - 服务端返回的 hunk。
 * @param collapsed - 已折叠的 hunk 下标。
 * @returns 扁平行数组。
 */
export function buildDiffRows(hunks: readonly DiffHunk[], collapsed: ReadonlySet<number>): DiffRow[] {
  const rows: DiffRow[] = []
  hunks.forEach((hunk, hunkIndex) => {
    const isCollapsed = collapsed.has(hunkIndex)
    rows.push({ kind: 'hunk', hunkIndex, header: hunk.header, collapsed: isCollapsed, lineCount: hunk.lines.length })
    if (isCollapsed) return
    hunk.lines.forEach((line, lineIndex) => rows.push({ kind: 'line', hunkIndex, lineIndex, line }))
  })
  return rows
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
export function LineCode({ text, spans }: { text: string; spans: HighlightSpan[] | undefined }): ReactNode {
  if (spans === undefined) return <span className={css.code}>{text}</span>
  return (
    <span className={css.code}>
      {spans.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)}
    </span>
  )
}

function LineRow({ line, spans, style }: { line: DiffLine; spans: HighlightSpan[] | undefined; style: CSSProperties }): ReactNode {
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
      <LineCode text={line.text} spans={spans} />
    </div>
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
}: DiffHunksProps): ReactNode {
  const t = useT()
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set(initialCollapsedHunks ?? []))
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(() => buildDiffRows(hunks, collapsed), [hunks, collapsed])

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
          return (
            <LineRow
              key={`l${row.hunkIndex}:${row.lineIndex}`}
              line={row.line}
              spans={spansFor(row.hunkIndex, row.lineIndex)}
              style={style}
            />
          )
        })}
      </div>
    </div>
  )
}
