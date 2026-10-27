// Branch actions of the Branches page and the log's branch panel (design §8.3.4, plan A3 T7):
// - `branchActions` / `quickActions`: pure availability matrices (disabled items carry a reason)
// - `createBranchActionRunner`: executes an action (write via the action store, or open an overlay)
// - smart checkout: send `mode: 'normal'`; only `git/would-overwrite` opens the smartCheckout sheet
// React-free so it is unit-testable without a DOM.
import type {
  BranchEntry,
  CheckoutTarget,
  OperationControlAction,
  RepoOperation,
  StatusValue,
  WritePolicyValue,
} from '../../shared/protocol.ts'
import { WRITE_PATHS_MAX } from '../../shared/protocol.ts'
import type { FocusTarget } from '../focus.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { GitWorkbenchKey } from '../locales.ts'
import type { ActionOutcome, ActionStore } from '../store/action-store.ts'
import { uncommittedCount } from '../store/changes-store.ts'
import type { WorkbenchOverlay } from './workbench-overlay.ts'

export type BranchActionId =
  | 'checkout'
  | 'newFrom'
  | 'merge'
  | 'rebaseOnto'
  | 'pull'
  | 'push'
  | 'rename'
  | 'delete'
  | 'copyName'
  | 'copyRef'
  | 'filterLog'
  | 'showInLog'
  // B2 compare mode
  | 'compareWithCurrent'
  | 'compareWithWorktree'
  // B3d
  | 'pushTag'
  | 'deleteTag'
  | 'deleteRemoteBranch'
  | 'setUpstream'
  | 'unsetUpstream'
  | 'checkoutInWorktree'

export interface BranchActionItem {
  id: BranchActionId
  label: LocalizedText
  /** Destructive: drawn in the danger tone (the confirmation lives in the sheet). */
  danger?: boolean
  /** Set when the item cannot run now; the menu still shows it, with this reason. */
  disabledReason?: LocalizedText
  /** Menu section; a separator is drawn between sections. */
  section: number
}

export interface BranchActionContext {
  /** Repository is writable (`writePolicy.mode === 'read-write'`). */
  writable: boolean
  /** In-progress operation (merge/rebase/…); writes are blocked while it runs. */
  operation: RepoOperation
  /** Current branch; null when HEAD is detached. */
  current: string | null
  /** The working tree has uncommitted changes. Informational: smart operations ask by themselves. */
  dirty: boolean
  /** B3d items (tags, remote branches, upstream, worktrees); absent → none of them. */
  remotes?: { worktrees: boolean }
}

/** Availability context from the latest status and the Host's write policy. */
export function branchActionContext(status: StatusValue | null, policy: WritePolicyValue): BranchActionContext {
  return {
    writable: policy.mode === 'read-write',
    operation: status?.operation ?? null,
    current: status === null || status.detached ? null : status.branch,
    dirty: uncommittedCount(status) > 0,
  }
}

const READ_ONLY = text('branch.disabled.readOnly')
const OPERATION = text('branch.disabled.operation')
const IS_CURRENT = text('branch.disabled.isCurrent')
const DELETE_CURRENT = text('branch.disabled.deleteCurrent')
const DETACHED = text('branch.disabled.detached')

/** Reason why every write is blocked right now, if any. */
export function writeBlock(context: Pick<BranchActionContext, 'writable' | 'operation'>): LocalizedText | undefined {
  if (!context.writable) return READ_ONLY
  if (context.operation !== null) return OPERATION
  return undefined
}

/** `origin/feat/x` → remote `origin`, branch `feat/x`. */
export function splitRemoteRef(ref: string): { remote: string; branch: string } | null {
  const index = ref.indexOf('/')
  if (index <= 0 || index === ref.length - 1) return null
  return { remote: ref.slice(0, index), branch: ref.slice(index + 1) }
}

