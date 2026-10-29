// B3c T1/T2: shelf — save chosen changes under a name in restricted refs, roll them back, apply them again.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SHELF_REF_PREFIX } from '../../src/shared/protocol.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import { readShelfList, readShelfPatch, shelfApplyOperation, shelfCreateOperation, shelfDropOperation } from '../../src/host/git/shelf.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { contextFor } from './remote-fixtures.ts'
import { gitTestSupports } from './git-binary.ts'

vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const run = createGitRunner(createFakeSubprocess())

function makeRepo(): TempRepo {
  const repo = createTempRepo()
  cleanups.push(repo.cleanup)
  repo.write('a.txt', 'a\n')
  repo.write('b.txt', 'b\n')
  repo.write('keep.txt', 'keep\n')
  repo.write('bin.dat', 'x\0y\n')
  repo.commit('base')
  return repo
}

const write = async <I, V>(operation: { parse(payload: unknown): I; run(ctx: ReturnType<typeof contextFor>, input: I): Promise<V> }, repo: TempRepo, payload: Record<string, unknown>): Promise<V> =>
  await operation.run(contextFor(repo), operation.parse({ sessionId: 's', requestId: 'r', ...payload }))

async function failureOf(promise: Promise<unknown>): Promise<GitCommandFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected a failure')
}

/**
 * A three-way apply. git < 2.43 has no `merge-file --object-id`: assert that the Host refuses it and
 * answer null, so a compatibility run checks the refusal instead (B4d T5).
 */
async function applyThreeWay(repo: TempRepo, payload: Record<string, unknown>): Promise<Awaited<ReturnType<typeof shelfApplyOperation.run>> | null> {
  if (gitTestSupports('mergeFileObjectId')) return await write(shelfApplyOperation, repo, { ...payload, threeWay: true })
  expect(await failureOf(write(shelfApplyOperation, repo, { ...payload, threeWay: true }))).toMatchObject({ code: 'git/unsupported-version' })
  return null
}

const read = (repo: TempRepo, path: string): string => readFileSync(join(repo.root, path), 'utf8')

/** Two modified files (one staged), a binary change, an untracked file, and a change that stays. */
function dirty(repo: TempRepo): void {
  repo.write('a.txt', 'a changed\n')
  repo.write('b.txt', 'b staged\n')
  repo.git('add', 'b.txt')
  writeFileSync(join(repo.root, 'bin.dat'), 'x\0z\n')
  repo.write('new file.txt', 'brand new\n')
  repo.write('keep.txt', 'keep changed\n')
}

