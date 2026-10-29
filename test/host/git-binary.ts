// The git binary tests spawn. Under pnpm/vitest a PATH launcher such as macOS `/usr/bin/git`
// (xcrun) costs ~40ms per spawn instead of ~3ms (B4c T4, references §17); `--exec-path` holds the
// real binary. Falls back to the bare name when it cannot be found.
// B4d T5: `DSH_GIT_TEST_BINARY=/abs/path/to/git` runs the tests against that git instead
// (scripts/compat/run-host-tests.sh); a value that cannot run fails loudly.
import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { GitFeature, ParsedGitVersion } from '../../src/host/git-version.ts'
import { gitSupports, parseGitVersion } from '../../src/host/git-version.ts'

export function resolveGitBinary(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env.DSH_GIT_TEST_BINARY
  if (chosen !== undefined && chosen !== '') {
    if (!isAbsolute(chosen)) throw new Error(`DSH_GIT_TEST_BINARY must be an absolute path, got ${chosen}`)
    try {
      accessSync(chosen, constants.X_OK)
    } catch {
      throw new Error(`DSH_GIT_TEST_BINARY ${chosen} is not an executable file`)
    }
    return chosen
  }
  const probe = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
  const dir = probe.status === 0 ? probe.stdout.trim() : ''
  if (dir === '') return 'git'
  const candidate = join(dir, process.platform === 'win32' ? 'git.exe' : 'git')
  try {
    accessSync(candidate, constants.X_OK)
    return candidate
  } catch {
    return 'git'
  }
}

export const GIT_BINARY: string = resolveGitBinary()

/** Version of {@link GIT_BINARY}: tests that pin a newer git's output branch on it (B4d T5). */
export const GIT_TEST_VERSION: ParsedGitVersion = parseGitVersion(spawnSync(GIT_BINARY, ['--version'], { encoding: 'utf8' }).stdout ?? '')
  ?? { major: 0, minor: 0, patch: 0 }

export function gitTestSupports(feature: GitFeature): boolean {
  return gitSupports(GIT_TEST_VERSION, feature)
}

export function gitTestAtLeast(major: number, minor: number): boolean {
  return GIT_TEST_VERSION.major > major || (GIT_TEST_VERSION.major === major && GIT_TEST_VERSION.minor >= minor)
}
