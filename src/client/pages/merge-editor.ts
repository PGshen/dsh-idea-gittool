// B1 T6 CodeMirror adapter of the three-pane merge window (design §10.3).
// Pure parts (unit-tested without a DOM): Result sync and edit extraction, chunk colouring, gutter
// buttons, the line mapping that drives synchronized scrolling, the scroll lock.
// DOM parts (`createMergePane`, `topLine`, `scrollToLine`, `revealLine`) stay thin; they are checked
// in the real browser (plan T8).
//
// Controller ruling 11: undo/redo belong to the merge store, so CodeMirror's history extension is not
// used. Every document change the window dispatches from the model carries MODEL_CHANGE and is never
// reported back as a user edit.
import { Annotation, Compartment, EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import type { ChangeSet, Extension, Transaction, TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, gutter, keymap, lineNumbers } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { isChunkResolved, isManuallyEdited } from '../merge/merge-model.ts'
import type { MergeModel, MergeSideName, ModelChunk, Range } from '../merge/merge-model.ts'
import type { MergeAction } from '../store/merge-store.ts'

export type MergePane = 'left' | 'result' | 'right'

/** Marks a transaction the window dispatched to follow the model (not a user edit). */
export const MODEL_CHANGE = Annotation.define<boolean>()

/** A replacement in Result character offsets (what `MergeStore.edit` takes). */
export interface TextEdit {
  from: number
  to: number
  insert: string
}

/** Smallest single replacement turning `current` into `next` (common prefix and suffix kept). */
export function docSyncChange(current: string, next: string): TextEdit | null {
  if (current === next) return null
  const max = Math.min(current.length, next.length)
  let start = 0
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++
  let endA = current.length
  let endB = next.length
  while (endA > start && endB > start && current.charCodeAt(endA - 1) === next.charCodeAt(endB - 1)) {
    endA--
    endB--
  }
  return { from: start, to: endA, insert: next.slice(start, endB) }
}

/** Transaction spec that brings the editor to `next`, marked as model-driven; null when equal. */
export function syncSpec(state: EditorState, next: string): TransactionSpec | null {
  const change = docSyncChange(state.doc.toString(), next)
  if (change === null) return null
  return { changes: change, annotations: MODEL_CHANGE.of(true) }
}

/** Changes of one transaction as edits to apply one after another (positions after earlier ones). */
export function editsOfChanges(changes: ChangeSet): TextEdit[] {
  const edits: TextEdit[] = []
  changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    edits.push({ from: fromB, to: fromB + (toA - fromA), insert: inserted.toString() })
  })
  return edits
}

/** User edits of a transaction; model-driven and non-document transactions yield none. */
export function userEdits(tr: Transaction): TextEdit[] {
  if (!tr.docChanged || tr.annotation(MODEL_CHANGE) === true) return []
  return editsOfChanges(tr.changes)
}

export { resultEditable } from './merge-pane-state.ts'

/** Extensions that lock (read-only, not editable) or unlock the Result editor. */
export function resultLock(editable: boolean): Extension {
  return editable ? [] : [EditorState.readOnly.of(true), EditorView.editable.of(false)]
}

/**
 * Runs `apply` with the latest arguments. While `busy()` (CodeMirror is inside an update) the call is
 * deferred once; the deferred run uses the arguments of the most recent call, so it never replays an
 * older model over a newer one.
 */
export function createCoalescedUpdate<T>(
  apply: (args: T) => void,
  busy: () => boolean,
  schedule: (callback: () => void) => void = queueMicrotask,
): (args: T) => void {
  let latest: { args: T } | null = null
  let pending = false
  const run = (args: T): void => {
    latest = { args }
    if (busy()) {
      if (!pending) {
        pending = true
        schedule(() => {
          pending = false
          if (latest !== null) run(latest.args)
        })
      }
      return
    }
    apply(args)
  }
  return run
}

// ---------------------------------------------------------------------------
// Chunk colouring
// ---------------------------------------------------------------------------

/** conflict / change = still to decide; resolved = decided; edited = user text in the Result. */
export type ChunkTone = 'conflict' | 'change' | 'resolved' | 'edited'

export interface ChunkMark {
  id: number
  /** Half-open 0-based line range in the pane. */
  from: number
  to: number
  tone: ChunkTone
  current: boolean
}

function changedOn(chunk: ModelChunk, side: MergeSideName): boolean {
  return side === 'left' ? chunk.kind !== 'right-only' : chunk.kind !== 'left-only'
}

function rangeIn(chunk: ModelChunk, pane: MergePane): Range {
  return pane === 'result' ? chunk.resultRange : chunk[pane]
}

