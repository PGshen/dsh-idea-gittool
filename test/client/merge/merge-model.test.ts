// B1 T4 merge model: chunk state machine, actions, edit mapping, counts, navigation, draft round trip.
import { describe, expect, it } from 'vitest'

import {
  acceptFile,
  acceptLeft,
  acceptRight,
  allResolved,
  appendBoth,
  applyEdit,
  applyNonConflicting,
  autoMerge,
  counts,
  createModel,
  ignore,
  isChunkResolved,
  nextUnresolved,
  resolveSimple,
  resolveWhole,
  revert,
  simpleResult,
  toDraft,
  type MergeModel,
} from '../../../src/client/merge/merge-model.ts'
import type { MergeDraft, MergeStageShas } from '../../../src/shared/protocol.ts'

// Fixture 1: chunk 0 left-only (b→B), chunk 1 conflict (d,e), chunk 2 right-only (append h).
const SIDES = {
  base: 'a\nb\nc\nd\ne\nf\ng\n',
  ours: 'a\nB\nc\nd\nE1\nf\ng\n',
  theirs: 'a\nb\nc\nD\nE2\nf\ng\nh\n',
}

// Fixture 2: chunk 0 simple conflict (different lines), chunk 1 non-simple conflict (same word).
const SIMPLE = {
  base: 'p\nq\nm\nk = 1\n',
  ours: 'P\nq\nm\nk = 10\n',
  theirs: 'p\nQ\nm\nk = 20\n',
}

const STAGES: MergeStageShas = { base: 'b'.repeat(40), ours: 'o'.repeat(40), theirs: 't'.repeat(40) }
const SAVED_AT = '2026-10-26T00:00:00.000Z'

function ranges(model: MergeModel): Array<[number, number]> {
  return model.chunks.map((c) => [c.resultRange.start, c.resultRange.end])
}

function states(model: MergeModel): string[] {
  return model.chunks.map((c) => `${c.state}:${c.leftDone ? 'L' : '-'}${c.rightDone ? 'R' : '-'}`)
}

/** Character offset of the start of result line `line`. */
function offsetOf(model: MergeModel, line: number): number {
  return model.resultLines.slice(0, line).join('').length
}

describe('createModel', () => {
  it('starts the result from base with every chunk pending', () => {
    const m = createModel(SIDES)
    expect(m.result).toBe(SIDES.base)
    expect(m.chunks.map((c) => c.kind)).toEqual(['left-only', 'conflict', 'right-only'])
    expect(ranges(m)).toEqual([[1, 2], [3, 5], [7, 7]])
    // The side without a change in a one-sided chunk counts as already done.
    expect(states(m)).toEqual(['pending:-R', 'pending:--', 'pending:L-'])
    expect(counts(m)).toEqual({ resolved: 0, total: 1 })
    expect(allResolved(m)).toBe(false)
  })

  it('treats a missing base (add/add) as empty text', () => {
    const m = createModel({ base: null, ours: 'x\n', theirs: 'y\n' })
    expect(m.result).toBe('')
    expect(ranges(m)).toEqual([[0, 0]])
    const both = acceptRight(acceptLeft(m, 0), 0)
    expect(both.result).toBe('x\ny\n')
    expect(both.chunks[0]!.state).toBe('both-left-first')
  })
})

