// A2 T1 写基础设施：写/网络模式的执行环境与 confine、写访问判定、写队列、写端点的门禁与版本递增。
import { chmodSync, realpathSync, rmSync, writeFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 })
import type { ConfinedArgv, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'

import {
  GIT_NETWORK_TIMEOUT_MS,
  GIT_WRITE_TIMEOUT_MS,
  RPC_ENDPOINTS,
} from '../../src/shared/protocol.ts'
import type { BootstrapValue, CommitResultValue, StatusValue } from '../../src/shared/protocol.ts'
import {
  GIT_TIMEOUT_MS,
  GitCommandFailure,
  bindWriteContext,
  createGitRunner,
  failureFromExit,
  timeoutForMode,
} from '../../src/host/git-executor.ts'
import type { GitConfiner, WriteContext } from '../../src/host/git-executor.ts'
import type { SandboxGateDeps, SandboxLike, SandboxPolicySource } from '../../src/host/sandbox-gate.ts'
import { resolveWriteAccess } from '../../src/host/sandbox-gate.ts'
import { createWriteQueue } from '../../src/host/write-queue.ts'
import { createRepoCache } from '../../src/host/cache.ts'
import type { WriteOperations } from '../../src/host/rpc.ts'
import { createRpcHandler } from '../../src/host/rpc.ts'
import { createGitExecutable } from '../../src/host/git-executable.ts'
import { createTempDir, createTempRepo, removeTempDir, writeExecutableScript } from './fixtures.ts'
import { createFakeSubprocess, lastSpawn } from './fake-subprocess.ts'
import { GIT_BINARY } from './git-binary.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRepo(): ReturnType<typeof createTempRepo> {
  const repo = createTempRepo()
  cleanups.push(() => repo.cleanup())
  return repo
}

const SIGNAL = new AbortController().signal
const UNCONFINED: GitConfiner = { kind: 'unconfined' }

function errorOf(result: ConnectionRpcHandlerResult): { code: string; message: string; details?: unknown } {
  if (result.ok) throw new Error('expected an error result')
  return result.error
}

describe('timeoutForMode', () => {
  it('maps read/write/network to 8s/60s/180s', () => {
    expect(timeoutForMode('read')).toBe(GIT_TIMEOUT_MS)
    expect(timeoutForMode('write')).toBe(GIT_WRITE_TIMEOUT_MS)
    expect(timeoutForMode('network')).toBe(GIT_NETWORK_TIMEOUT_MS)
  })
})

describe('createGitRunner / write modes', () => {
  it('write mode uses the write environment: system config visible, no optional-locks override', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)

    await run(['status', '--porcelain'], { cwd: repo.root, mode: 'write', confine: UNCONFINED })

    const env = lastSpawn(fake).env ?? {}
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LITERAL_PATHSPECS: '1',
      LC_ALL: 'C',
    })
    expect(env.GIT_CONFIG_NOSYSTEM).toBeUndefined()
    expect(env.GIT_OPTIONAL_LOCKS).toBeUndefined()
    expect('GIT_OPTIONAL_LOCKS' in env).toBe(true) // tombstoned: an inherited value is removed
    expect(env.GIT_DIR).toBeUndefined()
  })

  it('refuses a write without a confiner and never spawns (fail closed)', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)

    const attempt = run(['commit', '-m', 'x'], { cwd: repo.root, mode: 'write' })

    await expect(attempt).rejects.toMatchObject({ code: 'git/sandbox-denied' })
    expect(fake.spawns).toHaveLength(0)
  })

  it('network mode also requires a confiner', async () => {
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)
    await expect(run(['push'], { cwd: '/', mode: 'network' })).rejects.toMatchObject({ code: 'git/sandbox-denied' })
    expect(fake.spawns).toHaveLength(0)
  })

  it('spawns the confined argv produced by the confiner', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)
    const seen: Array<readonly string[]> = []
    const confine: GitConfiner = {
      kind: 'confined',
      wrap: async (argv) => {
        seen.push(argv)
        // A transparent "sandbox" so the real command still runs.
        return ['env', ...argv]
      },
    }

    const result = await run(['rev-parse', 'HEAD'], { cwd: repo.root, mode: 'write', confine })

    expect(result.exitCode).toBe(0)
    expect(seen).toEqual([[GIT_BINARY, 'rev-parse', 'HEAD']])
    expect(lastSpawn(fake).argv).toEqual(['env', GIT_BINARY, 'rev-parse', 'HEAD'])
  })

  it('maps a confine failure to git/sandbox-denied without spawning', async () => {
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)
    const confine: GitConfiner = {
      kind: 'confined',
      wrap: async () => {
        throw new Error('SANDBOX_UNAVAILABLE')
      },
    }
    await expect(run(['commit'], { cwd: '/', mode: 'write', confine })).rejects.toMatchObject({
      code: 'git/sandbox-denied',
    })
    expect(fake.spawns).toHaveLength(0)
  })

  it('read mode ignores the confiner and keeps the read environment', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const run = createGitRunner(fake)
    await run(['rev-parse', 'HEAD'], { cwd: repo.root })
    expect(lastSpawn(fake).env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' })
  })
})

