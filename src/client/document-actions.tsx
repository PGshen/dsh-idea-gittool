/**
 * Header actions contributed to the Sidebar document preview for the file
 * currently on screen: the file's git status letter (B2: a jump to the Commit
 * page), Blame (its own page), and history / diff (the Git tab, through the
 * per-session intent queue). The two helpers at the top
 * are pure so the mapping is testable without a slot runtime.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Loads the SlotMap declaration for 'sidebar.right.tab.document.actions'.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import css from './document-actions.module.css'
import { render, text } from './localized-text.ts'
import type { LocalizedText, Translate } from './localized-text.ts'
import type { WorkbenchIntent } from './workbench-intents.ts'

/** The one-letter git state a document header can show. */
export type FileStatusLetter = 'M' | 'A' | 'D' | 'U'

/** Repository-relative POSIX path, or `null` when the root does not contain the file. */
export function toRepoRelativePath(
  absolutePath: string,
  repoRoot: string | null | undefined,
): string | null {
  if (repoRoot === null || repoRoot === undefined || repoRoot.length === 0) return null
  const path = normalizeSeparators(absolutePath)
  const root = normalizeSeparators(repoRoot)
  if (root === '/') return path.length > 1 && path.startsWith('/') ? path.slice(1) : null
  if (path === root) return null
  const prefix = `${root}/`
  if (!path.startsWith(prefix)) return null
  const relative = path.slice(prefix.length)
  return relative.length === 0 ? null : relative
}

/**
 * Reduce a git status code (porcelain `XY`, or a single letter) to the letter
 * the header shows: untracked/unmerged become `U`, renames/copies/type changes
 * count as `M`, and a clean or unrecognised code yields `null`.
 * @param code - raw git status code, possibly with a leading column space.
 * @returns the display letter, or null when there is nothing to show.
 */
export function statusLetterOf(code: string | null | undefined): FileStatusLetter | null {
  if (code === null || code === undefined) return null
  const trimmed = code.trim()
  if (trimmed.length === 0) return null
  if (trimmed.includes('?')) return 'U'
  const letters = trimmed.toUpperCase()
  if (letters.includes('U')) return 'U'
  if (letters.includes('A')) return 'A'
  if (letters.includes('D')) return 'D'
  if (/[MRCT]/u.test(letters)) return 'M'
  return null
}

/** Business face injected when the header action is registered. */
export interface DocumentActionsInjected {
  /** Open the blame page for one file; returns a user-facing failure, or null. */
  readonly openBlame?: (absolutePath: string, repoRelativePath?: string) => LocalizedText | null
  /** B2: hand an intent to the Git tab of this session; returns a user-facing failure, or null. */
  readonly openInGit?: (intent: WorkbenchIntent) => LocalizedText | null
  /** Status letter for one file, when a status source is wired. */
  readonly statusFor?: (absolutePath: string) => FileStatusLetter | null
  /** Repository root for one file, used to derive the repo-relative path. */
  readonly repoRootFor?: (absolutePath: string) => string | null
  /** 订阅式状态来源：有实时 bootstrap 快照时优先于 statusFor。 */
  readonly useStatus?: (absolutePath: string) => FileStatusLetter | null
}

const NO_STATUS = (): FileStatusLetter | null => null

/** Why each header action is unavailable (null = available). */
export interface DocumentActionStates {
  blame: LocalizedText | null
  history: LocalizedText | null
  diff: LocalizedText | null
  /** Clicking the status badge (select the change on the Commit page). */
  status: LocalizedText | null
}

/**
 * Availability of the header actions (B2). Blame opens its own page, which explains a file outside the
 * repository; history, diff and the status jump need the repository path for the Git tab.
 */
export function documentActionStates(input: {
  repoPath: string | null
  status: FileStatusLetter | null
  openInGit: boolean
  openBlame: boolean
}): DocumentActionStates {
  const unwired = text('document.status.pending')
  const outside = input.repoPath === null ? text('document.notInRepo') : null
  const git = input.openInGit ? outside : unwired
  const clean = input.status === null ? text('document.diff.clean') : null
  return {
    blame: input.openBlame ? null : unwired,
    history: git,
    diff: git ?? clean,
    status: git ?? clean,
  }
}

const COMPACT_WIDTH = 280

export interface DocumentActionsViewProps {
  t: Translate
  status: FileStatusLetter | null
  repoPath: string | null
  states: DocumentActionStates
  /** Narrow header: history and diff fold under ⋯ (design §9.7). */
  compact: boolean
  failure: LocalizedText | null
  onBlame: () => void
  onIntent: (intent: WorkbenchIntent) => void
  rowRef?: Ref<HTMLDivElement>
}

