// Git 控制台抽屉（设计 §12）：只读展示插件执行过的 git 命令。
// 默认 240px、可拖高；时间 / argv（高亮子命令）/ 耗时 / 退出码；stdout/stderr 可展开。
// 可复制命令、清空视图、暂停自动滚动；刻意不提供任何命令输入。
import { useEffect, useRef } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { CONSOLE_BUFFER_SIZE } from '../../shared/protocol.ts'
import { EmptyState } from '../ui/EmptyState.tsx'
import {
  exitLabel,
  formatCommand,
  formatDuration,
  formatRecordTime,
  outputSummary,
  splitArgv,
} from './console-store.ts'
import type { ConsoleEntry, ConsoleState } from './console-store.ts'
import css from './ConsoleDrawer.module.css'

export const CONSOLE_DEFAULT_HEIGHT = 240
export const CONSOLE_MIN_HEIGHT = 120
/** 键盘调整高度的步长。 */
const HEIGHT_STEP = 24

/** 把抽屉高度夹在 [MIN, 容器高度的 85%] 内；容器高度未知时只夹下限。 */
export function clampDrawerHeight(height: number, containerHeight?: number): number {
  const max = containerHeight !== undefined && Number.isFinite(containerHeight)
    ? Math.max(CONSOLE_MIN_HEIGHT, Math.floor(containerHeight * 0.85))
    : Number.POSITIVE_INFINITY
  if (!Number.isFinite(height)) return CONSOLE_DEFAULT_HEIGHT
  return Math.min(max, Math.max(CONSOLE_MIN_HEIGHT, Math.round(height)))
}

/** 距底部小于这个距离视为「在底部」；用户上滚超过它就自动暂停滚动。 */
const STICK_THRESHOLD_PX = 24

export interface ConsoleDrawerProps {
  state: ConsoleState
  /** 抽屉高度（px），默认 240；fullHeight 时忽略。 */
  height?: number
  onHeightChange?: (height: number) => void
  /** Compact 档：面板内全高覆盖页。 */
  fullHeight?: boolean
  onClose: () => void
  onClear: () => void
  onPausedChange: (paused: boolean) => void
  onToggleExpanded: (key: string) => void
  /** 复制文本；默认走 navigator.clipboard。 */
  onCopy?: (text: string) => void
  onRetry?: () => void
}

function defaultCopy(text: string): void {
  void globalThis.navigator?.clipboard?.writeText(text).catch(() => {})
}

export function ConsoleDrawer(props: ConsoleDrawerProps): ReactNode {
  const { state, fullHeight = false, onPausedChange } = props
  const height = clampDrawerHeight(props.height ?? CONSOLE_DEFAULT_HEIGHT)
  const listRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const stopResize = useRef<(() => void) | null>(null)
  useEffect(() => () => { stopResize.current?.() }, [])
  const copy = props.onCopy ?? defaultCopy
  const lastKey = state.entries.at(-1)?.key

  // 新记录到达且未暂停时滚到底部。
  useEffect(() => {
    if (state.paused) return
    const list = listRef.current
    if (list !== null) list.scrollTop = list.scrollHeight
  }, [lastKey, state.paused])

  const onScroll = (): void => {
    const list = listRef.current
    if (list === null) return
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= STICK_THRESHOLD_PX
    if (!atBottom && !state.paused) onPausedChange(true)
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (props.onHeightChange === undefined) return
    event.preventDefault()
    stopResize.current?.()
    const startY = event.clientY
    const startHeight = height
    const container = rootRef.current?.parentElement?.clientHeight
    const onMove = (move: PointerEvent): void => {
      props.onHeightChange?.(clampDrawerHeight(startHeight + (startY - move.clientY), container))
    }
    // pointercancel 与卸载也要摘掉 window 监听，否则拖拽中途关闭抽屉会遗留（评审 M4）。
    const stop = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (stopResize.current === stop) stopResize.current = null
    }
    stopResize.current = stop
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (props.onHeightChange === undefined) return
    const container = rootRef.current?.parentElement?.clientHeight
    if (event.key === 'ArrowUp') props.onHeightChange(clampDrawerHeight(height + HEIGHT_STEP, container))
    else if (event.key === 'ArrowDown') props.onHeightChange(clampDrawerHeight(height - HEIGHT_STEP, container))
    else return
    event.preventDefault()
  }

  let body: ReactNode
  if (state.entries.length === 0 && state.error !== null) {
    body = (
      <EmptyState
        error
        title="读取控制台失败"
        hint={`${state.error.code}：${state.error.message}`}
        {...(props.onRetry === undefined ? {} : { action: { label: '重试', onClick: props.onRetry } })}
      />
    )
  } else if (state.entries.length === 0) {
    body = (
      <EmptyState
        title={state.loading ? '读取中…' : state.cleared ? '已清空' : '还没有命令记录'}
        hint={state.cleared ? '之后执行的 git 命令会继续显示在这里' : '插件执行的每条 git 命令都会记录在这里'}
      />
    )
  } else {
    body = (
      <ol className={css.list} aria-label="git 命令记录">
        {state.entries.map(entry => (
          <ConsoleRow
            key={entry.key}
            entry={entry}
            expanded={state.expanded[entry.key] === true}
            onToggle={() => props.onToggleExpanded(entry.key)}
            onCopy={() => copy(formatCommand(entry.record.argv))}
          />
        ))}
      </ol>
    )
  }

  return (
    <section
      ref={rootRef}
      className={`${css.drawer} ${fullHeight ? css.fullHeight : ''}`}
      style={fullHeight ? undefined : { height: `${height}px` }}
      aria-label="Git 控制台"
      data-dsh-git-console=""
      data-full-height={fullHeight}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose() } }}
    >
      {fullHeight
        ? null
        : (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="调整控制台高度"
              aria-valuenow={height}
              aria-valuemin={CONSOLE_MIN_HEIGHT}
              tabIndex={0}
              className={css.resizer}
              onPointerDown={startResize}
              onKeyDown={onResizeKey}
            />
          )}
      <header className={css.toolbar}>
        <strong className={css.title}>Git 控制台</strong>
        <span className={css.count}>{state.entries.length}</span>
        {state.failedCount > 0 ? <span className={css.failedCount} data-failed-count={state.failedCount}>{state.failedCount} 条失败</span> : null}
        {state.error !== null && state.entries.length > 0
          ? <span role="alert" className={css.failedCount}>刷新失败：{state.error.code}</span>
          : null}
        <span className={css.spacer} />
        <button
          type="button"
          className={css.toolButton}
          aria-pressed={state.paused}
          title={state.paused ? '恢复自动滚动' : '暂停自动滚动'}
          onClick={() => onPausedChange(!state.paused)}
        >
          {state.paused ? '▶ 自动滚动' : '⏸ 暂停滚动'}
        </button>
        <button type="button" className={css.toolButton} onClick={props.onClear} disabled={state.entries.length === 0}>
          清空
        </button>
        <button type="button" className={css.toolButton} aria-label="关闭 Git 控制台" title="关闭" onClick={props.onClose}>
          ✕
        </button>
      </header>
      {state.hostTruncated
        ? <div className={css.notice}>仅保留最近 {CONSOLE_BUFFER_SIZE} 条记录，更早的已丢弃</div>
        : null}
      <div ref={listRef} className={css.body} onScroll={onScroll}>
        {body}
      </div>
    </section>
  )
}