/** Coloured chunk ranges of one pane; a side pane only shows chunks that changed on that side. */
export function chunkMarks(model: MergeModel, pane: MergePane, current: number | null): ChunkMark[] {
  const marks: ChunkMark[] = []
  for (const chunk of model.chunks) {
    let tone: ChunkTone
    if (pane === 'result') {
      if (chunk.state === 'edited') tone = isManuallyEdited(chunk) ? 'edited' : 'resolved'
      else if (isChunkResolved(chunk)) tone = 'resolved'
      else tone = chunk.kind === 'conflict' ? 'conflict' : 'change'
    } else {
      if (!changedOn(chunk, pane)) continue
      const done = pane === 'left' ? chunk.leftDone : chunk.rightDone
      if (chunk.state === 'edited' || done) tone = 'resolved'
      else tone = chunk.kind === 'conflict' ? 'conflict' : 'change'
    }
    const range = rangeIn(chunk, pane)
    marks.push({ id: chunk.id, from: range.start, to: range.end, tone, current: chunk.id === current })
  }
  return marks
}

/** Where a line sits in its chunk; an empty range marks the insertion point before / after a line. */
export type LineEdge = 'first' | 'middle' | 'last' | 'single' | 'gapBefore' | 'gapAfter'

export interface LineClass {
  /** 1-based editor line. */
  line: number
  tone: ChunkTone
  current: boolean
  edge: LineEdge
}

/** Editor lines to decorate for `marks` in a document of `lineCount` lines (sorted by line). */
export function lineClasses(marks: readonly ChunkMark[], lineCount: number): LineClass[] {
  const lines: LineClass[] = []
  if (lineCount === 0) return lines
  for (const mark of marks) {
    const { tone, current } = mark
    if (mark.from === mark.to) {
      lines.push(mark.from < lineCount
        ? { line: mark.from + 1, tone, current, edge: 'gapBefore' }
        : { line: lineCount, tone, current, edge: 'gapAfter' })
      continue
    }
    const end = Math.min(mark.to, lineCount)
    for (let index = mark.from; index < end; index++) {
      const edge: LineEdge = mark.to - mark.from === 1
        ? 'single'
        : index === mark.from ? 'first' : index === mark.to - 1 ? 'last' : 'middle'
      lines.push({ line: index + 1, tone, current, edge })
    }
  }
  return lines.sort((a, b) => a.line - b.line)
}

// ---------------------------------------------------------------------------
// Gutter buttons (side panes)
// ---------------------------------------------------------------------------

export interface GutterChunk {
  id: number
  side: MergeSideName
  conflict: boolean
}

export interface GutterLine {
  /** 0-based line of the pane where the buttons sit (the chunk's first line). */
  line: number
  chunks: GutterChunk[]
}

/** Accept / ignore buttons of a side pane: chunks that changed on this side and are still open there. */
export function gutterActions(model: MergeModel, pane: MergePane): GutterLine[] {
  if (pane === 'result') return []
  const byLine = new Map<number, GutterChunk[]>()
  for (const chunk of model.chunks) {
    if (!changedOn(chunk, pane) || chunk.state === 'edited') continue
    if (pane === 'left' ? chunk.leftDone : chunk.rightDone) continue
    const line = chunk[pane].start
    const list = byLine.get(line) ?? []
    list.push({ id: chunk.id, side: pane, conflict: chunk.kind === 'conflict' })
    byLine.set(line, list)
  }
  return [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([line, chunks]) => ({ line, chunks }))
}

/** The store action of a gutter button; Ctrl/Cmd+click on accept resolves the whole chunk with it. */
export function gutterAction(kind: 'accept' | 'ignore', id: number, side: MergeSideName, modifier: boolean): MergeAction {
  if (kind === 'ignore') return { type: 'ignore', id, side }
  return modifier ? { type: 'resolveWhole', id, side } : { type: 'accept', id, side }
}

// ---------------------------------------------------------------------------
// Synchronized scrolling
// ---------------------------------------------------------------------------

/**
 * Maps a (fractional, 0-based) line of one pane to another with the chunks as anchors: lines between
 * chunks keep their offset from the previous chunk; lines inside a chunk map proportionally (onto its
 * position when the chunk is empty on the other pane).
 */
export function mapLine(model: MergeModel, from: MergePane, to: MergePane, line: number): number {
  if (from === to) return line
  let fromPrev = 0
  let toPrev = 0
  for (const chunk of model.chunks) {
    const f = rangeIn(chunk, from)
    const t = rangeIn(chunk, to)
    if (line < f.start) return Math.min(toPrev + (line - fromPrev), t.start)
    if (line < f.end) return t.start + ((line - f.start) * (t.end - t.start)) / (f.end - f.start)
    fromPrev = f.end
    toPrev = t.end
  }
  return toPrev + (line - fromPrev)
}

