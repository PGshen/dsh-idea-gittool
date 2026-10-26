// A3 T5：贮藏读写端点（真实临时仓库）。列表与 `git stash list` 一致、含未跟踪文件的贮藏
// 文件列表与 diff、三种创建选项、apply 保留 / pop 删除、pop 冲突贮藏仍在、按 sha 定位
// （列表位移后删对条目，已不存在 → `git/stale-target`）、待恢复标记随 pop/drop 清除。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { STASH_FILE_COUNT_LIMIT } from '../../src/shared/protocol.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import type { GitRunner, WriteContext } from '../../src/host/git-executor.ts'
import { readDiff } from '../../src/host/git/diff.ts'
import { PENDING_STASH_META_REF, PENDING_STASH_REF } from '../../src/host/git/smart-stash.ts'
import {
  readStashFiles,
  readStashList,
  stashApplyOperation,
  stashCreateOperation,
  stashDropOperation,
} from '../../src/host/git/stash.ts'
import { createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { contextFor, scriptedContext } from './remote-fixtures.ts'

vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRepo(): TempRepo {
  const repo = createTempRepo()
  cleanups.push(repo.cleanup)
  return repo
}

function runner(): GitRunner {
  return createGitRunner(createFakeSubprocess())
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

function codeOf(parse: () => unknown): string {
  try {
    parse()
  } catch (error) {
    if (error instanceof GitCommandFailure) return error.code
    throw error
  }
  return 'ok'
}

function stashShas(repo: TempRepo): string[] {
  return repo
    .git('stash', 'list', '--format=%H')
    .split('\n')
    .filter((line) => line !== '')
}

function porcelain(repo: TempRepo): string[] {
  return repo
    .git('status', '--porcelain=v1', '--untracked-files=all')
    .split('\n')
    .filter((line) => line !== '')
    .sort()
}

function read(repo: TempRepo, path: string): string {
  return readFileSync(join(repo.root, path), 'utf8')
}

async function create(repo: TempRepo, extra: Record<string, unknown> = {}) {
  const op = stashCreateOperation
  return await op.run(
    contextFor(repo),
    op.parse({ sessionId: 's', requestId: 'r', includeUntracked: false, keepIndex: false, ...extra }),
  )
}

async function apply(repo: TempRepo, sha: string, pop: boolean) {
  const op = stashApplyOperation
  return await op.run(contextFor(repo), op.parse({ sessionId: 's', requestId: 'r', sha, pop }))
}

async function drop(repo: TempRepo, sha: string) {
  const op = stashDropOperation
  return await op.run(contextFor(repo), op.parse({ sessionId: 's', requestId: 'r', sha }))
}

/** Base commit with tracked files a.txt and b.txt. */
function baseRepo(): TempRepo {
  const repo = makeRepo()
  repo.write('a.txt', 'a\n')
  repo.write('b.txt', 'b\n')
  repo.commit('base files')
  return repo
}

/** Write a well-formed pending-stash marker for `stashSha` (as T2 would). */
function writeMarker(repo: TempRepo, stashSha: string): void {
  const head = repo.git('rev-parse', 'HEAD').trim()
  const meta = JSON.stringify({ operation: 'merge', branch: 'refs/heads/main', headSha: head, createdAt: '' })
  // `TempRepo.git` has no stdin: store the blob through a temp file inside .git.
  repo.write('.git/dsh-meta.json', meta)
  const metaSha = repo.git('hash-object', '-w', '.git/dsh-meta.json').trim()
  repo.git('update-ref', PENDING_STASH_REF, stashSha)
  repo.git('update-ref', PENDING_STASH_META_REF, metaSha)
}

function hasRef(repo: TempRepo, ref: string): boolean {
  return repo.gitResult('rev-parse', '-q', '--verify', ref).status === 0
}

describe('readStashList', () => {
  it('is empty without stashes', async () => {
    const repo = baseRepo()
    expect(await readStashList(runner(), repo.root)).toEqual({ entries: [] })
  })

  it('matches `git stash list` (order, sha, index, branch, message, date, file count)', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'a1\n')
    repo.git('stash', 'push', '-q', '-m', 'first: custom')
    repo.write('a.txt', 'a2\n')
    repo.write('b.txt', 'b2\n')
    repo.git('stash', 'push', '-q')
    repo.git('checkout', '-q', '--detach')
    repo.write('a.txt', 'a3\n')
    repo.git('stash', 'push', '-q')
    repo.git('checkout', '-q', 'main')

    const value = await readStashList(runner(), repo.root)
    const shas = stashShas(repo)
    const short = repo.git('rev-parse', '--short', 'HEAD').trim()

    expect(value.entries.map((entry) => entry.sha)).toEqual(shas)
    expect(value.entries.map(({ index, branch, message, fileCount }) => ({ index, branch, message, fileCount }))).toEqual([
      { index: 0, branch: null, message: `WIP on (no branch): ${short} base files`, fileCount: 1 },
      { index: 1, branch: 'main', message: `WIP on main: ${short} base files`, fileCount: 2 },
      { index: 2, branch: 'main', message: 'first: custom', fileCount: 1 },
    ])
    for (const entry of value.entries) expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('counts only tracked files and reports 0 for an untracked-only stash', async () => {
    const repo = baseRepo()
    repo.write('u.txt', 'u\n')
    repo.git('stash', 'push', '-q', '-u')
    const value = await readStashList(runner(), repo.root)
    expect(value.entries).toHaveLength(1)
    expect(value.entries[0]?.fileCount).toBe(0)
  })

  it(`omits fileCount beyond ${String(STASH_FILE_COUNT_LIMIT)} entries`, async () => {
    const repo = baseRepo()
    // `stash create` + `stash store` (the reflog skips a repeated sha, so each one differs).
    for (let index = 0; index <= STASH_FILE_COUNT_LIMIT; index += 1) {
      repo.write('a.txt', `changed ${String(index)}\n`)
      repo.git('stash', 'store', '-m', `On main: n${String(index)}`, repo.git('stash', 'create').trim())
    }
    const value = await readStashList(runner(), repo.root)
    expect(value.entries).toHaveLength(STASH_FILE_COUNT_LIMIT + 1)
    for (const entry of value.entries) expect(entry.fileCount).toBeUndefined()
  })
})

describe('readStashFiles', () => {
  it('lists tracked and untracked files with resolved parent shas; both diffs work', async () => {
    const repo = baseRepo()
    const head = repo.git('rev-parse', 'HEAD').trim()
    repo.write('a.txt', 'a changed\n')
    repo.write('b.txt', 'b staged\n')
    repo.git('add', 'b.txt')
    repo.write('new/u.txt', 'untracked\n')
    repo.git('stash', 'push', '-q', '-u')
    const sha = stashShas(repo)[0] ?? ''

    const value = await readStashFiles(runner(), repo.root, sha)

    expect(value.sha).toBe(sha)
    expect(value.parentSha).toBe(head)
    expect(value.untrackedSha).toBe(repo.git('rev-parse', `${sha}^3`).trim())
    expect(value.files.map(({ path, status, parentSha }) => ({ path, status, parentSha }))).toEqual([
      { path: 'a.txt', status: 'M', parentSha: head },
      { path: 'b.txt', status: 'M', parentSha: head },
    ])
    expect(value.untracked.map(({ path, status }) => ({ path, status }))).toEqual([{ path: 'new/u.txt', status: 'A' }])

    const tracked = await readDiff(runner(), repo.root, { path: 'a.txt', scope: 'commit', sha, parent: value.parentSha })
    expect(tracked.status).toBe('M')
    expect(tracked.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))).toEqual(
      expect.arrayContaining(['a', 'a changed']),
    )
    const untracked = await readDiff(runner(), repo.root, {
      path: 'new/u.txt',
      scope: 'commit',
      sha: value.untrackedSha ?? '',
    })
    expect(untracked.status).toBe('A')
    expect(untracked.oldPath).toBeNull()
    expect(untracked.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))).toEqual(['untracked'])
  })

  it('reports untrackedSha null for a tracked-only stash', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'a changed\n')
    repo.git('stash', 'push', '-q')
    const value = await readStashFiles(runner(), repo.root, stashShas(repo)[0] ?? '')
    expect(value.untrackedSha).toBeNull()
    expect(value.untracked).toEqual([])
    expect(value.files.map((file) => file.path)).toEqual(['a.txt'])
  })

  it('rejects a malformed sha and a commit that is not a stash', async () => {
    const repo = baseRepo()
    const head = repo.git('rev-parse', 'HEAD').trim()
    expect((await failureOf(readStashFiles(runner(), repo.root, 'stash@{0}'))).code).toBe('git/invalid-payload')
    expect((await failureOf(readStashFiles(runner(), repo.root, head))).code).toBe('git/invalid-payload')
  })
})

