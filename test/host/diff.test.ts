import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 仓库 + 进程 spawn 在并发 worker 下偶尔超过默认 5s，这里按文件放宽。
vi.setConfig({ testTimeout: 30_000 })

import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import { parseUnifiedDiff, readDiff, validateRepoPath } from '../../src/host/git/diff.ts'
import { createTempRepo } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRepo(): ReturnType<typeof createTempRepo> {
  const repo = createTempRepo({ initialCommit: false })
  cleanups.push(() => repo.cleanup())
  return repo
}

function makeRunner(): { run: ReturnType<typeof createGitRunner>; fake: ReturnType<typeof createFakeSubprocess> } {
  const fake = createFakeSubprocess()
  return { run: createGitRunner(fake), fake }
}

const { run } = makeRunner()

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error.code
    throw error
  }
  throw new Error('expected a failure')
}

const LIMITS = { maxBytes: 1 << 20, maxLines: 10_000 }

describe('parseUnifiedDiff', () => {
  it('parses hunks with old/new line numbers and skips no-newline markers', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,3 @@ section',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '@@ -10 +10,2 @@',
      '-ten',
      '\\ No newline at end of file',
      '+ten',
      '+eleven',
      '',
    ].join('\n')

    const parsed = parseUnifiedDiff(patch, LIMITS)

    expect(parsed.binary).toBe(false)
    expect(parsed.truncated).toBe(false)
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[0]).toMatchObject({ header: '@@ -1,3 +1,3 @@ section', oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 })
    expect(parsed.hunks[0]?.lines).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, text: 'one' },
      { type: 'del', oldLine: 2, text: 'two' },
      { type: 'add', newLine: 2, text: 'TWO' },
      { type: 'context', oldLine: 3, newLine: 3, text: 'three' },
    ])
    expect(parsed.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 2 })
    expect(parsed.hunks[1]?.lines).toEqual([
      { type: 'del', oldLine: 10, text: 'ten' },
      { type: 'add', newLine: 10, text: 'ten' },
      { type: 'add', newLine: 11, text: 'eleven' },
    ])
  })

  it('keeps content lines that look like headers', () => {
    const patch = ['@@ -1,2 +1,2 @@', '--- not a header', '+++ also content', ''].join('\n')

    const parsed = parseUnifiedDiff(patch, LIMITS)

    expect(parsed.hunks[0]?.lines).toEqual([
      { type: 'del', oldLine: 1, text: '-- not a header' },
      { type: 'add', newLine: 1, text: '++ also content' },
    ])
  })

  it('truncates by lines and bytes while keeping the parsed prefix', () => {
    const body = Array.from({ length: 10 }, (_, i) => `+line ${i}`)
    const patch = ['@@ -0,0 +1,10 @@', ...body, ''].join('\n')

    const byLines = parseUnifiedDiff(patch, { maxBytes: 1 << 20, maxLines: 4 })
    expect(byLines).toMatchObject({ truncated: true, truncatedReason: 'lines' })
    expect(byLines.hunks[0]?.lines).toHaveLength(4)

    const byBytes = parseUnifiedDiff(patch, { maxBytes: 15, maxLines: 100 })
    expect(byBytes).toMatchObject({ truncated: true, truncatedReason: 'bytes' })
    expect(byBytes.hunks[0]?.lines).toHaveLength(2)
  })
})

describe('validateRepoPath', () => {
  it.each(['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/', '.git/config', 'sub/.GIT/x', 'C:\\x', 'a\0b'])(
    'rejects %j',
    (path) => {
      expect(() => validateRepoPath(path)).toThrow(GitCommandFailure)
    },
  )

  it('accepts ordinary and glob-looking relative paths', () => {
    expect(validateRepoPath('src/a b/*.ts')).toBe('src/a b/*.ts')
    expect(validateRepoPath('.gitignore')).toBe('.gitignore')
  })

  // B4d T4: on Windows `\` is a separator and `C:` a drive prefix, so `path.join` would leave the
  // repository through them.
  it.each(['..\\x', 'a\\..\\..\\b', 'C:foo', 'c:/x', '.git\\config', 'sub\\.GIT\\x', '\\\\server\\share\\x', 'a\\\\b'])(
    'rejects %j on win32 (B4d T4)',
    (path) => {
      expect(() => validateRepoPath(path, 'win32')).toThrow(GitCommandFailure)
    },
  )

  // Final review M6: names Windows resolves to `.git` (trailing dot/space, streams, 8.3 short name).
  it.each(['.git.\\config', '.git \\config', 'sub/.GIT./x', '.git::$INDEX_ALLOCATION\\config', 'GIT~1\\config', 'a/b:c'])(
    'rejects the .git alias %j on win32',
    (path) => {
      expect(() => validateRepoPath(path, 'win32')).toThrow(GitCommandFailure)
    },
  )

  it('keeps POSIX names with backslashes, quotes and CJK, and win32 subpaths (B4d T4)', () => {
    expect(validateRepoPath('a\\b.txt', 'linux')).toBe('a\\b.txt')
    expect(validateRepoPath('it\'s "quoted".txt', 'darwin')).toBe('it\'s "quoted".txt')
    expect(validateRepoPath('文档/中文 文件.md', 'win32')).toBe('文档/中文 文件.md')
    expect(validateRepoPath('src\\a.ts', 'win32')).toBe('src\\a.ts')
  })
})

