// Overlay routing for the Git tab (design §5.3, plan A3 T6): one overlay slot. Opening an overlay
// replaces the current one (never stacked), Esc goes back one level (overlay → page), and closing
// returns focus to the control that opened the first overlay of the chain.
// Pure transitions plus a small hook; GitWorkbench renders the component for each kind.
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CheckoutTarget,
  CommitFileEntry,
  DiffRequest,
  GitError,
  PushRejectedDetails,
} from '../../shared/protocol.ts'
import { activeFocusTarget, restoreFocus } from '../focus.ts'
import type { RebasePreset } from '../rebase/rebase-model.ts'
import type { FocusTarget } from '../focus.ts'
import type { ActionStore, ActionStoreDeps } from '../store/action-store.ts'
import type { RollbackTarget } from '../store/push-store.ts'
import type { DiffSourcePart } from './DiffViewer.tsx'

export type BranchSheetMode = 'new' | 'rename' | 'delete' | 'checkoutRevision'

/**
 * Every overlay of the workbench. A2 kinds (diff/push/rollback) carry what their components need;
 * A3 kinds carry the minimum their later tasks (T7–T10) start from and may grow additively.
 */
export type WorkbenchOverlay =
  | { kind: 'diff'; request: DiffRequest; files: CommitFileEntry[]; source: DiffSourcePart[] }
  /** Push page; it shows the A2 rejected view itself, so `pushRejected` is only for a direct entry. */
  | { kind: 'push'; autoSubmit?: boolean; revision?: string }
  | { kind: 'pushRejected'; remote: string; branch: string; details: PushRejectedDetails }
  | { kind: 'rollback'; targets: RollbackTarget[] }
  | { kind: 'conflicts' }
  /** B1 three-pane merge window for one conflicted file (puts the panel in host fullscreen). */
  | { kind: 'mergeWindow'; path: string }
  | { kind: 'merge'; ref?: string }
  | { kind: 'rebase'; onto?: string }
  /** Pull page; `remote`/`branch` prefill it when opened from a branch row. */
  | { kind: 'pull'; remote?: string; branch?: string }
  | { kind: 'updateProject' }
  | { kind: 'reset'; sha: string }
  | { kind: 'stashCreate' }
  /** Fetch sheet (repo bar and Branches page). */
  | { kind: 'fetch' }
  /** Confirmation of a cherry-pick / revert chosen in the commit context menu. */
  | { kind: 'commitOp'; op: 'cherryPick' | 'revert'; sha: string; shortSha: string; subject: string }
  /** `sha` is the branch tip the user saw (delete sends it as `expectedSha`). */
  | { kind: 'branchSheet'; mode: BranchSheetMode; branch?: string; startPoint?: string; sha?: string; revision?: string }
  | { kind: 'smartCheckout'; target: CheckoutTarget; paths: string[]; untracked?: string[] }
  /** "Uncommitted changes" question of the action store (DirtyWorktreeSheet reads the ask). */
  | { kind: 'dirtyWorktree' }
  /** B2 line-segment blame of one file; `rev` absent = worktree. `back` is the overlay "← back" returns to. */
  | { kind: 'blame'; path: string; rev?: string; back?: BackOverlay }
  /** B2 history of one file (follows renames). */
  | { kind: 'fileHistory'; path: string; rev?: string; back?: BackOverlay }
  /** B2 compare: commits in `left` but not in `right`, plus changed files; `right` null = worktree. */
  | { kind: 'compare'; left: string; right: string | null; leftLabel: string; rightLabel: string | null; back?: BackOverlay }
  /** B3a interactive rebase of `base..HEAD` (`base` null = from the root); `preset` = a log quick action. */
  | { kind: 'interactiveRebase'; base: string | null; preset?: RebasePreset }
  /** B3b log menu: new tag on a commit; undo the HEAD commit (soft reset); fixup / squash checked files into a commit. */
  | { kind: 'createTag'; sha: string; shortSha: string }
  | { kind: 'undoCommit'; sha: string; shortSha: string; subject: string }
  | { kind: 'fixupInto'; sha: string; shortSha: string; subject: string; mode: 'fixup' | 'squash' }
  /** B3b patches: export commits (download / copy); apply a pasted or chosen patch. */
  | { kind: 'patch'; shas: string[] }
  | { kind: 'applyPatch' }

/** An overlay "← back" can return to; one level only, so it never carries its own `back`. */
export type BackOverlay = DistributiveOmit<WorkbenchOverlay, 'back'>

/** Whether the workbench-level file history store is still needed with `overlay` on screen. */
export function keepsFileHistory(overlay: WorkbenchOverlay | null): boolean {
  if (overlay === null) return false
  if (overlay.kind === 'fileHistory') return true
  return 'back' in overlay && overlay.back?.kind === 'fileHistory'
}

