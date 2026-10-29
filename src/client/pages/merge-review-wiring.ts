// B1 T7 workbench wiring of the merge window and the Review Changes queue (confirmation 2, rulings
// 6/7/12), React-free so the workbench's behaviour is testable without a DOM:
// - start: open the first queued file; applied: refresh, then the next queued file (or, without a
//   queue, the next unresolved file / the list);
// - loadFailed: a queued resolved file the window cannot review is marked and skipped silently;
// - left / openFile: back, another entry point or moving to another file by hand stops the queue.
import type { GitError } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import type { ConflictStore } from '../store/conflict-store.ts'
import { createReviewRunner, nextFileAfterApply } from './merge-window-controller.ts'
import type { WorkbenchOverlay } from './workbench-overlay.ts'

/** The open merge window's `guardLeave` (filled by MergeWindow while a file is open). */
export type MergeLeaveGuard = (go: () => void, cancel?: () => void) => boolean

/**
 * The workbench overlay guard: a dirty merge window holds whatever replaces it. When that is the
 * pending action's dirty-worktree ask, not leaving (cancel, Esc, a newer navigation, the window
 * closing) answers the ask as cancelled (`cancelStash`).
 */
export function mergeWindowOverlayGuard(
  guard: { current: MergeLeaveGuard | null },
  cancelStash: () => void,
): (current: WorkbenchOverlay, next: WorkbenchOverlay | null, proceed: () => void) => boolean {
  return (current, next, proceed) => current.kind === 'mergeWindow'
    && guard.current?.(proceed, next?.kind === 'dirtyWorktree' ? cancelStash : undefined) === true
}

export interface MergeReviewDeps {
  conflicts: Pick<ConflictStore, 'getState' | 'refresh' | 'invalidateCount' | 'markNotReviewable' | 'markReviewed'>
  open: (overlay: WorkbenchOverlay, trigger: FocusTarget | null) => void
  /** Reload the workbench status after a write. */
  refreshStatus: () => void
}

export interface MergeReviewWiring {
  /** 「逐个解决 / 审查更改」: open the queue's first file. */
  start(queue: readonly string[], trigger: FocusTarget | null): void
  /** The merge store loaded a file (it counts as reviewed). */
  opened(path: string): void
  /** Applied in the window (`remaining` null: a fallback choice resolved the file). */
  applied(path: string, remaining: number | null): void
  /** The merge store could not load a file (`error` null: a resolved file it cannot review). */
  loadFailed(path: string, error: GitError | null): void
  /** The merge window overlay was left for `next`. */
  left(path: string, next: WorkbenchOverlay | null): void
  /** The window moved to another file by hand (header buttons, F7 at the end). */
  openFile(path: string): void
  /** A Review queue is running. */
  reviewing(): boolean
}

export function createMergeReviewWiring(deps: MergeReviewDeps): MergeReviewWiring {
  const runner = createReviewRunner()
  const openPath = (path: string | null): void => {
    deps.open(path === null ? { kind: 'conflicts' } : { kind: 'mergeWindow', path }, null)
  }
  return {
    start: (queue, trigger) => {
      const first = runner.start(queue)
      if (first !== null) deps.open({ kind: 'mergeWindow', path: first }, trigger)
    },
    opened: (path) => { deps.conflicts.markReviewed(path) },
    // Ruling 12: after a successful apply the window always leaves the file.
    applied: (path, remaining) => {
      deps.conflicts.invalidateCount(path)
      void deps.conflicts.refresh()
      deps.refreshStatus()
      const queued = runner.next(path)
      if (queued !== undefined) {
        openPath(queued)
        return
      }
      const paths = deps.conflicts.getState().value?.conflicts.map(entry => entry.path) ?? []
      openPath(nextFileAfterApply(paths, path, remaining ?? paths.filter(entry => entry !== path).length))
    },
    // Rulings 6/7: only a queued resolved file is skipped; unresolved files keep their error in the window.
    loadFailed: (path, error) => {
      if (runner.current() !== path || (error !== null && error.code !== 'git/stale-target')) return
      if (deps.conflicts.getState().value?.conflicts.some(entry => entry.path === path) === true) return
      deps.conflicts.markNotReviewable(path)
      openPath(runner.next(path) ?? null)
    },
    left: (path, next) => {
      deps.conflicts.invalidateCount(path)
      if (next?.kind !== 'mergeWindow') runner.cancel()
    },
    openFile: (path) => {
      runner.cancel()
      deps.open({ kind: 'mergeWindow', path }, null)
    },
    reviewing: () => runner.active(),
  }
}
