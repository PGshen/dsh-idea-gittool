// B2 T4：blame / 文件历史 / 比较三个 store（注入加载函数，无 React）。
import { describe, expect, it, vi } from 'vitest'
import { createBlameStore } from '../../../src/client/store/blame-store.ts'
import { createCompareStore } from '../../../src/client/store/compare-store.ts'
import { createFileHistoryStore } from '../../../src/client/store/file-history-store.ts'
import { createDiffStore } from '../../../src/client/store/diff-store.ts'
import type {
  BlameRequest,
  BlameValue,
  CommitSummary,
  CompareRequest,
  CompareValue,
  DiffFileValue,
  DiffRequest,
  FileHistoryEntry,
  FileHistoryRequest,
  FileHistoryValue,
  RpcResult,
} from '../../../src/shared/protocol.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const ok = <T>(value: T): RpcResult<T> => ({ ok: true, value })

function blamePage(path: string, start: number, lines: string[], total: number, extra: Partial<BlameValue> = {}): BlameValue {
  const end = start + lines.length
  return {
    path,
    rev: null,
    totalLines: total,
    start,
    lines,
    segments: [{ sha: start === 1 ? A : B, start, count: lines.length }],
    commits: {},
    ...(end <= total ? { next: end } : {}),
    binary: false,
    tooLarge: false,
    version: 1,
    ...extra,
  }
}

describe('blame store', () => {
  it('opens the first page and appends later pages with continuous line numbers', async () => {
    const load = vi.fn(async (request: BlameRequest) => ok(request.start === 3
      ? blamePage('f.txt', 3, ['c', 'd'], 4)
      : blamePage('f.txt', 1, ['a', 'b'], 4)))
    const store = createBlameStore({ sessionId: 's', load })
    await store.open({ path: 'f.txt' })
    expect(load).toHaveBeenLastCalledWith({ sessionId: 's', path: 'f.txt' }, expect.any(AbortSignal))
    expect(store.getState()).toMatchObject({ status: 'ready', next: 3 })
    await store.loadMore()
    expect(load).toHaveBeenLastCalledWith({ sessionId: 's', path: 'f.txt', start: 3 }, expect.any(AbortSignal))
    const rows = store.getState().rows
    expect(rows.map(row => [row.line, row.text, row.sha, row.segmentStart])).toEqual([
      [1, 'a', A, true], [2, 'b', A, false], [3, 'c', B, true], [4, 'd', B, false],
    ])
    expect(store.getState().next).toBeUndefined()
  })

  it('continues a segment across a page boundary without a second segment head', async () => {
    const load = vi.fn(async (request: BlameRequest) => ok(request.start === 2
      ? { ...blamePage('f.txt', 2, ['b'], 2), segments: [{ sha: A, start: 2, count: 1 }] }
      : blamePage('f.txt', 1, ['a'], 2)))
    const store = createBlameStore({ sessionId: 's', load })
    await store.open({ path: 'f.txt' })
    await store.loadMore()
    expect(store.getState().rows.map(row => row.segmentStart)).toEqual([true, false])
  })

  it('drops the response of a target it already left (no flash of the old file)', async () => {
    const slow = deferred<RpcResult<BlameValue>>()
    const load = vi.fn((request: BlameRequest, _signal: AbortSignal) => request.path === 'old.txt' ? slow.promise : Promise.resolve(ok(blamePage('new.txt', 1, ['n'], 1))))
    const store = createBlameStore({ sessionId: 's', load })
    const first = store.open({ path: 'old.txt' })
    await store.open({ path: 'new.txt', rev: 'HEAD' })
    slow.resolve(ok(blamePage('old.txt', 1, ['o'], 1)))
    await first
    expect(store.getState().target).toEqual({ path: 'new.txt', rev: 'HEAD' })
    expect(store.getState().rows.map(row => row.text)).toEqual(['n'])
    expect(load.mock.calls[0]?.[1].aborted).toBe(true)
  })

  it('reloads from the first page when a later page comes from another repository version', async () => {
    let version = 1
    const load = vi.fn(async (request: BlameRequest) => ok(blamePage('f.txt', request.start ?? 1, [`v${String(version)}`], 3, { version })))
    const store = createBlameStore({ sessionId: 's', load })
    await store.open({ path: 'f.txt' })
    version = 2
    await store.loadMore()
    expect(store.getState().rows.map(row => [row.line, row.text])).toEqual([[1, 'v2']])
    expect(store.getState().version).toBe(2)
  })

  it('selects a commit, reports errors and aborts on close', async () => {
    const pending = deferred<RpcResult<BlameValue>>()
    const load = vi.fn((_request: BlameRequest, _signal: AbortSignal) => pending.promise)
    const store = createBlameStore({ sessionId: 's', load })
    void store.open({ path: 'f.txt' })
    store.close()
    expect(load.mock.calls[0]?.[1].aborted).toBe(true)
    expect(store.getState().status).toBe('idle')
    const failing = createBlameStore({ sessionId: 's', load: async () => ({ ok: false, error: { code: 'git/invalid-payload', message: 'x' } }) })
    await failing.open({ path: 'f.txt' })
    expect(failing.getState()).toMatchObject({ status: 'error', error: { code: 'git/invalid-payload' } })
    failing.select(A)
    expect(failing.getState().selectedSha).toBe(A)
  })
})

