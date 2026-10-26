// T5 commit store: state machine, duplicate-submit de-dup, draft/history persistence, gate, error copy.
import { describe, expect, it, vi } from 'vitest'
import { enT, zhT } from '../i18n-helpers.tsx'
import {
  HISTORY_LIMIT,
  commitErrorView,
  commitGate,
  writePathsLimitReason,
  commitPageModeOf,
  createCommitStore,
  operationGate,
  visibleMessage,
  draftKey,
  historyKey,
  isSubmitShortcut,
  messageRows,
  pushHistory,
  subjectHint,
} from '../../../src/client/store/commit-store.ts'
import type { CommitGateInput, StorageLike } from '../../../src/client/store/commit-store.ts'
import { WRITE_PATHS_MAX } from '../../../src/shared/protocol.ts'
import type { AmendMessageRequest, CommitFilesRequest, CommitResultValue, GitError, RpcResult } from '../../../src/shared/protocol.ts'
import { statusFixture } from './changes-fixtures.ts'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) },
  }
}

const throwingStorage: StorageLike = {
  getItem: () => { throw new Error('SecurityError') },
  setItem: () => { throw new Error('QuotaExceeded') },
  removeItem: () => { throw new Error('SecurityError') },
}

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const ok = (sha = '7f3a2c1d'.padEnd(40, '0')): RpcResult<CommitResultValue> => ({ ok: true, value: { sha, shortSha: sha.slice(0, 7), version: 9 } })
const fail = (error: GitError): RpcResult<CommitResultValue> => ({ ok: false, error })

function setup(options: { storage?: StorageLike | null; commitFiles?: (request: CommitFilesRequest) => Promise<RpcResult<CommitResultValue>>; amendMessage?: (request: AmendMessageRequest) => Promise<RpcResult<CommitResultValue>> } = {}) {
  let counter = 0
  const commitFiles = vi.fn(options.commitFiles ?? (async () => ok()))
  const amendMessage = vi.fn(options.amendMessage ?? (async () => ok()))
  const storage = options.storage === undefined ? memoryStorage() : options.storage
  const store = createCommitStore({
    sessionId: 's1',
    repoRoot: '/repo',
    client: { commitFiles, amendMessage },
    storage,
    newRequestId: () => `req-${++counter}`,
  })
  return { store, commitFiles, amendMessage, storage }
}

