import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 仓库 + 进程 spawn 在并发 worker 下偶尔超过默认 5s，这里按文件放宽。
vi.setConfig({ testTimeout: 30_000 })

import { createRepoCache } from '../../src/host/cache.ts'
import type { GitRunner } from '../../src/host/git-executor.ts'
import { createGitRunner } from '../../src/host/git-executor.ts'
import type { RpcDeps, RpcRuntime } from '../../src/host/rpc.ts'
import { createRpcRuntime } from '../../src/host/rpc.ts'
import type { SandboxPolicySource } from '../../src/host/sandbox-gate.ts'
import type { FsWatch } from '../../src/host/watch.ts'
import { gitWatchTargets } from '../../src/host/watch.ts'
import type { BootstrapValue, LogValue, StatusValue } from '../../src/shared/protocol.ts'
import type { ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
import type { Session } from '@deepseek-ai/dsh-session'

import { createTempRepo, delay } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRepo(options: { initialCommit?: boolean } = {}): ReturnType<typeof createTempRepo> {
  const repo = createTempRepo(options)
  cleanups.push(() => repo.cleanup())
  return repo
}

const SIGNAL = new AbortController().signal

function okValue<T>(result: ConnectionRpcHandlerResult): T {
  if (!result.ok) throw new Error(`expected ok result, got ${JSON.stringify(result.error)}`)
  return result.value as T
}

function policySource(workspaceRoot: string): SandboxPolicySource {
  return {
    workspaceRoot,
    resolve: () => ({ mode: 'read-only', workspaceRoot }),
  }
}

interface FakeFsWatch {
  fsWatch: FsWatch
  emit: () => void
  closed: string[]
  watched: () => string[]
}

function makeFakeFsWatch(): FakeFsWatch {
  const callbacks = new Map<string, () => void>()
  const closed: string[] = []
  const fsWatch: FsWatch = (target, onEvent) => {
    callbacks.set(target, onEvent)
    return {
      close: () => {
        closed.push(target)
      },
    }
  }
  return {
    fsWatch,
    emit: () => {
      for (const callback of [...callbacks.values()]) callback()
    },
    closed,
    watched: () => [...callbacks.keys()],
  }
}

interface Environment {
  runtime: RpcRuntime
  cache: ReturnType<typeof createRepoCache>
  fake: ReturnType<typeof createFakeSubprocess>
  repo: ReturnType<typeof createTempRepo>
}

function makeEnvironment(
  overrides: Partial<RpcDeps> = {},
  repoOptions: { initialCommit?: boolean } = {},
): Environment {
  const repo = makeRepo(repoOptions)
  const cache = createRepoCache()
  const fake = createFakeSubprocess()
  const runtime = createRpcRuntime({
    runner: createGitRunner(fake),
    sandboxPolicy: () => policySource(repo.root),
    cache: () => cache,
    ...overrides,
  })
  return { runtime, cache, fake, repo }
}

function spawnsOf(fake: ReturnType<typeof createFakeSubprocess>, command: string): number {
  return fake.spawns.filter((record) => record.spec.argv.includes(command)).length
}

describe('rpc cache', () => {
  it('serves a cached status and reports its version', async () => {
    const { runtime, fake, repo } = makeEnvironment()

    const first = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )
    expect(first.version).toBe(0)
    const statusSpawns = spawnsOf(fake, 'status')
    expect(statusSpawns).toBeGreaterThan(0)

    const second = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )
    expect(second).toEqual(first)
    expect(spawnsOf(fake, 'status')).toBe(statusSpawns)
    expect(second.branch).toBe('main')
    expect(repo.root).toBeTruthy()
  })

  it('recomputes after a version bump and reports the new version', async () => {
    const { runtime, cache, fake, repo } = makeEnvironment()
    await runtime.handler('status', { sessionId: 's-1' }, SIGNAL)
    const before = spawnsOf(fake, 'status')

    cache.bumpVersion(repo.root)
    const next = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )

    expect(next.version).toBe(1)
    expect(spawnsOf(fake, 'status')).toBe(before + 1)
  })

  it('uses one version for the whole bootstrap snapshot', async () => {
    const { runtime, cache, repo } = makeEnvironment()
    cache.bumpVersion(repo.root)

    const bootstrap = okValue<BootstrapValue>(
      await runtime.handler('bootstrap', { sessionId: 's-1' }, SIGNAL),
    )

    expect(bootstrap.version).toBe(1)
    expect(bootstrap.status?.version).toBe(1)
  })

  it('caches log pages per cursor and per limit', async () => {
    const repo = makeRepo({ initialCommit: false })
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      repo.write(name, `${name}\n`)
      repo.commit(name)
    }
    const fake = createFakeSubprocess()
    const cache = createRepoCache()
    const runtime = createRpcRuntime({
      runner: createGitRunner(fake),
      sandboxPolicy: () => policySource(repo.root),
      cache: () => cache,
    })

    const first = okValue<LogValue>(
      await runtime.handler('log', { sessionId: 's-1', limit: 1 }, SIGNAL),
    )
    expect(first.commits).toHaveLength(1)
    expect(first.version).toBe(0)
    const logSpawns = spawnsOf(fake, 'log')

    const cached = okValue<LogValue>(
      await runtime.handler('log', { sessionId: 's-1', limit: 1 }, SIGNAL),
    )
    expect(cached).toEqual(first)
    expect(spawnsOf(fake, 'log')).toBe(logSpawns)

    await runtime.handler('log', { sessionId: 's-1', limit: 2 }, SIGNAL)
    expect(spawnsOf(fake, 'log')).toBe(logSpawns + 1)
  })

  it('drops a cache write that races a version bump', async () => {
    const repo = makeRepo()
    const cache = createRepoCache()
    const fake = createFakeSubprocess()
    const base = createGitRunner(fake)
    let bumped = false
    const runner: GitRunner = async (argv, options) => {
      const result = await base(argv, options)
      if (!bumped && argv.includes('status')) {
        bumped = true
        cache.bumpVersion(repo.root)
      }
      return result
    }
    const runtime = createRpcRuntime({
      runner,
      sandboxPolicy: () => policySource(repo.root),
      cache: () => cache,
    })

    const stale = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )
    expect(stale.version).toBe(0)
    const statusSpawns = spawnsOf(fake, 'status')

    // The racing bump must prevent the optimistic cache write, so this recomputes.
    const fresh = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )
    expect(fresh.version).toBe(1)
    expect(spawnsOf(fake, 'status')).toBe(statusSpawns + 1)
  })
})

