// Merge-editor facts the window needs while rendering. Kept free of CodeMirror imports: the editor
// itself is the on-demand chunk lib/client.merge.js (B4c T3), this module stays in the main bundle.
import type { MergeStatus } from '../store/merge-store.ts'

/**
 * The Result accepts typing only while the store is `ready`: during save / apply `store.edit` is
 * ignored, so a keystroke the editor kept would silently diverge from the model.
 */
export function resultEditable(status: MergeStatus): boolean {
  return status === 'ready'
}
