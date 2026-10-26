// Line splitting and Myers O(ND) diff (linear-space middle-snake variant). Pure, no DOM, no React.

/** A changed region: `a[aStart, aEnd)` is replaced by `b[bStart, bEnd)` (half-open; either side may be empty). */
export interface DiffOp {
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

/**
 * Upper bound on the edit distance explored by one bisect step. Beyond it the remaining region is
 * reported as a single replacement, which keeps pathological inputs (two unrelated 20 000-line
 * files, huge token streams) from taking seconds.
 */
const MAX_BISECT_COST = 4096

/** Splits text into lines that keep their terminator (`\n` or `\r\n`); a last line without one is kept. */
export function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) break
    lines.push(text.slice(start, nl + 1))
    start = nl + 1
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

/** Line diff `a → b`; lines compare by exact text including the terminator. Returns changed regions only, sorted. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  const ids = new Map<string, number>()
  const intern = (line: string): number => {
    let id = ids.get(line)
    if (id === undefined) {
      id = ids.size
      ids.set(line, id)
    }
    return id
  }
  return diffSequences(a.map(intern), b.map(intern))
}

/** Myers diff over integer sequences (callers intern their items). Adjacent regions are coalesced. */
export function diffSequences(a: ArrayLike<number>, b: ArrayLike<number>): DiffOp[] {
  const out: DiffOp[] = []
  diffRange(a, 0, a.length, b, 0, b.length, out)
  const merged: DiffOp[] = []
  for (const op of out) {
    const last = merged[merged.length - 1]
    if (last && last.aEnd === op.aStart && last.bEnd === op.bStart) {
      last.aEnd = op.aEnd
      last.bEnd = op.bEnd
    } else {
      merged.push({ ...op })
    }
  }
  return merged
}

function diffRange(
  a: ArrayLike<number>, aLo: number, aHi: number,
  b: ArrayLike<number>, bLo: number, bHi: number,
  out: DiffOp[],
): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) { aLo++; bLo++ }
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi-- }
  if (aLo === aHi && bLo === bHi) return
  if (aLo === aHi || bLo === bHi) {
    out.push({ aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi })
    return
  }
  const split = bisect(a, aLo, aHi, b, bLo, bHi)
  // A split on a corner would not make progress; report the whole region instead.
  if (!split || (split.x === aLo && split.y === bLo) || (split.x === aHi && split.y === bHi)) {
    out.push({ aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi })
    return
  }
  diffRange(a, aLo, split.x, b, bLo, split.y, out)
  diffRange(a, split.x, aHi, b, split.y, bHi, out)
}

/**
 * Finds the middle snake of `a[aLo,aHi)` vs `b[bLo,bHi)` (Myers 1986, as in diff-match-patch's bisect)
 * and returns the absolute split point, or null when there is no common item or the cost cap is hit.
 */
function bisect(
  a: ArrayLike<number>, aLo: number, aHi: number,
  b: ArrayLike<number>, bLo: number, bHi: number,
): { x: number; y: number } | null {
  const n = aHi - aLo
  const m = bHi - bLo
  const maxD = Math.ceil((n + m) / 2)
  const offset = maxD
  const size = 2 * maxD + 2
  const v1 = new Int32Array(size).fill(-1)
  const v2 = new Int32Array(size).fill(-1)
  v1[offset + 1] = 0
  v2[offset + 1] = 0
  const delta = n - m
  const front = delta % 2 !== 0
  let k1start = 0
  let k1end = 0
  let k2start = 0
  let k2end = 0
  const limit = Math.min(maxD, MAX_BISECT_COST)
  for (let d = 0; d < limit; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = offset + k1
      let x1 = k1 === -d || (k1 !== d && v1[k1Offset - 1]! < v1[k1Offset + 1]!) ? v1[k1Offset + 1]! : v1[k1Offset - 1]! + 1
      let y1 = x1 - k1
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) { x1++; y1++ }
      v1[k1Offset] = x1
      if (x1 > n) k1end += 2
      else if (y1 > m) k1start += 2
      else if (front) {
        const k2Offset = offset + delta - k1
        if (k2Offset >= 0 && k2Offset < size && v2[k2Offset] !== -1) {
          const x2 = n - v2[k2Offset]!
          if (x1 >= x2) return { x: aLo + x1, y: bLo + y1 }
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = offset + k2
      let x2 = k2 === -d || (k2 !== d && v2[k2Offset - 1]! < v2[k2Offset + 1]!) ? v2[k2Offset + 1]! : v2[k2Offset - 1]! + 1
      let y2 = x2 - k2
      while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) { x2++; y2++ }
      v2[k2Offset] = x2
      if (x2 > n) k2end += 2
      else if (y2 > m) k2start += 2
      else if (!front) {
        const k1Offset = offset + delta - k2
        if (k1Offset >= 0 && k1Offset < size && v1[k1Offset] !== -1) {
          const x1 = v1[k1Offset]!
          const y1 = offset + x1 - k1Offset
          if (x1 >= n - x2) return { x: aLo + x1, y: bLo + y1 }
        }
      }
    }
  }
  return null
}
