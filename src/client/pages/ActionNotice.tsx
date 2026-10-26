// Result notice of a write action that has no sheet to show it (branch menu checkout, fetch, …).
import type { ReactNode } from 'react'
import { useT } from '../i18n.tsx'
import type { ActionNotice as ActionNoticeValue, NoticeActionId } from './branch-actions.ts'
import css from './ActionNotice.module.css'

export interface ActionNoticeProps {
  notice: ActionNoticeValue | null
  onDismiss: () => void
  /** The notice's button was pressed (only notices with an `action` show one). */
  onAction?: (action: NoticeActionId) => void
}

export function ActionNotice({ notice, onDismiss, onAction }: ActionNoticeProps): ReactNode {
  const t = useT()
  if (notice === null) return null
  return (
    <div
      className={`${css.notice} ${notice.tone === 'error' ? css.error : css.warning}`}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      data-notice={notice.tone}
    >
      <span className={css.message}>
        {t(notice.message.key, notice.message.params)}
        {notice.detail === undefined
          ? null
          : <span className={css.detail} data-notice-detail>{t(notice.detail.key, notice.detail.params)}</span>}
      </span>
      {notice.action === undefined || onAction === undefined
        ? null
        : (
            <button type="button" className={css.link} data-notice-action={notice.action} onClick={() => onAction(notice.action as NoticeActionId)}>
              {t('notice.goStash')}
            </button>
          )}
      <button type="button" className={css.dismiss} aria-label={t('notice.dismiss')} title={t('notice.dismiss')} onClick={onDismiss}>
        ✕
      </button>
    </div>
  )
}
