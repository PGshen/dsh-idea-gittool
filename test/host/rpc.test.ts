import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 仓库 + 进程 spawn 在并发 worker 下偶尔超过默认 5s，这里按文件放宽。
vi.setConfig({ testTimeout: 30_000 })
import type {
  ConnectionRpcFailure,
  ConnectionRpcHandlerResult,
} from '@deepseek-ai/dsh-client-connection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

import type {
  BootstrapValue,
  BranchesValue,
  CommitDetailValue,
  ConsoleValue,
  DiffFileValue,
  LogValue,
  RefsValue,
  StatusValue,
  WritePolicyValue,
} from '../../src/shared/protocol.ts'
import { GitCommandFailure, createGitRunner, instrumentGitRunner } from '../../src/host/git-executor.ts'
import { createGitConsole } from '../../src/host/console.ts'
import { createRepoCache } from '../../src/host/cache.ts'
import type { SandboxPolicySource } from '../../src/host/sandbox-gate.ts'
import type { GitRpcHandler, RpcDeps } from '../../src/host/rpc.ts'
import { createRpcHandler } from '../../src/host/rpc.ts'
import { createTempDir, createTempRepo, removeTempDir } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRepo(): ReturnType<typeof createTempRepo> {
  const repo = createTempRepo()
  cleanups.push(() => repo.cleanup())
  return repo
}

function makeOutsideDir(): string {
  const dir = createTempDir('dsh-git-outside-')
  cleanups.push(() => removeTempDir(dir))
  return dir
}

function policySource(workspaceRoot: string, mode: SandboxMode = 'read-only'): SandboxPolicySource {
  return { workspaceRoot, resolve: () => ({ mode, workspaceRoot }) }
}

function makeHandler(overrides: Partial<RpcDeps> = {}): {
  handler: GitRpcHandler
  repo: ReturnType<typeof createTempRepo>
  fake: ReturnType<typeof createFakeSubprocess>
} {
  const repo = makeRepo()
  const fake = createFakeSubprocess()
  const handler = createRpcHandler({
    runner: createGitRunner(fake),
    sandboxPolicy: () => policySource(repo.root),
    ...overrides,
  })
  return { handler, repo, fake }
}

const SIGNAL = new AbortController().signal

function okValue<T>(result: ConnectionRpcHandlerResult): T {
  if (!result.ok) throw new Error(`expected ok result, got ${JSON.stringify(result.error)}`)
  return result.value as T
}

function errorOf(result: ConnectionRpcHandlerResult): ConnectionRpcFailure {
  if (result.ok) throw new Error('expected an error result')
  return result.error
}

describe('createRpcHandler / status', () => {
  it('returns structured status for the resolved repository', async () => {
    const { handler, repo } = makeHandler()

    const result = await handler('status', { sessionId: 'session-1' }, SIGNAL)

    const status = okValue<StatusValue>(result)
    expect(status.branch).toBe('main')
    expect(status.head).toBe(repo.git('rev-parse', 'HEAD').trim())
    expect(status.staged).toEqual([])
    expect(status.unstaged).toEqual([])
    expect(status.untracked).toEqual([])
    expect(status.conflicts).toEqual([])
    expect(status.operation).toBeNull()
  })

  it('maps an unknown session to git/no-session', async () => {
    const { handler } = makeHandler({
      sandboxPolicy: () => undefined,
      sessions: () => ({ get: () => undefined }),
      sessionPersistence: () => ({ stat: async () => undefined }),
    })

    const result = await handler('status', { sessionId: 'missing' }, SIGNAL)

    expect(errorOf(result).code).toBe('git/no-session')
  })

  it('maps a directory outside any repository to git/not-a-repository', async () => {
    const outside = makeOutsideDir()
    const { handler } = makeHandler({ sandboxPolicy: () => policySource(outside) })

    const result = await handler('status', { sessionId: 'session-1' }, SIGNAL)

    expect(errorOf(result).code).toBe('git/not-a-repository')
  })

  it('keeps reads available while the write policy is read-only', async () => {
    const readOnly: WritePolicyValue = { mode: 'read-only', reason: 'workspace 只读' }
    const { handler } = makeHandler({ writePolicy: () => readOnly })

    const result = await handler('status', { sessionId: 'session-1' }, SIGNAL)

    expect(result.ok).toBe(true)
  })
})

