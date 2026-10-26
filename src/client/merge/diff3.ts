// Three-way chunking (diff3) over lines, plus token-level "simple conflict" merging. Pure, no DOM, no React.
import { diffLines, diffSequences, type DiffOp, type DiffStats } from './line-diff.ts'

/** Half-open line range `[start, end)`. */
export interface Range {
  start: number
  end: number
}

/**
 * - `left-only` / `right-only`: only that side changed the base region.
 * - `same-change`: both sides made the identical change (non-conflicting).
 * - `conflict`: both sides changed overlapping or adjacent base regions differently.
 */
export type MergeChunkKind = 'left-only' | 'right-only' | 'same-change' | 'conflict'

/** One changed region of a three-way merge, in line numbers of base, left (ours) and right (theirs). */
export interface MergeChunk {
  /** Index in the chunk list (0-based, in file order). */
  id: number
  kind: MergeChunkKind
  base: Range
  left: Range
  right: Range
}

/** Upper bound on tokens fed to the token-level merge of one chunk; larger chunks are never "simple". */
const MAX_SIMPLE_TOKENS = 60_000

interface Group {
  base: Range
  left: Range
  right: Range
  hasLeft: boolean
  hasRight: boolean
}

/**
 * Groups the hunks of `base → left` and `base → right`. Hunks whose base ranges overlap or touch
 * (one ends where the other starts, including insertions at the same point) form one group.
 */
function groupHunks(leftOps: readonly DiffOp[], rightOps: readonly DiffOp[]): Group[] {
  const hunks = [
    ...leftOps.map((op) => ({ side: 'left' as const, op })),
    ...rightOps.map((op) => ({ side: 'right' as const, op })),
  ].sort((x, y) => x.op.aStart - y.op.aStart || x.op.aEnd - y.op.aEnd)
  const groups: Group[] = []
  // Line offset of each side relative to base outside any hunk seen so far.
  let leftOffset = 0
  let rightOffset = 0
  let i = 0
  while (i < hunks.length) {
    const first = hunks[i]!
    const members = [first]
    let baseStart = first.op.aStart
    let baseEnd = first.op.aEnd
    i++
    while (i < hunks.length && hunks[i]!.op.aStart <= baseEnd) {
      const next = hunks[i]!
      members.push(next)
      baseStart = Math.min(baseStart, next.op.aStart)
      baseEnd = Math.max(baseEnd, next.op.aEnd)
      i++
    }
    const sideRange = (side: 'left' | 'right', offset: number): { range: Range; has: boolean } => {
      const ops = members.filter((h) => h.side === side).map((h) => h.op)
      if (ops.length === 0) return { range: { start: baseStart + offset, end: baseEnd + offset }, has: false }
      const head = ops[0]!
      const tail = ops[ops.length - 1]!
      return {
        range: { start: head.bStart - (head.aStart - baseStart), end: tail.bEnd + (baseEnd - tail.aEnd) },
        has: true,
      }
    }
    const left = sideRange('left', leftOffset)
    const right = sideRange('right', rightOffset)
    leftOffset = left.range.end - baseEnd
    rightOffset = right.range.end - baseEnd
    groups.push({
      base: { start: baseStart, end: baseEnd },
      left: left.range,
      right: right.range,
      hasLeft: left.has,
      hasRight: right.has,
    })
  }
  return groups
}

function sameItems<T>(a: readonly T[], aRange: Range, b: readonly T[], bRange: Range): boolean {
  if (aRange.end - aRange.start !== bRange.end - bRange.start) return false
  for (let k = 0; k < aRange.end - aRange.start; k++) {
    if (a[aRange.start + k] !== b[bRange.start + k]) return false
  }
  return true
}

/**
 * Three-way line chunking. `base` is empty for add/add conflicts. Chunks are in file order.
 * `stats.coarse` turns true when the line diff's cost cap merged a region into one replacement.
 */
export function diff3(base: readonly string[], ours: readonly string[], theirs: readonly string[], stats?: DiffStats): MergeChunk[] {
  return groupHunks(diffLines(base, ours, stats), diffLines(base, theirs, stats)).map((g, id) => ({
    id,
    kind: !g.hasRight ? 'left-only'
      : !g.hasLeft ? 'right-only'
        : sameItems(ours, g.left, theirs, g.right) ? 'same-change' : 'conflict',
    base: g.base,
    left: g.left,
    right: g.right,
  }))
}

/** Word runs (letters, digits, `_`), `\r\n`, or any other single character. */
const TOKEN = /[\p{L}\p{N}_]+|\r\n|[^]/gu

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

function slice(lines: readonly string[], range: Range): string {
  return lines.slice(range.start, range.end).join('')
}

/**
 * Token-level three-way merge of a conflict chunk (tokens: word runs and single other characters).
 * Returns the merged text when no two token-level changes overlap or touch (identical changes are
 * fine), otherwise null. Non-conflict chunks and oversized chunks return null.
 */
export function simpleMerge(
  chunk: MergeChunk,
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): string | null {
  if (chunk.kind !== 'conflict') return null
  const b = tokenize(slice(base, chunk.base))
  const l = tokenize(slice(ours, chunk.left))
  const r = tokenize(slice(theirs, chunk.right))
  if (b.length + l.length + r.length > MAX_SIMPLE_TOKENS) return null
  const ids = new Map<string, number>()
  const intern = (t: string): number => {
    let id = ids.get(t)
    if (id === undefined) {
      id = ids.size
      ids.set(t, id)
    }
    return id
  }
  const bi = b.map(intern)
  const groups = groupHunks(diffSequences(bi, l.map(intern)), diffSequences(bi, r.map(intern)))
  let out = ''
  let pos = 0
  for (const g of groups) {
    out += b.slice(pos, g.base.start).join('')
    if (g.hasLeft && g.hasRight) {
      if (!sameItems(l, g.left, r, g.right)) return null
      out += l.slice(g.left.start, g.left.end).join('')
    } else if (g.hasLeft) {
      out += l.slice(g.left.start, g.left.end).join('')
    } else {
      out += r.slice(g.right.start, g.right.end).join('')
    }
    pos = g.base.end
  }
  return out + b.slice(pos).join('')
}

/** Whether a conflict chunk can be resolved automatically (see {@link simpleMerge}). */
export function isSimpleConflict(
  chunk: MergeChunk,
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): boolean {
  return simpleMerge(chunk, base, ours, theirs) !== null
}
