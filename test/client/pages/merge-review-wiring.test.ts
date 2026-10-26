// B1 T7 workbench wiring of the Review Changes queue (GitWorkbench uses createMergeReviewWiring as
// is): advance after apply, skip resolved files the window cannot review (incl. binary ones, fix 1),
// stop on back / switching files / another entry point. Real conflict and merge stores, fake RPCs.
import { describe, expect, it, vi } from 'vitest'
import { createMergeReviewWiring } from '../../../src/client/pages/merge-review-wiring.ts'
import type { WorkbenchOverlay } from '../../../src/client/pages/workbench-overlay.ts'
import { createConflictStore } from '../../../src/client/store/conflict-store.ts'
import { createMergeStore } from '../../../src/client/store/merge-store.ts'
import type { MergeStoreDeps } from '../../../src/client/store/merge-store.ts'
import type { MergeFileValue, MergeSide, RpcResult } from '../../../src/shared/protocol.ts'
import { conflictEntry, mergeState } from './operation-fixtures.ts'

const side = (body: string | null, blob: string): MergeSide => ({ blob, text: body, binary: body === null, size: body?.length ?? 0 })

function mergeFile(path: string, over: Partial<MergeFileValue> = {}): MergeFileValue {
  return {
    path,
    kind: 'both-modified',
    base: side('a\nb\n', '1'.repeat(40)),
    ours: side('a\nB1\n', '2'.repeat(40)),
    theirs: side('a\nB2\n', '3'.repeat(40)),
    tooLarge: false,
    worktreeSha: 'f'.repeat(40),
    draft: null,
    draftStale: false,
    resolved: false,
    ...over,
  }
}

async function setup(files: Record<string, RpcResult<MergeFileValue>>) {
  const conflicts = createConflictStore({
    load: async () => ({ ok: true, value: mergeState({ conflicts: [conflictEntry('u1'), conflictEntry('u2')], resolved: ['bin', 'gone', 'r1'] }) }),
  })
  await conflicts.refresh()
  const opened: Array<WorkbenchOverlay> = []
  const refreshStatus = vi.fn()
  const review = createMergeReviewWiring({ conflicts, open: (overlay) => { opened.push(overlay) }, refreshStatus })
  const run = vi.fn(async (_endpoint: string, payload: { path: string }) => ({ kind: 'done', value: { path: payload.path, remaining: 1 } }))
  const store = createMergeStore({
    loadFile: async path => files[path] ?? { ok: true, value: mergeFile(path) },
    actions: { run } as unknown as MergeStoreDeps['actions'],
    onOpened: review.opened,
    onLoadFailed: review.loadFailed,
    onApplied: review.applied,
  })
  /** What GitWorkbench renders for the last opened overlay: the window loads its file. */
  const windowLoads = async (): Promise<void> => {
    const last = opened[opened.length - 1]
    if (last?.kind === 'mergeWindow') await store.open(last.path)
  }
  return { conflicts, review, store, opened, refreshStatus, windowLoads }
}

const paths = (opened: WorkbenchOverlay[]): string[] => opened.map(o => (o.kind === 'mergeWindow' ? o.path : o.kind))

describe('Review queue wiring', () => {
  it('opens the next queued file after each apply and returns to the list at the end', async () => {
    const { review, store, opened, refreshStatus, windowLoads, conflicts } = await setup({})
    review.start(['u1', 'u2'], null)
    await windowLoads()
    expect(conflicts.getReview().reviewed.has('u1')).toBe(true)
    await store.apply()
    expect(refreshStatus).toHaveBeenCalled()
    await windowLoads()
    await store.apply()
    expect(paths(opened)).toEqual(['u1', 'u2', 'conflicts'])
    expect(review.reviewing()).toBe(false)
  })

  it('skips resolved files the window cannot review: binary sides, no worktree text, stale-target', async () => {
    const binary = mergeFile('bin', { resolved: true, worktreeText: 'x', ours: side(null, '2'.repeat(40)) })
    const { review, opened, windowLoads, conflicts } = await setup({
      bin: { ok: true, value: binary },
      gone: { ok: false, error: { code: 'git/stale-target', message: 'no resolve-undo' } },
      r1: { ok: true, value: mergeFile('r1', { resolved: true, worktreeText: 'a\nB1\n' }) },
    })
    review.start(['bin', 'gone', 'r1'], null)
    await windowLoads()
    await windowLoads()
    await windowLoads()
    expect(paths(opened)).toEqual(['bin', 'gone', 'r1'])
    expect([...conflicts.getReview().notReviewable].sort()).toEqual(['bin', 'gone'])
    expect(review.reviewing()).toBe(true)
  })

  it('a failure of an unresolved file stays in the window (no skip)', async () => {
    const { review, opened, windowLoads } = await setup({ u1: { ok: false, error: { code: 'git/stale-target', message: 'x' } } })
    review.start(['u1', 'u2'], null)
    await windowLoads()
    expect(paths(opened)).toEqual(['u1'])
    expect(review.reviewing()).toBe(true)
  })

  it('back, another entry point or switching files by hand stops the queue', async () => {
    const back = await setup({})
    back.review.start(['u1', 'u2'], null)
    back.review.left('u1', { kind: 'conflicts' })
    expect(back.review.reviewing()).toBe(false)
    await back.windowLoads()
    // Without a queue an apply follows the plain rule (next unresolved file).
    back.review.applied('u1', 1)
    expect(paths(back.opened)).toEqual(['u1', 'u2'])

    const other = await setup({})
    other.review.start(['u1', 'u2'], null)
    other.review.left('u1', { kind: 'fetch' })
    expect(other.review.reviewing()).toBe(false)

    const manual = await setup({})
    manual.review.start(['u1', 'u2', 'r1'], null)
    // Moving inside the queue (next queued file after apply) keeps it running.
    manual.review.left('u1', { kind: 'mergeWindow', path: 'u2' })
    expect(manual.review.reviewing()).toBe(true)
    manual.review.openFile('u2')
    expect(manual.review.reviewing()).toBe(false)
  })
})
