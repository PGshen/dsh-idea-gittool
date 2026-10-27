// B3a T1: payload validation of the interactiveRebase write endpoint (shape only; plan checks are T3).
import { describe, expect, it } from 'vitest'

import { GitCommandFailure } from '../../src/host/git-executor.ts'
import { interactiveRebaseOperation } from '../../src/host/git/interactive-rebase.ts'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 's',
    requestId: 'r-1',
    base: SHA_A,
    head: SHA_C,
    entries: [
      { sha: SHA_B, action: 'pick' },
      { sha: SHA_C, action: 'reword', message: 'new message' },
    ],
    ...overrides,
  }
}

function rejection(input: Record<string, unknown>): GitCommandFailure {
  try {
    interactiveRebaseOperation.parse(input)
  } catch (error) {
    if (error instanceof GitCommandFailure) return error
    throw error
  }
  throw new Error('expected parse to reject')
}

describe('interactiveRebaseOperation.parse', () => {
  it('accepts a well-formed request and defaults the flags', () => {
    expect(interactiveRebaseOperation.parse(payload())).toEqual({
      base: SHA_A,
      head: SHA_C,
      entries: [
        { sha: SHA_B, action: 'pick' },
        { sha: SHA_C, action: 'reword', message: 'new message' },
      ],
      updateRefs: false,
      stash: false,
    })
  })

  it('accepts base null (from the root) and keeps updateRefs / stash', () => {
    const input = interactiveRebaseOperation.parse(payload({ base: null, updateRefs: true, stash: true }))
    expect(input).toMatchObject({ base: null, updateRefs: true, stash: true })
  })

  it.each([
    ['base starting with a dash', { base: '--exec=x' }],
    ['base not a string', { base: 42 }],
    ['base missing', { base: undefined }],
    ['head not a full sha', { head: 'abc123' }],
    ['entries empty', { entries: [] }],
    ['entries not an array', { entries: 'pick' }],
    ['abbreviated entry sha', { entries: [{ sha: 'abcdef1', action: 'pick' }] }],
    ['unknown action', { entries: [{ sha: SHA_B, action: 'exec' }] }],
    ['reword without message', { entries: [{ sha: SHA_B, action: 'reword' }] }],
    ['reword with blank message', { entries: [{ sha: SHA_B, action: 'reword', message: ' \n ' }] }],
    ['message not a string', { entries: [{ sha: SHA_B, action: 'pick', message: 1 }] }],
    ['duplicate sha', { entries: [{ sha: SHA_B, action: 'pick' }, { sha: SHA_B, action: 'drop' }] }],
  ])('rejects %s with git/invalid-payload', (_name, overrides) => {
    expect(rejection(payload(overrides)).code).toBe('git/invalid-payload')
  })
})
