// Three-way merge model: immutable values + pure functions. No React, no CodeMirror.
//
// The Result starts from base (owner confirmation 3): every change, conflicting or not, is a pending
// chunk until the user accepts, ignores or edits it.
//
// Chunk state machine. `state` says what text the chunk currently holds in the Result; `leftDone` /
// `rightDone` say whether that side's change has been taken into account (applied or explicitly
// ignored). A side without a change in the chunk (the right side of a `left-only` chunk) starts done.
//
//   state               Result text of the chunk
//   pending             base
//   ignored             base (at least one side ignored, nothing applied)
//   left / right        that side
//   both-left-first     left + right   (second side appended after the first)
//   both-right-first    right + left
//   edited              user-owned text; see below
//
// - accept(side): if the other side's text is in place (state = other) → append (both-*-first);
//   otherwise replace with the side's text. Marks the side done. `same-change` marks both done.
// - ignore(side): marks the side done; `pending` becomes `ignored`; text unchanged.
// - appendBoth(order): only while neither side is done; inserts both in order, both done.
// - resolveWhole(side) (Ctrl/Cmd+click): replaces with the side's text and marks both done.
// - Manual edits touching a chunk make it `edited` and clear both flags. `resolveSimple` also uses
//   `edited` but sets both flags, so `edited` + both done means "auto-resolved by resolveSimple".
//   Edited chunks are resolved and ignore every chunk action and batch action (AC5); only
//   acceptFile / revert (whole-file) and undo (store history) change them.
//
// A chunk is resolved when it is `edited` or both sides are done. `counts` reports conflict chunks only.
import {
  MERGE_CHUNK_STATES,
  MERGE_DRAFT_VERSION,
  validDraftChunkRange,
  type MergeChunkState,
  type MergeDraft,
  type MergeDraftChunk,
  type MergeStageShas,
} from '../../shared/protocol.ts'
import { diff3, simpleMerge, type MergeChunk, type Range } from './diff3.ts'
import { diffLines, splitLines, type DiffOp } from './line-diff.ts'

export type { MergeChunk, MergeChunkKind, Range } from './diff3.ts'

/** Left = ours (`:2:`), right = theirs (`:3:`). */
export type MergeSideName = 'left' | 'right'

/** The three texts of a text conflict. `null` (missing side, e.g. no base for add/add) is treated as empty. */
export interface MergeTexts {
  base: string | null
  ours: string | null
  theirs: string | null
}

/** A chunk with its current decision and its line range in the Result. */
export interface ModelChunk extends MergeChunk {
  state: MergeChunkState
  leftDone: boolean
  rightDone: boolean
  /** Current half-open line range of this chunk in {@link MergeModel.resultLines}. */
  resultRange: Range
}

/** Immutable merge state. Every action returns a new model (or the same one when nothing changes). */
export interface MergeModel {
  readonly baseLines: readonly string[]
  readonly leftLines: readonly string[]
  readonly rightLines: readonly string[]
  readonly chunks: readonly ModelChunk[]
  /** Result split with {@link splitLines}; only the last line may lack a terminator. */
  readonly resultLines: readonly string[]
  /** `resultLines.join('')`. */
  readonly result: string
  /** Line terminator used when two texts must be joined on separate lines. */
  readonly eol: string
  /** Memo shared by all versions of the model (the three sides never change). */
  readonly memo: { simple: Map<number, string | null> }
  /**
   * The line diff hit its cost cap (very large, very different files): some region became one coarse
   * replacement chunk. The window says so (controller ruling 15).
   */
  readonly coarse: boolean
}

interface ChunkUpdate {
  state: MergeChunkState
  leftDone: boolean
  rightDone: boolean
  /** New Result text of the chunk; omitted keeps the current lines. */
  text?: string
}

function sideChanged(chunk: MergeChunk, side: MergeSideName): boolean {
  if (chunk.kind === 'left-only') return side === 'left'
  if (chunk.kind === 'right-only') return side === 'right'
  return true
}

function detectEol(...texts: string[]): string {
  for (const text of texts) {
    const nl = text.indexOf('\n')
    if (nl !== -1) return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n'
  }
  return '\n'
}

/** Joins two texts so the second starts on its own line. */
function joinTexts(first: string, second: string, eol: string): string {
  if (first !== '' && second !== '' && !first.endsWith('\n')) return first + eol + second
  return first + second
}

function linesOf(lines: readonly string[], range: Range): string {
  return lines.slice(range.start, range.end).join('')
}

