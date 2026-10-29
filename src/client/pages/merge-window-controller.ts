// B1 T6 merge window behaviour (design §10.3, AC4/AC5/AC11), React-free so it is testable without
// a DOM: keyboard commands, F7 / Shift+F7 chunk navigation (at the end a second F7 opens the
// adjacent file), leaving with the save / discard / cancel question, Cmd/Ctrl+S, apply with the
// apply question (never twice per window session, controller ruling 12): chunks not taken stay at
// the base version (ruling 21, with 「先应用非冲突更改」), and a worktree edited without markers would
// be overwritten (ruling 19); the notices of resolveSimple / save. The merge store owns the model,
// undo history and writes.
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import { applyNonConflicting, isChunkResolved, nextUnresolved } from '../merge/merge-model.ts'
import type { MergeAction, MergeStatus, MergeStore } from '../store/merge-store.ts'

export type MergeCommand = 'nextChunk' | 'prevChunk' | 'back' | 'undo' | 'redo' | 'save'

export interface MergeKeyEvent {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

/** Window keys: F7 / Shift+F7, Esc, Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z (or Ctrl+Y), Cmd/Ctrl+S. */
export function mergeKeyCommand(event: MergeKeyEvent): MergeCommand | null {
  const mod = event.metaKey || event.ctrlKey
  if (event.altKey) return null
  if (event.key === 'F7' && !mod) return event.shiftKey ? 'prevChunk' : 'nextChunk'
  if (event.key === 'Escape' && !mod && !event.shiftKey) return 'back'
  if (!mod) return null
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && !event.shiftKey) return 'redo'
  if (key === 's' && !event.shiftKey) return 'save'
  return null
}

/** The page and the open window, as far as the stray-key checks need them (React-free, testable). */
export interface StrayKeyDocument {
  body: unknown
  documentElement: unknown
  querySelectorAll(selector: string): ArrayLike<unknown>
}
export interface StrayKeyRoot {
  contains(node: unknown): boolean
}

/** Focus fell out of every element: it is on `<body>` / `<html>` or nowhere. */
export function focusIsLost(active: unknown, doc: Pick<StrayKeyDocument, 'body' | 'documentElement'>): boolean {
  return active === null || active === undefined || active === doc.body || active === doc.documentElement
}

/**
 * B1 acceptance demo: after a failed apply focus was on `<body>`, so the window's own `onKeyDown`
 * never saw Esc. A document-level listener takes a plain Esc whose target is the page itself, when
 * nobody handled it (`defaultPrevented`) and no other modal outside the window is open; an Esc on a
 * focused element is left to that element and the window's `onKeyDown` (menu → confirm → leave).
 */
export function isStrayEscape(
  event: MergeKeyEvent & { target: unknown; defaultPrevented: boolean },
  doc: StrayKeyDocument,
  root: StrayKeyRoot | null,
): boolean {
  if (root === null || event.defaultPrevented || mergeKeyCommand(event) !== 'back') return false
  if (!focusIsLost(event.target, doc)) return false
  const modals = Array.from(doc.querySelectorAll('[aria-modal="true"]'))
  return modals.every(modal => root.contains(modal))
}

/**
 * B4b: a gutter » « × re-renders the pane's buttons, so the pressed one is gone and focus falls to
 * <body> (where F7 / Ctrl+Z no longer reach the window). When focus is lost, move it to the same
 * action on the next chunk of that pane (wrapping), else to the Result editor. Returns what it focused.
 */
export function refocusAfterGutter(
  pane: ParentNode,
  resultEditor: HTMLElement | null,
  pressed: { chunk: number; kind: 'accept' | 'ignore' },
): HTMLElement | null {
  const doc = typeof document === 'undefined' ? null : document
  if (doc === null || !focusIsLost(doc.activeElement, doc)) return null
  const buttons = [...pane.querySelectorAll<HTMLElement>(`[data-chunk-action="${pressed.kind}"]`)]
  const target = buttons.find(button => Number(button.dataset['chunk']) > pressed.chunk) ?? buttons[0] ?? resultEditor
  target?.focus()
  return target ?? null
}

/** A save / apply that ended in an error: the disabled button lost focus, put it back in the window. */
export function shouldRefocusAfterWrite(previous: MergeStatus, next: MergeStatus, hasError: boolean): boolean {
  return (previous === 'saving' || previous === 'applying') && next === 'ready' && hasError
}

/** Where the window goes: back to the list, another file, or (T7) somewhere another entry point chose. */
export type LeaveTarget =
  | { kind: 'close' }
  | { kind: 'file'; path: string }
  /** `cancel`: the held navigation was a pending action's prompt; not leaving answers it as cancelled. */
  | { kind: 'external'; go: () => void; cancel?: () => void }
export type LeaveAnswer = 'save' | 'discard' | 'cancel'
export type NavigationDirection = 'next' | 'prev'

export type MergeConfirm =
  /**
   * `unresolved`: chunks not taken (they stay at the base version); `overwrite`: the worktree no
   * longer has conflict markers (edited before loading, ruling 19); `nonConflicting`: applying the
   * non-conflicting changes would change the Result (offers 「先应用非冲突更改」, ruling 21).
   */
  | { kind: 'apply'; unresolved: number; overwrite: boolean; nonConflicting: boolean }
  | { kind: 'leave'; target: LeaveTarget }