describe('stashCreateOperation', () => {
  it('validates the payload', () => {
    const op = stashCreateOperation
    const base = { sessionId: 's', requestId: 'r', includeUntracked: false, keepIndex: false }
    expect(codeOf(() => op.parse(base))).toBe('ok')
    expect(codeOf(() => op.parse({ ...base, message: 'm' }))).toBe('ok')
    expect(codeOf(() => op.parse({ ...base, includeUntracked: 'yes' }))).toBe('git/invalid-payload')
    expect(codeOf(() => op.parse({ ...base, keepIndex: undefined }))).toBe('git/invalid-payload')
    expect(codeOf(() => op.parse({ ...base, message: 42 }))).toBe('git/invalid-payload')
    expect(codeOf(() => op.parse({ ...base, message: 'a\0b' }))).toBe('git/invalid-payload')
    expect(codeOf(() => op.parse({ ...base, message: 'x'.repeat(5000) }))).toBe('git/invalid-payload')
  })

  it('stashes tracked changes with a generated default message and keeps untracked files', async () => {
    const repo = baseRepo()
    const short = repo.git('rev-parse', '--short', 'HEAD').trim()
    repo.write('a.txt', 'a changed\n')
    repo.write('u.txt', 'u\n')

    const value = await create(repo)

    expect(value.message).toBe(`WIP on main: ${short} base files`)
    expect(value.sha).toBe(stashShas(repo)[0])
    expect(porcelain(repo)).toEqual(['?? u.txt'])
    const listed = await readStashList(runner(), repo.root)
    expect(listed.entries[0]).toMatchObject({ sha: value.sha, branch: 'main', message: value.message })
  })

  it('uses a detached default message and passes a dash-leading custom message verbatim', async () => {
    const repo = baseRepo()
    const short = repo.git('rev-parse', '--short', 'HEAD').trim()
    repo.git('checkout', '-q', '--detach')
    repo.write('a.txt', 'a changed\n')
    expect((await create(repo)).message).toBe(`WIP on (no branch): ${short} base files`)

    repo.git('checkout', '-q', 'main')
    repo.write('b.txt', 'b changed\n')
    const custom = await create(repo, { message: '  --keep-index and more  ' })
    expect(custom.message).toBe('--keep-index and more')
    expect(repo.git('stash', 'list', '-1', '--format=%gs').trim()).toBe('On main: --keep-index and more')
    expect((await readStashList(runner(), repo.root)).entries[0]?.message).toBe('--keep-index and more')
    expect(read(repo, 'b.txt')).toBe('b\n')
  })

  it('includes untracked files with includeUntracked and keeps the index with keepIndex', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'a staged\n')
    repo.git('add', 'a.txt')
    repo.write('b.txt', 'b unstaged\n')
    repo.write('u.txt', 'u\n')

    const value = await create(repo, { includeUntracked: true, keepIndex: true })

    expect(porcelain(repo)).toEqual(['M  a.txt'])
    expect(existsSync(join(repo.root, 'u.txt'))).toBe(false)
    const files = await readStashFiles(runner(), repo.root, value.sha)
    expect(files.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
    expect(files.untracked.map((file) => file.path)).toEqual(['u.txt'])
  })

  it('reports nothing-to-stash on a clean tree and for untracked-only changes without includeUntracked', async () => {
    const repo = baseRepo()
    const clean = await failureOf(create(repo))
    expect(clean.code).toBe('git/invalid-payload')
    expect(clean.details).toMatchObject({ reason: 'nothing-to-stash' })

    repo.write('u.txt', 'u\n')
    const untrackedOnly = await failureOf(create(repo))
    expect(untrackedOnly.details).toMatchObject({ reason: 'nothing-to-stash' })
    expect(stashShas(repo)).toEqual([])

    const withUntracked = await create(repo, { includeUntracked: true })
    expect(stashShas(repo)).toEqual([withUntracked.sha])
  })
})

