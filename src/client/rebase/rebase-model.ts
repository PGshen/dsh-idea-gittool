// Interactive rebase list model (plan b3a T4): pure functions over the rows of the rebase page.
// React-free and RPC-free; the store and the page drive it. Rows are in todo order (oldest first).
// The todo text itself comes from the shared rules the Host executes (src/shared/rebase-todo.ts).
import type { RebaseAction, RebaseEntry, RebasePlanValue } from '../../shared/protocol.ts'
import { buildTodo, rebaseTodoProblem, rootDropBranches } from '../../shared/rebase-todo.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'

/**
 * What a log quick action asks the rebase model to start from (plan b3a T4/T6): the same rows and
 * entries as the full page, with one commit reworded/dropped or a run of commits squashed.
 */
export type RebasePreset =
  | { kind: 'reword'; sha: string }
  | { kind: 'drop'; sha: string }
  | { kind: 'squash'; shas: string[] }

export interface RebaseRow {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
  pushed: boolean
  branches: string[]
  /** Position in the plan (oldest first); a row elsewhere has been moved. */
  originalIndex: number
  action: RebaseAction
  /** The message the row will get (reword, or the final message of its squash group). */
  message: string
  originalMessage: string
  /** The user typed a message; until then a squash group's message follows its members. */
  messageEdited: boolean
}

/** A kept row (pick/reword/edit) and the squash/fixup rows folded into it, by index. */
export interface RebaseGroup {
  head: number
  members: number[]
}

/** Stand-in for a message blob sha in the preview; the page shows it as "write the message back". */
export const MESSAGE_PLACEHOLDER = '<message>'

export function fromPlan(plan: RebasePlanValue, preset?: RebasePreset): RebaseRow[] {
  const rows: RebaseRow[] = plan.commits.map((commit, originalIndex) => ({
    sha: commit.sha,
    shortSha: commit.shortSha,
    subject: commit.subject,
    author: commit.author,
    date: commit.date,
    pushed: commit.pushed,
    branches: commit.branches,
    originalIndex,
    action: 'pick',
    message: commit.message,
    originalMessage: commit.message,
    messageEdited: false,
  }))
  if (preset === undefined) return rows
  if (preset.kind === 'squash') {
    const chosen = new Set(preset.shas)
    let first = true
    return rows.map(row => {
      if (!chosen.has(row.sha)) return row
      if (first) {
        first = false
        return row
      }
      return { ...row, action: 'squash' }
    })
  }
  const action: RebaseAction = preset.kind
  return rows.map(row => (row.sha === preset.sha ? { ...row, action } : row))
}

export function setAction(rows: readonly RebaseRow[], index: number, action: RebaseAction): RebaseRow[] {
  return rows.map((row, at) => (at === index ? { ...row, action } : row))
}

export function setMessage(rows: readonly RebaseRow[], index: number, message: string): RebaseRow[] {
  return rows.map((row, at) => (at === index ? { ...row, message, messageEdited: true } : row))
}

export function move(rows: readonly RebaseRow[], from: number, to: number): RebaseRow[] {
  const next = [...rows]
  const [row] = next.splice(from, 1)
  if (row === undefined) return [...rows]
  next.splice(Math.max(0, Math.min(to, next.length)), 0, row)
  return next
}

export function groups(rows: readonly RebaseRow[]): RebaseGroup[] {
  const result: RebaseGroup[] = []
  let open: RebaseGroup | undefined
  rows.forEach((row, index) => {
    if (row.action === 'squash' || row.action === 'fixup') {
      open?.members.push(index)
    } else if (row.action !== 'drop') {
      open = { head: index, members: [] }
      result.push(open)
    }
  })
  return result
}

/** The group's default message when it has squash members: head + squash messages, fixups left out. */
function defaultSquashMessage(rows: readonly RebaseRow[], group: RebaseGroup): string {
  const parts = [group.head, ...group.members.filter(index => rows[index]?.action === 'squash')]
  return parts.map(index => rows[index]?.originalMessage ?? '').join('\n\n')
}

