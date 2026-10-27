// Hover card of a blame segment (design §9.7): subject, author, time, copy hash, show in log.
import type { ReactNode } from 'react'
import type { BlameCommit } from '../../shared/protocol.ts'
import { useT } from '../i18n.tsx'
import { formatLogDate } from './LogRow.tsx'
import css from './BlameView.module.css'

export interface BlameHoverCardProps {
  commit: BlameCommit
  now: number
  /** Offset inside the scrolled canvas, right below the hovered row. */
  top: number
  onCopyHash: (sha: string) => void
  onShowInLog: (sha: string) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export function BlameHoverCard({ commit, now, top, onCopyHash, onShowInLog, onMouseEnter, onMouseLeave }: BlameHoverCardProps): ReactNode {
  const t = useT()
  return (
    <div
      className={css.hoverCard}
      style={{ top }}
      role="tooltip"
      data-blame-hover
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {commit.uncommitted ? (
        <p className={css.hoverSubject}>{t('blame.commit.uncommitted')}</p>
      ) : (
        <>
          <p className={css.hoverSubject}>{commit.subject}</p>
          <p className={css.hoverMeta}>
            <span>{commit.author}</span>
            <span>{commit.email}</span>
            <time dateTime={commit.date}>{formatLogDate(commit.date, now)}</time>
          </p>
          {commit.boundary ? <p className={css.hoverMeta}>{t('blame.boundary')}</p> : null}
          <p className={css.hoverActions}>
            <code>{commit.shortSha}</code>
            <button type="button" className={css.link} onClick={() => { onCopyHash(commit.sha) }}>{t('blame.commit.copyHash')}</button>
            <button type="button" className={css.link} onClick={() => { onShowInLog(commit.sha) }}>{t('blame.commit.showInLog')}</button>
          </p>
        </>
      )}
    </div>
  )
}
