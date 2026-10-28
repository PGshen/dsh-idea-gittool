// 日志表格的一行（设计 §8.1.3）：图 ｜ 主题 + refs ｜ 作者 ｜ 日期 ｜ 短哈希。
// 行是绝对定位的虚拟行，只负责渲染；选择与键盘由 LogTable / store 处理。
import { memo } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { GraphCell } from '../graph/GraphCell.tsx'
import { COMPACT_ROW_HEIGHT, ROW_HEIGHT } from '../graph/layout.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import type { DateFormat } from '../settings.ts'
import type { LogTableData } from '../store/log-store.ts'
import { formatRelativeTime } from './CommitDetail.tsx'
import { RefChips } from './RefChips.tsx'
import css from './LogRow.module.css'

export interface LogRowModifiers {
  shift: boolean
  toggle: boolean
}

export interface LogRowProps {
  data: LogTableData
  index: number
  selected: boolean
  /** 多选（选中 >1 行）时用 multi-select 背景。 */
  multi: boolean
  /** 键盘焦点行。 */
  active: boolean
  /** 该提交是 HEAD（空心节点）。 */
  head: boolean
  currentBranch: string | null
  /** Virtual-list offset in px (`translateY`); a number so memoized rows compare equal (B4c T6). */
  offset?: number
  onClick?(index: number, modifiers: LogRowModifiers): void
  onDoubleClick?(index: number): void
  /** 右键（A3 T8）：由 LogTable 接成提交右键菜单。 */
  onContextMenu?(index: number, event: MouseEvent): void
  /** 日期显示的参照「现在」（年份不同才显示年），测试可注入。 */
  now?: number
  /** B4a: absolute (default) or relative dates. */
  dateFormat?: DateFormat
  /** B4a compact mode: 24px rows without the author and hash cells. */
  compact?: boolean
}

/** 日志日期：同年 `MM-DD HH:mm`，跨年 `YYYY-MM-DD`；`relative` 时为「3 小时前」；非法输入原样返回。 */
export function formatLogDate(iso: string, now: number = Date.now(), format: DateFormat = 'absolute', t?: Translate): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  if (format === 'relative' && t !== undefined) return formatRelativeTime(iso, now, t)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (date.getFullYear() !== new Date(now).getFullYear()) return `${date.getFullYear()}-${day}`
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 鼠标事件 → 选择修饰键：Shift 连选，Cmd/Ctrl 切换。 */
export function rowModifiers(event: Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>): LogRowModifiers {
  return { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey }
}

/**
 * Memoized (B4c T6): a scroll step or a selection change re-renders only the rows whose props
 * changed. LogTable passes stable callbacks for this reason.
 */
export const LogRow = memo(function LogRow({
  data,
  index,
  selected,
  multi,
  active,
  head,
  currentBranch,
  offset,
  onClick,
  onDoubleClick,
  onContextMenu,
  now,
  dateFormat = 'absolute',
  compact = false,
}: LogRowProps): ReactNode {
  const t = useT()
  const { commit, graph, refs } = data
  const classes = [
    css.row,
    compact ? css.compact : undefined,
    selected ? (multi ? css.multi : css.selected) : undefined,
    active ? css.active : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')
  const onCurrentBranch = refs.some((ref) => ref.kind === 'local' && ref.name === currentBranch)

  return (
    <div
      role="row"
      id={`git-log-row-${commit.sha}`}
      className={classes}
      style={offset === undefined ? undefined : { transform: `translateY(${String(offset)}px)` }}
      aria-rowindex={index + 1}
      aria-selected={selected}
      data-index={index}
      data-sha={commit.sha}
      onMouseDown={(event) => {
        // Shift 连选时不让浏览器顺手选中一片文字。
        if (event.shiftKey) event.preventDefault()
      }}
      onClick={(event) => onClick?.(index, rowModifiers(event))}
      onDoubleClick={() => onDoubleClick?.(index)}
      onContextMenu={onContextMenu === undefined ? undefined : (event) => onContextMenu(index, event)}
    >
      <span role="gridcell" className={css.graph}>
        <GraphCell row={graph} head={head} current={onCurrentBranch} selected={selected} height={compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT} />
      </span>
      <span role="gridcell" className={css.subject} title={commit.subject}>
        <span className={css.subjectText}>{commit.subject}</span>
        <RefChips refs={refs} currentBranch={currentBranch} />
      </span>
      {compact ? null : <span role="gridcell" className={css.author} title={`${commit.author} <${commit.email}>`}>{commit.author}</span>}
      <span role="gridcell" className={css.date} title={commit.date}>{formatLogDate(commit.date, now, dateFormat, t)}</span>
      {compact ? null : <span role="gridcell" className={css.hash}>{commit.shortSha}</span>}
    </div>
  )
})