function entry(sha: string, path: string, extra: Partial<FileHistoryEntry> = {}): FileHistoryEntry {
  return { sha, shortSha: sha.slice(0, 7), parents: [], author: 'T', email: 't@t', date: '2026-10-27T00:00:00+08:00', subject: sha.slice(0, 1), path, status: 'M', ...extra }
}

describe('file history store', () => {
  it('pages entries and diffs the selected entry by the path it had then', async () => {
    const load = vi.fn(async (request: FileHistoryRequest): Promise<RpcResult<FileHistoryValue>> => ok(request.cursor === undefined
      ? { path: 'new.txt', entries: [entry(A, 'new.txt', { status: 'R', origPath: 'old.txt' })], next: 'v1:x:1', followedRename: true, truncated: false, version: 1 }
      : { path: 'new.txt', entries: [entry(B, 'old.txt', { status: 'A' })], followedRename: false, truncated: false, version: 1 }))
    const diffLoad = vi.fn(async (_request: DiffRequest) => ok({ oldPath: null, newPath: 'old.txt', status: 'A', binary: false, hunks: [], truncated: false } satisfies DiffFileValue))
    const diff = createDiffStore({ load: diffLoad })
    const store = createFileHistoryStore({ sessionId: 's', load, diff })
    await store.open({ path: 'new.txt' })
    await store.loadMore()
    expect(load).toHaveBeenLastCalledWith({ sessionId: 's', path: 'new.txt', cursor: 'v1:x:1' }, expect.any(AbortSignal))
    expect(store.getState().followedRename).toBe(true)
    expect(store.getState().next).toBeUndefined()
    expect(store.getState().entries.map(item => item.sha)).toEqual([A, B])
    await store.select(B)
    expect(store.getState().selectedSha).toBe(B)
    expect(diffLoad).toHaveBeenLastCalledWith({ sessionId: 's', path: 'old.txt', scope: 'commit', sha: B }, expect.any(AbortSignal))
  })

  it('drops a stale open and closes the diff with the store', async () => {
    const slow = deferred<RpcResult<FileHistoryValue>>()
    const load = vi.fn((request: FileHistoryRequest) => request.path === 'a.txt'
      ? slow.promise
      : Promise.resolve(ok({ path: 'b.txt', entries: [entry(B, 'b.txt')], followedRename: false, truncated: false } satisfies FileHistoryValue)))
    const diff = createDiffStore({ load: async () => ok({ oldPath: 'b.txt', newPath: 'b.txt', status: 'M', binary: false, hunks: [], truncated: false } satisfies DiffFileValue) })
    const store = createFileHistoryStore({ sessionId: 's', load, diff })
    const first = store.open({ path: 'a.txt' })
    await store.open({ path: 'b.txt' })
    slow.resolve(ok({ path: 'a.txt', entries: [entry(A, 'a.txt')], followedRename: false, truncated: false }))
    await first
    expect(store.getState().entries.map(item => item.sha)).toEqual([B])
    await store.select(B)
    store.close()
    expect(diff.getState().status).toBe('idle')
    expect(store.getState().status).toBe('idle')
  })
})

function commit(sha: string): CommitSummary {
  return { sha, shortSha: sha.slice(0, 7), parents: [], author: 'T', email: 't@t', date: '2026-10-27T00:00:00+08:00', subject: sha.slice(0, 1) }
}

function compareValue(request: CompareRequest, extra: Partial<CompareValue> = {}): CompareValue {
  return {
    left: { input: request.left, sha: request.left === 'feature' ? A : B },
    right: request.right === null ? null : { input: request.right, sha: request.right === 'feature' ? A : B },
    commits: [commit(request.left === 'feature' ? A : B)],
    files: [{ path: 'f.txt', status: 'M' }],
    filesTruncated: false,
    version: 1,
    ...extra,
  }
}

