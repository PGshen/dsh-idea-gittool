// B3c T1/T2: shelf — save chosen changes under a name in restricted refs, roll them back, apply them again.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SHELF_REF_PREFIX } from '../../src/shared/protocol.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { readShelfList, readShelfPatch, shelfApplyOperation, shelfCreateOperation, shelfDropOperation } from '../../src/host/git/shelf.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { createTempDir, createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { contextFor } from './remote-fixtures.ts'

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

  it('stores a patch that rebuilds the change, binary included', async () => {
    const repo = makeRepo()
    dirty(repo)
    const { entry } = await write(shelfCreateOperation, repo, { name: 'x', paths: ['a.txt', 'bin.dat', 'new file.txt'] })
    const patch = await readShelfPatch(run, repo.root, entry.id)
    const file = join(createTempDir(), 'shelf.patch')
    writeFileSync(file, patch)
    repo.git('apply', file)
    expect(read(repo, 'a.txt')).toBe('a changed\n')
    expect(readFileSync(join(repo.root, 'bin.dat'))).toEqual(Buffer.from('x\0z\n'))
    expect(read(repo, 'new file.txt')).toBe('brand new\n')
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
    repo.git('checkout', '--', 'a.txt', 'b.txt')
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
    const merged = await write(shelfApplyOperation, repo, { id: entry.id, threeWay: true, keep: true })
    expect(merged).toMatchObject({ applied: true, conflicts: ['a.txt'], kept: true })
    expect(read(repo, 'a.txt')).toContain('<<<<<<<')
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
