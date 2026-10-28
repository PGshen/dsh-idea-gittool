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
  // B2 compare mode
  | 'compareWorktree'
  | 'compareSelected'
  // B3a interactive rebase (behind the `interactiveRebase` flag)
  | 'interactiveRebaseFrom'
  | 'reword'
  | 'drop'
  | 'squashSelected'
  // B3b commit menu
  | 'undoCommit'
  | 'pushUpTo'
  | 'createTag'
  | 'fixupInto'
  | 'squashInto'
  | 'createPatch'

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
  /** B2: shas selected in the log (the compare item needs exactly two, this one among them). */
  selection?: readonly string[]
  /** B3a: rebase items, present only when the flag is on. */
  rebase?: RebaseAvailability
  /** B3b: where the commit stands relative to HEAD (present when HEAD is known). */
  history?: HistoryAvailability
}

/** B3b: facts the commit-menu additions need. */
export interface HistoryAvailability {
  chain: RebaseAvailability['chain']
  isHead: boolean
  /** Files checked on the commit page (fixup / squash into take them). */
  checkedCount: number
}

/**
 * Where a commit stands for an interactive rebase of the current branch, from the loaded log: on the
 * first-parent chain of HEAD, off it, or unknown (the chain leaves the loaded pages; the Host decides).
 */
export interface RebaseAvailability {
  chain: 'on' | 'off' | 'unknown'
  /** The selection is two or more adjacent commits of the chain. */
  squash: boolean
}

/** First-parent chain of `head` through the loaded commits, and whether it reached the root. */
function firstParentChain(commits: readonly CommitSummary[], head: string): { shas: string[]; complete: boolean } {
  const bySha = new Map(commits.map(commit => [commit.sha, commit]))
  const shas: string[] = []
  let current: string | undefined = head
  while (current !== undefined) {
    const commit = bySha.get(current)
    if (commit === undefined) return { shas, complete: false }
    shas.push(current)
    current = commit.parents[0]
  }
  return { shas, complete: true }
}

/** {@link RebaseAvailability} of `commit` (B3a). */
export function rebaseAvailability(
  commits: readonly CommitSummary[],
  commit: CommitSummary,
  headSha: string,
  selection: readonly string[],
): RebaseAvailability {
  const chain = firstParentChain(commits, headSha)
  const position = new Map(chain.shas.map((sha, index) => [sha, index]))
  const status = position.has(commit.sha) ? 'on' : chain.complete ? 'off' : 'unknown'
  const indexes = selection.map(sha => position.get(sha)).filter((index): index is number => index !== undefined).sort((a, b) => a - b)
  const squash = selection.length >= 2 && indexes.length === selection.length &&
    indexes.every((index, at) => at === 0 || index === (indexes[at - 1] ?? -2) + 1)
  return { chain: status, squash }
}

/** Neighbour availability from the loaded log (newest first). */
export function commitActionContext(
  commits: readonly CommitSummary[],
  commit: CommitSummary,
  base: { writable: boolean; operation: RepoOperation; selection?: readonly string[]; rebase?: boolean; headSha?: string; checkedCount?: number },
): CommitActionContext {
  const parent = commit.parents[0]
  const context: CommitActionContext = {
    writable: base.writable,
    operation: base.operation,
    parentLoaded: parent !== undefined && commits.some(candidate => candidate.sha === parent),
    childLoaded: childOf(commits, commit.sha) !== null,
  }
  if (base.selection !== undefined) context.selection = base.selection
  if (base.headSha !== undefined) {
    const availability = rebaseAvailability(commits, commit, base.headSha, base.selection ?? [commit.sha])
    if (base.rebase === true) context.rebase = availability
    context.history = { chain: availability.chain, isHead: commit.sha === base.headSha, checkedCount: base.checkedCount ?? 0 }
  }
  return context
}

/** Why "compare the two selected commits" is unavailable for `sha`, if it is. */
function compareSelectedReason(sha: string, selection: readonly string[]): LocalizedText | undefined {
  if (selection.length > 2) return text('commit.disabled.compareTooMany')
  if (selection.length < 2 || !selection.includes(sha)) return text('commit.disabled.compareNeedsTwo')
  return undefined
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
    item('compareWorktree', 'commit.action.compareWorktree', 5),
    item('compareSelected', 'commit.action.compareSelected', 5, compareSelectedReason(commit.sha, context.selection ?? [])),
    ...rebaseItems(commit, context, block),
    ...historyItems(commit, context, block),
  ]
}

