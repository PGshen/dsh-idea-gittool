// Blame view (design §9.6/§9.7, plan B2 T5): line segments with a commit gutter. One component, two
// homes: a Level 1 overlay of the Git tab (with "← back") and the body of the `git.blame` page.
// Click a line → that commit's facts below; double click → its changes to this file in place; hover the
// gutter → hover card; right click → segment menu. Read only.
import { languageForPath, useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodeHighlighter, HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { BlameCommit } from '../../shared/protocol.ts'
import { useT } from '../i18n.tsx'
import { text } from '../localized-text.ts'
import type { Translate } from '../localized-text.ts'
import { createBlameStore, useBlameState } from '../store/blame-store.ts'
import type { BlameLoader, BlameRow, BlameState, BlameTarget } from '../store/blame-store.ts'
import { createDiffStore, useDiffState } from '../store/diff-store.ts'
import type { DiffLoader, DiffState } from '../store/diff-store.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { ActionMenu } from './ActionMenu.tsx'
import type { ActionMenuItem } from './ActionMenu.tsx'
import { BlameHoverCard } from './BlameHoverCard.tsx'
import css from './BlameView.module.css'
import { DiffHunks, LineCode } from './DiffHunks.tsx'
import { formatLogDate } from './LogRow.tsx'
import type { MenuAnchor } from './menu-position.ts'

export const BLAME_ROW_HEIGHT = 20
const OVERSCAN = 30
/** Delay before a hover card closes, so the pointer can move from the gutter onto the card. */
const HOVER_CLOSE_MS = 150

export type BlameSegmentActionId = 'copyHash' | 'showInLog' | 'fileHistory'

/** Segment menu items; uncommitted lines have no hash to copy or show. */
export function blameSegmentActions(commit: BlameCommit | undefined): ActionMenuItem<BlameSegmentActionId>[] {
  const reason = commit?.uncommitted === false ? undefined : text('blame.disabled.uncommitted')
  const item = (id: BlameSegmentActionId, label: 'blame.commit.copyHash' | 'blame.commit.showInLog' | 'blame.fileHistory', section: number, disabled?: typeof reason): ActionMenuItem<BlameSegmentActionId> =>
    disabled === undefined ? { id, label: text(label), section } : { id, label: text(label), section, disabledReason: disabled }
  return [
    item('copyHash', 'blame.commit.copyHash', 0, reason),
    item('showInLog', 'blame.commit.showInLog', 0, reason),
    item('fileHistory', 'blame.fileHistory', 1),
  ]
}

/** Gutter text of a segment head: `hash · date · author`, the hash only when compact, 未提交 for the worktree. */
export function gutterLabel(commit: BlameCommit | undefined, compact: boolean, now: number, t: Translate): string {
  if (commit === undefined) return ''
  if (commit.uncommitted) return t('blame.uncommitted')
  if (compact) return commit.shortSha
  return `${commit.shortSha} · ${formatLogDate(commit.date, now)} · ${commit.author}`
}

export interface BlameViewProps {
  state: BlameState
  branch: string | null
  compact: boolean
  hovered: { sha: string; line: number } | null
  menu: { sha: string; anchor: MenuAnchor } | null
  /** In-place diff of one commit to this file, or null. */
  diff: DiffState | null
  now: number
  highlighter?: CodeHighlighter
  /** Absent inside the `git.blame` page (no level to go back to). */
  onBack?: (() => void) | undefined
  onToggleCompact: () => void
  onLoadMore: () => void
  onRetry: () => void
  onSelect: (sha: string) => void
  onOpenDiff: (row: BlameRow) => void
  onHover: (hovered: { sha: string; line: number } | null) => void
  onMenu: (sha: string, anchor: MenuAnchor) => void
  onCloseMenu: () => void
  onMenuAction: (id: BlameSegmentActionId, sha: string) => void
  onCloseDiff: () => void
  onCopyHash: (sha: string) => void
  onShowInLog: (sha: string) => void
  onFileHistory: () => void
  onHoverCardEnter?: () => void
}

export function BlameView(props: BlameViewProps): ReactNode {
  const t = useT()
  const { state, onBack } = props
  const value = state.value
  const path = value?.path ?? state.target?.path ?? ''
  const revCommit = value?.rev === null || value?.rev === undefined ? undefined : value.rev.slice(0, 7)

  return (
    <div
      className={css.root}
      role="dialog"
      aria-label={t('blame.dialog', { path })}
      tabIndex={-1}
      data-blame-view
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        if (props.menu !== null) return
        event.preventDefault()
        if (props.diff !== null) props.onCloseDiff()
        else onBack?.()
      }}
    >
      <div className={css.header}>
        {onBack === undefined ? null : (
          <Button className={css.back} title={t('diff.back.title')} onClick={onBack}>{t('diff.back')}</Button>
        )}
        <span className={css.path} title={path}>{path}</span>
        {revCommit === undefined ? null : <span className={css.meta}>{t('blame.rev', { sha: revCommit })}</span>}
        {props.branch === null ? null : <span className={css.meta}>⎇ {props.branch}</span>}
        {value === null ? null : <span className={css.meta}>{t('blame.lines', { count: value.totalLines })}</span>}
        <Button className={css.toggle} title={t('blame.toggle.title')} onClick={props.onToggleCompact}>
          {props.compact ? t('blame.toggle.detailed') : t('blame.toggle.compact')}
        </Button>
      </div>
      <div className={css.body}>{bodyOf(props, t)}</div>
      {footerOf(props, t)}
      {props.menu === null ? null : (
        <ActionMenu
          label={t('blame.menu', { sha: state.commits[props.menu.sha]?.shortSha ?? props.menu.sha.slice(0, 7) })}
          items={blameSegmentActions(state.commits[props.menu.sha])}
          anchor={props.menu.anchor}
          onClose={props.onCloseMenu}
          onSelect={(id) => {
            const sha = props.menu?.sha
            props.onCloseMenu()
            if (sha !== undefined) props.onMenuAction(id, sha)
          }}
        />
      )}
    </div>
  )
}