/** `overlay` as the target of another overlay's `back` (its own `back` dropped). */
export function asBack(overlay: WorkbenchOverlay): BackOverlay {
  const copy: { back?: unknown } & BackOverlay = { ...overlay }
  delete copy.back
  return copy
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type WorkbenchOverlayKind = WorkbenchOverlay['kind']

/** Navigation level (design §5.3): 1 = overlay page with "← back", 2 = sheet / popover. */
export const OVERLAY_LEVEL: Record<WorkbenchOverlayKind, 1 | 2> = {
  diff: 1,
  push: 1,
  pushRejected: 1,
  conflicts: 1,
  mergeWindow: 1,
  merge: 1,
  rebase: 1,
  pull: 1,
  updateProject: 1,
  rollback: 2,
  reset: 2,
  stashCreate: 2,
  fetch: 2,
  commitOp: 2,
  branchSheet: 2,
  smartCheckout: 2,
  dirtyWorktree: 2,
  blame: 1,
  fileHistory: 1,
  compare: 1,
  interactiveRebase: 1,
  createTag: 2,
  undoCommit: 2,
  fixupInto: 2,
  patch: 1,
  applyPatch: 1,
}

export interface OverlayRoute {
  overlay: WorkbenchOverlay | null
  /** The control that opened the first overlay; focused again on close. */
  returnFocus: FocusTarget | null
}

export const CLOSED_ROUTE: OverlayRoute = { overlay: null, returnFocus: null }

export interface OverlayTransition {
  route: OverlayRoute
  /** The overlay that was closed or replaced (null when none was open). */
  left: WorkbenchOverlay | null
}

/**
 * Open `next`, replacing any current overlay. The trigger is recorded only when coming from a page:
 * a trigger inside the replaced overlay disappears with it.
 */
export function openOverlay(route: OverlayRoute, next: WorkbenchOverlay, trigger: FocusTarget | null): OverlayTransition {
  const returnFocus = route.overlay === null ? trigger : route.returnFocus
  return { route: { overlay: next, returnFocus }, left: route.overlay }
}

/**
 * Close the overlay; `focus` is the still-attached trigger to focus again. An overlay opened from
 * another one (B2 `back`) returns to it instead, keeping the page trigger for the final close.
 */
export function closeOverlay(
  route: OverlayRoute,
  options: { toPage?: boolean } = {},
): OverlayTransition & { focus: FocusTarget | null } {
  if (route.overlay === null) return { route: CLOSED_ROUTE, left: null, focus: null }
  const back = 'back' in route.overlay ? route.overlay.back : undefined
  if (back !== undefined && options.toPage !== true) return { route: { overlay: back, returnFocus: route.returnFocus }, left: route.overlay, focus: null }
  const focus = route.returnFocus !== null && route.returnFocus.isConnected ? route.returnFocus : null
  return { route: CLOSED_ROUTE, left: route.overlay, focus }
}

/**
 * Workbench-level Esc: closes the open overlay when the overlay itself did not handle the key
 * (A2 overlays handle Esc and prevent default, e.g. to cancel an in-flight push first).
 * @returns true when the event was consumed.
 */
export function handleOverlayEscape(
  event: { key: string; defaultPrevented: boolean; preventDefault(): void },
  route: OverlayRoute,
  close: () => void,
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || route.overlay === null) return false
  event.preventDefault()
  close()
  return true
}

export type { FocusTarget }
export { activeFocusTarget }

export type OverlayLeave = (left: WorkbenchOverlay, next: WorkbenchOverlay | null) => void

export interface OverlayControllerOptions {
  /** New route to render. */
  onChange: (route: OverlayRoute) => void
  /** Every overlay that closes (`next` null) or is replaced (`next` is the new overlay). */
  onLeave?: OverlayLeave
  /** Trigger used when `open` gets none: the focused element at call time. */
  currentTrigger?: () => FocusTarget | null
  /**
   * B1 T7: asked before `open` / `close` replace the current overlay. Returning true holds the change:
   * the guard calls `proceed` later (e.g. after a dirty merge window's save / discard question).
   * `closeIf` never asks (it follows an operation that already ended).
   */
  guard?: (current: WorkbenchOverlay, next: WorkbenchOverlay | null, proceed: () => void) => boolean
}

export interface OverlayController {
  /**
   * Open (replacing the current overlay). Without `trigger` the focused element at call time is
   * used, which is only right for synchronous opens from a click. **Async opens** (after an RPC,
   * e.g. the dirty-worktree question or the conflict list) must pass the trigger captured at click
   * time (`actions.run(..., { trigger })` carries it), or null.
   */
  open(next: WorkbenchOverlay, trigger?: FocusTarget | null): void
  /** Close the current overlay; focus returns to its trigger on the next {@link flushFocus}. */
  close(): void
  /** B2: close the current overlay and every `back` level behind it (e.g. "show in log"). */
  dismiss(): void
  /** Close only if `kind` is still the open overlay (late callbacks of a replaced overlay). */
  closeIf(kind: WorkbenchOverlayKind): void
  route(): OverlayRoute
  /** After the closed overlay unmounted: focus the remembered trigger (once). */
  flushFocus(): boolean
}