describe('compare store', () => {
  it('opens, swaps sides and diffs a file from the merge base by resolved shas', async () => {
    const load = vi.fn(async (request: CompareRequest) => ok(compareValue(request)))
    const diffLoad = vi.fn(async (_request: DiffRequest) => ok({ oldPath: 'f.txt', newPath: 'f.txt', status: 'M', binary: false, hunks: [], truncated: false } satisfies DiffFileValue))
    const diff = createDiffStore({ load: diffLoad })
    const store = createCompareStore({ sessionId: 's', load, diff })
    await store.open({ left: 'feature', right: 'main' })
    expect(store.getState().commits.map(item => item.sha)).toEqual([A])
    await store.selectFile('f.txt')
    expect(diffLoad).toHaveBeenLastCalledWith(
      { sessionId: 's', path: 'f.txt', scope: 'range', from: B, to: A, mergeBase: true },
      expect.any(AbortSignal),
    )
    await store.swap()
    expect(load).toHaveBeenLastCalledWith({ sessionId: 's', left: 'main', right: 'feature' }, expect.any(AbortSignal))
    expect(store.getState().target).toEqual({ left: 'main', right: 'feature' })
    expect(store.getState().selectedPath).toBeNull()
    expect(diff.getState().status).toBe('idle')
  })

  it('sends the old path of a renamed file so the Host scans only that file (终审 I3)', async () => {
    const load = vi.fn(async (request: CompareRequest) => ok(compareValue(request, { files: [{ path: 'new.txt', origPath: 'old.txt', status: 'R' }] })))
    const diffLoad = vi.fn(async (_request: DiffRequest) => ok({ oldPath: 'old.txt', newPath: 'new.txt', status: 'R', binary: false, hunks: [], truncated: false } satisfies DiffFileValue))
    const store = createCompareStore({ sessionId: 's', load, diff: createDiffStore({ load: diffLoad }) })
    await store.open({ left: 'feature', right: 'main' })
    await store.selectFile('new.txt')
    expect(diffLoad).toHaveBeenLastCalledWith(
      { sessionId: 's', path: 'new.txt', scope: 'range', from: B, to: A, mergeBase: true, origPath: 'old.txt' },
      expect.any(AbortSignal),
    )
  })

  it('compares with the worktree: no swap, diff from the revision to the worktree', async () => {
    const load = vi.fn(async (request: CompareRequest) => ok(compareValue(request, { commits: [] })))
    const diffLoad = vi.fn(async (_request: DiffRequest) => ok({ oldPath: 'f.txt', newPath: 'f.txt', status: 'M', binary: false, hunks: [], truncated: false } satisfies DiffFileValue))
    const store = createCompareStore({ sessionId: 's', load, diff: createDiffStore({ load: diffLoad }) })
    await store.open({ left: 'feature', right: null })
    expect(store.canSwap()).toBe(false)
    await store.swap()
    expect(load).toHaveBeenCalledTimes(1)
    await store.selectFile('f.txt')
    expect(diffLoad).toHaveBeenLastCalledWith({ sessionId: 's', path: 'f.txt', scope: 'range', from: A, to: null }, expect.any(AbortSignal))
  })

  it('appends commit pages and restarts when the version moved', async () => {
    let version = 1
    const load = vi.fn(async (request: CompareRequest) => ok(compareValue(request, request.cursor === undefined
      ? { next: 'v1:a:1', version }
      : { commits: [commit(B)], version })))
    const store = createCompareStore({ sessionId: 's', load, diff: createDiffStore({ load: vi.fn() }) })
    await store.open({ left: 'feature', right: 'main' })
    await store.loadMore()
    expect(store.getState().commits.map(item => item.sha)).toEqual([A, B])
    await store.open({ left: 'feature', right: 'main' })
    version = 2
    await store.loadMore()
    expect(store.getState().commits.map(item => item.sha)).toEqual([A])
    expect(store.getState().version).toBe(2)
  })
})

describe('diff store request identity (B2 range)', () => {
  it('treats a swapped range on the same path as a different request (old content is not kept)', async () => {
    const second = deferred<RpcResult<DiffFileValue>>()
    const value: DiffFileValue = { oldPath: 'f.txt', newPath: 'f.txt', status: 'M', binary: false, hunks: [], truncated: false }
    let call = 0
    const diff = createDiffStore({ load: () => (++call === 1 ? Promise.resolve(ok(value)) : second.promise) })
    await diff.open({ sessionId: 's', path: 'f.txt', scope: 'range', from: A, to: B })
    void diff.open({ sessionId: 's', path: 'f.txt', scope: 'range', from: B, to: A })
    expect(diff.getState()).toMatchObject({ status: 'loading', value: null })
  })
})
