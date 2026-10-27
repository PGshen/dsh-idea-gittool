// T6 push-store: form defaults + memory, risk gating, request de-duplication, rejection flow,
// auto-retry exactly once, conflict / auth outcomes, rollback store, Esc helpers.
import { describe, expect, it, vi } from 'vitest'
import { interpolate } from '../../../src/client/localized-text.ts'
import type {
  CommitSummary,
  GitError,
  PullForPushRequest,
  PushPreviewValue,
  PushRejectedDetails,
  PushRequest,
  RollbackRequest,
  RpcResult,
} from '../../../src/shared/protocol.ts'
import { WRITE_PATHS_MAX } from '../../../src/shared/protocol.ts'
import {
  createPushStore,
  createRollbackStore,
  defaultPushForm,
  parseRejectedDetails,
  PUSH_MEMORY_PREFIX,
  pushEscapeAction,
  pushSubmitBlock,
  rejectChoicesFor,
  rejectedSubmitBlock,
  rollbackCounts,
  rollbackEscapeAction,
  rollbackSkipped,
  rollbackSubmitBlock,
} from '../../../src/client/store/push-store.ts'
import type { KeyValueStorage, PushClient, RollbackClient } from '../../../src/client/store/push-store.ts'

function commit(sha: string, subject: string): CommitSummary {
  return { sha, shortSha: sha.slice(0, 7), parents: [], author: 'Ann', email: 'a@x', date: '2026-10-26T00:00:00Z', subject }
}

function preview(overrides: Partial<PushPreviewValue> = {}): PushPreviewValue {
  return {
    remotes: ['origin', 'upstream'],
    branch: 'feat/login',
    detached: false,
    upstream: 'origin/feat/login',
    defaultRemote: 'origin',
    commits: [commit('a1b2c3d4e5', 'feat: login')],
    truncated: false,
    ...overrides,
  }
}

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: key => data[key] ?? null,
    setItem: (key, value) => { data[key] = value },
  }
}

const throwingStorage: KeyValueStorage = {
  getItem: () => { throw new Error('denied') },
  setItem: () => { throw new Error('denied') },
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail(code: GitError['code'], message: string = code,details?: Record<string, unknown>): RpcResult<never> {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }
}

function rejection(overrides: Partial<PushRejectedDetails> = {}): PushRejectedDetails {
  return {
    reason: 'non-fast-forward',
    remote: 'origin',
    branch: 'feat/login',
    remoteCommits: [commit('f00dbabe11', 'fix: remote change')],
    summary: '[rejected] (non-fast-forward)',
    ...overrides,
  }
}

function fakeClient(overrides: Partial<PushClient> = {}): PushClient & {
  pushPreview: ReturnType<typeof vi.fn>
  push: ReturnType<typeof vi.fn>
  pullForPush: ReturnType<typeof vi.fn>
} {
  return {
    pushPreview: vi.fn(async () => ok(preview())),
    push: vi.fn(async (request: PushRequest) => ok({ remote: request.remote, branch: request.branch, updated: true })),
    pullForPush: vi.fn(async () => ok({ head: 'abc' })),
    ...overrides,
  } as never
}

function sequentialIds(): () => string {
  let next = 0
  return () => `req-${++next}`
}

async function loadedStore(options: { client?: PushClient; storage?: KeyValueStorage | null; value?: PushPreviewValue } = {}) {
  const client = options.client ?? fakeClient({ pushPreview: vi.fn(async () => ok(options.value ?? preview())) })
  const store = createPushStore({
    client,
    sessionId: 's1',
    repoRoot: '/repo',
    storage: options.storage === undefined ? memoryStorage() : options.storage,
    newRequestId: sequentialIds(),
  })
  await store.load()
  return { store, client }
}

describe('interpolate', () => {
  it('replaces {name} placeholders and leaves unknown ones', () => {
    expect(interpolate('删除 {count} 个文件 {x}', { count: 3 })).toBe('删除 3 个文件 {x}')
  })
})