describe('commit store state machine', () => {
  it('idle → submitting → success; clears draft, records history, reports sha', async () => {
    const { store, commitFiles, storage } = setup()
    store.setMessage('feat: one\n\nbody')
    expect(storage?.getItem(draftKey('s1'))).toBe('feat: one\n\nbody')
    const phases: string[] = []
    store.subscribe(() => { phases.push(store.getState().phase) })
    const outcome = await store.submit(['a.ts', 'b.ts'])
    expect(phases).toContain('submitting')
    expect(store.getState().phase).toBe('success')
    expect(outcome).toMatchObject({ ok: true, mode: 'files', paths: ['a.ts', 'b.ts'] })
    expect(commitFiles).toHaveBeenCalledWith({ sessionId: 's1', requestId: 'req-1', paths: ['a.ts', 'b.ts'], message: 'feat: one\n\nbody' })
    expect(store.getState().lastCommit?.shortSha).toBe('7f3a2c1')
    expect(store.getState().message).toBe('')
    expect(store.getState().amend).toBe(false)
    expect(storage?.getItem(draftKey('s1'))).toBeNull()
    expect(store.getState().history[0]).toBe('feat: one\n\nbody')
    expect(JSON.parse(storage?.getItem(historyKey('/repo')) ?? '[]')).toEqual(['feat: one\n\nbody'])
  })

  it('failure keeps the message and exposes the error', async () => {
    const { store } = setup({ commitFiles: async () => fail({ code: 'git/hook-failed', message: 'hook', details: { stderr: 'lint failed' } }) })
    store.setMessage('fix: x')
    const outcome = await store.submit(['a.ts'])
    expect(outcome.ok).toBe(false)
    expect(store.getState()).toMatchObject({ phase: 'failure', message: 'fix: x', error: { code: 'git/hook-failed' } })
    expect(store.getState().history).toEqual([])
  })

  it('duplicate submits while in flight share one request (one requestId, one call)', async () => {
    const pending = deferred<RpcResult<CommitResultValue>>()
    const { store, commitFiles } = setup({ commitFiles: () => pending.promise })
    store.setMessage('feat: dup')
    const first = store.submit(['a.ts'])
    const second = store.submit(['a.ts'])
    expect(second).toBe(first)
    expect(commitFiles).toHaveBeenCalledTimes(1)
    pending.resolve(ok())
    await first
    expect(store.getState().phase).toBe('success')
  })

  it('retry after a transport failure reuses the requestId when the payload is unchanged', async () => {
    const results = [fail({ code: 'git/exec-failed', message: 'HTTP 502' }), fail({ code: 'git/exec-failed', message: 'HTTP 502' }), ok()]
    const { store, commitFiles } = setup({ commitFiles: async () => results.shift() ?? ok() })
    store.setMessage('feat: retry')
    await store.submit(['a.ts'])
    await store.submit(['a.ts'])
    store.setMessage('feat: retry edited')
    await store.submit(['a.ts'])
    const ids = commitFiles.mock.calls.map(call => call[0].requestId)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[1])
  })

  it('a failure with a definite Git error gets a new requestId on retry', async () => {
    const results = [fail({ code: 'git/hook-failed', message: 'hook' }), ok()]
    const { store, commitFiles } = setup({ commitFiles: async () => results.shift() ?? ok() })
    store.setMessage('feat: hook')
    await store.submit(['a.ts'])
    await store.submit(['a.ts'])
    const ids = commitFiles.mock.calls.map(call => call[0].requestId)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('amend with checked files commits them with amend: true; without files it amends the message only', async () => {
    const { store, commitFiles, amendMessage } = setup()
    store.setMessage('fix: amended')
    store.setAmend(true)
    await store.submit(['a.ts'])
    expect(commitFiles.mock.calls[0]?.[0]).toMatchObject({ amend: true, paths: ['a.ts'] })
    store.setMessage('fix: only message')
    store.setAmend(true)
    const outcome = await store.submit([])
    expect(amendMessage).toHaveBeenCalledWith({ sessionId: 's1', requestId: 'req-2', message: 'fix: only message' })
    expect(outcome).toMatchObject({ ok: true, mode: 'amend-message', paths: [] })
  })

  it('refuses to submit an empty message or no files without amend (no request sent)', async () => {
    const { store, commitFiles } = setup()
    store.setMessage('   ')
    expect(await store.submit(['a.ts'])).toMatchObject({ ok: false, skipped: true })
    store.setMessage('feat: x')
    expect(await store.submit([])).toMatchObject({ ok: false, skipped: true })
    expect(commitFiles).not.toHaveBeenCalled()
    expect(store.getState().phase).toBe('idle')
  })

  it('trims trailing whitespace of the message before sending', async () => {
    const { store, commitFiles } = setup()
    store.setMessage('feat: x  \n\n')
    await store.submit(['a.ts'])
    expect(commitFiles.mock.calls[0]?.[0].message).toBe('feat: x')
  })

  it('editing after success/failure returns to idle; dismiss clears feedback', async () => {
    const { store } = setup()
    store.setMessage('feat: a')
    await store.submit(['a.ts'])
    expect(store.getState().phase).toBe('success')
    store.dismiss()
    expect(store.getState()).toMatchObject({ phase: 'idle', error: null })
    expect(store.getState().lastCommit).not.toBeNull()
    store.setMessage('next')
    expect(store.getState().phase).toBe('idle')
  })
})

describe('draft and history persistence', () => {
  it('restores the draft by session and history by repo root', () => {
    const storage = memoryStorage({ [draftKey('s1')]: 'wip message', [historyKey('/repo')]: JSON.stringify(['old 1', 'old 2']) })
    const { store } = setup({ storage })
    expect(store.getState().message).toBe('wip message')
    expect(store.getState().history).toEqual(['old 1', 'old 2'])
    expect(draftKey('s1')).toBe('dsh-git:draft:s1')
    expect(historyKey('/repo')).toBe('dsh-git:history:/repo')
  })

  it('ignores malformed history', () => {
    const { store } = setup({ storage: memoryStorage({ [historyKey('/repo')]: '{not json' }) })
    expect(store.getState().history).toEqual([])
    const { store: other } = setup({ storage: memoryStorage({ [historyKey('/repo')]: JSON.stringify([1, 'ok', null]) }) })
    expect(other.getState().history).toEqual(['ok'])
  })

  it('works with storage that throws or is missing', async () => {
    for (const storage of [throwingStorage, null]) {
      const { store } = setup({ storage })
      expect(store.getState().message).toBe('')
      store.setMessage('feat: still works')
      await store.submit(['a.ts'])
      expect(store.getState().phase).toBe('success')
      expect(store.getState().history).toEqual(['feat: still works'])
    }
  })

  it('history keeps the latest 20, newest first, de-duplicated', () => {
    let history: string[] = []
    for (let index = 0; index < 25; index += 1) history = pushHistory(history, `m${index}`)
    expect(history).toHaveLength(HISTORY_LIMIT)
    expect(history[0]).toBe('m24')
    history = pushHistory(history, 'm20')
    expect(history[0]).toBe('m20')
    expect(history.filter(item => item === 'm20')).toHaveLength(1)
  })

  it('applyHistory replaces the message and saves the draft', () => {
    const { store, storage } = setup()
    store.applyHistory('feat: from history')
    expect(store.getState().message).toBe('feat: from history')
    expect(storage?.getItem(draftKey('s1'))).toBe('feat: from history')
  })
})

describe('commitGate', () => {
  const base: CommitGateInput = {
    writePolicy: { mode: 'read-write' },
    status: statusFixture(),
    pendingWrites: 0,
    checkedCount: 2,
    message: 'feat: x',
    amend: false,
    phase: 'idle',
  }

  it('TD-9: more checked files than WRITE_PATHS_MAX disables commit with the limit reason', () => {
    expect(commitGate({ ...base, checkedCount: WRITE_PATHS_MAX }, zhT).canSubmit).toBe(true)
    const gate = commitGate({ ...base, checkedCount: WRITE_PATHS_MAX + 1 }, zhT)
    expect(gate).toMatchObject({ canSubmit: false, canPush: false, blocked: false })
    expect(gate.disabledReason).toBe(`一次最多 2000 个文件，当前 ${WRITE_PATHS_MAX + 1} 个`)
    expect(commitGate({ ...base, checkedCount: 2001 }, enT).disabledReason).toBe('At most 2000 files at once (selected: 2001)')
    expect(writePathsLimitReason(2000, zhT)).toBeNull()
  })

  it('enabled for a normal commit', () => {
    expect(commitGate(base, zhT)).toMatchObject({ disabledReason: null, blocked: false, mode: 'files', submitLabel: '提交' })
  })

  it('read-only disables everything with the policy reason', () => {
    const gate = commitGate({ ...base, writePolicy: { mode: 'read-only', reason: '仓库在工作区之外' } }, zhT)
    expect(gate).toMatchObject({ blocked: true, disabledReason: '仓库在工作区之外' })
    expect(commitGate({ ...base, writePolicy: { mode: 'read-only' } }, zhT).disabledReason).toContain('只读')
  })

  it('operation in progress disables commit', () => {
    const gate = commitGate({ ...base, status: statusFixture({ operation: 'merge' }) }, zhT)
    expect(gate.blocked).toBe(true)
    expect(gate.disabledReason).toContain('合并')
  })

  it('pending writes show 等待当前操作完成', () => {
    expect(commitGate({ ...base, pendingWrites: 1 }, zhT)).toMatchObject({ blocked: true, disabledReason: '等待当前操作完成' })
  })

  it('no checked files: hint; with amend it becomes message-only amend', () => {
    expect(commitGate({ ...base, checkedCount: 0 }, zhT).disabledReason).toBe('请至少选择一个文件')
    expect(commitGate({ ...base, checkedCount: 0, amend: true }, zhT)).toMatchObject({ disabledReason: null, mode: 'amend-message', submitLabel: '仅修改提交信息' })
    expect(commitGate({ ...base, amend: true }, zhT).submitLabel).toBe('修改提交')
  })

  it('empty message disables', () => {
    expect(commitGate({ ...base, message: '  \n' }, zhT).disabledReason).toBe('请填写提交信息')
  })

  it('no repository status disables without a crash', () => {
    expect(commitGate({ ...base, status: null }, zhT).blocked).toBe(true)
  })

  it('rewrite-history warning only for amend when HEAD is pushed (upstream and ahead 0)', () => {
    const pushed = statusFixture({ upstream: 'origin/main', ahead: 0 })
    expect(commitGate({ ...base, amend: true, status: pushed }, zhT).rewriteWarning).toContain('改写已推送的历史')
    expect(commitGate({ ...base, amend: false, status: pushed }, zhT).rewriteWarning).toBeNull()
    expect(commitGate({ ...base, amend: true, status: statusFixture({ upstream: 'origin/main', ahead: 2 }) }, zhT).rewriteWarning).toBeNull()
    expect(commitGate({ ...base, amend: true, status: statusFixture({ upstream: null, ahead: 0 }) }, zhT).rewriteWarning).toBeNull()
  })

  it('detached HEAD hint; push needs the push page without upstream or when detached; no push for amend', () => {
    const detached = commitGate({ ...base, status: statusFixture({ detached: true, branch: null, upstream: null }) }, zhT)
    expect(detached.detachedHint).toContain('游离')
    expect(detached.pushNeedsPage).toBe(true)
    expect(commitGate({ ...base, status: statusFixture({ upstream: null }) }, zhT).pushNeedsPage).toBe(true)
    expect(commitGate(base, zhT)).toMatchObject({ pushNeedsPage: false, canPush: true })
    expect(commitGate({ ...base, amend: true }, zhT).canPush).toBe(false)
  })

  it('while submitting the submit stays disabled without a reason (loading)', () => {
    expect(commitGate({ ...base, phase: 'submitting' }, zhT)).toMatchObject({ disabledReason: null, submitting: true, canSubmit: false })
  })
})

describe('commitErrorView', () => {
  it('hook failure: title, output summary, console action', () => {
    const view = commitErrorView({ code: 'git/hook-failed', message: 'pre-commit failed', details: { stdout: 'running lint', stderr: 'error: 3 problems' } }, zhT)
    expect(view.title).toBe('提交被 Git hook 阻止')
    expect(view.detail).toContain('error: 3 problems')
    expect(view.detail).toContain('running lint')
    expect(view.action).toBe('console')
  })

  it('caps long hook output', () => {
    const view = commitErrorView({ code: 'git/hook-failed', message: 'x', details: { output: 'y'.repeat(5000) } }, zhT)
    expect(view.detail?.length).toBeLessThanOrEqual(801)
  })

  it('paths changed → refresh and retry', () => {
    expect(commitErrorView({ code: 'git/paths-changed', message: 'x' }, zhT)).toMatchObject({ title: '文件已变化，刷新后重试', action: 'refresh' })
  })

  it('index not clean, sandbox, locked, operation, timeout and fallback', () => {
    expect(commitErrorView({ code: 'git/index-not-clean', message: 'x' }, zhT).title).toContain('暂存区')
    expect(commitErrorView({ code: 'git/sandbox-denied', message: 'x' }, zhT).title).toContain('只读')
    expect(commitErrorView({ code: 'git/locked', message: 'x' }, zhT)).toMatchObject({ action: 'console' })
    expect(commitErrorView({ code: 'git/locked', message: 'x' }, zhT).title).toContain('锁定')
    expect(commitErrorView({ code: 'git/operation-in-progress', message: 'x' }, zhT).title).toContain('进行中')
    expect(commitErrorView({ code: 'git/timeout', message: 'x' }, zhT).action).toBe('console')
    expect(commitErrorView({ code: 'git/exec-failed', message: 'boom' }, zhT)).toMatchObject({ title: '提交失败', detail: 'git/exec-failed：boom', action: 'console' })
  })
})

describe('message helpers', () => {
  it('rows grow from 3 to 8', () => {
    expect(messageRows('')).toBe(3)
    expect(messageRows('a\nb\nc\nd')).toBe(4)
    expect(messageRows('\n'.repeat(20))).toBe(8)
  })

  it('subject longer than 72 gives a soft hint', () => {
    expect(subjectHint('x'.repeat(72), zhT)).toBeNull()
    expect(subjectHint(`${'x'.repeat(80)}\n\nbody`, zhT)).toContain('80')
  })

  it('Cmd/Ctrl+Enter submits; plain Enter and IME composition do not', () => {
    expect(isSubmitShortcut({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true)
    expect(isSubmitShortcut({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true)
    expect(isSubmitShortcut({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false)
    expect(isSubmitShortcut({ key: 'Enter', metaKey: true, ctrlKey: false, isComposing: true })).toBe(false)
  })
})

describe('operation state commit (A3 T9)', () => {
  const client = { commitFiles: vi.fn(), amendMessage: vi.fn() }
  const store = (storage: StorageLike | null = null) => createCommitStore({ sessionId: 's', repoRoot: '/r', client, storage })

  it('page mode follows the operation', () => {
    expect(commitPageModeOf(null)).toBe('normal')
    expect(commitPageModeOf('bisect')).toBe('normal')
    expect(commitPageModeOf('merge')).toBe('merge')
    expect(commitPageModeOf('cherry-pick')).toBe('sequencer')
    expect(commitPageModeOf('revert')).toBe('sequencer')
    expect(commitPageModeOf('rebase')).toBe('rebase')
  })

  it('merge prefills MERGE_MSG; the normal draft is kept apart and comes back afterwards', () => {
    const storage = memoryStorage({ [draftKey('s')]: 'my draft' })
    const commit = store(storage)
    commit.setOperation({ mode: 'merge', message: "Merge branch 'f'", key: 'k1' })
    expect(commit.getState().mode).toBe('merge')
    expect(visibleMessage(commit.getState())).toBe("Merge branch 'f'")
    commit.setOperation({ mode: 'normal' })
    expect(visibleMessage(commit.getState())).toBe('my draft')
    expect(storage.data.get(draftKey('s'))).toBe('my draft')
  })

  it('a user edit is never overwritten by a later prefill of the same operation', () => {
    const commit = store()
    commit.setOperation({ mode: 'merge', message: 'A', key: 'k1' })
    commit.setMessage('edited')
    commit.setOperation({ mode: 'merge', message: 'B', key: 'k1' })
    expect(visibleMessage(commit.getState())).toBe('edited')
    // Without an edit the newer MERGE_MSG is taken.
    const fresh = store()
    fresh.setOperation({ mode: 'merge', key: 'k1' })
    fresh.setOperation({ mode: 'merge', message: 'B', key: 'k1' })
    expect(visibleMessage(fresh.getState())).toBe('B')
  })

  it('a new operation (other key) starts from its own MERGE_MSG', () => {
    const commit = store()
    commit.setOperation({ mode: 'merge', message: 'A', key: 'k1' })
    commit.setMessage('edited')
    commit.setOperation({ mode: 'merge', message: 'C', key: 'k2' })
    expect(visibleMessage(commit.getState())).toBe('C')
  })

  it('runOperation: submitting → success with the commit (merge clears the message, joins history)', async () => {
    const commit = store()
    commit.setOperation({ mode: 'merge', message: 'M', key: 'k' })
    let resolve!: (value: { kind: 'done'; value: CommitResultValue }) => void
    const task = () => new Promise<{ kind: 'done'; value: CommitResultValue }>((done) => { resolve = done })
    const pending = commit.runOperation(task)
    expect(commit.getState().phase).toBe('submitting')
    expect(commit.runOperation(task)).toBe(pending)
    resolve({ kind: 'done', value: { sha: 'f'.repeat(40), shortSha: 'fffffff' } })
    await pending
    expect(commit.getState()).toMatchObject({ phase: 'success', lastCommit: { shortSha: 'fffffff' } })
    expect(visibleMessage(commit.getState())).toBe('')
    expect(commit.getState().history[0]).toBe('M')
  })

  it('runOperation: continue result uses HEAD; failure keeps the error; a conflict goes back to idle', async () => {
    const commit = store()
    commit.setOperation({ mode: 'sequencer' })
    await commit.runOperation(async () => ({ kind: 'done', value: { operation: null, head: 'e'.repeat(40) } }))
    expect(commit.getState().lastCommit).toEqual({ sha: 'e'.repeat(40), shortSha: 'eeeeeee' })
    const error: GitError = { code: 'git/locked', message: 'lock' }
    await commit.runOperation(async () => ({ kind: 'failed', error, message: { key: 'write.error.git/locked' } }))
    expect(commit.getState()).toMatchObject({ phase: 'failure', error })
    await commit.runOperation(async () => ({ kind: 'conflict', error: { code: 'git/conflict', message: '' }, details: {} }))
    expect(commit.getState()).toMatchObject({ phase: 'idle', error: null })
  })
})

describe('operationGate (A3 T9)', () => {
  const base = {
    writePolicy: { mode: 'read-write' } as const,
    pendingWrites: 0,
    message: 'Merge',
    phase: 'idle' as const,
  }

  it('merge: 提交合并, disabled while conflicts are left or the message is empty', () => {
    const ok = operationGate({ ...base, mode: 'merge', status: statusFixture({ operation: 'merge' }) }, zhT)
    expect(ok).toMatchObject({ submitLabel: '提交合并', canSubmit: true, showMessage: true, disabledReason: null })
    const conflicts = operationGate({ ...base, mode: 'merge', status: statusFixture({ operation: 'merge', conflicts: [{ path: 'a', status: 'U' }, { path: 'b', status: 'U' }] }) }, zhT)
    expect(conflicts).toMatchObject({ canSubmit: false, disabledReason: '还有 2 个冲突未解决' })
    const empty = operationGate({ ...base, message: ' ', mode: 'merge', status: statusFixture({ operation: 'merge' }) }, zhT)
    expect(empty.canSubmit).toBe(false)
  })

  it('cherry-pick / revert: 继续拣选 / 继续回滚 without a message box', () => {
    const pick = operationGate({ ...base, message: '', mode: 'sequencer', status: statusFixture({ operation: 'cherry-pick' }) }, zhT)
    expect(pick).toMatchObject({ submitLabel: '继续拣选', canSubmit: true, showMessage: false })
    const revert = operationGate({ ...base, mode: 'sequencer', status: statusFixture({ operation: 'revert' }) }, zhT)
    expect(revert.submitLabel).toBe('继续回滚')
  })

  it('rebase: explanation + 继续变基', () => {
    const gate = operationGate({ ...base, mode: 'rebase', status: statusFixture({ operation: 'rebase' }) }, zhT)
    expect(gate).toMatchObject({ submitLabel: '继续变基', showMessage: false })
    expect(gate.explanation).toContain('横幅')
  })

  it('read-only and pending writes block; submitting disables', () => {
    const readOnly = operationGate({ ...base, writePolicy: { mode: 'read-only', reason: 'nope' }, mode: 'merge', status: statusFixture({ operation: 'merge' }) }, zhT)
    expect(readOnly).toMatchObject({ canSubmit: false, disabledReason: 'nope' })
    const pending = operationGate({ ...base, pendingWrites: 1, mode: 'merge', status: statusFixture({ operation: 'merge' }) }, zhT)
    expect(pending.canSubmit).toBe(false)
    const submitting = operationGate({ ...base, phase: 'submitting', mode: 'merge', status: statusFixture({ operation: 'merge' }) }, zhT)
    expect(submitting).toMatchObject({ canSubmit: false, submitting: true })
  })
})