describe('stashApplyOperation', () => {
  it('validates the payload', () => {
    const op = stashApplyOperation
    expect(codeOf(() => op.parse({ sha: 'a'.repeat(40), pop: true }))).toBe('ok')
    expect(codeOf(() => op.parse({ sha: 'stash@{0}', pop: true }))).toBe('git/invalid-payload')
    expect(codeOf(() => op.parse({ sha: 'a'.repeat(40) }))).toBe('git/invalid-payload')
  })

  it('apply restores changes and the index and keeps the stash; pop drops it', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'a staged\n')
    repo.git('add', 'a.txt')
    repo.write('b.txt', 'b unstaged\n')
    repo.write('u.txt', 'u\n')
    repo.git('stash', 'push', '-q', '-u')
    const sha = stashShas(repo)[0] ?? ''

    expect(await apply(repo, sha, false)).toEqual({ sha, dropped: false, indexRestored: true })
    expect(porcelain(repo)).toEqual(['M  a.txt', ' M b.txt', '?? u.txt'].sort())
    expect(stashShas(repo)).toEqual([sha])

    repo.git('reset', '-q', '--hard')
    repo.git('clean', '-fq')
    expect(await apply(repo, sha, true)).toEqual({ sha, dropped: true, indexRestored: true })
    expect(porcelain(repo)).toEqual(['M  a.txt', ' M b.txt', '?? u.txt'].sort())
    expect(stashShas(repo)).toEqual([])
  })

  it('falls back to content-only when the index cannot be restored', async () => {
    const repo = baseRepo()
    const lines = (first: string, third: string): string => `${first}\n2\n${third}\n4\n5\n6\n`
    repo.write('c.txt', lines('1', '3'))
    repo.commit('c')
    repo.write('c.txt', lines('one', '3'))
    repo.git('add', 'c.txt')
    repo.git('stash', 'push', '-q')
    const sha = stashShas(repo)[0] ?? ''
    // Line 3 changes on HEAD: the staged patch's context no longer matches (index restore fails),
    // while the three-way content merge of line 1 is still clean.
    repo.write('c.txt', lines('1', 'three'))
    repo.commit('line 3 moves on')

    const value = await apply(repo, sha, true)

    expect(value).toEqual({ sha, dropped: true, indexRestored: false })
    expect(read(repo, 'c.txt')).toBe(lines('one', 'three'))
    expect(stashShas(repo)).toEqual([])
  })

  it('pop on conflict reports git/conflict with stashKept and never drops the stash', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'stashed\n')
    repo.git('stash', 'push', '-q')
    const sha = stashShas(repo)[0] ?? ''
    repo.write('a.txt', 'committed\n')
    repo.commit('conflicting change')

    const failure = await failureOf(apply(repo, sha, true))

    expect(failure.code).toBe('git/conflict')
    expect(failure.details).toMatchObject({ stashKept: true })
    expect(stashShas(repo)).toEqual([sha])
    expect(repo.git('diff', '--name-only', '--diff-filter=U').trim()).toBe('a.txt')
  })

  it('refuses when local changes would be overwritten and keeps the stash', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'stashed\n')
    repo.git('stash', 'push', '-q')
    const sha = stashShas(repo)[0] ?? ''
    repo.write('a.txt', 'local\n')

    const failure = await failureOf(apply(repo, sha, true))

    expect(failure.code).toBe('git/would-overwrite')
    expect(failure.details).toMatchObject({ paths: ['a.txt'], stashKept: true })
    expect(read(repo, 'a.txt')).toBe('local\n')
    expect(stashShas(repo)).toEqual([sha])
  })

  it('refuses when an untracked file of the stash already exists', async () => {
    const repo = baseRepo()
    repo.write('u.txt', 'stashed\n')
    repo.git('stash', 'push', '-q', '-u')
    const sha = stashShas(repo)[0] ?? ''
    repo.write('u.txt', 'local\n')

    const failure = await failureOf(apply(repo, sha, true))

    expect(failure.code).toBe('git/would-overwrite')
    expect(failure.details).toMatchObject({ untracked: ['u.txt'], stashKept: true })
    expect(read(repo, 'u.txt')).toBe('local\n')
    expect(stashShas(repo)).toEqual([sha])
  })

  it('refuses while conflicts from an earlier apply are unresolved, and inside an open merge', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'stashed\n')
    repo.git('stash', 'push', '-q')
    repo.write('b.txt', 'second\n')
    repo.git('stash', 'push', '-q')
    const [second = '', first = ''] = stashShas(repo)
    repo.write('a.txt', 'committed\n')
    repo.commit('conflicting change')
    expect((await failureOf(apply(repo, first, false))).code).toBe('git/conflict')

    const again = await failureOf(apply(repo, second, true))
    expect(again.code).toBe('git/conflict')
    expect(again.message).toBe('resolve the existing conflicts first')
    expect(stashShas(repo)).toEqual([second, first])

    repo.git('reset', '-q', '--hard')
    repo.git('checkout', '-q', '-b', 'side')
    repo.write('side.txt', 'side\n')
    repo.commit('side')
    repo.git('checkout', '-q', 'main')
    repo.git('merge', '-q', '--no-ff', '--no-commit', 'side')
    expect((await failureOf(apply(repo, second, false))).code).toBe('git/operation-in-progress')
    expect((await failureOf(create(repo))).code).toBe('git/operation-in-progress')
    expect(repo.gitResult('rev-parse', '-q', '--verify', 'MERGE_HEAD').status).toBe(0)
  })

  it('a stash that is gone is git/stale-target', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'x\n')
    repo.git('stash', 'push', '-q')
    const sha = stashShas(repo)[0] ?? ''
    repo.git('stash', 'drop', '-q')
    const failure = await failureOf(apply(repo, sha, false))
    expect(failure.code).toBe('git/stale-target')
    expect(failure.details).toMatchObject({ target: 'stash', expected: sha })
  })

  it('pop of the pending smart stash removes the marker; apply keeps it', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'x\n')
    repo.git('stash', 'push', '-q')
    const sha = stashShas(repo)[0] ?? ''
    writeMarker(repo, sha)

    await apply(repo, sha, false)
    expect(hasRef(repo, PENDING_STASH_REF)).toBe(true)
    repo.git('reset', '-q', '--hard')

    await apply(repo, sha, true)
    expect(hasRef(repo, PENDING_STASH_REF)).toBe(false)
    expect(hasRef(repo, PENDING_STASH_META_REF)).toBe(false)
  })
})