describe('rpc watch wiring', () => {
  it('starts one watch per .git target on first read and bumps the version on change', async () => {
    const fs = makeFakeFsWatch()
    const { runtime, fake } = makeEnvironment({ fsWatch: () => fs.fsWatch, watchDebounceMs: 0 })

    const first = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )
    expect(first.version).toBe(0)
    expect(fs.watched()).toHaveLength(gitWatchTargets('/r').length)

    fs.emit()
    await delay(10)

    const next = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )
    expect(next.version).toBe(1)
    expect(spawnsOf(fake, 'status')).toBe(2)
  })

  it('merges burst signals through the debounce window', async () => {
    const fs = makeFakeFsWatch()
    const { runtime } = makeEnvironment({ fsWatch: () => fs.fsWatch, watchDebounceMs: 20 })
    await runtime.handler('status', { sessionId: 's-1' }, SIGNAL)

    fs.emit()
    fs.emit()
    fs.emit()
    await delay(60)

    const next = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )
    expect(next.version).toBe(1)
  })

  it('keeps reads working when the watch provider itself throws', async () => {
    const { runtime } = makeEnvironment({
      fsWatch: () => {
        throw new Error('fs service exploded')
      },
    })

    const status = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )

    expect(status.version).toBe(0)
    expect(status.branch).toBe('main')
  })

  it('keeps reads working when watch is unavailable', async () => {
    const { runtime } = makeEnvironment()
    const status = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )

    expect(status.version).toBe(0)
    expect(status.branch).toBe('main')
  })

  it('closes every watch on dispose and stays idempotent', async () => {
    const fs = makeFakeFsWatch()
    const { runtime } = makeEnvironment({ fsWatch: () => fs.fsWatch, watchDebounceMs: 0 })
    await runtime.handler('status', { sessionId: 's-1' }, SIGNAL)

    await runtime.dispose()
    expect(fs.closed).toHaveLength(gitWatchTargets('/r').length)
    await expect(runtime.dispose()).resolves.toBeUndefined()

    // Reads still work after dispose (no watch is recreated).
    const status = okValue<StatusValue>(
      await runtime.handler('status', { sessionId: 's-1' }, SIGNAL),
    )
    expect(status.branch).toBe('main')
    expect(fs.watched()).toHaveLength(gitWatchTargets('/r').length)
  })
})

describe('rpc bootstrap with write policy', () => {
  it('returns the gate decision and the snapshot version together', async () => {
    const repo = makeRepo()
    const session: Session = { header: { cwd: repo.root } } as unknown as Session
    const runtime = createRpcRuntime({
      runner: createGitRunner(createFakeSubprocess()),
      sessions: () => ({ get: () => session }),
      sandboxPolicy: () => ({
        workspaceRoot: repo.root,
        resolve: () => ({ mode: 'workspace-write', workspaceRoot: repo.root }),
      }),
    })

    const bootstrap = okValue<BootstrapValue>(
      await runtime.handler('bootstrap', { sessionId: 's-1' }, SIGNAL),
    )

    expect(bootstrap.version).toBe(0)
    // No sandbox executor is injected, so the gate fails closed.
    expect(bootstrap.writePolicy.mode).toBe('read-only')
    expect(bootstrap.writePolicy.reason).toMatch(/fail closed/)
    expect(bootstrap.status?.branch).toBe('main')
  })
})
