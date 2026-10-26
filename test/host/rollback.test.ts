// A2 T2：回滚（设计 §8.2.5，AC8 的 Host 部分；真实临时仓库）。
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure, bindWriteContext, createGitRunner } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import { rollbackOperation } from '../../src/host/git/rollback.ts'
import { createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'

vi.setConfig({ testTimeout: 30_000 })

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRepo(): TempRepo {
  const repo = createTempRepo()
  cleanups.push(() => repo.cleanup())
  return repo
}

function contextFor(repo: TempRepo): WriteContext {
  return bindWriteContext(createGitRunner(createFakeSubprocess()), repo.root, { kind: 'unconfined' }, new AbortController().signal)
}

async function rollback(repo: TempRepo, paths: string[], deleteUntracked: boolean) {
  const op = rollbackOperation
  return await op.run(contextFor(repo), op.parse({ sessionId: 's', requestId: 'r', paths, deleteUntracked }))
}

function porcelain(repo: TempRepo): string[] {
  return repo
    .git('status', '--porcelain=v1', '--untracked-files=all')
    .split('\n')
    .filter((line) => line !== '')
    .sort()
}

describe('rollbackOperation.parse', () => {
  it('requires a boolean deleteUntracked and a valid path list', () => {
    const codeOf = (payload: unknown): string => {
      try {
        rollbackOperation.parse(payload)
      } catch (error) {
        if (error instanceof GitCommandFailure) return error.code
        throw error
      }
      return 'ok'
    }
    expect(codeOf({ paths: ['a'] })).toBe('git/invalid-payload')
    expect(codeOf({ paths: [], deleteUntracked: false })).toBe('git/invalid-payload')
    expect(codeOf({ paths: ['a', 'a'], deleteUntracked: false })).toBe('git/invalid-payload')
    expect(codeOf({ paths: ['a/../b'], deleteUntracked: false })).toBe('git/invalid-payload')
    expect(codeOf({ paths: ['a'], deleteUntracked: true })).toBe('ok')
  })
})

describe('rollbackOperation.run', () => {
  it('restores tracked worktree changes, keeps staged content and skips untracked files', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    repo.write('b.txt', 'b\n')
    repo.write('del.txt', 'del\n')
    repo.write('keep.txt', 'keep\n')
    repo.commit('base')
    repo.write('a.txt', 'a changed\n')
    repo.write('b.txt', 'b staged\n')
    repo.git('add', 'b.txt')
    repo.write('b.txt', 'b staged and edited\n')
    repo.git('rm', '-q', '--cached', 'del.txt')
    repo.write('keep.txt', 'not selected\n')
    repo.write('u.txt', 'untracked\n')

    const value = await rollback(repo, ['a.txt', 'b.txt', 'u.txt', 'README.md'], false)

    expect(value).toEqual({
      restored: ['a.txt', 'b.txt'],
      deleted: [],
      keptStaged: ['b.txt'],
      skipped: ['u.txt'],
    })
    expect(repo.git('show', ':b.txt')).toBe('b staged\n')
    expect(porcelain(repo)).toEqual([' M keep.txt', 'D  del.txt', 'M  b.txt', '?? del.txt', '?? u.txt'].sort())
    expect(existsSync(join(repo.root, 'u.txt'))).toBe(true)
  })

  it('restores a deleted file and odd paths (space, Unicode, leading dash)', async () => {
    const repo = makeRepo()
    repo.write('gone.txt', 'gone\n')
    repo.write('a b/中文.txt', 'x\n')
    repo.write('-f', 'dash\n')
    repo.commit('base')
    rmSync(join(repo.root, 'gone.txt'))
    repo.write('a b/中文.txt', 'y\n')
    repo.write('-f', 'changed\n')

    const value = await rollback(repo, ['gone.txt', 'a b/中文.txt', '-f'], false)

    expect(value.restored).toEqual(['gone.txt', 'a b/中文.txt', '-f'])
    expect(porcelain(repo)).toEqual([])
  })

  it('deletes only the listed untracked files when confirmed', async () => {
    const repo = makeRepo()
    repo.write('dir/one.txt', '1\n')
    repo.write('dir/two.txt', '2\n')
    repo.write('-rf', 'not an option\n')

    const value = await rollback(repo, ['dir/one.txt', '-rf'], true)

    expect(value).toEqual({ restored: [], deleted: ['dir/one.txt', '-rf'], keptStaged: [], skipped: [] })
    expect(existsSync(join(repo.root, 'dir', 'one.txt'))).toBe(false)
    expect(existsSync(join(repo.root, '-rf'))).toBe(false)
    expect(existsSync(join(repo.root, 'dir', 'two.txt'))).toBe(true)
  })

  it('never deletes untracked files without confirmation', async () => {
    const repo = makeRepo()
    repo.write('u.txt', 'u\n')
    const value = await rollback(repo, ['u.txt'], false)
    expect(value.skipped).toEqual(['u.txt'])
    expect(existsSync(join(repo.root, 'u.txt'))).toBe(true)
  })

  it('reports a staged-only path as kept without touching it', async () => {
    const repo = makeRepo()
    repo.write('s.txt', 's\n')
    repo.git('add', 's.txt')
    const value = await rollback(repo, ['s.txt'], true)
    expect(value).toEqual({ restored: [], deleted: [], keptStaged: ['s.txt'], skipped: [] })
    expect(porcelain(repo)).toEqual(['A  s.txt'])
  })
})
