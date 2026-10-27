// Compare overlay (design §9.6, plan B2 T6): commits in `left` but not in `right` with a swap, plus the
// files `left` changed since the merge base; `right` null compares with the worktree (files only).
// The selected file's diff shows below, in place.
import { languageForPath, useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { STATUS_ENTRY_LIMIT } from '../../shared/protocol.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../localized-text.ts'
import { createCompareStore, useCompareState } from '../store/compare-store.ts'
import type { CompareLoader, CompareState } from '../store/compare-store.ts'
import { createDiffStore, useDiffState } from '../store/diff-store.ts'
import type { DiffLoader, DiffState } from '../store/diff-store.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { StatusLetter } from '../ui/StatusLetter.tsx'
import { diffBody } from './FileHistoryPage.tsx'
import css from './HistoryPages.module.css'
import { listKeyAction, stepListIndex } from './list-keys.ts'
import { formatLogDate } from './LogRow.tsx'

/** DOM id of a compare file row (aria-activedescendant). */
export function compareFileId(path: string): string {
  return `compare-file-${path}`
}

export interface ComparePageViewProps {
  state: CompareState
  leftLabel: string
  /** null = worktree. */
  rightLabel: string | null
  diff: DiffState | null
  now: number
  highlighter?: CodeHighlighter
  onBack: () => void
  onSwap: () => void
  onLoadMore: () => void
  onRetry: () => void
  onSelectFile: (path: string) => void
  onShowInLog: (sha: string) => void
}

export function ComparePageView(props: ComparePageViewProps): ReactNode {
  const t = useT()
  const { state, leftLabel, rightLabel } = props
  const right = rightLabel ?? t('compare.worktree')
  return (
    <div className={css.root} role="dialog" aria-label={t('compare.dialog', { left: leftLabel, right })} tabIndex={-1} data-compare>
      <div className={css.header}>
        <Button title={t('diff.back.title')} onClick={props.onBack}>{t('diff.back')}</Button>
        <span className={css.title}>{t('compare.title')}</span>
      </div>
      <div className={css.banner}>
        <span className={css.bannerText}>
          {rightLabel === null ? t('compare.banner.worktree', { left: leftLabel }) : t('compare.banner', { left: leftLabel, right: rightLabel })}
        </span>
        {rightLabel === null ? null : (
          <Button title={t('compare.swap.title', { left: leftLabel, right: rightLabel })} onClick={props.onSwap}>{t('compare.swap')}</Button>
        )}
      </div>
      {listsOf(props, t)}
      {state.selectedPath === null ? null : (
        <div className={css.diff} data-compare-diff>
          <div className={css.diffHeader}><span className={css.subject}>{state.selectedPath}</span></div>
          {diffBody(props.diff, props.highlighter, t, t('compare.diff.empty'))}
        </div>
      )}
    </div>
  )
}

function listsOf(props: ComparePageViewProps, t: Translate): ReactNode {
  const { state, leftLabel, rightLabel } = props
  if (state.status === 'error') {
    return <div className={css.state}><EmptyState error title={t('compare.loadFailed')} hint={state.error?.message ?? t('action.retryHint')} action={{ label: t('action.retry'), onClick: props.onRetry }} /></div>
  }
  if (state.value === null) return <p className={css.state} role="status">{t('compare.loading')}</p>
  return (
    <div className={css.lists}>
      {rightLabel === null ? null : (
        <>
          <div className={css.section}>{t('compare.commits', { count: state.commits.length })}</div>
          {state.commits.length === 0 ? (
            <p className={css.section}>{t('compare.commits.empty', { left: leftLabel, right: rightLabel })}</p>
          ) : (
            <ul className={css.list}>
              {state.commits.map(commit => (
                <li
                  key={commit.sha}
                  className={css.row}
                  tabIndex={0}
                  title={t('compare.showInLog')}
                  onDoubleClick={() => { props.onShowInLog(commit.sha) }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    props.onShowInLog(commit.sha)
                  }}
                >
                  <span className={css.sha}>{commit.shortSha}</span>
                  <span className={css.subject}>{commit.subject}</span>
                  <span className={css.muted}>{commit.author}</span>
                  <time className={css.muted} dateTime={commit.date}>{formatLogDate(commit.date, props.now)}</time>
                </li>
              ))}
            </ul>
          )}
          {state.next === undefined ? null : (
            <div className={css.more}>
              <Button disabled={state.loadingMore} onClick={props.onLoadMore}>{state.loadingMore ? t('blame.loadingMore') : t('compare.loadMore')}</Button>
            </div>
          )}
        </>
      )}
      <div className={css.section}>{t('compare.files', { count: state.files.length })}</div>
      {state.files.length === 0 ? <p className={css.section}>{t('compare.files.empty')}</p> : (
        <ul
          className={css.list}
          role="listbox"
          tabIndex={0}
          aria-label={t('compare.files', { count: state.files.length })}
          {...(state.selectedPath === null ? {} : { 'aria-activedescendant': compareFileId(state.selectedPath) })}
          onKeyDown={(event) => {
            const action = listKeyAction(event)
            if (action === null || action === 'menu') return
            event.preventDefault()
            const index = state.files.findIndex(file => file.path === state.selectedPath)
            const target = action === 'activate' ? state.files[index] : state.files[stepListIndex(state.files.length, index, action)]
            if (target === undefined) return
            props.onSelectFile(target.path)
            globalThis.document?.getElementById(compareFileId(target.path))?.scrollIntoView({ block: 'nearest' })
          }}
        >
          {state.files.map(file => (
            <li
              key={file.path}
              id={compareFileId(file.path)}
              role="option"
              aria-selected={file.path === state.selectedPath}
              className={css.row}
              onClick={() => { props.onSelectFile(file.path) }}
            >
              <StatusLetter status={file.status} />
              <span className={css.subject} title={file.path}>
                {file.origPath === undefined ? file.path : t('history.renamedFrom', { from: file.origPath, to: file.path })}
              </span>
              {file.additions === undefined || file.deletions === undefined ? null : (
                <span className={css.muted}>{t('history.lines', { add: file.additions, del: file.deletions })}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.value.filesTruncated ? <p className={css.section}>{t('compare.files.truncated', { count: STATUS_ENTRY_LIMIT })}</p> : null}
    </div>
  )
}

export interface ComparePageProps {
  sessionId: string
  left: string
  right: string | null
  leftLabel: string
  rightLabel: string | null
  load: CompareLoader
  loadDiff: DiffLoader
  onBack: () => void
  onShowInLog: (sha: string) => void
  useHighlighter?: (language: string | undefined) => CodeHighlighter
}

/** Container: owns the compare and diff stores for one comparison; swapping stays inside the page. */
export function ComparePage(props: ComparePageProps): ReactNode {
  const { sessionId, useHighlighter = useCodeHighlighter } = props
  const loadRef = useRef(props.load)
  const loadDiffRef = useRef(props.loadDiff)
  loadRef.current = props.load
  loadDiffRef.current = props.loadDiff
  const diffStore = useMemo(() => createDiffStore({ load: (request, signal) => loadDiffRef.current(request, signal) }), [])
  const store = useMemo(
    () => createCompareStore({ sessionId, load: (request, signal) => loadRef.current(request, signal), diff: diffStore }),
    [sessionId, diffStore],
  )
  const state = useCompareState(store)
  const diffState = useDiffState(diffStore)
  const highlighter = useHighlighter(state.selectedPath === null ? undefined : languageForPath(state.selectedPath))
  useEffect(() => {
    void store.open({ left: props.left, right: props.right })
  }, [store, props.left, props.right])
  useEffect(() => () => { store.close() }, [store])
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { rootRef.current?.querySelector<HTMLElement>('[data-compare]')?.focus() }, [])
  // After a swap the labels follow the sides.
  const swapped = state.target !== null && state.target.left !== props.left
  const leftLabel = swapped ? (props.rightLabel ?? props.right ?? '') : props.leftLabel
  const rightLabel = swapped ? props.leftLabel : props.rightLabel
  return (
    <div ref={rootRef}>
      <ComparePageView
        state={state}
        leftLabel={leftLabel}
        rightLabel={rightLabel}
        diff={diffState}
        now={Date.now()}
        highlighter={highlighter}
        onBack={props.onBack}
        onSwap={() => { void store.swap() }}
        onLoadMore={() => { void store.loadMore() }}
        onRetry={() => { void store.open(state.target ?? { left: props.left, right: props.right }) }}
        onSelectFile={(path) => { void store.selectFile(path) }}
        onShowInLog={props.onShowInLog}
      />
    </div>
  )
}
