// File history overlay (design §9.6, plan B2 T6): the commits that changed one file (following
// renames), newest first; the selected commit's changes to the file below. Row actions: blame this
// revision, compare with the worktree, show in log, copy path. The store lives in GitWorkbench, so
// coming back from Blame finds the selection and scroll position as they were (AC5).
import { languageForPath, useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { FileHistoryEntry } from '../../shared/protocol.ts'
import { useT } from '../i18n.tsx'
import { text } from '../localized-text.ts'
import type { Translate } from '../localized-text.ts'
import type { DiffState } from '../store/diff-store.ts'
import { useDiffState } from '../store/diff-store.ts'
import { useFileHistoryState } from '../store/file-history-store.ts'
import type { FileHistoryState, FileHistoryStore, FileHistoryTarget } from '../store/file-history-store.ts'
import type { DiffStore } from '../store/diff-store.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { StatusLetter } from '../ui/StatusLetter.tsx'
import { ActionMenu } from './ActionMenu.tsx'
import type { ActionMenuItem } from './ActionMenu.tsx'
import { DiffHunks } from './DiffHunks.tsx'
import css from './HistoryPages.module.css'
import { formatLogDate } from './LogRow.tsx'
import type { MenuAnchor } from './menu-position.ts'

export type HistoryRowActionId = 'blameRevision' | 'compareWorktree' | 'showInLog' | 'copyPath'

/** Actions of one history row; the commit that deleted the file has no content to blame. */
export function historyRowActions(entry: FileHistoryEntry): ActionMenuItem<HistoryRowActionId>[] {
  const blame: ActionMenuItem<HistoryRowActionId> = { id: 'blameRevision', label: text('history.action.blameRevision'), section: 0 }
  if (entry.status === 'D') blame.disabledReason = text('history.disabled.deleted')
  return [
    blame,
    { id: 'compareWorktree', label: text('history.action.compareWorktree'), section: 0 },
    { id: 'showInLog', label: text('history.action.showInLog'), section: 1 },
    { id: 'copyPath', label: text('history.action.copyPath'), section: 1 },
  ]
}

export interface FileHistoryPageViewProps {
  state: FileHistoryState
  diff: DiffState | null
  now: number
  menu: { sha: string; anchor: MenuAnchor } | null
  highlighter?: CodeHighlighter
  initialScrollTop?: number
  onScrollTopChange?: (top: number) => void
  onBack: () => void
  onLoadMore: () => void
  onRetry: () => void
  onSelect: (sha: string) => void
  onMenu: (sha: string, anchor: MenuAnchor) => void
  onCloseMenu: () => void
  onAction: (id: HistoryRowActionId, entry: FileHistoryEntry) => void
}

export function FileHistoryPageView(props: FileHistoryPageViewProps): ReactNode {
  const t = useT()
  const { state } = props
  const path = state.target?.path ?? ''
  const selected = state.entries.find(entry => entry.sha === state.selectedSha)
  const menuEntry = props.menu === null ? undefined : state.entries.find(entry => entry.sha === props.menu?.sha)
  return (
    <div className={css.root} role="dialog" aria-label={t('history.dialog', { path })} tabIndex={-1} data-file-history>
      <div className={css.header}>
        <Button title={t('diff.back.title')} onClick={props.onBack}>{t('diff.back')}</Button>
        <span className={css.title} title={path}>{t('history.title', { path })}</span>
        {state.followedRename ? <span className={css.chip} title={t('history.renamed.title')}>{t('history.renamed')}</span> : null}
      </div>
      <HistoryList {...props} t={t} />
      {selected === undefined ? null : (
        <div className={css.diff} data-history-diff>
          <div className={css.diffHeader}>
            <span className={css.sha}>{selected.shortSha}</span>
            <span className={css.subject}>{selected.subject}</span>
            {historyRowActions(selected).map(item => (
              <Button
                key={item.id}
                disabled={item.disabledReason !== undefined}
                {...(item.disabledReason === undefined ? {} : { title: t(item.disabledReason.key) })}
                onClick={() => { props.onAction(item.id, selected) }}
              >
                {t(item.label.key)}
              </Button>
            ))}
          </div>
          {diffBody(props.diff, props.highlighter, t, t('history.diff.empty'))}
        </div>
      )}
      {props.menu === null || menuEntry === undefined ? null : (
        <ActionMenu
          label={t('history.menu', { sha: menuEntry.shortSha })}
          items={historyRowActions(menuEntry)}
          anchor={props.menu.anchor}
          onClose={props.onCloseMenu}
          onSelect={(id) => {
            props.onCloseMenu()
            props.onAction(id, menuEntry)
          }}
        />
      )}
    </div>
  )
}

function HistoryList(props: FileHistoryPageViewProps & { t: Translate }): ReactNode {
  const { state, t } = props
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (scrollRef.current !== null && props.initialScrollTop !== undefined) scrollRef.current.scrollTop = props.initialScrollTop
    // Restore once, on mount.
  }, [])
  if (state.status === 'error') {
    return <div className={css.state}><EmptyState error title={t('history.loadFailed')} hint={state.error?.message ?? t('action.retryHint')} action={{ label: t('action.retry'), onClick: props.onRetry }} /></div>
  }
  if (state.status === 'loading' && state.entries.length === 0) return <p className={css.state} role="status">{t('history.loading')}</p>
  if (state.entries.length === 0) return <div className={css.state}><EmptyState title={t('history.empty')} /></div>
  return (
    <div
      ref={scrollRef}
      className={css.lists}
      onScroll={props.onScrollTopChange === undefined ? undefined : event => props.onScrollTopChange?.(event.currentTarget.scrollTop)}
    >
      <ul className={css.list} role="listbox" aria-label={t('history.dialog', { path: state.target?.path ?? '' })}>
        {state.entries.map(entry => (
          <li
            key={entry.sha}
            role="option"
            aria-selected={entry.sha === state.selectedSha}
            className={css.row}
            data-sha={entry.sha}
            onClick={() => { props.onSelect(entry.sha) }}
            onContextMenu={(event) => {
              event.preventDefault()
              props.onMenu(entry.sha, { kind: 'point', x: event.clientX, y: event.clientY })
            }}
          >
            <StatusLetter status={entry.status} />
            <span className={css.subject} title={entry.subject}>
              {entry.subject}
              {entry.origPath === undefined ? null : <span className={css.muted}> {t('history.renamedFrom', { from: entry.origPath, to: entry.path })}</span>}
            </span>
            {entry.additions === undefined || entry.deletions === undefined ? null : (
              <span className={css.muted}>{t('history.lines', { add: entry.additions, del: entry.deletions })}</span>
            )}
            <span className={css.muted}>{entry.author}</span>
            <time className={css.muted} dateTime={entry.date}>{formatLogDate(entry.date, props.now)}</time>
            <span className={css.sha}>{entry.shortSha}</span>
          </li>
        ))}
      </ul>
      {state.next === undefined ? null : (
        <div className={css.more}>
          <Button disabled={state.loadingMore} onClick={props.onLoadMore}>{state.loadingMore ? t('blame.loadingMore') : t('history.loadMore')}</Button>
        </div>
      )}
    </div>
  )
}