export interface MergeWindowUi {
  /** Chunk F7 last moved to (null before the first move). */
  currentChunk: number | null
  confirm: MergeConfirm | null
  notice: LocalizedText | null
  /** F7 (or Shift+F7) found no more unresolved chunks; pressing it again opens the adjacent file. */
  atEnd: NavigationDirection | null
  /** The Result was written back in this window session (apply never runs twice). */
  applied: boolean
}

export interface MergeWindowControllerDeps {
  store: MergeStore
  /** The file before / after this one in the conflict list (null when none). */
  adjacentFile: (dir: NavigationDirection) => string | null
  /** Back to the conflict list. */
  onClose: () => void
  /** Show another file in the window. */
  onOpenFile: (path: string) => void
}

export interface MergeWindowController {
  getState(): MergeWindowUi
  subscribe(listener: () => void): () => void
  /** The editors scroll to a chunk (set by the component once they exist). */
  setReveal(reveal: ((chunkId: number) => void) | null): void
  command(command: MergeCommand): void
  navigate(dir: NavigationDirection): void
  /** Runs a model action through the store (notices for resolveSimple). */
  run(action: MergeAction): void
  requestLeave(target: LeaveTarget): void
  /**
   * T7: another entry point is about to replace the window. True when the window holds it to ask
   * save / discard / cancel first (`go` runs after save or discard); false when it may go right away.
   */
  guardLeave(go: () => void, cancel?: () => void): boolean
  /** Save failing on a held outside prompt asks the same question again (T2). */
  answerLeave(answer: LeaveAnswer): void
  /**
   * T2: the window is going away without answering (e.g. `closeIf` after the operation ended). A held
   * outside prompt — open, or waiting on its save — is answered as cancelled; a late save result is ignored.
   */
  dispose(): void
  requestApply(): void
  confirmApply(): void
  /** In the apply question: apply the non-conflicting changes, then ask again for what is left (or apply). */
  applyNonConflictingFirst(): void
  cancelConfirm(): void
}

const INITIAL: MergeWindowUi = { currentChunk: null, confirm: null, notice: null, atEnd: null, applied: false }