describe('shelfCreate', () => {
  it('saves the chosen paths, rolls only them back, and lists the entry', async () => {
    const repo = makeRepo()
    dirty(repo)
    const value = await write(shelfCreateOperation, repo, { name: '调试 "日志"\n第二行', paths: ['a.txt', 'b.txt', 'bin.dat', 'new file.txt'] })
    expect(value.entry).toMatchObject({ name: '调试 "日志"\n第二行', branch: 'main' })
    expect(value.entry.files.map(file => [file.path, file.status])).toEqual([
      ['a.txt', 'M'], ['b.txt', 'M'], ['bin.dat', 'M'], ['new file.txt', '?'],
    ])
    expect(read(repo, 'a.txt')).toBe('a\n')
    expect(read(repo, 'b.txt')).toBe('b\n')
    expect(existsSync(join(repo.root, 'new file.txt'))).toBe(false)
    expect(read(repo, 'keep.txt')).toBe('keep changed\n')
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('')
    expect(repo.git('for-each-ref', '--format=%(refname)', SHELF_REF_PREFIX).trim()).toBe(`${SHELF_REF_PREFIX}${value.entry.id}`)
    expect(repo.git('stash', 'list').trim()).toBe('')
    const list = await readShelfList(run, repo.root)
    expect(list.map(entry => entry.id)).toEqual([value.entry.id])
  })

  it('restores exactly what was shelved, binary and untracked included; the preview is a readable diff', async () => {
    const repo = makeRepo()
    dirty(repo)
    const { entry } = await write(shelfCreateOperation, repo, { name: 'x', paths: ['a.txt', 'bin.dat', 'new file.txt'] })
    const patch = await readShelfPatch(run, repo.root, entry.id)
    expect(patch).toContain('a.txt')
    expect(patch).toContain('+a changed')
    await write(shelfApplyOperation, repo, { id: entry.id })
    expect(read(repo, 'a.txt')).toBe('a changed\n')
    expect(readFileSync(join(repo.root, 'bin.dat'))).toEqual(Buffer.from('x\0z\n'))
    expect(read(repo, 'new file.txt')).toBe('brand new\n')
    expect(repo.git('status', '--porcelain', '--', 'new file.txt').trim()).toBe('?? "new file.txt"')
  })

  it('keeps non-UTF-8 bytes, ignores textconv and diff.noprefix (review C2)', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo.root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    repo.write('.gitattributes', '*.up diff=upper\n')
    repo.write('doc.up', 'docx1\n')
    repo.commit('more')
    repo.git('config', 'diff.upper.textconv', 'tr a-z A-Z')
    repo.git('config', 'diff.noprefix', 'true')
    writeFileSync(join(repo.root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a]))
    repo.write('doc.up', 'docx2\n')
    const { entry } = await write(shelfCreateOperation, repo, { name: 'x', paths: ['latin.txt', 'doc.up'] })
    expect(readFileSync(join(repo.root, 'latin.txt'))).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    await write(shelfApplyOperation, repo, { id: entry.id })
    expect(readFileSync(join(repo.root, 'latin.txt'))).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a]))
    expect(read(repo, 'doc.up')).toBe('docx2\n')
  })

  it('keeps staged-only and partially staged states (review I2)', async () => {
    const repo = makeRepo()
    repo.write('staged-new.txt', 'staged\n')
    repo.git('add', 'staged-new.txt')
    rmSync(join(repo.root, 'staged-new.txt'))
    repo.write('a.txt', 'a staged\n')
    repo.git('add', 'a.txt')
    repo.write('a.txt', 'a staged\na worktree\n')
    const { entry } = await write(shelfCreateOperation, repo, { name: 'x', paths: ['staged-new.txt', 'a.txt'] })
    expect(repo.git('status', '--porcelain').trim()).toBe('')
    await write(shelfApplyOperation, repo, { id: entry.id })
    expect(repo.git('show', ':a.txt')).toBe('a staged\n')
    expect(read(repo, 'a.txt')).toBe('a staged\na worktree\n')
    expect(repo.git('show', ':staged-new.txt')).toBe('staged\n')
    expect(existsSync(join(repo.root, 'staged-new.txt'))).toBe(false)
  })

  it('refuses to shelve in a repository without commits (review I3)', async () => {
    const repo = createTempRepo({ initialCommit: false })
    cleanups.push(repo.cleanup)
    repo.write('x.txt', 'x\n')
    repo.git('add', 'x.txt')
    const failure = await failureOf(write(shelfCreateOperation, repo, { name: 'x', paths: ['x.txt'] }))
    expect(failure.details).toMatchObject({ reason: 'no-head' })
    expect(repo.git('for-each-ref', SHELF_REF_PREFIX).trim()).toBe('')
  })

  it('aborts without rolling back when a file changes between capture and rollback (review I4)', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'first\n')
    const ctx = contextFor(repo)
    const racing: typeof ctx = {
      ...ctx,
      git: async (argv, options) => {
        const result = await ctx.git(argv, options)
        // The Agent edits the file right after it was captured.
        if (argv.includes('hash-object') && argv.includes('-w') && argv.includes('a.txt')) repo.write('a.txt', 'agent edit\n')
        return result
      },
    }
    const input = shelfCreateOperation.parse({ sessionId: 's', requestId: 'r', name: 'x', paths: ['a.txt'] })
    const failure = await failureOf(shelfCreateOperation.run(racing, input))
    expect(failure.code).toBe('git/stale-target')
    expect(read(repo, 'a.txt')).toBe('agent edit\n')
    expect(repo.git('for-each-ref', SHELF_REF_PREFIX).trim()).toBe('')
  })

  it('refuses paths without changes, option-like and escaping paths', async () => {
    const repo = makeRepo()
    expect((await failureOf(write(shelfCreateOperation, repo, { name: 'x', paths: ['a.txt'] }))).code).toBe('git/invalid-payload')
    expect((await failureOf(write(shelfCreateOperation, repo, { name: 'x', paths: ['../x'] }))).code).toBe('git/invalid-payload')
    expect((await failureOf(write(shelfCreateOperation, repo, { name: ' ', paths: ['a.txt'] }))).code).toBe('git/invalid-payload')
  })
})