/**
 * One pane drives the others at a time: scroll events of the panes it moved are ignored until two
 * animation frames later (programmatic scroll events arrive before the next frame callbacks).
 */
export function createScrollLock(schedule: (callback: () => void) => void = defaultSchedule): { begin(pane: MergePane): boolean } {
  let driver: MergePane | null = null
  let generation = 0
  return {
    begin: (pane) => {
      if (driver !== null && driver !== pane) return false
      driver = pane
      const mine = ++generation
      schedule(() => { schedule(() => { if (generation === mine) driver = null }) })
      return true
    },
  }
}

function defaultSchedule(callback: () => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame
  if (raf === undefined) setTimeout(callback, 16)
  else raf(callback)
}

// ---------------------------------------------------------------------------
// DOM: one CodeMirror pane (real-browser checks in T8)
// ---------------------------------------------------------------------------

export interface MergePaneClasses {
  editor: string
  tone: Readonly<Record<ChunkTone, string>>
  edge: Readonly<Record<LineEdge, string>>
  current: string
  gutter: string
  gutterButton: string
}

export interface MergePaneLabels {
  /** "Accept main's change here" (aria-label and tooltip). */
  accept: string
  ignore: string
}

export interface MergePaneOptions {
  parent: HTMLElement
  pane: MergePane
  doc: string
  editable: boolean
  ariaLabel: string
  classes: MergePaneClasses
  labels?: MergePaneLabels
  onEdits?: (edits: TextEdit[]) => void
  onGutter?: (kind: 'accept' | 'ignore', chunk: GutterChunk, modifier: boolean) => void
  onScroll?: () => void
}

export interface MergePaneHandle {
  readonly view: EditorView
  /** Follow the model: Result text (Result pane), colours and gutter buttons. */
  update(model: MergeModel, current: number | null): void
  /** Result pane: lock / unlock typing (see {@link resultEditable}). */
  setEditable(editable: boolean): void
  destroy(): void
}

interface PaneMarks {
  deco: DecorationSet
  gutter: RangeSet<GutterMarker>
}

const setMarks = StateEffect.define<PaneMarks>()

const marksField = StateField.define<PaneMarks>({
  create: () => ({ deco: Decoration.none, gutter: RangeSet.empty }),
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setMarks)) return effect.value
    return tr.docChanged ? { deco: value.deco.map(tr.changes), gutter: value.gutter.map(tr.changes) } : value
  },
  provide: field => EditorView.decorations.from(field, value => value.deco),
})

class ChunkButtons extends GutterMarker {
  constructor(
    readonly chunks: readonly GutterChunk[],
    readonly pane: 'left' | 'right',
    readonly labels: MergePaneLabels,
    readonly className: string,
    readonly onGutter: MergePaneOptions['onGutter'],
  ) {
    super()
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof ChunkButtons
      && other.pane === this.pane
      && other.labels.accept === this.labels.accept
      && other.labels.ignore === this.labels.ignore
      && other.chunks.length === this.chunks.length
      && other.chunks.every((chunk, index) => chunk.id === this.chunks[index]?.id && chunk.conflict === this.chunks[index]?.conflict)
  }

  override toDOM(): Node {
    const wrap = document.createElement('span')
    for (const chunk of this.chunks) {
      const accept = this.button(this.pane === 'left' ? '»' : '«', this.labels.accept, 'accept', chunk)
      const ignore = this.button('×', this.labels.ignore, 'ignore', chunk)
      // The accept arrow sits next to the Result in both panes (mirrored layout).
      if (this.pane === 'left') wrap.append(ignore, accept)
      else wrap.append(accept, ignore)
    }
    return wrap
  }

  private button(glyph: string, label: string, kind: 'accept' | 'ignore', chunk: GutterChunk): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = this.className
    button.textContent = glyph
    button.title = label
    button.setAttribute('aria-label', label)
    button.dataset['chunkAction'] = kind
    button.dataset['chunk'] = String(chunk.id)
    // Keep the editor selection; the button still works from the keyboard (Tab + Enter/Space).
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      this.onGutter?.(kind, chunk, event.ctrlKey || event.metaKey)
    })
    return button
  }
}

function lineDecorations(state: EditorState, marks: readonly ChunkMark[], classes: MergePaneClasses): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const entry of lineClasses(marks, state.doc.lines)) {
    const names = [classes.tone[entry.tone], classes.edge[entry.edge], entry.current ? classes.current : '']
    builder.add(state.doc.line(entry.line).from, state.doc.line(entry.line).from, Decoration.line({ class: names.filter(Boolean).join(' ') }))
  }
  return builder.finish()
}

