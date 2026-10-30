// B4d T3: the empty state when the Host has no usable git (design §7.2), and the git path field it
// shares with the settings sheet.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GitMissing } from './git-path.ts'
import css from './git-missing.module.css'
import { useT } from './i18n.tsx'
import { Button } from './ui/Button.tsx'

export const GIT_INSTALL_URL = 'https://git-scm.com/downloads'

export interface GitPathFieldProps {
  /** Initial text: the stored setting. */
  value: string | null
  busy: boolean
  error: string | null
  autoFocus?: boolean
  /** t2 T5: the session may not change the git path (read-only); the field is shown but inert. */
  disabled?: boolean
  onApply(path: string): void
}

/** Absolute path input + Apply; the last rejection is read out as an alert. */
export function GitPathField({ value, busy, error, autoFocus = false, disabled = false, onApply }: GitPathFieldProps): ReactNode {
  const t = useT()
  const [text, setText] = useState(value ?? '')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])
  return (
    <>
      <form
        className={css.field}
        onSubmit={(event) => {
          event.preventDefault()
          if (!disabled) onApply(text)
        }}
      >
        <input
          ref={inputRef}
          className={css.input}
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label={t('git.path.label')}
          placeholder="/usr/local/bin/git"
          value={text}
          data-setting="gitPath"
          disabled={disabled}
          onChange={event => setText(event.target.value)}
        />
        <Button type="submit" disabled={busy || disabled}>{t('git.path.apply')}</Button>
      </form>
      {error === null ? null : <p role="alert" className={css.error}>{error}</p>}
    </>
  )
}

export interface GitMissingViewProps {
  missing: GitMissing
  gitPath: string | null
  busy: boolean
  error: string | null
  /**
   * t2 T5 (owner's choice): a read-only session cannot set the git path, so the entry is hidden;
   * the install guide and re-detect stay. Known from the Host refusing a path (bootstrap has no
   * write policy while git is missing).
   */
  readOnly?: boolean
  onRedetect(): void
  onApply(path: string): void
}

export function GitMissingView({ missing, gitPath, busy, error, readOnly = false, onRedetect, onApply }: GitMissingViewProps): ReactNode {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const showField = !readOnly && (editing || gitPath !== null || error !== null)
  return (
    <section className={css.panel} data-git-missing={missing.kind}>
      <h2 className={css.title}>{t(missing.kind === 'not-found' ? 'git.notFound.title' : 'git.unsupported.title')}</h2>
      <p className={css.body}>
        {missing.kind === 'not-found'
          ? t('git.notFound.body')
          : t('git.unsupported.body', { current: missing.current, minimum: missing.minimum })}
      </p>
      <a className={css.link} href={GIT_INSTALL_URL} target="_blank" rel="noopener noreferrer">{t('git.install')}</a>
      <div className={css.actions}>
        <Button tone="primary" disabled={busy} onClick={onRedetect}>{t('git.redetect')}</Button>
        {showField || readOnly ? null : <Button disabled={busy} onClick={() => { setEditing(true) }}>{t('git.setPath')}</Button>}
      </div>
      {readOnly ? <p className={css.body} data-git-path-read-only="">{t('git.path.readOnly')}</p> : null}
      {showField ? <GitPathField value={gitPath} busy={busy} error={error} autoFocus={editing} onApply={onApply} /> : null}
    </section>
  )
}
