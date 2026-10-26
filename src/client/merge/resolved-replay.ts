// B1 T7 resolved files in the merge window (Review Changes, ruling 16). `mergeFile` gives the three
// sides from resolve-undo and the worktree text; the Result is that text:
// - a saved draft, the automatic merge (applyNonConflicting('all') + resolveSimple) or a whole-file
//   take whose Result equals it keeps its chunk states;
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

/** The model of a resolved file whose Result is the worktree text; null when there is none (not reviewable). */
export function resolvedModel(texts: MergeTexts, worktreeText: string | null | undefined, draft: MergeDraft | null): MergeModel | null {
  if (worktreeText === null || worktreeText === undefined) return null
  const target = cleanForm(texts, worktreeText)
  if (draft !== null && draft.result === target) {
    const restored = createModel(texts, draft)
    if (restored !== null) return restored
  }
  const auto = autoMerge(texts)
  if (auto.result === target) return auto
  const fresh = createModel(texts)
  for (const side of ['left', 'right'] as const) {
    const taken = acceptFile(fresh, side)
    if (taken.result === target) return taken
  }
  return editedModel(fresh, target)
}
