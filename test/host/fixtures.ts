// 测试用真实临时仓库：node:fs 建目录 + 系统 git 操作。
// 只属于测试代码（src/host 的零依赖约束不覆盖 test/）。

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** One git invocation result, non-throwing so conflict setups are expressible. */
export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

/** A real temporary git repository, removed by {@link TempRepo.cleanup}. */
export interface TempRepo {
  /** Absolute (realpath-normalized) repository root. */
  readonly root: string
  gitResult(...args: string[]): GitResult
  /** Run git and throw on a non-zero exit. */
  git(...args: string[]): string
  write(relativePath: string, content: string): void
  /** Run `git add -A && git commit`, returning the new HEAD sha. */
  commit(message: string): string
  cleanup(): void
}

/** Deterministic git environment: no user/system config, no prompts. */
export const TEST_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
}

/** Create an empty temp directory removed by {@link removeTempDir}. */
export function createTempDir(prefix = 'dsh-git-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

/** Write an executable shell script and return its absolute path. */
export function writeExecutableScript(directory: string, name: string, body: string): string {
  const path = join(directory, name)
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
  return path
}

/** Create an initialized repository whose first commit is on `main`. */
export function createTempRepo(options: { initialCommit?: boolean } = {}): TempRepo {
  const root = realpathSync(createTempDir('dsh-git-repo-'))
  const run = (args: string[], throwOnError: boolean): GitResult => {
    const result = spawnSync('git', args, {
      cwd: root,
      env: TEST_GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error !== undefined) throw result.error
    const outcome: GitResult = {
      status: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
    }
    if (throwOnError && outcome.status !== 0) {
      throw new Error(`git ${args.join(' ')} exited ${outcome.status}: ${outcome.stderr}`)
    }
    return outcome
  }
  const repo: TempRepo = {
    root,
    gitResult: (...args) => run(args, false),
    git: (...args) => run(args, true).stdout,
    write: (relativePath, content) => {
      const target = join(root, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
    },
    commit: (message) => {
      run(['add', '-A'], true)
      run(
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', message],
        true,
      )
      return run(['rev-parse', 'HEAD'], true).stdout.trim()
    },
    cleanup: () => removeTempDir(root),
  }
  run(['init', '-b', 'main'], true)
  run(['config', 'user.name', 'Test'], true)
  run(['config', 'user.email', 'test@example.com'], true)
  if (options.initialCommit !== false) {
    repo.write('README.md', '# fixture\n')
    repo.commit('initial commit')
  }
  return repo
}

/** Resolve symlinks so temp-dir comparisons match git's `--show-toplevel` output. */
export function canonicalPath(path: string): string {
  return realpathSync(path)
}

/** Await a short real-time delay (used to let a spawned process start). */
export async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