/** Text of one version of a chunk: `base`, `left` (ours) or `right` (theirs). */
export function chunkText(model: MergeModel, chunk: MergeChunk, version: 'base' | MergeSideName): string {
  if (version === 'base') return linesOf(model.baseLines, chunk.base)
  if (version === 'left') return linesOf(model.leftLines, chunk.left)
  return linesOf(model.rightLines, chunk.right)
}

/** Text the chunk holds for a given state. For `edited` this is only a hint (used to realign drafts). */
function stateText(model: MergeModel, chunk: ModelChunk, state: MergeChunkState, leftDone: boolean, rightDone: boolean): string {
  switch (state) {
    case 'left': return chunkText(model, chunk, 'left')
    case 'right': return chunkText(model, chunk, 'right')
    case 'both-left-first': return joinTexts(chunkText(model, chunk, 'left'), chunkText(model, chunk, 'right'), model.eol)
    case 'both-right-first': return joinTexts(chunkText(model, chunk, 'right'), chunkText(model, chunk, 'left'), model.eol)
    case 'edited': return (leftDone && rightDone ? simpleResult(model, chunk.id) : null) ?? chunkText(model, chunk, 'base')
    default: return chunkText(model, chunk, 'base')
  }
}

/** Rebuilds the Result in one pass, replacing the text of updated chunks and shifting the rest. */
function rebuild(model: MergeModel, updates: ReadonlyMap<number, ChunkUpdate>): MergeModel {
  if (updates.size === 0) return model
  const lines: string[] = []
  const chunks: ModelChunk[] = []
  let pos = 0
  for (const chunk of model.chunks) {
    for (let i = pos; i < chunk.resultRange.start; i++) lines.push(model.resultLines[i]!)
    const update = updates.get(chunk.id)
    const start = lines.length
    if (update?.text !== undefined) lines.push(...splitLines(update.text))
    else for (let i = chunk.resultRange.start; i < chunk.resultRange.end; i++) lines.push(model.resultLines[i]!)
    pos = chunk.resultRange.end
    chunks.push(update
      ? { ...chunk, state: update.state, leftDone: update.leftDone, rightDone: update.rightDone, resultRange: { start, end: lines.length } }
      : { ...chunk, resultRange: { start, end: lines.length } })
  }
  for (let i = pos; i < model.resultLines.length; i++) lines.push(model.resultLines[i]!)
  // A side's last line may lack a terminator; keep the invariant that only the final Result line can.
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]!.endsWith('\n')) lines[i] += model.eol
  }
  return { ...model, chunks, resultLines: lines, result: lines.join('') }
}

function update(model: MergeModel, id: number, change: ChunkUpdate): MergeModel {
  return rebuild(model, new Map([[id, change]]))
}

function initialChunk(chunk: MergeChunk, resultRange: Range): ModelChunk {
  return {
    ...chunk,
    state: 'pending',
    leftDone: !sideChanged(chunk, 'left'),
    rightDone: !sideChanged(chunk, 'right'),
    resultRange,
  }
}

function baseModel(texts: MergeTexts): MergeModel {
  const base = texts.base ?? ''
  const ours = texts.ours ?? ''
  const theirs = texts.theirs ?? ''
  const baseLines = splitLines(base)
  const leftLines = splitLines(ours)
  const rightLines = splitLines(theirs)
  const stats = { coarse: false }
  const chunks = diff3(baseLines, leftLines, rightLines, stats).map((c) => initialChunk(c, { ...c.base }))
  return {
    baseLines,
    leftLines,
    rightLines,
    chunks,
    resultLines: baseLines,
    result: base,
    eol: detectEol(ours, theirs, base),
    memo: { simple: new Map() },
    coarse: stats.coarse,
  }
}

/**
 * Builds the model for a text conflict. Without a draft the Result is the base text and every chunk
 * is pending. With a draft, returns null when the draft does not fit (unknown version, chunk count
 * differs from the current diff3, unknown state); the caller then starts fresh. The caller is
 * responsible for checking `draft.stages` against the current index (Host reports `draftStale`).
 */
export function createModel(texts: MergeTexts): MergeModel
export function createModel(texts: MergeTexts, draft: MergeDraft): MergeModel | null
export function createModel(texts: MergeTexts, draft?: MergeDraft): MergeModel | null {
  const model = baseModel(texts)
  return draft ? restore(model, draft) : model
}

