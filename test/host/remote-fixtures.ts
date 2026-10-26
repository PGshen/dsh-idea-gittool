// 推送/拉取测试用的本地 bare 远程（测试以 unconfined 运行，远程位置不受沙箱限制）。

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

import type { GitRunResult, WriteContext } from '../../src/host/git-executor.ts'
import { bindWriteContext, createGitRunner } from '../../src/host/git-executor.ts'
import { TEST_GIT_ENV, createTempDir, createTempRepo, removeTempDir } from './fixtures.ts'
import type { TempRepo } from './fixtures.ts'
import { createFakeSubprocess } from './fake-subprocess.ts'

export interface RemoteSetup {
  /** Absolute path of the bare repository (remote `origin`). */
  bare: string
  /** The repository under test: `main` pushed to origin with upstream set. */
  local: TempRepo
  /** Another clone that plays "someone else pushing". */
  other: TempRepo
  cleanup: () => void
}

/** A bare `origin`, a local clone with upstream and a second clone. */
export function createRemoteSetup(): RemoteSetup {
  const bare = realpathSync(createTempDir('dsh-git-bare-'))
  const init = spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: TEST_GIT_ENV, encoding: 'utf8' })
  if (init.status !== 0) throw new Error(`git init --bare failed: ${init.stderr}`)

  const local = createTempRepo()
  local.git('remote', 'add', 'origin', bare)
  local.git('push', '-q', '-u', 'origin', 'main')

  const other = createTempRepo({ initialCommit: false })
  other.git('remote', 'add', 'origin', bare)
  other.git('fetch', '-q', 'origin')
  other.git('checkout', '-q', '-B', 'main', 'origin/main')

  return {
    bare,
    local,
    other,
    cleanup: () => {
      local.cleanup()
      other.cleanup()
      removeTempDir(bare)
    },
  }
}

/** Commit a file in `repo` and push it to origin/main (the "someone else" move). */
export function pushFromOther(other: TempRepo, path: string, content: string, message: string): string {
  other.write(path, content)
  const sha = other.commit(message)
  other.git('push', '-q', 'origin', 'HEAD:refs/heads/main')
  return sha
}

/** A real write context over a repository (unconfined, test-only). */
export function contextFor(repo: TempRepo): WriteContext {
  return bindWriteContext(
    createGitRunner(createFakeSubprocess()),
    repo.root,
    { kind: 'unconfined' },
    new AbortController().signal,
  )
}

/** A scripted write context: `respond` sees argv without the global prefix. */
export function scriptedContext(
  respond: (args: readonly string[]) => Partial<GitRunResult>,
  repoRoot = '/work/repo',
): { ctx: WriteContext; calls: string[][] } {
  const calls: string[][] = []
  const ctx: WriteContext = {
    repoRoot,
    signal: new AbortController().signal,
    git: async (argv) => {
      const args = argv.slice(argv.indexOf('core.fsmonitor=false') + 1)
      calls.push(args)
      const result = respond(args)
      return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },
  }
  return { ctx, calls }
}
