// B1 T6 three-pane merge window (design §10.3): left = ours (:2:), Result (editable), right =
// theirs (:3:), each named after the concrete side (§10.1). Level-1 overlay of the Git tab that puts
// the right panel in host fullscreen while open (merge-fullscreen.ts).
// - MergeWindowView renders from the merge store state and the window UI state (testable markup);
//   the editors mount into its pane hosts (merge-editor.ts).
// - Behaviour (keys, navigation, questions, apply once) lives in merge-window-controller.ts.
// - Binary / too large / delete-kind files get the two-choice fallback instead of editors.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'
import type { ConflictCommandValue, ConflictResolution, MergeFileValue, OperationStateValue, RpcResult } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import type { GitWorkbenchKey } from '../locales.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import { counts, nextUnresolved } from '../merge/merge-model.ts'
import type { ActionStore } from '../store/action-store.ts'
import { conflictRowActions, conflictSides, withStashLabel } from '../store/conflict-store.ts'
import { useMergeState } from '../store/merge-store.ts'
import type { MergeAction, MergeStore, MergeStoreState } from '../store/merge-store.ts'
import { Button } from '../ui/Button.tsx'
import { useInitialFocus } from './integrate-parts.tsx'
import { createMergePane, createScrollLock, gutterAction, mapLine, resultEditable, revealLine, scrollToLine, topLine } from './merge-editor.ts'
import type { MergePane, MergePaneClasses, MergePaneHandle } from './merge-editor.ts'
import { useMergeFullscreen } from './merge-fullscreen.ts'
import type { SidebarFullscreen } from './merge-fullscreen.ts'
import { adjacentPath, createMergeWindowController, mergeKeyCommand } from './merge-window-controller.ts'
import type { LeaveAnswer, MergeWindowUi } from './merge-window-controller.ts'
import css from './MergeWindow.module.css'
import { MergeConfirmBar, MergeFallback, MergeFooter, MergeHeader } from './MergeWindowParts.tsx'
import type { MergeSideLabels } from './MergeWindowParts.tsx'
import { resolveConflictFile } from './operation-actions.ts'

export type { MergeSideLabels }

/** Pane headings and gutter labels from the operation state (the stash pop has no operation). */
export function mergeSideLabels(t: Translate, operation: OperationStateValue | null): MergeSideLabels {
  if (operation === null) {
    return {
      left: { label: 'ours', name: 'ours', technical: t('merge.pane.ours') },
      right: { label: 'theirs', name: 'theirs', technical: t('merge.pane.theirs') },
      note: null,
    }
  }
  const shown = withStashLabel(operation, t('conflict.stashLabel'))
  const sides = conflictSides(shown)
  return {
    left: { label: shown.ours.label, name: t(sides.ours.name.key, sides.ours.name.params), technical: t('merge.pane.ours') },
    right: { label: shown.theirs.label, name: t(sides.theirs.name.key, sides.theirs.name.params), technical: t('merge.pane.theirs') },
    note: sides.note === null ? null : t(sides.note.key, sides.note.params),
  }
}

const DELETE_KINDS = new Set<MergeFileValue['kind']>(['deleted-by-us', 'deleted-by-them', 'both-deleted'])

/** Why a file gets the two-choice fallback instead of editors. */
export function fallbackReason(file: MergeFileValue): GitWorkbenchKey {
  if (DELETE_KINDS.has(file.kind)) return 'merge.fallback.delete'
  if (file.tooLarge) return 'merge.fallback.tooLarge'
  if ([file.base, file.ours, file.theirs].some(side => side?.binary === true)) return 'merge.fallback.binary'
  return 'merge.fallback.missing'
}

export interface MergeWindowHandlers {
  onBack: () => void
  onPrevFile: () => void
  onNextFile: () => void
  onUndo: () => void
  onSaveClose: () => void
  onAction: (action: MergeAction) => void
  onToggleNonConflicting: () => void
  onApply: () => void
  onConfirmApply: () => void
  onCancelConfirm: () => void
  onLeaveAnswer: (answer: LeaveAnswer) => void
  onRetry: () => void
  onFallbackResolve: (resolution: ConflictResolution, trigger: FocusTarget | null) => void
  onCopyCommand: (trigger: FocusTarget | null) => void
}