describe('defaultPushForm', () => {
  it('uses the upstream remote and branch when an upstream exists', () => {
    const form = defaultPushForm(preview(), null)
    expect(form).toEqual({
      remote: 'origin',
      branch: 'feat/login',
      setUpstream: false,
      forceWithLease: false,
      riskConfirmed: false,
      tags: false,
    })
  })

  it('matches the longest remote name when splitting the upstream', () => {
    const form = defaultPushForm(preview({ remotes: ['origin', 'origin/mirror'], upstream: 'origin/mirror/main' }), null)
    expect(form.remote).toBe('origin/mirror')
    expect(form.branch).toBe('main')
  })

  it('without upstream: default remote, same branch name, set upstream ticked', () => {
    const form = defaultPushForm(preview({ upstream: null }), null)
    expect(form.remote).toBe('origin')
    expect(form.branch).toBe('feat/login')
    expect(form.setUpstream).toBe(true)
  })

  it('without upstream: remembered remote/branch win for the same local branch', () => {
    const form = defaultPushForm(preview({ upstream: null }), { remote: 'upstream', branch: 'login', localBranch: 'feat/login' })
    expect(form.remote).toBe('upstream')
    expect(form.branch).toBe('login')
  })

  it('ignores a remembered branch from another local branch and a remote that no longer exists', () => {
    const form = defaultPushForm(preview({ upstream: null }), { remote: 'gone', branch: 'other', localBranch: 'main' })
    expect(form.remote).toBe('origin')
    expect(form.branch).toBe('feat/login')
  })

  it('detached HEAD never pre-fills the remote branch', () => {
    const form = defaultPushForm(
      preview({ branch: null, detached: true, upstream: null }),
      { remote: 'origin', branch: 'main', localBranch: null },
    )
    expect(form.branch).toBe('')
    expect(form.setUpstream).toBe(false)
  })

  it('no remotes → empty remote', () => {
    expect(defaultPushForm(preview({ remotes: [], defaultRemote: null, upstream: null }), null).remote).toBe('')
  })
})

describe('createPushStore: load and memory', () => {
  it('loads the preview and fills the form', async () => {
    const { store, client } = await loadedStore()
    expect(client.pushPreview).toHaveBeenCalledWith('s1', expect.anything())
    const state = store.getState()
    expect(state.previewStatus).toBe('ready')
    expect(state.preview?.commits).toHaveLength(1)
    expect(state.form.remote).toBe('origin')
  })

  it('reads the remembered remote/branch per repo', async () => {
    const storage = memoryStorage({
      [`${PUSH_MEMORY_PREFIX}/repo`]: JSON.stringify({ remote: 'upstream', branch: 'x', localBranch: 'feat/login' }),
    })
    const { store } = await loadedStore({ storage, value: preview({ upstream: null }) })
    expect(store.getState().form).toMatchObject({ remote: 'upstream', branch: 'x' })
  })

  it('remembers remote/branch after a successful push but never the risk tick', async () => {
    const storage = memoryStorage()
    const { store } = await loadedStore({ storage, value: preview({ upstream: null }) })
    store.updateForm({ remote: 'upstream', branch: 'login', forceWithLease: true, riskConfirmed: true })
    const outcome = await store.submit()
    expect(outcome.kind).toBe('pushed')
    const saved = JSON.parse(storage.data[`${PUSH_MEMORY_PREFIX}/repo`] ?? '{}') as Record<string, unknown>
    expect(saved).toEqual({ remote: 'upstream', branch: 'login', localBranch: 'feat/login' })
    expect(JSON.stringify(saved)).not.toContain('risk')
    expect(JSON.stringify(saved)).not.toContain('force')
  })

  it('a throwing storage is tolerated on read and write', async () => {
    const { store } = await loadedStore({ storage: throwingStorage })
    expect(store.getState().previewStatus).toBe('ready')
    expect((await store.submit()).kind).toBe('pushed')
  })

  it('corrupt memory JSON falls back to defaults', async () => {
    const storage = memoryStorage({ [`${PUSH_MEMORY_PREFIX}/repo`]: '{oops' })
    const { store } = await loadedStore({ storage, value: preview({ upstream: null }) })
    expect(store.getState().form.remote).toBe('origin')
  })

  it('preview failure is reported', async () => {
    const client = fakeClient({ pushPreview: vi.fn(async () => fail('git/exec-failed', 'boom')) })
    const { store } = await loadedStore({ client })
    expect(store.getState().previewStatus).toBe('error')
    expect(store.getState().previewError?.message).toBe('boom')
  })
})

