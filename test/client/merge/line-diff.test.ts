// B1 T4 line diff: splitLines keeps line endings; diffLines lists changed regions only.
import { describe, expect, it } from 'vitest'

import { diffLines, splitLines, type DiffOp } from '../../../src/client/merge/line-diff.ts'

/** Applies ops (a → b) to `a` and returns the reconstructed `b`; proves ops are a valid edit script. */
function apply(a: string[], b: string[], ops: DiffOp[]): string[] {
  const out: string[] = []
  let pos = 0
  for (const op of ops) {
    out.push(...a.slice(pos, op.aStart))
    out.push(...b.slice(op.bStart, op.bEnd))
    pos = op.aEnd
  }
  out.push(...a.slice(pos))
  return out
}

function checkOps(a: string[], b: string[], ops: DiffOp[]): void {
  expect(apply(a, b, ops)).toEqual(b)
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    expect(op.aStart).toBeLessThanOrEqual(op.aEnd)
    expect(op.bStart).toBeLessThanOrEqual(op.bEnd)
    expect(op.aEnd - op.aStart + op.bEnd - op.bStart).toBeGreaterThan(0)
    if (i > 0) {
      const prev = ops[i - 1]!
      // Sorted, non-overlapping and not touching on both sides (adjacent ops are coalesced).
      expect(op.aStart).toBeGreaterThanOrEqual(prev.aEnd)
      expect(op.aStart > prev.aEnd || op.bStart > prev.bEnd).toBe(true)
    }
    // Unchanged stretches between ops really are equal.
    const prevAEnd = i > 0 ? ops[i - 1]!.aEnd : 0
    const prevBEnd = i > 0 ? ops[i - 1]!.bEnd : 0
    expect(op.aStart - prevAEnd).toBe(op.bStart - prevBEnd)
  }
}

describe('splitLines', () => {
  it('returns no lines for empty text', () => {
    expect(splitLines('')).toEqual([])
  })

  it('keeps LF and CRLF endings and a final line without newline', () => {
    expect(splitLines('a\nb\r\nc')).toEqual(['a\n', 'b\r\n', 'c'])
    expect(splitLines('a\n')).toEqual(['a\n'])
    expect(splitLines('\n\n')).toEqual(['\n', '\n'])
  })

  it('joins back to the original text', () => {
    const text = 'x\r\n\ny\nz'
    expect(splitLines(text).join('')).toBe(text)
  })
})

describe('diffLines', () => {
  it('handles empty inputs', () => {
    expect(diffLines([], [])).toEqual([])
    expect(diffLines([], ['a\n'])).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }])
    expect(diffLines(['a\n'], [])).toEqual([{ aStart: 0, aEnd: 1, bStart: 0, bEnd: 0 }])
  })

  it('returns no ops for identical input', () => {
    const a = splitLines('a\nb\nc\n')
    expect(diffLines(a, [...a])).toEqual([])
  })

  it('returns one replace op when everything differs', () => {
    expect(diffLines(splitLines('a\nb\n'), splitLines('x\ny\nz\n'))).toEqual([{ aStart: 0, aEnd: 2, bStart: 0, bEnd: 3 }])
  })

  it('finds a single changed line in the middle', () => {
    expect(diffLines(splitLines('a\nb\nc\n'), splitLines('a\nB\nc\n'))).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }])
  })

  it('treats a missing final newline as a changed last line', () => {
    expect(diffLines(splitLines('a\nb\n'), splitLines('a\nb'))).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }])
  })

  it('treats LF and CRLF versions of a line as different', () => {
    const ops = diffLines(splitLines('a\nb\nc\n'), splitLines('a\nb\r\nc\n'))
    expect(ops).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }])
  })

  it('produces a minimal script for insertions and deletions', () => {
    const a = splitLines('1\n2\n3\n4\n5\n6\n')
    const b = splitLines('1\n2\nx\n3\n5\n6\ny\n')
    const ops = diffLines(a, b)
    checkOps(a, b, ops)
    expect(ops).toEqual([
      { aStart: 2, aEnd: 2, bStart: 2, bEnd: 3 },
      { aStart: 3, aEnd: 4, bStart: 4, bEnd: 4 },
      { aStart: 6, aEnd: 6, bStart: 6, bEnd: 7 },
    ])
  })

  it('produces valid edit scripts for pseudo-random inputs', () => {
    let seed = 7
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: rand(30) }, () => `${rand(6)}\n`)
      const b = Array.from({ length: rand(30) }, () => `${rand(6)}\n`)
      const ops = diffLines(a, b)
      checkOps(a, b, ops)
      // Minimal: edit cost equals n + m - 2 * LCS (reference O(NM) dynamic programming).
      const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
      for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
          lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
        }
      }
      const cost = ops.reduce((sum, op) => sum + op.aEnd - op.aStart + op.bEnd - op.bStart, 0)
      expect(cost).toBe(a.length + b.length - 2 * lcs[0]![0]!)
    }
  })
})

describe('diff stats', () => {
  it('reports coarse only when the cost cap stopped the search', () => {
    const stats = { coarse: false }
    diffLines(['a\n', 'b\n', 'c\n'], ['a\n', 'B\n', 'c\n'], stats)
    expect(stats.coarse).toBe(false)
    const a = Array.from({ length: 12_000 }, (_, i) => `line ${i}\n`)
    const b = a.map((line, i) => (i % 2 === 0 ? `x ${i}\n` : line))
    diffLines(a, b, stats)
    expect(stats.coarse).toBe(true)
  })
})
