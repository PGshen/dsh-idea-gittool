// "Uncommitted changes" question of smart operations (design §8.3.3, plan A3 T6): lists the first
// changed paths and the total, then "stash and continue" (the action store resends with
// `stash: true`) or "cancel" (nothing is sent). Esc and the scrim cancel.
import { useEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import type { StashAsk } from '../store/action-store.ts'
import { Button } from '../ui/Button.tsx'
import css from './DirtyWorktreeSheet.module.css'

/** Paths listed before the total. */
export const DIRTY_VISIBLE_PATHS = 10

export interface DirtyWorktreeSheetViewProps {
  t: Translate
  ask: StashAsk
  rootRef?: Ref<HTMLDivElement>
  onStash: () => void
  onCancel: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function DirtyWorktreeSheetView({ t, ask, rootRef, onStash, onCancel, onKeyDown }: DirtyWorktreeSheetViewProps): ReactNode {
  const operation = t(`smart.operation.${ask.operation}`)
  const visible = ask.paths.slice(0, DIRTY_VISIBLE_PATHS)
  const more = Math.max(ask.count, ask.paths.length) - visible.length
  return (
    <div className={css.layer} data-dirty-worktree-sheet>
      <div className={css.scrim} aria-hidden="true" onClick={onCancel} />
      <div
        ref={rootRef}
        className={css.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t('dirty.dialogLabel', { operation })}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className={css.header}>
          <strong>{t('dirty.title')}</strong>
          <span className={css.muted}>{t('dirty.count', { count: ask.count })}</span>
        </header>
        <div className={css.body}>
          <ul className={css.files} aria-label={t('dirty.count', { count: ask.count })}>
            {visible.map(path => <li key={path} className={css.file} title={path}>{path}</li>)}
          </ul>
          {more > 0 ? <p className={css.muted} data-dirty-more>{t('dirty.more', { count: more })}</p> : null}
          <p className={css.hint}>{t('dirty.hint', { operation })}</p>
          <footer className={css.footer}>
            <span className={css.actions}>
              <Button onClick={onCancel} data-cancel>{t('action.cancel')}</Button>
              <Button tone="primary" onClick={onStash} data-primary>{t('dirty.stash')}</Button>
            </span>
          </footer>
        </div>
      </div>
    </div>
  )
}

export function handleDirtyEscape(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'preventDefault' | 'stopPropagation'>,
  cancel: () => void,
): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  cancel()
}

export interface DirtyWorktreeSheetProps {
  ask: StashAsk
  /** "Stash and continue": the caller answers the action store and closes the overlay. */
  onStash: () => void
  /** "Cancel", Esc or the scrim: no side effects. */
  onCancel: () => void
}

export function DirtyWorktreeSheet({ ask, onStash, onCancel }: DirtyWorktreeSheetProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { rootRef.current?.focus() }, [])
  return (
    <DirtyWorktreeSheetView
      t={t}
      ask={ask}
      rootRef={rootRef}
      onStash={onStash}
      onCancel={onCancel}
      onKeyDown={event => handleDirtyEscape(event, onCancel)}
    />
  )
}
