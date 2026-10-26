// A3 T10 stash store: list/selection/files loading and the pure helpers of the stash page.
import { describe, expect, it, vi } from 'vitest'
import {
  adjacentStash,
  createStashStore,
  stashDiffRequest,
  stashKeyAction,
  stashRelativeTime,
  stashSummary,
} from '../../../src/client/store/stash-store.ts'
import type { GitError, RpcResult, StashEntry, StashFilesValue, StashListValue } from '../../../src/shared/protocol.ts'
import { text } from '../../../src/client/localized-text.ts'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const PARENT = 'd'.repeat(40)
const UNTRACKED = 'e'.repeat(40)

function entry(sha: string, index: number, overrides: Partial<StashEntry> = {}): StashEntry {
  return { sha, index, message: `WIP on main: ${sha.slice(0, 7)} subject`, branch: 'main', date: '2026-10-24T10:20:00.000Z', fileCount: 2, ...overrides }
}

function filesOf(sha: string): StashFilesValue {
  return {
    sha,
    parentSha: PARENT,
    untrackedSha: UNTRACKED,
    files: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 }],
    untracked: [{ path: 'new.txt', status: '?' }],
  }
}

const ok = <T,>(value: T): RpcResult<T> => ({ ok: true, value })
const fail = (code: GitError['code']): RpcResult<never> => ({ ok: false, error: { code, message: code } })

function harness(entries: StashEntry[] = [entry(SHA_A, 0), entry(SHA_B, 1)]) {
  let list: RpcResult<StashListValue> = ok({ entries, version: 1 })
  const loadList = vi.fn(async () => list)
  const loadFiles = vi.fn(async (sha: string) => ok(filesOf(sha)))
  const store = createStashStore({ loadList, loadFiles })
  return { store, loadList, loadFiles, setList: (next: RpcResult<StashListValue>) => { list = next } }
}

describe('stash store list', () => {
  it('loads entries and keeps them while a reload fails', async () => {
    const h = harness()
    await h.store.refresh()
    expect(h.store.getState().list.status).toBe('ready')
    expect(h.store.getState().list.entries.map(item => item.sha)).toEqual([SHA_A, SHA_B])
    h.setList(fail('git/timeout'))
    await h.store.refresh()
    const state = h.store.getState().list
    expect(state.status).toBe('error')
    expect(state.entries).toHaveLength(2)
    expect(state.error?.code).toBe('git/timeout')
  })

  it('drops an older list response arriving after a newer one', async () => {
    let release: (value: RpcResult<StashListValue>) => void = () => {}
    const slow = new Promise<RpcResult<StashListValue>>((resolve) => { release = resolve })
    const loadList = vi.fn<() => Promise<RpcResult<StashListValue>>>()
    loadList.mockReturnValueOnce(slow)
    loadList.mockResolvedValueOnce(ok({ entries: [entry(SHA_C, 0)] }))
    const store = createStashStore({ loadList, loadFiles: async sha => ok(filesOf(sha)) })
    const first = store.refresh()
    await store.refresh()
    release(ok({ entries: [entry(SHA_A, 0)] }))
    await first
    expect(store.getState().list.entries.map(item => item.sha)).toEqual([SHA_C])
  })

  it('clears the selection when the selected stash disappeared, keeps it otherwise', async () => {
    const h = harness()
    await h.store.refresh()
    await h.store.select(SHA_A)
    h.setList(ok({ entries: [entry(SHA_A, 0)] }))
    await h.store.refresh()
    expect(h.store.getState().selectedSha).toBe(SHA_A)
    h.setList(ok({ entries: [entry(SHA_B, 0)] }))
    await h.store.refresh()
    expect(h.store.getState().selectedSha).toBeNull()
    expect(h.store.getState().files.status).toBe('idle')
  })
})

