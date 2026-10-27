// B2 T2：blame 读取与 line-porcelain 解析（真实临时仓库）。
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { parseLinePorcelain, readBlame } from '../../src/host/git/blame.ts'
import type { BlameValue } from '../../src/shared/protocol.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { createTempDir, createTempRepo, removeTempDir } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'

vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const run = createGitRunner(createFakeSubprocess())

function makeRepo(): TempRepo {
  const repo = createTempRepo({ initialCommit: false })
  cleanups.push(repo.cleanup)
  return repo
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error.code
    throw error
  }
  throw new Error('expected a failure')
}

/** Final line number → sha, from the segments of one or more pages. */
function owners(values: BlameValue[]): string[] {
  const out: string[] = []
  for (const value of values) {
    for (const segment of value.segments) {
      for (let line = segment.start; line < segment.start + segment.count; line += 1) out[line - 1] = segment.sha
    }
  }
  return out
}

function numbered(count: number, tag = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${tag} ${String(index + 1)}\n`).join('')
}

describe('parseLinePorcelain', () => {
  const header = (sha: string, orig: number, final: number, extra: string[] = [], filename = 'f.txt'): string[] => [
    `${sha} ${String(orig)} ${String(final)}`,
    'author Alice',
    'author-mail <alice@example.com>',
    'author-time 1793087686',
    'author-tz +0800',
    'committer Alice',
    'committer-mail <alice@example.com>',
    'committer-time 1793087686',
    'committer-tz +0800',
    'summary first subject',
    ...extra,
    `filename ${filename}`,
  ]
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)

  it('merges consecutive lines of one commit into a segment and keeps line text without line ends', () => {
    const output = [
      ...header(a, 1, 1), '\tone\r',
      ...header(a, 2, 2), '\ttwo',
      ...header(b, 7, 3, ['previous ' + a + ' old.txt'], 'old.txt'), '\tthree',
      ...header(a, 3, 4), '\tfour',
      '',
    ].join('\n')
    const parsed = parseLinePorcelain(output, 'f.txt')
    expect(parsed.lines).toEqual(['one', 'two', 'three', 'four'])
    expect(parsed.segments).toEqual([
      { sha: a, start: 1, count: 2 },
      { sha: b, start: 3, count: 1, origPath: 'old.txt' },
      { sha: a, start: 4, count: 1 },
    ])
    expect(parsed.commits[a]).toEqual({
      sha: a,
      shortSha: 'aaaaaaa',
      author: 'Alice',
      email: 'alice@example.com',
      date: '2026-10-27T15:54:46+08:00',
      subject: 'first subject',
      uncommitted: false,
      boundary: false,
    })
    expect(parsed.commits[b]?.previous).toEqual({ sha: a, path: 'old.txt' })
  })

  it('marks the all-zero sha as uncommitted and a boundary commit as boundary', () => {
    const zero = '0'.repeat(40)
    const output = [...header(zero, 1, 1), '\tdirty', ...header(a, 1, 2, ['boundary']), '\told', ''].join('\n')
    const parsed = parseLinePorcelain(output, 'f.txt')
    expect(parsed.commits[zero]?.uncommitted).toBe(true)
    expect(parsed.commits[a]?.boundary).toBe(true)
  })
})

describe('readBlame', () => {
  it('attributes each line to the commit that last changed it and merges runs', async () => {
    const repo = makeRepo()
    repo.write('f.txt', 'a\nb\nc\nd\n')
    const first = repo.commit('first')
    repo.write('f.txt', 'a\nB\nC\nd\n')
    const second = repo.commit('second')
    const value = await readBlame(run, repo.root, { sessionId: 's', path: 'f.txt' })
    expect(value).toMatchObject({ path: 'f.txt', rev: null, totalLines: 4, start: 1, binary: false, tooLarge: false })
    expect(value.next).toBeUndefined()
    expect(value.lines).toEqual(['a', 'B', 'C', 'd'])
    expect(value.segments).toEqual([
      { sha: first, start: 1, count: 1 },
      { sha: second, start: 2, count: 2 },
      { sha: first, start: 4, count: 1 },
    ])
    expect(value.commits[second]).toMatchObject({ subject: 'second', author: 'Test', uncommitted: false, boundary: false })
    // The root commit is not a boundary (`--root`).
    expect(value.commits[first]?.boundary).toBe(false)
  })

  it('shows worktree edits as one uncommitted segment', async () => {
    const repo = makeRepo()
    repo.write('f.txt', 'a\nb\n')
    repo.commit('first')
    repo.write('f.txt', 'a\nchanged\nadded\n')
    const value = await readBlame(run, repo.root, { sessionId: 's', path: 'f.txt' })
    const zero = '0'.repeat(40)
    expect(value.segments.at(-1)).toEqual({ sha: zero, start: 2, count: 2 })
    expect(value.commits[zero]?.uncommitted).toBe(true)
  })

  it('blames a revision and resolves it to a full sha', async () => {
    const repo = makeRepo()
    repo.write('f.txt', 'old\n')
    const first = repo.commit('first')
    repo.write('f.txt', 'new\nmore\n')
    repo.commit('second')
    const value = await readBlame(run, repo.root, { sessionId: 's', path: 'f.txt', rev: 'HEAD~1' })
    expect(value.rev).toBe(first)
    expect(value.lines).toEqual(['old'])
    expect(value.totalLines).toBe(1)
  })

  it('pages large files: pages join without gaps or overlaps and equal one full blame', async () => {
    const repo = makeRepo()
    repo.write('big.txt', numbered(4500))
    repo.commit('first')
    repo.write('big.txt', numbered(2500) + numbered(2000, 'tail'))
    repo.commit('second')
    const pages: BlameValue[] = []
    let start: number | undefined = 1
    while (start !== undefined) {
      const page: BlameValue = await readBlame(run, repo.root, { sessionId: 's', path: 'big.txt', start })
      pages.push(page)
      start = page.next
    }
    expect(pages.map(page => [page.start, page.lines.length, page.next])).toEqual([
      [1, 2000, 2001],
      [2001, 2000, 4001],
      [4001, 500, undefined],
    ])
    expect(pages.every(page => page.totalLines === 4500)).toBe(true)
    const whole = await readBlame(run, repo.root, { sessionId: 's', path: 'big.txt', limit: 2000 })
    expect(whole.lines.length).toBe(2000)
    const full = repo.git('blame', '--porcelain', '--root', '--', 'big.txt')
      .split('\n').filter(line => /^[0-9a-f]{40} \d+ \d+/.test(line)).map(line => line.slice(0, 40))
    expect(owners(pages)).toEqual(full)
    expect(pages.flatMap(page => page.lines).at(-1)).toBe('tail 2000')
  })

  it('counts lines of CRLF files, files without a final newline and empty files', async () => {
    const repo = makeRepo()
    repo.write('crlf.txt', 'x\r\ny\r\nz')
    repo.write('empty.txt', '')
    repo.commit('first')
    const crlf = await readBlame(run, repo.root, { sessionId: 's', path: 'crlf.txt' })
    expect(crlf.totalLines).toBe(3)
    expect(crlf.lines).toEqual(['x', 'y', 'z'])
    const empty = await readBlame(run, repo.root, { sessionId: 's', path: 'empty.txt' })
    expect(empty).toMatchObject({ totalLines: 0, lines: [], segments: [] })
  })

  it('ignores textconv drivers so the lines match the counted content (终审 I2)', async () => {
    const repo = makeRepo()
    repo.write('.gitattributes', '*.dat diff=dup\n')
    repo.git('config', 'diff.dup.textconv', 'sed p')
    repo.write('x.dat', 'a\nb\nc')
    repo.commit('first')
    const value = await readBlame(run, repo.root, { sessionId: 's', path: 'x.dat' })
    expect(value.totalLines).toBe(3)
    expect(value.lines).toEqual(['a', 'b', 'c'])
  })

  it('reports binary and too-large files without blaming them', async () => {
    const repo = makeRepo()
    repo.write('bin.dat', 'a\0b\n')
    repo.write('big.txt', numbered(100))
    repo.commit('first')
    expect(await readBlame(run, repo.root, { sessionId: 's', path: 'bin.dat' })).toMatchObject({ binary: true, lines: [], segments: [] })
    const big = await readBlame(run, repo.root, { sessionId: 's', path: 'big.txt' }, { maxBytes: 100 })
    expect(big).toMatchObject({ tooLarge: true, lines: [], segments: [] })
    expect(big.terminalCommand).toBe('git blame -- big.txt')
  })

  it('answers untracked and missing files with an empty, explained value', async () => {
    const repo = makeRepo()
    repo.write('kept.txt', 'k\n')
    repo.write('gone.txt', 'g\n')
    repo.commit('first')
    repo.write('new.txt', 'n\n')
    repo.git('rm', '-q', 'gone.txt')
    expect(await readBlame(run, repo.root, { sessionId: 's', path: 'new.txt' })).toMatchObject({ unavailable: 'untracked', lines: [] })
    expect(await readBlame(run, repo.root, { sessionId: 's', path: 'gone.txt' })).toMatchObject({ unavailable: 'missing', lines: [] })
    expect(await readBlame(run, repo.root, { sessionId: 's', path: 'kept.txt', rev: 'HEAD' })).toMatchObject({ lines: ['k'] })
    expect(await readBlame(run, repo.root, { sessionId: 's', path: 'new.txt', rev: 'HEAD' })).toMatchObject({ unavailable: 'missing' })
  })

  it('keeps odd paths literal and refuses option-like revisions', async () => {
    const repo = makeRepo()
    repo.write('-dash.txt', 'd\n')
    repo.write('空 格.txt', 'c\n')
    repo.commit('first')
    expect((await readBlame(run, repo.root, { sessionId: 's', path: '-dash.txt' })).lines).toEqual(['d'])
    expect((await readBlame(run, repo.root, { sessionId: 's', path: '空 格.txt' })).lines).toEqual(['c'])
    expect(await codeOf(readBlame(run, repo.root, { sessionId: 's', path: '-dash.txt', rev: '--output=/tmp/x' }))).toBe('git/invalid-payload')
    expect(await codeOf(readBlame(run, repo.root, { sessionId: 's', path: '-dash.txt', rev: 'no-such-branch' }))).toBe('git/invalid-payload')
    expect(await codeOf(readBlame(run, repo.root, { sessionId: 's', path: '-dash.txt', start: 5 }))).toBe('git/invalid-payload')
    expect(await codeOf(readBlame(run, repo.root, { sessionId: 's', path: '-dash.txt', limit: 0 }))).toBe('git/invalid-payload')
  })

  it('marks the shallow-clone boundary', async () => {
    const repo = makeRepo()
    repo.write('f.txt', 'a\n')
    repo.commit('first')
    repo.write('f.txt', 'a\nb\n')
    repo.commit('second')
    const parent = createTempDir()
    cleanups.push(() => removeTempDir(parent))
    const clone = `${parent}/clone`
    repo.git('clone', '-q', '--depth', '1', `file://${repo.root}`, clone)
    const value = await readBlame(run, clone, { sessionId: 's', path: 'f.txt' })
    const [segment] = value.segments
    expect(value.segments).toHaveLength(1)
    expect(value.commits[segment?.sha ?? '']?.boundary).toBe(true)
  })
})