describe('chunk actions', () => {
  it('acceptLeft on a left-only chunk applies the left text', () => {
    const m = acceptLeft(createModel(SIDES), 0)
    expect(m.result).toBe('a\nB\nc\nd\ne\nf\ng\n')
    expect(states(m)[0]).toBe('left:LR')
    expect(isChunkResolved(m.chunks[0]!)).toBe(true)
    expect(counts(m)).toEqual({ resolved: 0, total: 1 })
  })

  it('acceptRight on an insertion chunk grows its result range', () => {
    const m = acceptRight(createModel(SIDES), 2)
    expect(m.result).toBe('a\nb\nc\nd\ne\nf\ng\nh\n')
    expect(ranges(m)[2]).toEqual([7, 8])
  })

  it('accepting one side of a conflict leaves the other side to decide', () => {
    const m = acceptLeft(createModel(SIDES), 1)
    expect(m.result).toBe('a\nb\nc\nd\nE1\nf\ng\n')
    expect(states(m)[1]).toBe('left:L-')
    expect(counts(m)).toEqual({ resolved: 0, total: 1 })
  })

  it('accepting the second side appends it after the first', () => {
    const m = acceptRight(acceptLeft(createModel(SIDES), 1), 1)
    expect(m.result).toBe('a\nb\nc\nd\nE1\nD\nE2\nf\ng\n')
    expect(states(m)[1]).toBe('both-left-first:LR')
    expect(ranges(m)).toEqual([[1, 2], [3, 7], [9, 9]])
    expect(counts(m)).toEqual({ resolved: 1, total: 1 })

    const r = acceptLeft(acceptRight(createModel(SIDES), 1), 1)
    expect(r.result).toBe('a\nb\nc\nD\nE2\nd\nE1\nf\ng\n')
    expect(states(r)[1]).toBe('both-right-first:LR')
  })

  it('ignoring the other side after accepting one resolves the conflict', () => {
    const m = ignore(acceptLeft(createModel(SIDES), 1), 1, 'right')
    expect(m.result).toBe('a\nb\nc\nd\nE1\nf\ng\n')
    expect(states(m)[1]).toBe('left:LR')
    expect(counts(m)).toEqual({ resolved: 1, total: 1 })
  })

  it('ignoring both sides keeps the base text', () => {
    const one = ignore(createModel(SIDES), 1, 'left')
    expect(states(one)[1]).toBe('ignored:L-')
    const m = ignore(one, 1, 'right')
    expect(m.result).toBe(SIDES.base)
    expect(states(m)[1]).toBe('ignored:LR')
    expect(counts(m)).toEqual({ resolved: 1, total: 1 })
  })

  it('accepting a side after ignoring the other replaces the base text', () => {
    const m = acceptRight(ignore(createModel(SIDES), 1, 'left'), 1)
    expect(m.result).toBe('a\nb\nc\nD\nE2\nf\ng\n')
    expect(states(m)[1]).toBe('right:LR')
  })

  it('appendBoth inserts both sides in the requested order', () => {
    const lf = appendBoth(createModel(SIDES), 1, 'left-first')
    expect(lf.result).toBe('a\nb\nc\nd\nE1\nD\nE2\nf\ng\n')
    expect(states(lf)[1]).toBe('both-left-first:LR')
    const rf = appendBoth(createModel(SIDES), 1, 'right-first')
    expect(rf.result).toBe('a\nb\nc\nD\nE2\nd\nE1\nf\ng\n')
    expect(states(rf)[1]).toBe('both-right-first:LR')
  })

  it('appendBoth adds a line break when the first side has no final newline', () => {
    const m = appendBoth(createModel({ base: 'a\n', ours: 'a\nl', theirs: 'a\nr' }), 0, 'left-first')
    expect(m.result).toBe('a\nl\nr')
  })

  it('resolveWhole (Ctrl+click) applies one side and ignores the other in one step', () => {
    const m = resolveWhole(createModel(SIDES), 1, 'right')
    expect(m.result).toBe('a\nb\nc\nD\nE2\nf\ng\n')
    expect(states(m)[1]).toBe('right:LR')
    expect(counts(m)).toEqual({ resolved: 1, total: 1 })

    // After one side was applied, Ctrl+click on the other side replaces instead of appending.
    const replaced = resolveWhole(acceptLeft(createModel(SIDES), 1), 1, 'right')
    expect(replaced.result).toBe('a\nb\nc\nD\nE2\nf\ng\n')
    expect(states(replaced)[1]).toBe('right:LR')
  })

  it('treats same-change chunks as resolved by either side', () => {
    const sides = { base: 'a\nb\n', ours: 'a\nX\n', theirs: 'a\nX\n' }
    const m = acceptRight(createModel(sides), 0)
    expect(m.result).toBe('a\nX\n')
    expect(states(m)[0]).toBe('right:LR')
    expect(counts(m)).toEqual({ resolved: 0, total: 0 })
  })

  it('actions on a side that is already done return the same model', () => {
    const m = acceptLeft(createModel(SIDES), 1)
    expect(acceptLeft(m, 1)).toBe(m)
    expect(ignore(m, 1, 'left')).toBe(m)
    expect(appendBoth(m, 1, 'left-first')).toBe(m)
    const unchangedSide = createModel(SIDES)
    expect(acceptRight(unchangedSide, 0)).toBe(unchangedSide)
  })
})

