// B1 T7 「全部简单冲突」 and 「还原冲突解决」 of the conflict list: files are handled one after another
// through mergeApply, only when every chunk resolves automatically (no draft is written); restoring
// maps the Host's failures to the list's messages.
import { describe, expect, it, vi } from 'vitest'
import { resolveAllSimple, runSimpleAll, simpleAllSummary, unresolveConflictFile } from '../../../src/client/pages/operation-actions.ts'
import { render, text } from '../../../src/client/localized-text.ts'
import { enT } from '../i18n-helpers.tsx'
import { autoMerge } from '../../../src/client/merge/merge-model.ts'
import type { ActionOutcome, ActionStore } from '../../../src/client/store/action-store.ts'
import type { MergeFileValue, MergeSide, RpcResult } from '../../../src/shared/protocol.ts'
import { conflictEntry } from './operation-fixtures.ts'

const side = (body: string | null, blob: string): MergeSide => ({ blob, text: body, binary: body === null, size: body?.length ?? 0 })
const SIMPLE = { base: 'alpha beta\n', ours: 'ALPHA beta\n', theirs: 'alpha BETA\n' }
const HARD = { base: 'x\n', ours: 'one\n', theirs: 'two\n' }

function file(path: string, texts: { base: string; ours: string | null; theirs: string }, over: Partial<MergeFileValue> = {}): MergeFileValue {
  return {
    path,
    kind: 'both-modified',
    base: side(texts.base, '1'.repeat(40)),
    ours: side(texts.ours, '2'.repeat(40)),
    theirs: side(texts.theirs, '3'.repeat(40)),
    tooLarge: false,
    worktreeSha: `${path}-sha`,
    draft: null,
    draftStale: false,
    resolved: false,
    ...over,
  }
}

describe('resolveAllSimple', () => {
  it('applies fully auto-resolvable files serially and counts the others as manual', async () => {
    const files: Record<string, MergeFileValue> = {
      simple: file('simple', SIMPLE),
      hard: file('hard', HARD),
      bin: file('bin', { ...SIMPLE, ours: null }),
      drafted: file('drafted', SIMPLE, { draft: { version: 1, stages: { base: null, ours: null, theirs: null }, result: '', chunks: [], savedAt: 'x' } }),
      rejected: file('rejected', SIMPLE),
    }
    const order: string[] = []
    const loadFile = vi.fn(async (path: string) => {
      order.push(`load:${path}`)
      return { ok: true, value: files[path]! } as RpcResult<MergeFileValue>
    })
    const run = vi.fn(async (_endpoint: string, payload: { path: string }) => {
      order.push(`apply:${payload.path}`)
      return (payload.path === 'rejected'
        ? { kind: 'failed', error: { code: 'git/stale-target', message: 'x' }, message: text('merge.error.stale') }
        : { kind: 'done', value: { path: payload.path, remaining: 0 } }) as ActionOutcome<never>
    })
    const entries = ['simple', 'hard', 'bin', 'drafted', 'rejected'].map(path => conflictEntry(path))
    entries.push(conflictEntry('gone', 'deleted-by-us'))
    const outcome = await resolveAllSimple({ actions: { run } as unknown as Pick<ActionStore, 'run'>, loadFile, trigger: null }, entries)
    expect(outcome).toEqual({ resolved: ['simple'], manual: ['hard', 'bin', 'drafted', 'rejected', 'gone'] })
    expect(order).toEqual(['load:simple', 'apply:simple', 'load:hard', 'load:bin', 'load:drafted', 'load:rejected', 'apply:rejected'])
    expect(run).toHaveBeenCalledWith('mergeApply', {
      path: 'simple',
      result: autoMerge(SIMPLE).result,
      stages: { base: '1'.repeat(40), ours: '2'.repeat(40), theirs: '3'.repeat(40) },
      expectedWorktreeSha: 'simple-sha',
    }, { target: 'simple', trigger: null })
    // No draft is ever saved.
    expect(run.mock.calls.every(call => call[0] === 'mergeApply')).toBe(true)
  })

  it('summary text: 已解决 N 个文件，M 个文件需要手动处理', () => {
    expect(simpleAllSummary({ resolved: ['a', 'b'], manual: ['c'] })).toEqual(text('conflict.simpleAll.done', { resolved: 2, manual: 1 }))
  })
})

describe('unresolveConflictFile', () => {
  const run = (outcome: ActionOutcome<unknown>) => ({ run: vi.fn(async () => outcome) } as unknown as Pick<ActionStore, 'run'>)

  it('sends unresolveConflict for the path', async () => {
    const actions = run({ kind: 'done', value: { path: 'a', remaining: 1 } })
    expect(await unresolveConflictFile({ actions, trigger: null }, 'a')).toEqual({ kind: 'done' })
    expect(actions.run).toHaveBeenCalledWith('unresolveConflict', { path: 'a' }, { target: 'a', trigger: null })
  })

  it('exec-failed (delete-kind, no resolve-undo) asks to restore in a terminal; stale-target reloads', async () => {
    const execFailed = await unresolveConflictFile({ actions: run({ kind: 'failed', error: { code: 'git/exec-failed', message: 'x' }, message: text('write.error.fallback') }), trigger: null }, 'a')
    expect(execFailed).toEqual({ kind: 'error', message: text('conflict.unresolve.terminal') })
    const stale = await unresolveConflictFile({ actions: run({ kind: 'failed', error: { code: 'git/stale-target', message: 'x' }, message: text('merge.error.stale') }), trigger: null }, 'a')
    expect(stale).toEqual({ kind: 'error', message: text('conflict.unresolve.unavailable'), stale: true })
  })
})

describe('runSimpleAll (the list button)', () => {
  const store = () => ({ unmarkReviewed: vi.fn(), invalidateCount: vi.fn(), refresh: vi.fn(async () => undefined) })

  it('updates the review state and always settles with a text, even when a write throws', async () => {
    const ok = store()
    const loadFile = async (path: string) => ({ ok: true, value: file(path, SIMPLE) }) as RpcResult<MergeFileValue>
    const done = vi.fn(async (_e: string, payload: { path: string }) => ({ kind: 'done', value: { path: payload.path, remaining: 0 } }))
    const summary = await runSimpleAll({ actions: { run: done } as unknown as Pick<ActionStore, 'run'>, loadFile, trigger: null }, [conflictEntry('simple')], ok)
    expect(summary).toEqual(text('conflict.simpleAll.done', { resolved: 1, manual: 0 }))
    expect(ok.unmarkReviewed).toHaveBeenCalledWith(['simple'])
    expect(ok.invalidateCount).toHaveBeenCalledWith('simple')
    expect(ok.refresh).toHaveBeenCalled()

    const broken = store()
    const throwing = vi.fn(async () => { throw new Error('network') })
    const failed = await runSimpleAll({ actions: { run: throwing } as unknown as Pick<ActionStore, 'run'>, loadFile, trigger: null }, [conflictEntry('simple')], broken)
    expect(failed).toEqual(text('conflict.simpleAll.failed'))
    expect(broken.refresh).toHaveBeenCalled()
  })
})

describe('summary wording', () => {
  it('reads right for one file in English (no plural to get wrong)', () => {
    expect(render(enT, text('conflict.simpleAll.done', { resolved: 1, manual: 1 }))).toBe('Files resolved: 1; need manual resolution: 1')
  })
})
