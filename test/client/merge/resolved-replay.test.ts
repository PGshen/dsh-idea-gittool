// B1 T7 resolved files in the merge window (ruling 16): the Result is the worktree text from
// `mergeFile.worktreeText`; a draft / the automatic merge / a whole-file take that equals it keeps
// its chunk states, anything else is the worktree text with every chunk edited.
import { describe, expect, it } from 'vitest'
import { autoMerge, counts, createModel, editedModel, isManuallyEdited, resolveWhole, toDraft } from '../../../src/client/merge/merge-model.ts'
import { resolvedModel } from '../../../src/client/merge/resolved-replay.ts'

// One left-only chunk, one simple conflict (different words of one line), one right-only chunk.
const TEXTS = {
  base: 'a\nb\nalpha beta\nd\n',
  ours: 'a\nB\nALPHA beta\nd\n',
  theirs: 'a\nb\nalpha BETA\nd\nend\n',
}
const STAGES = { base: '1'.repeat(40), ours: '2'.repeat(40), theirs: '3'.repeat(40) }

describe('resolvedModel', () => {
  it('worktree equals the automatic merge: the chunk states of the replay come back', () => {
    const auto = autoMerge(TEXTS)
    const model = resolvedModel(TEXTS, auto.result, null)
    expect(model?.result).toBe(auto.result)
    expect(model?.chunks.map(c => c.state)).toEqual(auto.chunks.map(c => c.state))
    expect(counts(model!)).toEqual({ resolved: 1, total: 1 })
  })

  it('worktree equals one side (采用 …): that side is accepted for the whole file', () => {
    const left = resolvedModel(TEXTS, TEXTS.ours, null)
    expect(left?.result).toBe(TEXTS.ours)
    expect(left?.chunks.every(c => c.leftDone && c.rightDone && c.state !== 'edited')).toBe(true)
    expect(resolvedModel(TEXTS, TEXTS.theirs, null)?.result).toBe(TEXTS.theirs)
  })

  it('a draft is used only when its Result is the worktree', () => {
    const drafted = resolveWhole(createModel(TEXTS), 1, 'left')
    const draft = toDraft(drafted, STAGES)
    expect(resolvedModel(TEXTS, drafted.result, draft)?.chunks.map(c => c.state)).toEqual(drafted.chunks.map(c => c.state))
    expect(resolvedModel(TEXTS, TEXTS.ours, draft)?.result).toBe(TEXTS.ours)
  })

  it('anything else is the worktree text with every chunk edited', () => {
    const model = resolvedModel(TEXTS, 'hand\nmade\n', null)
    expect(model?.result).toBe('hand\nmade\n')
    expect(model?.chunks.every(c => isManuallyEdited(c))).toBe(true)
  })

  it('a CRLF worktree of LF sides (autocrlf) compares in clean form', () => {
    const model = resolvedModel(TEXTS, TEXTS.ours.replace(/\n/g, '\r\n'), null)
    expect(model?.result).toBe(TEXTS.ours)
    expect(model?.chunks.every(c => c.state !== 'edited')).toBe(true)
  })

  it('no readable worktree text (null / missing): not reviewable', () => {
    expect(resolvedModel(TEXTS, null, null)).toBeNull()
    expect(resolvedModel(TEXTS, undefined, null)).toBeNull()
  })
})

describe('editedModel', () => {
  it('takes the given Result and marks every chunk edited (manually)', () => {
    const model = editedModel(createModel(TEXTS), 'hand\nmade\n')
    expect(model.result).toBe('hand\nmade\n')
    expect(model.chunks.length).toBeGreaterThan(1)
    expect(model.chunks.every(c => c.state === 'edited' && isManuallyEdited(c))).toBe(true)
    expect(model.chunks[0]?.resultRange).toEqual({ start: 0, end: 2 })
    expect(model.chunks.slice(1).every(c => c.resultRange.start === 2 && c.resultRange.end === 2)).toBe(true)
  })
})