/** The ref a "pull into current" would fetch: the remote branch itself, or a local branch's upstream. */
function pullSource(entry: BranchEntry): string | null {
  if (entry.kind === 'remote') return entry.name
  if (entry.kind === 'local' && !entry.current && entry.upstream !== undefined) return entry.upstream
  return null
}

function item(
  id: BranchActionId,
  label: GitWorkbenchKey,
  section: number,
  disabledReason: LocalizedText | undefined,
  extra: { danger?: boolean } = {},
): BranchActionItem {
  const result: BranchActionItem = { id, label: text(label), section }
  if (extra.danger === true) result.danger = true
  if (disabledReason !== undefined) result.disabledReason = disabledReason
  return result
}

/** Menu items for a branch or tag row. Hidden items are out of scope (remote delete/rename, tags). */
export function branchActions(entry: BranchEntry, context: BranchActionContext): BranchActionItem[] {
  const block = writeBlock(context)
  const isTag = entry.kind === 'tag'
  const isLocal = entry.kind === 'local'
  const items: BranchActionItem[] = [
    item('checkout', isTag ? 'branch.action.checkoutTag' : 'branch.action.checkout', 1, block ?? (entry.current ? IS_CURRENT : undefined)),
    item('newFrom', isTag ? 'branch.action.newFromTag' : 'branch.action.newFrom', 1, block),
  ]
  if (!isTag) {
    items.push(
      item('merge', 'branch.action.merge', 2, block ?? (entry.current ? IS_CURRENT : undefined)),
      item('rebaseOnto', 'branch.action.rebaseOnto', 2, block ?? (entry.current ? IS_CURRENT : undefined)),
    )
    if (pullSource(entry) !== null) {
      items.push(item('pull', 'branch.action.pull', 2, block ?? (context.current === null ? DETACHED : undefined)))
    }
    if (entry.current) items.push(item('push', 'branch.action.push', 2, block))
  }
  if (isLocal) {
    items.push(
      item('rename', 'branch.action.rename', 3, block),
      item('delete', 'branch.action.delete', 3, block ?? (entry.current ? DELETE_CURRENT : undefined), { danger: true }),
    )
  }
  items.push(item('copyName', 'branch.menu.copyName', 4, undefined), item('copyRef', 'branch.menu.copyRef', 4, undefined))
  if (!isTag) items.push(item('filterLog', 'branch.menu.filter', 5, undefined))
  items.push(item('showInLog', 'branch.action.showInLog', 5, undefined))
  items.push(
    item('compareWithCurrent', 'branch.action.compareWithCurrent', 6, entry.current ? IS_CURRENT : undefined),
    item('compareWithWorktree', 'branch.action.compareWithWorktree', 6, undefined),
  )
  if (context.remotes !== undefined) items.push(...remoteItems(entry, context.remotes, block))
  return items
}

/** B3d: tag push/delete, remote branch delete, upstream, new worktree. */
function remoteItems(entry: BranchEntry, options: { worktrees: boolean }, block: LocalizedText | undefined): BranchActionItem[] {
  if (entry.kind === 'tag') {
    return [
      item('pushTag', 'branch.action.pushTag', 7, block),
      item('deleteTag', 'branch.action.deleteTag', 7, block, { danger: true }),
    ]
  }
  if (entry.kind === 'remote') return [item('deleteRemoteBranch', 'branch.action.deleteRemoteBranch', 7, block, { danger: true })]
  const items = [
    item('setUpstream', 'branch.action.setUpstream', 7, block),
    item('unsetUpstream', 'branch.action.unsetUpstream', 7, block ?? (entry.upstream === undefined ? text('branch.disabled.noUpstream') : undefined)),
  ]
  if (options.worktrees) items.push(item('checkoutInWorktree', 'branch.action.checkoutInWorktree', 7, block ?? (entry.current ? IS_CURRENT : undefined)))
  return items
}