describe('stashDropOperation', () => {
  it('drops the right entry by sha after the list shifted; a gone stash is git/stale-target', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'one\n')
    repo.git('stash', 'push', '-q', '-m', 'one')
    repo.write('a.txt', 'two\n')
    repo.git('stash', 'push', '-q', '-m', 'two')
    const one = stashShas(repo)[1] ?? ''
    const two = stashShas(repo)[0] ?? ''
    // The client saw `one` as stash@{1}; a new stash moves it to stash@{2}.
    repo.write('a.txt', 'three\n')
    repo.git('stash', 'push', '-q', '-m', 'three')
    const three = stashShas(repo)[0] ?? ''

    expect(await drop(repo, one)).toEqual({ sha: one })
    expect(stashShas(repo)).toEqual([three, two])

    const gone = await failureOf(drop(repo, one))
    expect(gone.code).toBe('git/stale-target')
    expect(gone.details).toMatchObject({ target: 'stash', expected: one })
    expect(stashShas(repo)).toEqual([three, two])
  })

  it('removes the pending marker only when its stash is dropped', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'one\n')
    repo.git('stash', 'push', '-q')
    repo.write('a.txt', 'two\n')
    repo.git('stash', 'push', '-q')
    const [newer = '', older = ''] = stashShas(repo)
    writeMarker(repo, older)

    await drop(repo, newer)
    expect(hasRef(repo, PENDING_STASH_REF)).toBe(true)

    await drop(repo, older)
    expect(hasRef(repo, PENDING_STASH_REF)).toBe(false)
    expect(hasRef(repo, PENDING_STASH_META_REF)).toBe(false)
  })
})

