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
  onApply(path: string): void
}

/** Absolute path input + Apply; the last rejection is read out as an alert. */
export function GitPathField({ value, busy, error, autoFocus = false, onApply }: GitPathFieldProps): ReactNode {
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
          onApply(text)
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
          onChange={event => setText(event.target.value)}
        />
        <Button type="submit" disabled={busy}>{t('git.path.apply')}</Button>
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
  onRedetect(): void
  onApply(path: string): void
}

export function GitMissingView({ missing, gitPath, busy, error, onRedetect, onApply }: GitMissingViewProps): ReactNode {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const showField = editing || gitPath !== null || error !== null
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
        {showField ? null : <Button disabled={busy} onClick={() => { setEditing(true) }}>{t('git.setPath')}</Button>}
      </div>
      {showField ? <GitPathField value={gitPath} busy={busy} error={error} autoFocus={editing} onApply={onApply} /> : null}
    </section>
  )
}