describe('createRpcHandler / bootstrap', () => {
  it('aggregates repo root, first status page, log page, write policy and version', async () => {
    const repo = makeRepo()
    const cache = createRepoCache()
    for (let index = 0; index < 7; index += 1) cache.bumpVersion(repo.root)
    const handler = createRpcHandler({
      runner: createGitRunner(createFakeSubprocess()),
      sandboxPolicy: () => policySource(repo.root),
      cache: () => cache,
    })

    const result = await handler('bootstrap', { sessionId: 'session-1' }, SIGNAL)

    const bootstrap = okValue<BootstrapValue>(result)
    expect(bootstrap.sessionId).toBe('session-1')
    expect(bootstrap.repoRoot).toBe(repo.root)
    expect(bootstrap.status?.branch).toBe('main')
    expect(bootstrap.log?.commits).toHaveLength(1)
    expect(bootstrap.log?.commits[0]?.subject).toBe('initial commit')
    expect(bootstrap.writePolicy.mode).toBe('read-only')
    expect(bootstrap.version).toBe(7)
  })

  it('defaults the write policy to fail-closed read-only', async () => {
    const { handler } = makeHandler()

    const bootstrap = okValue<BootstrapValue>(
      await handler('bootstrap', { sessionId: 'session-1' }, SIGNAL),
    )

    expect(bootstrap.writePolicy.mode).toBe('read-only')
    expect(bootstrap.writePolicy.reason).toBeTruthy()
  })

  it('returns the injected write policy', async () => {
    const policy: WritePolicyValue = {
      mode: 'read-write',
      reason: 'repo inside workspace',
      workspaceRoot: '/workspace',
    }
    const { handler, repo } = makeHandler({ writePolicy: () => policy })

    const bootstrap = okValue<BootstrapValue>(
      await handler('bootstrap', { sessionId: 'session-1' }, SIGNAL),
    )

    expect(bootstrap.writePolicy).toEqual(policy)
    expect(bootstrap.repoRoot).toBe(repo.root)
  })

  it('passes the resolved repo root and session id to the write policy', async () => {
    let seen: { repoRoot: string; sessionId: string } | undefined
    const { handler, repo } = makeHandler({
      writePolicy: (input) => {
        seen = input
        return { mode: 'read-only' }
      },
    })

    await handler('bootstrap', { sessionId: 'session-1' }, SIGNAL)

    expect(seen).toEqual({ repoRoot: repo.root, sessionId: 'session-1' })
  })

  it('fails closed when the write policy rejects the boundary', async () => {
    const { handler } = makeHandler({
      writePolicy: () => {
        throw new GitCommandFailure('git/sandbox-denied', 'repo root outside workspace')
      },
    })

    const result = await handler('bootstrap', { sessionId: 'session-1' }, SIGNAL)

    expect(errorOf(result).code).toBe('git/sandbox-denied')
  })

  it('returns an empty state when the session is outside any repository', async () => {
    const outside = makeOutsideDir()
    const { handler } = makeHandler({ sandboxPolicy: () => policySource(outside) })

    const bootstrap = okValue<BootstrapValue>(
      await handler('bootstrap', { sessionId: 'session-1' }, SIGNAL),
    )

    expect(bootstrap.repoRoot).toBeNull()
    expect(bootstrap.status).toBeNull()
    expect(bootstrap.log).toBeNull()
    expect(bootstrap.writePolicy.mode).toBe('read-only')
  })

  it('maps an unknown session to git/no-session', async () => {
    const { handler } = makeHandler({
      sandboxPolicy: () => undefined,
      sessions: () => ({ get: () => undefined }),
      sessionPersistence: () => ({ stat: async () => undefined }),
    })

    const result = await handler('bootstrap', { sessionId: 'missing' }, SIGNAL)

    expect(errorOf(result).code).toBe('git/no-session')
  })
})