describe('failureFromExit / write classification', () => {
  it('classifies a sandbox write denial', () => {
    const failure = failureFromExit(
      { exitCode: 128, stdout: '', stderr: "fatal: Unable to create '/r/.git/index.lock': Operation not permitted\n" },
      'git commit',
    )
    expect(failure.code).toBe('git/sandbox-denied')
  })

  it('classifies a held index lock', () => {
    const failure = failureFromExit(
      { exitCode: 128, stdout: '', stderr: "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running" },
      'git commit',
    )
    expect(failure.code).toBe('git/locked')
  })
})

describe('bindWriteContext', () => {
  it('binds cwd, signal and confiner; defaults to write mode', async () => {
    const calls: Array<{ argv: readonly string[]; mode: string | undefined; cwd: string; hasConfine: boolean }> = []
    const ctx: WriteContext = bindWriteContext(
      async (argv, options) => {
        calls.push({ argv, mode: options.mode, cwd: options.cwd, hasConfine: options.confine !== undefined })
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      '/repo',
      UNCONFINED,
      SIGNAL,
    )
    await ctx.git(['commit'])
    await ctx.git(['status'], { mode: 'read' })
    await ctx.git(['push'], { mode: 'network' })
    expect(ctx.repoRoot).toBe('/repo')
    expect(calls).toEqual([
      { argv: ['commit'], mode: 'write', cwd: '/repo', hasConfine: true },
      { argv: ['status'], mode: 'read', cwd: '/repo', hasConfine: true },
      { argv: ['push'], mode: 'network', cwd: '/repo', hasConfine: true },
    ])
  })
})

// ---------------------------------------------------------------------------

function fakeSession(cwd: string): Session {
  return { header: { cwd } } as unknown as Session
}

function gateDeps(
  repoRoot: string,
  mode: SandboxMode,
  enforcement: 'full' | 'partial' = 'full',
): { deps: SandboxGateDeps; confineCalls: Array<{ argv: readonly string[]; mode: string }> } {
  const confineCalls: Array<{ argv: readonly string[]; mode: string }> = []
  const policySource: SandboxPolicySource = { workspaceRoot: repoRoot, resolve: () => ({ mode, workspaceRoot: repoRoot }) }
  const sandbox: SandboxLike = {
    confine: async (argv, policy) => {
      confineCalls.push({ argv: [...argv], mode: policy.mode })
      return { argv: ['sandbox-runner', ...argv], enforcement, denialSignatures: [] } as unknown as ConfinedArgv
    },
  }
  return {
    deps: {
      sessions: () => ({ get: () => fakeSession(repoRoot) }),
      sandboxPolicy: () => policySource,
      sandbox: () => sandbox,
    },
    confineCalls,
  }
}

describe('resolveWriteAccess', () => {
  it('danger-full-access: writable and unconfined', async () => {
    const repo = makeRepo()
    const { deps } = gateDeps(repo.root, 'danger-full-access')
    const access = await resolveWriteAccess({ repoRoot: repo.root, sessionId: 's' }, deps)
    expect(access.policy.mode).toBe('read-write')
    expect(access.confiner).toEqual({ kind: 'unconfined' })
  })

  it('workspace-write: writable and every command is wrapped by sandbox.confine', async () => {
    const repo = makeRepo()
    const { deps, confineCalls } = gateDeps(repo.root, 'workspace-write')
    const access = await resolveWriteAccess({ repoRoot: repo.root, sessionId: 's' }, deps)
    expect(access.policy.mode).toBe('read-write')
    expect(access.confiner?.kind).toBe('confined')
    if (access.confiner?.kind !== 'confined') throw new Error('unreachable')
    const wrapped = await access.confiner.wrap(['git', 'commit'], SIGNAL)
    expect(wrapped).toEqual(['sandbox-runner', 'git', 'commit'])
    expect(confineCalls.at(-1)).toEqual({ argv: ['git', 'commit'], mode: 'workspace-write' })
  })

  it('a wrap that reports partial enforcement fails closed', async () => {
    const repo = makeRepo()
    const { deps } = gateDeps(repo.root, 'workspace-write', 'partial')
    const access = await resolveWriteAccess({ repoRoot: repo.root, sessionId: 's' }, deps)
    expect(access.policy.mode).toBe('read-only')
    expect(access.confiner).toBeUndefined()
  })

  it('read-only: no confiner', async () => {
    const repo = makeRepo()
    const { deps } = gateDeps(repo.root, 'read-only')
    const access = await resolveWriteAccess({ repoRoot: repo.root, sessionId: 's' }, deps)
    expect(access.policy.mode).toBe('read-only')
    expect(access.policy.reasonCode).toBe('read-only-mode')
    expect(access.confiner).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createWriteQueue', () => {
  it('runs writes for one repository strictly in order', async () => {
    const queue = createWriteQueue()
    const order: string[] = []
    const first = deferred<void>()
    const a = queue.run('/r', 'a', async () => {
      order.push('a:start')
      await first.promise
      order.push('a:end')
      return 'a'
    })
    const b = queue.run('/r', 'b', async () => {
      order.push('b:start')
      return 'b'
    })
    await Promise.resolve()
    expect(queue.pending('/r')).toBe(2)
    first.resolve()
    expect(await Promise.all([a, b])).toEqual(['a', 'b'])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
    expect(queue.pending('/r')).toBe(0)
  })

  it('does not serialize different repositories', async () => {
    const queue = createWriteQueue()
    const gate = deferred<void>()
    const slow = queue.run('/r1', 'x', async () => {
      await gate.promise
      return 1
    })
    const fast = await queue.run('/r2', 'y', async () => 2)
    expect(fast).toBe(2)
    gate.resolve()
    expect(await slow).toBe(1)
  })

  it('deduplicates a repeated requestId while running and after completion', async () => {
    const queue = createWriteQueue()
    let runs = 0
    const gate = deferred<void>()
    const task = async (): Promise<number> => {
      runs += 1
      await gate.promise
      return runs
    }
    const first = queue.run('/r', 'same', task)
    const second = queue.run('/r', 'same', task)
    gate.resolve()
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    expect(await queue.run('/r', 'same', task)).toBe(1)
    expect(runs).toBe(1)
  })

  it('a failed write does not block the next one and its failure is replayed for the same requestId', async () => {
    const queue = createWriteQueue()
    const failure = new GitCommandFailure('git/hook-failed', 'hook')
    await expect(queue.run('/r', 'f', async () => Promise.reject(failure))).rejects.toBe(failure)
    await expect(queue.run('/r', 'f', async () => 'never')).rejects.toBe(failure)
    expect(await queue.run('/r', 'g', async () => 'ok')).toBe('ok')
  })

  it('keeps a bounded number of completed request ids', async () => {
    const queue = createWriteQueue({ rememberCompleted: 2 })
    let runs = 0
    const task = async (): Promise<number> => ++runs
    await queue.run('/r', '1', task)
    await queue.run('/r', '2', task)
    await queue.run('/r', '3', task)
    expect(await queue.run('/r', '1', task)).toBe(4) // evicted → runs again
    expect(await queue.run('/r', '3', task)).toBe(3)
  })
})

// ---------------------------------------------------------------------------

describe('write endpoints / gate, queue and version', () => {
  function makeWriteHandler(
    mode: SandboxMode,
    ops: Partial<WriteOperations>,
  ): { handler: ReturnType<typeof createRpcHandler>; repo: ReturnType<typeof createTempRepo>; cache: ReturnType<typeof createRepoCache> } {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const cache = createRepoCache()
    const { deps } = gateDeps(repo.root, mode)
    const handler = createRpcHandler({
      runner: createGitRunner(fake),
      ...deps,
      cache: () => cache,
      writeOperations: ops,
    })
    return { handler, repo, cache }
  }

  const commitOp = (sha = 'abcdef1234567'): Partial<WriteOperations> => ({
    commitFiles: {
      parse: () => ({ paths: ['a.txt'], message: 'm', amend: false }),
      run: async () => ({ sha, shortSha: sha.slice(0, 7) }),
    },
  })

  it('registers every A2 endpoint name', () => {
    for (const name of ['commitFiles', 'amendMessage', 'rollback', 'addToVcs', 'pushPreview', 'push', 'pullForPush']) {
      expect(RPC_ENDPOINTS).toContain(name)
    }
  })

  it('read-only boundary → git/sandbox-denied, the operation never runs', async () => {
    let ran = false
    const { handler } = makeWriteHandler('read-only', {
      commitFiles: { parse: () => ({}), run: async () => { ran = true; return { sha: 'x', shortSha: 'x' } } },
    })
    const result = await handler('commitFiles', { sessionId: 's', requestId: 'r1' }, SIGNAL)
    expect(errorOf(result).code).toBe('git/sandbox-denied')
    expect(ran).toBe(false)
  })

  it('requires a requestId', async () => {
    const { handler } = makeWriteHandler('workspace-write', commitOp())
    const result = await handler('commitFiles', { sessionId: 's' }, SIGNAL)
    expect(errorOf(result).code).toBe('git/invalid-payload')
  })

  it('invalid operation payload is rejected before the gate is evaluated', async () => {
    const { handler } = makeWriteHandler('read-only', {
      commitFiles: {
        parse: () => {
          throw new GitCommandFailure('git/invalid-payload', 'paths must be a non-empty array')
        },
        run: async () => ({ sha: 'x', shortSha: 'x' }),
      },
    })
    const result = await handler('commitFiles', { sessionId: 's', requestId: 'r' }, SIGNAL)
    expect(errorOf(result).code).toBe('git/invalid-payload')
  })

  it('runs the operation with a confined write context and bumps the version afterwards', async () => {
    let seen: WriteContext | undefined
    const { handler, repo, cache } = makeWriteHandler('workspace-write', {
      commitFiles: {
        parse: () => ({}),
        run: async (ctx) => {
          seen = ctx
          return { sha: 'abcdef1234567', shortSha: 'abcdef1' }
        },
      },
    })
    const before = cache.versionOf(repo.root)
    const result = await handler('commitFiles', { sessionId: 's', requestId: 'r1' }, SIGNAL)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    const value = result.value as CommitResultValue
    expect(value.sha).toBe('abcdef1234567')
    expect(value.version).toBe(cache.versionOf(repo.root))
    expect(cache.versionOf(repo.root)).toBeGreaterThan(before)
    expect(seen?.repoRoot).toBe(repo.root)
  })

  it('bumps the version even when the write fails (state may have changed)', async () => {
    const { handler, repo, cache } = makeWriteHandler('workspace-write', {
      commitFiles: {
        parse: () => ({}),
        run: async () => {
          throw new GitCommandFailure('git/hook-failed', 'pre-commit hook exited with 1')
        },
      },
    })
    const before = cache.versionOf(repo.root)
    const result = await handler('commitFiles', { sessionId: 's', requestId: 'r1' }, SIGNAL)
    expect(errorOf(result).code).toBe('git/hook-failed')
    expect(cache.versionOf(repo.root)).toBeGreaterThan(before)
  })

  it('a duplicated requestId commits once', async () => {
    let runs = 0
    const { handler } = makeWriteHandler('workspace-write', {
      commitFiles: {
        parse: () => ({}),
        run: async () => {
          runs += 1
          return { sha: 'abcdef1234567', shortSha: 'abcdef1' }
        },
      },
    })
    const [a, b] = await Promise.all([
      handler('commitFiles', { sessionId: 's', requestId: 'dup' }, SIGNAL),
      handler('commitFiles', { sessionId: 's', requestId: 'dup' }, SIGNAL),
    ])
    expect(a.ok && b.ok).toBe(true)
    expect(runs).toBe(1)
  })

  it('bootstrap reports pending writes for the repository', async () => {
    const gate = deferred<void>()
    const { handler } = makeWriteHandler('workspace-write', {
      commitFiles: {
        parse: () => ({}),
        run: async () => {
          await gate.promise
          return { sha: 'abcdef1234567', shortSha: 'abcdef1' }
        },
      },
    })
    const pending = handler('commitFiles', { sessionId: 's', requestId: 'slow' }, SIGNAL)
    await new Promise(resolve => setTimeout(resolve, 50))
    const boot = await handler('bootstrap', { sessionId: 's' }, SIGNAL)
    if (!boot.ok) throw new Error(JSON.stringify(boot.error))
    expect((boot.value as BootstrapValue).pendingWrites).toBe(1)
    gate.resolve()
    await pending
    const after = await handler('bootstrap', { sessionId: 's' }, SIGNAL)
    if (!after.ok) throw new Error('bootstrap failed')
    expect((after.value as BootstrapValue).pendingWrites ?? 0).toBe(0)
  })

  it('unimplemented default operations fail structurally instead of throwing', async () => {
    const repo = makeRepo()
    const { deps } = gateDeps(repo.root, 'workspace-write')
    const handler = createRpcHandler({ runner: createGitRunner(createFakeSubprocess()), ...deps })
    const result = await handler('rollback', { sessionId: 's', requestId: 'r', paths: [], deleteUntracked: false }, SIGNAL)
    expect(result.ok).toBe(false)
    // Status reads keep working next to the write endpoints.
    const status = await handler('status', { sessionId: 's' }, SIGNAL)
    expect((status.ok ? (status.value as StatusValue).branch : null)).toBe('main')
  })
})

describe('review fixes', () => {
  it('write environment disables every interactive credential path (评审 I5)', async () => {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    await createGitRunner(fake)(['status'], { cwd: repo.root, mode: 'network', confine: UNCONFINED })
    expect(lastSpawn(fake).env).toMatchObject({
      GIT_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GCM_INTERACTIVE: 'never',
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
    })
  })

  it('a git directory outside the workspace makes the repository read-only (评审 I6)', async () => {
    const repo = makeRepo()
    const { deps } = gateDeps(repo.root, 'workspace-write')
    const access = await resolveWriteAccess(
      { repoRoot: repo.root, sessionId: 's', gitDirs: [repo.root + '/.git', '/somewhere/else/.git'] },
      deps,
    )
    expect(access.policy.mode).toBe('read-only')
    expect(access.policy.reasonCode).toBe('repo-outside-workspace')
  })

  it('a write keeps running after the HTTP request is cancelled (评审 I1)', async () => {
    let seen: WriteContext | undefined
    const gate = deferred<void>()
    const repo = makeRepo()
    const { deps } = gateDeps(repo.root, 'workspace-write')
    const handler = createRpcHandler({
      runner: createGitRunner(createFakeSubprocess()),
      ...deps,
      writeOperations: {
        commitFiles: {
          parse: () => ({}),
          run: async (ctx) => {
            seen = ctx
            await gate.promise
            return { sha: 'abcdef1234567', shortSha: 'abcdef1' }
          },
        },
      },
    })
    const request = new AbortController()
    const pending = handler('commitFiles', { sessionId: 's', requestId: 'r' }, request.signal)
    for (let waited = 0; seen === undefined && waited < 10_000; waited += 20) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    request.abort()
    expect(seen?.signal.aborted).toBe(false)
    gate.resolve()
    expect((await pending).ok).toBe(true)
  })
})

describe('git path snapshot per write (t2 T5, ADR 0014)', () => {
  function gitWrapper(): string {
    const dir = createTempDir('dsh-git-path-')
    cleanups.push(() => removeTempDir(dir))
    return realpathSync(writeExecutableScript(dir, 'git', `#!/bin/sh\nexec "${GIT_BINARY}" "$@"\n`))
  }

  function setup(run: (ctx: WriteContext) => Promise<void>): {
    handler: ReturnType<typeof createRpcHandler>
    repo: ReturnType<typeof createTempRepo>
    fake: ReturnType<typeof createFakeSubprocess>
    gitExecutable: ReturnType<typeof createGitExecutable>
  } {
    const repo = makeRepo()
    const fake = createFakeSubprocess()
    const gitExecutable = createGitExecutable(fake)
    const { deps } = gateDeps(repo.root, 'danger-full-access')
    const handler = createRpcHandler({
      runner: createGitRunner(fake, { executable: gitExecutable }),
      gitExecutable,
      ...deps,
      writeOperations: {
        commitFiles: {
          parse: () => ({}),
          run: async (ctx) => {
            await run(ctx)
            return { sha: 'abcdef1234567', shortSha: 'abcdef1' }
          },
        },
      },
    })
    return { handler, repo, fake, gitExecutable }
  }

  /** argv[0] of every command spawned in the repository since `from`. */
  const programsSince = (fake: ReturnType<typeof createFakeSubprocess>, root: string, from: number): string[] =>
    fake.spawns.slice(from).filter(spawn => spawn.spec.cwd === root).map(spawn => String(spawn.spec.argv[0]))

  it('runs every command of one write with the git in effect when it started; the next write uses the new one', async () => {
    const first = gitWrapper()
    const second = gitWrapper()
    let from = 0
    let mid: (() => Promise<unknown>) | undefined
    const { handler, repo, fake, gitExecutable } = setup(async (ctx) => {
      from = fake.spawns.length
      await ctx.git(['--version'], { mode: 'read' })
      await mid?.()
      await ctx.git(['rev-parse', 'HEAD'], { mode: 'read' })
      await ctx.git(['status', '--porcelain'])
    })
    await gitExecutable.set(first, SIGNAL)
    mid = async () => {
      const result = await handler('gitExecutable', { sessionId: 's', path: second }, SIGNAL)
      if (!result.ok) throw new Error(JSON.stringify(result.error))
    }

    expect((await handler('commitFiles', { sessionId: 's', requestId: 'w1' }, SIGNAL)).ok).toBe(true)
    const during = programsSince(fake, repo.root, from)
    expect(gitExecutable.override()).toBe(second)
    expect(during).toHaveLength(3)
    expect(new Set(during)).toEqual(new Set([first]))

    mid = undefined
    expect((await handler('commitFiles', { sessionId: 's', requestId: 'w2' }, SIGNAL)).ok).toBe(true)
    expect(new Set(programsSince(fake, repo.root, from))).toEqual(new Set([second]))
  })

  it('stops a write whose pinned git was replaced mid-way (identity still checked per command)', async () => {
    const first = gitWrapper()
    const { handler, gitExecutable } = setup(async (ctx) => {
      await ctx.git(['--version'], { mode: 'read' })
      rmSync(first)
      writeFileSync(first, '#!/bin/sh\necho swapped\n')
      chmodSync(first, 0o755)
      await ctx.git(['status', '--porcelain'])
    })
    await gitExecutable.set(first, SIGNAL)

    expect(errorOf(await handler('commitFiles', { sessionId: 's', requestId: 'w' }, SIGNAL)).code).toBe('git/not-found')
  })
})