describe('file actions', () => {
  it('applyNonConflicting only touches non-conflict chunks of the chosen side', () => {
    const left = applyNonConflicting(createModel(SIDES), 'left')
    expect(states(left)).toEqual(['left:LR', 'pending:--', 'pending:L-'])
    const right = applyNonConflicting(createModel(SIDES), 'right')
    expect(states(right)).toEqual(['pending:-R', 'pending:--', 'right:LR'])
    const all = applyNonConflicting(createModel(SIDES), 'all')
    expect(all.result).toBe('a\nB\nc\nd\ne\nf\ng\nh\n')
    expect(states(all)).toEqual(['left:LR', 'pending:--', 'right:LR'])
    expect(ranges(all)).toEqual([[1, 2], [3, 5], [7, 8]])
  })

  it('applyNonConflicting applies same-change chunks', () => {
    const m = applyNonConflicting(createModel({ base: 'a\nb\n', ours: 'a\nX\n', theirs: 'a\nX\n' }), 'left')
    expect(m.result).toBe('a\nX\n')
    expect(allResolved(m)).toBe(true)
  })

  it('resolveSimple only resolves simple conflicts and reports how many', () => {
    const start = createModel(SIMPLE)
    expect(start.chunks.map((c) => c.kind)).toEqual(['conflict', 'conflict'])
    expect(simpleResult(start, 0)).toBe('P\nQ\n')
    expect(simpleResult(start, 1)).toBeNull()
    const { model, resolved } = resolveSimple(start)
    expect(resolved).toBe(1)
    expect(model.result).toBe('P\nQ\nm\nk = 1\n')
    expect(states(model)).toEqual(['edited:LR', 'pending:--'])
    expect(counts(model)).toEqual({ resolved: 1, total: 2 })
    // Running again finds nothing left to do.
    expect(resolveSimple(model).resolved).toBe(0)
  })

  it('resolveSimple skips conflicts where one side was already decided', () => {
    const { resolved } = resolveSimple(acceptLeft(createModel(SIMPLE), 0))
    expect(resolved).toBe(0)
  })

  it('acceptFile replaces the whole result with one side and resolves everything', () => {
    const left = acceptFile(applyEdit(createModel(SIDES), 0, 0, 'zz'), 'left')
    expect(left.result).toBe(SIDES.ours)
    expect(allResolved(left)).toBe(true)
    expect(states(left)).toEqual(['left:LR', 'left:LR', 'ignored:LR'])
    expect(ranges(left)).toEqual([[1, 2], [3, 5], [7, 7]])
    const right = acceptFile(createModel(SIDES), 'right')
    expect(right.result).toBe(SIDES.theirs)
    expect(ranges(right)).toEqual([[1, 2], [3, 5], [7, 8]])
  })

  it('revert returns to the initial state', () => {
    const m = revert(acceptFile(createModel(SIDES), 'left'))
    expect(m.result).toBe(SIDES.base)
    expect(states(m)).toEqual(states(createModel(SIDES)))
    expect(ranges(m)).toEqual(ranges(createModel(SIDES)))
  })

  it('autoMerge replays applyNonConflicting(all) and resolveSimple deterministically', () => {
    const a = autoMerge(SIMPLE)
    expect(a.result).toBe('P\nQ\nm\nk = 1\n')
    expect(counts(a)).toEqual({ resolved: 1, total: 2 })
    const b = autoMerge({ base: 'x = 1\n', ours: 'x = 2\n', theirs: 'x = 1\n' })
    expect(b.result).toBe('x = 2\n')
    expect(allResolved(b)).toBe(true)
  })
})

