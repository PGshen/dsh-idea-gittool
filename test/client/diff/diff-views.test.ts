// B3b T4: pure helpers of the enhanced diff viewer (side-by-side rows, word diff, folding, change anchors).
import { describe, expect, it } from 'vitest'

import { changeAnchors, foldContext, pairChanges, splitRows, wordDiff } from '../../../src/client/diff/diff-views.ts'
import type { DiffLine } from '../../../src/shared/protocol.ts'

const ctx = (text: string, oldLine: number, newLine: number): DiffLine => ({ type: 'context', text, oldLine, newLine })
const del = (text: string, oldLine: number): DiffLine => ({ type: 'del', text, oldLine })
const add = (text: string, newLine: number): DiffLine => ({ type: 'add', text, newLine })

describe('splitRows', () => {
  it('pairs each run of deletions with the following additions and pads the shorter side', () => {
    const lines = [ctx('a', 1, 1), del('b', 2), del('c', 3), add('B', 2), ctx('d', 4, 3), add('e', 4)]
    expect(splitRows(lines).map(row => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', null],
      ['d', 'd'],
      [null, 'e'],
    ])
    const rows = splitRows(lines)
    expect([rows[1]?.left?.oldLine, rows[1]?.right?.newLine]).toEqual([2, 2])
  })
})

describe('wordDiff', () => {
  it('marks only the changed words of a line', () => {
    const result = wordDiff('const total = price * count', 'const total = price * amount')
    expect(result).not.toBeNull()
    const marked = (text: string, ranges: readonly [number, number][]): string[] => ranges.map(([start, end]) => text.slice(start, end))
    expect(marked('const total = price * count', result?.old ?? [])).toEqual(['count'])
    expect(marked('const total = price * amount', result?.new ?? [])).toEqual(['amount'])
  })

  it('treats a mostly rewritten line as a whole-line change and equal lines as no change', () => {
    expect(wordDiff('alpha beta gamma', 'one two three')).toBeNull()
    expect(wordDiff('same text', 'same text')).toBeNull()
  })

  it('handles CJK and punctuation tokens', () => {
    const result = wordDiff('提交信息：旧的', '提交信息：新的')
    expect(result?.old.length).toBeGreaterThan(0)
    expect(result?.new.length).toBeGreaterThan(0)
  })
})

describe('pairChanges', () => {
  it('gives word ranges to the i-th deletion and i-th addition of each change run', () => {
    const lines = [del('let a = 1', 1), add('let a = 2', 1), ctx('x', 2, 2), del('gone', 3)]
    const pairs = pairChanges(lines)
    expect([...pairs.keys()].sort()).toEqual([0, 1])
    expect(pairs.get(3)).toBeUndefined()
  })
})

describe('foldContext', () => {
  it('folds context runs longer than the threshold, keeping 3 lines next to changes', () => {
    const lines: DiffLine[] = [
      ...Array.from({ length: 12 }, (_, index) => ctx(`c${String(index)}`, index + 1, index + 1)),
      del('x', 13),
      add('y', 13),
      ...Array.from({ length: 5 }, (_, index) => ctx(`t${String(index)}`, 14 + index, 14 + index)),
    ]
    const segments = foldContext(lines, new Set())
    expect(segments).toEqual([
      { kind: 'fold', start: 0, count: 9 },
      { kind: 'lines', start: 9, end: 19 },
    ])
    expect(foldContext(lines, new Set([0]))).toEqual([{ kind: 'lines', start: 0, end: 19 }])
  })

  it('folds a long middle run on both sides of the kept edges', () => {
    const lines: DiffLine[] = [
      del('a', 1),
      ...Array.from({ length: 20 }, (_, index) => ctx(`m${String(index)}`, index + 2, index + 1)),
      add('b', 21),
    ]
    expect(foldContext(lines, new Set())).toEqual([
      { kind: 'lines', start: 0, end: 4 },
      { kind: 'fold', start: 4, count: 14 },
      { kind: 'lines', start: 18, end: 22 },
    ])
  })
})

describe('changeAnchors', () => {
  it('lists the first line of every change block', () => {
    const lines = [ctx('a', 1, 1), del('b', 2), add('B', 2), ctx('c', 3, 3), add('d', 4), ctx('e', 4, 5)]
    expect(changeAnchors(lines)).toEqual([1, 4])
  })
})