describe('drop races (scripted git)', () => {
  const wanted = 'a'.repeat(40)
  const other = 'b'.repeat(40)
  const parent = 'c'.repeat(40)
  const listLine = (sha: string): string => `${sha}\0${parent} ${'d'.repeat(40)}\0On main: x\0${'2026-10-26T00:00:00Z'}\n`

  /** A stash list that the scripted `stash drop` changes to `afterDrop`. */
  function scripted(afterDrop: string[], dropStdout = '') {
    let listed = [other, wanted]
    return scriptedContext((args) => {
      if (args[0] === 'stash' && args[1] === 'list') return { stdout: listed.map(listLine).join('') }
      if (args[0] === 'stash' && args[1] === 'drop') {
        listed = afterDrop
        return { stdout: dropStdout }
      }
      if (args[0] === 'log') return { stdout: 'On main: theirs\n' }
      if (args[0] === 'rev-parse') return { exitCode: 1 }
      return {}
    })
  }

  it('decides from the list, not the output: the wrong entry is stored back and the drop is git/stale-target', async () => {
    // Another stash moved the indices between list and drop: `other` was dropped instead.
    const { ctx, calls } = scripted([wanted], `Dropped stash@{1} (${wanted})\n`)

    const failure = await failureOf(stashDropOperation.run(ctx, { sha: wanted }))

    expect(failure.code).toBe('git/stale-target')
    const store = calls.find((args) => args[0] === 'stash' && args[1] === 'store')
    expect(store).toEqual(['stash', 'store', '--message=On main: theirs', other])
  })

  it('treats unreadable drop output as success when the list confirms the drop', async () => {
    const { ctx, calls } = scripted([other], 'something git 3.x might print\n')
    expect(await stashDropOperation.run(ctx, { sha: wanted })).toEqual({ sha: wanted })
    expect(calls.some((args) => args[0] === 'stash' && args[1] === 'store')).toBe(false)
  })

  it('pop keeps the applied changes and reports dropped false when the drop hit another entry', async () => {
    const { ctx, calls } = scripted([wanted])

    const value = await stashApplyOperation.run(ctx, { sha: wanted, pop: true })

    expect(value).toEqual({ sha: wanted, dropped: false, indexRestored: true })
    expect(calls.some((args) => args[0] === 'stash' && args[1] === 'store')).toBe(true)
  })
})

describe('pop whose drop fails after a successful apply', () => {
  it('succeeds with dropped false and keeps the stash listed', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'stashed\n')
    repo.git('stash', 'push', '-q')
    const sha = stashShas(repo)[0] ?? ''
    const real = contextFor(repo)
    const ctx: WriteContext = {
      ...real,
      git: async (argv, options) =>
        argv.includes('drop')
          ? { exitCode: 1, stdout: '', stderr: 'error: simulated drop failure' }
          : await real.git(argv, options),
    }

    const value = await stashApplyOperation.run(ctx, { sha, pop: true })

    expect(value).toEqual({ sha, dropped: false, indexRestored: true })
    expect(read(repo, 'a.txt')).toBe('stashed\n')
    expect(stashShas(repo)).toEqual([sha])
  })

  it('a normal pop still drops', async () => {
    const repo = baseRepo()
    repo.write('a.txt', 'stashed\n')
    repo.git('stash', 'push', '-q')
    const sha = stashShas(repo)[0] ?? ''
    expect(await apply(repo, sha, true)).toEqual({ sha, dropped: true, indexRestored: true })
    expect(stashShas(repo)).toEqual([])
  })
})
