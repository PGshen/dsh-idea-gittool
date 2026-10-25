import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'

import { createGitRunner } from '../../src/host/git-executor.ts'
import type { RepoResolverDeps, SessionPersistenceLike } from '../../src/host/repo-resolver.ts'
import { resolveRepository, resolveSessionCwd } from '../../src/host/repo-resolver.ts'
import {
  canonicalPath,
  createTempDir,
  createTempRepo,
  removeTempDir,
  writeExecutableScript,
} from './fixtures.ts'
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

function makeTempDir(): string {
  const dir = createTempDir('dsh-git-resolver-')
  cleanups.push(() => removeTempDir(dir))
  return dir
}

function fakeSession(cwd: string | undefined): Session {
  return { header: { cwd } } as unknown as Session
}

function makeDeps(overrides: Partial<RepoResolverDeps> = {}): {
  deps: RepoResolverDeps
  fake: ReturnType<typeof createFakeSubprocess>
} {
  const fake = createFakeSubprocess()
  return {
    deps: { runner: createGitRunner(fake), ...overrides },
    fake,
  }
}

const unusedPersistence: SessionPersistenceLike = {
  stat: async () => undefined,
}

describe('resolveSessionCwd', () => {
  it('prefers the live session effective directory', async () => {
    const session = fakeSession('/from/header')
    const { deps } = makeDeps({
      sessions: () => ({ get: () => session }),
      workingDirectory: () => ({ get: () => '/effective/dir' }),
      sessionPersistence: () => unusedPersistence,
    })

    await expect(resolveSessionCwd(deps, 's-1')).resolves.toBe('/effective/dir')
  })

  it('falls back to the live header cwd without an effective directory', async () => {
    const session = fakeSession('/from/header')
    const { deps } = makeDeps({
      sessions: () => ({ get: () => session }),
      sessionPersistence: () => unusedPersistence,
    })

    await expect(resolveSessionCwd(deps, 's-1')).resolves.toBe('/from/header')
  })

  it('reads the stored header for a dormant session', async () => {
    const { deps } = makeDeps({
      sessions: () => ({ get: () => undefined }),
      sessionPersistence: () => ({
        stat: async () => ({ header: { cwd: '/stored/cwd' } }),
      }),
    })

    await expect(resolveSessionCwd(deps, 's-1')).resolves.toBe('/stored/cwd')
  })

  it('passes the request signal to session persistence', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const { deps } = makeDeps({
      sessions: () => ({ get: () => undefined }),
      sessionPersistence: () => ({
        stat: async (_id, options) => {
          seen = options?.signal
          return { header: { cwd: '/stored/cwd' } }
        },
      }),
    })

    await resolveSessionCwd(deps, 's-1', controller.signal)

    expect(seen).toBe(controller.signal)
  })

  it('falls back to the sandbox workspace root when persistence fails', async () => {
    const { deps } = makeDeps({
      sessions: () => ({ get: () => undefined }),
      sessionPersistence: () => ({
        stat: async () => {
          throw new Error('storage offline')
        },
      }),
      sandboxPolicy: () => ({ workspaceRoot: '/sandbox/root' }),
    })

    await expect(resolveSessionCwd(deps, 's-1')).resolves.toBe('/sandbox/root')
  })

  it('resolves to undefined when no source knows a directory', async () => {
    const { deps } = makeDeps({
      sessions: () => ({ get: () => undefined }),
      sessionPersistence: () => ({ stat: async () => undefined }),
    })

    await expect(resolveSessionCwd(deps, 's-1')).resolves.toBeUndefined()
  })
})

describe('resolveRepository', () => {
  it('uses the live working directory and the git top level', async () => {
    const repo = makeRepo()
    const sub = join(repo.root, 'src', 'nested')
    mkdirSync(sub, { recursive: true })
    const session = fakeSession(sub)
    const { deps } = makeDeps({
      sessions: () => ({ get: () => session }),
      workingDirectory: () => ({ get: () => sub }),
    })

    const resolution = await resolveRepository(deps, 's-1')

    expect(resolution.kind).toBe('repository')
    if (resolution.kind !== 'repository') return
    expect(canonicalPath(resolution.root)).toBe(canonicalPath(repo.root))
    expect(resolution.cwd).toBe(sub)
  })

  it('uses the stored session header when the session is dormant', async () => {
    const repo = makeRepo()
    const { deps } = makeDeps({
      sessions: () => ({ get: () => undefined }),
      sessionPersistence: () => ({ stat: async () => ({ header: { cwd: repo.root } }) }),
    })

    const resolution = await resolveRepository(deps, 's-1')

    expect(resolution.kind).toBe('repository')
    if (resolution.kind !== 'repository') return
    expect(canonicalPath(resolution.root)).toBe(canonicalPath(repo.root))
  })

  it('falls back to the sandbox workspace root', async () => {
    const repo = makeRepo()
    const { deps } = makeDeps({
      sessions: () => ({ get: () => undefined }),
      sandboxPolicy: () => ({ workspaceRoot: repo.root }),
    })

    const resolution = await resolveRepository(deps, 's-1')

    expect(resolution.kind).toBe('repository')
  })

  it('reports no-session when nothing knows a directory', async () => {
    const { deps } = makeDeps({
      sessions: () => ({ get: () => undefined }),
      sessionPersistence: () => ({ stat: async () => undefined }),
    })

    await expect(resolveRepository(deps, 's-1')).resolves.toEqual({ kind: 'no-session' })
  })

  it('reports not-a-repository when the directory does not exist', async () => {
    const dir = makeTempDir()
    const missing = join(dir, 'gone')
    const { deps } = makeDeps({ sandboxPolicy: () => ({ workspaceRoot: missing }) })

    const resolution = await resolveRepository(deps, 's-1')

    expect(resolution.kind).toBe('not-a-repository')
    if (resolution.kind !== 'not-a-repository') return
    expect(resolution.cwd).toBe(missing)
  })

  it('reports not-a-repository when the directory is outside any repository', async () => {
    const dir = makeTempDir()
    const { deps } = makeDeps({ sandboxPolicy: () => ({ workspaceRoot: dir }) })

    const resolution = await resolveRepository(deps, 's-1')

    expect(resolution.kind).toBe('not-a-repository')
  })

  it('surfaces a deadline instead of reporting not-a-repository', async () => {
    const dir = makeTempDir()
    const slow = writeExecutableScript(dir, 'slow-git.sh', '#!/bin/sh\nsleep 5\n')
    const fake = createFakeSubprocess({ executable: slow })
    const deps: RepoResolverDeps = {
      runner: createGitRunner(fake),
      sandboxPolicy: () => ({ workspaceRoot: dir }),
    }

    await expect(resolveRepository(deps, 's-1', undefined, { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'git/timeout',
    })
  })
})