export interface MergeWindowViewProps {
  t: Translate
  path: string
  state: MergeStoreState
  ui: MergeWindowUi
  sides: MergeSideLabels
  operation: OperationStateValue | null
  hasPrev: boolean
  hasNext: boolean
  /** Why writes are disabled (read-only repository). */
  blockReason: string | null
  nonConflictingOpen: boolean
  fallback: { busy: boolean; error: LocalizedText | null; copied: boolean }
  handlers: MergeWindowHandlers
  windowRef?: Ref<HTMLDivElement>
  paneRefs?: Partial<Record<MergePane, Ref<HTMLDivElement>>>
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function MergeWindowView(props: MergeWindowViewProps): ReactNode {
  const { t, path, state, ui, sides, handlers, blockReason } = props
  const model = state.model
  const file = state.file
  const busy = state.status === 'saving' || state.status === 'applying'

  let body: ReactNode
  if (state.status === 'loading' || state.status === 'idle') {
    body = <p className={css.hint} aria-busy="true">{t('state.loading')}</p>
  } else if (file === null) {
    body = (
      <p className={css.error} role="alert">
        {state.error === null ? null : t(state.error.key, state.error.params)}{' '}
        <Button data-merge-retry onClick={handlers.onRetry}>{t('merge.retry')}</Button>
      </p>
    )
  } else if (model === null) {
    const entry = { path, status: 'U' as const, conflict: file.kind }
    body = (
      <MergeFallback
        t={t}
        reason={fallbackReason(file)}
        actions={props.operation === null || file.resolved ? [] : conflictRowActions(entry, withStashLabel(props.operation, t('conflict.stashLabel')))}
        busy={props.fallback.busy}
        blockReason={blockReason}
        error={props.fallback.error}
        copied={props.fallback.copied}
        onResolve={handlers.onFallbackResolve}
        onCopyCommand={handlers.onCopyCommand}
      />
    )
  } else {
    const pane = (name: MergePane, heading: string, title: string): ReactNode => (
      <section className={css.pane} data-merge-pane={name} aria-label={heading}>
        <h3 className={css.paneHead} title={title}>{heading}</h3>
        <div className={css.editorHost} ref={props.paneRefs?.[name]} />
      </section>
    )
    body = (
      <>
        {sides.note === null ? null : <p className={css.note} data-rebase-note>{sides.note}</p>}
        <div className={css.panes}>
          {pane('left', sides.left.name, `${sides.left.name} · ${sides.left.technical}`)}
          {pane('result', t('merge.pane.result'), t('merge.pane.result.title'))}
          {pane('right', sides.right.name, `${sides.right.name} · ${sides.right.technical}`)}
        </div>
      </>
    )
  }

  const notices: Array<{ key: string; text: LocalizedText; role: 'status' | 'alert' }> = []
  if (model?.coarse === true) notices.push({ key: 'coarse', text: text('merge.coarse'), role: 'status' })
  if (state.draftDiscarded) notices.push({ key: 'draft', text: text('merge.draftDiscarded'), role: 'status' })
  if (ui.notice !== null) notices.push({ key: 'notice', text: ui.notice, role: 'status' })
  if (state.error !== null && file !== null) notices.push({ key: 'error', text: state.error, role: 'alert' })

  return (
    <div
      ref={props.windowRef}
      className={css.window}
      role="dialog"
      aria-label={t('merge.window.label', { path })}
      aria-busy={busy ? true : undefined}
      tabIndex={-1}
      data-merge-window={path}
      onKeyDown={props.onKeyDown}
    >
      <MergeHeader
        t={t}
        path={path}
        counts={model === null ? null : counts(model)}
        hasPrev={props.hasPrev}
        hasNext={props.hasNext}
        canUndo={state.canUndo}
        busy={busy}
        blockReason={blockReason}
        onBack={handlers.onBack}
        onPrevFile={handlers.onPrevFile}
        onNextFile={handlers.onNextFile}
        onUndo={handlers.onUndo}
        onSaveClose={handlers.onSaveClose}
      />
      {notices.length === 0
        ? null
        : (
            <div className={css.notices}>
              {notices.map(notice => (
                <p
                  key={notice.key}
                  className={notice.role === 'alert' ? css.error : css.notice}
                  role={notice.role}
                  {...(notice.key === 'coarse' ? { 'data-merge-coarse': true } : {})}
                >
                  {t(notice.text.key, notice.text.params)}
                </p>
              ))}
            </div>
          )}
      {body}
      {ui.confirm === null
        ? null
        : (
            <MergeConfirmBar
              t={t}
              confirm={ui.confirm}
              busy={busy}
              blockReason={blockReason}
              onConfirmApply={handlers.onConfirmApply}
              onCancel={handlers.onCancelConfirm}
              onLeaveAnswer={handlers.onLeaveAnswer}
            />
          )}
      {model === null
        ? null
        : (
            <MergeFooter
              t={t}
              sides={sides}
              busy={busy}
              applied={ui.applied}
              blockReason={blockReason}
              nonConflictingOpen={props.nonConflictingOpen}
              onAction={handlers.onAction}
              onToggleNonConflicting={handlers.onToggleNonConflicting}
              onApply={handlers.onApply}
            />
          )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface MergeWindowProps {
  path: string
  store: MergeStore
  /** Fallback choices go through the action store (A3 resolveConflict). */
  actions: Pick<ActionStore, 'run'>
  operation: OperationStateValue | null
  blockReason: string | null
  /** Host fullscreen (absent outside the DSH slot). */
  sidebar?: SidebarFullscreen | undefined
  loadCommand: () => Promise<RpcResult<ConflictCommandValue>>
  copy: (value: string) => void
  /** Back to the conflict list. */
  onClose: () => void
  /** Show another conflicted file in the window. */
  onOpenFile: (path: string) => void
  /** A fallback choice resolved the file (the same follow-up as a successful apply). */
  onResolved: (path: string) => void
  /**
   * T7: filled while a file is open. The workbench asks it before another entry point replaces the
   * window; true = the window holds that navigation to ask save / discard / cancel first.
   */
  leaveGuard?: { current: ((go: () => void) => boolean) | null } | undefined
}

const PANES: readonly MergePane[] = ['left', 'result', 'right']

function paneClasses(): MergePaneClasses {
  const name = (key: string): string => css[key] ?? ''
  return {
    editor: name('editor'),
    tone: { conflict: name('toneConflict'), change: name('toneChange'), resolved: name('toneResolved'), edited: name('toneEdited') },
    edge: {
      first: name('edgeFirst'),
      middle: '',
      last: name('edgeLast'),
      single: name('edgeSingle'),
      gapBefore: name('gapBefore'),
      gapAfter: name('gapAfter'),
    },
    current: name('current'),
    gutter: name('gutter'),
    gutterButton: name('gutterButton'),
  }
}

/** The whole window: host fullscreen for its lifetime, one session per file. */
export function MergeWindow(props: MergeWindowProps): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null)
  useMergeFullscreen(rootRef, props.sidebar)
  const { store } = props
  // Leaving the window any way drops the loaded state (a saved draft stays on the Host).
  useEffect(() => () => { store.discard() }, [store])
  return (
    <div ref={rootRef} className={css.root}>
      <MergeFileSession key={props.path} {...props} />
    </div>
  )
}

function MergeFileSession(props: MergeWindowProps): ReactNode {
  const t = useT()
  const { store, path } = props
  const latest = useRef(props)
  latest.current = props
  const state = useMergeState(store)
  const controller = useMemo(() => createMergeWindowController({
    store,
    adjacentFile: dir => adjacentPath(latest.current.operation?.conflicts.map(entry => entry.path) ?? [], latest.current.path, dir),
    onClose: () => { latest.current.onClose() },
    onOpenFile: (next) => { latest.current.onOpenFile(next) },
  }), [store])
  const ui = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const leaveGuard = props.leaveGuard
  useEffect(() => {
    if (leaveGuard === undefined) return undefined
    const guard = controller.guardLeave
    leaveGuard.current = guard
    return () => { if (leaveGuard.current === guard) leaveGuard.current = null }
  }, [controller, leaveGuard])
  const [menuOpen, setMenuOpen] = useState(false)
  const [fallbackBusy, setFallbackBusy] = useState(false)
  const [fallbackError, setFallbackError] = useState<LocalizedText | null>(null)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => { void store.open(path) }, [store, path])

  const windowRef = useRef<HTMLDivElement | null>(null)
  useInitialFocus(windowRef, ui.confirm?.kind ?? null)

  // Editors: mounted once per loaded file, updated on every model / current-chunk change.
  const leftRef = useRef<HTMLDivElement | null>(null)
  const resultRef = useRef<HTMLDivElement | null>(null)
  const rightRef = useRef<HTMLDivElement | null>(null)
  const panes = useRef<Partial<Record<MergePane, MergePaneHandle>> | null>(null)
  const sides = mergeSideLabels(t, props.operation)
  const file = state.file
  const hasModel = state.model !== null
  const leftLabels = { accept: t('merge.chunk.accept', { label: sides.left.label }), ignore: t('merge.chunk.ignore', { label: sides.left.label }) }
  const rightLabels = { accept: t('merge.chunk.accept', { label: sides.right.label }), ignore: t('merge.chunk.ignore', { label: sides.right.label }) }
  const labelKey = [leftLabels.accept, leftLabels.ignore, rightLabels.accept, rightLabels.ignore, sides.left.name, sides.right.name, t('merge.pane.result')].join('\u0000')
  useEffect(() => {
    const model = store.getState().model
    const hosts = { left: leftRef.current, result: resultRef.current, right: rightRef.current }
    if (file === null || model === null || hosts.left === null || hosts.result === null || hosts.right === null) return undefined
    const [leftAccept, leftIgnore, rightAccept, rightIgnore, leftName, rightName, resultName] = labelKey.split('\u0000') as [string, string, string, string, string, string, string]
    const classes = paneClasses()
    const lock = createScrollLock()
    const handles: Partial<Record<MergePane, MergePaneHandle>> = {}
    const onScroll = (pane: MergePane) => (): void => {
      const source = handles[pane]
      const current = store.getState().model
      if (source === undefined || current === null || !lock.begin(pane)) return
      const line = topLine(source.view)
      for (const other of PANES) {
        const target = handles[other]
        if (other !== pane && target !== undefined) scrollToLine(target.view, mapLine(current, pane, other, line))
      }
    }
    const onGutter = (kind: 'accept' | 'ignore', chunk: { id: number; side: 'left' | 'right' }, modifier: boolean): void => {
      controller.run(gutterAction(kind, chunk.id, chunk.side, modifier))
    }
    handles.left = createMergePane({
      parent: hosts.left, pane: 'left', doc: model.leftLines.join(''), editable: false, ariaLabel: leftName, classes,
      labels: { accept: leftAccept, ignore: leftIgnore }, onGutter, onScroll: onScroll('left'),
    })
    handles.result = createMergePane({
      parent: hosts.result, pane: 'result', doc: model.result, editable: resultEditable(store.getState().status), ariaLabel: resultName, classes,
      onEdits: (edits) => {
        for (const edit of edits) store.edit(edit.from, edit.to, edit.insert)
        // Safety net: an edit the store did not take (not ready) must not stay only in the editor.
        const latest = store.getState().model
        const result = handles.result
        if (latest !== null && result !== undefined && latest.result !== result.view.state.doc.toString()) {
          result.update(latest, controller.getState().currentChunk)
        }
      },
      onScroll: onScroll('result'),
    })
    handles.right = createMergePane({
      parent: hosts.right, pane: 'right', doc: model.rightLines.join(''), editable: false, ariaLabel: rightName, classes,
      labels: { accept: rightAccept, ignore: rightIgnore }, onGutter, onScroll: onScroll('right'),
    })
    panes.current = handles
    for (const handle of Object.values(handles)) handle.update(model, controller.getState().currentChunk)
    controller.setReveal((id) => {
      const chunk = store.getState().model?.chunks[id]
      if (chunk !== undefined && handles.result !== undefined) revealLine(handles.result.view, chunk.resultRange.start)
    })
    if (nextUnresolved(model, null, 'next') !== null) controller.navigate('next')
    return () => {
      controller.setReveal(null)
      panes.current = null
      for (const handle of Object.values(handles)) handle.destroy()
    }
  }, [controller, file, hasModel, labelKey, store])
  const model = state.model
  const currentChunk = ui.currentChunk
  useEffect(() => {
    const handles = panes.current
    if (model === null || handles === null) return
    for (const handle of Object.values(handles)) handle.update(model, currentChunk)
  }, [currentChunk, model])

  const editable = resultEditable(state.status)
  useEffect(() => { panes.current?.result?.setEditable(editable) }, [editable, model])

  const paths = props.operation?.conflicts.map(entry => entry.path) ?? []
  const prev = adjacentPath(paths, path, 'prev')
  const next = adjacentPath(paths, path, 'next')

  const resolveFallback = (resolution: ConflictResolution, trigger: FocusTarget | null): void => {
    if (fallbackBusy) return
    setFallbackBusy(true)
    setFallbackError(null)
    void resolveConflictFile({ actions: props.actions, trigger }, path, resolution).then((result) => {
      if (!mounted.current) return
      setFallbackBusy(false)
      if (result.kind === 'done') latest.current.onResolved(path)
      else if (result.kind === 'markers') setFallbackError(text('conflict.markers.title', { path }))
      else if (result.kind === 'error') setFallbackError(result.message)
    })
  }

  const copyCommand = (): void => {
    setFallbackError(null)
    void props.loadCommand().then((result) => {
      if (!mounted.current) return
      if (result.ok) {
        latest.current.copy(result.value.command)
        setCopied(true)
      } else {
        setFallbackError(text('conflict.loadFailed', { code: result.error.code }))
      }
    })
  }

  const handlers: MergeWindowHandlers = {
    onBack: () => { controller.requestLeave({ kind: 'close' }) },
    onPrevFile: () => { if (prev !== null) controller.requestLeave({ kind: 'file', path: prev }) },
    onNextFile: () => { if (next !== null) controller.requestLeave({ kind: 'file', path: next }) },
    onUndo: () => { controller.command('undo') },
    onSaveClose: () => {
      void store.saveAndClose().then((saved) => {
        if (saved) controller.requestLeave({ kind: 'close' })
      })
    },
    onAction: (action) => { controller.run(action) },
    onToggleNonConflicting: () => { setMenuOpen(open => !open) },
    onApply: () => { controller.requestApply() },
    onConfirmApply: () => { controller.confirmApply() },
    onCancelConfirm: () => { controller.cancelConfirm() },
    onLeaveAnswer: (answer) => { controller.answerLeave(answer) },
    onRetry: () => { void store.open(path) },
    onFallbackResolve: resolveFallback,
    onCopyCommand: copyCommand,
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault()
      event.stopPropagation()
      setMenuOpen(false)
      return
    }
    const command = mergeKeyCommand(event)
    if (command === null || (command !== 'back' && state.model === null)) return
    event.preventDefault()
    event.stopPropagation()
    controller.command(command)
  }

  return (
    <MergeWindowView
      t={t}
      path={path}
      state={state}
      ui={ui}
      sides={sides}
      operation={props.operation}
      hasPrev={prev !== null}
      hasNext={next !== null}
      blockReason={props.blockReason}
      nonConflictingOpen={menuOpen}
      fallback={{ busy: fallbackBusy, error: fallbackError, copied }}
      handlers={handlers}
      windowRef={windowRef}
      paneRefs={{ left: leftRef, result: resultRef, right: rightRef }}
      onKeyDown={onKeyDown}
    />
  )
}
