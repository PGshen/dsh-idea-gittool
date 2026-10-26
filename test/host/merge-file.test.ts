// B1 T2：mergeFile 读三方与草稿（真实临时仓库）。
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import { resolveConflictOperation } from '../../src/host/git/conflict.ts'
import { mergeDraftRef, readMergeFile } from '../../src/host/git/merge-file.ts'
import { JsonRefInvalid, readJsonRef } from '../../src/host/git/write-support.ts'
import type { MergeDraft } from '../../src/shared/protocol.ts'
import { createTempRepo } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { contextFor } from './remote-fixtures.ts'

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

async function failureOf(promise: Promise<unknown>): Promise<GitCommandFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected a GitCommandFailure')
}

function show(repo: TempRepo, spec: string): string {
  return repo.git('show', spec)
}

/** main and feature diverge on every file; the merge stops with conflicts. */
function mergeStopped(repo: TempRepo, extra: () => void = () => undefined): void {
  repo.write('uu.txt', 'a\nb\nc\n')
  repo.write('du.txt', 'base du\n')
  repo.write('ud.txt', 'base ud\n')
  extra()
  repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  repo.write('uu.txt', 'a\nfeature\nc\n')
  repo.write('du.txt', 'feature du\n')
  repo.git('rm', '-q', 'ud.txt')
  repo.write('aa.txt', 'feature aa\n')
  repo.commit('feature side')
  repo.git('checkout', '-q', 'main')
  repo.write('uu.txt', 'a\nmain\nc\n')
  repo.git('rm', '-q', 'du.txt')
  repo.write('ud.txt', 'main ud\n')
  repo.write('aa.txt', 'main aa\n')
  repo.commit('main side')
  expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
}

function draftFor(value: { base: { blob: string } | null; ours: { blob: string } | null; theirs: { blob: string } | null }): MergeDraft {
  return {
    version: 1,
    stages: { base: value.base?.blob ?? null, ours: value.ours?.blob ?? null, theirs: value.theirs?.blob ?? null },
    result: 'a\nmid\nc\n',
    chunks: [{ state: 'edited', leftDone: true, rightDone: false }],
    savedAt: '2026-10-26T00:00:00.000Z',
  }
}

/** Store a JSON blob behind a ref, the way T3 will (confined git is not needed in tests). */
function storeRef(repo: TempRepo, ref: string, content: string): void {
  const file = join(repo.root, '.git', 'tmp-draft.json')
  writeFileSync(file, content)
  const sha = repo.git('hash-object', '-w', file).trim()
  repo.git('update-ref', ref, sha)
}

describe('mergeDraftRef', () => {
  it('is the sha1 hex of the path under refs/worktree/dsh-git/merge-draft/', () => {
    expect(mergeDraftRef('a/b.txt')).toBe(
      `refs/worktree/dsh-git/merge-draft/${createHash('sha1').update('a/b.txt').digest('hex')}`,
    )
  })
})