/** React-free overlay slot: transitions, leave notifications and pending focus return. */
export function createOverlayController(options: OverlayControllerOptions): OverlayController {
  let route = CLOSED_ROUTE
  let pendingFocus: FocusTarget | null = null

  function apply(transition: OverlayTransition): void {
    route = transition.route
    options.onChange(route)
    if (transition.left !== null) options.onLeave?.(transition.left, route.overlay)
  }

  const doClose = (toPage = false): void => {
    const transition = closeOverlay(route, { toPage })
    pendingFocus = transition.focus
    apply(transition)
  }
  const held = (next: WorkbenchOverlay | null, proceed: () => void): boolean =>
    route.overlay !== null && options.guard?.(route.overlay, next, proceed) === true

  const controller: OverlayController = {
    open: (next, trigger) => {
      const captured = trigger === undefined ? (options.currentTrigger?.() ?? null) : trigger
      const proceed = (): void => {
        pendingFocus = null
        apply(openOverlay(route, next, captured))
      }
      if (!held(next, proceed)) proceed()
    },
    close: () => {
      if (!held(null, doClose)) doClose()
    },
    dismiss: () => {
      const proceed = (): void => { doClose(true) }
      if (!held(null, proceed)) proceed()
    },
    closeIf: (kind) => {
      if (route.overlay?.kind === kind) doClose()
    },
    route: () => route,
    flushFocus: () => {
      if (route.overlay !== null || pendingFocus === null) return false
      const target = pendingFocus
      pendingFocus = null
      return restoreFocus(target)
    },
  }
  return controller
}

export interface WorkbenchOverlayController extends Omit<OverlayController, 'flushFocus'> {
  overlay: WorkbenchOverlay | null
}

/** Thin React wrapper over {@link createOverlayController} for GitWorkbench. */
export function useWorkbenchOverlay(onLeave?: OverlayLeave, guard?: OverlayControllerOptions['guard']): WorkbenchOverlayController {
  const [route, setRoute] = useState<OverlayRoute>(CLOSED_ROUTE)
  const onLeaveRef = useRef(onLeave)
  onLeaveRef.current = onLeave
  const guardRef = useRef(guard)
  guardRef.current = guard
  const controller = useMemo(() => createOverlayController({
    onChange: setRoute,
    onLeave: (left, next) => onLeaveRef.current?.(left, next),
    currentTrigger: activeFocusTarget,
    guard: (current, next, proceed) => guardRef.current?.(current, next, proceed) ?? false,
  }), [])
  // Runs after the closed overlay unmounted (and after its own focus cleanup).
  useEffect(() => { controller.flushFocus() }, [controller, route])
  return { overlay: route.overlay, open: controller.open, close: controller.close, dismiss: controller.dismiss, closeIf: controller.closeIf, route: controller.route }
}

// ---------------------------------------------------------------------------
// Wiring between the action store and the overlay slot (GitWorkbench)
// ---------------------------------------------------------------------------

/** Action store callbacks that open overlays, using the trigger captured when the action started. */
export function actionOverlayWiring(deps: {
  open: (next: WorkbenchOverlay, trigger: FocusTarget | null) => void
  refresh: () => void
}): Pick<ActionStoreDeps, 'onAskStash' | 'onConflict' | 'onSuccess'> {
  return {
    onAskStash: (ask) => { deps.open({ kind: 'dirtyWorktree' }, ask.trigger) },
    onConflict: (_endpoint, details, trigger) => {
      // Conflict markers on "mark resolved" are asked inside the already open list (A3 T9).
      if (details.markers === true) return
      deps.refresh()
      deps.open({ kind: 'conflicts' }, trigger)
    },
    onSuccess: () => { deps.refresh() },
  }
}

/**
 * Push page `git/conflict` (final review 8): the pull before the push stopped on conflicts — or,
 * with no operation left open, restoring the stash conflicted. Open the conflict list (it loads
 * operationState itself, so it works for operation null too); the console keeps the details.
 */
export function pushConflictWiring(deps: {
  open: (next: WorkbenchOverlay, trigger: FocusTarget | null) => void
  refresh: () => void
  openConsole: () => void
}): (error: GitError) => void {
  return () => {
    deps.refresh()
    deps.openConsole()
    deps.open({ kind: 'conflicts' }, null)
  }
}

/** Leaving the dirty-worktree question any way (Esc, scrim, replaced) counts as "cancel". */
export function overlayLeaveEffects(actions: Pick<ActionStore, 'cancelStash'>): OverlayLeave {
  return (left, next) => {
    // A newer question replacing this one is handled by the store (it cancels the old ask).
    if (left.kind === 'dirtyWorktree' && next?.kind !== 'dirtyWorktree') actions.cancelStash()
  }
}

/** Buttons of DirtyWorktreeSheet: answer the store first, then close the overlay. */
export function dirtySheetHandlers(
  actions: Pick<ActionStore, 'confirmStash'>,
  overlays: Pick<OverlayController, 'closeIf'>,
): { onStash: () => void; onCancel: () => void } {
  return {
    onStash: () => {
      actions.confirmStash()
      overlays.closeIf('dirtyWorktree')
    },
    // Closing runs the leave effect, which cancels the ask.
    onCancel: () => { overlays.closeIf('dirtyWorktree') },
  }
}