/** Returns to the initial state (Result = base, every chunk pending). */
export function revert(model: MergeModel): MergeModel {
  return {
    ...model,
    chunks: model.chunks.map((c) => initialChunk(c, { ...c.base })),
    resultLines: model.baseLines,
    result: model.baseLines.join(''),
  }
}

/** Resolved: `edited`, or both sides done. */
export function isChunkResolved(chunk: ModelChunk): boolean {
  return chunk.state === 'edited' || (chunk.leftDone && chunk.rightDone)
}

/** Manually edited (as opposed to auto-resolved by {@link resolveSimple}). */
export function isManuallyEdited(chunk: ModelChunk): boolean {
  return chunk.state === 'edited' && !(chunk.leftDone && chunk.rightDone)
}

function doneKey(side: MergeSideName): 'leftDone' | 'rightDone' {
  return side === 'left' ? 'leftDone' : 'rightDone'
}

function other(side: MergeSideName): MergeSideName {
  return side === 'left' ? 'right' : 'left'
}

function acceptUpdate(model: MergeModel, chunk: ModelChunk, side: MergeSideName): ChunkUpdate | null {
  if (chunk.state === 'edited' || chunk[doneKey(side)]) return null
  if (chunk.kind === 'same-change') return { state: side, leftDone: true, rightDone: true, text: chunkText(model, chunk, side) }
  const done = { leftDone: chunk.leftDone, rightDone: chunk.rightDone, [doneKey(side)]: true }
  if (chunk.state === other(side)) {
    const state: MergeChunkState = side === 'left' ? 'both-right-first' : 'both-left-first'
    return { state, ...done, text: stateText(model, chunk, state, true, true) }
  }
  return { state: side, ...done, text: chunkText(model, chunk, side) }
}

function chunkById(model: MergeModel, id: number): ModelChunk | undefined {
  return model.chunks[id]
}

/** Applies one side of a chunk (arrow button). Appends after the other side if that one is already applied. */
export function acceptSide(model: MergeModel, id: number, side: MergeSideName): MergeModel {
  const chunk = chunkById(model, id)
  const change = chunk && acceptUpdate(model, chunk, side)
  return change ? update(model, id, change) : model
}

/** {@link acceptSide} for the left (ours) side. */
export function acceptLeft(model: MergeModel, id: number): MergeModel {
  return acceptSide(model, id, 'left')
}

/** {@link acceptSide} for the right (theirs) side. */
export function acceptRight(model: MergeModel, id: number): MergeModel {
  return acceptSide(model, id, 'right')
}

/** Marks one side of a chunk as handled without applying it (× button). */
export function ignore(model: MergeModel, id: number, side: MergeSideName): MergeModel {
  const chunk = chunkById(model, id)
  if (!chunk || chunk.state === 'edited' || chunk[doneKey(side)]) return model
  const state = chunk.state === 'pending' ? 'ignored' : chunk.state
  if (chunk.kind === 'same-change') return update(model, id, { state, leftDone: true, rightDone: true })
  return update(model, id, { state, leftDone: chunk.leftDone, rightDone: chunk.rightDone, [doneKey(side)]: true })
}

/** Inserts both sides of an undecided conflict chunk in the given order. */
export function appendBoth(model: MergeModel, id: number, order: 'left-first' | 'right-first'): MergeModel {
  const chunk = chunkById(model, id)
  if (!chunk || chunk.kind !== 'conflict' || chunk.state === 'edited' || chunk.leftDone || chunk.rightDone) return model
  const state: MergeChunkState = order === 'left-first' ? 'both-left-first' : 'both-right-first'
  return update(model, id, { state, leftDone: true, rightDone: true, text: stateText(model, chunk, state, true, true) })
}

/** Ctrl/Cmd+click on a side's arrow: the chunk becomes exactly that side and the other side is ignored. */
export function resolveWhole(model: MergeModel, id: number, side: MergeSideName): MergeModel {
  const chunk = chunkById(model, id)
  if (!chunk || chunk.state === 'edited' || !sideChanged(chunk, side) || isChunkResolved(chunk)) return model
  return update(model, id, { state: side, leftDone: true, rightDone: true, text: chunkText(model, chunk, side) })
}

/** Applies every undecided non-conflict chunk of the chosen side(s); conflicts and edited chunks are untouched. */
export function applyNonConflicting(model: MergeModel, which: MergeSideName | 'all'): MergeModel {
  const updates = new Map<number, ChunkUpdate>()
  for (const chunk of model.chunks) {
    if (chunk.kind === 'conflict') continue
    const side: MergeSideName = chunk.kind === 'right-only' ? 'right' : 'left'
    if (chunk.kind !== 'same-change' && which !== 'all' && which !== side) continue
    const change = acceptUpdate(model, chunk, side)
    if (change) updates.set(chunk.id, change)
  }
  return rebuild(model, updates)
}

