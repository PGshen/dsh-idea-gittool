/**
 * 提交详情 store：请求取消、过期响应丢弃、错误归一与正文折叠判定。
 * 这里只测纯传输状态机，不依赖 DOM——组件测试见 detail.test.tsx。
 */
import { describe, expect, it } from 'vitest'
import type { CommitDetailValue, RpcResult } from '../../../src/shared/protocol.ts'
import { createDetailStore } from '../../../src/client/store/detail-store.ts'
import type { DetailState } from '../../../src/client/store/detail-store.ts'
import { shouldCollapseBody } from '../../../src/client/pages/CommitDetail.tsx'

function detailOf(sha: string, subject = `subject ${sha}`): CommitDetailValue {
  return {
    sha,
    shortSha: sha.slice(0, 8),
    parents: [],
    author: { name: 'Alice', email: 'alice@example.com', date: '2026-10-25T09:00:00+08:00' },
    committer: { name: 'Alice', email: 'alice@example.com', date: '2026-10-25T09:00:00+08:00' },
    subject,
    body: '',
    refs: [],
    files: [],
    truncated: false,
  }
}

/** 手动控制结算时机的 loader，用来验证「旧请求被取消、迟到响应被丢弃」。 */
function controlledLoader(): {
  load: (sha: string, signal: AbortSignal) => Promise<RpcResult<CommitDetailValue>>
  calls: { sha: string; signal: AbortSignal }[]
  resolve: (sha: string, value: CommitDetailValue) => void
  reject: (sha: string, error: { code: 'git/exec-failed'; message: string }) => void
} {
  const calls: { sha: string; signal: AbortSignal }[] = []
  const pending: { sha: string; resolve: (result: RpcResult<CommitDetailValue>) => void }[] = []
  const settle = (sha: string, result: RpcResult<CommitDetailValue>): void => {
    for (const entry of pending) {
      if (entry.sha === sha) entry.resolve(result)
    }
  }
  return {
    calls,
    load: (sha, signal) => {
      calls.push({ sha, signal })
      return new Promise<RpcResult<CommitDetailValue>>((resolve) => {
        pending.push({ sha, resolve })
      })
    },
    resolve: (sha, value) => { settle(sha, { ok: true, value }) },
    reject: (sha, error) => { settle(sha, { ok: false, error }) },
  }
}

describe('createDetailStore', () => {
  it('选中提交后进入 loading，成功后进入 ready 并保留 sha', async () => {
    const loader = controlledLoader()
    const store = createDetailStore({ load: loader.load })
    expect(store.getState().status).toBe('idle')

    const done = store.select('aaaa1111')
    expect(store.getState()).toMatchObject({ status: 'loading', sha: 'aaaa1111', value: null, error: null })
    expect(loader.calls.map(call => call.sha)).toEqual(['aaaa1111'])

    loader.resolve('aaaa1111', detailOf('aaaa1111'))
    await done
    expect(store.getState().status).toBe('ready')
    expect(store.getState().value?.subject).toBe('subject aaaa1111')
  })

  it('重新选中另一个提交会中止上一次请求，并丢弃它的迟到响应', async () => {
    const loader = controlledLoader()
    const store = createDetailStore({ load: loader.load })
    const first = store.select('aaaa1111')
    const second = store.select('bbbb2222')
    expect(loader.calls[0]?.signal.aborted).toBe(true)
    expect(loader.calls[1]?.signal.aborted).toBe(false)

    loader.resolve('aaaa1111', detailOf('aaaa1111', 'stale'))
    await first
    expect(store.getState().sha).toBe('bbbb2222')
    expect(store.getState().value).toBeNull()

    loader.resolve('bbbb2222', detailOf('bbbb2222', 'fresh'))
    await second
    expect(store.getState().value?.subject).toBe('fresh')
  })

  it('请求失败时进入 error，并带上结构化错误码；重试成功后清掉错误', async () => {
    const loader = controlledLoader()
    const store = createDetailStore({ load: loader.load })
    const failed = store.select('cccc3333')
    loader.reject('cccc3333', { code: 'git/exec-failed', message: 'git 退出码 128' })
    await failed
    expect(store.getState()).toMatchObject({
      status: 'error',
      sha: 'cccc3333',
      value: null,
      error: { code: 'git/exec-failed', message: 'git 退出码 128' },
    })

    const retried = store.reload()
    expect(loader.calls).toHaveLength(2)
    expect(loader.calls[1]?.sha).toBe('cccc3333')
    loader.resolve('cccc3333', detailOf('cccc3333'))
    await retried
    expect(store.getState()).toMatchObject({ status: 'ready', error: null })
  })

  it('cancel 中止在途请求并清空状态', async () => {
    const loader = controlledLoader()
    const store = createDetailStore({ load: loader.load })
    const pending = store.select('dddd4444')
    store.cancel()
    expect(loader.calls[0]?.signal.aborted).toBe(true)
    expect(store.getState()).toEqual({ status: 'idle', sha: null, value: null, error: null })
    loader.resolve('dddd4444', detailOf('dddd4444'))
    await pending
    expect(store.getState().status).toBe('idle')
  })

  it('向订阅者广播状态变化，并在取消订阅后停止', async () => {
    const loader = controlledLoader()
    const store = createDetailStore({ load: loader.load })
    const seen: DetailState[] = []
    const unsubscribe = store.subscribe(() => { seen.push(store.getState()) })
    const first = store.select('eeee5555')
    loader.resolve('eeee5555', detailOf('eeee5555'))
    await first
    expect(seen.map(state => state.status)).toEqual(['loading', 'ready'])
    unsubscribe()
    store.cancel()
    expect(seen).toHaveLength(2)
  })

  it('同一 sha 重复选中会复用一次新请求而不是静默忽略', async () => {
    const loader = controlledLoader()
    const store = createDetailStore({ load: loader.load })
    const first = store.select('ffff6666')
    const second = store.select('ffff6666')
    expect(loader.calls).toHaveLength(2)
    expect(loader.calls[0]?.signal.aborted).toBe(true)
    loader.resolve('ffff6666', detailOf('ffff6666'))
    await Promise.all([first, second])
    expect(store.getState().status).toBe('ready')
  })
})

describe('shouldCollapseBody', () => {
  it('短正文不折叠', () => {
    expect(shouldCollapseBody('')).toBe(false)
    expect(shouldCollapseBody('一行说明\n第二行')).toBe(false)
  })

  it('超过 20 行或 1200 字符时折叠', () => {
    expect(shouldCollapseBody(Array.from({ length: 21 }, (_, index) => `line ${index}`).join('\n'))).toBe(true)
    expect(shouldCollapseBody('x'.repeat(1201))).toBe(true)
  })

  it('行数与字符数都在阈值内时不折叠', () => {
    expect(shouldCollapseBody(Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'))).toBe(false)
    expect(shouldCollapseBody('x'.repeat(1200))).toBe(false)
  })
})
