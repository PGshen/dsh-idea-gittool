// B4d T7: real-repository matrix (L5, not part of `make check`). Run with `pnpm matrix`.
// Builds 12 kinds of repository in a temporary directory (no real repository data), then walks
// each through the real RPC handler the way the Git tab does: bootstrap → log → commit detail →
// diff → status, and where writes are allowed one commit plus its undo (`reset --soft`).
// Prints a Markdown table, writes JSON to .evidence/b4d/, exits 1 when a kind does not behave.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Session } from '@deepseek-ai/dsh-session'

import type {
  BootstrapValue,
  CommitDetailValue,
  CommitResultValue,
  DiffFileValue,
  LogValue,
  StatusValue,
} from '../../src/shared/protocol.ts'
import { createGitExecutable } from '../../src/host/git-executable.ts'
import { createGitRunner } from '../../src/host/git-executor.ts'
import { createRpcHandler } from '../../src/host/rpc.ts'
import type { GitRpcHandler } from '../../src/host/rpc.ts'
import { createFakeSubprocess } from '../../test/host/fake-subprocess.ts'
import { createTempDir, removeTempDir, TEST_GIT_ENV } from '../../test/host/fixtures.ts'
import { createBenchRepo } from '../bench/fixture.mjs'

const SIGNAL = new AbortController().signal
const SESSION = 'matrix'

interface Kind {
  name: string
  /** Session cwd. */
  cwd: string
  /** Sandbox workspace root (differs from the repository for the outside-the-sandbox case). */
  workspaceRoot: string
  expect: {
    repo: boolean
    writable: boolean
    /** Optional per-kind check on the bootstrap / status. */
    check?: (bootstrap: BootstrapValue, status: StatusValue | null) => string | undefined
  }
  /** A path to commit (relative to the repository root) when writable. */
  commitPath?: string
}

interface Row {
  name: string
  ok: boolean
  notes: string[]
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: TEST_GIT_ENV, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`)
  return result.stdout
}

function init(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Matrix')
  git(dir, 'config', 'user.email', 'matrix@example.com')
  return dir
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

function commitAll(root: string, message: string): void {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
}

/** A small history: three commits touching a.txt and src/b.txt. */
function small(dir: string): string {
  const root = init(dir)
  write(root, 'a.txt', 'one\n')
  commitAll(root, 'first')
  write(root, 'src/b.txt', 'b\n')
  commitAll(root, 'second')
  write(root, 'a.txt', 'one\ntwo\n')
  commitAll(root, 'third')
  return root
}

async function buildKinds(base: string): Promise<Kind[]> {
  mkdirSync(join(base, 'big'))
  const big = await createBenchRepo(join(base, 'big'), { commits: Number(process.env.MATRIX_COMMITS ?? 10_000) })

  const dirty = small(join(base, 'dirty'))
  write(dirty, 'a.txt', 'one\ntwo\nthree\n')
  write(dirty, 'src/b.txt', 'b staged\n')
  git(dirty, 'add', 'src/b.txt')
  write(dirty, 'new.txt', 'untracked\n')
  git(dirty, 'mv', 'a.txt', 'renamed.txt')

  const conflict = small(join(base, 'conflict'))
  git(conflict, 'switch', '-q', '-c', 'side', 'HEAD~1')
  write(conflict, 'a.txt', 'side\n')
  commitAll(conflict, 'side change')
  git(conflict, 'switch', '-q', 'main')
  spawnSync('git', ['merge', 'side'], { cwd: conflict, env: TEST_GIT_ENV })

  const outside = small(join(base, 'outside'))
  const otherRoot = join(base, 'elsewhere')
  mkdirSync(otherRoot, { recursive: true })

  const subdir = small(join(base, 'subdir'))
  mkdirSync(join(subdir, 'src', 'deep'), { recursive: true })
  write(subdir, 'src/deep/c.txt', 'c\n')

  const crlf = init(join(base, 'crlf'))
  git(crlf, 'config', 'core.autocrlf', 'true')
  write(crlf, 'win.txt', 'line one\r\nline two\r\n')
  commitAll(crlf, 'crlf file')
  write(crlf, 'win.txt', 'line one\r\nline 2\r\n')

  const shallowSource = small(join(base, 'shallow-source'))
  for (let i = 0; i < 5; i += 1) {
    write(shallowSource, 'a.txt', `rev ${String(i)}\n`)
    commitAll(shallowSource, `more ${String(i)}`)
  }
  const shallow = join(base, 'shallow')
  git(base, 'clone', '-q', '--depth', '3', `file://${shallowSource}`, shallow)
  git(shallow, 'config', 'user.name', 'Matrix')
  git(shallow, 'config', 'user.email', 'matrix@example.com')
  write(shallow, 'a.txt', 'shallow edit\n')

