// B4c T1: the synthetic benchmark repository is deterministic and has the shapes the bench times.
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBenchRepo } from '../../scripts/bench/fixture.mjs'
import { createTempDir, removeTempDir, TEST_GIT_ENV } from '../host/fixtures.ts'

vi.setConfig({ testTimeout: 30_000 })

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) removeTempDir(dirs.pop() ?? '')
})

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, env: TEST_GIT_ENV, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trimEnd()
}

async function make(commits: number) {
  const dir = createTempDir('dsh-git-bench-')
  dirs.push(dir)
  return createBenchRepo(dir, { commits })
}

describe('createBenchRepo', () => {
  it('produces the same history for the same parameters', async () => {
    const first = await make(200)
    const second = await make(200)

    expect(git(first.root, 'rev-parse', 'HEAD')).toBe(git(second.root, 'rev-parse', 'HEAD'))
    expect(first.hugeDiffSha).toBe(second.hugeDiffSha)
  })

  it('has first-parent commits, merges, branches, tags, a big file and a huge diff', async () => {
    const repo = await make(200)

    expect(Number(git(repo.root, 'rev-list', '--first-parent', '--count', 'HEAD'))).toBe(200)
    expect(git(repo.root, 'rev-list', '--merges', '--count', 'HEAD')).not.toBe('0')
    expect(git(repo.root, 'cat-file', '-p', repo.mergeSha).match(/^parent /gmu)).toHaveLength(2)
    expect(git(repo.root, 'branch', '--list', 'topic-*').split('\n').length).toBeGreaterThan(0)
    expect(git(repo.root, 'tag', '--list').split('\n').length).toBeGreaterThan(0)
    expect(git(repo.root, 'show', `HEAD:${repo.bigFile}`).split('\n')).toHaveLength(4500)
    const hugeSize = Number(git(repo.root, 'cat-file', '-s', `${repo.hugeDiffSha}:${repo.hugeFile}`))
    expect(hugeSize).toBeGreaterThan(256 * 1024)
  })

  it('leaves a dirty worktree on main', async () => {
    const repo = await make(200)

    expect(git(repo.root, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    const status = git(repo.root, 'status', '--porcelain', '-uall').split('\n')
    expect(status.filter((line) => line.startsWith(' M'))).toHaveLength(repo.modified.length)
    expect(status.filter((line) => line.startsWith('??'))).toHaveLength(repo.untracked.length)
  })
})