/** Hook-free header contribution, so the layout is testable without a DOM. */
export function DocumentActionsView(props: DocumentActionsViewProps): ReactNode {
  const { t, status, repoPath, states, compact } = props
  const action = (
    label: string,
    reason: LocalizedText | null,
    title: string,
    run: () => void,
  ): ReactNode => (
    <button
      type="button"
      className={reason === null ? `git-document-actions__action ${css.action}` : `git-document-actions__action ${css.action} ${css.actionDisabled}`}
      onClick={run}
      disabled={reason !== null}
      title={reason === null ? title : render(t, reason)}
    >
      {label}
    </button>
  )
  const history = action(t('document.history'), states.history, t('document.history.title'), () => {
    if (repoPath !== null) props.onIntent({ kind: 'fileHistory', path: repoPath })
  })
  const diff = action('Diff', states.diff, t('document.diff.title'), () => {
    if (repoPath !== null) props.onIntent({ kind: 'worktreeDiff', path: repoPath })
  })
  return (
    <div
      ref={props.rowRef}
      className={`git-document-actions ${css.row}`}
      data-repo-path={repoPath ?? undefined}
    >
      {status === null
        ? (
          <span
            className={`git-document-actions__status ${css.badge} ${css.unknown}`}
            data-status="unknown"
            title={t('document.status.pending')}
          >
            ·
          </span>
        )
        : (
          <button
            type="button"
            className={`git-document-actions__status ${css.badge} ${css.badgeButton} ${STATUS_CLASS[status]}`}
            data-status={status}
            disabled={states.status !== null}
            title={states.status === null ? t('document.status.open', { status }) : t('document.status', { status })}
            onClick={() => { if (repoPath !== null) props.onIntent({ kind: 'selectChange', path: repoPath }) }}
          >
            {status}
          </button>
        )}
      {action('Blame', states.blame, 'Blame', props.onBlame)}
      {compact
        ? (
          <details className={css.more}>
            <summary className={`git-document-actions__action ${css.action}`} title={t('document.more')} aria-label={t('document.more')}>⋯</summary>
            <div className={css.moreMenu}>{history}{diff}</div>
          </details>
        )
        : <>{history}{diff}</>}
      {states.history !== null && states.history.key === 'document.notInRepo'
        ? <span className={`git-document-actions__note ${css.note}`}>{render(t, states.history)}</span>
        : null}
      {props.failure === null
        ? null
        : (
          <span
            className={`git-document-actions__failure ${css.failure}`}
            role="alert"
          >
            {render(t, props.failure)}
          </span>
        )}
    </div>
  )
}

/** Full component props: the slot's owner inputs plus the injected lookups. */
export type DocumentActionsProps =
  PropsRuntime<'sidebar.right.tab.document.actions'> & PropsLocale<'gitWorkbench'> & DocumentActionsInjected

/** 状态字母 → 语义色类。 */
const STATUS_CLASS: Record<FileStatusLetter, string> = {
  M: css.statusM ?? '',
  A: css.statusA ?? '',
  D: css.statusD ?? '',
  U: css.statusU ?? '',
}

function normalizeSeparators(path: string): string {
  const slashed = path.replace(/\\/gu, '/')
  const withoutTrailing = slashed.length > 1 ? slashed.replace(/\/+$/u, '') : slashed
  return withoutTrailing.length === 0 ? '/' : withoutTrailing
}

/**
 * Draw the document header's git contribution.
 * @param props - absolute path, optional lookups injected, and the open actions.
 * @returns the status badge followed by the document actions.
 */
export function DocumentActions(props: DocumentActionsProps): ReactNode {
  const { absolutePath, openBlame, openInGit, statusFor, repoRootFor, useStatus, t } = props
  const [failure, setFailure] = useState<LocalizedText | null>(null)
  const [compact, setCompact] = useState(false)
  const rowRef = useRef<HTMLDivElement | null>(null)
  // Hook 位置稳定：注册时固定传同一个函数，缺省用无副作用的 NO_STATUS。
  const useStatusHook = useStatus ?? NO_STATUS
  const liveStatus = useStatusHook(absolutePath)
  const status = liveStatus ?? statusFor?.(absolutePath) ?? null
  const repoRelativePath = toRepoRelativePath(absolutePath, repoRootFor?.(absolutePath))
  // Narrow header (design §9.7): measure the header the row sits in, not the row itself.
  useLayoutEffect(() => {
    const host = rowRef.current?.parentElement
    if (host === null || host === undefined || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { setCompact(host.clientWidth < COMPACT_WIDTH) })
    observer.observe(host)
    return () => { observer.disconnect() }
  }, [])
  return (
    <DocumentActionsView
      t={t}
      status={status}
      repoPath={repoRelativePath}
      states={documentActionStates({ repoPath: repoRelativePath, status, openInGit: openInGit !== undefined, openBlame: openBlame !== undefined })}
      compact={compact}
      failure={failure}
      rowRef={rowRef}
      onBlame={() => { if (openBlame !== undefined) setFailure(openBlame(absolutePath, repoRelativePath ?? undefined)) }}
      onIntent={(intent) => { if (openInGit !== undefined) setFailure(openInGit(intent)) }}
    />
  )
}