describe('risk gating', () => {
  it('force-with-lease blocks submit until the risk tick', async () => {
    const { store, client } = await loadedStore()
    store.updateForm({ forceWithLease: true })
    expect(pushSubmitBlock(store.getState())).toBe('risk-unconfirmed')
    expect((await store.submit()).kind).toBe('blocked')
    expect(client.push).not.toHaveBeenCalled()
    store.updateForm({ riskConfirmed: true })
    expect(pushSubmitBlock(store.getState())).toBeNull()
    await store.submit()
    expect(client.push).toHaveBeenCalledWith(expect.objectContaining({ forceWithLease: true }))
  })

  it('unticking force-with-lease also clears the risk tick', async () => {
    const { store } = await loadedStore()
    store.updateForm({ forceWithLease: true, riskConfirmed: true })
    store.updateForm({ forceWithLease: false })
    expect(store.getState().form.riskConfirmed).toBe(false)
  })

  it('detached HEAD requires an explicit remote branch', async () => {
    const { store, client } = await loadedStore({ value: preview({ branch: null, detached: true, upstream: null }) })
    expect(pushSubmitBlock(store.getState())).toBe('detached-branch')
    expect((await store.submit()).kind).toBe('blocked')
    expect(client.push).not.toHaveBeenCalled()
    store.updateForm({ branch: '  release  ' })
    await store.submit()
    expect(client.push).toHaveBeenCalledWith(expect.objectContaining({ branch: 'release' }))
  })

  it('blocks without a remote or while loading', async () => {
    const { store } = await loadedStore({ value: preview({ remotes: [], defaultRemote: null, upstream: null }) })
    expect(pushSubmitBlock(store.getState())).toBe('no-remote')
    const pending = createPushStore({ client: fakeClient(), sessionId: 's1', repoRoot: '/r', storage: null })
    expect(pushSubmitBlock(pending.getState())).toBe('loading')
  })

  it('empty branch on an attached HEAD reports no-branch', async () => {
    const { store } = await loadedStore()
    store.updateForm({ branch: ' ' })
    expect(pushSubmitBlock(store.getState())).toBe('no-branch')
  })
})

describe('submit', () => {
  it('sends one request per action and de-duplicates a double click', async () => {
    let resolve: (value: RpcResult<{ remote: string; branch: string; updated: boolean }>) => void = () => undefined
    const client = fakeClient({ push: vi.fn(() => new Promise(r => { resolve = r })) as never })
    const { store } = await loadedStore({ client })
    const first = store.submit()
    const second = store.submit()
    expect(store.getState().busy).toBe('push')
    expect(pushSubmitBlock(store.getState())).toBe('busy')
    resolve(ok({ remote: 'origin', branch: 'feat/login', updated: true }))
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(client.push).toHaveBeenCalledTimes(1)
    expect(client.push).toHaveBeenCalledWith({
      sessionId: 's1',
      requestId: 'req-1',
      remote: 'origin',
      branch: 'feat/login',
      setUpstream: false,
      forceWithLease: false,
      tags: false,
    })
    expect(store.getState().busy).toBeNull()
  })

  it('a later click is a new action with a new requestId', async () => {
    const client = fakeClient({ push: vi.fn(async () => fail('git/exec-failed')) })
    const { store } = await loadedStore({ client })
    await store.submit()
    await store.submit()
    const ids = client.push.mock.calls.map(call => (call[0] as PushRequest).requestId)
    expect(ids).toEqual(['req-1', 'req-2'])
  })

  it('auth-required keeps the page with the error (command in details)', async () => {
    const client = fakeClient({ push: vi.fn(async () => fail('git/auth-required', 'auth', { command: 'git push origin feat/login' })) })
    const { store } = await loadedStore({ client })
    const outcome = await store.submit()
    expect(outcome.kind).toBe('failed')
    expect(store.getState().view).toBe('push')
    expect(store.getState().error?.details).toEqual({ command: 'git push origin feat/login' })
  })

  it('git/rejected switches to the rejected view with rebase as default choice', async () => {
    const client = fakeClient({ push: vi.fn(async () => fail('git/rejected', 'rejected', { ...rejection() })) })
    const { store } = await loadedStore({ client })
    const outcome = await store.submit()
    expect(outcome.kind).toBe('rejected')
    const state = store.getState()
    expect(state.view).toBe('rejected')
    expect(state.rejected?.reason).toBe('non-fast-forward')
    expect(state.rejectedFromPush).toBe(true)
    expect(state.choice).toBe('rebase')
    expect(state.choiceRiskConfirmed).toBe(false)
  })
})

