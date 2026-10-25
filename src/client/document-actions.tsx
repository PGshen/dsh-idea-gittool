/**
 * Header actions contributed to the Sidebar document preview for the file
 * currently on screen. M0 shows the file's git status letter and a `Blame`
 * action; history and diff stay disabled until B2. The two helpers at the top
 * are pure so the mapping is testable without a slot runtime.
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Loads the SlotMap declaration for 'sidebar.right.tab.document.actions'.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'

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
  readonly openBlame?: (absolutePath: string, repoRelativePath?: string) => string | null
  /** Status letter for one file, when a status source is wired. */
  readonly statusFor?: (absolutePath: string) => FileStatusLetter | null
  /** Repository root for one file, used to derive the repo-relative path. */
  readonly repoRootFor?: (absolutePath: string) => string | null
}

/** Full component props: the slot's owner inputs plus the injected lookups. */
export type DocumentActionsProps =
  PropsRuntime<'sidebar.right.tab.document.actions'> & DocumentActionsInjected

const STATUS_COLOR: Record<FileStatusLetter, string> = {
  M: 'var(--dsw-alias-state-warn)',
  A: 'var(--dsw-alias-state-success)',
  D: 'var(--dsw-alias-state-error-primary)',
  U: 'var(--dsw-alias-label-tertiary)',
}

const ROW_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
}

const BADGE_STYLE: CSSProperties = {
  minWidth: '14px',
  textAlign: 'center',
  fontFamily: 'var(--dsw-font-mono, monospace)',
  fontSize: '11px',
  fontWeight: 600,
}

const BUTTON_STYLE: CSSProperties = {
  padding: '0 6px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: '4px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: '12px',
  lineHeight: 1.5,
  cursor: 'pointer',
}

const DISABLED_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_STYLE,
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'not-allowed',
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
  const { absolutePath, openBlame, statusFor, repoRootFor } = props
  const [failure, setFailure] = useState<string | null>(null)
  const status = statusFor?.(absolutePath) ?? null
  const repoRelativePath = toRepoRelativePath(absolutePath, repoRootFor?.(absolutePath))
  const handleBlame = (): void => {
    if (openBlame === undefined) return
    setFailure(openBlame(absolutePath, repoRelativePath ?? undefined))
  }
  return (
    <div
      className="git-document-actions"
      style={ROW_STYLE}
      data-repo-path={repoRelativePath ?? undefined}
    >
      {status === null
        ? (
          <span
            className="git-document-actions__status"
            data-status="unknown"
            style={{ ...BADGE_STYLE, color: 'var(--dsw-alias-label-tertiary)' }}
            title="Git 状态待接入"
          >
            ·
          </span>
        )
        : (
          <span
            className="git-document-actions__status"
            data-status={status}
            style={{ ...BADGE_STYLE, color: STATUS_COLOR[status] }}
            title={`Git 状态：${status}`}
          >
            {status}
          </span>
        )}
      <button
        type="button"
        className="git-document-actions__action"
        style={openBlame === undefined ? DISABLED_BUTTON_STYLE : BUTTON_STYLE}
        onClick={handleBlame}
        disabled={openBlame === undefined}
      >
        Blame
      </button>
      <button
        type="button"
        className="git-document-actions__action"
        style={DISABLED_BUTTON_STYLE}
        disabled
        title="历史视图将在 B2 实现"
      >
        历史
      </button>
      <button
        type="button"
        className="git-document-actions__action"
        style={DISABLED_BUTTON_STYLE}
        disabled
        title="Diff 视图将在 B2 实现"
      >
        Diff
      </button>
      {failure === null
        ? null
        : (
          <span
            className="git-document-actions__failure"
            role="alert"
            style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: '11px' }}
          >
            {failure}
          </span>
        )}
    </div>
  )
}
