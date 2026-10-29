// B4d T1: `git --version` parsing and the per-feature version gates (design §16.7, §16.9).
import { describe, expect, it } from 'vitest'

import {
  GIT_MIN_VERSION,
  formatGitVersion,
  gitSupports,
  isSupportedGitVersion,
  parseGitVersion,
} from '../../src/host/git-version.ts'

describe('parseGitVersion', () => {
  it.each([
    ['git version 2.25.0', [2, 25, 0]],
    ['git version 2.39.3 (Apple Git-146)\n', [2, 39, 3]],
    ['git version 2.45.1.windows.1', [2, 45, 1]],
    ['git version 2.40.0.rc1', [2, 40, 0]],
    ['git version 2.40.0-rc1', [2, 40, 0]],
    ['git version 2.25', [2, 25, 0]],
    ['git version 3.0.0', [3, 0, 0]],
    ['2.50.1', [2, 50, 1]],
  ])('parses %j', (raw, [major, minor, patch]) => {
    expect(parseGitVersion(raw)).toEqual({ major, minor, patch })
  })

  it.each(['', 'hello', 'git version', 'git version x.y', 'not git 2.30.0'])('rejects %j', (raw) => {
    expect(parseGitVersion(raw)).toBeNull()
  })
})

describe('version gates', () => {
  it('requires at least 2.25.0', () => {
    expect(GIT_MIN_VERSION).toBe('2.25.0')
    expect(isSupportedGitVersion(parseGitVersion('2.24.9')!)).toBe(false)
    expect(isSupportedGitVersion(parseGitVersion('2.25.0')!)).toBe(true)
    expect(isSupportedGitVersion(parseGitVersion('3.0.0')!)).toBe(true)
  })

  it('enables --update-refs from 2.38', () => {
    expect(gitSupports(parseGitVersion('2.37.9')!, 'updateRefs')).toBe(false)
    expect(gitSupports(parseGitVersion('2.38.0')!, 'updateRefs')).toBe(true)
    expect(gitSupports(parseGitVersion('3.1.0')!, 'updateRefs')).toBe(true)
  })

  it('formats a parsed version as major.minor.patch', () => {
    expect(formatGitVersion(parseGitVersion('git version 2.45.1.windows.1')!)).toBe('2.45.1')
  })
})