describe('createRpcHandler / log', () => {
  it('returns the first page and a next cursor', async () => {
    const { handler, repo } = makeHandler()
    for (let index = 2; index <= 3; index += 1) {
      repo.write('series.txt', `line ${index}\n`)
      repo.commit(`commit ${index}`)
    }

    const result = await handler('log', { sessionId: 'session-1', limit: 2 }, SIGNAL)

    const page = okValue<LogValue>(result)
    expect(page.commits).toHaveLength(2)
    expect(page.commits[0]?.subject).toBe('commit 3')
    expect(page.truncated).toBe(true)
    expect(page.next).toBeDefined()
  })

  it('rejects an invalid limit with git/invalid-payload', async () => {
    const { handler } = makeHandler()

    const result = await handler('log', { sessionId: 'session-1', limit: 'many' }, SIGNAL)

    expect(errorOf(result).code).toBe('git/invalid-payload')
  })

  it('rejects an invalid cursor with git/invalid-payload', async () => {
    const { handler } = makeHandler()

    const result = await handler('log', { sessionId: 'session-1', cursor: 'nope' }, SIGNAL)

    expect(errorOf(result).code).toBe('git/invalid-payload')
  })
})

describe('createRpcHandler / envelope', () => {
  it('rejects malformed payloads with git/invalid-payload', async () => {
    const { handler } = makeHandler()
    const payloads: unknown[] = [
      undefined,
      null,
      {},
      { sessionId: '' },
      { sessionId: 42 },
      { sessionId: 'x'.repeat(300) },
      [1, 2, 3],
      'session-1',
    ]

    for (const payload of payloads) {
      for (const endpoint of ['status', 'log', 'bootstrap']) {
        const error = errorOf(await handler(endpoint, payload, SIGNAL))
        expect(error.code).toBe('git/invalid-payload')
        expect(typeof error.details).toBe('object')
      }
    }
  })

  it('rejects unknown endpoints with git/invalid-payload', async () => {
    const { handler } = makeHandler()

    const error = errorOf(await handler('diff', { sessionId: 'session-1' }, SIGNAL))

    expect(error.code).toBe('git/invalid-payload')
  })

  it('never throws: unexpected runner failures become git/exec-failed', async () => {
    const { handler } = makeHandler({
      runner: async () => {
        throw new Error('boom')
      },
    })

    const error = errorOf(await handler('status', { sessionId: 'session-1' }, SIGNAL))

    expect(error.code).toBe('git/exec-failed')
    expect(error.message).toContain('boom')
    expect(typeof error.details).toBe('object')
  })

  it('never throws on non-Error rejections', async () => {
    const { handler } = makeHandler({
      runner: async () => {
        throw 'plain failure'
      },
    })

    const error = errorOf(await handler('status', { sessionId: 'session-1' }, SIGNAL))

    expect(error.code).toBe('git/exec-failed')
    expect(error.message).toContain('plain failure')
  })

  it('propagates structured git failures with their code and details', async () => {
    const { handler } = makeHandler({
      runner: async () => {
        throw new GitCommandFailure('git/output-too-large', 'git status output exceeded 2 MiB', {
          stdoutMaxBytes: 2097152,
        })
      },
    })

    const error = errorOf(await handler('status', { sessionId: 'session-1' }, SIGNAL))

    expect(error.code).toBe('git/output-too-large')
    expect(error.details).toMatchObject({ stdoutMaxBytes: 2097152 })
  })
})