/** Diff area shared by the history and compare pages. */
export function diffBody(diff: DiffState | null, highlighter: CodeHighlighter | undefined, t: Translate, empty: string): ReactNode {
  if (diff === null || diff.status === 'idle') return <p className={css.state}>{empty}</p>
  if (diff.status === 'error') return <p className={css.state} role="alert">{diff.error?.message ?? t('diff.loadFailed')}</p>
  if (diff.value === null) return <p className={css.state} role="status">{t('diff.loading')}</p>
  if (diff.value.hunks.length === 0) return <p className={css.state}>{diff.value.binary ? t('blame.binary') : t('diff.noTextChange')}</p>
  return <DiffHunks key={JSON.stringify(diff.request)} hunks={diff.value.hunks} viewportHeight={240} {...(highlighter === undefined ? {} : { highlighter })} />
}

export interface FileHistoryPageProps {
  store: FileHistoryStore
  diff: DiffStore
  target: FileHistoryTarget
  /** Scroll position kept by the workbench across Blame and back. */
  scroll: { current: number }
  onBack: () => void
  onAction: (id: HistoryRowActionId, entry: FileHistoryEntry) => void
  useHighlighter?: (language: string | undefined) => CodeHighlighter
}

/** Container: opens the target unless the store already shows it (back from Blame keeps everything). */
export function FileHistoryPage(props: FileHistoryPageProps): ReactNode {
  const { store, target, useHighlighter = useCodeHighlighter } = props
  const state = useFileHistoryState(store)
  const diffState = useDiffState(props.diff)
  const [menu, setMenu] = useState<{ sha: string; anchor: MenuAnchor } | null>(null)
  const highlighter = useHighlighter(languageForPath(target.path))
  const targetKey = `${target.path}\u0000${target.rev ?? ''}`
  useEffect(() => {
    const current = store.getState()
    const same = current.target?.path === target.path && current.target.rev === target.rev
    if (!same || current.status === 'idle' || current.status === 'error') {
      props.scroll.current = 0
      void store.open(target)
    }
    // target identity is targetKey.
  }, [store, targetKey])
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { rootRef.current?.querySelector<HTMLElement>('[data-file-history]')?.focus() }, [])
  return (
    <div ref={rootRef}>
      <FileHistoryPageView
        state={state}
        diff={diffState}
        now={Date.now()}
        menu={menu}
        highlighter={highlighter}
        initialScrollTop={props.scroll.current}
        onScrollTopChange={(top) => { props.scroll.current = top }}
        onBack={props.onBack}
        onLoadMore={() => { void store.loadMore() }}
        onRetry={() => { void store.open(target) }}
        onSelect={(sha) => { void store.select(sha) }}
        onMenu={(sha, anchor) => { setMenu({ sha, anchor }) }}
        onCloseMenu={() => { setMenu(null) }}
        onAction={props.onAction}
      />
    </div>
  )
}
