// B1 T7 resolved files in the merge window (Review Changes, ruling 16). `mergeFile` gives the three
// sides from resolve-undo and the worktree text; the Result is that text:
// - a usable saved draft wins even when its Result differs from the worktree (ruling 20: the user's
//   unfinished work is never dropped silently; the window says applying writes the draft);
// - otherwise the automatic merge (applyNonConflicting('all') + resolveSimple) or a whole-file take
//   whose Result equals the worktree keeps its chunk states;
// - otherwise the worktree text with every chunk edited.
// Pure, no React / CodeMirror.
import type { MergeDraft } from '../../shared/protocol.ts'
import { acceptFile, autoMerge, createModel, editedModel } from './merge-model.ts'
import type { MergeModel, MergeTexts } from './merge-model.ts'

/**
 * The worktree in the sides' form: the sides are index blobs (clean, LF); a CRLF worktree of LF sides
 * (autocrlf's smudge) is compared and edited as LF, which is what `mergeApply`'s clean filter stores.
 */
function cleanForm(texts: MergeTexts, worktree: string): string {
  if (!worktree.includes('\r\n')) return worktree
  const sidesUseCr = [texts.base, texts.ours, texts.theirs].some(text => text?.includes('\r') === true)
  return sidesUseCr ? worktree : worktree.replace(/\r\n/g, '\n')
}

export interface ResolvedReplay {
  model: MergeModel
  /** The restored draft's Result differs from the worktree: applying writes the draft (ruling 20). */
  draftDiffers: boolean
  /** A draft was given but its chunks do not fit the sides; the worktree was used instead. */
  draftUnusable: boolean
}

/** The model of a resolved file (see the header); null without worktree text (not reviewable). */
export function resolvedReplay(texts: MergeTexts, worktreeText: string | null | undefined, draft: MergeDraft | null): ResolvedReplay | null {
  if (worktreeText === null || worktreeText === undefined) return null
  const target = cleanForm(texts, worktreeText)
  const restored = draft === null ? null : createModel(texts, draft)
  if (restored !== null) return { model: restored, draftDiffers: restored.result !== target, draftUnusable: false }
  const draftUnusable = draft !== null
  const auto = autoMerge(texts)
  if (auto.result === target) return { model: auto, draftDiffers: false, draftUnusable }
  const fresh = createModel(texts)
  for (const side of ['left', 'right'] as const) {
    const taken = acceptFile(fresh, side)
    if (taken.result === target) return { model: taken, draftDiffers: false, draftUnusable }
  }
  return { model: editedModel(fresh, target), draftDiffers: false, draftUnusable }
}

/** {@link resolvedReplay}'s model alone. */
export function resolvedModel(texts: MergeTexts, worktreeText: string | null | undefined, draft: MergeDraft | null): MergeModel | null {
  return resolvedReplay(texts, worktreeText, draft)?.model ?? null
}