export function createMergeWindowController(deps: MergeWindowControllerDeps): MergeWindowController {
  const { store } = deps
  const listeners = new Set<() => void>()
  let ui = INITIAL
  let reveal: ((chunkId: number) => void) | null = null
  let applying = false
  /** The leave target whose save is in flight, and the token that save answers to. */
  let savingTarget: LeaveTarget | null = null
  let saveToken = 0

  const set = (patch: Partial<MergeWindowUi>): void => {
    ui = { ...ui, ...patch }
    for (const listener of [...listeners]) listener()
  }

  const leave = (target: LeaveTarget): void => {
    set({ confirm: null })
    // Drop the window state first: whatever opens next must not see unsaved changes to ask about.
    store.discard()
    if (target.kind === 'close') deps.onClose()
    else if (target.kind === 'file') deps.onOpenFile(target.path)
    else target.go()
  }

  /** Closes an open question; a held outside prompt is answered as cancelled. */
  const dropConfirm = (): void => {
    const confirm = ui.confirm
    set({ confirm: null })
    if (confirm?.kind === 'leave' && confirm.target.kind === 'external') confirm.target.cancel?.()
  }

  const requestLeave = (target: LeaveTarget): void => {
    if (store.getState().dirty) set({ confirm: { kind: 'leave', target } })
    else leave(target)
  }

  const navigate = (dir: NavigationDirection): void => {
    const model = store.getState().model
    if (model === null || ui.confirm !== null) return
    const next = nextUnresolved(model, ui.currentChunk, dir)
    if (next !== null) {
      set({ currentChunk: next, atEnd: null, notice: null })
      reveal?.(next)
      return
    }
    const file = deps.adjacentFile(dir)
    if (ui.atEnd === dir && file !== null) {
      requestLeave({ kind: 'file', path: file })
      return
    }
    const key = file === null ? 'merge.nav.endNone' : dir === 'next' ? 'merge.nav.endNext' : 'merge.nav.endPrev'
    set({ atEnd: dir, notice: text(key) })
  }

  const apply = (): void => {
    if (applying || ui.applied) return
    applying = true
    set({ confirm: null, notice: null })
    void store.apply().then((result) => {
      applying = false
      // Success leaves the file (the injected onApplied path); a failure shows the store error.
      if (result !== null) set({ applied: true })
    })
  }

  const requestApply = (): void => {
    const state = store.getState()
    const model = state.model
    if (model === null || state.status !== 'ready' || ui.applied || applying) return
    const unresolved = model.chunks.filter(chunk => !isChunkResolved(chunk)).length
    const overwrite = state.file?.worktreeHasMarkers === false
    if (unresolved === 0 && !overwrite) {
      apply()
      return
    }
    const nonConflicting = applyNonConflicting(model, 'all') !== model
    set({ confirm: { kind: 'apply', unresolved, overwrite, nonConflicting } })
  }

  const save = (): void => {
    if (!store.getState().dirty) return
    void store.saveAndClose().then((saved) => {
      if (saved) set({ notice: text('merge.saved') })
    })
  }

  return {
    getState: () => ui,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setReveal: (next) => { reveal = next },
    command: (command) => {
      switch (command) {
        case 'nextChunk': navigate('next'); return
        case 'prevChunk': navigate('prev'); return
        case 'back':
          if (ui.confirm !== null) dropConfirm()
          else requestLeave({ kind: 'close' })
          return
        case 'undo': store.undo(); return
        case 'redo': store.redo(); return
        case 'save': save(); return
      }
    },
    navigate,
    run: (action) => {
      const resolved = store.dispatch(action)
      if (action.type === 'resolveSimple') {
        set({ atEnd: null, notice: resolved > 0 ? text('merge.simple.done', { count: resolved }) : text('merge.simple.none') })
      } else if (ui.atEnd !== null || ui.notice !== null) {
        set({ atEnd: null, notice: null })
      }
    },
    requestLeave,
    guardLeave: (go, cancel) => {
      if (!store.getState().dirty) return false
      if (ui.confirm !== null) dropConfirm()
      set({ confirm: { kind: 'leave', target: cancel === undefined ? { kind: 'external', go } : { kind: 'external', go, cancel } } })
      return true
    },
    answerLeave: (answer) => {
      const confirm = ui.confirm
      if (confirm?.kind !== 'leave') return
      if (answer === 'cancel') {
        dropConfirm()
        return
      }
      if (answer === 'discard') {
        leave(confirm.target)
        return
      }
      set({ confirm: null })
      const target = confirm.target
      const token = ++saveToken
      savingTarget = target
      void store.saveAndClose().then((saved) => {
        // The window went away (dispose) or another save started: this result answers nothing.
        if (token !== saveToken) return
        savingTarget = null
        if (saved) leave(target)
        // T2: a held outside prompt must stay answerable; ask again (the store shows the error).
        else if (target.kind === 'external' && ui.confirm === null) set({ confirm })
      })
    },
    dispose: () => {
      saveToken++
      const held = savingTarget ?? (ui.confirm?.kind === 'leave' ? ui.confirm.target : null)
      savingTarget = null
      if (ui.confirm !== null) set({ confirm: null })
      if (held?.kind === 'external') held.cancel?.()
    },
    requestApply,
    confirmApply: () => {
      if (ui.confirm?.kind === 'apply') apply()
    },
    applyNonConflictingFirst: () => {
      if (ui.confirm?.kind !== 'apply') return
      store.dispatch({ type: 'applyNonConflicting', which: 'all' })
      set({ confirm: null })
      requestApply()
    },
    cancelConfirm: () => { if (ui.confirm !== null) dropConfirm() },
  }
}

/**
 * Where the window goes after a successful apply (controller ruling 12): the next unresolved file
 * after the applied one in list order (wrapping), or null (back to the conflict list).
 */
export function nextFileAfterApply(paths: readonly string[], applied: string, remaining: number): string | null {
  if (remaining <= 0) return null
  const others = paths.filter(path => path !== applied)
  if (others.length === 0) return null
  const index = paths.indexOf(applied)
  if (index === -1) return others[0] ?? null
  for (let step = 1; step < paths.length; step++) {
    const candidate = paths[(index + step) % paths.length]
    if (candidate !== undefined && candidate !== applied) return candidate
  }
  return null
}

/**
 * Previous / next file of the conflict list for the header buttons and F7 at the end of a file.
 * A path outside the list (an already resolved file) steps into the list from its ends.
 */
export function adjacentPath(paths: readonly string[], current: string, dir: NavigationDirection): string | null {
  const index = paths.indexOf(current)
  if (index === -1) return (dir === 'next' ? paths[0] : paths[paths.length - 1]) ?? null
  return paths[dir === 'next' ? index + 1 : index - 1] ?? null
}

/** B1 T7 Review Changes queue (confirmation 2, controller ruling 12): files opened one after another. */
export interface ReviewRunner {
  /** Starts a queue; returns the first file (null for an empty queue). */
  start(queue: readonly string[]): string | null
  /**
   * The current file was applied (or could not be opened): the next queued file, null when the queue
   * is done (back to the list), undefined when no queue is running (the default follow-up applies).
   */
  next(path: string): string | null | undefined
  /** Back / another file / another entry point without applying: no further files open. */
  cancel(): void
  active(): boolean
  /** The queued file the window is on (null without a queue). */
  current(): string | null
}

export function createReviewRunner(): ReviewRunner {
  let queue: string[] = []
  let running = false
  return {
    start: (next) => {
      queue = [...next]
      running = queue.length > 0
      return queue[0] ?? null
    },
    next: () => {
      if (!running) return undefined
      queue.shift()
      const next = queue[0] ?? null
      if (next === null) running = false
      return next
    },
    cancel: () => {
      running = false
      queue = []
    },
    active: () => running,
    current: () => (running ? (queue[0] ?? null) : null),
  }
}
