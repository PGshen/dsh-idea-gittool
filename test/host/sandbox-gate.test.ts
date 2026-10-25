import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { ConfinedArgv, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'

import type { BootstrapValue, StatusValue } from '../../src/shared/protocol.ts'
import type { ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import type {
  SandboxGateDeps,
  SandboxLike,
  SandboxPolicySource,
} from '../../src/host/sandbox-gate.ts'
import { assertWritable, evaluateWritePolicy } from '../../src/host/sandbox-gate.ts'
import { createRpcHandler } from '../../src/host/rpc.ts'
import { createTempRepo, removeTempDir } from './fixtures.ts'
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

function makeTempDir(prefix = 'dsh-git-gate-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => removeTempDir(dir))
  return dir
}

function fakeSession(cwd: string): Session {
  return { header: { cwd } } as unknown as Session
}

/** One plausible sandbox executor: records confine calls and can fail on demand. */
interface ConfineRecording {
  calls: Array<{ argv: readonly string[]; mode: string; workspaceRoot: string }>
}

interface GateOptions {
  mode?: SandboxMode
  /** workspaceRoot reported by the policy; defaults to the repo root. */
  workspaceRoot?: string | undefined
  hasSandboxPolicy?: boolean
  hasSandbox?: boolean
  hasSession?: boolean
  confine?: 'ok' | 'throw' | 'partial'
  resolveThrows?: boolean
}

function makeGateDeps(repoRoot: string, options: GateOptions = {}): {
  deps: SandboxGateDeps
  recording: ConfineRecording
} {
  const workspaceRoot = options.workspaceRoot ?? repoRoot
  const hasSandboxPolicy = options.hasSandboxPolicy ?? true
  const hasSandbox = options.hasSandbox ?? true
  const hasSession = options.hasSession ?? true
  const mode = options.mode ?? 'workspace-write'
  const recording: ConfineRecording = { calls: [] }

  const policySource: SandboxPolicySource = {
    workspaceRoot,
    resolve: () => {
      if (options.resolveThrows === true) throw new Error('policy projection unavailable')
      return { mode, workspaceRoot }
    },
  }
  const sandbox: SandboxLike = {
    confine: async (argv, policy) => {
      recording.calls.push({ argv: [...argv], mode: policy.mode, workspaceRoot: policy.workspaceRoot })
      if (options.confine === 'throw') throw new Error('bwrap is not available')
      const enforcement = options.confine === 'partial' ? 'partial' : 'full'
      return {
        argv: ['sandbox-runner', ...argv],
        enforcement,
        denialSignatures: [],
      } as unknown as ConfinedArgv
    },
  }

  const deps: SandboxGateDeps = {
    sessions: () => ({
      get: () => (hasSession ? fakeSession(workspaceRoot) : undefined),
    }),
    sandboxPolicy: hasSandboxPolicy ? () => policySource : () => undefined,
    sandbox: hasSandbox ? () => sandbox : () => undefined,
  }
  return { deps, recording }
}

describe('evaluateWritePolicy / matrix', () => {
  it('allows writes when the session runs under danger-full-access', async () => {
    const repo = makeRepo()
    const outside = makeTempDir('dsh-git-gate-outside-')
    const { deps, recording } = makeGateDeps(repo.root, {
      mode: 'danger-full-access',
      workspaceRoot: outside,
    })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-write')
    expect(policy.workspaceRoot).toBe(outside)
    expect(recording.calls).toEqual([])
  })

  it('allows writes when the repository root is the workspace root and confine succeeds', async () => {
    const repo = makeRepo()
    const { deps, recording } = makeGateDeps(repo.root, { mode: 'workspace-write' })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-write')
    expect(policy.workspaceRoot).toBe(repo.root)
    expect(recording.calls).toHaveLength(1)
    expect(recording.calls[0]).toMatchObject({
      argv: expect.arrayContaining(['git']),
      mode: 'workspace-write',
      workspaceRoot: repo.root,
    })
  })

  it('denies writes when the session cwd is a repository subdirectory', async () => {
    const repo = makeRepo()
    const sub = join(repo.root, 'src', 'nested')
    mkdirSync(sub, { recursive: true })
    const { deps, recording } = makeGateDeps(repo.root, {
      mode: 'workspace-write',
      workspaceRoot: sub,
    })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-only')
    expect(policy.reason).toMatch(/工作区/)
    expect(policy.workspaceRoot).toBe(sub)
    expect(recording.calls).toEqual([])
  })

  it('denies writes when the repository root is outside the workspace root', async () => {
    const repo = makeRepo()
    const outside = makeTempDir('dsh-git-gate-other-')
    const { deps } = makeGateDeps(repo.root, { mode: 'workspace-write', workspaceRoot: outside })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-only')
  })

  it('does not treat a sibling path with a shared prefix as inside', async () => {
    const base = makeTempDir('dsh-git-gate-prefix-')
    const workspaceRoot = join(base, 'ws')
    const repoRoot = join(base, 'ws-evil')
    mkdirSync(workspaceRoot, { recursive: true })
    mkdirSync(repoRoot, { recursive: true })
    const { deps } = makeGateDeps(repoRoot, { mode: 'workspace-write', workspaceRoot })

    const policy = await evaluateWritePolicy({ repoRoot, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-only')
  })

  it('sees through symlinked workspace roots', async () => {
    const repo = makeRepo()
    const linkParent = makeTempDir('dsh-git-gate-link-')
    const link = join(linkParent, 'repo-link')
    symlinkSync(repo.root, link, 'dir')
    const { deps } = makeGateDeps(repo.root, { mode: 'workspace-write', workspaceRoot: link })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-write')
  })

  it('denies writes under a read-only session mode', async () => {
    const repo = makeRepo()
    const { deps, recording } = makeGateDeps(repo.root, { mode: 'read-only' })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-only')
    expect(policy.reason).toBeTruthy()
    expect(recording.calls).toEqual([])
  })
})

describe('evaluateWritePolicy / fail closed', () => {
  it('denies writes when the sandbox policy service is unavailable', async () => {
    const repo = makeRepo()
    const { deps } = makeGateDeps(repo.root, { hasSandboxPolicy: false })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-only')
    expect(policy.reason).toMatch(/fail closed/)
  })

  it('denies writes when the session is not live', async () => {
    const repo = makeRepo()
    const { deps } = makeGateDeps(repo.root, { hasSession: false })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-only')
    expect(policy.reason).toMatch(/fail closed/)
  })

  it('denies writes when policy resolution throws', async () => {
    const repo = makeRepo()
    const { deps } = makeGateDeps(repo.root, { resolveThrows: true })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-only')
    expect(policy.reason).toMatch(/fail closed/)
  })

  it('denies writes when the sandbox executor is unavailable', async () => {
    const repo = makeRepo()
    const { deps } = makeGateDeps(repo.root, { hasSandbox: false })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-only')
    expect(policy.reason).toMatch(/fail closed/)
  })

  it('denies writes when confine throws', async () => {
    const repo = makeRepo()
    const { deps } = makeGateDeps(repo.root, { confine: 'throw' })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-only')
    expect(policy.reason).toMatch(/fail closed/)
  })

  it('denies writes when confine reports partial enforcement', async () => {
    const repo = makeRepo()
    const { deps } = makeGateDeps(repo.root, { confine: 'partial' })

    const policy = await evaluateWritePolicy({ repoRoot: repo.root, sessionId: 's-1' }, deps)

    expect(policy.mode).toBe('read-only')
    expect(policy.reason).toMatch(/fail closed/)
  })
})

describe('assertWritable', () => {
  it('passes for a read-write policy', () => {
    expect(() => assertWritable({ mode: 'read-write' })).not.toThrow()
  })

  it('throws git/sandbox-denied for a read-only policy with its reason', () => {
    const failure: unknown = (() => {
      try {
        assertWritable({ mode: 'read-only', reason: '仓库根不在工作区内' })
        return undefined
      } catch (error) {
        return error
      }
    })()

    expect(failure).toBeInstanceOf(GitCommandFailure)
    expect((failure as GitCommandFailure).code).toBe('git/sandbox-denied')
    expect((failure as GitCommandFailure).message).toContain('仓库根不在工作区内')
  })
})

// ---- bootstrap 集成：门禁结果随 bootstrap 返回，读操作不受影响 ----

const SIGNAL = new AbortController().signal

function okValue<T>(result: ConnectionRpcHandlerResult): T {
  if (!result.ok) throw new Error(`expected ok result, got ${JSON.stringify(result.error)}`)
  return result.value as T
}

function makeBootstrap(repoRoot: string, options: GateOptions = {}) {
  const gate = makeGateDeps(repoRoot, options)
  const fake = createFakeSubprocess()
  const handler = createRpcHandler({
    runner: createGitRunner(fake),
    sessions: gate.deps.sessions,
    sandboxPolicy: gate.deps.sandboxPolicy,
    sandbox: gate.deps.sandbox,
  })
  return { handler, recording: gate.recording }
}

describe('bootstrap write policy', () => {
  it('reports read-write for danger-full-access sessions', async () => {
    const repo = makeRepo()
    const { handler } = makeBootstrap(repo.root, { mode: 'danger-full-access' })

    const bootstrap = okValue<BootstrapValue>(
      await handler('bootstrap', { sessionId: 's-1' }, SIGNAL),
    )

    expect(bootstrap.writePolicy.mode).toBe('read-write')
  })

  it('reports read-only with a reason while status stays available', async () => {
    const repo = makeRepo()
    const { handler } = makeBootstrap(repo.root, { mode: 'read-only' })

    const bootstrap = okValue<BootstrapValue>(
      await handler('bootstrap', { sessionId: 's-1' }, SIGNAL),
    )

    expect(bootstrap.writePolicy.mode).toBe('read-only')
    expect(bootstrap.writePolicy.reason).toBeTruthy()
    expect((bootstrap.status as StatusValue).branch).toBe('main')

    const status = okValue<StatusValue>(await handler('status', { sessionId: 's-1' }, SIGNAL))
    expect(status.branch).toBe('main')
  })

  it('fails closed without blocking reads when no sandbox policy exists', async () => {
    const repo = makeRepo()
    const { handler } = makeBootstrap(repo.root, { hasSandboxPolicy: false })

    const bootstrap = okValue<BootstrapValue>(
      await handler('bootstrap', { sessionId: 's-1' }, SIGNAL),
    )

    expect(bootstrap.writePolicy.mode).toBe('read-only')
    const status = okValue<StatusValue>(await handler('status', { sessionId: 's-1' }, SIGNAL))
    expect(status.branch).toBe('main')
  })
})
