// A2 T3：推送、推送预览（本地 bare 远程 + 脚本化 runner 的分类测试）。
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PushRejectedDetails } from '../../src/shared/protocol.ts'
import { PUSH_PREVIEW_COMMIT_LIMIT } from '../../src/shared/protocol.ts'
import { GitCommandFailure, createGitRunner } from '../../src/host/git-executor.ts'
import type { WriteContext } from '../../src/host/git-executor.ts'
import {
  classifyRejection,
  parsePushPorcelain,
  pushOperation,
  readPushPreview,
} from '../../src/host/git/push.ts'
import { TEST_GIT_ENV, createTempRepo, writeExecutableScript } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'
import { contextFor, createRemoteSetup, pushFromOther, scriptedContext } from './remote-fixtures.ts'
import type { RemoteSetup } from './remote-fixtures.ts'

// Each test spawns dozens of git processes (clones, pushes); allow for a loaded machine.
vi.setConfig({ testTimeout: 90_000 })

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function setup(): RemoteSetup {
  const remote = createRemoteSetup()
  cleanups.push(remote.cleanup)
  return remote
}

function makeRepo(options: { initialCommit?: boolean } = {}): TempRepo {
  const repo = createTempRepo(options)
  cleanups.push(() => repo.cleanup())
  return repo
}

async function failureOf(promise: Promise<unknown>): Promise<GitCommandFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected a GitCommandFailure')
}

async function push(ctx: WriteContext, payload: Record<string, unknown>) {
  return await pushOperation.run(ctx, pushOperation.parse({ sessionId: 's', requestId: 'r', ...payload }))
}

function preview(repo: TempRepo) {
  return readPushPreview(createGitRunner(createFakeSubprocess()), repo.root)
}

function remoteHead(remote: RemoteSetup, branch = 'main'): string {
  return remote.local.git('ls-remote', remote.bare, `refs/heads/${branch}`).split('\t')[0] ?? ''
}

describe('parsePushPorcelain / classifyRejection', () => {
  it('parses ref lines and skips To/Done lines', () => {
    const stdout = [
      'To https://example.com/r.git',
      '=\tHEAD:refs/heads/main\t[up to date]',
      '!\tHEAD:refs/heads/dev\t[rejected] (fetch first)',
      'Done',
      '',
    ].join('\n')
    expect(parsePushPorcelain(stdout)).toEqual([
      { flag: '=', from: 'HEAD', to: 'refs/heads/main', summary: '[up to date]' },
      { flag: '!', from: 'HEAD', to: 'refs/heads/dev', summary: '[rejected] (fetch first)' },
    ])
  })

  it('maps rejection summaries to reasons', () => {
    expect(classifyRejection('[rejected] (non-fast-forward)', '')).toBe('non-fast-forward')
    expect(classifyRejection('[rejected] (fetch first)', '')).toBe('fetch-first')
    expect(classifyRejection('[rejected] (stale info)', '')).toBe('stale-lease')
    expect(classifyRejection('[remote rejected] (protected branch hook declined)', '')).toBe('protected')
    expect(
      classifyRejection('[remote rejected] (pre-receive hook declined)', 'remote: You are not allowed to push code to protected branches'),
    ).toBe('protected')
    expect(classifyRejection('[remote rejected] (pre-receive hook declined)', 'remote: nope')).toBe('hook-declined')
    expect(classifyRejection('[remote rejected] (shallow update not allowed)', '')).toBe('other')
  })
})

describe('pushOperation.parse', () => {
  it('rejects missing, option-like and whitespace names', () => {
    const codeOf = (payload: unknown): string => {
      try {
        pushOperation.parse(payload)
      } catch (error) {
        if (error instanceof GitCommandFailure) return error.code
        throw error
      }
      return 'ok'
    }
    expect(codeOf({ remote: 'origin' })).toBe('git/invalid-payload')
    expect(codeOf({ remote: '--upload-pack=evil', branch: 'main' })).toBe('git/invalid-payload')
    expect(codeOf({ remote: 'origin', branch: '-f' })).toBe('git/invalid-payload')
    expect(codeOf({ remote: 'origin', branch: 'a b' })).toBe('git/invalid-payload')
    expect(codeOf({ remote: 'origin', branch: 'main', forceWithLease: 'yes' })).toBe('git/invalid-payload')
    expect(codeOf({ remote: 'origin', branch: 'feature/x' })).toBe('ok')
  })
})

