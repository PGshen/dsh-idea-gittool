// The git binary tests spawn. Under pnpm/vitest a PATH launcher such as macOS `/usr/bin/git`
// (xcrun) costs ~40ms per spawn instead of ~3ms (B4c T4, references §17); `--exec-path` holds the
// real binary. Falls back to the bare name when it cannot be found.
import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

function resolveGitBinary(): string {
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