/** The message the group's head is sent with, or undefined when git keeps the head's own. */
export function groupMessage(rows: readonly RebaseRow[], group: RebaseGroup): string | undefined {
  const head = rows[group.head]
  if (head === undefined || (head.action !== 'pick' && head.action !== 'reword')) return undefined
  const hasSquash = group.members.some(index => rows[index]?.action === 'squash')
  if (head.action !== 'reword' && !hasSquash) return undefined
  if (head.messageEdited) return head.message
  return hasSquash ? defaultSquashMessage(rows, group) : head.originalMessage
}

export function toEntries(rows: readonly RebaseRow[]): RebaseEntry[] {
  const messages = new Map<number, string>()
  for (const group of groups(rows)) {
    const message = groupMessage(rows, group)
    if (message !== undefined) messages.set(group.head, message)
  }
  return rows.map((row, index) => {
    const message = messages.get(index)
    return message === undefined ? { sha: row.sha, action: row.action } : { sha: row.sha, action: row.action, message }
  })
}

/** Index of the first row the rebase rewrites; rows.length when nothing changes. */
function firstRewritten(rows: readonly RebaseRow[]): number {
  const headOf = new Map<number, number>()
  for (const group of groups(rows)) for (const member of group.members) headOf.set(member, group.head)
  let first = rows.length
  toEntries(rows).forEach((entry, index) => {
    const unchanged = rows[index]?.originalIndex === index && entry.action === 'pick' && entry.message === undefined
    if (!unchanged) first = Math.min(first, headOf.get(index) ?? index)
  })
  return first
}

/** Nothing would change: every commit picked in its original place with its own message. */
export function isUnchanged(rows: readonly RebaseRow[]): boolean {
  return firstRewritten(rows) === rows.length
}

/** Whether a commit already on a remote is rewritten (asks for the risk confirmation). */
export function rewritesPushed(rows: readonly RebaseRow[]): boolean {
  return rows.slice(firstRewritten(rows)).some(row => row.pushed)
}

/** Why the list cannot be submitted, or null. */
export function validate(
  plan: RebasePlanValue,
  rows: readonly RebaseRow[],
  options: { confirmPushed: boolean },
): LocalizedText | null {
  const problem = rebaseTodoProblem(plan.commits.map(commit => commit.sha), toEntries(rows))
  if (problem !== null) return text(`rebase.invalid.${problem}`)
  if (isUnchanged(rows)) return text('rebase.invalid.unchanged')
  if (!options.confirmPushed && rewritesPushed(rows)) return text('rebase.invalid.confirmPushed')
  return null
}

/** The todo the Host will run, with {@link MESSAGE_PLACEHOLDER} for message blobs. */
export function previewTodo(plan: RebasePlanValue, rows: readonly RebaseRow[], options: { updateRefs: boolean }): string {
  const branches = new Map(plan.commits.map(commit => [commit.sha, commit.branches]))
  return buildTodo(toEntries(rows), {
    messageBlob: () => MESSAGE_PLACEHOLDER,
    branches: options.updateRefs ? sha => branches.get(sha) ?? [] : undefined,
    root: plan.base === null,
  })
}

/**
 * Branches the rebase leaves on their old commit although `--update-refs` is on: under `--root`, those
 * on the dropped commits before the first kept one (plan t2 T1; the page says so).
 */
export function stayingBranches(plan: RebasePlanValue, rows: readonly RebaseRow[], options: { updateRefs: boolean }): string[] {
  if (!options.updateRefs || plan.base !== null) return []
  const branches = new Map(plan.commits.map(commit => [commit.sha, commit.branches]))
  return [...new Set(rootDropBranches(toEntries(rows), sha => branches.get(sha) ?? []))]
}
