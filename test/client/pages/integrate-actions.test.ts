// A3 T8 submit logic of the integrate forms: what is sent, through which smart-stash kind, and how
// each outcome maps to "close / stay / show an error / switch view".
import { describe, expect, it, vi } from 'vitest'
import {
  backupNotice,
  fetchNotice,
  resetCanSubmit,
  submitCommitOp,
  submitFetch,
  submitMerge,
  submitPull,
  submitRebase,
  submitReset,
  submitResetToRemote,
  submitUpdateProject,
} from '../../../src/client/pages/integrate-actions.ts'
import { text } from '../../../src/client/localized-text.ts'
import { en, zh } from '../../../src/client/locales.ts'
import { statusFixture } from './changes-fixtures.ts'
import type { ActionOutcome } from '../../../src/client/store/action-store.ts'
import type { GitError, ResetPreviewValue } from '../../../src/shared/protocol.ts'

const trigger = { focus() {}, isConnected: true }
const SHA = 'a'.repeat(40)

function failed(code: GitError['code'], details?: Record<string, unknown>): ActionOutcome<unknown> {
  const error: GitError = details === undefined ? { code, message: code } : { code, message: code, details }
  return { kind: 'failed', error, message: text('action.error.fallback', { code, message: code }) }
}
const done = (value: unknown = {}): ActionOutcome<unknown> => ({ kind: 'done', value })

function deps(outcome: ActionOutcome<unknown>) {
  const run = vi.fn(async () => outcome)
  return { run, deps: { actions: { run: run as never }, trigger } }
}

describe('smart operations pass their kind and the click trigger', () => {
  it('merge: flags from the option, smartStash merge', async () => {
    const { run, deps: d } = deps(done())
    const result = await submitMerge(d, { ref: 'feat/x', option: 'noFf' })
    expect(run).toHaveBeenCalledWith('merge', { ref: 'feat/x', noFf: true }, { smartStash: 'merge', trigger })
    expect(result.kind).toBe('closed')
  })
  it('rebase: onto, smartStash rebase', async () => {
    const { run, deps: d } = deps(done())
    await submitRebase(d, 'origin/main')
    expect(run).toHaveBeenCalledWith('rebase', { onto: 'origin/main' }, { smartStash: 'rebase', trigger })
  })
  it('pull: remote, branch and mode, smartStash pull', async () => {
    const { run, deps: d } = deps(done())
    await submitPull(d, { remote: 'origin', branch: 'main', mode: 'rebase' })
    expect(run).toHaveBeenCalledWith('pull', { remote: 'origin', branch: 'main', mode: 'rebase' }, { smartStash: 'pull', trigger })
  })
  it('cherry-pick and revert: sha with their own kinds', async () => {
    const a = deps(done())
    await submitCommitOp(a.deps, 'cherryPick', SHA)
    expect(a.run).toHaveBeenCalledWith('cherryPick', { sha: SHA }, { smartStash: 'cherry-pick', trigger })
    const b = deps(done())
    await submitCommitOp(b.deps, 'revert', SHA)
    expect(b.run).toHaveBeenCalledWith('revertCommit', { sha: SHA }, { smartStash: 'revert', trigger })
  })
})

describe('outcome mapping', () => {
  it('failure stays open with the message; cancel stays open silently; conflict closes (the list takes over)', async () => {
    const f = failed('git/exec-failed')
    const failure = await submitMerge(deps(f).deps, { ref: 'x', option: 'default' })
    expect(failure).toEqual({ kind: 'error', message: (f as { message: unknown }).message })
    expect(await submitMerge(deps({ kind: 'cancelled' }).deps, { ref: 'x', option: 'default' })).toEqual({ kind: 'stay' })
    const conflict: ActionOutcome<unknown> = { kind: 'conflict', error: { code: 'git/conflict', message: 'c' }, details: {} }
    expect((await submitMerge(deps(conflict).deps, { ref: 'x', option: 'default' })).kind).toBe('closed')
  })
})

