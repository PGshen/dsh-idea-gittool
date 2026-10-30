// B3a T3: the todo rules shared by the Host (execution) and the rebase page (preview).
import { describe, expect, it } from 'vitest'

import type { RebaseEntry } from '../../src/shared/protocol.ts'
import { buildTodo, rebaseTodoProblem, rootDropBranches } from '../../src/shared/rebase-todo.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)
const PLAN = [A, B, C, D]

const EXEC = (blob: string): string => `exec git cat-file blob ${blob} | git commit --amend --no-verify --allow-empty -F -`

function blobs(entries: readonly RebaseEntry[]): (index: number) => string {
  return (index) => `blob-${String(index)}-${entries[index]?.sha.slice(0, 1) ?? ''}`
}

describe('rebaseTodoProblem', () => {
  it('accepts a permutation with valid actions', () => {
    expect(rebaseTodoProblem(PLAN, [
      { sha: D, action: 'pick' },
      { sha: A, action: 'reword', message: 'm' },
      { sha: B, action: 'squash' },
      { sha: C, action: 'drop' },
    ])).toBeNull()
  })

  it('rejects anything but a permutation of the plan', () => {
    expect(rebaseTodoProblem(PLAN, [{ sha: A, action: 'pick' }])).toBe('not-permutation')
    expect(rebaseTodoProblem(PLAN, [...PLAN, 'e'.repeat(40)].map(sha => ({ sha, action: 'pick' as const })))).toBe('not-permutation')
    expect(rebaseTodoProblem(PLAN, [A, B, C, C].map(sha => ({ sha, action: 'pick' as const })))).toBe('not-permutation')
  })

  it('rejects a squash or fixup with nothing to fold into (drops do not count)', () => {
    expect(rebaseTodoProblem(PLAN, [
      { sha: A, action: 'fixup' }, { sha: B, action: 'pick' }, { sha: C, action: 'pick' }, { sha: D, action: 'pick' },
    ])).toBe('leading-squash')
    expect(rebaseTodoProblem(PLAN, [
      { sha: A, action: 'drop' }, { sha: B, action: 'squash' }, { sha: C, action: 'pick' }, { sha: D, action: 'pick' },
    ])).toBe('leading-squash')
  })

  it('requires a message on reword and allows one only on pick/reword', () => {
    expect(rebaseTodoProblem(PLAN, [
      { sha: A, action: 'reword' }, { sha: B, action: 'pick' }, { sha: C, action: 'pick' }, { sha: D, action: 'pick' },
    ])).toBe('missing-message')
    expect(rebaseTodoProblem(PLAN, [
      { sha: A, action: 'reword', message: '  ' }, { sha: B, action: 'pick' }, { sha: C, action: 'pick' }, { sha: D, action: 'pick' },
    ])).toBe('missing-message')
    for (const action of ['edit', 'squash', 'fixup', 'drop'] as const) {
      expect(rebaseTodoProblem(PLAN, [
        { sha: A, action: 'pick' }, { sha: B, action, message: 'x' }, { sha: C, action: 'pick' }, { sha: D, action: 'pick' },
      ]), action).toBe('misplaced-message')
    }
  })
})