/** Token-level merge text of a conflict chunk, or null when it is not a simple conflict (memoized). */
export function simpleResult(model: MergeModel, id: number): string | null {
  const memo = model.memo.simple
  if (memo.has(id)) return memo.get(id) ?? null
  const chunk = chunkById(model, id)
  const text = chunk ? simpleMerge(chunk, model.baseLines, model.leftLines, model.rightLines) : null
  memo.set(id, text)
  return text
}

/**
 * Resolves every undecided (pending, neither side done) simple conflict with its token-level merge.
 * Such chunks become `edited` with both sides done. Returns how many chunks were resolved.
 */
export function resolveSimple(model: MergeModel): { model: MergeModel; resolved: number } {
  const updates = new Map<number, ChunkUpdate>()
  for (const chunk of model.chunks) {
    if (chunk.kind !== 'conflict' || chunk.state !== 'pending' || chunk.leftDone || chunk.rightDone) continue
    const text = simpleResult(model, chunk.id)
    if (text !== null) updates.set(chunk.id, { state: 'edited', leftDone: true, rightDone: true, text })
  }
  return { model: rebuild(model, updates), resolved: updates.size }
}

/** Whole-file accept: the Result becomes that side's full text; every chunk is resolved. */
export function acceptFile(model: MergeModel, side: MergeSideName): MergeModel {
  const lines = side === 'left' ? model.leftLines : model.rightLines
  return {
    ...model,
    chunks: model.chunks.map((c) => ({
      ...c,
      state: sideChanged(c, side) ? side : 'ignored',
      leftDone: true,
      rightDone: true,
      resultRange: { ...c[side] },
    })),
    resultLines: lines,
    result: lines.join(''),
  }
}

/**
 * The Result is `text` (a resolved file whose worktree content no replay explains) and every chunk is
 * manually `edited`: the first chunk covers the whole Result, the others sit empty at its end.
 */
export function editedModel(model: MergeModel, text: string): MergeModel {
  const lines = splitLines(text)
  const end = lines.length
  return {
    ...model,
    chunks: model.chunks.map((c, i) => ({
      ...c,
      state: 'edited',
      leftDone: false,
      rightDone: false,
      resultRange: i === 0 ? { start: 0, end } : { start: end, end },
    })),
    resultLines: lines,
    result: text,
  }
}

/** Replays the automatic steps: `applyNonConflicting('all')` then `resolveSimple()` (deterministic). */
export function autoMerge(texts: MergeTexts): MergeModel {
  return resolveSimple(applyNonConflicting(createModel(texts), 'all')).model
}

/**
 * Applies a manual Result edit (character offsets into {@link MergeModel.result}, like a CodeMirror
 * change). Chunk ranges are remapped; chunks the edit touches become `edited`.
 *
 * Touch rules (line level): an edit replacing lines `[es, ee)` touches a non-empty chunk it overlaps;
 * a pure line insertion (`es === ee`) touches a non-empty chunk only strictly inside it, so pressing
 * Enter at a chunk boundary just shifts the chunk; an empty chunk (pending insertion) is touched only
 * by an edit whose replaced lines strictly contain its position — a pure line insertion at its
 * position shifts it like any other chunk. A touched chunk grows to cover the edited lines;
 * when one edit spans several chunks, the first keeps the shared lines (ranges stay ordered).
 */
