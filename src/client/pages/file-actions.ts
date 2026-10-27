// File actions of the B2 entries (plan B2 T7): one availability matrix for the commit detail's changed
// files and the commit page's change tree. React-free; menus render the items with ActionMenu.
import type { FileStatusCode } from '../../shared/protocol.ts'
import { text } from '../localized-text.ts'
import type { LocalizedText } from '../localized-text.ts'
import type { GitWorkbenchKey } from '../locales.ts'
import type { ActionMenuItem } from './ActionMenu.tsx'

export type FileActionId = 'showDiff' | 'fileHistory' | 'blameRevision' | 'blame' | 'compareWorktree' | 'copyPath'

export type FileActionSource =
  /** A file changed by a commit (commit detail). */
  | { kind: 'commitFile'; status: FileStatusCode }
  /** A worktree change (commit page). */
  | { kind: 'change'; status: FileStatusCode }

export type FileActionItem = ActionMenuItem<FileActionId>

function item(id: FileActionId, label: GitWorkbenchKey, section: number, disabledReason?: LocalizedText): FileActionItem {
  return disabledReason === undefined ? { id, label: text(label), section } : { id, label: text(label), section, disabledReason }
}

/** The menu items for one file row; disabled ones carry their reason. */
export function fileActions(source: FileActionSource): FileActionItem[] {
  if (source.kind === 'commitFile') {
    return [
      item('showDiff', 'file.action.showDiff', 0),
      item('fileHistory', 'file.action.fileHistory', 1),
      item('blameRevision', 'file.action.blameRevision', 1, source.status === 'D' ? text('file.disabled.deletedHere') : undefined),
      item('compareWorktree', 'file.action.compareWorktree', 1),
      item('copyPath', 'file.action.copyPath', 2),
    ]
  }
  // Untracked and newly added files have no commit yet: nothing to follow, nothing to blame.
  const uncommitted = source.status === '?' || source.status === 'A' ? text('file.disabled.untracked') : undefined
  return [
    item('fileHistory', 'file.action.fileHistory', 0, uncommitted),
    item('blame', 'file.action.blame', 0, uncommitted ?? (source.status === 'D' ? text('file.disabled.deletedWorktree') : undefined)),
  ]
}
