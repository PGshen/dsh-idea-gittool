// A3 T7 branch actions: availability matrix, quick actions + search, the action runner
// (checkout / smart checkout trigger rule / sheets / overlays), name validation and notices.
import { describe, expect, it, vi } from 'vitest'
import type { BranchEntry, CheckoutTarget, GitError } from '../../../src/shared/protocol.ts'
import {
  branchActionContext,
  branchActions,
  checkoutTargetOf,
  createBranchActionRunner,
  doubleClickAction,
  matchesQuery,
  outcomeNotice,
  quickActions,
  validateBranchName,
} from '../../../src/client/pages/branch-actions.ts'
import type { BranchActionContext, BranchActionId, BranchActionRunnerDeps } from '../../../src/client/pages/branch-actions.ts'
import type { ActionOutcome } from '../../../src/client/store/action-store.ts'
import type { WorkbenchOverlay } from '../../../src/client/pages/workbench-overlay.ts'
import { text } from '../../../src/client/localized-text.ts'
import { branchesFixture } from './branch-fixtures.ts'

const fixture = branchesFixture()
function pick(list: BranchEntry[], name: string): BranchEntry {
  const found = list.find(entry => entry.name === name)
  if (found === undefined) throw new Error(`fixture missing ${name}`)
  return found
}
const main = pick(fixture.local, 'main')
const login = pick(fixture.local, 'feat/login')
const ui = pick(fixture.local, 'feat/ui') // has upstream origin/feat/ui
const remote = fixture.remote[0] as BranchEntry
const tag = fixture.tags[0] as BranchEntry

function ctx(overrides: Partial<BranchActionContext> = {}): BranchActionContext {
  return { writable: true, operation: null, current: 'main', dirty: false, ...overrides }
}
const ids = (items: { id: BranchActionId }[]): BranchActionId[] => items.map(item => item.id)

