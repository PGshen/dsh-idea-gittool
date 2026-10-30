// B3a T4: the interactive rebase list model (pure).
import { describe, expect, it } from 'vitest'

import type { RebasePlanCommit, RebasePlanValue } from '../../../src/shared/protocol.ts'
import {
  MESSAGE_PLACEHOLDER,
  fromPlan,
  groupMessage,
  groups,
  isUnchanged,
  move,
  previewTodo,
  rewritesPushed,
  setAction,
  setMessage,
  stayingBranches,
  toEntries,
  validate,
} from '../../../src/client/rebase/rebase-model.ts'

function commit(letter: string, extra: Partial<RebasePlanCommit> = {}): RebasePlanCommit {
  const sha = letter.repeat(40)
  return {
    sha,
    shortSha: letter.repeat(7),
    parents: [],
    author: 'A',
    email: 'a@x',
    date: '2020-01-01T00:00:00Z',
    subject: `subject ${letter}`,
    message: `subject ${letter}\n\nbody ${letter}`,
    pushed: false,
    branches: [],
    ...extra,
  }
}

function plan(commits: RebasePlanCommit[]): RebasePlanValue {
  return { base: '0'.repeat(40), head: commits.at(-1)?.sha ?? '', branch: 'main', commits, supportsUpdateRefs: true }
}

const PLAN = plan([commit('a'), commit('b', { pushed: true }), commit('c'), commit('d')])
const sha = (letter: string): string => letter.repeat(40)

describe('fromPlan', () => {
  it('starts with every commit picked, oldest first, carrying its message', () => {
    const rows = fromPlan(PLAN)
    expect(rows.map(row => [row.sha, row.action])).toEqual([[sha('a'), 'pick'], [sha('b'), 'pick'], [sha('c'), 'pick'], [sha('d'), 'pick']])
    expect(rows[0]).toMatchObject({ message: 'subject a\n\nbody a', originalMessage: 'subject a\n\nbody a', messageEdited: false, pushed: false })
    expect(isUnchanged(rows)).toBe(true)
  })

  it('applies a reword preset', () => {
    const rows = fromPlan(PLAN, { kind: 'reword', sha: sha('c') })
    expect(rows.map(row => row.action)).toEqual(['pick', 'pick', 'reword', 'pick'])
  })

  it('applies a drop preset', () => {
    expect(fromPlan(PLAN, { kind: 'drop', sha: sha('b') }).map(row => row.action)).toEqual(['pick', 'drop', 'pick', 'pick'])
  })

  it('applies a squash preset: oldest kept as pick, the others squash into it', () => {
    const rows = fromPlan(PLAN, { kind: 'squash', shas: [sha('d'), sha('b'), sha('c')] })
    expect(rows.map(row => row.action)).toEqual(['pick', 'pick', 'squash', 'squash'])
  })
})

describe('edits', () => {
  it('switches actions, moves rows and edits messages without mutating the input', () => {
    const rows = fromPlan(PLAN)
    const changed = setAction(rows, 1, 'drop')
    expect(rows[1]?.action).toBe('pick')
    expect(changed[1]?.action).toBe('drop')
    expect(move(rows, 3, 0).map(row => row.sha)).toEqual([sha('d'), sha('a'), sha('b'), sha('c')])
    expect(move(rows, 0, 3).map(row => row.sha)).toEqual([sha('b'), sha('c'), sha('d'), sha('a')])
    const edited = setMessage(rows, 2, 'new')
    expect(edited[2]).toMatchObject({ message: 'new', messageEdited: true })
    expect(isUnchanged(move(rows, 1, 1))).toBe(true)
    expect(isUnchanged(edited)).toBe(true)
    expect(isUnchanged(setAction(edited, 2, 'reword'))).toBe(false)
  })
})

describe('groups and messages', () => {
  it('folds squash/fixup into the previous kept row, drops do not break a group', () => {
    const rows = fromPlan(PLAN)
    const shaped = setAction(setAction(setAction(rows, 1, 'drop'), 2, 'squash'), 3, 'fixup')
    expect(groups(shaped)).toEqual([{ head: 0, members: [2, 3] }])
  })

  it('defaults a squash group message to the head and squash messages, without fixups', () => {
    const shaped = setAction(setAction(fromPlan(PLAN), 1, 'squash'), 2, 'fixup')
    const [group] = groups(shaped)
    expect(group).toBeDefined()
    expect(groupMessage(shaped, group ?? { head: 0, members: [] })).toBe('subject a\n\nbody a\n\nsubject b\n\nbody b')
    const edited = setMessage(shaped, 0, 'combined')
    expect(groupMessage(edited, group ?? { head: 0, members: [] })).toBe('combined')
  })

  it('gives a fixup-only group of a pick no message (git keeps the head message)', () => {
    const shaped = setAction(fromPlan(PLAN), 1, 'fixup')
    expect(groupMessage(shaped, { head: 0, members: [1] })).toBeUndefined()
  })
})

