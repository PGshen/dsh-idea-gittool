// A2 T2：只提交勾选文件、仅改信息 Amend、加入 VCS（真实临时仓库）。
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { COMMIT_MESSAGE_MAX_BYTES, WRITE_PATHS_MAX } from '../../src/shared/protocol.ts'
import { GitCommandFailure, bindWriteContext, createGitRunner } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import {
  addToVcsOperation,
  amendMessageOperation,
  commitFilesOperation,
} from '../../src/host/git/commit-write.ts'
import { createTempRepo, writeExecutableScript } from './fixtures.ts'
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

async function failureOf(promise: Promise<unknown>): Promise<GitCommandFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected a GitCommandFailure')
}

function parseFailure(run: () => unknown): GitCommandFailure {
  try {
    run()
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected a GitCommandFailure')
}

/** `git status --porcelain` lines (short format, stable for assertions). */
function porcelain(repo: TempRepo): string[] {
  return repo
    .git('status', '--porcelain=v1', '--untracked-files=all')
    .split('\n')
    .filter((line) => line !== '')
    .sort()
}

function committedFiles(repo: TempRepo, rev = 'HEAD'): string[] {
  return repo
    .git('-c', 'core.quotepath=false', 'diff-tree', '--no-commit-id', '--name-status', '-r', '-M', '--root', rev)
    .split('\n')
    .filter((line) => line !== '')
    .sort()
}

async function commit(repo: TempRepo, paths: string[], message = 'msg', amend = false) {
  const op = commitFilesOperation
  return await op.run(contextFor(repo), op.parse({ sessionId: 's', requestId: 'r', paths, message, amend }))
}

function installHook(repo: TempRepo, name: string, body: string): void {
  writeExecutableScript(join(repo.root, '.git', 'hooks'), name, body)
}

describe('commitFilesOperation.parse', () => {
  it('rejects empty, duplicate, oversized and unsafe path lists', () => {
    const parse = (paths: unknown) => parseFailure(() => commitFilesOperation.parse({ paths, message: 'm' }))
    expect(parse([]).code).toBe('git/invalid-payload')
    expect(parse(['a', 'a']).code).toBe('git/invalid-payload')
    expect(parse('a').code).toBe('git/invalid-payload')
    expect(parse(['../x']).code).toBe('git/invalid-payload')
    expect(parse(['/etc/passwd']).code).toBe('git/invalid-payload')
    expect(parse(['.git/config']).code).toBe('git/invalid-payload')
    expect(parse(Array.from({ length: WRITE_PATHS_MAX + 1 }, (_, i) => `f${String(i)}`)).code).toBe(
      'git/invalid-payload',
    )
  })

  it('trims trailing whitespace and rejects empty or oversized messages', () => {
    expect(commitFilesOperation.parse({ paths: ['a'], message: 'subject\n\nbody  \n\n' }).message).toBe(
      'subject\n\nbody',
    )
    const parse = (message: unknown) => parseFailure(() => commitFilesOperation.parse({ paths: ['a'], message }))
    expect(parse('  \n\t').code).toBe('git/invalid-payload')
    expect(parse(undefined).code).toBe('git/invalid-payload')
    // Multi-byte: fewer characters than the limit, more bytes.
    expect(parse('中'.repeat(Math.ceil(COMMIT_MESSAGE_MAX_BYTES / 3) + 1)).code).toBe('git/invalid-payload')
    expect(parseFailure(() => commitFilesOperation.parse({ paths: ['a'], message: 'm', amend: 'yes' })).code).toBe(
      'git/invalid-payload',
    )
  })
})

describe('commitFilesOperation.run', () => {
  it('commits only the 2 selected of 5 changes and keeps an unrelated staged change (AC2)', async () => {
    const repo = makeRepo()
    for (const name of ['a', 'b', 'c', 'd', 'e', 'staged']) repo.write(`${name}.txt`, `${name}\n`)
    repo.commit('base')
    for (const name of ['a', 'b', 'c', 'd', 'e']) repo.write(`${name}.txt`, `${name} changed\n`)
    repo.write('staged.txt', 'staged change\n')
    repo.git('add', 'staged.txt')
    // A staged hunk on a selected file plus a further worktree edit.
    repo.git('add', 'a.txt')
    repo.write('a.txt', 'a changed twice\n')

    const head = await commit(repo, ['a.txt', 'c.txt'], 'pick two')

    expect(head.sha).toBe(repo.git('rev-parse', 'HEAD').trim())
    expect(head.shortSha).toBe(repo.git('rev-parse', '--short', 'HEAD').trim())
    expect(committedFiles(repo)).toEqual(['M\ta.txt', 'M\tc.txt'])
    expect(repo.git('show', 'HEAD:a.txt')).toBe('a changed twice\n')
    expect(porcelain(repo)).toEqual([' M b.txt', ' M d.txt', ' M e.txt', 'M  staged.txt'])
    expect(repo.git('diff', '--cached', '--', 'staged.txt')).toContain('+staged change')
  })

  it('commits untracked, deleted and renamed files (AC3)', async () => {
    const repo = makeRepo()
    repo.write('gone.txt', 'gone\n')
    repo.write('old.txt', 'rename me\n')
    repo.commit('base')
    repo.write('new.txt', 'new\n')
    repo.write('other-untracked.txt', 'leave me\n')
    repo.git('rm', '-q', 'gone.txt')
    repo.git('mv', 'old.txt', 'moved.txt')

    // Only the destination of the staged rename is selected: its source comes along.
    await commit(repo, ['new.txt', 'gone.txt', 'moved.txt'])

    expect(committedFiles(repo)).toEqual(['A\tnew.txt', 'D\tgone.txt', 'R100\told.txt\tmoved.txt'])
    expect(porcelain(repo)).toEqual(['?? other-untracked.txt'])
  })

  it('handles paths with spaces, Unicode and a leading dash (AC3)', async () => {
    const repo = makeRepo()
    repo.write('dir with space/file name.txt', 'x\n')
    repo.write('中文/文件.md', 'y\n')
    repo.write('-n', 'dash\n')
    repo.write('--amend', 'double dash\n')
    repo.write('star*.txt', 'literal\n')
    repo.write('starX.txt', 'not selected\n')

    await commit(repo, ['dir with space/file name.txt', '中文/文件.md', '-n', '--amend', 'star*.txt'])

    expect(committedFiles(repo)).toEqual([
      'A\t--amend',
      'A\t-n',
      'A\tdir with space/file name.txt',
      'A\tstar*.txt',
      'A\t中文/文件.md',
    ])
    expect(porcelain(repo)).toEqual(['?? starX.txt'])
  })

  it('allows a commit on a detached HEAD', async () => {
    const repo = makeRepo()
    repo.git('checkout', '-q', '--detach')
    repo.write('a.txt', 'a\n')
    const head = await commit(repo, ['a.txt'])
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head.sha)
  })

  it('amends HEAD with the selected files', async () => {
    const repo = makeRepo()
    const before = repo.git('rev-parse', 'HEAD~0').trim()
    repo.write('a.txt', 'a\n')
    repo.write('b.txt', 'b\n')
    await commit(repo, ['a.txt'], 'amended', true)
    expect(repo.git('rev-parse', 'HEAD').trim()).not.toBe(before)
    expect(repo.git('rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('amended')
    expect(committedFiles(repo)).toEqual(['A\tREADME.md', 'A\ta.txt'])
    expect(porcelain(repo)).toEqual(['?? b.txt'])
  })

  it('returns git/paths-changed when a selected file no longer has changes or vanished', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    const before = repo.git('rev-parse', 'HEAD').trim()

    const unchanged = await failureOf(commit(repo, ['a.txt', 'README.md']))
    expect(unchanged.code).toBe('git/paths-changed')
    expect(unchanged.details?.paths).toEqual(['README.md'])

    const vanished = await failureOf(commit(repo, ['a.txt', 'deleted-by-agent.txt']))
    expect(vanished.code).toBe('git/paths-changed')

    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(before)
    expect(porcelain(repo)).toEqual(['?? a.txt'])
  })

  it('maps a pre-commit hook failure to git/hook-failed and undoes intent-to-add (AC5)', async () => {
    const repo = makeRepo()
    repo.write('tracked.txt', 'v1\n')
    repo.commit('base')
    repo.write('tracked.txt', 'v2\n')
    repo.write('new.txt', 'new\n')
    repo.write('staged.txt', 'staged\n')
    repo.git('add', 'staged.txt')
    installHook(
      repo,
      'pre-commit',
      '#!/bin/sh\necho "lint failed in https://user:s3cret@example.com/repo"\necho "stderr line" >&2\nexit 1\n',
    )
    const before = repo.git('rev-parse', 'HEAD').trim()
    const statusBefore = porcelain(repo)
    const indexBefore = repo.git('ls-files', '--stage')

    const failure = await failureOf(commit(repo, ['tracked.txt', 'new.txt']))

    expect(failure.code).toBe('git/hook-failed')
    const output = String(failure.details?.output)
    expect(output).toContain('lint failed')
    expect(output).toContain('stderr line')
    expect(output).not.toContain('s3cret')
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(before)
    expect(porcelain(repo)).toEqual(statusBefore)
    expect(repo.git('ls-files', '--stage')).toBe(indexBefore)
  })

  it('maps a commit-msg hook failure and bounds the output to 4KB', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    installHook(repo, 'commit-msg', '#!/bin/sh\nawk \'BEGIN { for (i = 0; i < 2000; i++) print "noise noise" }\'\nexit 1\n')
    const failure = await failureOf(commit(repo, ['a.txt']))
    expect(failure.code).toBe('git/hook-failed')
    expect(Buffer.byteLength(String(failure.details?.output))).toBeLessThanOrEqual(4096)
    expect(porcelain(repo)).toEqual(['?? a.txt'])
  })

  it('refuses while a merge is in progress', async () => {
    const repo = makeRepo()
    repo.write('c.txt', 'base\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'side')
    repo.write('c.txt', 'side\n')
    repo.commit('side')
    repo.git('checkout', '-q', 'main')
    repo.write('c.txt', 'main\n')
    repo.commit('main')
    expect(repo.gitResult('merge', 'side').status).not.toBe(0)
    repo.write('other.txt', 'x\n')

    const failure = await failureOf(commit(repo, ['other.txt']))
    expect(failure.code).toBe('git/operation-in-progress')
    expect(failure.details?.operation).toBe('merge')
  })

  it('maps an existing index.lock to git/locked without touching the index', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    repo.write('.git/index.lock', '')
    const failure = await failureOf(commit(repo, ['a.txt']))
    expect(failure.code).toBe('git/locked')
    expect(existsSync(join(repo.root, '.git', 'index.lock'))).toBe(true)
    rmSync(join(repo.root, '.git', 'index.lock'))
    expect(porcelain(repo)).toEqual(['?? a.txt'])
  })
})

