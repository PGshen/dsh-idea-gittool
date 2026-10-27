// A3 T6 overlay routing (design §5.3): one overlay at a time, opening replaces, Esc goes back one
// level, closing returns focus to the control that opened the first overlay.
import { describe, expect, it, vi } from 'vitest'
import { restoreFocus } from '../../../src/client/focus.ts'
import {
  CLOSED_ROUTE,
  OVERLAY_LEVEL,
  actionOverlayWiring,
  asBack,
  closeOverlay,
  createOverlayController,
  dirtySheetHandlers,
  handleOverlayEscape,
  openOverlay,
  overlayLeaveEffects,
  pushConflictWiring,
} from '../../../src/client/pages/workbench-overlay.ts'
import type { FocusTarget, OverlayController, WorkbenchOverlay } from '../../../src/client/pages/workbench-overlay.ts'
import { createActionStore } from '../../../src/client/store/action-store.ts'
import type { ActionClient, ActionStore } from '../../../src/client/store/action-store.ts'
import { conflictListSync, createAutoOpenTracker } from '../../../src/client/store/conflict-store.ts'
import { mergeState } from './operation-fixtures.ts'
import type { IntegrateValue, RpcResult } from '../../../src/shared/protocol.ts'

function target(connected = true): FocusTarget & { focus: ReturnType<typeof vi.fn<() => void>> } {
  return { focus: vi.fn<() => void>(), isConnected: connected }
}

const PUSH: WorkbenchOverlay = { kind: 'push' }
const ROLLBACK: WorkbenchOverlay = { kind: 'rollback', targets: [{ path: 'a.ts', untracked: false }] }

describe('openOverlay', () => {
  it('opens on a closed route and records the trigger', () => {
    const trigger = target()
    const result = openOverlay(CLOSED_ROUTE, PUSH, trigger)
    expect(result.route).toEqual({ overlay: PUSH, returnFocus: trigger })
    expect(result.left).toBeNull()
  })

  it('replaces the current overlay and keeps the original trigger (the replaced overlay is gone)', () => {
    const pageButton = target()
    const insideOverlay = target()
    const first = openOverlay(CLOSED_ROUTE, PUSH, pageButton).route
    const result = openOverlay(first, ROLLBACK, insideOverlay)
    expect(result.route).toEqual({ overlay: ROLLBACK, returnFocus: pageButton })
    expect(result.left).toBe(PUSH)
  })

  it('a missing trigger on a closed route records nothing', () => {
    expect(openOverlay(CLOSED_ROUTE, PUSH, null).route.returnFocus).toBeNull()
  })
})

describe('closeOverlay', () => {
  it('closes and hands back the trigger to focus', () => {
    const trigger = target()
    const open = openOverlay(CLOSED_ROUTE, PUSH, trigger).route
    const result = closeOverlay(open)
    expect(result.route).toEqual(CLOSED_ROUTE)
    expect(result.left).toBe(PUSH)
    expect(result.focus).toBe(trigger)
  })

  it('does not hand back a detached trigger', () => {
    const open = openOverlay(CLOSED_ROUTE, PUSH, target(false)).route
    expect(closeOverlay(open).focus).toBeNull()
  })

  it('closing a closed route is a no-op', () => {
    expect(closeOverlay(CLOSED_ROUTE)).toEqual({ route: CLOSED_ROUTE, left: null, focus: null })
  })

  it('B2: an overlay with `back` returns to that overlay, keeping the page trigger for the final close', () => {
    const trigger = target()
    const history = { kind: 'fileHistory', path: 'a.txt' } as const
    const blame: WorkbenchOverlay = { kind: 'blame', path: 'a.txt', rev: 'abc', back: history }
    const open = openOverlay(openOverlay(CLOSED_ROUTE, history, trigger).route, blame, null).route
    const back = closeOverlay(open)
    expect(back.route).toEqual({ overlay: history, returnFocus: trigger })
    expect(back.left).toBe(blame)
    expect(back.focus).toBeNull()
    expect(closeOverlay(back.route).focus).toBe(trigger)
  })

  it('B2: closing to the page skips the back chain', () => {
    const trigger = target()
    const blame: WorkbenchOverlay = { kind: 'blame', path: 'a.txt', back: { kind: 'fileHistory', path: 'a.txt' } }
    const open = openOverlay(CLOSED_ROUTE, blame, trigger).route
    expect(closeOverlay(open, { toPage: true })).toEqual({ route: CLOSED_ROUTE, left: blame, focus: trigger })
  })
})