describe('buildTodo', () => {
  it('writes picks as-is and a reword as pick + exec of its message blob', () => {
    const entries: RebaseEntry[] = [
      { sha: A, action: 'pick' },
      { sha: B, action: 'reword', message: 'new' },
      { sha: C, action: 'edit' },
      { sha: D, action: 'drop' },
    ]
    expect(buildTodo(entries, { messageBlob: blobs(entries) })).toBe(
      [`pick ${A}`, `pick ${B}`, EXEC('blob-1-b'), `edit ${C}`, `drop ${D}`, ''].join('\n'),
    )
  })

  it('folds a squash group with a final message as fixups followed by one exec', () => {
    const entries: RebaseEntry[] = [
      { sha: A, action: 'pick', message: 'combined' },
      { sha: B, action: 'squash' },
      { sha: C, action: 'fixup' },
      { sha: D, action: 'pick' },
    ]
    expect(buildTodo(entries, { messageBlob: blobs(entries) })).toBe(
      [`pick ${A}`, `fixup ${B}`, `fixup ${C}`, EXEC('blob-0-a'), `pick ${D}`, ''].join('\n'),
    )
  })

  it('keeps git squash semantics when the group carries no message', () => {
    const entries: RebaseEntry[] = [
      { sha: A, action: 'pick' }, { sha: B, action: 'squash' }, { sha: C, action: 'fixup' }, { sha: D, action: 'pick' },
    ]
    expect(buildTodo(entries, { messageBlob: blobs(entries) })).toBe(
      [`pick ${A}`, `squash ${B}`, `fixup ${C}`, `pick ${D}`, ''].join('\n'),
    )
  })

  it('places a drop inside a group without breaking it', () => {
    const entries: RebaseEntry[] = [
      { sha: A, action: 'reword', message: 'm' }, { sha: B, action: 'drop' }, { sha: C, action: 'fixup' }, { sha: D, action: 'pick' },
    ]
    expect(buildTodo(entries, { messageBlob: blobs(entries) })).toBe(
      [`pick ${A}`, `drop ${B}`, `fixup ${C}`, EXEC('blob-0-a'), `pick ${D}`, ''].join('\n'),
    )
  })

  it('writes update-ref lines after the group that contains the branch commit (drops included)', () => {
    const entries: RebaseEntry[] = [
      { sha: B, action: 'pick', message: 'm' },
      { sha: A, action: 'squash' },
      { sha: C, action: 'drop' },
      { sha: D, action: 'pick' },
    ]
    const branches = (sha: string): string[] => (sha === A ? ['feature/a'] : sha === C ? ['c1', 'c2'] : [])
    expect(buildTodo(entries, { messageBlob: blobs(entries), branches })).toBe([
      `pick ${B}`, `fixup ${A}`, `drop ${C}`, EXEC('blob-0-b'),
      'update-ref refs/heads/feature/a', 'update-ref refs/heads/c1', 'update-ref refs/heads/c2',
      `pick ${D}`, '',
    ].join('\n'))
  })

  it('writes the update-ref of a leading drop right after it', () => {
    const entries: RebaseEntry[] = [{ sha: A, action: 'drop' }, { sha: B, action: 'pick' }]
    expect(buildTodo(entries, { messageBlob: blobs(entries), branches: sha => (sha === A ? ['x'] : []) })).toBe(
      [`drop ${A}`, 'update-ref refs/heads/x', `pick ${B}`, ''].join('\n'),
    )
  })

  it('leaves the branch of a leading drop alone under --root (t2 T1)', () => {
    // `rebase -i --root` would move it onto git's internal empty root commit.
    const entries: RebaseEntry[] = [{ sha: A, action: 'drop' }, { sha: B, action: 'pick' }, { sha: C, action: 'drop' }]
    const branches = (sha: string): string[] => (sha === A ? ['x'] : sha === C ? ['y'] : [])
    expect(buildTodo(entries, { messageBlob: blobs(entries), branches, root: true })).toBe(
      [`drop ${A}`, `pick ${B}`, `drop ${C}`, 'update-ref refs/heads/y', ''].join('\n'),
    )
    expect(buildTodo(entries, { messageBlob: blobs(entries), branches, root: false })).toContain('update-ref refs/heads/x')
  })
})

describe('rootDropBranches', () => {
  it('lists the branches on drops before the first kept commit', () => {
    const entries: RebaseEntry[] = [
      { sha: A, action: 'drop' }, { sha: B, action: 'drop' }, { sha: C, action: 'pick' }, { sha: D, action: 'drop' },
    ]
    const branches = (sha: string): string[] => (sha === A ? ['x'] : sha === B ? ['y', 'z'] : sha === D ? ['w'] : [])
    expect(rootDropBranches(entries, branches)).toEqual(['x', 'y', 'z'])
    expect(rootDropBranches([{ sha: A, action: 'pick' }], branches)).toEqual([])
  })
})
