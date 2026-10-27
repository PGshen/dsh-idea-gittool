// B3a T1/T3: payload validation and execution of the interactiveRebase write endpoint.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RebaseEntry } from '../../src/shared/protocol.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { interactiveRebaseOperation } from '../../src/host/git/interactive-rebase.ts'
import { readOperationState } from '../../src/host/git/operation.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { contextFor } from './remote-fixtures.ts'

vi.setConfig({ testTimeout: 60_000 })

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 's',
    requestId: 'r-1',
    base: SHA_A,
    head: SHA_C,
    entries: [
      { sha: SHA_B, action: 'pick' },
      { sha: SHA_C, action: 'reword', message: 'new message' },
    ],
    ...overrides,
  }
}

function rejection(input: Record<string, unknown>): GitCommandFailure {
  try {
    interactiveRebaseOperation.parse(input)
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected parse to reject')
}

describe('interactiveRebaseOperation.parse', () => {
  it('accepts a well-formed request and defaults the flags', () => {
    expect(interactiveRebaseOperation.parse(payload())).toEqual({
      base: SHA_A,
      head: SHA_C,
      entries: [
        { sha: SHA_B, action: 'pick' },
        { sha: SHA_C, action: 'reword', message: 'new message' },
      ],
      updateRefs: false,
      stash: false,
    })
  })

  it('accepts base null (from the root) and keeps updateRefs / stash', () => {
    const input = interactiveRebaseOperation.parse(payload({ base: null, updateRefs: true, stash: true }))
    expect(input).toMatchObject({ base: null, updateRefs: true, stash: true })
  })

  it.each([
    ['base starting with a dash', { base: '--exec=x' }],
    ['base not a string', { base: 42 }],
    ['base missing', { base: undefined }],
    ['head not a full sha', { head: 'abc123' }],
    ['entries empty', { entries: [] }],
    ['entries not an array', { entries: 'pick' }],
    ['abbreviated entry sha', { entries: [{ sha: 'abcdef1', action: 'pick' }] }],
    ['unknown action', { entries: [{ sha: SHA_B, action: 'exec' }] }],
    ['reword without message', { entries: [{ sha: SHA_B, action: 'reword' }] }],
    ['reword with blank message', { entries: [{ sha: SHA_B, action: 'reword', message: ' \n ' }] }],
    ['message not a string', { entries: [{ sha: SHA_B, action: 'pick', message: 1 }] }],
    ['duplicate sha', { entries: [{ sha: SHA_B, action: 'pick' }, { sha: SHA_B, action: 'drop' }] }],
  ])('rejects %s with git/invalid-payload', (_name, overrides) => {
    expect(rejection(payload(overrides)).code).toBe('git/invalid-payload')
  })
})

// ---------------------------------------------------------------------------
// T3: execution against real repositories
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRepo(): TempRepo {
  const repo = createTempRepo()
  cleanups.push(repo.cleanup)
  return repo
}

/** initial commit + c1..c<count>, each adding f<i>.txt; author dates are fixed and distinct. */
function linear(repo: TempRepo, count: number): string[] {
  const shas: string[] = []
  for (let index = 1; index <= count; index += 1) {
    repo.write(`f${String(index)}.txt`, `${String(index)}\n`)
    repo.git('add', '-A')
    repo.git(
      '-c', 'user.name=Author', '-c', 'user.email=author@example.com',
      'commit', '-q', '-m', `c${String(index)}`, `--date=2020-01-0${String(index)}T10:00:00Z`,
    )
    shas.push(repo.git('rev-parse', 'HEAD').trim())
  }
  return shas
}

const runner = createGitRunner(createFakeSubprocess())

async function rebase(repo: TempRepo, base: string | null, entries: RebaseEntry[], extra: Record<string, unknown> = {}) {
  const ctx = contextFor(repo)
  const head = repo.git('rev-parse', 'HEAD').trim()
  const input = interactiveRebaseOperation.parse({ sessionId: 's', requestId: 'r', base, head, entries, ...extra })
  return await interactiveRebaseOperation.run(ctx, input)
}

function subjects(repo: TempRepo, range = 'HEAD'): string[] {
  return repo.git('log', '--reverse', '--format=%s', range).trim().split('\n')
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error.code
    throw error
  }
  throw new Error('expected a failure')
}

