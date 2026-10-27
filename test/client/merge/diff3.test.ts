// B1 T4 diff3 chunking and simple-conflict detection.
import { describe, expect, it } from 'vitest'

import { diff3, isSimpleConflict, simpleMerge, type MergeChunk } from '../../../src/client/merge/diff3.ts'
import { splitLines } from '../../../src/client/merge/line-diff.ts'

function chunks(base: string, ours: string, theirs: string): MergeChunk[] {
  return diff3(splitLines(base), splitLines(ours), splitLines(theirs))
}

const r = (start: number, end: number) => ({ start, end })

describe('diff3', () => {
  it('returns no chunks when all three are equal', () => {
    expect(chunks('a\nb\n', 'a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('classifies a change only on the left', () => {
    expect(chunks('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\n')).toEqual([
      { id: 0, kind: 'left-only', base: r(1, 2), left: r(1, 2), right: r(1, 2) },
    ])
  })

  it('classifies a change only on the right, with offsets from earlier chunks', () => {
    expect(chunks('a\nb\nc\nd\n', 'x\na\nb\nc\nd\n', 'a\nb\nc\nD\n')).toEqual([
      { id: 0, kind: 'left-only', base: r(0, 0), left: r(0, 1), right: r(0, 0) },
      { id: 1, kind: 'right-only', base: r(3, 4), left: r(4, 5), right: r(3, 4) },
    ])
  })

  it('classifies identical changes on both sides as same-change', () => {
    expect(chunks('a\nb\nc\n', 'a\nX\nc\n', 'a\nX\nc\n')).toEqual([
      { id: 0, kind: 'same-change', base: r(1, 2), left: r(1, 2), right: r(1, 2) },
    ])
  })

  it('merges overlapping changes into one conflict', () => {
    expect(chunks('a\nb\nc\nd\n', 'a\nB\nC\nd\n', 'a\nb\nZ\nd\n')).toEqual([
      { id: 0, kind: 'conflict', base: r(1, 3), left: r(1, 3), right: r(1, 3) },
    ])
  })

  it('merges adjacent changes into one conflict', () => {
    expect(chunks('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'a\nb\nC\nd\n')).toEqual([
      { id: 0, kind: 'conflict', base: r(1, 3), left: r(1, 3), right: r(1, 3) },
    ])
  })

  it('keeps changes separated by an unchanged line apart', () => {
    expect(chunks('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n')).toEqual([
      { id: 0, kind: 'left-only', base: r(0, 1), left: r(0, 1), right: r(0, 1) },
      { id: 1, kind: 'right-only', base: r(2, 3), left: r(2, 3), right: r(2, 3) },
    ])
  })

  it('treats an add/add file (no base) as one conflict', () => {
    expect(diff3([], splitLines('x\ny\n'), splitLines('x\nz\n'))).toEqual([
      { id: 0, kind: 'conflict', base: r(0, 0), left: r(0, 2), right: r(0, 2) },
    ])
  })

  it('treats both sides appending different lines at the end as a conflict', () => {
    expect(chunks('a\n', 'a\nl\n', 'a\nr\n')).toEqual([
      { id: 0, kind: 'conflict', base: r(1, 1), left: r(1, 2), right: r(1, 2) },
    ])
  })

  it('handles one side appending at the end', () => {
    expect(chunks('a\n', 'a\n', 'a\nr\n')).toEqual([
      { id: 0, kind: 'right-only', base: r(1, 1), left: r(1, 1), right: r(1, 2) },
    ])
  })

  it('handles a deletion on one side', () => {
    expect(chunks('a\nb\nc\n', 'a\nc\n', 'a\nb\nc\n')).toEqual([
      { id: 0, kind: 'left-only', base: r(1, 2), left: r(1, 1), right: r(1, 2) },
    ])
  })
})

describe('simpleMerge / isSimpleConflict', () => {
  function only(base: string, ours: string, theirs: string): { chunk: MergeChunk; b: string[]; o: string[]; t: string[] } {
    const b = splitLines(base)
    const o = splitLines(ours)
    const t = splitLines(theirs)
    const list = diff3(b, o, t)
    expect(list).toHaveLength(1)
    return { chunk: list[0]!, b, o, t }
  }

  it('merges different words changed on the same line', () => {
    const { chunk, b, o, t } = only('the quick brown fox\n', 'the slow brown fox\n', 'the quick brown dog\n')
    expect(chunk.kind).toBe('conflict')
    expect(isSimpleConflict(chunk, b, o, t)).toBe(true)
    expect(simpleMerge(chunk, b, o, t)).toBe('the slow brown dog\n')
  })

  it('is not simple when both sides change the same word', () => {
    const { chunk, b, o, t } = only('let a = 1;\n', 'let a = 10;\n', 'let a = 20;\n')
    expect(isSimpleConflict(chunk, b, o, t)).toBe(false)
    expect(simpleMerge(chunk, b, o, t)).toBeNull()
  })

  it('is not simple when both sides change different letters of the same word', () => {
    const { chunk, b, o, t } = only('value\n', 'vXlue\n', 'valuY\n')
    expect(isSimpleConflict(chunk, b, o, t)).toBe(false)
  })

  it('merges changes on different lines of one conflict chunk', () => {
    const { chunk, b, o, t } = only('a\nb\n', 'A\nb\n', 'a\nB\n')
    expect(chunk.kind).toBe('conflict')
    expect(simpleMerge(chunk, b, o, t)).toBe('A\nB\n')
  })

  it('is not simple for add/add with different content', () => {
    const b: string[] = []
    const o = splitLines('x\n')
    const t = splitLines('y\n')
    const [chunk] = diff3(b, o, t)
    expect(isSimpleConflict(chunk!, b, o, t)).toBe(false)
  })

  it('only applies to conflict chunks', () => {
    const b = splitLines('a\n')
    const o = splitLines('b\n')
    const [chunk] = diff3(b, o, b)
    expect(chunk!.kind).toBe('left-only')
    expect(isSimpleConflict(chunk!, b, o, b)).toBe(false)
  })
})
