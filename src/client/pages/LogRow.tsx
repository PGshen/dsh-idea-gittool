// 日志表格的一行（设计 §8.1.3）：图 ｜ 主题 + refs ｜ 作者 ｜ 日期 ｜ 短哈希。
// 行是绝对定位的虚拟行，只负责渲染；选择与键盘由 LogTable / store 处理。
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { GraphCell } from '../graph/GraphCell.tsx'
import type { LogTableData } from '../store/log-store.ts'
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
  style?: CSSProperties
  onClick?(index: number, modifiers: LogRowModifiers): void
  onDoubleClick?(index: number): void
  /** 日期显示的参照「现在」（年份不同才显示年），测试可注入。 */
  now?: number
}

/** 日志日期：同年 `MM-DD HH:mm`，跨年 `YYYY-MM-DD`；非法输入原样返回。 */
export function formatLogDate(iso: string, now: number = Date.now()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (date.getFullYear() !== new Date(now).getFullYear()) return `${date.getFullYear()}-${day}`
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 鼠标事件 → 选择修饰键：Shift 连选，Cmd/Ctrl 切换。 */
export function rowModifiers(event: Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>): LogRowModifiers {
  return { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey }
}

export function LogRow({
  data,
  index,
  selected,
  multi,
  active,
  head,
  currentBranch,
  style,
  onClick,
  onDoubleClick,
  now,
}: LogRowProps): ReactNode {
  const { commit, graph, refs } = data
  const classes = [
    css.row,
    selected ? (multi ? css.multi : css.selected) : undefined,
    active ? css.active : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')
  const onCurrentBranch = refs.some((ref) => ref.kind === 'local' && ref.name === currentBranch)

  return (
    <div
      role="row"
      id={`git-log-row-${commit.sha}`}
      className={classes}
      style={style}
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
    >
      <span role="gridcell" className={css.graph}>
        <GraphCell row={graph} head={head} current={onCurrentBranch} selected={selected} />
      </span>
      <span role="gridcell" className={css.subject} title={commit.subject}>
        <span className={css.subjectText}>{commit.subject}</span>
        <RefChips refs={refs} currentBranch={currentBranch} />
      </span>
      <span role="gridcell" className={css.author} title={`${commit.author} <${commit.email}>`}>{commit.author}</span>
      <span role="gridcell" className={css.date} title={commit.date}>{formatLogDate(commit.date, now)}</span>
      <span role="gridcell" className={css.hash}>{commit.shortSha}</span>
    </div>
  )
}