function bodyOf(props: BlameViewProps, t: Translate): ReactNode {
  const { state } = props
  if (state.status === 'error') {
    return (
      <div className={css.state}>
        <EmptyState error title={t('blame.loadFailed')} hint={state.error?.message ?? t('action.retryHint')} action={{ label: t('action.retry'), onClick: props.onRetry }} />
      </div>
    )
  }
  const value = state.value
  if (value === null) return <p className={css.state} role="status">{t('blame.loading')}</p>
  if (value.binary) return <div className={css.state}><EmptyState title={t('blame.binary')} /></div>
  if (value.tooLarge) {
    return (
      <div className={css.state}>
        <EmptyState title={t('blame.tooLarge')} hint={t('blame.tooLarge.hint')} />
        {value.terminalCommand === undefined ? null : <code className={css.command}>{value.terminalCommand}</code>}
      </div>
    )
  }
  if (value.unavailable === 'untracked') return <div className={css.state}><EmptyState title={t('blame.untracked')} /></div>
  if (value.unavailable === 'missing') return <div className={css.state}><EmptyState title={t('blame.unavailable.missing')} /></div>
  if (value.totalLines === 0) return <div className={css.state}><EmptyState title={t('blame.empty')} /></div>
  return <BlameLines {...props} />
}

function footerOf(props: BlameViewProps, t: Translate): ReactNode {
  const { state, diff } = props
  if (diff !== null) {
    const sha = diff.request?.sha
    return (
      <div className={css.footer} data-blame-diff>
        <div className={css.footerHeader}>
          <span>{t('blame.diff.title', { sha: sha === undefined ? t('blame.uncommitted') : sha.slice(0, 7) })}</span>
          <Button onClick={props.onCloseDiff}>{t('blame.diff.close')}</Button>
        </div>
        <div className={css.footerDiff}>
          {diff.value === null
            ? <p className={css.state} role="status">{diff.status === 'error' ? (diff.error?.message ?? '') : t('diff.loading')}</p>
            : <DiffHunks hunks={diff.value.hunks} viewportHeight={200} {...(props.highlighter === undefined ? {} : { highlighter: props.highlighter })} />}
        </div>
      </div>
    )
  }
  const commit = state.selectedSha === null ? undefined : state.commits[state.selectedSha]
  if (commit === undefined) return null
  return (
    <div className={css.footer} data-blame-commit>
      {commit.uncommitted ? (
        <p className={css.footerSubject}>{t('blame.commit.uncommitted')}</p>
      ) : (
        <>
          <p className={css.footerSubject}>{commit.subject}</p>
          <p className={css.hoverMeta}>
            <code>{commit.shortSha}</code>
            <span>{commit.author}</span>
            <time dateTime={commit.date}>{formatLogDate(commit.date, props.now)}</time>
          </p>
        </>
      )}
      <p className={css.hoverActions}>
        <button type="button" className={css.link} onClick={() => {
          const row = state.rows.find(candidate => candidate.sha === commit.sha)
          if (row !== undefined) props.onOpenDiff(row)
        }}>{t('blame.commit.showDiff')}</button>
        {commit.uncommitted ? null : (
          <>
            <button type="button" className={css.link} onClick={() => { props.onShowInLog(commit.sha) }}>{t('blame.commit.showInLog')}</button>
            <button type="button" className={css.link} onClick={() => { props.onCopyHash(commit.sha) }}>{t('blame.commit.copyHash')}</button>
          </>
        )}
      </p>
    </div>
  )
}