describe('applyEdit', () => {
  it('shifts chunks after an edit in an unchanged region', () => {
    const m = applyEdit(createModel(SIDES), 0, 0, 'X\n')
    expect(m.result).toBe(`X\n${SIDES.base}`)
    expect(ranges(m)).toEqual([[2, 3], [4, 6], [8, 8]])
    expect(states(m)).toEqual(states(createModel(SIDES)))
  })

  it('does not mark a chunk when typing at the end of the line before it', () => {
    const start = createModel(SIDES)
    const m = applyEdit(start, offsetOf(start, 3) - 1, offsetOf(start, 3) - 1, 'x')
    expect(m.result).toBe('a\nb\ncx\nd\ne\nf\ng\n')
    expect(states(m)).toEqual(states(start))
    expect(ranges(m)).toEqual(ranges(start))
  })

  it('shifts a chunk when a new line is inserted at its first line start', () => {
    const start = createModel(SIDES)
    const m = applyEdit(start, offsetOf(start, 3), offsetOf(start, 3), '\n')
    expect(states(m)).toEqual(states(start))
    expect(ranges(m)).toEqual([[1, 2], [4, 6], [8, 8]])
  })

  it('marks a chunk edited when typing inside it', () => {
    const start = createModel(SIDES)
    const m = applyEdit(start, offsetOf(start, 3) + 1, offsetOf(start, 3) + 1, 'd')
    expect(m.result).toBe('a\nb\nc\ndd\ne\nf\ng\n')
    expect(states(m)[1]).toBe('edited:--')
    expect(ranges(m)).toEqual([[1, 2], [3, 5], [7, 7]])
    expect(counts(m)).toEqual({ resolved: 1, total: 1 })
  })

  it('marks every chunk an edit spans and keeps ranges ordered', () => {
    const start = createModel(SIDES)
    const m = applyEdit(start, offsetOf(start, 1) + 1, offsetOf(start, 3) + 1, 'Z')
    expect(m.result).toBe('a\nbZ\ne\nf\ng\n')
    expect(states(m)).toEqual(['edited:--', 'edited:--', 'pending:L-'])
    expect(ranges(m)).toEqual([[1, 2], [2, 3], [5, 5]])
  })

  it('collapses a chunk whose lines are deleted', () => {
    const start = createModel(SIDES)
    const m = applyEdit(start, offsetOf(start, 3), offsetOf(start, 5), '')
    expect(m.result).toBe('a\nb\nc\nf\ng\n')
    expect(states(m)[1]).toBe('edited:--')
    expect(ranges(m)).toEqual([[1, 2], [3, 3], [5, 5]])
  })

  it('marks an empty chunk edited when typing at its position', () => {
    const start = createModel(SIDES)
    const m = applyEdit(start, start.result.length, start.result.length, 'h')
    expect(states(m)[2]).toBe('edited:--')
    expect(ranges(m)[2]).toEqual([7, 8])
  })

  it('keeps edited chunks out of chunk and batch actions', () => {
    const start = createModel(SIDES)
    const edited = applyEdit(start, offsetOf(start, 1), offsetOf(start, 1) + 1, 'b2')
    expect(states(edited)[0]).toBe('edited:--')
    expect(acceptLeft(edited, 0)).toBe(edited)
    const all = applyNonConflicting(edited, 'all')
    expect(all.result.startsWith('a\nb2\n')).toBe(true)
    expect(states(all)[0]).toBe('edited:--')

    const simpleStart = createModel(SIMPLE)
    const simpleEdited = applyEdit(simpleStart, 0, 1, 'p0')
    const { model, resolved } = resolveSimple(simpleEdited)
    expect(resolved).toBe(0)
    expect(model.result).toBe(simpleEdited.result)
  })

  it('ignores a no-op edit', () => {
    const start = createModel(SIDES)
    expect(applyEdit(start, 3, 3, '')).toBe(start)
  })
})

