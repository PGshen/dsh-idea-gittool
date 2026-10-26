// Level 0 "Stash" page (design §8.4, plan A3 T10): the stash list, the files of the selected stash
// (reusing ChangedFilesTree; double click opens the diff overlay) and the actions create / apply /
// pop / delete. Everything addresses a stash by sha. The view is hook-free; StashPage owns the
// transient state (delete confirmation, selected file) and runs the writes.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { CommitFileEntry, DiffRequest, StashEntry, StashFilesValue } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { activeFocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { ActionStore } from '../store/action-store.ts'
import { canDropStash, stashDiffRequest, stashRelativeTime, stashRowKeyDecision, stashSummary, useStashState } from '../store/stash-store.ts'
import type { StashFileKind, StashStore, StashStoreState } from '../store/stash-store.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import type { ActionNotice } from './branch-actions.ts'
import { ChangedFilesTree } from './ChangedFilesTree.tsx'
import type { DiffSourcePart } from './DiffViewer.tsx'
import { escapeHandler } from './integrate-parts.tsx'
import { applyStash, dropStash, stashOutcomeEffect } from './stash-actions.ts'
import css from './StashPage.module.css'

export interface StashDiffOpen {
  request: DiffRequest
  /** Only the files of the opened kind: they share the request's base commit, so switching works. */
  files: CommitFileEntry[]
}

/** Diff overlay content for one file of a stash; null when the file or its commit is unknown. */
export function stashFileOpen(sessionId: string, value: StashFilesValue, kind: StashFileKind, path: string): StashDiffOpen | null {
  const request = stashDiffRequest(sessionId, value, kind, path)
  if (request === null) return null
  const source = kind === 'tracked' ? value.files : value.untracked
  if (!source.some(file => file.path === path)) return null
  const files = source.map((file): CommitFileEntry => (kind === 'tracked' ? { ...file, parentSha: value.parentSha } : { ...file }))
  return { request, files }
}

export interface SelectedStashFile { kind: StashFileKind; path: string }

export interface StashPageViewProps {
  state: StashStoreState
  /** "Now" for the relative times. */
  now: number
  /** A stash write is running. */
  busy: boolean
  /** Why create / apply / pop are unavailable (read-only, operation in progress). */
  block?: LocalizedText | undefined
  /** Why delete is unavailable (read-only only). */
  dropBlock?: LocalizedText | undefined
  /** The stash whose delete confirmation is open. */
  confirmingSha: string | null
  selectedFile?: SelectedStashFile | null | undefined
  onSelect: (sha: string) => void
  /** Enter / double click on a row: select it and open its first file's diff. */
  onPreview: (entry: StashEntry, trigger: FocusTarget | null) => void
  onCreate: (trigger: FocusTarget | null) => void
  onApply: (pop: boolean, trigger: FocusTarget | null) => void
  /** Asks (never deletes): opens the confirmation for `sha`. */
  onAskDrop: (sha: string) => void
  onCancelDrop: () => void
  onConfirmDrop: (trigger: FocusTarget | null) => void
  onSelectFile?: ((file: SelectedStashFile) => void) | undefined
  onOpenFile: (kind: StashFileKind, path: string) => void
  onRetry: () => void
}

function triggerOf(event: MouseEvent | KeyboardEvent): FocusTarget | null {
  const element = event.currentTarget
  return typeof HTMLElement !== 'undefined' && element instanceof HTMLElement ? element : activeFocusTarget()
}

function pathOfEvent(event: MouseEvent): string | null {
  const target = event.target
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null
  return target.closest<HTMLElement>('[data-path]')?.dataset['path'] ?? null
}

interface RowProps {
  entry: StashEntry
  selected: boolean
  now: number
  state: StashStoreState
  onSelect: (sha: string) => void
  onPreview: (entry: StashEntry, trigger: FocusTarget | null) => void
  onAskDrop: (sha: string) => void
  canDrop: boolean
}

