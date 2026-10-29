// B4d T5: the Host tests can run against a chosen git (scripts/compat/run-host-tests.sh).
import { describe, expect, it } from 'vitest'

import { resolveGitBinary } from './git-binary.ts'

describe('resolveGitBinary', () => {
  it('uses DSH_GIT_TEST_BINARY when it names an executable', () => {
    expect(resolveGitBinary({ DSH_GIT_TEST_BINARY: '/bin/sh' })).toBe('/bin/sh')
  })

  it('refuses a DSH_GIT_TEST_BINARY that cannot run, instead of silently testing another git', () => {
    expect(() => resolveGitBinary({ DSH_GIT_TEST_BINARY: '/nonexistent/git' })).toThrow(/DSH_GIT_TEST_BINARY/u)
    expect(() => resolveGitBinary({ DSH_GIT_TEST_BINARY: 'git' })).toThrow(/absolute/u)
  })

  it('finds the real binary without the variable', () => {
    expect(resolveGitBinary({})).toMatch(/git(\.exe)?$/u)
  })
})