describe('update project', () => {
  it('sends the mode; stash first ("will stash" note) is the explicit stash: true', async () => {
    const plain = deps(done())
    await submitUpdateProject(plain.deps, { mode: 'merge', stashFirst: false })
    expect(plain.run).toHaveBeenCalledWith('updateProject', { mode: 'merge' }, { smartStash: 'update', trigger })
    const stash = deps(done())
    await submitUpdateProject(stash.deps, { mode: 'rebase', stashFirst: true })
    expect(stash.run).toHaveBeenCalledWith('updateProject', { mode: 'rebase', stash: true }, { smartStash: 'update', trigger })
  })

  it('upstream-rewritten switches the view and carries the local-ahead count', async () => {
    const result = await submitUpdateProject(
      deps(failed('git/upstream-rewritten', { localAhead: 3 })).deps,
      { mode: 'merge', stashFirst: false },
    )
    expect(result).toEqual({ kind: 'rewritten', localAhead: 3 })
  })

  it('reset to remote sends the backup flag and never offers a stash', async () => {
    const { run, deps: d } = deps(done({ head: SHA, backupBranch: 'backup/main-20261025-101500' }))
    const result = await submitResetToRemote(d, true)
    expect(run).toHaveBeenCalledWith('resetToRemote', { backup: true }, { trigger })
    expect(result.kind).toBe('closed')
    const off = deps(done())
    await submitResetToRemote(off.deps, false)
    expect(off.run).toHaveBeenCalledWith('resetToRemote', { backup: false }, { trigger })
  })

  it('carry 2: reset to remote blocked by untracked/ignored files says "move or delete", not "commit or stash"', async () => {
    const status = statusFixture({ unstaged: [{ path: 'src/a.ts', status: 'M' }] })
    const blocked = failed('git/dirty-worktree', { paths: ['build/out.js', 'tmp/cache'], count: 2 })
    const result = await submitResetToRemote(deps(blocked).deps, true, status)
    expect(result).toEqual({ kind: 'error', message: text('integrate.update.resetInTheWay', { count: 2, paths: 'build/out.js, tmp/cache' }) })
    expect(zh['integrate.update.resetInTheWay']).toContain('移走或删除')
    expect(zh['integrate.update.resetInTheWay']).not.toContain('贮藏')
    expect(en['integrate.update.resetInTheWay']).toContain('Move or delete')
  })

  it('carry 2: reset to remote blocked by tracked changes keeps the commit-or-stash wording', async () => {
    const status = statusFixture({ unstaged: [{ path: 'src/a.ts', status: 'M' }] })
    const blocked = failed('git/dirty-worktree', { paths: ['src/a.ts'], count: 1 })
    const result = await submitResetToRemote(deps(blocked).deps, true, status)
    expect(result).toEqual({ kind: 'error', message: text('integrate.update.resetDirty', { count: 1 }) })
  })

  it('fix 1: Host reason untracked-in-the-way → move-or-delete wording without needing the status', async () => {
    const blocked = failed('git/dirty-worktree', { paths: ['out.js'], count: 1, reason: 'untracked-in-the-way' })
    expect(await submitResetToRemote(deps(blocked).deps, true, null)).toEqual({
      kind: 'error', message: text('integrate.update.resetInTheWay', { count: 1, paths: 'out.js' }),
    })
  })

  it('fix 1: no reason and no status snapshot → tracked-changes wording (commit or stash), never move-or-delete', async () => {
    const blocked = failed('git/dirty-worktree', { paths: ['out.js'], count: 1 })
    expect(await submitResetToRemote(deps(blocked).deps, true, null)).toEqual({
      kind: 'error', message: text('integrate.update.resetDirty', { count: 1 }),
    })
    expect(await submitResetToRemote(deps(blocked).deps, true)).toEqual({
      kind: 'error', message: text('integrate.update.resetDirty', { count: 1 }),
    })
  })

  it('fix 1: an empty path list is not rendered as an empty list', async () => {
    const blocked = failed('git/dirty-worktree', { paths: [], count: 3, reason: 'untracked-in-the-way' })
    expect(await submitResetToRemote(deps(blocked).deps, true, null)).toEqual({
      kind: 'error', message: text('integrate.update.resetInTheWayCount', { count: 3 }),
    })
    expect(zh['integrate.update.resetInTheWayCount']).toContain('移走或删除')
    expect(en['integrate.update.resetInTheWayCount']).toContain('Move or delete')
  })

  it('the backup branch name becomes a notice', () => {
    expect(backupNotice(done({ backupBranch: 'backup/main-1' }))).toEqual({
      tone: 'warning', message: text('integrate.notice.backup', { branch: 'backup/main-1' }),
    })
    expect(backupNotice(done({ head: SHA }))).toBeNull()
    expect(backupNotice(failed('git/exec-failed'))).toBeNull()
  })
})