export function applyEdit(model: MergeModel, from: number, to: number, insert: string): MergeModel {
  if (from === to && insert === '') return model
  const old = model.result
  const text = old.slice(0, from) + insert + old.slice(to)
  const oldLines = model.resultLines
  const newLines = splitLines(text)

  // Lines entirely before `from` (terminator included) and entirely after `to` are unchanged.
  let p = 0
  let offset = 0
  while (p < oldLines.length) {
    const line = oldLines[p]!
    if (offset + line.length > from || !line.endsWith('\n')) break
    offset += line.length
    p++
  }
  const lineStartStays = insert.endsWith('\n') || (insert === '' && (from === 0 || old[from - 1] === '\n'))
  let s = 0
  let end = old.length
  for (let i = oldLines.length - 1; i >= p; i--) {
    const start = end - oldLines[i]!.length
    if (start > to || (start === to && lineStartStays)) s++
    else break
    end = start
  }
  const es = p
  const ee = oldLines.length - s
  const ne = newLines.length - s
  const d = ne - ee

  const touches = (r: Range): boolean => {
    if (r.start === r.end) return es < r.start && r.start < ee
    if (es === ee) return r.start < es && es < r.end
    return es < r.end && ee > r.start
  }
  let floor = 0
  const chunks = model.chunks.map((chunk) => {
    const r = chunk.resultRange
    let next: ModelChunk
    if (touches(r)) {
      next = {
        ...chunk,
        state: 'edited',
        leftDone: false,
        rightDone: false,
        resultRange: { start: Math.min(r.start, es), end: r.end > ee ? r.end + d : ne },
      }
    } else if (r.end < es || (r.end === es && !(r.start === r.end && es === ee))) {
      // Before the edit. An empty chunk sitting exactly where whole lines are inserted moves below them.
      next = chunk
    } else {
      next = { ...chunk, resultRange: { start: r.start + d, end: r.end + d } }
    }
    const start = Math.max(next.resultRange.start, floor)
    const endLine = Math.max(next.resultRange.end, start)
    floor = endLine
    if (start !== next.resultRange.start || endLine !== next.resultRange.end) next = { ...next, resultRange: { start, end: endLine } }
    return next
  })
  return { ...model, chunks, resultLines: newLines, result: text }
}

/** Resolved / total over conflict chunks only (what the conflict list and the window header show). */
export function counts(model: MergeModel): { resolved: number; total: number } {
  let resolved = 0
  let total = 0
  for (const chunk of model.chunks) {
    if (chunk.kind !== 'conflict') continue
    total++
    if (isChunkResolved(chunk)) resolved++
  }
  return { resolved, total }
}

/** Every chunk (conflict or not) is resolved; non-conflict changes left pending would be lost on apply. */
export function allResolved(model: MergeModel): boolean {
  return model.chunks.every(isChunkResolved)
}

/**
 * Id of the next (or previous) unresolved chunk of any kind after (before) `fromChunk`; `null` starts
 * from the beginning (end). Returns null at the end of the file (no wrap; F7 then offers the next file).
 */
export function nextUnresolved(model: MergeModel, fromChunk: number | null, dir: 'next' | 'prev'): number | null {
  const n = model.chunks.length
  if (dir === 'next') {
    for (let i = fromChunk === null ? 0 : fromChunk + 1; i < n; i++) {
      if (!isChunkResolved(model.chunks[i]!)) return i
    }
  } else {
    for (let i = fromChunk === null ? n - 1 : fromChunk - 1; i >= 0; i--) {
      if (!isChunkResolved(model.chunks[i]!)) return i
    }
  }
  return null
}

/** Serializes the model for `mergeDraftSave`. `savedAt` defaults to now. */
export function toDraft(model: MergeModel, stages: MergeStageShas, savedAt: string = new Date().toISOString()): MergeDraft {
  return {
    version: MERGE_DRAFT_VERSION,
    stages,
    result: model.result,
    chunks: model.chunks.map((c) => ({
      state: c.state,
      leftDone: c.leftDone,
      rightDone: c.rightDone,
      resultStart: c.resultRange.start,
      resultEnd: c.resultRange.end,
    })),
    savedAt,
  }
}

/**
 * Maps a template line position through `ops` (template → result). `include` decides whether a pure
 * insertion exactly at the position belongs to the range (start: before it; end: after it).
 */
function mapPoint(ops: readonly DiffOp[], p: number, isStart: boolean, include: boolean): number {
  let delta = 0
  for (const op of ops) {
    if (op.aEnd < p || (op.aEnd === p && op.aStart < p)) {
      delta = op.bEnd - op.aEnd
      continue
    }
    if (op.aStart > p) break
    if (op.aStart < p) return isStart ? op.bStart : op.bEnd
    if (op.aEnd === p) return isStart === include ? op.bStart : op.bEnd
    return op.bStart
  }
  return p + delta
}

/**
 * Whether a saved chunk decision is reachable for this chunk (state machine above): one-sided chunks
 * keep their unchanged side done; `pending` has decided nothing; `ignored` decided something without
 * applying; a side state needs that side changed and done; `both-*` and auto-resolved `edited` exist
 * only for conflicts and need both sides done; manual `edited` has both flags cleared.
 */
