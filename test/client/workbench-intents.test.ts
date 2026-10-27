// B2 T4：文档头部 / git.blame 页 → Git tab 的按会话意图队列。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { postIntent, resetIntentsForTest, subscribeIntents } from '../../src/client/workbench-intents.ts'

afterEach(() => { resetIntentsForTest() })

describe('workbench intents', () => {
  it('delivers intents posted before anyone subscribed, once, then live ones', () => {
    postIntent('s1', { kind: 'fileHistory', path: 'a.txt' })
    postIntent('s1', { kind: 'worktreeDiff', path: 'b.txt' })
    const listener = vi.fn()
    const stop = subscribeIntents('s1', listener)
    expect(listener.mock.calls.map(call => call[0])).toEqual([
      { kind: 'fileHistory', path: 'a.txt' },
      { kind: 'worktreeDiff', path: 'b.txt' },
    ])
    postIntent('s1', { kind: 'showCommit', sha: 'abc' })
    expect(listener).toHaveBeenLastCalledWith({ kind: 'showCommit', sha: 'abc' })
    stop()
    const later = vi.fn()
    subscribeIntents('s1', later)
    expect(later).not.toHaveBeenCalled()
  })

  it('keeps sessions apart and queues again after the last listener left', () => {
    const other = vi.fn()
    subscribeIntents('s2', other)
    postIntent('s1', { kind: 'selectChange', path: 'x' })
    expect(other).not.toHaveBeenCalled()
    const stop = subscribeIntents('s1', vi.fn())
    stop()
    postIntent('s1', { kind: 'selectChange', path: 'y' })
    const next = vi.fn()
    subscribeIntents('s1', next)
    expect(next).toHaveBeenCalledWith({ kind: 'selectChange', path: 'y' })
  })
})