describe('amendMessageOperation', () => {
  it('changes only the message when the index is clean (AC4)', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    repo.commit('first')
    repo.write('a.txt', 'worktree change\n')
    repo.write('u.txt', 'untracked\n')
    const tree = repo.git('rev-parse', 'HEAD^{tree}').trim()

    const op = amendMessageOperation
    const head = await op.run(contextFor(repo), op.parse({ message: 'reworded\n' }))

    expect(head.sha).toBe(repo.git('rev-parse', 'HEAD').trim())
    expect(repo.git('log', '-1', '--format=%B').trim()).toBe('reworded')
    expect(repo.git('rev-parse', 'HEAD^{tree}').trim()).toBe(tree)
    expect(porcelain(repo)).toEqual([' M a.txt', '?? u.txt'])
  })

  it('refuses with git/index-not-clean when something is staged (AC4)', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    repo.git('add', 'a.txt')
    const before = repo.git('rev-parse', 'HEAD').trim()
    const op = amendMessageOperation
    const failure = await failureOf(op.run(contextFor(repo), op.parse({ message: 'x' })))
    expect(failure.code).toBe('git/index-not-clean')
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(before)
    expect(porcelain(repo)).toEqual(['A  a.txt'])
  })
})

describe('addToVcsOperation', () => {
  it('adds untracked paths and reports them', async () => {
    const repo = makeRepo()
    repo.write('-x file.txt', 'x\n')
    repo.write('b.txt', 'b\n')
    const op = addToVcsOperation
    const value = await op.run(contextFor(repo), op.parse({ paths: ['-x file.txt'] }))
    expect(value).toEqual({ added: ['-x file.txt'] })
    // Short status quotes paths containing spaces.
    expect(porcelain(repo)).toEqual(['?? b.txt', 'A  "-x file.txt"'])
  })

  it('returns git/paths-changed for a vanished path', async () => {
    const repo = makeRepo()
    const op = addToVcsOperation
    const failure = await failureOf(op.run(contextFor(repo), op.parse({ paths: ['nope.txt'] })))
    expect(failure.code).toBe('git/paths-changed')
  })
})