/** Double click checks the row out, but only when the menu's checkout item is enabled. */
export function doubleClickAction(entry: BranchEntry, context: BranchActionContext): 'checkout' | null {
  const checkout = branchActions(entry, context).find(candidate => candidate.id === 'checkout')
  return checkout !== undefined && checkout.disabledReason === undefined ? 'checkout' : null
}

export function checkoutTargetOf(entry: BranchEntry): CheckoutTarget {
  return { kind: entry.kind, name: entry.name }
}

// ---------------------------------------------------------------------------
// Quick actions (top of the Branches page)
// ---------------------------------------------------------------------------

export type QuickActionId = 'update' | 'commit' | 'push' | 'continue' | 'abort' | 'newBranch' | 'checkoutRevision'

export interface QuickActionItem {
  id: QuickActionId
  label: LocalizedText
  disabledReason?: LocalizedText
  danger?: boolean
}

function quick(
  id: QuickActionId,
  label: GitWorkbenchKey,
  disabledReason: LocalizedText | undefined,
  danger = false,
): QuickActionItem {
  const result: QuickActionItem = { id, label: text(label) }
  if (disabledReason !== undefined) result.disabledReason = disabledReason
  if (danger) result.danger = true
  return result
}

export function quickActions(context: BranchActionContext): QuickActionItem[] {
  const block = writeBlock(context)
  const items: QuickActionItem[] = [
    quick('update', 'branch.quick.update', block),
    // "Commit" only switches the page, so it never needs write access.
    quick('commit', 'branch.quick.commit', undefined),
    quick('push', 'branch.quick.push', !context.writable ? READ_ONLY : (context.current === null ? DETACHED : undefined)),
  ]
  if (context.operation !== null) {
    const readOnly = context.writable ? undefined : READ_ONLY
    items.push(quick('continue', 'branch.quick.continue', readOnly), quick('abort', 'branch.quick.abort', readOnly, true))
  }
  items.push(quick('newBranch', 'branch.quick.newBranch', block), quick('checkoutRevision', 'branch.quick.checkoutRevision', block))
  return items
}

/** Search match: case-insensitive "contains"; a blank query matches everything. */
export function matchesQuery(label: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || label.toLowerCase().includes(needle)
}