describe('readDiff', () => {
  function seed(): { repo: ReturnType<typeof createTempRepo>; c1: string; c2: string } {
    const repo = makeRepo()
    repo.write('a.txt', 'one\ntwo\nthree\n')
    repo.write('move-me.txt', Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\n') + '\n')
    repo.write('bin.dat', '\u0000\u0001\u0002')
    const c1 = repo.commit('c1')
    repo.write('a.txt', 'one\nTWO\nthree\n')
    repo.git('mv', 'move-me.txt', 'moved.txt')
    repo.write('bin.dat', '\u0000\u0001\u0002\u0003\u0004')
    const c2 = repo.commit('c2')
    return { repo, c1, c2 }
  }

  it('diffs the worktree against the index', async () => {
    const { repo } = seed()
    repo.write('a.txt', 'one\nTWO\nthree\nfour\n')

    const value = await readDiff(run, repo.root, { path: 'a.txt', scope: 'worktree' })

    expect(value).toMatchObject({ oldPath: 'a.txt', newPath: 'a.txt', status: 'M', binary: false, truncated: false })
    expect(value.hunks[0]?.lines.filter((line) => line.type !== 'context')).toEqual([
      { type: 'add', newLine: 4, text: 'four' },
    ])
  })

  it('diffs staged changes', async () => {
    const { repo } = seed()
    repo.write('a.txt', 'zero\none\nTWO\nthree\n')
    repo.git('add', 'a.txt')

    const value = await readDiff(run, repo.root, { path: 'a.txt', scope: 'staged' })

    expect(value.status).toBe('M')
    expect(value.hunks[0]?.lines[0]).toEqual({ type: 'add', newLine: 1, text: 'zero' })
    // Nothing left in the worktree for that file.
    const worktree = await readDiff(run, repo.root, { path: 'a.txt', scope: 'worktree' })
    expect(worktree.hunks).toEqual([])
  })

  it('diffs a commit against its first parent and recognizes renames by new path', async () => {
    const { repo, c2 } = seed()

    const modified = await readDiff(run, repo.root, { path: 'a.txt', scope: 'commit', sha: c2 })
    expect(modified.hunks[0]?.lines.filter((line) => line.type !== 'context')).toEqual([
      { type: 'del', oldLine: 2, text: 'two' },
      { type: 'add', newLine: 2, text: 'TWO' },
    ])

    const renamed = await readDiff(run, repo.root, { path: 'moved.txt', scope: 'commit', sha: c2 })
    expect(renamed).toMatchObject({ oldPath: 'move-me.txt', newPath: 'moved.txt', status: 'R', hunks: [] })
  })

  it('reports binary files with sizes and blob shas', async () => {
    const { repo, c1, c2 } = seed()
    const oldBlob = repo.git('rev-parse', `${c1}:bin.dat`).trim()
    const newBlob = repo.git('rev-parse', `${c2}:bin.dat`).trim()

    const value = await readDiff(run, repo.root, { path: 'bin.dat', scope: 'commit', sha: c2 })

    expect(value).toMatchObject({ binary: true, oldSize: 3, newSize: 5, oldSha: oldBlob, newSha: newBlob, hunks: [] })

    repo.write('bin.dat', '\u0000\u0009')
    const worktree = await readDiff(run, repo.root, { path: 'bin.dat', scope: 'worktree' })
    expect(worktree).toMatchObject({ binary: true, oldSize: 5, newSize: 2, oldSha: newBlob })
  })

  it('diffs a root commit and a merge against a chosen parent', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    const root = repo.commit('root')
    repo.git('checkout', '-q', '-b', 'side')
    repo.write('side.txt', 'side\n')
    const side = repo.commit('side')
    repo.git('checkout', '-q', 'main')
    repo.write('main.txt', 'main\n')
    const main = repo.commit('main')
    repo.git('-c', 'user.name=T', '-c', 'user.email=t@e', 'merge', '-q', '--no-ff', '-m', 'merge', 'side')
    const merge = repo.git('rev-parse', 'HEAD').trim()

    const rootDiff = await readDiff(run, repo.root, { path: 'a.txt', scope: 'commit', sha: root })
    expect(rootDiff).toMatchObject({ oldPath: null, newPath: 'a.txt', status: 'A' })
    expect(rootDiff.hunks[0]?.lines).toEqual([{ type: 'add', newLine: 1, text: 'a' }])

    const vsFirst = await readDiff(run, repo.root, { path: 'side.txt', scope: 'commit', sha: merge })
    expect(vsFirst.status).toBe('A')
    const vsSecond = await readDiff(run, repo.root, { path: 'side.txt', scope: 'commit', sha: merge, parent: side })
    expect(vsSecond.hunks).toEqual([])
    const mainVsSecond = await readDiff(run, repo.root, { path: 'main.txt', scope: 'commit', sha: merge, parent: side })
    expect(mainVsSecond.status).toBe('A')

    expect(
      await codeOf(readDiff(run, repo.root, { path: 'a.txt', scope: 'commit', sha: merge, parent: root })),
    ).toBe('git/invalid-payload')
    expect(main).not.toBe(side)
  })

  it('diffs untracked files with --no-index and deleted files', async () => {
    const { repo } = seed()
    repo.write('new dir/[x].txt', 'fresh\n')
    repo.write('ignored.log', 'x\n')
    repo.write('.gitignore', '*.log\n')
    repo.git('rm', '-q', 'a.txt')

    const untracked = await readDiff(run, repo.root, { path: 'new dir/[x].txt', scope: 'worktree' })
    expect(untracked).toMatchObject({ oldPath: null, newPath: 'new dir/[x].txt', status: '?' })
    expect(untracked.hunks[0]?.lines).toEqual([{ type: 'add', newLine: 1, text: 'fresh' }])

    const ignored = await readDiff(run, repo.root, { path: 'ignored.log', scope: 'worktree' })
    expect(ignored.hunks).toEqual([])

    const deleted = await readDiff(run, repo.root, { path: 'a.txt', scope: 'staged' })
    expect(deleted).toMatchObject({ oldPath: 'a.txt', newPath: null, status: 'D' })
    expect(deleted.hunks[0]?.lines.every((line) => line.type === 'del')).toBe(true)
  })

  it('treats glob characters literally', async () => {
    const repo = makeRepo()
    repo.write('a*.txt', 'star\n')
    repo.write('ab.txt', 'b\n')
    repo.commit('c1')
    repo.write('ab.txt', 'b changed\n')

    const value = await readDiff(run, repo.root, { path: 'a*.txt', scope: 'worktree' })

    expect(value.hunks).toEqual([])
  })

  it('returns an empty diff for an unchanged file', async () => {
    const { repo } = seed()

    const value = await readDiff(run, repo.root, { path: 'a.txt', scope: 'worktree' })

    expect(value).toEqual({ oldPath: 'a.txt', newPath: 'a.txt', status: 'M', binary: false, hunks: [], truncated: false })
  })

  it('truncates large files and keeps the prefix', async () => {
    const repo = makeRepo()
    repo.write('big.txt', 'seed\n')
    repo.commit('c1')
    repo.write('big.txt', Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n')

    const value = await readDiff(run, repo.root, { path: 'big.txt', scope: 'worktree' }, { maxLines: 100 })
    expect(value).toMatchObject({ truncated: true, truncatedReason: 'lines' })
    expect(value.hunks[0]?.lines).toHaveLength(100)

    const tooLarge = await readDiff(run, repo.root, { path: 'big.txt', scope: 'worktree' }, { responseMaxBytes: 256 })
    expect(tooLarge).toMatchObject({ truncated: true, truncatedReason: 'bytes', hunks: [] })
  })

  it('rejects invalid payloads', async () => {
    const { repo, c2 } = seed()
    const cases: Array<Record<string, unknown>> = [
      { path: '../a.txt', scope: 'worktree' },
      { path: '/etc/passwd', scope: 'worktree' },
      { path: 'a.txt', scope: 'bogus' },
      { path: 'a.txt', scope: 'commit' },
      { path: 'a.txt', scope: 'commit', sha: 'HEAD' },
      { path: 'a.txt', scope: 'commit', sha: 'deadbeefdeadbeef' },
      { path: 'a.txt', scope: 'worktree', sha: c2 },
      { path: 'a.txt', scope: 'commit', sha: c2, parent: '--all' },
    ]
    for (const query of cases) {
      expect(await codeOf(readDiff(run, repo.root, query as never)), JSON.stringify(query)).toBe('git/invalid-payload')
    }
  })

  it('passes paths after -- and pins the output shape', async () => {
    const { repo } = seed()
    repo.write('a.txt', 'changed\n')
    const { run: spied, fake } = makeRunner()

    await readDiff(spied, repo.root, { path: 'a.txt', scope: 'worktree' })

    const patchArgv = fake.spawns.at(-1)?.spec.argv ?? []
    const separator = patchArgv.indexOf('--')
    expect(separator).toBeGreaterThan(0)
    expect(patchArgv.slice(separator + 1)).toEqual(['a.txt'])
    for (const flag of ['--no-ext-diff', '--no-color', '--no-textconv', '-M']) expect(patchArgv).toContain(flag)
    expect(fake.spawns.at(-1)?.spec.env?.GIT_LITERAL_PATHSPECS).toBe('1')
  })
})

describe('readDiff scope range (B2 T3)', () => {
  function forkedRepo(): ReturnType<typeof createTempRepo> {
    const repo = makeRepo()
    repo.write('f.txt', 'base\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('f.txt', 'base\nfeature\n')
    repo.commit('feature')
    repo.git('checkout', '-q', 'main')
    repo.write('f.txt', 'main\n')
    repo.commit('main')
    return repo
  }

  const added = (value: Awaited<ReturnType<typeof readDiff>>): string[] =>
    value.hunks.flatMap(hunk => hunk.lines.filter(line => line.type === 'add').map(line => line.text))

  it('diffs two revisions directly', async () => {
    const repo = forkedRepo()
    const value = await readDiff(run, repo.root, { path: 'f.txt', scope: 'range', from: 'main', to: 'feature' })
    expect(added(value)).toEqual(['base', 'feature'])
  })

  it('diffs from the merge base with mergeBase', async () => {
    const repo = forkedRepo()
    const value = await readDiff(run, repo.root, { path: 'f.txt', scope: 'range', from: 'main', to: 'feature', mergeBase: true })
    expect(added(value)).toEqual(['feature'])
  })

  it('diffs a revision against the worktree when to is null', async () => {
    const repo = forkedRepo()
    repo.write('f.txt', 'main\ndirty\n')
    const value = await readDiff(run, repo.root, { path: 'f.txt', scope: 'range', from: 'feature', to: null })
    expect(added(value)).toEqual(['main', 'dirty'])
  })

  it('rejects range fields on other scopes, a missing from and option-like revisions', async () => {
    const repo = forkedRepo()
    expect(await codeOf(readDiff(run, repo.root, { path: 'f.txt', scope: 'worktree', from: 'main' }))).toBe('git/invalid-payload')
    expect(await codeOf(readDiff(run, repo.root, { path: 'f.txt', scope: 'range', to: null }))).toBe('git/invalid-payload')
    expect(await codeOf(readDiff(run, repo.root, { path: 'f.txt', scope: 'range', from: '--output=x', to: null }))).toBe('git/invalid-payload')
  })
})

describe('readDiff scope range is limited to the file (终审 I3)', () => {
  it('scans only the requested path (and its origPath), still seeing the rename', async () => {
    const repo = makeRepo()
    repo.write('old.txt', 'one\ntwo\nthree\nfour\n')
    repo.write('other.txt', 'x\n')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.git('mv', 'old.txt', 'new.txt')
    repo.write('other.txt', 'y\n')
    repo.commit('rename')
    const calls: string[][] = []
    const recording: typeof run = async (argv, options) => {
      calls.push([...argv])
      return run(argv, options)
    }
    const value = await readDiff(recording, repo.root, { path: 'new.txt', origPath: 'old.txt', scope: 'range', from: 'main', to: 'feature' })
    expect(value).toMatchObject({ status: 'R', oldPath: 'old.txt', newPath: 'new.txt' })
    const raw = calls.find(argv => argv.includes('--raw'))
    expect(raw?.slice(raw.indexOf('--') + 1)).toEqual(['old.txt', 'new.txt'])
  })

  it('rejects origPath outside scope range and validates it like a path', async () => {
    const repo = makeRepo()
    repo.write('a.txt', 'a\n')
    repo.commit('base')
    expect(await codeOf(readDiff(run, repo.root, { path: 'a.txt', origPath: 'b.txt', scope: 'worktree' }))).toBe('git/invalid-payload')
    expect(await codeOf(readDiff(run, repo.root, { path: 'a.txt', origPath: '../b', scope: 'range', from: 'HEAD', to: null }))).toBe('git/invalid-payload')
  })
})

describe('readDiff options (B3b T2)', () => {
  function whitespaceRepo(): ReturnType<typeof createTempRepo> {
    const repo = makeRepo()
    repo.write('ws.txt', 'alpha\nbeta\ngamma\n')
    repo.write('mixed.txt', 'one\ntwo\nthree\n')
    repo.commit('base')
    repo.write('ws.txt', 'alpha  \n  beta\ngamma\n')
    repo.write('mixed.txt', 'one \ntwo\nTHREE\n')
    return repo
  }
  const changed = (value: { hunks: { lines: { type: string; text: string }[] }[] }): string[] =>
    value.hunks.flatMap(hunk => hunk.lines.filter(line => line.type !== 'context').map(line => `${line.type}:${line.text}`))

  it('ignoreWhitespace drops whitespace-only lines in every scope', async () => {
    const repo = whitespaceRepo()
    const { run } = makeRunner()
    expect((await readDiff(run, repo.root, { path: 'ws.txt', scope: 'worktree', ignoreWhitespace: true })).hunks).toEqual([])
    expect(changed(await readDiff(run, repo.root, { path: 'mixed.txt', scope: 'worktree', ignoreWhitespace: true }))).toEqual(['del:three', 'add:THREE'])
    expect(changed(await readDiff(run, repo.root, { path: 'mixed.txt', scope: 'worktree' }))).toContain('del:one')
    repo.git('add', '-A')
    expect((await readDiff(run, repo.root, { path: 'ws.txt', scope: 'staged', ignoreWhitespace: true })).hunks).toEqual([])
    const sha = repo.commit('ws')
    expect((await readDiff(run, repo.root, { path: 'ws.txt', scope: 'commit', sha, ignoreWhitespace: true })).hunks).toEqual([])
    expect((await readDiff(run, repo.root, { path: 'ws.txt', scope: 'range', from: 'HEAD~1', to: 'HEAD', ignoreWhitespace: true })).hunks).toEqual([])
  })

  it('context full returns the whole file as one hunk with continuous line numbers', async () => {
    const repo = makeRepo()
    repo.write('long.txt', Array.from({ length: 40 }, (_, index) => `line ${String(index + 1)}`).join('\n') + '\n')
    repo.commit('base')
    repo.write('long.txt', Array.from({ length: 40 }, (_, index) => (index === 19 ? 'changed' : `line ${String(index + 1)}`)).join('\n') + '\n')
    const { run } = makeRunner()
    const value = await readDiff(run, repo.root, { path: 'long.txt', scope: 'worktree', context: 'full' })
    expect(value.hunks).toHaveLength(1)
    const newLines = value.hunks[0]?.lines.filter(line => line.newLine !== undefined).map(line => line.newLine)
    expect(newLines).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
    expect((await readDiff(run, repo.root, { path: 'long.txt', scope: 'worktree' })).hunks[0]?.lines.length).toBe(8)
  })

  it('rejects malformed option values', async () => {
    const repo = makeRepo()
    const { run } = makeRunner()
    expect(await codeOf(readDiff(run, repo.root, { path: 'README.md', scope: 'worktree', ignoreWhitespace: 'yes' }))).toBe('git/invalid-payload')
    expect(await codeOf(readDiff(run, repo.root, { path: 'README.md', scope: 'worktree', context: 'all' }))).toBe('git/invalid-payload')
  })
})