describe('branchActions availability matrix', () => {
  it('non-current local branch offers the full local menu, all enabled', () => {
    const items = branchActions(login, ctx())
    expect(ids(items)).toEqual([
      'checkout', 'newFrom', 'merge', 'rebaseOnto', 'rename', 'delete', 'copyName', 'copyRef', 'filterLog', 'showInLog',
    ])
    expect(items.filter(item => item.disabledReason !== undefined)).toEqual([])
    expect(items.find(item => item.id === 'delete')?.danger).toBe(true)
  })

  it('local branch with an upstream also offers pull', () => {
    expect(ids(branchActions(ui, ctx()))).toContain('pull')
    expect(ids(branchActions(login, ctx()))).not.toContain('pull')
  })

  it('current branch: push is offered, checkout/merge/rebase/delete are disabled with a reason', () => {
    const items = branchActions(main, ctx())
    expect(ids(items)).toContain('push')
    const byId = Object.fromEntries(items.map(item => [item.id, item]))
    expect(byId['checkout']?.disabledReason).toEqual(text('branch.disabled.isCurrent'))
    expect(byId['merge']?.disabledReason).toEqual(text('branch.disabled.isCurrent'))
    expect(byId['rebaseOnto']?.disabledReason).toEqual(text('branch.disabled.isCurrent'))
    expect(byId['delete']?.disabledReason).toEqual(text('branch.disabled.deleteCurrent'))
    expect(byId['rename']?.disabledReason).toBeUndefined()
    expect(byId['push']?.disabledReason).toBeUndefined()
  })

  it('push is only offered for the current branch', () => {
    expect(ids(branchActions(login, ctx()))).not.toContain('push')
    expect(ids(branchActions(remote, ctx()))).not.toContain('push')
  })

  it('remote branch: no rename/delete/push at all (hidden, not disabled); pull is offered', () => {
    const list = ids(branchActions(remote, ctx()))
    expect(list).toEqual(['checkout', 'newFrom', 'merge', 'rebaseOnto', 'pull', 'copyName', 'copyRef', 'filterLog', 'showInLog'])
  })

  it('tag: checkout (detached label), new branch from tag, copy, show in log only', () => {
    const items = branchActions(tag, ctx())
    expect(ids(items)).toEqual(['checkout', 'newFrom', 'copyName', 'copyRef', 'showInLog'])
    expect(items[0]?.label).toEqual(text('branch.action.checkoutTag'))
    expect(items[1]?.label).toEqual(text('branch.action.newFromTag'))
  })

  it('read-only: every write item is disabled, copy and show-in-log stay enabled', () => {
    const items = branchActions(login, ctx({ writable: false }))
    for (const item of items) {
      if (['copyName', 'copyRef', 'showInLog', 'filterLog'].includes(item.id)) expect(item.disabledReason, item.id).toBeUndefined()
      else expect(item.disabledReason, item.id).toEqual(text('branch.disabled.readOnly'))
    }
  })

  it('operation in progress: write items are disabled with the operation reason', () => {
    const items = branchActions(login, ctx({ operation: 'rebase' }))
    expect(items.find(item => item.id === 'checkout')?.disabledReason).toEqual(text('branch.disabled.operation'))
    expect(items.find(item => item.id === 'delete')?.disabledReason).toEqual(text('branch.disabled.operation'))
    expect(items.find(item => item.id === 'copyName')?.disabledReason).toBeUndefined()
  })

  it('detached HEAD: pull has no current branch to pull into; merge/rebase still work', () => {
    const items = branchActions(remote, ctx({ current: null }))
    expect(items.find(item => item.id === 'pull')?.disabledReason).toEqual(text('branch.disabled.detached'))
    expect(items.find(item => item.id === 'merge')?.disabledReason).toBeUndefined()
  })

  it('assigns sections so the menu can draw separators', () => {
    const sections = branchActions(login, ctx()).map(item => item.section)
    expect(sections).toEqual([...sections].sort((a, b) => a - b))
    expect(new Set(sections).size).toBeGreaterThan(2)
  })

  it('double click maps to checkout only when it is enabled', () => {
    expect(doubleClickAction(login, ctx())).toBe('checkout')
    expect(doubleClickAction(main, ctx())).toBeNull()
    expect(doubleClickAction(login, ctx({ writable: false }))).toBeNull()
    expect(doubleClickAction(login, ctx({ operation: 'merge' }))).toBeNull()
  })

  it('checkoutTargetOf maps entry kinds', () => {
    expect(checkoutTargetOf(login)).toEqual({ kind: 'local', name: 'feat/login' })
    expect(checkoutTargetOf(remote)).toEqual({ kind: 'remote', name: remote.name })
    expect(checkoutTargetOf(tag)).toEqual({ kind: 'tag', name: tag.name })
  })
})

describe('quickActions and search', () => {
  it('idle repository: update, commit, push, new branch, checkout revision (no continue/abort)', () => {
    expect(quickActions(ctx()).map(item => item.id)).toEqual(['update', 'commit', 'push', 'newBranch', 'checkoutRevision'])
  })

  it('operation in progress adds continue/abort and disables the rest except commit', () => {
    const items = quickActions(ctx({ operation: 'merge' }))
    expect(items.map(item => item.id)).toEqual(['update', 'commit', 'push', 'continue', 'abort', 'newBranch', 'checkoutRevision'])
    expect(items.find(item => item.id === 'continue')?.disabledReason).toBeUndefined()
    expect(items.find(item => item.id === 'update')?.disabledReason).toEqual(text('branch.disabled.operation'))
    expect(items.find(item => item.id === 'commit')?.disabledReason).toBeUndefined()
  })

  it('read-only disables writes; commit (a page switch) stays enabled; push needs a branch', () => {
    const items = quickActions(ctx({ writable: false }))
    expect(items.find(item => item.id === 'update')?.disabledReason).toEqual(text('branch.disabled.readOnly'))
    expect(items.find(item => item.id === 'commit')?.disabledReason).toBeUndefined()
    const detached = quickActions(ctx({ current: null }))
    expect(detached.find(item => item.id === 'push')?.disabledReason).toEqual(text('branch.disabled.detached'))
  })

  it('matchesQuery is a case-insensitive contains; blank matches everything', () => {
    expect(matchesQuery('Push…', 'pu')).toBe(true)
    expect(matchesQuery('feat/login', 'LOG')).toBe(true)
    expect(matchesQuery('feat/login', 'zzz')).toBe(false)
    expect(matchesQuery('anything', '  ')).toBe(true)
  })
})

