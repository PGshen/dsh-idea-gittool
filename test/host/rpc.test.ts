import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 仓库 + 进程 spawn 在并发 worker 下偶尔超过默认 5s，这里按文件放宽。
vi.setConfig({ testTimeout: 30_000 })
import type {
  ConnectionRpcFailure,
  ConnectionRpcHandlerResult,
} from '@deepseek-ai/dsh-client-connection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

import type {
  BlameValue,
  BootstrapValue,
  BranchesValue,
  CommitDetailValue,
  ConflictCommandValue,
  ConsoleValue,
  DiffFileValue,
  LogValue,
  OperationStateValue,
  ResetPreviewValue,
  RefsValue,
  StashFilesValue,
  StashListValue,
  StatusValue,
  WritePolicyValue,
} from '../../src/shared/protocol.ts'
import { RPC_ENDPOINTS, WRITE_ENDPOINTS, isWriteEndpoint } from '../../src/shared/protocol.ts'
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
  it('aggregates repo root, status, write policy and version without reading the log', async () => {
    const repo = makeRepo()
    const cache = createRepoCache()
    for (let index = 0; index < 7; index += 1) cache.bumpVersion(repo.root)
    const fake = createFakeSubprocess()
    const handler = createRpcHandler({
      runner: createGitRunner(fake),
      sandboxPolicy: () => policySource(repo.root),
      cache: () => cache,
    })

    const result = await handler('bootstrap', { sessionId: 'session-1' }, SIGNAL)

    const bootstrap = okValue<BootstrapValue>(result)
    expect(bootstrap.sessionId).toBe('session-1')
    expect(bootstrap.repoRoot).toBe(repo.root)
    expect(bootstrap.status?.branch).toBe('main')
    // 日志页自己分页拉取；bootstrap 每 3s 轮询一次，不再白跑 git log（评审 I5）。
    expect('log' in bootstrap).toBe(false)
    expect(fake.spawns.some((spawn) => spawn.spec.argv.includes('log'))).toBe(false)
    expect(bootstrap.writePolicy.mode).toBe('read-only')
    expect(bootstrap.version).toBe(7)
  })

  it('reports the git version once per runtime', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const handler = createRpcHandler({
      runner: createGitRunner(fake),
      sandboxPolicy: () => policySource(repo.root),
    })

    const first = okValue<BootstrapValue>(await handler('bootstrap', { sessionId: 'session-1' }, SIGNAL))
    const second = okValue<BootstrapValue>(await handler('bootstrap', { sessionId: 'session-1' }, SIGNAL))

    expect(first.gitVersion).toMatch(/^\d+\.\d+/)
    expect(second.gitVersion).toBe(first.gitVersion)
    const probes = fake.spawns.filter(spawn => spawn.spec.argv.includes('--version'))
    expect(probes).toHaveLength(1)
  })

  it('omits gitVersion when the probe fails without failing bootstrap', async () => {
    const repo = makeRepo()
    const real = createGitRunner(createFakeSubprocess())
    const handler = createRpcHandler({
      runner: async (argv, options) => {
        if (argv.includes('--version')) throw new GitCommandFailure('git/exec-failed', 'boom', {})
        return real(argv, options)
      },
      sandboxPolicy: () => policySource(repo.root),
    })

    const bootstrap = okValue<BootstrapValue>(await handler('bootstrap', { sessionId: 'session-1' }, SIGNAL))

    expect(bootstrap.repoRoot).toBe(repo.root)
    expect(bootstrap.gitVersion).toBeUndefined()
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

  it('returns only console records from the session repository (评审 I5)', async () => {
    const gitConsole = createGitConsole()
    const repo = makeRepo()
    const handler = createRpcHandler({
      runner: instrumentGitRunner(createGitRunner(createFakeSubprocess()), gitConsole),
      sandboxPolicy: () => policySource(repo.root),
      console: gitConsole,
    })
    // Another session's repository shares the process-wide console.
    gitConsole.record({ argv: ['status'], cwd: '/somewhere/else', durationMs: 1, exitCode: 0, stdout: '', stderr: '' })

    await handler('status', { sessionId: 'session-1' }, SIGNAL)
    const value = okValue<ConsoleValue>(await handler('console', { sessionId: 'session-1' }, SIGNAL))

    expect(value.records.length).toBeGreaterThan(0)
    expect(value.records.every((record) => record.cwd?.startsWith(repo.root) === true)).toBe(true)
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

describe('endpoint registry (B1 T1)', () => {
  it('registers every B1 endpoint', () => {
    expect(RPC_ENDPOINTS).toEqual(expect.arrayContaining(['mergeFile', 'mergeDraftSave', 'mergeApply', 'unresolveConflict']))
  })

  it('B1 write endpoints still require a requestId before anything else', async () => {
    const { handler } = makeHandler()
    for (const endpoint of ['mergeDraftSave', 'mergeApply', 'unresolveConflict']) {
      const error = errorOf(await handler(endpoint, { sessionId: 'session-1', path: 'a.txt' }, SIGNAL))
      expect({ endpoint, code: error.code }).toEqual({ endpoint, code: 'git/invalid-payload' })
    }
  })
})

describe('endpoint registry (A3 T1)', () => {
  it('routes every registered endpoint (none answers "unknown RPC endpoint")', async () => {
    const { handler } = makeHandler()
    for (const endpoint of RPC_ENDPOINTS) {
      const result = await handler(endpoint, { sessionId: 'session-1', requestId: 'r-1', sha: 'a'.repeat(40) }, SIGNAL)
      if (!result.ok) expect(result.error.message, endpoint).not.toBe('unknown RPC endpoint')
    }
    expect(errorOf(await handler('nope', { sessionId: 'session-1' }, SIGNAL)).message).toBe('unknown RPC endpoint')
  })

  it('implements every registered endpoint (none answers "not implemented")', async () => {
    const { handler } = makeHandler()
    for (const endpoint of RPC_ENDPOINTS) {
      const result = await handler(endpoint, { sessionId: 'session-1', requestId: 'r-1' }, SIGNAL)
      if (!result.ok) expect(result.error.message, endpoint).not.toBe('not implemented')
    }
  })

  it('serves mergeFile (B1 T2): validates the path and answers stale-target outside a conflict', async () => {
    const { handler } = makeHandler()
    expect(errorOf(await handler('mergeFile', { sessionId: 'session-1', path: '../x' }, SIGNAL)).code).toBe(
      'git/invalid-payload',
    )
    const error = errorOf(await handler('mergeFile', { sessionId: 'session-1', path: 'README.md' }, SIGNAL))
    expect(error).toMatchObject({ code: 'git/stale-target', details: { target: 'conflict' } })
  })

  it('serves blame (B2 T2) as a versioned read and validates path and revision', async () => {
    const { handler } = makeHandler()
    const value = okValue<BlameValue>(await handler('blame', { sessionId: 'session-1', path: 'README.md' }, SIGNAL))
    expect(value).toMatchObject({ path: 'README.md', rev: null, totalLines: 1, lines: ['# fixture'], version: 0 })
    expect(errorOf(await handler('blame', { sessionId: 'session-1', path: '/etc/passwd' }, SIGNAL)).code).toBe('git/invalid-payload')
    expect(errorOf(await handler('blame', { sessionId: 'session-1', path: 'README.md', rev: '-p' }, SIGNAL)).code).toBe('git/invalid-payload')
  })

  it('serves stashList and stashFiles (T5) as versioned reads and validates the sha', async () => {
    const { handler, repo } = makeHandler()
    expect(okValue<StashListValue>(await handler('stashList', { sessionId: 'session-1' }, SIGNAL))).toEqual({
      entries: [],
      version: 0,
    })
    repo.write('README.md', 'changed\n')
    repo.git('stash', 'push', '-q', '-m', 'saved')
    const sha = repo.git('rev-parse', 'refs/stash').trim()

    const files = okValue<StashFilesValue>(await handler('stashFiles', { sessionId: 'session-1', sha }, SIGNAL))
    expect(files).toMatchObject({ sha, untrackedSha: null, untracked: [], version: 0 })
    expect(files.files.map((file) => file.path)).toEqual(['README.md'])
    const bad = await handler('stashFiles', { sessionId: 'session-1', sha: 'stash@{0}' }, SIGNAL)
    expect(errorOf(bad).code).toBe('git/invalid-payload')
  })

  it('serves operationState (T2) as a versioned read', async () => {
    const { handler, repo } = makeHandler()
    const value = okValue<OperationStateValue>(await handler('operationState', { sessionId: 'session-1' }, SIGNAL))
    expect(value).toMatchObject({
      operation: null,
      ours: { label: 'main', sha: repo.git('rev-parse', 'HEAD').trim() },
      theirs: { label: '' },
      conflicts: [],
      resolved: [],
      pendingStash: false,
      version: 0,
    })
  })

  it('validates operationControl / operationCommit payloads before the gate (T2)', async () => {
    const { handler } = makeHandler()
    const control = await handler('operationControl', { sessionId: 'session-1', requestId: 'r', action: 'quit' }, SIGNAL)
    expect(errorOf(control).code).toBe('git/invalid-payload')
    const commit = await handler('operationCommit', { sessionId: 'session-1', requestId: 'r', message: '  ' }, SIGNAL)
    expect(errorOf(commit).code).toBe('git/invalid-payload')
  })

  it('serves conflictCommand (T3) for the resolved repository', async () => {
    const { handler, repo } = makeHandler()
    const value = okValue<ConflictCommandValue>(await handler('conflictCommand', { sessionId: 'session-1' }, SIGNAL))
    expect(value.command).toBe(`cd ${repo.root} && git status && git mergetool`)
  })

  it.each([
    ['checkout', { target: { kind: 'local', name: '-b' } }],
    ['createBranch', { name: 'x', startPoint: 'main' }],
    ['renameBranch', { from: 'a', to: '--force' }],
    ['deleteBranch', { name: 'x', force: false, expectedSha: 'abc' }],
    ['resolveConflict', { path: '../x', resolution: 'ours' }],
  ])('validates %s payloads before the gate (T3)', async (endpoint, extra) => {
    const { handler } = makeHandler()
    const result = await handler(endpoint, { sessionId: 'session-1', requestId: 'r', ...extra }, SIGNAL)
    expect(errorOf(result).code).toBe('git/invalid-payload')
  })

  it.each([
    ['merge', { ref: '--abort' }],
    ['rebase', { onto: '-i' }],
    ['cherryPick', { sha: 'HEAD' }],
    ['revertCommit', { sha: 'abc' }],
    ['reset', { sha: 'a'.repeat(40), mode: 'hard' }],
    ['fetch', { remote: '--all', prune: false }],
    ['pull', { remote: 'origin', branch: 'main', mode: 'squash' }],
    ['updateProject', { mode: 'ff' }],
    ['resetToRemote', { backup: 'yes' }],
  ])('validates %s payloads before the gate (T4)', async (endpoint, extra) => {
    const { handler } = makeHandler()
    const result = await handler(endpoint, { sessionId: 'session-1', requestId: 'r', ...extra }, SIGNAL)
    expect(errorOf(result).code).toBe('git/invalid-payload')
  })

  it('serves resetPreview (T4) as a versioned read and validates the sha', async () => {
    const { handler, repo } = makeHandler()
    const head = repo.git('rev-parse', 'HEAD').trim()
    const value = okValue<ResetPreviewValue>(await handler('resetPreview', { sessionId: 'session-1', sha: head }, SIGNAL))
    expect(value).toEqual({ head, discardCount: 0, commitsLost: [], truncated: false, version: 0 })
    const bad = await handler('resetPreview', { sessionId: 'session-1', sha: 'HEAD' }, SIGNAL)
    expect(errorOf(bad).code).toBe('git/invalid-payload')
  })

  it('write endpoints are a subset of the registry and require a requestId', async () => {
    const { handler } = makeHandler()
    for (const endpoint of WRITE_ENDPOINTS) {
      expect(RPC_ENDPOINTS).toContain(endpoint)
      expect(isWriteEndpoint(endpoint)).toBe(true)
      const error = errorOf(await handler(endpoint, { sessionId: 'session-1' }, SIGNAL))
      expect({ endpoint, code: error.code }).toEqual({ endpoint, code: 'git/invalid-payload' })
    }
    for (const endpoint of ['status', 'operationState', 'stashList', 'resetPreview']) {
      expect(isWriteEndpoint(endpoint)).toBe(false)
    }
  })
})