describe('review fixes', () => {
  it('commits a file inside a new untracked directory (评审 C1)', async () => {
    const repo = makeRepo()
    repo.write('newdir/a.txt', 'a\n')
    repo.write('newdir/b.txt', 'b\n')
    await commit(repo, ['newdir/a.txt'])
    expect(committedFiles(repo)).toEqual(['A\tnewdir/a.txt'])
    expect(porcelain(repo)).toEqual(['?? newdir/b.txt'])
  })

  it('does not report a signing failure as a hook failure even when a hook exists (评审 M1)', async () => {
    const repo = makeRepo()
    installHook(repo, 'pre-commit', '#!/bin/sh\nexit 0\n')
    repo.git('config', 'commit.gpgsign', 'true')
    repo.git('config', 'gpg.program', 'false')
    repo.write('a.txt', 'base\n')
    repo.git('add', 'a.txt')
    repo.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'base')
    repo.write('a.txt', 'changed\n')
    const op = commitFilesOperation
    const failure = await failureOf(op.run(contextFor(repo), op.parse({ paths: ['a.txt'], message: 'm' })))
    expect(failure.code).toBe('git/exec-failed')
  })

  it('addToVcs only accepts untracked files (评审 M3)', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'base\n')
    repo.git('add', 'a.txt')
    repo.git('commit', '-qm', 'base')
    repo.write('a.txt', 'changed\n')
    const op = addToVcsOperation
    const failure = await failureOf(op.run(contextFor(repo), op.parse({ paths: ['a.txt'] })))
    expect(failure.code).toBe('git/paths-changed')
    expect(porcelain(repo)).toEqual([' M a.txt'])
  })
})