function StashRow({ entry, selected, now, state, onSelect, onPreview, onAskDrop, canDrop }: RowProps): ReactNode {
  const t = useT()
  const relative = stashRelativeTime(entry.date, now)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const decision = stashRowKeyDecision(state.list.entries, entry.sha, event.key, canDrop)
    if (decision.kind === 'none') return
    event.preventDefault()
    if (decision.kind === 'move') {
      onSelect(decision.sha)
      event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-sha="${decision.sha}"]`)?.focus()
    } else if (decision.kind === 'preview') {
      onPreview(entry, triggerOf(event))
    } else {
      onSelect(entry.sha)
      onAskDrop(entry.sha)
    }
  }
  return (
    <div
      role="option"
      tabIndex={0}
      aria-selected={selected}
      data-sha={entry.sha}
      className={selected ? `${css.row} ${css.selected}` : css.row}
      title={t('stash.row.title', { message: entry.message, sha: entry.sha })}
      onClick={() => onSelect(entry.sha)}
      onDoubleClick={event => onPreview(entry, triggerOf(event))}
      onKeyDown={onKeyDown}
    >
      <span className={css.message}>{entry.message}</span>
      <span className={css.meta}>
        <span>{entry.branch === null ? t('stash.row.noBranch') : t('stash.row.branch', { branch: entry.branch })}</span>
        {entry.fileCount === undefined ? null : <span>{t('stash.row.files', { count: entry.fileCount })}</span>}
        <span title={entry.date}>{t(relative.key, relative.params)}</span>
        <span className={css.index}>{t('stash.row.index', { index: entry.index })}</span>
      </span>
    </div>
  )
}

interface DropConfirmProps {
  summary: string
  sha: string
  canDrop: boolean
  onCancel: () => void
  onConfirm: (trigger: FocusTarget | null) => void
}

/** Delete confirmation: focus lands on Cancel (Enter never destroys), Esc cancels, focus returns to the row. */
function DropConfirm({ summary, sha, canDrop, onCancel, onConfirm }: DropConfirmProps): ReactNode {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const root = rootRef.current
    root?.querySelector<HTMLElement>('[data-drop-confirm-cancel]')?.focus()
    const scope = root?.closest('section') ?? null
    return () => {
      // After the bar unmounted: back to the stash row (gone after a delete: nothing to focus).
      scope?.querySelector<HTMLElement>(`[data-sha="${sha}"]`)?.focus()
    }
  }, [sha])
  return (
    <div ref={rootRef} className={css.confirm} role="alert" data-drop-confirm onKeyDown={escapeHandler(false, onCancel)}>
      <span>{t('stash.dropConfirm', { summary })}</span>
      <span className={css.confirmActions}>
        <Button onClick={onCancel} data-drop-confirm-cancel>{t('stash.dropConfirm.cancel')}</Button>
        <Button tone="danger" disabled={!canDrop} onClick={event => onConfirm(event.currentTarget)} data-drop-confirm-ok>
          {t('stash.dropConfirm.ok')}
        </Button>
      </span>
    </div>
  )
}

export function StashPageView(props: StashPageViewProps): ReactNode {
  const t = useT()
  const { state, busy, block, dropBlock, confirmingSha } = props
  const { entries } = state.list
  const selected = entries.find(item => item.sha === state.selectedSha) ?? null
  const confirming = entries.find(item => item.sha === confirmingSha) ?? null
  const reasonOf = (reason: LocalizedText | undefined, needsSelection: boolean): string | undefined => {
    if (reason !== undefined) return t(reason.key, reason.params)
    if (needsSelection && selected === null) return t('stash.selectFirst')
    return undefined
  }
  const createReason = reasonOf(block, false)
  const applyReason = reasonOf(block, true)
  const dropReason = reasonOf(dropBlock, true)
  const canDrop = canDropStash(busy, dropBlock)

  let list: ReactNode
  if (state.list.status === 'error' && entries.length === 0) {
    list = (
      <EmptyState
        error
        title={t('stash.loadFailed', { code: state.list.error?.code ?? '' })}
        hint={state.list.error?.message ?? ''}
        action={{ label: t('action.retry'), onClick: props.onRetry }}
      />
    )
  } else if (entries.length === 0) {
    list = state.list.status === 'ready'
      ? (
          <EmptyState
            title={t('stash.empty')}
            hint={t('stash.empty.hint')}
            action={{ label: t('stash.create'), onClick: () => props.onCreate(activeFocusTarget()) }}
          />
        )
      : <div className={css.message} aria-busy>{t('state.loading')}</div>
  } else {
    list = (
      <div role="listbox" aria-label={t('stash.listLabel')} className={css.list}>
        {entries.map(entry => (
          <StashRow
            key={entry.sha}
            entry={entry}
            selected={entry.sha === state.selectedSha}
            now={props.now}
            state={state}
            onSelect={props.onSelect}
            onPreview={props.onPreview}
            onAskDrop={props.onAskDrop}
            canDrop={canDrop}
          />
        ))}
      </div>
    )
  }

  const filesState = state.files
  let detail: ReactNode
  if (selected === null) {
    detail = entries.length === 0 ? null : <p className={css.hint}>{t('stash.files.pickHint')}</p>
  } else if (filesState.status === 'loading' || filesState.sha !== selected.sha) {
    detail = <p className={css.hint} aria-busy>{t('state.loading')}</p>
  } else if (filesState.status === 'error') {
    detail = <p className={css.error} role="alert">{t('stash.files.loadFailed', { code: filesState.error?.code ?? '' })}</p>
  } else if (filesState.value !== null) {
    const value = filesState.value
    const section = (kind: StashFileKind, files: CommitFileEntry[]): ReactNode => (
      files.length === 0
        ? null
        : (
            <div
              key={kind}
              data-stash-files={kind}
              onDoubleClick={(event) => {
                const path = pathOfEvent(event)
                if (path !== null) props.onOpenFile(kind, path)
              }}
            >
              <ChangedFilesTree
                files={files}
                label={t(kind === 'tracked' ? 'stash.files.tracked' : 'stash.files.untracked')}
                {...(props.selectedFile?.kind === kind ? { selectedPath: props.selectedFile.path } : {})}
                onOpenFile={(file) => { props.onSelectFile?.({ kind, path: file.path }) }}
              />
            </div>
          )
    )
    detail = value.files.length === 0 && value.untracked.length === 0
      ? <p className={css.hint}>{t('stash.files.none')}</p>
      : (
          <>
            {section('tracked', value.files)}
            {section('untracked', value.untracked)}
            {value.truncated === true
              ? <p className={css.hint} data-stash-truncated>{t('stash.files.truncated', { count: value.files.length + value.untracked.length })}</p>
              : null}
            <p className={css.hint}>{t('stash.files.hint')}</p>
          </>
        )
  }

  return (
    <section className={css.page} aria-label={t('stash.title')}>
      <div className={css.header}>
        <strong className={css.title}>{`${t('stash.title')} (${entries.length})`}</strong>
        <span className={css.actions}>
          <Button
            disabled={busy || createReason !== undefined}
            title={createReason}
            onClick={event => props.onCreate(event.currentTarget)}
            data-stash-action="create"
          >
            {t('stash.create')}
          </Button>
          <Button
            disabled={busy || applyReason !== undefined}
            title={applyReason ?? t('stash.apply.title')}
            onClick={event => props.onApply(false, event.currentTarget)}
            data-stash-action="apply"
          >
            {t('stash.apply')}
          </Button>
          <Button
            disabled={busy || applyReason !== undefined}
            title={applyReason ?? t('stash.pop.title')}
            onClick={event => props.onApply(true, event.currentTarget)}
            data-stash-action="pop"
          >
            {t('stash.pop')}
          </Button>
          <Button
            tone="danger"
            disabled={busy || dropReason !== undefined}
            title={dropReason ?? t('stash.drop.title')}
            onClick={() => { if (selected !== null) props.onAskDrop(selected.sha) }}
            data-stash-action="drop"
          >
            {t('stash.drop')}
          </Button>
        </span>
      </div>
      {confirming === null
        ? null
        : (
            <DropConfirm
              summary={stashSummary(confirming.message)}
              sha={confirming.sha}
              canDrop={canDrop}
              onCancel={props.onCancelDrop}
              onConfirm={props.onConfirmDrop}
            />
          )}
      {state.list.status === 'error' && entries.length > 0
        ? (
            <div role="alert" className={css.inlineError}>
              <span>{t('refresh.failed', { code: state.list.error?.code ?? '' })}</span>
              <Button onClick={props.onRetry}>{t('action.retry')}</Button>
            </div>
          )
        : null}
      <div className={css.listArea}>{list}</div>
      {detail === null ? null : <div className={css.detail}>{detail}</div>}
    </section>
  )
}

export interface StashPageProps {
  store: StashStore
  sessionId: string
  actions: Pick<ActionStore, 'run'>
  busy: boolean
  block?: LocalizedText | undefined
  dropBlock?: LocalizedText | undefined
  onNotice: (notice: ActionNotice | null) => void
  onOpenDiff: (request: DiffRequest, files: CommitFileEntry[], source: DiffSourcePart[]) => void
  onCreate: (trigger: FocusTarget | null) => void
  onRetry: () => void
}

export function StashPage(props: StashPageProps): ReactNode {
  const { store, sessionId, actions, onNotice, onOpenDiff } = props
  const state = useStashState(store)
  const [confirmingSha, setConfirmingSha] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<SelectedStashFile | null>(null)

  const openFile = (value: StashFilesValue, kind: StashFileKind, path: string): void => {
    const open = stashFileOpen(sessionId, value, kind, path)
    if (open === null) return
    setSelectedFile({ kind, path })
    onOpenDiff(open.request, open.files, [text('stash.diffSource'), value.sha.slice(0, 7)])
  }

  const finish = (outcome: Parameters<typeof stashOutcomeEffect>[0], pop = false): void => {
    const effect = stashOutcomeEffect(outcome, pop)
    onNotice(effect.notice)
    if (effect.refresh) void store.refresh()
  }

  const select = (sha: string): void => {
    setSelectedFile(null)
    void store.select(sha)
  }

  return (
    <StashPageView
      state={state}
      now={Date.now()}
      busy={props.busy}
      block={props.block}
      dropBlock={props.dropBlock}
      confirmingSha={confirmingSha}
      selectedFile={selectedFile}
      onSelect={select}
      onPreview={(entry) => {
        setSelectedFile(null)
        void store.select(entry.sha).then((value) => {
          const first = value?.files[0]
          if (value !== null && first !== undefined) openFile(value, 'tracked', first.path)
          else if (value !== null && value.untracked[0] !== undefined) openFile(value, 'untracked', value.untracked[0].path)
        })
      }}
      onCreate={props.onCreate}
      onApply={(pop, trigger) => {
        const sha = state.selectedSha
        if (sha === null) return
        onNotice(null)
        void applyStash({ actions, trigger }, sha, pop).then((outcome) => { finish(outcome, pop) })
      }}
      onAskDrop={(sha) => { if (canDropStash(props.busy, props.dropBlock)) setConfirmingSha(sha) }}
      onCancelDrop={() => { setConfirmingSha(null) }}
      onConfirmDrop={(trigger) => {
        const sha = confirmingSha
        if (sha === null || !canDropStash(props.busy, props.dropBlock)) return
        setConfirmingSha(null)
        onNotice(null)
        void dropStash({ actions, trigger }, sha).then((outcome) => { finish(outcome) })
      }}
      onSelectFile={setSelectedFile}
      onOpenFile={(kind, path) => {
        if (state.files.value !== null) openFile(state.files.value, kind, path)
      }}
      onRetry={props.onRetry}
    />
  )
}