describe('toEntries and validate', () => {
  it('sends a message only where it changes something', () => {
    const rows = setMessage(setAction(setAction(fromPlan(PLAN), 1, 'reword'), 3, 'squash'), 1, 'b renamed')
    expect(toEntries(rows)).toEqual([
      { sha: sha('a'), action: 'pick' },
      { sha: sha('b'), action: 'reword', message: 'b renamed' },
      { sha: sha('c'), action: 'pick', message: 'subject c\n\nbody c\n\nsubject d\n\nbody d' },
      { sha: sha('d'), action: 'squash' },
    ])
  })

  it('reports invalid lists as localized text', () => {
    expect(validate(PLAN, setAction(fromPlan(PLAN), 0, 'fixup'), { confirmPushed: true })?.key).toBe('rebase.invalid.leading-squash')
    expect(validate(PLAN, setMessage(setAction(fromPlan(PLAN), 3, 'reword'), 3, '  '), { confirmPushed: true })?.key).toBe('rebase.invalid.missing-message')
    expect(validate(PLAN, fromPlan(PLAN), { confirmPushed: true })?.key).toBe('rebase.invalid.unchanged')
    expect(validate(PLAN, setAction(fromPlan(PLAN), 3, 'drop'), { confirmPushed: false })).toBeNull()
  })

  it('asks to confirm only when a pushed commit is rewritten', () => {
    // b (pushed) is the second commit: changing d leaves a..c as they are.
    expect(rewritesPushed(setAction(fromPlan(PLAN), 3, 'drop'))).toBe(false)
    expect(rewritesPushed(setAction(fromPlan(PLAN), 1, 'reword'))).toBe(true)
    expect(rewritesPushed(setAction(fromPlan(PLAN), 0, 'drop'))).toBe(true)
    expect(rewritesPushed(move(fromPlan(PLAN), 3, 2))).toBe(false)
    expect(validate(PLAN, setAction(fromPlan(PLAN), 0, 'drop'), { confirmPushed: false })?.key).toBe('rebase.invalid.confirmPushed')
  })
})

describe('previewTodo', () => {
  it('is the Host todo with a placeholder for message blobs and update-ref lines when asked', () => {
    const withBranch = plan([commit('a', { branches: ['mid'] }), commit('b')])
    const rows = setAction(fromPlan(withBranch), 0, 'reword')
    expect(previewTodo(withBranch, rows, { updateRefs: true })).toBe([
      `pick ${sha('a')}`,
      `exec git cat-file blob ${MESSAGE_PLACEHOLDER} | git commit --amend --no-verify --allow-empty -F -`,
      'update-ref refs/heads/mid',
      `pick ${sha('b')}`,
      '',
    ].join('\n'))
    expect(previewTodo(withBranch, rows, { updateRefs: false })).not.toContain('update-ref')
  })
})

describe('stayingBranches (t2 T1)', () => {
  const rootPlan = (): RebasePlanValue => ({ ...plan([commit('a', { branches: ['side'] }), commit('b', { branches: ['mid'] }), commit('c')]), base: null })

  it('lists branches on leading drops of a --root rebase with --update-refs, and the preview leaves them out', () => {
    const value = rootPlan()
    const rows = setAction(setAction(fromPlan(value), 0, 'drop'), 1, 'drop')
    expect(stayingBranches(value, rows, { updateRefs: true })).toEqual(['side', 'mid'])
    expect(previewTodo(value, rows, { updateRefs: true })).not.toContain('update-ref')
  })

  it('is empty without --root, without --update-refs or when a kept commit comes first', () => {
    const value = rootPlan()
    const dropped = setAction(fromPlan(value), 0, 'drop')
    expect(stayingBranches(value, dropped, { updateRefs: false })).toEqual([])
    expect(stayingBranches({ ...value, base: '0'.repeat(40) }, dropped, { updateRefs: true })).toEqual([])
    expect(previewTodo({ ...value, base: '0'.repeat(40) }, dropped, { updateRefs: true })).toContain('update-ref refs/heads/side')
    expect(stayingBranches(value, setAction(fromPlan(value), 1, 'drop'), { updateRefs: true })).toEqual([])
  })
})