function historyItems(commit: CommitSummary, context: CommitActionContext, block: LocalizedText | undefined): CommitActionItem[] {
  const history = context.history
  if (history === undefined) return []
  const merge = commit.parents.length > 1 ? text('commit.disabled.rebaseMerge') : undefined
  const offBranch = history.chain === 'off' ? text('commit.disabled.rebaseOffBranch') : undefined
  const undo = block
    ?? (history.isHead ? undefined : text('commit.disabled.undoNotHead'))
    ?? merge
    ?? (commit.parents.length === 0 ? text('commit.disabled.noParent') : undefined)
  const fold = block ?? merge ?? offBranch ?? (history.checkedCount > 0 ? undefined : text('commit.disabled.fixupNeedsFiles'))
  return [
    item('undoCommit', 'commit.action.undoCommit', 7, undo),
    item('pushUpTo', 'commit.action.pushUpTo', 7, block ?? offBranch),
    item('createTag', 'commit.action.createTag', 7, block),
    item('fixupInto', 'commit.action.fixupInto', 8, fold),
    item('squashInto', 'commit.action.squashInto', 8, fold),
    item('createPatch', 'commit.action.createPatch', 8, merge),
  ]
}

function rebaseItems(commit: CommitSummary, context: CommitActionContext, block: LocalizedText | undefined): CommitActionItem[] {
  const rebase = context.rebase
  if (rebase === undefined) return []
  const reason = block
    ?? (commit.parents.length > 1 ? text('commit.disabled.rebaseMerge') : undefined)
    ?? (rebase.chain === 'off' ? text('commit.disabled.rebaseOffBranch') : undefined)
  return [
    item('interactiveRebaseFrom', 'commit.action.interactiveRebaseFrom', 6, reason),
    item('reword', 'commit.action.reword', 6, reason),
    item('drop', 'commit.action.drop', 6, reason, true),
    item('squashSelected', 'commit.action.squashSelected', 6, block ?? (rebase.squash ? undefined : text('commit.disabled.squashNeedsAdjacent'))),
  ]
}

export type CommitActionEffect =
  | { kind: 'copy'; value: string }
  | { kind: 'overlay'; overlay: WorkbenchOverlay }
  | { kind: 'jump'; sha: string }

/** What choosing `id` does; null when there is nothing to do (no parent / child). */
export function commitActionEffect(
  id: CommitActionId,
  commit: CommitSummary,
  childSha: string | null,
  selected: readonly CommitSummary[] = [],
): CommitActionEffect | null {
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
    case 'compareWorktree':
      return { kind: 'overlay', overlay: { kind: 'compare', left: commit.sha, right: null, leftLabel: commit.shortSha, rightLabel: null } }
    case 'interactiveRebaseFrom':
      return { kind: 'overlay', overlay: { kind: 'interactiveRebase', base: commit.parents[0] ?? null } }
    case 'reword':
    case 'drop':
      return { kind: 'overlay', overlay: { kind: 'interactiveRebase', base: commit.parents[0] ?? null, preset: { kind: id, sha: commit.sha } } }
    case 'squashSelected': {
      // `selected` is in log order (newest first): rebase from the parent of the oldest one.
      const oldest = selected.at(-1)
      return oldest === undefined || selected.length < 2
        ? null
        : {
            kind: 'overlay',
            overlay: { kind: 'interactiveRebase', base: oldest.parents[0] ?? null, preset: { kind: 'squash', shas: selected.map(entry => entry.sha) } },
          }
    }
    case 'undoCommit': {
      const parent = commit.parents[0]
      return parent === undefined
        ? null
        : { kind: 'overlay', overlay: { kind: 'undoCommit', sha: commit.sha, parent, shortSha: commit.shortSha, subject: commit.subject } }
    }
    case 'pushUpTo':
      return { kind: 'overlay', overlay: { kind: 'push', revision: commit.sha } }
    case 'createTag':
      return { kind: 'overlay', overlay: { kind: 'createTag', sha: commit.sha, shortSha: commit.shortSha } }
    case 'fixupInto':
    case 'squashInto':
      return {
        kind: 'overlay',
        overlay: { kind: 'fixupInto', sha: commit.sha, shortSha: commit.shortSha, subject: commit.subject, mode: id === 'fixupInto' ? 'fixup' : 'squash' },
      }
    case 'createPatch': {
      // A multi-selection containing this commit exports all of it (design §14.2).
      const shas = selected.length > 1 && selected.some(entry => entry.sha === commit.sha) ? selected.map(entry => entry.sha) : [commit.sha]
      return { kind: 'overlay', overlay: { kind: 'patch', shas } }
    }
    case 'compareSelected': {
      // "In this commit but not in the other": the clicked commit is the left side.
      const other = selected.find(candidate => candidate.sha !== commit.sha)
      return other === undefined
        ? null
        : { kind: 'overlay', overlay: { kind: 'compare', left: commit.sha, right: other.sha, leftLabel: commit.shortSha, rightLabel: other.shortSha } }
    }
  }
}

/** Whether a keyboard shortcut for `id` may run: the item is in the menu and not disabled. */
export function enabledAction(items: readonly CommitActionItem[], id: CommitActionId): boolean {
  const found = items.find(entry => entry.id === id)
  return found !== undefined && found.disabledReason === undefined
}

/** ContextMenu key or Shift+F10 (design §14.1). */
export function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}