describe('validateBranchName', () => {
  it('accepts normal names and slashes', () => {
    expect(validateBranchName('feat/new-ui_2')).toBeNull()
    expect(validateBranchName('release-1.2')).toBeNull()
  })
  it('blank is not an error (the submit button is simply disabled)', () => {
    expect(validateBranchName('')).toBeNull()
    expect(validateBranchName('   ')).toBeNull()
  })
  it('rejects illegal characters', () => {
    for (const name of ['a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\tb']) {
      expect(validateBranchName(name), name).toEqual(text('branch.sheet.name.invalidChars'))
    }
  })
  it('rejects illegal shapes', () => {
    for (const name of ['-x', '/x', 'x/', 'x.', 'x.lock', 'a..b', 'a//b', 'a@{b', '@', '.hidden', 'a/.b']) {
      expect(validateBranchName(name), name).toEqual(text('branch.sheet.name.invalidShape'))
    }
  })
})

describe('outcomeNotice', () => {
  it('failed → error notice with the localized message', () => {
    const message = text('action.error.nothing-to-stash')
    const outcome: ActionOutcome<unknown> = { kind: 'failed', error: { code: 'git/invalid-payload', message: 'x' }, message }
    expect(outcomeNotice(outcome)).toEqual({ tone: 'error', message })
  })
  it('done with a kept stash → warning; plain done / cancelled / conflict → none', () => {
    expect(outcomeNotice({ kind: 'done', value: { stashKept: true } })).toEqual({ tone: 'warning', message: text('notice.stashKept'), action: 'goStash' })
    expect(outcomeNotice({ kind: 'done', value: { stashRestored: true } })).toBeNull()
    expect(outcomeNotice({ kind: 'cancelled' })).toBeNull()
    const error: GitError = { code: 'git/conflict', message: 'c' }
    expect(outcomeNotice({ kind: 'conflict', error, details: { operation: 'merge' } as never })).toBeNull()
  })
})

function makeRunner(runImpl: (endpoint: string, payload: unknown, options: unknown) => Promise<ActionOutcome<unknown>>) {
  const run = vi.fn(runImpl)
  const opened: { overlay: WorkbenchOverlay; trigger: unknown }[] = []
  const deps: BranchActionRunnerDeps = {
    actions: { run: run as never },
    openOverlay: (overlay, trigger) => { opened.push({ overlay, trigger }) },
    copy: vi.fn(),
    showInLog: vi.fn(),
    filterLog: vi.fn(),
    openPush: vi.fn(),
    onOutcome: vi.fn(),
  }
  return { runner: createBranchActionRunner(deps), run, opened, deps }
}
const trigger = { focus() {}, isConnected: true }