describe('shelfApply and shelfDrop', () => {
  it('applies cleanly onto a clean tree and deletes the entry unless kept', async () => {
    const repo = makeRepo()
    dirty(repo)
    const { entry } = await write(shelfCreateOperation, repo, { name: 'x', paths: ['a.txt', 'b.txt', 'new file.txt'] })
    expect(await write(shelfApplyOperation, repo, { id: entry.id, keep: true })).toEqual({ applied: true, conflicts: [], kept: true })
    expect(read(repo, 'a.txt')).toBe('a changed\n')
    expect(read(repo, 'new file.txt')).toBe('brand new\n')
    expect((await readShelfList(run, repo.root)).length).toBe(1)
    repo.git('reset', '-q', '--hard')
    repo.git('clean', '-fq', '--', 'new file.txt')
    expect(await write(shelfApplyOperation, repo, { id: entry.id })).toMatchObject({ applied: true, kept: false })
    expect(await readShelfList(run, repo.root)).toEqual([])
  })

  it('refuses a patch that does not apply cleanly without touching files, then merges three-way on request', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a changed\n')
    const { entry } = await write(shelfCreateOperation, repo, { name: 'x', paths: ['a.txt'] })
    repo.write('a.txt', 'a different\n')
    const failure = await failureOf(write(shelfApplyOperation, repo, { id: entry.id }))
    expect(failure).toMatchObject({ code: 'git/conflict', details: { reason: 'shelf-not-clean' } })
    expect(read(repo, 'a.txt')).toBe('a different\n')
    repo.git('commit', '-qam', 'diverge')
    const merged = await applyThreeWay(repo, { id: entry.id, keep: true })
    if (merged === null) return
    expect(merged).toMatchObject({ applied: true, conflicts: ['a.txt'], kept: true })
    expect(read(repo, 'a.txt')).toContain('<<<<<<<')
  })

  it('refuses a three-way apply on git older than 2.43 before touching files (B4d T5)', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a changed\n')
    const { entry } = await write(shelfCreateOperation, repo, { name: 'x', paths: ['a.txt'] })
    repo.write('a.txt', 'a different\n')
    const real = contextFor(repo)
    const old: WriteContext = {
      ...real,
      git: async (argv, options) =>
        argv.includes('--version') ? { exitCode: 0, stdout: 'git version 2.42.0\n', stderr: '' } : await real.git(argv, options),
    }

    const failure = await failureOf(shelfApplyOperation.run(old, shelfApplyOperation.parse({ sessionId: 's', requestId: 'r', id: entry.id, threeWay: true })))

    expect(failure).toMatchObject({ code: 'git/unsupported-version', details: { current: '2.42.0', minimum: '2.43.0', feature: 'mergeFileObjectId' } })
    expect(read(repo, 'a.txt')).toBe('a different\n')
  })

  it('merges three-way over an unstaged local change and records the conflict as index stages (L4 finding)', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a changed\n')
    const { entry } = await write(shelfCreateOperation, repo, { name: 'x', paths: ['a.txt'] })
    repo.write('a.txt', 'a different\n')
    const merged = await applyThreeWay(repo, { id: entry.id, keep: true })
    if (merged === null) return
    expect(merged).toMatchObject({ applied: true, conflicts: ['a.txt'] })
    expect(read(repo, 'a.txt')).toContain('a different')
    expect(read(repo, 'a.txt')).toContain('a changed')
    expect(repo.git('ls-files', '-u', '--', 'a.txt').trim().split('\n')).toHaveLength(3)
  })

  it('counts only its own conflicts and never drops an entry that left conflicts (review C1/I5)', async () => {
    const repo = makeRepo()
    repo.write('b.txt', 'b mine\n')
    const { entry } = await write(shelfCreateOperation, repo, { name: 'x', paths: ['b.txt'] })
    repo.write('b.txt', 'b theirs\n')
    repo.commit('b moves on')
    // An unrelated conflict on a.txt left without an operation (MERGE_HEAD gone, as after a stash pop).
    repo.git('checkout', '-q', '-b', 'side', 'HEAD~1')
    repo.write('a.txt', 'a side\n')
    repo.commit('side a')
    repo.git('checkout', '-q', 'main')
    repo.write('a.txt', 'a main\n')
    repo.commit('main a')
    repo.gitResult('merge', 'side')
    rmSync(join(repo.root, '.git', 'MERGE_HEAD'))
    const merged = await applyThreeWay(repo, { id: entry.id })
    if (merged === null) return
    expect(merged).toMatchObject({ applied: true, conflicts: ['b.txt'], kept: true })
    expect((await readShelfList(run, repo.root)).map(item => item.id)).toEqual([entry.id])
    expect(read(repo, 'b.txt')).toContain('b mine')
    expect(read(repo, 'b.txt')).toContain('b theirs')
  })

  it('drops an entry and refuses unknown or malformed ids', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'z\n')
    const { entry } = await write(shelfCreateOperation, repo, { name: 'x', paths: ['a.txt'] })
    expect(await write(shelfDropOperation, repo, { id: entry.id })).toEqual({ id: entry.id })
    expect(await readShelfList(run, repo.root)).toEqual([])
    expect((await failureOf(write(shelfDropOperation, repo, { id: entry.id }))).code).toBe('git/stale-target')
    expect((await failureOf(write(shelfDropOperation, repo, { id: '../x' }))).code).toBe('git/invalid-payload')
  })
})
