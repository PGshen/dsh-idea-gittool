// 提交图表格（设计 §8.1.3）：@tanstack/react-virtual 虚拟化，26px 行高，接近底部自动加载下一页。
// 键盘交给 log-store.handleKey（§14.1），这里只做事件翻译、preventDefault 与滚动跟随。
import { useEffect, useRef } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { FocusTarget } from '../focus.ts'
import { ROW_HEIGHT } from '../graph/layout.ts'
import { useT } from '../i18n.tsx'
import type { LogAction, LogKeyInput, LogKeyResult, LogTableData } from '../store/log-store.ts'
import { isContextMenuKey } from './commit-actions.ts'
import { LogRow } from './LogRow.tsx'
import type { LogRowModifiers } from './LogRow.tsx'
import css from './LogTable.module.css'

/** 可见区最后一行距末尾不足这么多行时加载下一页。 */
export const LOAD_MORE_THRESHOLD = 20

/** 视口外多渲染的行数（滚动时不闪白）。 */
export const LOG_OVERSCAN = 12

/** 首帧/无 DOM 环境下假定的视口高度（px），用于 SSR 与测试。 */
export const DEFAULT_VIEWPORT_HEIGHT = 600

const TABLE_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'F2',
])

/**
 * KeyboardEvent → store 的按键输入；不是表格快捷键时返回 null（交给 DSH 全局）。
 * Alt 组合一律放行，避免覆盖 DSH 的全局快捷键（§14.1 规则）。
 */
export function toLogKeyInput(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>,
): LogKeyInput | null {
  if (event.altKey) return null
  const primary = event.metaKey || event.ctrlKey
  if (primary) {
    const key = event.key.toLowerCase()
    return key === 'a' || key === 'c' ? { key, primary: true } : null
  }
  if (!TABLE_KEYS.has(event.key)) return null
  return { key: event.key, shiftKey: event.shiftKey }
}

/** 是否该加载下一页：最后一个渲染行已进入末尾阈值。 */
export function shouldLoadMore(lastRenderedIndex: number, total: number, threshold: number = LOAD_MORE_THRESHOLD): boolean {
  if (total === 0 || lastRenderedIndex < 0) return false
  return lastRenderedIndex >= total - 1 - threshold
}

function hasTextSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false
  const selection = window.getSelection()
  return selection !== null && selection.toString().length > 0
}

/** 提交右键菜单的打开请求：视口坐标 + 关闭后要回到的焦点（表格本身）。 */
export interface RowMenuRequest {
  index: number
  x: number
  y: number
  trigger: FocusTarget | null
}

export interface LogTableProps {
  rows: readonly LogTableData[]
  selection: readonly string[]
  activeIndex: number
  /** 筛选/排序重建计数：变化时滚回顶部。 */
  generation: number
  headSha: string | null
  currentBranch: string | null
  loadingMore: boolean
  atRowLimit: boolean
  onRowClick(index: number, modifiers: LogRowModifiers): void
  /** 双击：打开该提交的 diff。 */
  onRowOpen(index: number): void
  /** 一般接 `store.handleKey`。 */
  onKey(input: LogKeyInput): LogKeyResult
  /** store 返回的页面级动作（open-diff / copy-hash / select-all / clear-search）。 */
  onAction?(action: LogAction): void
  /** 右键或 Shift+F10 / ContextMenu 键（A3 T8）；未传时不拦截浏览器菜单。 */
  onRowContextMenu?(request: RowMenuRequest): void
  /** 接近底部：一般接 `store.loadNextPage`（store 自己处理并发与上限）。 */
  onNearEnd(): void
  /** 加载下一页失败时的提示与重试（不清空已加载行）。 */
  footerError?: { message: string; onRetry(): void } | null
  tableRef?: Ref<HTMLDivElement>
  viewportHeight?: number
}