function consistent(chunk: MergeChunk, saved: MergeDraftChunk): boolean {
  const { state, leftDone, rightDone } = saved
  const leftChanged = sideChanged(chunk, 'left')
  const rightChanged = sideChanged(chunk, 'right')
  if (state === 'edited') return (!leftDone && !rightDone) || (leftDone && rightDone && chunk.kind === 'conflict')
  if ((!leftChanged && !leftDone) || (!rightChanged && !rightDone)) return false
  const both = leftDone && rightDone
  switch (state) {
    case 'pending': return leftDone === !leftChanged && rightDone === !rightChanged
    case 'ignored': return chunk.kind === 'same-change' ? both : (leftChanged && leftDone) || (rightChanged && rightDone)
    case 'left': return leftChanged && leftDone && (chunk.kind !== 'same-change' || both)
    case 'right': return rightChanged && rightDone && (chunk.kind !== 'same-change' || both)
    default: return chunk.kind === 'conflict' && both
  }
}

/** Saved text matches the state text (allowing the terminator `rebuild` adds to a side's last line). */
function holdsStateText(actual: string, expected: string, eol: string): boolean {
  return actual === expected || (expected !== '' && !expected.endsWith('\n') && actual === expected + eol)
}

/**
 * Restores chunk states and Result from a draft (null when it does not fit this merge).
 *
 * Drafts written by {@link toDraft} carry each chunk's Result line range; they are used as is after
 * validation (ordered, non-overlapping, inside the Result, and every non-edited chunk's lines hold
 * its state text). Older drafts without ranges fall back to aligning the Result with a template
 * (base gaps + each chunk's state text) using the line diff, which is exact whenever text outside
 * edited chunks was not changed by hand.
 */
function restore(fresh: MergeModel, draft: MergeDraft): MergeModel | null {
  if (draft.version !== MERGE_DRAFT_VERSION || draft.chunks.length !== fresh.chunks.length) return null
  const valid = new Set<string>(MERGE_CHUNK_STATES)
  const savedChunks = draft.chunks
  if (!savedChunks.every((c, i) =>
    valid.has(c.state) && typeof c.leftDone === 'boolean' && typeof c.rightDone === 'boolean'
    && validDraftChunkRange(c) && consistent(fresh.chunks[i]!, c))) return null

  const resultLines = splitLines(draft.result)
  const withState = (chunk: ModelChunk, saved: MergeDraftChunk, resultRange: Range): ModelChunk =>
    ({ ...chunk, state: saved.state, leftDone: saved.leftDone, rightDone: saved.rightDone, resultRange })

  const ranged = savedChunks.filter((c) => c.resultStart !== undefined).length
  if (ranged > 0) {
    if (ranged !== savedChunks.length) return null
    let floor = 0
    const chunks: ModelChunk[] = []
    for (let i = 0; i < fresh.chunks.length; i++) {
      const saved = savedChunks[i]!
      const range = { start: saved.resultStart!, end: saved.resultEnd! }
      if (range.start < floor || range.end > resultLines.length) return null
      floor = range.end
      const chunk = withState(fresh.chunks[i]!, saved, range)
      if (chunk.state !== 'edited') {
        const text = resultLines.slice(range.start, range.end).join('')
        if (!holdsStateText(text, stateText(fresh, chunk, chunk.state, chunk.leftDone, chunk.rightDone), fresh.eol)) return null
      }
      chunks.push(chunk)
    }
    return { ...fresh, chunks, resultLines, result: draft.result }
  }

  const template: string[] = []
  const templateRanges: Range[] = []
  let pos = 0
  fresh.chunks.forEach((chunk, i) => {
    const saved = savedChunks[i]!
    for (let k = pos; k < chunk.base.start; k++) template.push(fresh.baseLines[k]!)
    const start = template.length
    template.push(...splitLines(stateText(fresh, chunk, saved.state, saved.leftDone, saved.rightDone)))
    templateRanges.push({ start, end: template.length })
    pos = chunk.base.end
  })
  for (let k = pos; k < fresh.baseLines.length; k++) template.push(fresh.baseLines[k]!)

  const ops = diffLines(template, resultLines)
  let floor = 0
  const chunks = fresh.chunks.map((chunk, i): ModelChunk => {
    const saved = savedChunks[i]!
    const tr = templateRanges[i]!
    const include = saved.state === 'edited'
    const start = Math.max(mapPoint(ops, tr.start, true, include), floor)
    const end = Math.max(mapPoint(ops, tr.end, false, include), start)
    floor = end
    return withState(chunk, saved, { start, end })
  })
  return { ...fresh, chunks, resultLines, result: draft.result }
}