describe('nextUnresolved', () => {
  it('walks unresolved chunks in both directions without wrapping', () => {
    const m = createModel(SIDES)
    expect(nextUnresolved(m, null, 'next')).toBe(0)
    expect(nextUnresolved(m, 0, 'next')).toBe(1)
    expect(nextUnresolved(m, 2, 'next')).toBeNull()
    expect(nextUnresolved(m, null, 'prev')).toBe(2)
    expect(nextUnresolved(m, 1, 'prev')).toBe(0)
    expect(nextUnresolved(acceptLeft(m, 0), null, 'next')).toBe(1)
  })
})

describe('draft round trip', () => {
  function worked(): MergeModel {
    let m = createModel(SIDES)
    m = acceptLeft(m, 0)
    m = acceptLeft(m, 1)
    m = applyEdit(m, offsetOf(m, 3) + 1, offsetOf(m, 3) + 1, 'dd')
    return m
  }

  it('restores the result text, chunk states and ranges exactly', () => {
    const m = worked()
    const draft = toDraft(m, STAGES, SAVED_AT)
    expect(draft).toEqual({
      version: 1,
      stages: STAGES,
      result: m.result,
      chunks: [
        { state: 'left', leftDone: true, rightDone: true },
        { state: 'edited', leftDone: false, rightDone: false },
        { state: 'pending', leftDone: true, rightDone: false },
      ],
      savedAt: SAVED_AT,
    } satisfies MergeDraft)
    const restored = createModel(SIDES, draft)
    expect(restored).not.toBeNull()
    expect(restored!.result).toBe(m.result)
    expect(states(restored!)).toEqual(states(m))
    expect(ranges(restored!)).toEqual(ranges(m))
    expect(toDraft(restored!, STAGES, SAVED_AT)).toEqual(draft)
  })

  it('restores auto-resolved and appended chunks', () => {
    const m = acceptRight(acceptLeft(resolveSimple(createModel(SIMPLE)).model, 1), 1)
    const restored = createModel(SIMPLE, toDraft(m, STAGES, SAVED_AT))!
    expect(restored.result).toBe(m.result)
    expect(ranges(restored)).toEqual(ranges(m))
    expect(states(restored)).toEqual(states(m))
  })

  it('rejects a draft whose chunk count does not match', () => {
    const draft = toDraft(worked(), STAGES, SAVED_AT)
    expect(createModel(SIDES, { ...draft, chunks: draft.chunks.slice(1) })).toBeNull()
  })

  it('rejects a draft with an unknown version or state', () => {
    const draft = toDraft(worked(), STAGES, SAVED_AT)
    expect(createModel(SIDES, { ...draft, version: 2 as unknown as 1 })).toBeNull()
    const badState = { ...draft, chunks: draft.chunks.map((c) => ({ ...c, state: 'bogus' as unknown as 'left' })) }
    expect(createModel(SIDES, badState)).toBeNull()
  })

  it('defaults savedAt to the current time', () => {
    const draft = toDraft(createModel(SIDES), STAGES)
    expect(Number.isNaN(Date.parse(draft.savedAt))).toBe(false)
  })
})

