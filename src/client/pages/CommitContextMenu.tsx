// Right-click / Shift+F10 menu of a log row (design §8.1.7, plan A3 T8). Disabled items stay
// visible with their reason; dangerous items use the danger tone. Esc / ArrowLeft and outside clicks
// close it; focus lands on the first enabled item once the menu is placed (I-1).
// B2: the markup lives in the generic ActionMenu.
import type { ReactNode } from 'react'
import type { CommitSummary } from '../../shared/protocol.ts'
import { useT } from '../i18n.tsx'
import { ActionMenu } from './ActionMenu.tsx'
import type { CommitActionId, CommitActionItem } from './commit-actions.ts'
import type { MenuAnchor } from './menu-position.ts'

export interface CommitContextMenuProps {
  commit: CommitSummary
  items: CommitActionItem[]
  onSelect: (id: CommitActionId) => void
  onClose?: () => void
  /** Where it opens; measured after render and kept inside the viewport and the Git panel. Without it the menu renders in the document flow. */
  anchor?: MenuAnchor
}

export function CommitContextMenu({ commit, items, onSelect, onClose, anchor }: CommitContextMenuProps): ReactNode {
  const t = useT()
  return (
    <ActionMenu
      label={t('commit.menu', { sha: commit.shortSha })}
      items={items}
      onSelect={onSelect}
      {...(onClose === undefined ? {} : { onClose })}
      {...(anchor === undefined ? {} : { anchor })}
    />
  )
}