describe('parseRejectedDetails / rejectChoicesFor', () => {
  it('falls back to reason other when details are malformed', () => {
    const details = parseRejectedDetails({ code: 'git/rejected', message: 'nope', details: { reason: 'weird' } }, { remote: 'origin', branch: 'main' })
    expect(details).toEqual({ reason: 'other', remote: 'origin', branch: 'main', remoteCommits: [], summary: 'nope' })
  })

  it('TD-10: keeps a well-formed remoteSha, drops a malformed one', () => {
    const sha = 'a'.repeat(40)
    const base = { reason: 'non-fast-forward', remote: 'origin', branch: 'main', remoteCommits: [], summary: 's' }
    expect(parseRejectedDetails({ code: 'git/rejected', message: 'x', details: { ...base, remoteSha: sha } }, { remote: 'o', branch: 'b' }).remoteSha).toBe(sha)
    expect(parseRejectedDetails({ code: 'git/rejected', message: 'x', details: { ...base, remoteSha: '--force' } }, { remote: 'o', branch: 'b' })).not.toHaveProperty('remoteSha')
    expect(parseRejectedDetails({ code: 'git/rejected', message: 'x', details: base }, { remote: 'o', branch: 'b' })).not.toHaveProperty('remoteSha')
  })

  it('protected branches never offer force-with-lease', () => {
    expect(rejectChoicesFor('protected')).toEqual(['rebase', 'merge'])
    expect(rejectChoicesFor('non-fast-forward')).toEqual(['rebase', 'merge', 'force'])
    expect(rejectChoicesFor('stale-lease')).toEqual(['rebase', 'merge', 'force'])
  })
})