describe('invariants under random actions and edits', () => {
  function rng(seed: number): (n: number) => number {
    let s = seed
    return (n) => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s % n
    }
  }

  function randomText(rand: (n: number) => number, lines: number): string {
    return Array.from({ length: lines }, () => `${'abcde'[rand(5)]}${rand(3)}\n`).join('')
  }

  function mutate(rand: (n: number) => number, text: string): string {
    const lines = text.split(/(?<=\n)/).filter((l) => l !== '')
    for (let k = 0; k < 4; k++) {
      const at = rand(lines.length + 1)
      const op = rand(3)
      if (op === 0) lines.splice(at, 0, `n${rand(9)}\n`)
      else if (op === 1 && at < lines.length) lines.splice(at, 1)
      else if (at < lines.length) lines[at] = `m${rand(9)}\n`
    }
    return lines.join('')
  }

  /** Ordered, non-overlapping, in bounds; non-edited chunks hold exactly their state's text. */
  function check(m: MergeModel): void {
    expect(m.resultLines.join('')).toBe(m.result)
    let floor = 0
    for (const c of m.chunks) {
      expect(c.resultRange.start).toBeGreaterThanOrEqual(floor)
      expect(c.resultRange.end).toBeGreaterThanOrEqual(c.resultRange.start)
      floor = c.resultRange.end
      if (c.state === 'edited') continue
      const text = m.resultLines.slice(c.resultRange.start, c.resultRange.end).join('')
      const left = m.leftLines.slice(c.left.start, c.left.end).join('')
      const right = m.rightLines.slice(c.right.start, c.right.end).join('')
      const base = m.baseLines.slice(c.base.start, c.base.end).join('')
      const expected = { pending: base, ignored: base, left, right, 'both-left-first': left + right, 'both-right-first': right + left }[c.state]
      expect(text).toBe(expected)
    }
    expect(floor).toBeLessThanOrEqual(m.resultLines.length)
  }

  it('keeps ranges consistent and drafts restorable', () => {
    const rand = rng(42)
    for (let round = 0; round < 150; round++) {
      const base = randomText(rand, 12)
      const texts = { base, ours: mutate(rand, base), theirs: mutate(rand, base) }
      let m = createModel(texts)
      check(m)
      for (let step = 0; step < 8; step++) {
        const id = m.chunks.length > 0 ? rand(m.chunks.length) : 0
        const side = rand(2) === 0 ? 'left' : 'right'
        switch (rand(7)) {
          case 0: m = acceptLeft(m, id); break
          case 1: m = acceptRight(m, id); break
          case 2: m = ignore(m, id, side); break
          case 3: m = appendBoth(m, id, side === 'left' ? 'left-first' : 'right-first'); break
          case 4: m = resolveWhole(m, id, side); break
          case 5: m = resolveSimple(applyNonConflicting(m, 'all')).model; break
          default: {
            const from = rand(m.result.length + 1)
            const to = Math.min(m.result.length, from + rand(6))
            m = applyEdit(m, from, to, ['', 'x', 'y\n', '\n'][rand(4)]!)
          }
        }
        check(m)
      }
      const restored = createModel(texts, toDraft(m, STAGES, SAVED_AT))!
      expect(restored.result).toBe(m.result)
      expect(states(restored)).toEqual(states(m))
      check(restored)
    }
  })
})

describe('large inputs', () => {
  it('handles 20 000-line files with scattered and wholesale changes', () => {
    const base = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`).join('')
    const ours = base.replace('line 100\n', 'ours 100\n').replace('line 15000\n', 'ours 15000\n')
    const theirs = base.replace('line 100\n', 'theirs 100\n').replace('line 9000\n', 'theirs 9000\n')
    const m = applyNonConflicting(createModel({ base, ours, theirs }), 'all')
    expect(m.chunks.map((c) => c.kind)).toEqual(['conflict', 'right-only', 'left-only'])
    expect(counts(m)).toEqual({ resolved: 0, total: 1 })

    const unrelated = Array.from({ length: 20_000 }, (_, i) => `other ${i * 7}\n`).join('')
    const started = Date.now()
    const w = createModel({ base, ours: unrelated, theirs: base })
    expect(w.chunks.length).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(4000)
  })
})