export function LogTable({
  rows,
  selection,
  activeIndex,
  generation,
  headSha,
  currentBranch,
  loadingMore,
  atRowLimit,
  onRowClick,
  onRowOpen,
  onKey,
  onAction,
  onRowContextMenu,
  onNearEnd,
  footerError = null,
  tableRef,
  viewportHeight = DEFAULT_VIEWPORT_HEIGHT,
}: LogTableProps): ReactNode {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: LOG_OVERSCAN,
    initialRect: { width: 0, height: viewportHeight },
    getItemKey: (index) => rows[index]?.commit.sha ?? index,
  })
  const items = virtualizer.getVirtualItems()
  const lastRendered = items[items.length - 1]?.index ?? -1
  const selected = new Set(selection)
  const multi = selection.length > 1
  const activeSha = rows[activeIndex]?.commit.sha

  useEffect(() => {
    if (shouldLoadMore(lastRendered, rows.length)) onNearEnd()
  }, [lastRendered, rows.length, onNearEnd])

  // 键盘移动后保持焦点行可见（align: auto 时可见行不滚动）。
  useEffect(() => {
    if (activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
  }, [activeIndex, virtualizer])

  // 筛选/排序重建后回到顶部（§8.1.3）。
  useEffect(() => {
    virtualizer.scrollToOffset(0)
  }, [generation, virtualizer])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return
    if (onRowContextMenu !== undefined && isContextMenuKey(event) && activeIndex >= 0) {
      event.preventDefault()
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      const box = (row ?? event.currentTarget).getBoundingClientRect()
      onRowContextMenu({ index: activeIndex, x: box.left + 24, y: box.bottom, trigger: event.currentTarget })
      return
    }
    const input = toLogKeyInput(event)
    if (input === null) return
    // 有文字选区时 Cmd/Ctrl+C 交给浏览器复制文字（§14.1）。
    if (input.primary === true && input.key === 'c' && hasTextSelection()) return
    const result = onKey(input)
    if (!result.handled) return
    event.preventDefault()
    if (result.action !== undefined) onAction?.(result.action)
  }

  function setScrollRef(node: HTMLDivElement | null): void {
    scrollRef.current = node
    if (typeof tableRef === 'function') tableRef(node)
    else if (tableRef !== undefined && tableRef !== null) (tableRef as { current: HTMLDivElement | null }).current = node
  }

  return (
    <div
      ref={setScrollRef}
      className={css.scroller}
      role="grid"
      aria-label={t('log.table.label')}
      aria-multiselectable
      aria-rowcount={rows.length}
      aria-activedescendant={activeSha === undefined ? undefined : `git-log-row-${activeSha}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className={css.canvas} style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const data = rows[item.index]
          if (data === undefined) return null
          return (
            <LogRow
              key={item.key}
              data={data}
              index={item.index}
              selected={selected.has(data.commit.sha)}
              multi={multi}
              active={item.index === activeIndex}
              head={headSha !== null && data.commit.sha === headSha}
              currentBranch={currentBranch}
              style={{ transform: `translateY(${item.start}px)` }}
              onClick={onRowClick}
              onDoubleClick={onRowOpen}
              {...(onRowContextMenu === undefined ? {} : {
                onContextMenu: (index: number, mouse: MouseEvent) => {
                  mouse.preventDefault()
                  onRowContextMenu({ index, x: mouse.clientX, y: mouse.clientY, trigger: scrollRef.current })
                },
              })}
            />
          )
        })}
      </div>
      {loadingMore ? <div className={css.skeleton} aria-busy="true">{t('log.table.loadingMore')}</div> : null}
      {footerError === null ? null : (
        <div className={css.footerError} role="alert">
          <span>{footerError.message}</span>
          <button type="button" className={css.footerAction} onClick={footerError.onRetry}>{t('action.retry')}</button>
        </div>
      )}
      {atRowLimit ? (
        <div className={css.footer}>{t('log.table.rowLimit', { count: rows.length })}</div>
      ) : null}
    </div>
  )
}