function gutterMarkers(state: EditorState, model: MergeModel, options: MergePaneOptions): RangeSet<GutterMarker> {
  if (options.pane === 'result' || options.labels === undefined) return RangeSet.empty
  const builder = new RangeSetBuilder<GutterMarker>()
  const lines = state.doc.lines
  for (const entry of gutterActions(model, options.pane)) {
    const position = state.doc.line(Math.min(entry.line + 1, lines)).from
    builder.add(position, position, new ChunkButtons(entry.chunks, options.pane, options.labels, options.classes.gutterButton, options.onGutter))
  }
  return builder.finish()
}

/** Mounts one pane. Side panes are read-only; only the Result reports user edits. */
export function createMergePane(options: MergePaneOptions): MergePaneHandle {
  const extensions: Extension[] = [
    // Keep `\r` inside lines so editor offsets equal Result offsets for CRLF files.
    EditorState.lineSeparator.of('\n'),
    lineNumbers(),
    marksField,
    keymap.of(defaultKeymap),
    EditorView.editorAttributes.of({ class: options.classes.editor }),
    EditorView.contentAttributes.of({ 'aria-label': options.ariaLabel }),
  ]
  const editability = new Compartment()
  if (options.pane === 'result') extensions.push(editability.of(resultLock(options.editable)))
  else if (!options.editable) extensions.push(EditorState.readOnly.of(true))
  if (options.pane !== 'result') {
    extensions.push(gutter({
      class: options.classes.gutter,
      side: options.pane === 'left' ? 'after' : 'before',
      markers: view => view.state.field(marksField).gutter,
    }))
  }
  const onEdits = options.onEdits
  /** True while user edits are reported: a synchronous re-render must not dispatch inside CM's update. */
  let reporting = false
  if (onEdits !== undefined) {
    extensions.push(EditorView.updateListener.of((update) => {
      reporting = true
      try {
        for (const tr of update.transactions) {
          const edits = userEdits(tr)
          if (edits.length > 0) onEdits(edits)
        }
      } finally {
        reporting = false
      }
    }))
  }
  const view = new EditorView({ parent: options.parent, state: EditorState.create({ doc: options.doc, extensions }) })
  const onScroll = options.onScroll
  if (onScroll !== undefined) view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
  let destroyed = false
  const update = createCoalescedUpdate<{ model: MergeModel; current: number | null }>(({ model, current }) => {
    if (destroyed) return
    if (options.pane === 'result') {
      const spec = syncSpec(view.state, model.result)
      if (spec !== null) view.dispatch(spec)
    }
    const state = view.state
    const marks = chunkMarks(model, options.pane, current)
    view.dispatch({ effects: setMarks.of({ deco: lineDecorations(state, marks, options.classes), gutter: gutterMarkers(state, model, options) }) })
  }, () => reporting)
  let editable = options.editable
  const handle: MergePaneHandle = {
    view,
    update: (model, current) => { update({ model, current }) },
    setEditable: (next) => {
      if (destroyed || options.pane !== 'result' || next === editable) return
      editable = next
      const reconfigure = (): void => {
        if (!destroyed) view.dispatch({ effects: editability.reconfigure(resultLock(editable)) })
      }
      if (reporting) queueMicrotask(reconfigure)
      else reconfigure()
    },
    destroy: () => {
      destroyed = true
      if (onScroll !== undefined) view.scrollDOM.removeEventListener('scroll', onScroll)
      view.destroy()
    },
  }
  return handle
}

/** Fractional 0-based line at the top of the pane's viewport. */
export function topLine(view: EditorView): number {
  const top = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top)
  const block = view.lineBlockAtHeight(top)
  const line = view.state.doc.lineAt(block.from).number - 1
  if (block.height <= 0) return line
  return line + Math.min(1, Math.max(0, (top - block.top) / block.height))
}

/** Scrolls the pane so the fractional 0-based `line` is at the top. */
export function scrollToLine(view: EditorView, line: number): void {
  const lines = view.state.doc.lines
  const index = Math.min(Math.max(0, Math.floor(line)), lines - 1)
  const fraction = index === Math.floor(line) ? line - index : 0
  const block = view.lineBlockAt(view.state.doc.line(index + 1).from)
  view.scrollDOM.scrollTop = block.top + fraction * block.height + view.documentPadding.top
}

/** Centers a 0-based line and puts the cursor there (no document change, so nothing is reported). */
export function revealLine(view: EditorView, line: number): void {
  const position = view.state.doc.line(Math.min(Math.max(1, line + 1), view.state.doc.lines)).from
  view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) })
}