// ---------------------------------------------------------------------------
// Branch name validation (client-side hint; the Host's `check-ref-format` is authoritative)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- control characters are exactly what git refuses
const ILLEGAL_CHARS = /[\s~^:?*[\\\u0000-\u001f\u007f]/

/** Null when the name is blank (submit stays disabled) or looks valid. */
export function validateBranchName(name: string): LocalizedText | null {
  const value = name.trim()
  if (value === '') return null
  if (ILLEGAL_CHARS.test(value)) return text('branch.sheet.name.invalidChars')
  const badShape = value === '@'
    || value.startsWith('-')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || /(^|\/)\./.test(value)
    || /\.lock(\/|$)/.test(value)
  return badShape ? text('branch.sheet.name.invalidShape') : null
}

// ---------------------------------------------------------------------------
// Result notices
// ---------------------------------------------------------------------------

/** A button on a notice: `goStash` switches to the stash page (the kept stash lives there). */
export type NoticeActionId = 'goStash'

export interface ActionNotice {
  tone: 'error' | 'warning'
  message: LocalizedText
  /** Second sentence after the message (a failed write that kept or lost the user's stash). */
  detail?: LocalizedText
  action?: NoticeActionId
}

/** TD-9: a write over more than {@link WRITE_PATHS_MAX} paths is not sent; the notice says why. */
export function pathsLimitNotice(count: number): ActionNotice | null {
  return count > WRITE_PATHS_MAX ? { tone: 'error', message: text('write.tooManyPaths', { max: WRITE_PATHS_MAX, count }) } : null
}

/** Stash fields a write result or a failure's details may carry (smart stash / pending stash). */
export interface StashFields {
  stashRestored?: unknown
  stashKept?: unknown
  stashMissing?: unknown
  stashError?: unknown
}

/** What the user must hear about the stash of an operation; a successful restore is silent. */
export function stashNotice(value: StashFields): ActionNotice | null {
  if (typeof value.stashError === 'string') return { tone: 'warning', message: text('operation.notice.stashError', { message: value.stashError }), action: 'goStash' }
  if (value.stashKept === true) return { tone: 'warning', message: text('operation.notice.stashKept'), action: 'goStash' }
  if (value.stashMissing === true) return { tone: 'warning', message: text('operation.notice.stashMissing') }
  return null
}

/**
 * The error notice of a failed write; when the failure also kept (or lost) the user's stash,
 * that is told in the same notice with 「前往贮藏页」 (final review 2a: "恢复失败一律保留并告知").
 */
export function failedNotice(outcome: Extract<ActionOutcome<unknown>, { kind: 'failed' }>): ActionNotice {
  const stash = stashNotice(outcome.error.details ?? {})
  if (stash === null) return { tone: 'error', message: outcome.message }
  return { tone: 'error', message: outcome.message, detail: stash.message, ...(stash.action === undefined ? {} : { action: stash.action }) }
}

/** What the user should be told about an outcome (null: nothing — the UI already shows the result). */
export function outcomeNotice(outcome: ActionOutcome<unknown>): ActionNotice | null {
  if (outcome.kind === 'failed') return failedNotice(outcome)
  if (outcome.kind === 'done') {
    const value = outcome.value
    if (typeof value !== 'object' || value === null) return null
    const fields = value as StashFields
    // A conflicting restore keeps its own wording; a git error or a vanished stash is told as such.
    if (fields.stashKept === true && typeof fields.stashError !== 'string') {
      return { tone: 'warning', message: text('notice.stashKept'), action: 'goStash' }
    }
    return stashNotice(fields)
  }
  return null
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** The plain "Fetch" of the Branches page (all remotes, no prune); also its in-flight key. */
export const FETCH_ALL = { remote: null, prune: false } as const

export interface BranchActionRunnerDeps {
  actions: Pick<ActionStore, 'run'>
  /** Open an overlay; `trigger` is the control the user clicked (async opens never read the DOM). */
  openOverlay: (overlay: WorkbenchOverlay, trigger: FocusTarget | null) => void
  copy: (value: string) => void
  showInLog: (entry: BranchEntry) => void
  filterLog: (entry: BranchEntry) => void
  openPush: () => void
  /** Every finished write outcome (the workbench turns it into a notice). */
  onOutcome: (outcome: ActionOutcome<unknown>) => void
  /** B2: the current branch's name, the label of "compare with current" (HEAD when detached). */
  currentBranch?: () => string | null
}

export interface BranchActionRunner {
  run(id: BranchActionId, entry: BranchEntry, trigger: FocusTarget | null): Promise<void>
  /**
   * Checkout with the smart-checkout rule; resolves to 'smart' when the sheet was opened instead.
   * `report: false` leaves the outcome to the caller (a sheet that shows the error itself).
   */
  checkout(
    target: CheckoutTarget,
    trigger: FocusTarget | null,
    options?: { report?: boolean },
  ): Promise<ActionOutcome<unknown> | 'smart'>
  fetch(trigger: FocusTarget | null): Promise<void>
  control(action: OperationControlAction, trigger: FocusTarget | null): Promise<void>
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : []
}

/** The smartCheckout overlay for a `git/would-overwrite` refusal (tracked paths + blocking untracked files). */
function smartCheckoutOverlay(target: CheckoutTarget, details: Record<string, unknown> | undefined): WorkbenchOverlay {
  const untracked = stringList(details?.['untracked'])
  return { kind: 'smartCheckout', target, paths: stringList(details?.['paths']), ...(untracked.length > 0 ? { untracked } : {}) }
}

export function createBranchActionRunner(deps: BranchActionRunnerDeps): BranchActionRunner {
  async function checkout(
    target: CheckoutTarget,
    trigger: FocusTarget | null,
    options: { report?: boolean } = {},
  ): Promise<ActionOutcome<unknown> | 'smart'> {
    // Like IntelliJ: try the plain checkout; only a git refusal (it would overwrite local changes) asks.
    const outcome = await deps.actions.run('checkout', { target, mode: 'normal' }, { trigger })
    if (outcome.kind === 'failed' && outcome.error.code === 'git/would-overwrite') {
      deps.openOverlay(smartCheckoutOverlay(target, outcome.error.details), trigger)
      return 'smart'
    }
    if (options.report !== false) deps.onOutcome(outcome)
    return outcome
  }

  async function control(action: OperationControlAction, trigger: FocusTarget | null): Promise<void> {
    deps.onOutcome(await deps.actions.run('operationControl', { action }, { trigger }))
  }

  async function fetch(trigger: FocusTarget | null): Promise<void> {
    deps.onOutcome(await deps.actions.run('fetch', FETCH_ALL, { trigger }))
  }

  async function run(id: BranchActionId, entry: BranchEntry, trigger: FocusTarget | null): Promise<void> {
    switch (id) {
      case 'checkout':
        await checkout(checkoutTargetOf(entry), trigger)
        return
      case 'newFrom':
        deps.openOverlay({ kind: 'branchSheet', mode: 'new', startPoint: entry.name }, trigger)
        return
      case 'rename':
        deps.openOverlay({ kind: 'branchSheet', mode: 'rename', branch: entry.name }, trigger)
        return
      case 'delete':
        deps.openOverlay({ kind: 'branchSheet', mode: 'delete', branch: entry.name, sha: entry.sha }, trigger)
        return
      case 'merge':
        deps.openOverlay({ kind: 'merge', ref: entry.name }, trigger)
        return
      case 'rebaseOnto':
        deps.openOverlay({ kind: 'rebase', onto: entry.name }, trigger)
        return
      case 'pull': {
        const source = pullSource(entry)
        const split = source === null ? null : splitRemoteRef(source)
        deps.openOverlay(split === null ? { kind: 'pull' } : { kind: 'pull', remote: split.remote, branch: split.branch }, trigger)
        return
      }
      case 'push':
        deps.openPush()
        return
      case 'copyName':
        deps.copy(entry.name)
        return
      case 'copyRef':
        deps.copy(entry.ref)
        return
      case 'compareWithCurrent':
        deps.openOverlay({ kind: 'compare', left: entry.name, right: 'HEAD', leftLabel: entry.name, rightLabel: deps.currentBranch?.() ?? 'HEAD' }, trigger)
        return
      case 'compareWithWorktree':
        deps.openOverlay({ kind: 'compare', left: entry.name, right: null, leftLabel: entry.name, rightLabel: null }, trigger)
        return
      case 'showInLog':
        deps.showInLog(entry)
        return
      case 'filterLog':
        deps.filterLog(entry)
        return
      case 'pushTag':
      case 'deleteTag':
        deps.openOverlay({ kind: 'tagSheet', mode: id === 'pushTag' ? 'push' : 'delete', name: entry.name }, trigger)
        return
      case 'deleteRemoteBranch':
        deps.openOverlay({ kind: 'remoteBranchDelete', ref: entry.name }, trigger)
        return
      case 'setUpstream':
        deps.openOverlay(entry.upstream === undefined ? { kind: 'upstreamSheet', branch: entry.name } : { kind: 'upstreamSheet', branch: entry.name, upstream: entry.upstream }, trigger)
        return
      case 'unsetUpstream':
        deps.onOutcome(await deps.actions.run('setUpstream', { branch: entry.name, upstream: null }, { trigger }))
        return
      case 'checkoutInWorktree':
        deps.openOverlay({ kind: 'worktreeAdd', branch: entry.name }, trigger)
        return
    }
  }

  return { run, checkout, fetch, control }
}
