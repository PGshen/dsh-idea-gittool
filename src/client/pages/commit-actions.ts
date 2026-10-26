// Commit context menu of the log (design §8.1.7, plan A3 T8): availability matrix, what each item
// does (as data, so it is testable) and the small geometry/keyboard helpers. React-free.
import type { CommitSummary, RepoOperation } from '../../shared/protocol.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { GitWorkbenchKey } from '../locales.ts'
import { writeBlock } from './branch-actions.ts'
import type { WorkbenchOverlay } from './workbench-overlay.ts'

export type CommitActionId =
  | 'copyHash'
  | 'copyShortHash'
  | 'copyMessage'
  | 'checkout'
  | 'newBranch'
  | 'cherryPick'
  | 'revert'
  | 'resetTo'
  | 'goParent'
  | 'goChild'

export interface CommitActionItem {
  id: CommitActionId
  label: LocalizedText
  danger?: boolean
  disabledReason?: LocalizedText
  /** Menu section; a separator is drawn between sections. */
  section: number
}

export interface CommitActionContext {
  writable: boolean
  operation: RepoOperation
  /** The first parent is in the loaded log. */
  parentLoaded: boolean
  /** A child of this commit is in the loaded log. */
  childLoaded: boolean
}

/** Neighbour availability from the loaded log (newest first). */
export function commitActionContext(
  commits: readonly CommitSummary[],
  commit: CommitSummary,
  base: { writable: boolean; operation: RepoOperation },
): CommitActionContext {
  const parent = commit.parents[0]
  return {
    writable: base.writable,
    operation: base.operation,
    parentLoaded: parent !== undefined && commits.some(candidate => candidate.sha === parent),
    childLoaded: childOf(commits, commit.sha) !== null,
  }
}

/** The newest loaded commit that has `sha` as a parent. */
export function childOf(commits: readonly CommitSummary[], sha: string): string | null {
  return commits.find(candidate => candidate.parents.includes(sha))?.sha ?? null
}

function item(
  id: CommitActionId,
  label: GitWorkbenchKey,
  section: number,
  disabledReason?: LocalizedText,
  danger = false,
): CommitActionItem {
  const result: CommitActionItem = { id, label: text(label), section }
  if (danger) result.danger = true
  if (disabledReason !== undefined) result.disabledReason = disabledReason
  return result
}

/** Menu items for a log row. Disabled items stay visible with their reason. */
export function commitActions(commit: CommitSummary, context: CommitActionContext): CommitActionItem[] {
  const block = writeBlock(context)
  const isMerge = commit.parents.length > 1
  const mergeReason = isMerge ? text('commit.disabled.mergeParent') : undefined
  const parentReason = commit.parents.length === 0
    ? text('commit.disabled.noParent')
    : (context.parentLoaded ? undefined : text('commit.disabled.parentNotLoaded'))
  return [
    item('copyHash', 'commit.action.copyHash', 1),
    item('copyShortHash', 'commit.action.copyShortHash', 1),
    item('copyMessage', 'commit.action.copyMessage', 1),
    item('checkout', 'commit.action.checkout', 2, block),
    item('newBranch', 'commit.action.newBranch', 2, block),
    item('cherryPick', 'commit.action.cherryPick', 3, block ?? mergeReason),
    item('revert', 'commit.action.revert', 3, block ?? mergeReason),
    item('resetTo', 'commit.action.resetTo', 3, block, true),
    item('goParent', 'commit.action.goParent', 4, parentReason),
    item('goChild', 'commit.action.goChild', 4, context.childLoaded ? undefined : text('commit.disabled.noChild')),
  ]
}

export type CommitActionEffect =
  | { kind: 'copy'; value: string }
  | { kind: 'overlay'; overlay: WorkbenchOverlay }
  | { kind: 'jump'; sha: string }

/** What choosing `id` does; null when there is nothing to do (no parent / child). */
export function commitActionEffect(id: CommitActionId, commit: CommitSummary, childSha: string | null): CommitActionEffect | null {
  switch (id) {
    case 'copyHash': return { kind: 'copy', value: commit.sha }
    case 'copyShortHash': return { kind: 'copy', value: commit.shortSha }
    case 'copyMessage': return { kind: 'copy', value: commit.subject }
    case 'checkout': return { kind: 'overlay', overlay: { kind: 'branchSheet', mode: 'checkoutRevision', revision: commit.sha } }
    case 'newBranch': return { kind: 'overlay', overlay: { kind: 'branchSheet', mode: 'new', startPoint: commit.sha } }
    case 'cherryPick':
    case 'revert':
      return {
        kind: 'overlay',
        overlay: { kind: 'commitOp', op: id, sha: commit.sha, shortSha: commit.shortSha, subject: commit.subject },
      }
    case 'resetTo': return { kind: 'overlay', overlay: { kind: 'reset', sha: commit.sha } }
    case 'goParent': {
      const parent = commit.parents[0]
      return parent === undefined ? null : { kind: 'jump', sha: parent }
    }
    case 'goChild': return childSha === null ? null : { kind: 'jump', sha: childSha }
  }
}

/** ContextMenu key or Shift+F10 (design §14.1). */
export function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}

const MENU_MARGIN = 8

/** Keep a fixed-position menu of `size` inside the viewport. */
export function clampMenuPosition(
  position: { x: number; y: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const clamp = (value: number, extent: number, limit: number): number =>
    Math.max(MENU_MARGIN, Math.min(value, limit - extent - MENU_MARGIN))
  return { x: clamp(position.x, size.width, viewport.width), y: clamp(position.y, size.height, viewport.height) }
}