function BlameLines(props: BlameViewProps): ReactNode {
  const t = useT()
  const { state, compact, hovered, now, highlighter } = props
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rows = state.rows
  // Highlight the loaded text as one fragment so multi-line syntax keeps its state.
  const spans = useMemo<HighlightSpan[][] | undefined>(
    () => (highlighter === undefined ? undefined : highlighter(rows.map(row => row.text).join('\n'))),
    [highlighter, rows],
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => BLAME_ROW_HEIGHT,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: 600 },
  })
  const hoveredIndex = hovered === null ? -1 : rows.findIndex(row => row.line === hovered.line)
  const hoveredCommit = hovered === null ? undefined : state.commits[hovered.sha]
  const total = state.value?.totalLines ?? rows.length

  return (
    <div ref={scrollRef} className={css.scroller} data-row-count={rows.length}>
      <div className={css.canvas} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (row === undefined) return null
          const commit = state.commits[row.sha]
          const style: CSSProperties = { transform: `translateY(${item.start}px)`, height: BLAME_ROW_HEIGHT }
          return (
            <div
              key={row.line}
              className={`${css.row} ${row.segmentStart ? css.segmentStart : ''}`}
              style={style}
              data-blame-line={row.line}
              {...(state.selectedSha === row.sha ? { 'data-selected': true } : {})}
              {...(commit?.uncommitted === true ? { 'data-uncommitted': true } : {})}
              onClick={() => { props.onSelect(row.sha) }}
              onDoubleClick={() => { props.onOpenDiff(row) }}
              onContextMenu={(event) => {
                event.preventDefault()
                props.onMenu(row.sha, { kind: 'point', x: event.clientX, y: event.clientY })
              }}
            >
              <span
                className={`${css.gutter} ${compact ? css.gutterCompact : ''}`}
                title={commit === undefined || commit.uncommitted ? undefined : commit.subject}
                onMouseEnter={() => { props.onHover({ sha: row.sha, line: row.line }) }}
                onMouseLeave={() => { props.onHover(null) }}
              >
                {row.segmentStart ? gutterLabel(commit, compact, now, t) : ''}
              </span>
              <span className={css.lineNumber}>{row.line}</span>
              <LineCode text={row.text} spans={spans?.[item.index]} />
            </div>
          )
        })}
        {hoveredCommit === undefined || hoveredIndex === -1 ? null : (
          <BlameHoverCard
            commit={hoveredCommit}
            now={now}
            top={(hoveredIndex + 1) * BLAME_ROW_HEIGHT}
            onCopyHash={props.onCopyHash}
            onShowInLog={props.onShowInLog}
            {...(props.onHoverCardEnter === undefined ? {} : { onMouseEnter: props.onHoverCardEnter })}
            onMouseLeave={() => { props.onHover(null) }}
          />
        )}
      </div>
      {state.next === undefined ? null : (
        <div className={css.more}>
          <Button disabled={state.loadingMore} onClick={props.onLoadMore}>
            {state.loadingMore ? t('blame.loadingMore') : t('blame.loadMore', { shown: rows.length, total })}
          </Button>
        </div>
      )}
    </div>
  )
}

