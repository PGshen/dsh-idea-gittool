import { afterEach, describe, expect, it } from 'vitest'
import type {
  ConnectionRpcFailure,
  ConnectionRpcHandlerResult,
} from '@deepseek-ai/dsh-client-connection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

import type { BootstrapValue, LogValue, StatusValue, WritePolicyValue } from '../../src/shared/protocol.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
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
    const { handler, repo } = makeHandler({ version: () => 7 })

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