describe('interactiveRebaseOperation.run', () => {
  it('rewords one commit, keeping its tree, author and author date', async () => {
    const repo = makeRepo()
    const [, c2] = linear(repo, 3)
    const base = repo.git('rev-parse', 'HEAD~3').trim()
    const before = repo.git('rev-parse', 'HEAD^{tree}').trim()
    const plan = repo.git('rev-list', '--reverse', `${base}..HEAD`).trim().split('\n')
    const value = await rebase(repo, base, plan.map(sha => (sha === c2 ? { sha, action: 'reword', message: 'c2 renamed' } : { sha, action: 'pick' })))
    expect(value).toMatchObject({ completed: true, head: repo.git('rev-parse', 'HEAD').trim() })
    expect(value.stop).toBeUndefined()
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['c1', 'c2 renamed', 'c3'])
    expect(repo.git('rev-parse', 'HEAD^{tree}').trim()).toBe(before)
    expect(repo.git('log', '-1', '--format=%an <%ae> %aI', 'HEAD~1').trim()).toBe('Author <author@example.com> 2020-01-02T10:00:00Z')
  })

  it('rewords HEAD itself', async () => {
    const repo = makeRepo()
    const [c1] = linear(repo, 1)
    await rebase(repo, repo.git('rev-parse', 'HEAD~1').trim(), [{ sha: c1 ?? '', action: 'reword', message: 'only' }])
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('only')
  })

  it('writes messages with shell metacharacters, newlines and # lines verbatim', async () => {
    const repo = makeRepo()
    const [c1] = linear(repo, 1)
    const marker = join(repo.root, 'pwned')
    const message = `quote " ' $(touch ${marker}) \`touch ${marker}\`\n\n# kept line\n中文 $HOME`
    await rebase(repo, repo.git('rev-parse', 'HEAD~1').trim(), [{ sha: c1 ?? '', action: 'reword', message }])
    expect(repo.git('log', '-1', '--format=%B').replace(/\n+$/u, '')).toBe(message)
    expect(existsSync(marker)).toBe(false)
  })

  it('drops, reorders and squashes with a final message', async () => {
    const repo = makeRepo()
    const [c1, c2, c3, c4] = linear(repo, 4)
    const base = repo.git('rev-parse', 'HEAD~4').trim()
    await rebase(repo, base, [
      { sha: c3 ?? '', action: 'pick', message: 'c3+c1' },
      { sha: c1 ?? '', action: 'squash' },
      { sha: c4 ?? '', action: 'pick' },
      { sha: c2 ?? '', action: 'drop' },
    ])
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['c3+c1', 'c4'])
    expect(repo.git('ls-tree', '--name-only', 'HEAD').trim().split('\n').sort()).toEqual(['README.md', 'f1.txt', 'f3.txt', 'f4.txt'])
    expect(repo.git('ls-tree', '--name-only', 'HEAD~1').trim().split('\n').sort()).toEqual(['README.md', 'f1.txt', 'f3.txt'])
  })

  it('keeps the head message of a fixup chain', async () => {
    const repo = makeRepo()
    const [c1, c2, c3] = linear(repo, 3)
    const base = repo.git('rev-parse', 'HEAD~3').trim()
    await rebase(repo, base, [
      { sha: c1 ?? '', action: 'pick' }, { sha: c2 ?? '', action: 'fixup' }, { sha: c3 ?? '', action: 'fixup' },
    ])
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['c1'])
    expect(repo.git('log', '-1', '--format=%B').trim()).toBe('c1')
  })

  it('rebases from the root when base is null', async () => {
    const repo = makeRepo()
    linear(repo, 1)
    const [root, c1] = repo.git('rev-list', '--reverse', 'HEAD').trim().split('\n')
    await rebase(repo, null, [{ sha: c1 ?? '', action: 'pick' }, { sha: root ?? '', action: 'reword', message: 'root renamed' }])
    expect(subjects(repo)).toEqual(['c1', 'root renamed'])
  })

  it('moves other branches with updateRefs and leaves them without it', async () => {
    const repo = makeRepo()
    const [c1, c2] = linear(repo, 2)
    repo.git('branch', 'mid', c1 ?? '')
    const base = repo.git('rev-parse', 'HEAD~2').trim()
    await rebase(repo, base, [{ sha: c1 ?? '', action: 'reword', message: 'c1 new' }, { sha: c2 ?? '', action: 'pick' }], { updateRefs: true })
    expect(repo.git('log', '-1', '--format=%s', 'mid').trim()).toBe('c1 new')
    const [d1, d2] = repo.git('rev-list', '--reverse', `${base}..HEAD`).trim().split('\n')
    await rebase(repo, base, [{ sha: d1 ?? '', action: 'reword', message: 'c1 newer' }, { sha: d2 ?? '', action: 'pick' }])
    expect(repo.git('log', '-1', '--format=%s', 'mid').trim()).toBe('c1 new')
  })

  it('stops at an edit (git exits 0), reports rebaseStop, then finishes on continue with later execs', async () => {
    const repo = makeRepo()
    const [c1, c2] = linear(repo, 2)
    const base = repo.git('rev-parse', 'HEAD~2').trim()
    const value = await rebase(repo, base, [{ sha: c1 ?? '', action: 'edit' }, { sha: c2 ?? '', action: 'reword', message: 'after edit' }])
    expect(value).toMatchObject({ completed: false, stop: 'edit' })
    expect((await readOperationState(runner, repo.root)).rebaseStop).toBe('edit')
    repo.git('-c', 'core.editor=true', 'rebase', '--continue')
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['c1', 'after edit'])
  })

  it('stops on a conflict and reports rebaseStop conflict', async () => {
    const repo = makeRepo()
    repo.write('same.txt', 'one\n')
    const first = repo.commit('one')
    repo.write('same.txt', 'two\n')
    const second = repo.commit('two')
    const base = repo.git('rev-parse', 'HEAD~2').trim()
    const value = await rebase(repo, base, [{ sha: second, action: 'pick' }, { sha: first, action: 'pick' }])
    expect(value).toMatchObject({ completed: false, stop: 'conflict' })
    const state = await readOperationState(runner, repo.root)
    expect(state.operation).toBe('rebase')
    expect(state.rebaseStop).toBe('conflict')
  })

  it('reports exec-failed when writing a message back fails', async () => {
    const repo = makeRepo()
    const [c1] = linear(repo, 1)
    const ctx = contextFor(repo)
    const head = repo.git('rev-parse', 'HEAD').trim()
    const input = interactiveRebaseOperation.parse({
      sessionId: 's', requestId: 'r', base: repo.git('rev-parse', 'HEAD~1').trim(), head,
      entries: [{ sha: c1, action: 'reword', message: 'x' }],
    })
    const failing: typeof ctx = {
      ...ctx,
      git: async (argv, options) => {
        // Corrupt the stored message blob id so `git cat-file blob <id>` fails inside the exec line.
        if (argv.includes('hash-object')) return { ...(await ctx.git(argv, options)), stdout: `${'0'.repeat(40)}\n` }
        return await ctx.git(argv, options)
      },
    }
    const value = await interactiveRebaseOperation.run(failing, input)
    expect(value).toMatchObject({ completed: false, stop: 'exec-failed' })
    expect((await readOperationState(runner, repo.root)).rebaseStop).toBe('exec-failed')
  })

  it('refuses a moved HEAD, a non-permutation, a blocked plan and an operation in progress', async () => {
    const repo = makeRepo()
    const [c1, c2] = linear(repo, 2)
    const base = repo.git('rev-parse', 'HEAD~2').trim()
    const ctx = contextFor(repo)
    const entries: RebaseEntry[] = [{ sha: c1 ?? '', action: 'pick' }, { sha: c2 ?? '', action: 'drop' }]
    const stale = interactiveRebaseOperation.parse({ sessionId: 's', requestId: 'r', base, head: c1, entries })
    expect(await failureCode(interactiveRebaseOperation.run(ctx, stale))).toBe('git/stale-target')
    expect(await failureCode(rebase(repo, base, [{ sha: c1 ?? '', action: 'pick' }]))).toBe('git/invalid-payload')
    expect(await failureCode(rebase(repo, base, [{ sha: c1 ?? '', action: 'fixup' }, { sha: c2 ?? '', action: 'pick' }]))).toBe('git/invalid-payload')
    repo.git('checkout', '-q', '--detach')
    expect(await failureCode(rebase(repo, base, entries))).toBe('git/invalid-payload')
    repo.git('checkout', '-q', 'main')
    repo.write('f1.txt', 'conflict\n')
    repo.commit('conflicting')
    repo.gitResult('cherry-pick', c1 ?? '')
    expect(await failureCode(rebase(repo, repo.git('rev-parse', 'HEAD~1').trim(), [{ sha: repo.git('rev-parse', 'HEAD').trim(), action: 'pick' }]))).toBe('git/operation-in-progress')
  })

  it('refuses tracked changes without stash and restores them with stash', async () => {
    const repo = makeRepo()
    const [c1, c2] = linear(repo, 2)
    const base = repo.git('rev-parse', 'HEAD~2').trim()
    repo.write('f1.txt', 'dirty\n')
    const entries: RebaseEntry[] = [{ sha: c2 ?? '', action: 'pick' }, { sha: c1 ?? '', action: 'pick' }]
    expect(await failureCode(rebase(repo, base, entries))).toBe('git/dirty-worktree')
    const value = await rebase(repo, base, entries, { stash: true })
    expect(value).toMatchObject({ completed: true, stashRestored: true })
    expect(readFileSync(join(repo.root, 'f1.txt'), 'utf8')).toBe('dirty\n')
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['c2', 'c1'])
  })

  it('keeps the stash pending while stopped and reports it', async () => {
    const repo = makeRepo()
    const [c1, c2] = linear(repo, 2)
    const base = repo.git('rev-parse', 'HEAD~2').trim()
    repo.write('f1.txt', 'dirty\n')
    const value = await rebase(repo, base, [{ sha: c1 ?? '', action: 'edit' }, { sha: c2 ?? '', action: 'pick' }], { stash: true })
    expect(value).toMatchObject({ completed: false, stop: 'edit', stashKept: true })
    expect((await readOperationState(runner, repo.root)).pendingStash).toBe(true)
  })
})