describe('rejected flow', () => {
  function rejectedStore(pushResults: Array<RpcResult<unknown>>, pull: RpcResult<unknown> = ok({ head: 'h' }), details = rejection()) {
    const queue = [...pushResults]
    const client = fakeClient({
      push: vi.fn(async () => queue.shift() ?? ok({ remote: 'origin', branch: 'feat/login', updated: true })) as never,
      pullForPush: vi.fn(async () => pull) as never,
    })
    const store = createPushStore({
      client,
      sessionId: 's1',
      repoRoot: '/repo',
      storage: memoryStorage(),
      newRequestId: sequentialIds(),
      initialRejection: details,
    })
    return { store, client }
  }

  it('opened directly from a rejection: rejected view, Esc closes', () => {
    const { store } = rejectedStore([])
    const state = store.getState()
    expect(state.view).toBe('rejected')
    expect(state.rejectedFromPush).toBe(false)
    expect(state.form).toMatchObject({ remote: 'origin', branch: 'feat/login' })
    expect(pushEscapeAction(state)).toBe('close')
  })

  it('pull (rebase) then retries the push exactly once', async () => {
    const { store, client } = rejectedStore([])
    const outcome = await store.resolveRejected()
    expect(outcome.kind).toBe('pushed')
    expect(client.pullForPush).toHaveBeenCalledTimes(1)
    expect(client.pullForPush.mock.calls[0]?.[0]).toEqual({
      sessionId: 's1', requestId: 'req-1', remote: 'origin', branch: 'feat/login', mode: 'rebase',
    } satisfies PullForPushRequest)
    expect(client.push).toHaveBeenCalledTimes(1)
    expect(client.push.mock.calls[0]?.[0]).toMatchObject({ requestId: 'req-2', forceWithLease: false })
  })

  it('merge choice is passed to pullForPush', async () => {
    const { store, client } = rejectedStore([])
    store.setChoice('merge')
    await store.resolveRejected()
    expect((client.pullForPush.mock.calls[0]?.[0] as PullForPushRequest).mode).toBe('merge')
  })

  it('a second rejection after the automatic retry stops (no further retries)', async () => {
    const again = fail('git/rejected', 'again', { ...rejection({ remoteCommits: [commit('beef000000', 'other')] }) })
    const { store, client } = rejectedStore([again, again, again])
    const outcome = await store.resolveRejected()
    expect(outcome.kind).toBe('rejected')
    expect(client.pullForPush).toHaveBeenCalledTimes(1)
    expect(client.push).toHaveBeenCalledTimes(1)
    const state = store.getState()
    expect(state.view).toBe('rejected')
    expect(state.autoRetryRejected).toBe(true)
    expect(state.rejected?.remoteCommits[0]?.subject).toBe('other')
  })

  it('pull conflict ends with a conflict outcome and no push', async () => {
    const { store, client } = rejectedStore([], fail('git/conflict', 'conflict'))
    const outcome = await store.resolveRejected()
    expect(outcome).toEqual({ kind: 'conflict', error: { code: 'git/conflict', message: 'conflict' } })
    expect(client.push).not.toHaveBeenCalled()
  })

  it('pull auth failure stays on the rejected page with the error', async () => {
    const { store, client } = rejectedStore([], fail('git/auth-required', 'auth', { command: 'git pull --rebase origin feat/login' }))
    const outcome = await store.resolveRejected()
    expect(outcome.kind).toBe('failed')
    expect(store.getState().view).toBe('rejected')
    expect(store.getState().error?.code).toBe('git/auth-required')
    expect(client.push).not.toHaveBeenCalled()
  })

  it('force choice requires the risk tick and pushes with force-with-lease, no pull', async () => {
    const { store, client } = rejectedStore([])
    store.setChoice('force')
    expect(rejectedSubmitBlock(store.getState())).toBe('risk-unconfirmed')
    expect((await store.resolveRejected()).kind).toBe('blocked')
    store.setChoiceRiskConfirmed(true)
    expect(rejectedSubmitBlock(store.getState())).toBeNull()
    await store.resolveRejected()
    expect(client.pullForPush).not.toHaveBeenCalled()
    expect(client.push.mock.calls[0]?.[0]).toMatchObject({ forceWithLease: true })
  })

  it('TD-10: force-with-lease carries expectedRemoteSha from the rejection details', async () => {
    const sha = 'c'.repeat(40)
    const { store, client } = rejectedStore([], ok({ head: 'h' }), rejection({ remoteSha: sha }))
    store.setChoice('force')
    store.setChoiceRiskConfirmed(true)
    await store.resolveRejected()
    expect(client.push.mock.calls[0]?.[0]).toMatchObject({ forceWithLease: true, expectedRemoteSha: sha })
  })

  it('TD-10: an old Host without remoteSha → force push without expectedRemoteSha (A2 behaviour)', async () => {
    const { store, client } = rejectedStore([])
    store.setChoice('force')
    store.setChoiceRiskConfirmed(true)
    await store.resolveRejected()
    expect(client.push.mock.calls[0]?.[0]).not.toHaveProperty('expectedRemoteSha')
  })

  it('TD-10: the pull + retry path never sends expectedRemoteSha', async () => {
    const { store, client } = rejectedStore([], ok({ head: 'h' }), rejection({ remoteSha: 'c'.repeat(40) }))
    await store.resolveRejected()
    expect(client.push.mock.calls[0]?.[0]).not.toHaveProperty('expectedRemoteSha')
  })

  it('switching away from force clears the risk tick', () => {
    const { store } = rejectedStore([])
    store.setChoice('force')
    store.setChoiceRiskConfirmed(true)
    store.setChoice('rebase')
    expect(store.getState().choiceRiskConfirmed).toBe(false)
  })

  it('protected rejection refuses force even if forced through the API', async () => {
    const { store, client } = rejectedStore([], ok({ head: 'h' }), rejection({ reason: 'protected' }))
    store.setChoice('force')
    expect(store.getState().choice).toBe('rebase')
    expect(rejectedSubmitBlock({ ...store.getState(), choice: 'force', choiceRiskConfirmed: true })).toBe('force-protected')
    await store.resolveRejected()
    expect(client.push.mock.calls.every(call => (call[0] as PushRequest).forceWithLease !== true)).toBe(true)
  })

  it('double click on resolve runs one pull', async () => {
    const { store, client } = rejectedStore([])
    await Promise.all([store.resolveRejected(), store.resolveRejected()])
    expect(client.pullForPush).toHaveBeenCalledTimes(1)
  })

  it('back to push from a rejection reached via the push page', async () => {
    const client = fakeClient({ push: vi.fn(async () => fail('git/rejected', 'r', { ...rejection() })) })
    const { store } = await loadedStore({ client })
    await store.submit()
    expect(pushEscapeAction(store.getState())).toBe('back')
    store.backToPush()
    expect(store.getState().view).toBe('push')
    expect(store.getState().rejected).toBeNull()
  })
})

