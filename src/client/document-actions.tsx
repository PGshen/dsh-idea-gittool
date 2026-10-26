/**
 * Header actions contributed to the Sidebar document preview for the file
 * currently on screen. M0 shows the file's git status letter and a `Blame`
 * action; history and diff stay disabled until B2. The two helpers at the top
 * are pure so the mapping is testable without a slot runtime.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Loads the SlotMap declaration for 'sidebar.right.tab.document.actions'.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import css from './document-actions.module.css'
import { render } from './localized-text.ts'
import type { LocalizedText } from './localized-text.ts'

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
  /** Status letter for one file, when a status source is wired. */
  readonly statusFor?: (absolutePath: string) => FileStatusLetter | null
  /** Repository root for one file, used to derive the repo-relative path. */
  readonly repoRootFor?: (absolutePath: string) => string | null
  /** 订阅式状态来源：有实时 bootstrap 快照时优先于 statusFor。 */
  readonly useStatus?: (absolutePath: string) => FileStatusLetter | null
}

const NO_STATUS = (): FileStatusLetter | null => null

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
 * @param props - absolute path, optional lookups injected, and the open action.
 * @returns the status badge followed by the document actions.
 */
export function DocumentActions(props: DocumentActionsProps): ReactNode {
  const { absolutePath, openBlame, statusFor, repoRootFor, useStatus, t } = props
  const [failure, setFailure] = useState<LocalizedText | null>(null)
  // Hook 位置稳定：注册时固定传同一个函数，缺省用无副作用的 NO_STATUS。
  const useStatusHook = useStatus ?? NO_STATUS
  const liveStatus = useStatusHook(absolutePath)
  const status = liveStatus ?? statusFor?.(absolutePath) ?? null
  const repoRelativePath = toRepoRelativePath(absolutePath, repoRootFor?.(absolutePath))
  const handleBlame = (): void => {
    if (openBlame === undefined) return
    setFailure(openBlame(absolutePath, repoRelativePath ?? undefined))
  }
  return (
    <div
      className={`git-document-actions ${css.row}`}
      data-repo-path={repoRelativePath ?? undefined}
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
          <span
            className={`git-document-actions__status ${css.badge} ${STATUS_CLASS[status]}`}
            data-status={status}
            title={t('document.status', { status })}
          >
            {status}
          </span>
        )}
      <button
        type="button"
        className={openBlame === undefined ? `git-document-actions__action ${css.action} ${css.actionDisabled}` : `git-document-actions__action ${css.action}`}
        onClick={handleBlame}
        disabled={openBlame === undefined}
      >
        Blame
      </button>
      <button
        type="button"
        className={`git-document-actions__action ${css.action} ${css.actionDisabled}`}
        disabled
        title={t('document.history.pending')}
      >
        {t('document.history')}
      </button>
      <button
        type="button"
        className={`git-document-actions__action ${css.action} ${css.actionDisabled}`}
        disabled
        title={t('document.diff.pending')}
      >
        Diff
      </button>
      {failure === null
        ? null
        : (
          <span
            className={`git-document-actions__failure ${css.failure}`}
            role="alert"
          >
            {render(t, failure)}
          </span>
        )}
    </div>
  )
}
