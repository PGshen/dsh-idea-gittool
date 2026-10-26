// Overlay routing for the Git tab (design §5.3, plan A3 T6): one overlay slot. Opening an overlay
// replaces the current one (never stacked), Esc goes back one level (overlay → page), and closing
// returns focus to the control that opened the first overlay of the chain.
// Pure transitions plus a small hook; GitWorkbench renders the component for each kind.
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CheckoutTarget,
  CommitFileEntry,
  DiffRequest,
  PushRejectedDetails,
} from '../../shared/protocol.ts'
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
  | { kind: 'push'; autoSubmit?: boolean }
  | { kind: 'pushRejected'; remote: string; branch: string; details: PushRejectedDetails }
  | { kind: 'rollback'; targets: RollbackTarget[] }
  | { kind: 'conflicts' }
  | { kind: 'merge'; ref?: string }
  | { kind: 'rebase'; onto?: string }
  | { kind: 'pull' }
  | { kind: 'updateProject' }
  | { kind: 'reset'; sha: string }
  | { kind: 'stashCreate' }
  | { kind: 'branchSheet'; mode: BranchSheetMode; branch?: string; startPoint?: string }
  | { kind: 'smartCheckout'; target: CheckoutTarget; paths: string[] }
  /** "Uncommitted changes" question of the action store (DirtyWorktreeSheet reads the ask). */
  | { kind: 'dirtyWorktree' }

export type WorkbenchOverlayKind = WorkbenchOverlay['kind']

/** Navigation level (design §5.3): 1 = overlay page with "← back", 2 = sheet / popover. */
export const OVERLAY_LEVEL: Record<WorkbenchOverlayKind, 1 | 2> = {
  diff: 1,
  push: 1,
  pushRejected: 1,
  conflicts: 1,
  merge: 1,
  rebase: 1,
  pull: 1,
  updateProject: 1,
  rollback: 2,
  reset: 2,
  stashCreate: 2,
  branchSheet: 2,
  smartCheckout: 2,
  dirtyWorktree: 2,
}

/** What focus returns to (an HTMLElement in the browser). */
export interface FocusTarget {
  focus(): void
  readonly isConnected: boolean
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

/** Close the overlay; `focus` is the still-attached trigger to focus again. */
export function closeOverlay(route: OverlayRoute): OverlayTransition & { focus: FocusTarget | null } {
  if (route.overlay === null) return { route: CLOSED_ROUTE, left: null, focus: null }
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

/** The focused element, as a focus target (null outside the browser or when nothing is focused). */
export function activeFocusTarget(): FocusTarget | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  return typeof HTMLElement !== 'undefined' && active instanceof HTMLElement && active !== document.body ? active : null
}

export interface WorkbenchOverlayController {
  overlay: WorkbenchOverlay | null
  /** Open (replacing the current overlay); the trigger defaults to the focused element. */
  open(next: WorkbenchOverlay, trigger?: FocusTarget | null): void
  /** Close the current overlay and return focus to its trigger. */
  close(): void
  /** Close only if `kind` is still the open overlay (late callbacks of a replaced overlay). */
  closeIf(kind: WorkbenchOverlayKind): void
  route(): OverlayRoute
}

/**
 * Overlay slot state for GitWorkbench. `onLeave` sees every overlay that closes (`next` null)
 * or is replaced (`next` is the new overlay).
 */
export function useWorkbenchOverlay(
  onLeave?: (left: WorkbenchOverlay, next: WorkbenchOverlay | null) => void,
): WorkbenchOverlayController {
  const [route, setRoute] = useState<OverlayRoute>(CLOSED_ROUTE)
  const routeRef = useRef(route)
  const onLeaveRef = useRef(onLeave)
  onLeaveRef.current = onLeave
  const pendingFocus = useRef<FocusTarget | null>(null)

  // Focus the trigger after the overlay has unmounted (runs after its own cleanup).
  useEffect(() => {
    const focus = pendingFocus.current
    if (route.overlay !== null || focus === null) return
    pendingFocus.current = null
    if (focus.isConnected) focus.focus()
  }, [route])

  const apply = useCallback((transition: OverlayTransition) => {
    routeRef.current = transition.route
    setRoute(transition.route)
    if (transition.left !== null) onLeaveRef.current?.(transition.left, transition.route.overlay)
  }, [])

  const open = useCallback((next: WorkbenchOverlay, trigger?: FocusTarget | null) => {
    apply(openOverlay(routeRef.current, next, trigger === undefined ? activeFocusTarget() : trigger))
  }, [apply])

  const close = useCallback(() => {
    const transition = closeOverlay(routeRef.current)
    pendingFocus.current = transition.focus
    apply(transition)
  }, [apply])

  const closeIf = useCallback((kind: WorkbenchOverlayKind) => {
    if (routeRef.current.overlay?.kind === kind) close()
  }, [close])

  const currentRoute = useCallback(() => routeRef.current, [])

  return { overlay: route.overlay, open, close, closeIf, route: currentRoute }
}