interface ConsoleRowProps {
  entry: ConsoleEntry
  expanded: boolean
  onToggle: () => void
  onCopy: () => void
}

function ConsoleRow({ entry, expanded, onToggle, onCopy }: ConsoleRowProps): ReactNode {
  const { record, failed } = entry
  const { globals, subcommand, args } = splitArgv(record.argv)
  const summary = outputSummary(record)
  const hasOutput = record.stdout !== '' || record.stderr !== ''
  const truncated = record.stdoutTruncated || record.stderrTruncated
  return (
    <li className={`${css.row} ${failed ? css.failed : ''}`} data-failed={failed} data-exit-code={String(record.exitCode)}>
      <div className={css.line}>
        <button
          type="button"
          className={css.expander}
          aria-expanded={expanded}
          aria-label={expanded ? '收起输出' : '展开输出'}
          disabled={!hasOutput}
          onClick={onToggle}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <time className={css.time} dateTime={record.at}>{formatRecordTime(record.at)}</time>
        <code className={css.command} title={formatCommand(record.argv)}>
          <span className={css.git}>git</span>
          {globals.map((arg, index) => <span key={`g${index}`} className={css.arg}> {arg}</span>)}
          {subcommand === null ? null : <span className={css.subcommand} data-subcommand={subcommand}> {subcommand}</span>}
          {args.map((arg, index) => <span key={`a${index}`} className={css.arg}> {arg}</span>)}
        </code>
        {record.repeat !== undefined && record.repeat > 1
          ? <span className={css.repeat} data-repeat={record.repeat} title={`相同命令重复执行 ${record.repeat} 次（轮询），只保留最近一次`}>×{record.repeat}</span>
          : null}
        <span className={css.duration}>{formatDuration(record.durationMs)}</span>
        <span className={`${css.exit} ${failed ? css.exitFailed : ''}`}>{exitLabel(record)}</span>
        {truncated ? <span className={css.truncated} data-truncated="true">已截断</span> : null}
        <button type="button" className={css.copy} aria-label="复制命令" title="复制命令" onClick={onCopy}>
          ⧉
        </button>
      </div>
      {!expanded && summary !== '' ? <div className={css.summary}>{summary}</div> : null}
      {expanded
        ? (
            <div className={css.output}>
              {record.stdout === '' ? null : <OutputBlock label="stdout" text={record.stdout} truncated={record.stdoutTruncated} />}
              {record.stderr === '' ? null : <OutputBlock label="stderr" text={record.stderr} truncated={record.stderrTruncated} error />}
            </div>
          )
        : null}
    </li>
  )
}

function OutputBlock({ label, text, truncated, error = false }: { label: string; text: string; truncated: boolean; error?: boolean }): ReactNode {
  return (
    <div className={css.block} data-stream={label}>
      <span className={css.streamLabel}>{label}</span>
      <pre className={`${css.pre} ${error ? css.stderr : ''}`}>{text}</pre>
      {truncated ? <div className={css.truncatedNote}>输出超过 64KB，已截断</div> : null}
    </div>
  )
}