describe('reset', () => {
  const preview: ResetPreviewValue = { head: 'h'.repeat(40), discardCount: 2, commitsLost: [], truncated: false }

  it('needs a loaded preview; hard also needs the risk tick', () => {
    expect(resetCanSubmit({ mode: 'mixed', hardConfirmed: false }, null)).toBe(false)
    expect(resetCanSubmit({ mode: 'mixed', hardConfirmed: false }, preview)).toBe(true)
    expect(resetCanSubmit({ mode: 'soft', hardConfirmed: false }, preview)).toBe(true)
    expect(resetCanSubmit({ mode: 'hard', hardConfirmed: false }, preview)).toBe(false)
    expect(resetCanSubmit({ mode: 'hard', hardConfirmed: true }, preview)).toBe(true)
  })

  it('sends the head the user saw as expectedHead; only hard carries confirmHard', async () => {
    const mixed = deps(done())
    await submitReset(mixed.deps, { sha: SHA, mode: 'mixed', hardConfirmed: true }, preview)
    expect(mixed.run).toHaveBeenCalledWith('reset', { sha: SHA, mode: 'mixed', expectedHead: preview.head }, { trigger })
    const hard = deps(done())
    await submitReset(hard.deps, { sha: SHA, mode: 'hard', hardConfirmed: true }, preview)
    expect(hard.run).toHaveBeenCalledWith('reset', { sha: SHA, mode: 'hard', confirmHard: true, expectedHead: preview.head }, { trigger })
  })

  it('refuses to send hard without the tick', async () => {
    const { run, deps: d } = deps(done())
    expect(await submitReset(d, { sha: SHA, mode: 'hard', hardConfirmed: false }, preview)).toEqual({ kind: 'stay' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a stale head asks the form to reload the preview', async () => {
    const result = await submitReset(
      deps(failed('git/stale-target', { target: 'head' })).deps,
      { sha: SHA, mode: 'hard', hardConfirmed: true },
      preview,
    )
    expect(result).toMatchObject({ kind: 'error', stale: true })
  })
})

describe('fetch', () => {
  it('all remotes sends remote null; a named remote and the prune flag are passed through', async () => {
    const all = deps(done({ updatedRefs: 4 }))
    await submitFetch(all.deps, { remote: null, prune: false })
    expect(all.run).toHaveBeenCalledWith('fetch', { remote: null, prune: false }, { trigger })
    const one = deps(done())
    await submitFetch(one.deps, { remote: 'origin', prune: true })
    expect(one.run).toHaveBeenCalledWith('fetch', { remote: 'origin', prune: true }, { trigger })
  })

  it('the result tells how many refs were updated', () => {
    expect(fetchNotice({ updatedRefs: 4 })).toEqual(text('integrate.fetch.updated', { count: 4 }))
    expect(fetchNotice({ updatedRefs: 0 })).toEqual(text('integrate.fetch.upToDate'))
    expect(fetchNotice({})).toEqual(text('integrate.fetch.done'))
  })
})
