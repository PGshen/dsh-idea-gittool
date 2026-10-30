// Shared tree glyphs for the branch tree and the changed-file trees: vector chevron,
// folder / file-type icons from DSH primitives, and branch-kind icons (branch, tag, star).
import type { ReactNode } from 'react'
import {
  FileTypeIcon,
  IconBranchOutlineRegular,
  IconChevronRightOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconGlobeOutlineRegular,
  IconWarningOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TreeIcons.module.css'

/** Disclosure arrow: points right when collapsed, rotates down when expanded. */
export function TreeChevron({ expanded }: { expanded: boolean }): ReactNode {
  return (
    <span className={css.chevron} data-expanded={expanded} aria-hidden="true">
      <IconChevronRightOutlineRegular size={12} />
    </span>
  )
}

/** Folder glyph; `open` while the folder's children are shown. */
export function TreeFolderIcon({ open }: { open: boolean }): ReactNode {
  return (
    <span className={`${css.icon} ${css.folder}`} data-tree-icon={open ? 'folder-open' : 'folder'} aria-hidden="true">
      {open ? <IconFolderOpenRegular size={16} /> : <IconFolderCloseRegular size={16} />}
    </span>
  )
}

/** File-type glyph classified from the path's extension (same set as the DSH files tab). */
export function TreeFileIcon({ path }: { path: string }): ReactNode {
  return (
    <span className={css.icon} data-tree-icon="file" aria-hidden="true">
      <FileTypeIcon path={path} size={16} />
    </span>
  )
}

export type TreeKind = 'branch' | 'remote' | 'tag' | 'current' | 'detached'

function TagGlyph(): ReactNode {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round">
      <path d="M2.5 3.2v4.1c0 .4.2.8.4 1l5.6 5.6c.5.5 1.3.5 1.8 0l3.6-3.6c.5-.5.5-1.3 0-1.8L8.3 2.9c-.3-.3-.6-.4-1-.4H3.2c-.4 0-.7.3-.7.7Z" />
      <circle cx="5.4" cy="5.4" r="1" />
    </svg>
  )
}

function StarGlyph(): ReactNode {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1.6l1.95 4.1 4.45.55-3.28 3.08.84 4.42L8 11.58l-3.96 2.17.84-4.42L1.6 6.25l4.45-.55L8 1.6Z" />
    </svg>
  )
}

const KIND_GLYPH: Record<TreeKind, () => ReactNode> = {
  branch: () => <IconBranchOutlineRegular size={14} />,
  remote: () => <IconGlobeOutlineRegular size={14} />,
  tag: TagGlyph,
  current: StarGlyph,
  detached: () => <IconWarningOutlineRegular size={14} />,
}

/** Leaf glyph of the branch tree; the current branch gets the star. */
export function TreeKindIcon({ kind }: { kind: TreeKind }): ReactNode {
  const Glyph = KIND_GLYPH[kind]
  return (
    <span className={`${css.icon} ${css[kind] ?? ''}`} data-tree-icon={kind} aria-hidden="true">
      <Glyph />
    </span>
  )
}
