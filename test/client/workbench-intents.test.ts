// B2 T4：文档头部 / git.blame 页 → Git tab 的按会话意图队列。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { intentEffect, postIntent, resetIntentsForTest, subscribeIntents } from '../../src/client/workbench-intents.ts'

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

describe('intentEffect', () => {
  const status = (staged: string[], unstaged: string[]) => ({
    branch: 'main', detached: false, head: 'h', upstream: null, ahead: 0, behind: 0,
    staged: staged.map(path => ({ path, status: 'M' as const })),
    unstaged: unstaged.map(path => ({ path, status: 'M' as const })),
    untracked: [], conflicts: [], operation: null, truncated: false,
  })

  it('maps each intent to what the Git tab does', () => {
    expect(intentEffect({ kind: 'fileHistory', path: 'a' }, null)).toEqual({ kind: 'overlay', overlay: { kind: 'fileHistory', path: 'a' } })
    expect(intentEffect({ kind: 'selectChange', path: 'a' }, null)).toEqual({ kind: 'selectChange', path: 'a' })
    expect(intentEffect({ kind: 'showCommit', sha: 'abc' }, null)).toEqual({ kind: 'showCommit', sha: 'abc' })
  })

  it('opens the worktree diff, or the staged one when the file has only staged changes', () => {
    expect(intentEffect({ kind: 'worktreeDiff', path: 'a' }, status([], ['a']))).toEqual({ kind: 'diff', path: 'a', scope: 'worktree' })
    expect(intentEffect({ kind: 'worktreeDiff', path: 'a' }, status(['a'], []))).toEqual({ kind: 'diff', path: 'a', scope: 'staged' })
    expect(intentEffect({ kind: 'worktreeDiff', path: 'a' }, null)).toEqual({ kind: 'diff', path: 'a', scope: 'worktree' })
  })
})
