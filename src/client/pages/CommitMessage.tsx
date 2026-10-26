// Commit message box (design §8.2.3): 3–8 rows auto-size, subject length hint, history, Cmd/Ctrl+Enter.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useT } from '../i18n.tsx'
import { isSubmitShortcut, messageRows, subjectHint } from '../store/commit-store.ts'
import css from './CommitMessage.module.css'

/** First line of a history entry, for the dropdown. */
export function historyPreview(message: string): string {
  return message.split('\n', 1)[0] ?? ''
}

export interface CommitMessageProps {
  value: string
  onChange: (message: string) => void
  /** Cmd/Ctrl+Enter. */
  onSubmit: () => void
  history: readonly string[]
  /** A history entry was picked; the caret is moved to the end afterwards. */
  onPickHistory: (message: string) => void
  disabled?: boolean
  /** Lets the panel focus the box ("Commit this file…"). */
  textareaRef?: RefObject<HTMLTextAreaElement>
}

export function CommitMessage({ value, onChange, onSubmit, history, onPickHistory, disabled = false, textareaRef }: CommitMessageProps): ReactNode {
  const t = useT()
  const [historyOpen, setHistoryOpen] = useState(false)
  const localRef = useRef<HTMLTextAreaElement>(null)
  const ref = textareaRef ?? localRef
  const caretToEnd = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const hint = subjectHint(value, t)

  useEffect(() => {
    if (!caretToEnd.current) return
    caretToEnd.current = false
    const element = ref.current
    if (element === null) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [ref, value])

  useEffect(() => {
    if (!historyOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current !== null && event.target instanceof Node && menuRef.current.contains(event.target)) return
      setHistoryOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [historyOpen])

  return (
    <div className={css.root} data-commit-message>
      <div className={css.header}>
        <label className={css.label} htmlFor="dsh-git-commit-message">{t('message.label')}</label>
        <div ref={menuRef} className={css.historyAnchor}>
          <button
            type="button"
            className={css.historyButton}
            aria-haspopup="listbox"
            aria-expanded={historyOpen}
            disabled={disabled}
            onClick={() => setHistoryOpen(open => !open)}
          >
            {t('message.history')}
          </button>
          {historyOpen
            ? (
                <div
                  role="listbox"
                  aria-label={t('message.historyLabel')}
                  className={css.historyMenu}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      setHistoryOpen(false)
                      ref.current?.focus()
                    }
                  }}
                >
                  {history.length === 0
                    ? <div className={css.historyEmpty}>{t('message.historyEmpty')}</div>
                    : history.map(item => (
                        <button
                          key={item}
                          type="button"
                          role="option"
                          aria-selected={false}
                          className={css.historyItem}
                          title={item}
                          onClick={() => {
                            caretToEnd.current = true
                            onPickHistory(item)
                            setHistoryOpen(false)
                          }}
                        >
                          {historyPreview(item)}
                        </button>
                      ))}
                </div>
              )
            : null}
        </div>
      </div>
      <textarea
        id="dsh-git-commit-message"
        ref={ref}
        className={css.input}
        rows={messageRows(value)}
        value={value}
        placeholder={t('message.placeholder')}
        spellCheck={false}
        disabled={disabled}
        aria-describedby={hint === null ? undefined : 'dsh-git-commit-subject-hint'}
        onChange={event => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (isSubmitShortcut({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, isComposing: event.nativeEvent.isComposing })) {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
      <div className={css.footer}>
        {hint === null ? <span /> : <span id="dsh-git-commit-subject-hint" className={css.hint} data-subject-hint>{hint}</span>}
        <span className={css.shortcut}>{t('message.shortcutHint')}</span>
      </div>
    </div>
  )
}
