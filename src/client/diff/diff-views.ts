// Enhanced diff viewer helpers (plan b3b T4, design §9.2–9.4): side-by-side rows, word-level ranges,
// folding of long unchanged runs and change-block anchors for `n`/`p`. Pure; React-free.
import type { DiffLine } from '../../shared/protocol.ts'
import { diffSequences } from '../merge/line-diff.ts'

/** One side-by-side row: old on the left, new on the right; a missing side is padding. */
export interface SplitRow {
  /** Index of the left / right line in the hunk's `lines`. */
  leftIndex?: number
  rightIndex?: number
  left?: DiffLine
  right?: DiffLine
}

/** Context lines pair with themselves; each run of deletions pairs index-wise with the additions after it. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.type === 'context') {
      rows.push({ leftIndex: index, rightIndex: index, left: line, right: line })
      index += 1
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    while (lines[index]?.type === 'del') dels.push(index++)
    while (lines[index]?.type === 'add') adds.push(index++)
    for (let at = 0; at < Math.max(dels.length, adds.length); at += 1) {
      const row: SplitRow = {}
      const left = dels[at]
      const right = adds[at]
      if (left !== undefined) Object.assign(row, { leftIndex: left, left: lines[left] })
      if (right !== undefined) Object.assign(row, { rightIndex: right, right: lines[right] })
      rows.push(row)
    }
  }
  return rows
}

/** Character ranges `[start, end)` changed on each side of a line pair. */
export interface WordRanges {
  old: [number, number][]
  new: [number, number][]
}

/** Above this share of changed characters a line counts as rewritten: no word marks. */
const WHOLE_LINE_RATIO = 0.6
const TOKEN = /\p{L}+|\p{N}+|\s+|[^\p{L}\p{N}\s]/gu

function tokens(text: string): { text: string; start: number }[] {
  return [...text.matchAll(TOKEN)].map(match => ({ text: match[0], start: match.index }))
}

/** Changed words between two versions of a line, or null for identical / mostly rewritten lines. */
export function wordDiff(oldText: string, newText: string): WordRanges | null {
  if (oldText === newText) return null
  const a = tokens(oldText)
  const b = tokens(newText)
  const ids = new Map<string, number>()
  const intern = (token: { text: string }): number => {
    let id = ids.get(token.text)
    if (id === undefined) {
      id = ids.size
      ids.set(token.text, id)
    }
    return id
  }
  const ops = diffSequences(a.map(intern), b.map(intern))
  const ranges: WordRanges = { old: [], new: [] }
  let changed = 0
  const span = (list: { text: string; start: number }[], from: number, to: number): [number, number] | null => {
    const first = list[from]
    const last = list[to - 1]
    if (first === undefined || last === undefined) return null
    return [first.start, last.start + last.text.length]
  }
  for (const op of ops) {
    const left = span(a, op.aStart, op.aEnd)
    const right = span(b, op.bStart, op.bEnd)
    if (left !== null) {
      ranges.old.push(left)
      changed += left[1] - left[0]
    }
    if (right !== null) {
      ranges.new.push(right)
      changed += right[1] - right[0]
    }
  }
  if (changed / Math.max(1, oldText.length + newText.length) > WHOLE_LINE_RATIO) return null
  return ranges.old.length === 0 && ranges.new.length === 0 ? null : ranges
}

/** Word ranges per line index for the unified view: the i-th deletion and i-th addition of each run. */
export function pairChanges(lines: readonly DiffLine[]): Map<number, [number, number][]> {
  const result = new Map<number, [number, number][]>()
  for (const row of splitRows(lines)) {
    if (row.left === undefined || row.right === undefined || row.left === row.right) continue
    const ranges = wordDiff(row.left.text, row.right.text)
    if (ranges === null || row.leftIndex === undefined || row.rightIndex === undefined) continue
    result.set(row.leftIndex, ranges.old)
    result.set(row.rightIndex, ranges.new)
  }
  return result
}

/** A visible run of lines `[start, end)`, or a folded run of `count` context lines from `start`. */
export type FoldSegment = { kind: 'lines'; start: number; end: number } | { kind: 'fold'; start: number; count: number }

/**
 * Fold context runs longer than `minRun`, keeping `keep` lines next to each change; `expanded` holds
 * the start index of folds the user opened.
 */
export function foldContext(lines: readonly DiffLine[], expanded: ReadonlySet<number>, minRun = 8, keep = 3): FoldSegment[] {
  const segments: FoldSegment[] = []
  const pushLines = (start: number, end: number): void => {
    if (end <= start) return
    const last = segments.at(-1)
    if (last?.kind === 'lines' && last.end === start) last.end = end
    else segments.push({ kind: 'lines', start, end })
  }
  let index = 0
  while (index < lines.length) {
    if (lines[index]?.type !== 'context') {
      pushLines(index, index + 1)
      index += 1
      continue
    }
    const start = index
    while (lines[index]?.type === 'context') index += 1
    const end = index
    const head = start === 0 ? 0 : keep
    const tail = end === lines.length ? 0 : keep
    const foldStart = start + head
    const foldEnd = end - tail
    if (end - start > minRun && foldEnd > foldStart && !expanded.has(foldStart)) {
      pushLines(start, foldStart)
      segments.push({ kind: 'fold', start: foldStart, count: foldEnd - foldStart })
      pushLines(foldEnd, end)
    } else {
      pushLines(start, end)
    }
  }
  return segments
}

/** Index of the first line of every change block (for `n` / `p`). */
export function changeAnchors(lines: readonly DiffLine[]): number[] {
  const anchors: number[] = []
  lines.forEach((line, index) => {
    if (line.type !== 'context' && lines[index - 1]?.type !== 'del' && lines[index - 1]?.type !== 'add') anchors.push(index)
  })
  return anchors
}