  // B3d default: worktrees under the repository's `.worktrees/`, inside the workspace.
  const main = small(join(base, 'worktree-main'))
  const linked = join(main, '.worktrees', 'feature')
  git(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
  write(linked, 'src/b.txt', 'b in worktree\n')
  // A worktree elsewhere: its common `.git` is outside the session's workspace.
  const farMain = small(join(base, 'worktree-far-main'))
  const far = join(base, 'worktree-far')
  git(farMain, 'worktree', 'add', '-q', '-b', 'far', far)

  const empty = init(join(base, 'empty'))
  write(empty, 'first.txt', 'first\n')

  const plain = join(base, 'not-a-repo')
  mkdirSync(plain, { recursive: true })

  const unicode = small(join(base, '仓库 with space'))
  write(unicode, '文档/说明 "引号" it\'s.md', '中文内容\n')

  const linkedStatus = (_bootstrap: BootstrapValue, status: StatusValue | null): string | undefined =>
    status?.branch === 'feature' ? undefined : `branch ${String(status?.branch)}`
  return [
    { name: '10k 提交（合成，含合并/大文件/脏工作区）', cwd: big.root, workspaceRoot: big.root, expect: { repo: true, writable: true }, commitPath: big.modified[0] ?? '' },
    { name: '脏工作区（修改/暂存/未跟踪/重命名）', cwd: dirty, workspaceRoot: dirty, expect: { repo: true, writable: true }, commitPath: 'new.txt' },
    {
      name: '冲突进行中（merge）',
      cwd: conflict,
      workspaceRoot: conflict,
      expect: {
        repo: true,
        writable: true,
        check: (_b, status) => (status?.operation === 'merge' && status.conflicts.length === 1 ? undefined : `operation ${String(status?.operation)}, conflicts ${String(status?.conflicts.length)}`),
      },
    },
    {
      name: '仓库根在沙箱外',
      cwd: outside,
      workspaceRoot: otherRoot,
      expect: { repo: true, writable: false, check: bootstrap => (bootstrap.writePolicy.mode === 'read-only' ? undefined : 'expected read-only') },
    },
    {
      name: '子目录会话',
      cwd: join(subdir, 'src', 'deep'),
      workspaceRoot: subdir,
      expect: { repo: true, writable: true, check: bootstrap => (bootstrap.repoRoot?.endsWith('/subdir') === true ? undefined : `repoRoot ${String(bootstrap.repoRoot)}`) },
      commitPath: 'src/deep/c.txt',
    },
    { name: 'CRLF + core.autocrlf', cwd: crlf, workspaceRoot: crlf, expect: { repo: true, writable: true }, commitPath: 'win.txt' },
    { name: '浅克隆（--depth 3）', cwd: shallow, workspaceRoot: shallow, expect: { repo: true, writable: true }, commitPath: 'a.txt' },
    { name: 'linked worktree（在仓库 `.worktrees/` 下，工作区为主仓库）', cwd: linked, workspaceRoot: main, expect: { repo: true, writable: true, check: linkedStatus }, commitPath: 'src/b.txt' },
    {
      name: 'linked worktree（在工作区外的主仓库）',
      cwd: far,
      workspaceRoot: far,
      expect: { repo: true, writable: false, check: bootstrap => (bootstrap.writePolicy.reasonCode === 'repo-outside-workspace' ? undefined : `reason ${String(bootstrap.writePolicy.reasonCode)}`) },
    },
    { name: '空仓库（还没有提交）', cwd: empty, workspaceRoot: empty, expect: { repo: true, writable: true }, commitPath: 'first.txt' },
    { name: '非仓库目录', cwd: plain, workspaceRoot: plain, expect: { repo: false, writable: false } },
    { name: '路径含空格/中文/引号', cwd: unicode, workspaceRoot: unicode, expect: { repo: true, writable: true }, commitPath: '文档/说明 "引号" it\'s.md' },
  ]
}

function handlerFor(kind: Kind): GitRpcHandler {
  const fake = createFakeSubprocess({ executable: 'git' })
  const gitExecutable = createGitExecutable(fake)
  const session = { header: { cwd: kind.cwd } } as unknown as Session
  return createRpcHandler({
    runner: createGitRunner(fake, { directBinary: true, executable: gitExecutable }),
    gitExecutable,
    sessions: () => ({ get: () => session }),
    sandboxPolicy: () => ({ workspaceRoot: kind.workspaceRoot, resolve: () => ({ mode: 'workspace-write', workspaceRoot: kind.workspaceRoot }) }),
    // Pass-through confinement: the matrix checks git behaviour, the sandbox has its own tests and L4.
    sandbox: () => ({ confine: async argv => ({ argv, enforcement: 'full' as const }) }),
  })
}

async function call<T>(handler: GitRpcHandler, endpoint: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await handler(endpoint, { sessionId: SESSION, ...payload }, SIGNAL)
  if (!result.ok) throw new Error(`${endpoint}: ${result.error.code} ${result.error.message}`)
  return result.value as T
}

async function walk(kind: Kind): Promise<Row> {
  const notes: string[] = []
  const handler = handlerFor(kind)
  const bootstrap = await call<BootstrapValue>(handler, 'bootstrap')
  if ((bootstrap.repoRoot !== null) !== kind.expect.repo) notes.push(`repoRoot ${String(bootstrap.repoRoot)}`)
  if (!kind.expect.repo) return { name: kind.name, ok: notes.length === 0, notes: notes.length === 0 ? ['bootstrap: 不在仓库，只读空状态'] : notes }

  const writable = bootstrap.writePolicy.mode !== 'read-only'
  if (writable !== kind.expect.writable) notes.push(`writePolicy ${bootstrap.writePolicy.mode} (${bootstrap.writePolicy.reasonCode ?? ''})`)
  const log = await call<LogValue>(handler, 'log', { limit: 100 })
  const status = await call<StatusValue>(handler, 'status')
  const problem = kind.expect.check?.(bootstrap, status)
  if (problem !== undefined) notes.push(problem)
  const facts = [`log ${String(log.commits.length)} 行`, `改动 ${String(status.staged.length + status.unstaged.length + status.untracked.length)}`]
  if (status.conflicts.length > 0) facts.push(`冲突 ${String(status.conflicts.length)}`)

  const first = log.commits[0]
  if (first !== undefined) {
    const detail = await call<CommitDetailValue>(handler, 'commit', { sha: first.sha })
    const file = detail.files[0]
    if (file !== undefined) {
      const diff = await call<DiffFileValue>(handler, 'diff', { scope: 'commit', sha: first.sha, path: file.path })
      facts.push(`diff ${diff.binary ? 'binary' : `${String(diff.hunks.length)} hunk`}`)
    }
  }

  // The oldest commit of the page: a root, or the boundary of a shallow clone.
  const last = log.commits.at(-1)
  if (last !== undefined && last !== first) {
    const detail = await call<CommitDetailValue>(handler, 'commit', { sha: last.sha })
    if (detail.parents.length === 0) facts.push(`最早一行无父提交，详情 ${String(detail.files.length)} 个文件`)
  }

  if (writable && kind.commitPath !== undefined) {
    const before = status.head
    const committed = await call<CommitResultValue>(handler, 'commitFiles', { requestId: `c-${kind.name}`, paths: [kind.commitPath], message: 'matrix commit' })
    facts.push(`提交 ${committed.shortSha}`)
    if (before !== null) {
      await call(handler, 'reset', { requestId: `u-${kind.name}`, sha: before, mode: 'soft', expectedHead: committed.sha })
      const after = await call<StatusValue>(handler, 'status')
      if (after.head !== before) notes.push(`undo left HEAD at ${String(after.head)}`)
      else facts.push('撤销 ✓')
    } else {
      facts.push('首个提交（无父提交可撤销）')
    }
  }
  return { name: kind.name, ok: notes.length === 0, notes: notes.length === 0 ? facts : [...notes, ...facts] }
}

async function main(): Promise<void> {
  const base = createTempDir('dsh-git-matrix-')
  try {
    const kinds = await buildKinds(base)
    const rows: Row[] = []
    for (const kind of kinds) {
      try {
        rows.push(await walk(kind))
      } catch (error) {
        rows.push({ name: kind.name, ok: false, notes: [error instanceof Error ? error.message : String(error)] })
      }
    }
    const lines = ['| 仓库 | 结果 | 记录 |', '|---|---|---|', ...rows.map(row => `| ${row.name} | ${row.ok ? '通过' : '**未通过**'} | ${row.notes.join('；').replaceAll('|', '\\|')} |`)]
    console.log(lines.join('\n'))
    mkdirSync('.evidence/b4d', { recursive: true })
    writeFileSync('.evidence/b4d/matrix.json', JSON.stringify(rows, null, 2))
    if (rows.some(row => !row.ok)) process.exitCode = 1
  } finally {
    removeTempDir(base)
  }
}

await main()