export interface BlameOverlayProps {
  sessionId: string
  target: BlameTarget
  load: BlameLoader
  loadDiff: DiffLoader
  branch: string | null
  onBack?: (() => void) | undefined
  onShowInLog: (sha: string) => void
  onFileHistory: (path: string) => void
  onCopy?: (text: string) => void
  /** Highlighter hook; tests inject a stand-in (see DiffViewer). */
  useHighlighter?: (language: string | undefined) => CodeHighlighter
}

/** Container: owns the blame and diff stores, reopens when the target changes, aborts on unmount. */
export function BlameOverlay(props: BlameOverlayProps): ReactNode {
  const { sessionId, target, useHighlighter = useCodeHighlighter } = props
  const loadRef = useRef(props.load)
  const loadDiffRef = useRef(props.loadDiff)
  loadRef.current = props.load
  loadDiffRef.current = props.loadDiff
  const store = useMemo(() => createBlameStore({ sessionId, load: (request, signal) => loadRef.current(request, signal) }), [sessionId])
  const diffStore = useMemo(() => createDiffStore({ load: (request, signal) => loadDiffRef.current(request, signal) }), [])
  const state = useBlameState(store)
  const diffState = useDiffState(diffStore)
  const [compact, setCompact] = useState(false)
  const [hovered, setHovered] = useState<{ sha: string; line: number } | null>(null)
  const [menu, setMenu] = useState<{ sha: string; anchor: MenuAnchor } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const highlighter = useHighlighter(languageForPath(target.path))
  const copy = props.onCopy ?? ((value: string) => { void globalThis.navigator?.clipboard?.writeText(value) })

  const targetKey = `${target.path}\u0000${target.rev ?? ''}`
  useEffect(() => {
    diffStore.close()
    void store.open(target)
    // target identity is targetKey.
  }, [store, diffStore, targetKey])
  useEffect(() => () => {
    store.close()
    diffStore.close()
    clearTimeout(hoverTimer.current)
  }, [store, diffStore])
  useEffect(() => { rootRef.current?.querySelector<HTMLElement>('[data-blame-view]')?.focus() }, [])

  const onHover = (next: { sha: string; line: number } | null): void => {
    clearTimeout(hoverTimer.current)
    if (next !== null) {
      setHovered(next)
      return
    }
    hoverTimer.current = setTimeout(() => { setHovered(null) }, HOVER_CLOSE_MS)
  }
  const openDiff = (row: BlameRow): void => {
    const path = row.origPath ?? state.value?.path ?? target.path
    const commit = state.commits[row.sha]
    void diffStore.open(commit?.uncommitted === true
      ? { sessionId, path, scope: 'worktree' }
      : { sessionId, path, scope: 'commit', sha: row.sha })
  }

  return (
    <div ref={rootRef} className={css.host}>
      <BlameView
        state={state}
        branch={props.branch}
        compact={compact}
        hovered={hovered}
        menu={menu}
        diff={diffState.status === 'idle' ? null : diffState}
        now={Date.now()}
        highlighter={highlighter}
        onBack={props.onBack}
        onToggleCompact={() => { setCompact(current => !current) }}
        onLoadMore={() => { void store.loadMore() }}
        onRetry={() => { void store.open(target) }}
        onSelect={(sha) => { store.select(sha) }}
        onOpenDiff={openDiff}
        onHover={onHover}
        onHoverCardEnter={() => { clearTimeout(hoverTimer.current) }}
        onMenu={(sha, anchor) => { setMenu({ sha, anchor }) }}
        onCloseMenu={() => { setMenu(null) }}
        onMenuAction={(id, sha) => {
          if (id === 'copyHash') copy(sha)
          else if (id === 'showInLog') props.onShowInLog(sha)
          else props.onFileHistory(target.path)
        }}
        onCloseDiff={() => { diffStore.close() }}
        onCopyHash={copy}
        onShowInLog={props.onShowInLog}
        onFileHistory={() => { props.onFileHistory(target.path) }}
      />
    </div>
  )
}