describe('pushOperation.run (local bare remote)', () => {
  it('pushes HEAD, then reports updated=false when up to date', async () => {
    const remote = setup()
    remote.local.write('a.txt', 'a\n')
    const sha = remote.local.commit('local work')

    expect(await push(contextFor(remote.local), { remote: 'origin', branch: 'main' })).toEqual({
      remote: 'origin',
      branch: 'main',
      updated: true,
    })
    expect(remoteHead(remote)).toBe(sha)
    expect((await push(contextFor(remote.local), { remote: 'origin', branch: 'main' })).updated).toBe(false)
  })

  it('sets upstream for a new branch when asked', async () => {
    const remote = setup()
    remote.local.git('checkout', '-q', '-b', 'feature/x')
    remote.local.write('f.txt', 'f\n')
    remote.local.commit('feature')

    await push(contextFor(remote.local), { remote: 'origin', branch: 'feature/x', setUpstream: true })

    expect(remote.local.git('rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/feature/x')
  })

  it('pushes a detached HEAD only to the explicitly named branch', async () => {
    const remote = setup()
    remote.local.git('checkout', '-q', '--detach')
    remote.local.write('d.txt', 'd\n')
    const sha = remote.local.commit('detached work')
    await push(contextFor(remote.local), { remote: 'origin', branch: 'review/detached' })
    expect(remoteHead(remote, 'review/detached')).toBe(sha)
  })

  it('pushes annotated tags reachable from HEAD with tags=true', async () => {
    const remote = setup()
    remote.local.write('t.txt', 't\n')
    remote.local.commit('tagged')
    remote.local.git('tag', '-a', 'v1.0', '-m', 'release')
    await push(contextFor(remote.local), { remote: 'origin', branch: 'main', tags: true })
    expect(remote.local.git('ls-remote', '--tags', remote.bare)).toContain('refs/tags/v1.0')
  })

  it('rejects a push behind the remote with reason and the remote commits (fetch first / non-fast-forward)', async () => {
    const remote = setup()
    const theirs = pushFromOther(remote.other, 'theirs.txt', 'x\n', 'their change')
    remote.local.write('mine.txt', 'y\n')
    remote.local.commit('my change')

    const failure = await failureOf(push(contextFor(remote.local), { remote: 'origin', branch: 'main' }))
    expect(failure.code).toBe('git/rejected')
    const details = failure.details as unknown as PushRejectedDetails
    expect(details.reason).toBe('fetch-first')
    expect(details.remote).toBe('origin')
    expect(details.branch).toBe('main')
    expect(details.summary).toContain('fetch first')
    expect(details.remoteCommits.map((commit) => commit.sha)).toEqual([theirs])
    expect(details.remoteCommits[0]?.subject).toBe('their change')

    // After the fetch the local side knows the remote tip: a retry is non-fast-forward.
    const again = await failureOf(push(contextFor(remote.local), { remote: 'origin', branch: 'main' }))
    expect((again.details as unknown as PushRejectedDetails).reason).toBe('non-fast-forward')
  })

  it('force-with-lease fails after someone else updated the remote, then succeeds once seen', async () => {
    const remote = setup()
    remote.local.write('mine.txt', 'mine\n')
    remote.local.commit('mine')
    remote.local.git('fetch', '-q', 'origin')
    const theirs = pushFromOther(remote.other, 'theirs.txt', 'theirs\n', 'theirs')

    const failure = await failureOf(
      push(contextFor(remote.local), { remote: 'origin', branch: 'main', forceWithLease: true }),
    )
    expect(failure.code).toBe('git/rejected')
    const details = failure.details as unknown as PushRejectedDetails
    expect(details.reason).toBe('stale-lease')
    expect(details.remoteCommits.map((commit) => commit.sha)).toEqual([theirs])
    expect(remoteHead(remote)).toBe(theirs)

    // The rejection fetched the remote tip, so the user has now "seen" it and the lease holds.
    await push(contextFor(remote.local), { remote: 'origin', branch: 'main', forceWithLease: true })
    expect(remoteHead(remote)).toBe(remote.local.git('rev-parse', 'HEAD').trim())
  })

  it('classifies remote hook rejections, including protected branches', async () => {
    const remote = setup()
    remote.local.write('a.txt', 'a\n')
    remote.local.commit('a')
    writeExecutableScript(`${remote.bare}/hooks`, 'pre-receive', '#!/bin/sh\necho "policy says no"\nexit 1\n')
    const declined = await failureOf(push(contextFor(remote.local), { remote: 'origin', branch: 'main' }))
    expect((declined.details as unknown as PushRejectedDetails).reason).toBe('hook-declined')
    expect((declined.details as unknown as PushRejectedDetails).remoteCommits).toEqual([])

    writeExecutableScript(
      `${remote.bare}/hooks`,
      'pre-receive',
      '#!/bin/sh\necho "GitLab: You are not allowed to push code to protected branches on this project."\nexit 1\n',
    )
    const protectedBranch = await failureOf(push(contextFor(remote.local), { remote: 'origin', branch: 'main' }))
    expect((protectedBranch.details as unknown as PushRejectedDetails).reason).toBe('protected')
  })

  it('maps a failing local pre-push hook to git/hook-failed (never --no-verify)', async () => {
    const remote = setup()
    remote.local.write('a.txt', 'a\n')
    remote.local.commit('a')
    writeExecutableScript(`${remote.local.root}/.git/hooks`, 'pre-push', '#!/bin/sh\necho "tests failed" >&2\nexit 1\n')
    const before = remoteHead(remote)
    const failure = await failureOf(push(contextFor(remote.local), { remote: 'origin', branch: 'main' }))
    expect(failure.code).toBe('git/hook-failed')
    expect(String(failure.details?.output)).toContain('tests failed')
    expect(remoteHead(remote)).toBe(before)
  })

  it('validates the remote against `git remote` and the branch with check-ref-format', async () => {
    const remote = setup()
    const unknown = await failureOf(push(contextFor(remote.local), { remote: 'upstream', branch: 'main' }))
    expect(unknown.code).toBe('git/invalid-payload')
    const badRef = await failureOf(push(contextFor(remote.local), { remote: 'origin', branch: 'a..b' }))
    expect(badRef.code).toBe('git/invalid-payload')
    const lock = await failureOf(push(contextFor(remote.local), { remote: 'origin', branch: 'x.lock' }))
    expect(lock.code).toBe('git/invalid-payload')
  })
})

describe('pushOperation.run (classification with scripted git output)', () => {
  const remoteAndRefOk = (args: readonly string[]) => {
    if (args[0] === 'remote') return { stdout: 'origin\n' }
    if (args[0] === 'check-ref-format') return { exitCode: 0 }
    return undefined
  }

  it.each([
    "fatal: could not read Username for 'https://alice:ghp_secret@github.com': terminal prompts disabled",
    'remote: HTTP Basic: Access denied\nfatal: Authentication failed for \'https://alice:ghp_secret@gitlab.com/x.git/\'',
    'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
  ])('maps auth failures to git/auth-required with a credential-free command: %s', async (stderr) => {
    const { ctx } = scriptedContext((args) => remoteAndRefOk(args) ?? { exitCode: 128, stderr }, '/work/my repo')
    const failure = await failureOf(push(ctx, { remote: 'origin', branch: 'feature/x', setUpstream: true }))
    expect(failure.code).toBe('git/auth-required')
    const command = String(failure.details?.command)
    expect(command).toBe("cd '/work/my repo' && git push --set-upstream origin HEAD:refs/heads/feature/x")
    expect(JSON.stringify(failure.details)).not.toContain('ghp_secret')
    expect(failure.message).not.toContain('ghp_secret')
  })

  it('maps an unpacker error from a sandboxed local remote to git/sandbox-denied, not git/rejected', async () => {
    const { ctx } = scriptedContext(
      (args) =>
        remoteAndRefOk(args) ?? {
          exitCode: 1,
          stdout: 'To /outside/remote.git\n!\tHEAD:refs/heads/main\t[remote rejected] (unpacker error)\nDone\n',
          stderr: 'remote: error: unable to create temporary object directory\nerror: failed to push some refs',
        },
    )
    const failure = await failureOf(push(ctx, { remote: 'origin', branch: 'main' }))
    expect(failure.code).toBe('git/sandbox-denied')
  })

  it('redacts credentials from other failures', async () => {
    const { ctx } = scriptedContext(
      (args) =>
        remoteAndRefOk(args) ?? {
          exitCode: 128,
          stderr: "fatal: unable to access 'https://bob:hunter2@example.com/r.git/': Could not resolve host: example.com",
        },
    )
    const failure = await failureOf(push(ctx, { remote: 'origin', branch: 'main' }))
    expect(failure.code).toBe('git/exec-failed')
    expect(failure.message).not.toContain('hunter2')
    expect(JSON.stringify(failure.details)).not.toContain('hunter2')
  })

  it('never passes --force or --no-verify', async () => {
    const { ctx, calls } = scriptedContext(
      (args) => remoteAndRefOk(args) ?? { stdout: '*\tHEAD:refs/heads/main\t[new branch]\nDone\n' },
    )
    await push(ctx, { remote: 'origin', branch: 'main', forceWithLease: true, setUpstream: true, tags: true })
    const pushArgs = calls.find((args) => args[0] === 'push') ?? []
    expect(pushArgs).toEqual([
      'push',
      '--porcelain',
      '--set-upstream',
      '--force-with-lease',
      '--follow-tags',
      '--',
      'origin',
      'HEAD:refs/heads/main',
    ])
  })
})

describe('readPushPreview', () => {
  it('lists commits ahead of the upstream', async () => {
    const remote = setup()
    remote.local.write('a.txt', 'a\n')
    const sha = remote.local.commit('ahead one')

    const value = await preview(remote.local)
    expect(value).toMatchObject({
      remotes: ['origin'],
      branch: 'main',
      detached: false,
      upstream: 'origin/main',
      defaultRemote: 'origin',
      truncated: false,
    })
    expect(value.commits.map((commit) => commit.sha)).toEqual([sha])
    expect(value.commits[0]).toMatchObject({ subject: 'ahead one', author: 'Test', email: 'test@example.com' })
  })

  it('without upstream lists commits not on the default remote', async () => {
    const remote = setup()
    remote.local.git('checkout', '-q', '-b', 'topic')
    remote.local.write('t.txt', 't\n')
    const sha = remote.local.commit('topic work')
    const value = await preview(remote.local)
    expect(value.upstream).toBeNull()
    expect(value.defaultRemote).toBe('origin')
    expect(value.commits.map((commit) => commit.sha)).toEqual([sha])
  })

  it('reports detached HEAD', async () => {
    const remote = setup()
    remote.local.git('checkout', '-q', '--detach')
    const value = await preview(remote.local)
    expect(value.branch).toBeNull()
    expect(value.detached).toBe(true)
    expect(value.upstream).toBeNull()
    expect(value.commits).toEqual([])
  })

  it('without remotes returns all commits and defaultRemote null; truncates at the limit', async () => {
    const repo = makeRepo()
    // One fast-import stream instead of 100 commit processes (keeps the test fast under load).
    const stream = Array.from({ length: PUSH_PREVIEW_COMMIT_LIMIT }, (_, index) => {
      const message = `c${String(index)}`
      return [
        'commit refs/heads/main',
        `committer Test <test@example.com> ${String(1_700_000_000 + index)} +0000`,
        `data ${String(message.length)}`,
        message,
        index === 0 ? 'from refs/heads/main^0' : '',
        '',
      ].join('\n')
    }).join('')
    const imported = spawnSync('git', ['fast-import', '--quiet'], {
      cwd: repo.root,
      env: TEST_GIT_ENV,
      input: stream,
      encoding: 'utf8',
    })
    expect(imported.status, imported.stderr).toBe(0)
    const value = await preview(repo)
    expect(value.remotes).toEqual([])
    expect(value.defaultRemote).toBeNull()
    expect(value.commits).toHaveLength(PUSH_PREVIEW_COMMIT_LIMIT)
    expect(value.truncated).toBe(true)
    expect(value.commits[0]?.subject).toBe(`c${String(PUSH_PREVIEW_COMMIT_LIMIT - 1)}`)
  })

  it('handles an unborn branch', async () => {
    const repo = makeRepo({ initialCommit: false })
    const value = await preview(repo)
    expect(value).toMatchObject({ branch: 'main', detached: false, commits: [], truncated: false })
  })
})