describe('pushEscapeAction', () => {
  it('ignores Esc while a network write is running', async () => {
    let resolve: (value: RpcResult<never>) => void = () => undefined
    const client = fakeClient({ push: vi.fn(() => new Promise(r => { resolve = r })) as never })
    const { store } = await loadedStore({ client })
    const pending = store.submit()
    expect(pushEscapeAction(store.getState())).toBe('ignore')
    resolve(fail('git/exec-failed'))
    await pending
    expect(pushEscapeAction(store.getState())).toBe('close')
  })
})

describe('rollback store', () => {
  const targets = [
    { path: 'a.ts', untracked: false },
    { path: 'b.ts', untracked: false },
    { path: 'new1.txt', untracked: true },
    { path: 'new2.txt', untracked: true },
  ]

  function rollbackClient(result: RpcResult<unknown> = ok({ restored: ['a.ts', 'b.ts'], deleted: [], keptStaged: [], skipped: [] })) {
    return { rollback: vi.fn(async () => result) } as RollbackClient & { rollback: ReturnType<typeof vi.fn> }
  }

  it('counts tracked and untracked targets', () => {
    expect(rollbackCounts(targets)).toEqual({ total: 4, tracked: 2, untracked: 2 })
  })

  it('without the danger tick: deleteUntracked false', async () => {
    const client = rollbackClient()
    const store = createRollbackStore({ client, sessionId: 's1', targets, newRequestId: sequentialIds() })
    await store.submit()
    expect(client.rollback).toHaveBeenCalledWith({
      sessionId: 's1', requestId: 'req-1', paths: ['a.ts', 'b.ts', 'new1.txt', 'new2.txt'], deleteUntracked: false,
    } satisfies RollbackRequest)
  })

  it('with the danger tick: deleteUntracked true and confirmedUntracked = the untracked paths shown (TD-8)', async () => {
    const client = rollbackClient()
    const store = createRollbackStore({ client, sessionId: 's1', targets, newRequestId: sequentialIds() })
    store.setDeleteConfirmed(true)
    await store.submit()
    expect(client.rollback.mock.calls[0]?.[0]).toEqual({
      sessionId: 's1',
      requestId: 'req-1',
      paths: ['a.ts', 'b.ts', 'new1.txt', 'new2.txt'],
      deleteUntracked: true,
      confirmedUntracked: ['new1.txt', 'new2.txt'],
    } satisfies RollbackRequest)
  })

  it('TD-8: skipped paths split into declined (shown untracked) and became-untracked-after-confirmation', () => {
    expect(rollbackSkipped(targets, ['new1.txt', 'b.ts'])).toEqual({ declined: ['new1.txt'], becameUntracked: ['b.ts'] })
    expect(rollbackSkipped(targets, [])).toEqual({ declined: [], becameUntracked: [] })
  })

  it('TD-9: more targets than WRITE_PATHS_MAX blocks the rollback', async () => {
    const many = Array.from({ length: WRITE_PATHS_MAX + 1 }, (_, index) => ({ path: `f${index}.ts`, untracked: false }))
    const client = rollbackClient()
    const store = createRollbackStore({ client, sessionId: 's1', targets: many })
    expect(rollbackSubmitBlock(many, store.getState())).toBe('too-many')
    expect((await store.submit()).kind).toBe('blocked')
    expect(client.rollback).not.toHaveBeenCalled()
    expect(rollbackSubmitBlock(many.slice(1), store.getState())).toBeNull()
  })

  it('only untracked targets and no tick → nothing to do', async () => {
    const client = rollbackClient()
    const onlyNew = targets.filter(target => target.untracked)
    const store = createRollbackStore({ client, sessionId: 's1', targets: onlyNew })
    expect(rollbackSubmitBlock(onlyNew, store.getState())).toBe('nothing')
    expect((await store.submit()).kind).toBe('blocked')
    expect(client.rollback).not.toHaveBeenCalled()
    store.setDeleteConfirmed(true)
    expect(rollbackSubmitBlock(onlyNew, store.getState())).toBeNull()
  })

  it('creating the store (and cancelling) has no side effects', () => {
    const client = rollbackClient()
    const store = createRollbackStore({ client, sessionId: 's1', targets })
    store.setDeleteConfirmed(true)
    store.setDeleteConfirmed(false)
    expect(client.rollback).not.toHaveBeenCalled()
  })

  it('keeps the result (keptStaged / skipped) and de-duplicates double clicks', async () => {
    const client = rollbackClient(ok({ restored: ['a.ts'], deleted: [], keptStaged: ['b.ts'], skipped: ['new1.txt', 'new2.txt'] }))
    const store = createRollbackStore({ client, sessionId: 's1', targets })
    const [a, b] = await Promise.all([store.submit(), store.submit()])
    expect(a).toBe(b)
    expect(client.rollback).toHaveBeenCalledTimes(1)
    expect(store.getState().result?.keptStaged).toEqual(['b.ts'])
    expect(store.getState().busy).toBe(false)
  })

  it('a failure is kept for display', async () => {
    const store = createRollbackStore({ client: rollbackClient(fail('git/locked', 'index.lock')), sessionId: 's1', targets })
    const outcome = await store.submit()
    expect(outcome.kind).toBe('failed')
    expect(store.getState().error?.code).toBe('git/locked')
  })

  it('Esc closes the sheet unless a rollback is running', () => {
    expect(rollbackEscapeAction({ busy: false })).toBe('close')
    expect(rollbackEscapeAction({ busy: true })).toBe('ignore')
  })
})

describe('push up to a commit (B3b)', () => {
  it('previews and pushes the revision instead of HEAD', async () => {
    const client = fakeClient()
    const revision = 'c'.repeat(40)
    const store = createPushStore({ client, sessionId: 's1', repoRoot: '/repo', storage: null, newRequestId: sequentialIds(), revision })
    await store.load()
    expect(client.pushPreview).toHaveBeenCalledWith('s1', expect.any(AbortSignal), revision)
    await store.submit()
    expect(client.push).toHaveBeenCalledWith(expect.objectContaining({ revision }))
  })

  it('leaves the revision out when pushing HEAD', async () => {
    const client = fakeClient()
    const { store } = await loadedStore({ client })
    await store.submit()
    expect(client.push.mock.calls[0]?.[0]).not.toHaveProperty('revision')
  })
})