describe('mergeFile', () => {
  it('reads base/ours/theirs byte-for-byte for a both-modified file', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const value = await readMergeFile(contextFor(repo), 'uu.txt')
    expect(value).toMatchObject({ path: 'uu.txt', kind: 'both-modified', tooLarge: false, resolved: false, draft: null, draftStale: false })
    expect(value.base?.text).toBe(show(repo, ':1:uu.txt'))
    expect(value.ours?.text).toBe(show(repo, ':2:uu.txt'))
    expect(value.theirs?.text).toBe(show(repo, ':3:uu.txt'))
    expect(value.ours?.text).toBe('a\nmain\nc\n')
    expect(value.theirs?.text).toBe('a\nfeature\nc\n')
    expect(value.ours).toMatchObject({ binary: false, size: 9, blob: repo.git('rev-parse', ':2:uu.txt').trim() })
    // The worktree holds conflict markers: its hash is not any side's.
    expect(value.worktreeSha).toBe(repo.git('hash-object', 'uu.txt').trim())
  })

  it('both-added has no base', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const value = await readMergeFile(contextFor(repo), 'aa.txt')
    expect(value.kind).toBe('both-added')
    expect(value.base).toBeNull()
    expect(value.ours?.text).toBe('main aa\n')
    expect(value.theirs?.text).toBe('feature aa\n')
  })

  it('deleted-by-us (DU) has no ours; deleted-by-them (UD) has no theirs', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const du = await readMergeFile(contextFor(repo), 'du.txt')
    expect(du).toMatchObject({ kind: 'deleted-by-us', ours: null })
    expect(du.theirs?.text).toBe('feature du\n')
    expect(du.worktreeSha).toBe(repo.git('hash-object', 'du.txt').trim())
    const ud = await readMergeFile(contextFor(repo), 'ud.txt')
    expect(ud).toMatchObject({ kind: 'deleted-by-them', theirs: null })
    expect(ud.ours?.text).toBe('main ud\n')
  })

  it('worktreeSha is null when the file is missing from the worktree', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    // A deleted-by-us conflict keeps the file in the worktree; remove it by hand.
    rmSync(join(repo.root, 'du.txt'))
    expect((await readMergeFile(contextFor(repo), 'du.txt')).worktreeSha).toBeNull()
  })

  it('treats NUL bytes and invalid UTF-8 as binary (text null)', async () => {
    const repo = makeRepo()
    const bin = (byte: number) => Buffer.from([0x61, byte, 0x62, 0x0a])
    repo.write('seed.txt', 'x\n')
    repo.commit('seed')
    const put = (name: string, data: Buffer) => writeFileSync(join(repo.root, name), data)
    put('nul.bin', bin(0))
    put('latin.txt', bin(0xe9))
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    put('nul.bin', Buffer.from([0x62, 0, 0x0a]))
    put('latin.txt', Buffer.from([0x61, 0xe8, 0x0a]))
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    put('nul.bin', Buffer.from([0x63, 0, 0x0a]))
    put('latin.txt', Buffer.from([0x61, 0xea, 0x0a]))
    repo.commit('main')
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    for (const path of ['nul.bin', 'latin.txt']) {
      const value = await readMergeFile(contextFor(repo), path)
      expect(value.ours).toMatchObject({ text: null, binary: true })
      expect(value.theirs).toMatchObject({ text: null, binary: true })
      expect(value.tooLarge).toBe(false)
    }
  })

  it('marks sides over 20 000 lines or 2 MiB as tooLarge with text null', async () => {
    const repo = makeRepo()
    const lines = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag}${String(i)}`).join('\n') + '\n'
    repo.write('long.txt', 'base\n')
    repo.write('wide.txt', 'base\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('long.txt', lines(20_001, 'f'))
    repo.write('wide.txt', 'f'.repeat(2 * 1024 * 1024 + 1) + '\n')
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    repo.write('long.txt', 'main\n')
    repo.write('wide.txt', 'main\n')
    repo.commit('main')
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    for (const path of ['long.txt', 'wide.txt']) {
      const value = await readMergeFile(contextFor(repo), path)
      expect(value.tooLarge).toBe(true)
      expect(value.theirs?.text).toBeNull()
      expect(value.theirs?.binary).toBe(false)
      expect(value.ours?.text).toBe('main\n')
    }
    // Exactly 20 000 lines is still fine.
    repo.git('merge', '--abort')
    repo.git('checkout', '-q', 'feature')
    repo.write('long.txt', lines(20_000, 'f'))
    repo.commit('exact')
    repo.git('checkout', '-q', 'main')
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const exact = await readMergeFile(contextFor(repo), 'long.txt')
    expect(exact.theirs?.text?.length).toBeGreaterThan(0)
  })

  it('returns LF text in an autocrlf repository', async () => {
    const repo = makeRepo()
    repo.git('config', 'core.autocrlf', 'true')
    repo.write('crlf.txt', 'a\r\nb\r\nc\r\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('crlf.txt', 'a\r\nfeature\r\nc\r\n')
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    repo.write('crlf.txt', 'a\r\nmain\r\nc\r\n')
    repo.commit('main')
    expect(repo.gitResult('merge', '--no-edit', 'feature').status).not.toBe(0)
    const value = await readMergeFile(contextFor(repo), 'crlf.txt')
    expect(value.ours?.text).toBe('a\nmain\nc\n')
    expect(value.theirs?.text).toBe('a\nfeature\nc\n')
    expect(value.base?.text).toBe('a\nb\nc\n')
  })

  it('rejects a path that is neither unmerged nor resolved in this operation', async () => {
    const repo = makeRepo()
    mergeStopped(repo, () => repo.write('plain.txt', 'p\n'))
    const ctx = contextFor(repo)
    const failure = await failureOf(readMergeFile(ctx, 'plain.txt'))
    expect(failure).toMatchObject({ code: 'git/stale-target', details: { target: 'conflict' } })
    expect((await failureOf(readMergeFile(ctx, 'nope.txt'))).code).toBe('git/stale-target')
  })

  it('reads a resolved path from resolve-undo while the operation is in progress', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    const before = await readMergeFile(ctx, 'uu.txt')
    const op = resolveConflictOperation
    await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', path: 'uu.txt', resolution: 'ours' }))
    const after = await readMergeFile(ctx, 'uu.txt')
    expect(after.resolved).toBe(true)
    expect(after.kind).toBe('both-modified')
    expect(after.ours?.blob).toBe(before.ours?.blob)
    expect(after.theirs?.text).toBe('a\nfeature\nc\n')
    expect(after.base?.text).toBe('a\nb\nc\n')
  })

  it('ruling 16: worktreeText is the worktree file of a resolved path only', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    expect((await readMergeFile(ctx, 'uu.txt')).worktreeText).toBeUndefined()
    const op = resolveConflictOperation
    await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', path: 'uu.txt', resolution: 'ours' }))
    expect((await readMergeFile(ctx, 'uu.txt')).worktreeText).toBe('a\nmain\nc\n')
    // Edited after resolving (e.g. by an agent): the current worktree content, CRLF kept.
    repo.write('uu.txt', 'a\r\nmine\r\nc')
    expect((await readMergeFile(ctx, 'uu.txt')).worktreeText).toBe('a\r\nmine\r\nc')
  })

  it('ruling 16: worktreeText is null for a missing, binary, oversized or symlinked worktree file', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    const op = resolveConflictOperation
    await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', path: 'uu.txt', resolution: 'ours' }))
    const text = async (): Promise<string | null | undefined> => (await readMergeFile(ctx, 'uu.txt')).worktreeText
    rmSync(join(repo.root, 'uu.txt'))
    expect(await text()).toBeNull()
    writeFileSync(join(repo.root, 'uu.txt'), Buffer.from([0x61, 0x00, 0x62]))
    expect(await text()).toBeNull()
    writeFileSync(join(repo.root, 'uu.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x0a]))
    expect(await text()).toBeNull()
    writeFileSync(join(repo.root, 'uu.txt'), 'x\n'.repeat(20_001))
    expect(await text()).toBeNull()
    writeFileSync(join(repo.root, 'uu.txt'), 'y'.repeat(2 * 1024 * 1024 + 1))
    expect(await text()).toBeNull()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-merge-outside-'))
    cleanups.push(() => { rmSync(outside, { recursive: true, force: true }) })
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    rmSync(join(repo.root, 'uu.txt'))
    symlinkSync(join(outside, 'secret.txt'), join(repo.root, 'uu.txt'))
    expect(await text()).toBeNull()
  })

  it('does not open resolved delete-kind conflicts (resolve-undo lacks stage 2 or 3)', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    // Unresolved DU/UD still open through the normal path.
    expect((await readMergeFile(ctx, 'du.txt')).kind).toBe('deleted-by-us')
    expect((await readMergeFile(ctx, 'ud.txt')).kind).toBe('deleted-by-them')
    const op = resolveConflictOperation
    await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', path: 'du.txt', resolution: 'delete' }))
    await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', path: 'ud.txt', resolution: 'ours' }))
    for (const path of ['du.txt', 'ud.txt']) {
      expect(await failureOf(readMergeFile(ctx, path))).toMatchObject({
        code: 'git/stale-target',
        details: { target: 'conflict' },
      })
    }
  })

  it('does not trust resolve-undo leftovers once the operation has ended', async () => {
    const repo = makeRepo()
    mergeStopped(repo)
    const ctx = contextFor(repo)
    const op = resolveConflictOperation
    for (const path of ['uu.txt', 'aa.txt']) {
      await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', path, resolution: 'ours' }))
    }
    await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', path: 'du.txt', resolution: 'delete' }))
    await op.run(ctx, op.parse({ sessionId: 's', requestId: 'r', path: 'ud.txt', resolution: 'ours' }))
    repo.git('commit', '-q', '--no-edit')
    expect(repo.git('ls-files', '--resolve-undo')).not.toBe('')
    expect((await failureOf(readMergeFile(ctx, 'uu.txt'))).code).toBe('git/stale-target')
  })
})

describe('mergeFile drafts', () => {
  async function setup(): Promise<{ repo: TempRepo; ctx: WriteContext; ref: string }> {
    const repo = makeRepo()
    mergeStopped(repo)
    return { repo, ctx: contextFor(repo), ref: mergeDraftRef('uu.txt') }
  }

  it('loads a valid draft for the current stages', async () => {
    const { repo, ctx, ref } = await setup()
    const draft = draftFor(await readMergeFile(ctx, 'uu.txt'))
    storeRef(repo, ref, JSON.stringify(draft))
    const value = await readMergeFile(ctx, 'uu.txt')
    expect(value.draft).toEqual(draft)
    expect(value.draftStale).toBe(false)
  })

  it('voids a draft whose stages differ from the current ones', async () => {
    const { repo, ctx, ref } = await setup()
    const draft = draftFor(await readMergeFile(ctx, 'uu.txt'))
    draft.stages.theirs = 'f'.repeat(40)
    storeRef(repo, ref, JSON.stringify(draft))
    expect(await readMergeFile(ctx, 'uu.txt')).toMatchObject({ draft: null, draftStale: true })
  })

  it('voids a draft with another version', async () => {
    const { repo, ctx, ref } = await setup()
    storeRef(repo, ref, JSON.stringify({ ...draftFor(await readMergeFile(ctx, 'uu.txt')), version: 2 }))
    expect(await readMergeFile(ctx, 'uu.txt')).toMatchObject({ draft: null, draftStale: true })
  })

  it('loads a draft whose chunks carry result line ranges', async () => {
    const { repo, ctx, ref } = await setup()
    const base = draftFor(await readMergeFile(ctx, 'uu.txt'))
    const draft: MergeDraft = { ...base, chunks: [{ state: 'edited', leftDone: false, rightDone: false, resultStart: 1, resultEnd: 2 }] }
    storeRef(repo, ref, JSON.stringify(draft))
    const value = await readMergeFile(ctx, 'uu.txt')
    expect(value.draft).toEqual(draft)
    expect(value.draftStale).toBe(false)
  })

  it('voids a draft whose result line ranges are malformed', async () => {
    const { repo, ctx, ref } = await setup()
    const base = draftFor(await readMergeFile(ctx, 'uu.txt'))
    const chunk = base.chunks[0]!
    for (const bad of [{ resultStart: -1, resultEnd: 2 }, { resultStart: 1.5, resultEnd: 2 }, { resultStart: '1', resultEnd: 2 }, { resultStart: 1 }, { resultStart: 2, resultEnd: 1 }]) {
      storeRef(repo, ref, JSON.stringify({ ...base, chunks: [{ ...chunk, ...bad }] }))
      expect(await readMergeFile(ctx, 'uu.txt')).toMatchObject({ draft: null, draftStale: true })
    }
  })

  it('voids a draft whose JSON is corrupt', async () => {
    const { repo, ctx, ref } = await setup()
    storeRef(repo, ref, '{ not json')
    expect(await readMergeFile(ctx, 'uu.txt')).toMatchObject({ draft: null, draftStale: true })
  })
})

describe('readJsonRef', () => {
  it('returns null for a missing ref, the value for a JSON blob and throws JsonRefInvalid for bad JSON', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    repo.commit('init')
    const ctx = contextFor(repo)
    const ref = 'refs/worktree/dsh-git/test/x'
    expect(await readJsonRef(ctx, ref)).toBeNull()
    storeRef(repo, ref, '{"a":1}')
    expect(await readJsonRef(ctx, ref)).toEqual({ a: 1 })
    storeRef(repo, ref, 'nope')
    await expect(readJsonRef(ctx, ref)).rejects.toBeInstanceOf(JsonRefInvalid)
    repo.git('update-ref', ref, 'HEAD') // a commit, not a blob
    await expect(readJsonRef(ctx, ref)).rejects.toBeInstanceOf(JsonRefInvalid)
  })
})