describe('createBranchActionRunner', () => {
  it('checkout sends mode normal with the click-time trigger, never asks about a dirty tree first', async () => {
    const { runner, run, opened } = makeRunner(async () => ({ kind: 'done', value: { branch: 'feat/login', detached: false, head: 'x' } }))
    await runner.run('checkout', login, trigger)
    expect(run).toHaveBeenCalledWith('checkout', { target: { kind: 'local', name: 'feat/login' }, mode: 'normal' }, { trigger })
    expect(opened).toEqual([])
  })

  it('opens smartCheckout only on git/would-overwrite, carrying target + paths', async () => {
    const error: GitError = { code: 'git/would-overwrite', message: 'x', details: { paths: ['a.ts', 'b.ts'] } }
    const { runner, opened, deps } = makeRunner(async () => ({ kind: 'failed', error, message: text('action.error.fallback') }))
    await runner.run('checkout', login, trigger)
    expect(opened).toEqual([{
      overlay: { kind: 'smartCheckout', target: { kind: 'local', name: 'feat/login' } satisfies CheckoutTarget, paths: ['a.ts', 'b.ts'] },
      trigger,
    }])
    expect(deps.onOutcome).not.toHaveBeenCalled()
  })

  it('other checkout failures go to the notice instead of the smart sheet', async () => {
    const error: GitError = { code: 'git/exec-failed', message: 'boom' }
    const { runner, opened, deps } = makeRunner(async () => ({ kind: 'failed', error, message: text('action.error.fallback') }))
    await runner.run('checkout', login, trigger)
    expect(opened).toEqual([])
    expect(deps.onOutcome).toHaveBeenCalledTimes(1)
  })

  it('reports successful outcomes too (stash kept notice)', async () => {
    const { runner, deps } = makeRunner(async () => ({ kind: 'done', value: { stashKept: true } }))
    await runner.run('checkout', login, trigger)
    expect(deps.onOutcome).toHaveBeenCalledWith({ kind: 'done', value: { stashKept: true } })
  })

  it('sheet actions open the branchSheet overlay with what they need', async () => {
    const { runner, opened } = makeRunner(async () => ({ kind: 'cancelled' }))
    await runner.run('newFrom', login, trigger)
    await runner.run('rename', login, trigger)
    await runner.run('delete', login, trigger)
    expect(opened.map(item => item.overlay)).toEqual([
      { kind: 'branchSheet', mode: 'new', startPoint: 'feat/login' },
      { kind: 'branchSheet', mode: 'rename', branch: 'feat/login' },
      { kind: 'branchSheet', mode: 'delete', branch: 'feat/login', sha: login.sha },
    ])
    expect(opened.every(item => item.trigger === trigger)).toBe(true)
  })

  it('integration actions open their overlays prefilled', async () => {
    const { runner, opened } = makeRunner(async () => ({ kind: 'cancelled' }))
    await runner.run('merge', login, trigger)
    await runner.run('rebaseOnto', login, trigger)
    await runner.run('pull', remote, trigger)
    await runner.run('pull', ui, trigger)
    expect(opened.map(item => item.overlay)).toEqual([
      { kind: 'merge', ref: 'feat/login' },
      { kind: 'rebase', onto: 'feat/login' },
      { kind: 'pull', remote: 'origin', branch: remote.name.slice('origin/'.length) },
      { kind: 'pull', remote: 'origin', branch: 'feat/ui' },
    ])
  })

  it('copy / log / push go to their callbacks', async () => {
    const { runner, deps } = makeRunner(async () => ({ kind: 'cancelled' }))
    await runner.run('copyName', login, trigger)
    await runner.run('copyRef', login, trigger)
    await runner.run('showInLog', login, trigger)
    await runner.run('filterLog', login, trigger)
    await runner.run('push', main, trigger)
    expect(deps.copy).toHaveBeenNthCalledWith(1, 'feat/login')
    expect(deps.copy).toHaveBeenNthCalledWith(2, 'refs/heads/feat/login')
    expect(deps.showInLog).toHaveBeenCalledWith(login)
    expect(deps.filterLog).toHaveBeenCalledWith(login)
    expect(deps.openPush).toHaveBeenCalledTimes(1)
  })

  it('quick actions: fetch / continue / abort go through the action store', async () => {
    const { runner, run } = makeRunner(async () => ({ kind: 'done', value: {} }))
    await runner.fetch(trigger)
    await runner.control('continue', trigger)
    await runner.control('abort', trigger)
    expect(run).toHaveBeenNthCalledWith(1, 'fetch', { remote: null, prune: false }, { trigger })
    expect(run).toHaveBeenNthCalledWith(2, 'operationControl', { action: 'continue' }, { trigger })
    expect(run).toHaveBeenNthCalledWith(3, 'operationControl', { action: 'abort' }, { trigger })
  })
})

describe('branchActionContext', () => {
  const clean = { branch: 'main', detached: false, operation: null, staged: [], unstaged: [], untracked: [], conflicts: [] }

  it('derives writable / operation / current / dirty from status and the write policy', () => {
    const status = { ...clean, operation: 'merge', unstaged: [{ path: 'a', status: 'M' }] } as never
    expect(branchActionContext(status, { mode: 'read-write' })).toEqual({ writable: true, operation: 'merge', current: 'main', dirty: true })
  })

  it('read-only policy, missing status and detached HEAD', () => {
    expect(branchActionContext(null, { mode: 'read-only', reason: 'x' })).toEqual({ writable: false, operation: null, current: null, dirty: false })
    expect(branchActionContext({ ...clean, branch: null, detached: true } as never, { mode: 'read-write' }).current).toBeNull()
  })
})