describe('createRpcHandler / A1 read endpoints', () => {
  it('serves branches and refs for the resolved repository', async () => {
    const { handler, repo } = makeHandler()
    const head = repo.git('rev-parse', 'HEAD').trim()
    repo.git('tag', 'v1')

    const branches = okValue<BranchesValue>(await handler('branches', { sessionId: 'session-1' }, SIGNAL))
    expect(branches.head).toEqual({ branch: 'main', detached: false, sha: head })
    expect(branches.local.map((entry) => entry.name)).toEqual(['main'])
    expect(branches.tags.map((entry) => entry.name)).toEqual(['v1'])
    expect(typeof branches.version).toBe('number')

    const refs = okValue<RefsValue>(await handler('refs', { sessionId: 'session-1' }, SIGNAL))
    expect(refs.bySha[head]?.map((entry) => entry.name)).toEqual(['main', 'v1'])
  })

  it('serves commit details and caches them per sha', async () => {
    const { handler, repo, fake } = makeHandler()
    const head = repo.git('rev-parse', 'HEAD').trim()

    const first = okValue<CommitDetailValue>(await handler('commit', { sessionId: 'session-1', sha: head }, SIGNAL))
    expect(first.sha).toBe(head)
    expect(first.subject).toBe('initial commit')
    expect(first.files.map((file) => file.path)).toEqual(['README.md'])

    const spawned = fake.spawns.length
    const second = okValue<CommitDetailValue>(await handler('commit', { sessionId: 'session-1', sha: head }, SIGNAL))
    expect(second).toEqual(first)
    // Only repository resolution may spawn again; the commit read itself is cached.
    expect(fake.spawns.slice(spawned).some((spawn) => spawn.spec.argv.includes('diff-tree'))).toBe(false)
  })

  it('serves single-file diffs', async () => {
    const { handler, repo } = makeHandler()
    repo.write('README.md', '# fixture\nmore\n')

    const value = okValue<DiffFileValue>(
      await handler('diff', { sessionId: 'session-1', path: 'README.md', scope: 'worktree' }, SIGNAL),
    )

    expect(value.status).toBe('M')
    expect(value.hunks[0]?.lines.at(-1)).toEqual({ type: 'add', newLine: 2, text: 'more' })
  })

  it('applies log filters and keys the cache by them', async () => {
    const { handler, repo } = makeHandler()
    repo.write('x.txt', 'x\n')
    repo.commit('feature: add x')

    const all = okValue<LogValue>(await handler('log', { sessionId: 'session-1' }, SIGNAL))
    const filtered = okValue<LogValue>(await handler('log', { sessionId: 'session-1', query: 'feature' }, SIGNAL))

    expect(all.commits).toHaveLength(2)
    expect(filtered.commits.map((commit) => commit.subject)).toEqual(['feature: add x'])
  })

  it('returns the console records of the instrumented runner, uncached', async () => {
    const gitConsole = createGitConsole()
    const fake = createFakeSubprocess()
    const repo = makeRepo()
    const handler = createRpcHandler({
      runner: instrumentGitRunner(createGitRunner(fake), gitConsole),
      sandboxPolicy: () => policySource(repo.root),
      console: gitConsole,
    })

    await handler('status', { sessionId: 'session-1' }, SIGNAL)
    const value = okValue<ConsoleValue>(await handler('console', { sessionId: 'session-1' }, SIGNAL))

    expect(value.records.length).toBeGreaterThan(0)
    expect(value.records.some((record) => record.argv.includes('status'))).toBe(true)
    expect(value.records.every((record) => typeof record.durationMs === 'number')).toBe(true)
  })

  it('returns an empty console without a console dependency', async () => {
    const { handler } = makeHandler()

    const value = okValue<ConsoleValue>(await handler('console', { sessionId: 'session-1' }, SIGNAL))

    expect(value).toEqual({ records: [], truncated: false })
  })

  it.each([
    ['branches', {}],
    ['refs', {}],
    ['commit', { sha: 'deadbeef' }],
    ['diff', { path: 'README.md', scope: 'worktree' }],
  ])('maps %s outside any repository to git/not-a-repository', async (endpoint, extra) => {
    const outside = makeOutsideDir()
    const { handler } = makeHandler({ sandboxPolicy: () => policySource(outside) })

    const result = await handler(endpoint, { sessionId: 'session-1', ...extra }, SIGNAL)

    expect(errorOf(result).code).toBe('git/not-a-repository')
  })

  it.each([
    ['commit', {}],
    ['commit', { sha: 'HEAD' }],
    ['commit', { sha: 'deadbeefdeadbeef' }],
    ['diff', { scope: 'worktree' }],
    ['diff', { path: '../etc/passwd', scope: 'worktree' }],
    ['diff', { path: '/etc/passwd', scope: 'worktree' }],
    ['diff', { path: 'README.md', scope: 'nope' }],
    ['diff', { path: 'README.md', scope: 'commit' }],
    ['diff', { path: 'README.md', scope: 'commit', sha: 7 }],
    ['log', { query: 1 }],
    ['log', { branches: 'main' }],
    ['log', { authors: [1] }],
    ['log', { order: 'sideways' }],
    ['log', { firstParent: 'yes' }],
    ['log', { branches: ['--all'] }],
    ['console', {}],
  ])('rejects invalid %s payload %j with git/invalid-payload', async (endpoint, extra) => {
    const { handler } = makeHandler()
    const payload = endpoint === 'console' ? { sessionId: 42 } : { sessionId: 'session-1', ...extra }

    const result = await handler(endpoint, payload, SIGNAL)

    expect(errorOf(result).code).toBe('git/invalid-payload')
  })
})