describe('asBack', () => {
  it('drops the back of an overlay so chains stay one level deep', () => {
    const blame: WorkbenchOverlay = { kind: 'blame', path: 'a.txt', rev: 'abc', back: { kind: 'fileHistory', path: 'a.txt' } }
    expect(asBack(blame)).toEqual({ kind: 'blame', path: 'a.txt', rev: 'abc' })
  })
})

describe('createOverlayController dismiss (B2)', () => {
  it('closes the whole chain at once', () => {
    const routes: Array<WorkbenchOverlay | null> = []
    const controller = createOverlayController({ onChange: route => { routes.push(route.overlay) } })
    controller.open({ kind: 'blame', path: 'a.txt', back: { kind: 'fileHistory', path: 'a.txt' } }, null)
    controller.dismiss()
    expect(routes.at(-1)).toBeNull()
  })
})

describe('handleOverlayEscape', () => {
  function key(name: string, defaultPrevented = false) {
    return { key: name, defaultPrevented, preventDefault: vi.fn() }
  }

  it('Esc with an overlay open closes it once (one level)', () => {
    const close = vi.fn()
    const event = key('Escape')
    expect(handleOverlayEscape(event, { overlay: PUSH, returnFocus: null }, close)).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('leaves Esc alone when the overlay already handled it, when nothing is open, or for other keys', () => {
    const close = vi.fn()
    expect(handleOverlayEscape(key('Escape', true), { overlay: PUSH, returnFocus: null }, close)).toBe(false)
    expect(handleOverlayEscape(key('Escape'), CLOSED_ROUTE, close)).toBe(false)
    expect(handleOverlayEscape(key('Enter'), { overlay: PUSH, returnFocus: null }, close)).toBe(false)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('WorkbenchOverlay kinds', () => {
  it('every kind has a navigation level (1 = overlay page, 2 = sheet)', () => {
    expect(Object.keys(OVERLAY_LEVEL).sort()).toEqual([
      'blame', 'branchSheet', 'commitOp', 'compare', 'conflicts', 'diff', 'dirtyWorktree', 'fetch', 'fileHistory', 'merge', 'mergeWindow',
      'pull', 'push', 'pushRejected', 'rebase', 'reset', 'rollback', 'smartCheckout', 'stashCreate', 'updateProject',
    ])
    // B2 T1: blame, file history and compare are overlay pages with "← back".
    expect([OVERLAY_LEVEL.blame, OVERLAY_LEVEL.fileHistory, OVERLAY_LEVEL.compare]).toEqual([1, 1, 1])
    // B1 T6: the three-pane merge window is an overlay page (it also enters host fullscreen).
    expect(OVERLAY_LEVEL.mergeWindow).toBe(1)
    expect(OVERLAY_LEVEL.diff).toBe(1)
    expect(OVERLAY_LEVEL.rollback).toBe(2)
    expect(OVERLAY_LEVEL.dirtyWorktree).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Fix round 1: the glue (controller, leave effects, focus return, action wiring)
// ---------------------------------------------------------------------------

describe('restoreFocus', () => {
  it('focuses an attached target; skips a detached one; never throws', () => {
    const attached = { focus: vi.fn<() => void>(), isConnected: true }
    expect(restoreFocus(attached)).toBe(true)
    expect(attached.focus).toHaveBeenCalledTimes(1)
    const detached = { focus: vi.fn<() => void>(), isConnected: false }
    expect(restoreFocus(detached)).toBe(false)
    expect(detached.focus).not.toHaveBeenCalled()
    const failing = { focus: () => { throw new Error('gone') }, isConnected: true }
    expect(() => restoreFocus(failing)).not.toThrow()
    expect(restoreFocus(failing)).toBe(false)
    expect(restoreFocus(null)).toBe(false)
  })
})

describe('createOverlayController', () => {
  function controller(onLeave = vi.fn(), currentTrigger: () => FocusTarget | null = () => null) {
    const onChange = vi.fn()
    return { overlays: createOverlayController({ onChange, onLeave, currentTrigger }), onChange, onLeave }
  }

  it('replacing fires onLeave for the old overlay with the new one as next', () => {
    const { overlays, onLeave, onChange } = controller()
    overlays.open(PUSH, null)
    expect(onLeave).not.toHaveBeenCalled()
    overlays.open(ROLLBACK, null)
    expect(onLeave).toHaveBeenCalledWith(PUSH, ROLLBACK)
    expect(onChange).toHaveBeenLastCalledWith({ overlay: ROLLBACK, returnFocus: null })
    overlays.close()
    expect(onLeave).toHaveBeenLastCalledWith(ROLLBACK, null)
  })

  it('closeIf closes only the named kind', () => {
    const { overlays, onLeave } = controller()
    overlays.open(PUSH, null)
    overlays.closeIf('rollback')
    expect(overlays.route().overlay).toBe(PUSH)
    overlays.closeIf('push')
    expect(overlays.route()).toEqual(CLOSED_ROUTE)
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('focus returns to the trigger once, after close (flushFocus)', () => {
    const trigger = target()
    const { overlays } = controller()
    overlays.open(PUSH, trigger)
    expect(overlays.flushFocus()).toBe(false)
    overlays.close()
    expect(overlays.flushFocus()).toBe(true)
    expect(trigger.focus).toHaveBeenCalledTimes(1)
    expect(overlays.flushFocus()).toBe(false)
  })

  it('a trigger detached before close gets no focus call and nothing throws', () => {
    const trigger = { focus: vi.fn<() => void>(), isConnected: true }
    const { overlays } = controller()
    overlays.open(PUSH, trigger)
    ;(trigger as { isConnected: boolean }).isConnected = false
    overlays.close()
    expect(() => overlays.flushFocus()).not.toThrow()
    expect(trigger.focus).not.toHaveBeenCalled()
  })

  it('a trigger detached after close but before flush is skipped too', () => {
    const trigger = { focus: vi.fn<() => void>(), isConnected: true }
    const { overlays } = controller()
    overlays.open(PUSH, trigger)
    overlays.close()
    ;(trigger as { isConnected: boolean }).isConnected = false
    expect(overlays.flushFocus()).toBe(false)
    expect(trigger.focus).not.toHaveBeenCalled()
  })

  it('without an explicit trigger it uses the focused element at call time; null records none', () => {
    const focused = target()
    const { overlays } = controller(vi.fn(), () => focused)
    overlays.open(PUSH)
    expect(overlays.route().returnFocus).toBe(focused)
    overlays.close()
    overlays.open(PUSH, null)
    expect(overlays.route().returnFocus).toBeNull()
  })
})

describe('action store ↔ overlay wiring', () => {
  const MERGED: IntegrateValue = { head: 'a'.repeat(40), committed: true }
  const DIRTY: RpcResult<IntegrateValue> = {
    ok: false,
    error: { code: 'git/dirty-worktree', message: 'dirty', details: { operation: 'merge', paths: ['a.ts'], count: 1 } },
  }

  /** Same composition as GitWorkbench: store callbacks open overlays, leaving cancels the ask. */
  function workbench(merge: ActionClient['merge'], focused: () => FocusTarget | null = () => null, extra: Partial<ActionClient> = {}) {
    const refresh = vi.fn()
    let overlays: OverlayController | null = null
    const actions = createActionStore({
      client: { merge, ...extra } as unknown as ActionClient,
      sessionId: 's1',
      ...actionOverlayWiring({ open: (next, trigger) => overlays?.open(next, trigger), refresh }),
    })
    overlays = createOverlayController({ onChange: () => undefined, onLeave: overlayLeaveEffects(actions), currentTrigger: focused })
    return { actions, overlays, refresh, sheet: dirtySheetHandlers(actions, overlays) }
  }

  async function asked(actions: ActionStore, overlays: OverlayController): Promise<void> {
    await vi.waitFor(() => { expect(overlays.route().overlay?.kind).toBe('dirtyWorktree') })
    expect(actions.getState().ask).not.toBeNull()
  }

  it('closeIf("dirtyWorktree") (scrim / cancel button) cancels the ask: cancelled outcome, pending empty', async () => {
    const merge = vi.fn(async () => DIRTY)
    const { actions, overlays, sheet } = workbench(merge)
    const outcome = actions.run('merge', { ref: 'f' }, { smartStash: 'merge' })
    await asked(actions, overlays)
    sheet.onCancel()
    await expect(outcome).resolves.toEqual({ kind: 'cancelled' })
    expect(actions.getState()).toEqual({ pending: {}, ask: null })
    expect(overlays.route()).toEqual(CLOSED_ROUTE)
    expect(merge).toHaveBeenCalledTimes(1)
  })

  it('workbench Esc on the question cancels the ask', async () => {
    const merge = vi.fn(async () => DIRTY)
    const { actions, overlays } = workbench(merge)
    const outcome = actions.run('merge', { ref: 'f' }, { smartStash: 'merge' })
    await asked(actions, overlays)
    const event = { key: 'Escape', defaultPrevented: false, preventDefault: vi.fn() }
    expect(handleOverlayEscape(event, overlays.route(), overlays.close)).toBe(true)
    await expect(outcome).resolves.toEqual({ kind: 'cancelled' })
    expect(actions.getState().pending).toEqual({})
  })

  it('replacing the question with another overlay cancels the ask', async () => {
    const merge = vi.fn(async () => DIRTY)
    const { actions, overlays } = workbench(merge)
    const outcome = actions.run('merge', { ref: 'f' }, { smartStash: 'merge' })
    await asked(actions, overlays)
    overlays.open(PUSH, null)
    await expect(outcome).resolves.toEqual({ kind: 'cancelled' })
    expect(actions.getState().pending).toEqual({})
    expect(overlays.route().overlay).toBe(PUSH)
  })

  it('"stash and continue" resends with stash: true and closes the sheet without cancelling', async () => {
    const merge = vi.fn<ActionClient['merge']>()
      .mockResolvedValueOnce(DIRTY)
      .mockResolvedValueOnce({ ok: true, value: MERGED })
    const { actions, overlays, sheet, refresh } = workbench(merge)
    const outcome = actions.run('merge', { ref: 'f' }, { smartStash: 'merge' })
    await asked(actions, overlays)
    sheet.onStash()
    await expect(outcome).resolves.toEqual({ kind: 'done', value: MERGED })
    expect(merge.mock.calls[1]?.[0]).toMatchObject({ stash: true })
    expect(overlays.route()).toEqual(CLOSED_ROUTE)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('an async open uses the trigger captured at click time, not the element focused later', async () => {
    const clicked = target()
    const focusedLater = target()
    const merge = vi.fn(async () => DIRTY)
    const { actions, overlays, sheet } = workbench(merge, () => focusedLater)
    const outcome = actions.run('merge', { ref: 'f' }, { smartStash: 'merge', trigger: clicked })
    await asked(actions, overlays)
    expect(actions.getState().ask?.trigger).toBe(clicked)
    expect(overlays.route().returnFocus).toBe(clicked)
    sheet.onCancel()
    await outcome
    expect(overlays.flushFocus()).toBe(true)
    expect(clicked.focus).toHaveBeenCalledTimes(1)
    expect(focusedLater.focus).not.toHaveBeenCalled()
  })

  it('without a captured trigger an async open records none (no stale activeElement)', async () => {
    const focusedLater = target()
    const merge = vi.fn(async () => DIRTY)
    const { actions, overlays } = workbench(merge, () => focusedLater)
    const outcome = actions.run('merge', { ref: 'f' }, { smartStash: 'merge' })
    await asked(actions, overlays)
    expect(overlays.route().returnFocus).toBeNull()
    overlays.close()
    await outcome
  })

  it('a conflict opens the conflict list with the captured trigger and refreshes', async () => {
    const clicked = target()
    const merge = vi.fn(async () => ({ ok: false, error: { code: 'git/conflict', message: 'c', details: { conflicts: 1 } } }) as RpcResult<IntegrateValue>)
    const { actions, overlays, refresh } = workbench(merge)
    const outcome = await actions.run('merge', { ref: 'f' }, { trigger: clicked })
    expect(outcome.kind).toBe('conflict')
    expect(overlays.route()).toEqual({ overlay: { kind: 'conflicts' }, returnFocus: clicked })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('conflict markers on "mark resolved" (answered inside the list) do not reopen the list (A3 T9)', async () => {
    const resolveConflict = vi.fn(async () => ({ ok: false, error: { code: 'git/conflict', message: 'm', details: { markers: true } } }) as RpcResult<never>)
    const { actions, overlays, refresh } = workbench(vi.fn() as unknown as ActionClient['merge'], undefined, { resolveConflict: resolveConflict as unknown as ActionClient['resolveConflict'] })
    const outcome = await actions.run('resolveConflict', { path: 'a', resolution: 'mark-resolved' })
    expect(outcome.kind).toBe('conflict')
    expect(overlays.route().overlay).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('pushConflictWiring (final review 8)', () => {
  it('a pull-before-push that conflicted refreshes and opens the conflict list (console still opens)', () => {
    const open = vi.fn()
    const refresh = vi.fn()
    const openConsole = vi.fn()
    pushConflictWiring({ open, refresh, openConsole })({ code: 'git/conflict', message: 'c', details: { stashKept: true } })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({ kind: 'conflicts' }, null)
    expect(openConsole).toHaveBeenCalledTimes(1)
  })
})

describe('T7: leave guard (a dirty merge window asks before another entry replaces it)', () => {
  it('open / close consult the guard for the current overlay; closeIf does not', () => {
    const onChange = vi.fn()
    let held: (() => void) | null = null
    const guard = vi.fn((current: { kind: string }, _next: unknown, proceed: () => void) => {
      if (current.kind !== 'push') return false
      held = proceed
      return true
    })
    const overlays = createOverlayController({ onChange, guard })
    overlays.open(PUSH, null)
    overlays.open(ROLLBACK, null)
    expect(overlays.route().overlay).toBe(PUSH)
    expect(guard).toHaveBeenLastCalledWith(PUSH, ROLLBACK, expect.any(Function))
    held!()
    expect(overlays.route().overlay).toBe(ROLLBACK)

    overlays.open(PUSH, null)
    overlays.close()
    expect(overlays.route().overlay).toBe(PUSH)
    held!()
    expect(overlays.route().overlay).toBeNull()

    overlays.open(PUSH, null)
    overlays.closeIf('push')
    expect(overlays.route().overlay).toBeNull()
  })
})

describe('B1 L4: first 「解决冲突…」 click after a page load', () => {
  // L4 saw the first click do nothing. The cause was the DSH sign-in dialog's transparent mask (the
  // click landed on it and closed the dialog); this pins that the workbench wiring itself (status
  // sync, auto-open tracker, leave guard) never swallows or undoes that first open.
  const CONFLICTS: WorkbenchOverlay = { kind: 'conflicts' }
  for (const clickBeforeState of [true, false]) {
    it(`mounted mid-merge, clicked ${clickBeforeState ? 'before' : 'after'} operationState loaded: the list opens and stays`, () => {
      const onChange = vi.fn()
      const guard = vi.fn((current: WorkbenchOverlay) => current.kind === 'mergeWindow')
      const overlays = createOverlayController({ onChange, guard })
      const tracker = createAutoOpenTracker()
      let listActive = false
      const statusArrived = (): void => {
        const sync = conflictListSync(listActive, 'merge', 4)
        listActive = sync.active
        if (sync.close) {
          overlays.closeIf('conflicts')
          overlays.closeIf('mergeWindow')
        }
      }
      const stateArrived = (): void => {
        if (tracker.observe(mergeState()) && overlays.route().overlay === null) overlays.open(CONFLICTS, null)
      }
      const click = (): void => {
        overlays.open(CONFLICTS, null)
        tracker.noteOpened()
      }

      statusArrived()
      if (clickBeforeState) {
        click()
        stateArrived()
      } else {
        stateArrived()
        click()
      }
      statusArrived()
      stateArrived()

      expect(overlays.route().overlay).toEqual(CONFLICTS)
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(guard).not.toHaveBeenCalled()
    })
  }
})
