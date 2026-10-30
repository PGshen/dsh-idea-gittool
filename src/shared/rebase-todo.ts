// Interactive rebase todo rules (plan b3a T3), shared on purpose: the Host executes exactly the todo
// the rebase page previews. Pure functions over protocol types only (ARCHITECTURE R3).
//
// A group is a pick/reword/edit entry plus the squash/fixup entries that fold into it; drop entries
// stay where they are and belong to the group that is open at that point. A group's final message
// (reword, or a message on the group's head) is written back by one `exec` line after the group:
// the message itself is a blob, so only hex reaches the shell (references/git-behavior §4).
import type { RebaseEntry } from './protocol.ts'

/** Why a list of entries cannot be executed; the client maps each to its own copy. */
export type RebaseTodoProblem = 'not-permutation' | 'leading-squash' | 'missing-message' | 'misplaced-message'

/** The exec line that writes a stored message blob back onto HEAD (keeps author and author date). */
export function messageExecLine(blob: string): string {
  return `exec git cat-file blob ${blob} | git commit --amend --no-verify --allow-empty -F -`
}

/** First problem of `entries` against the planned shas, or null when they can run. */
export function rebaseTodoProblem(planShas: readonly string[], entries: readonly RebaseEntry[]): RebaseTodoProblem | null {
  const planned = new Set(planShas)
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!planned.has(entry.sha) || seen.has(entry.sha)) return 'not-permutation'
    seen.add(entry.sha)
  }
  if (seen.size !== planned.size) return 'not-permutation'

  let headOpen = false
  for (const entry of entries) {
    if (entry.action === 'squash' || entry.action === 'fixup') {
      if (!headOpen) return 'leading-squash'
    } else if (entry.action !== 'drop') {
      headOpen = true
    }
    if (entry.message !== undefined && entry.action !== 'pick' && entry.action !== 'reword') return 'misplaced-message'
    if (entry.action === 'reword' && (entry.message === undefined || entry.message.trim() === '')) return 'missing-message'
  }
  return null
}

export interface BuildTodoOptions {
  /** Blob sha holding the message of the entry at `index` (the page passes a placeholder). */
  messageBlob: (index: number) => string
  /** Other local branches on a commit; given only when `--update-refs` is requested. */
  branches?: ((sha: string) => readonly string[]) | undefined
  /**
   * The rebase runs with `--root` (no base). Branches on drops before the first kept commit then get
   * no update-ref line: git would move them onto its internal empty root commit (empty tree, no
   * message, no parent), so they stay on their old commit instead (plan t2 T1, git 2.50.1).
   */
  root?: boolean | undefined
}

/** Branches on the drops before the first kept commit: under `--root` they stay where they are. */
export function rootDropBranches(entries: readonly RebaseEntry[], branches: (sha: string) => readonly string[]): string[] {
  const result: string[] = []
  for (const entry of entries) {
    if (entry.action !== 'drop') break
    result.push(...branches(entry.sha))
  }
  return result
}

/** The todo text for valid entries (see {@link rebaseTodoProblem}); ends with a newline. */
export function buildTodo(entries: readonly RebaseEntry[], options: BuildTodoOptions): string {
  const lines: string[] = []
  let group: { messageIndex: number | undefined; refs: string[] } | undefined

  const closeGroup = (): void => {
    if (group === undefined) return
    if (group.messageIndex !== undefined) lines.push(messageExecLine(options.messageBlob(group.messageIndex)))
    for (const ref of group.refs) lines.push(`update-ref refs/heads/${ref}`)
    group = undefined
  }
  const refsOf = (sha: string): readonly string[] => options.branches?.(sha) ?? []

  entries.forEach((entry, index) => {
    switch (entry.action) {
      case 'pick':
      case 'reword':
      case 'edit':
        closeGroup()
        group = { messageIndex: entry.message === undefined ? undefined : index, refs: [...refsOf(entry.sha)] }
        lines.push(`${entry.action === 'edit' ? 'edit' : 'pick'} ${entry.sha}`)
        break
      case 'squash':
      case 'fixup':
        // With a final message for the group, squash messages are not needed: fold silently.
        lines.push(`${entry.action === 'squash' && group?.messageIndex === undefined ? 'squash' : 'fixup'} ${entry.sha}`)
        group?.refs.push(...refsOf(entry.sha))
        break
      case 'drop':
        lines.push(`drop ${entry.sha}`)
        if (group !== undefined) group.refs.push(...refsOf(entry.sha))
        else if (options.root !== true) for (const ref of refsOf(entry.sha)) lines.push(`update-ref refs/heads/${ref}`)
        break
    }
  })
  closeGroup()
  return `${lines.join('\n')}\n`
}