describe('stash store selection', () => {
  it('loads the files of the selected stash by sha', async () => {
    const h = harness()
    await h.store.refresh()
    const value = await h.store.select(SHA_B)
    expect(h.loadFiles).toHaveBeenCalledWith(SHA_B, expect.anything())
    expect(value?.sha).toBe(SHA_B)
    expect(h.store.getState().files).toMatchObject({ status: 'ready', sha: SHA_B })
  })

  it('does not reload files already loaded for the same sha', async () => {
    const h = harness()
    await h.store.refresh()
    await h.store.select(SHA_A)
    await h.store.select(SHA_A)
    expect(h.loadFiles).toHaveBeenCalledTimes(1)
  })

  it('a late response of a previously selected stash is ignored', async () => {
    const resolvers = new Map<string, (value: RpcResult<StashFilesValue>) => void>()
    const loadFiles = vi.fn((sha: string) => new Promise<RpcResult<StashFilesValue>>((resolve) => { resolvers.set(sha, resolve) }))
    const store = createStashStore({ loadList: async () => ok({ entries: [entry(SHA_A, 0), entry(SHA_B, 1)] }), loadFiles })
    await store.refresh()
    const first = store.select(SHA_A)
    const second = store.select(SHA_B)
    resolvers.get(SHA_B)?.(ok(filesOf(SHA_B)))
    resolvers.get(SHA_A)?.(ok(filesOf(SHA_A)))
    expect(await first).toBeNull()
    expect((await second)?.sha).toBe(SHA_B)
    expect(store.getState().files).toMatchObject({ status: 'ready', sha: SHA_B })
  })

  it('a failed files load is reported and select(null) clears', async () => {
    const store = createStashStore({
      loadList: async () => ok({ entries: [entry(SHA_A, 0)] }),
      loadFiles: async () => fail('git/stale-target'),
    })
    await store.refresh()
    expect(await store.select(SHA_A)).toBeNull()
    expect(store.getState().files).toMatchObject({ status: 'error', sha: SHA_A })
    await store.select(null)
    expect(store.getState()).toMatchObject({ selectedSha: null, files: { status: 'idle' } })
  })
})

describe('stash helpers', () => {
  it('diff request: tracked files use the stash commit against its first parent, untracked the root commit', () => {
    const value = filesOf(SHA_A)
    expect(stashDiffRequest('s1', value, 'tracked', 'src/a.ts')).toEqual({
      sessionId: 's1', scope: 'commit', sha: SHA_A, parent: PARENT, path: 'src/a.ts',
    })
    expect(stashDiffRequest('s1', value, 'untracked', 'new.txt')).toEqual({
      sessionId: 's1', scope: 'commit', sha: UNTRACKED, path: 'new.txt',
    })
    expect(stashDiffRequest('s1', { ...value, untrackedSha: null }, 'untracked', 'new.txt')).toBeNull()
  })

  it('relative time: now, minutes, hours, days, then the date', () => {
    const now = Date.parse('2026-10-26T12:00:00.000Z')
    expect(stashRelativeTime('2026-10-26T11:59:40.000Z', now)).toEqual(text('stash.time.now'))
    expect(stashRelativeTime('2026-10-26T11:15:00.000Z', now)).toEqual(text('stash.time.minutes', { count: 45 }))
    expect(stashRelativeTime('2026-10-26T07:00:00.000Z', now)).toEqual(text('stash.time.hours', { count: 5 }))
    expect(stashRelativeTime('2026-10-24T12:00:00.000Z', now)).toEqual(text('stash.time.days', { count: 2 }))
    expect(stashRelativeTime('2026-08-01T12:00:00.000Z', now)).toEqual(text('stash.time.date', { date: '2026-08-01' }))
    expect(stashRelativeTime('garbage', now)).toEqual(text('stash.time.date', { date: 'garbage' }))
  })

  it('summary is the first line, shortened', () => {
    expect(stashSummary('WIP on main: 1 x\nbody')).toBe('WIP on main: 1 x')
    expect(stashSummary('x'.repeat(100))).toBe(`${'x'.repeat(59)}…`)
  })

  it('arrow keys move the selection inside the list, Enter previews, Delete deletes', () => {
    const entries = [entry(SHA_A, 0), entry(SHA_B, 1), entry(SHA_C, 2)]
    expect(adjacentStash(entries, SHA_A, 'ArrowDown')).toBe(SHA_B)
    expect(adjacentStash(entries, SHA_C, 'ArrowDown')).toBe(SHA_C)
    expect(adjacentStash(entries, SHA_B, 'ArrowUp')).toBe(SHA_A)
    expect(adjacentStash(entries, null, 'ArrowDown')).toBe(SHA_A)
    expect(adjacentStash(entries, SHA_A, 'x')).toBeNull()
    expect(stashKeyAction('Enter')).toBe('preview')
    expect(stashKeyAction('Delete')).toBe('delete')
    expect(stashKeyAction('Backspace')).toBeNull()
  })
})
