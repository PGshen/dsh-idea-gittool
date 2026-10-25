// 日志行的 refs 胶囊（设计 §8.1.3）：最多显示 3 个，超出折成 `+n`，悬浮展开全部名字。
// 当前分支用 head 色，本地/远程/标签沿用 Chip 的语义色。
import type { ReactNode } from 'react'
import type { RefEntry } from '../../shared/protocol.ts'
import { Chip } from '../ui/Chip.tsx'
import type { ChipKind } from '../ui/Chip.tsx'
import css from './RefChips.module.css'

/** 每行最多显示的 refs 胶囊数（设计 §8.1.3）。 */
export const MAX_REF_CHIPS = 3

export interface RefChipItem {
  key: string
  name: string
  kind: ChipKind
}

export interface SplitRefs {
  visible: RefChipItem[]
  hidden: RefChipItem[]
}

const KIND_ORDER: Record<ChipKind, number> = { head: 0, local: 1, remote: 2, tag: 3, filter: 4, count: 5 }

/**
 * 排序并切分 refs：当前分支最前，其后本地 → 远程 → 标签（同类保持 Host 返回顺序）。
 * `currentBranch` 是 HEAD 指向的本地分支短名（detached 时为 null）。
 */
export function splitRefs(
  refs: readonly RefEntry[],
  currentBranch: string | null = null,
  max: number = MAX_REF_CHIPS,
): SplitRefs {
  const items = refs.map((ref, index): { item: RefChipItem; index: number } => ({
    item: {
      key: ref.ref,
      name: ref.name,
      kind: ref.kind === 'local' && currentBranch !== null && ref.name === currentBranch ? 'head' : ref.kind,
    },
    index,
  }))
  items.sort((left, right) => KIND_ORDER[left.item.kind] - KIND_ORDER[right.item.kind] || left.index - right.index)
  const sorted = items.map((entry) => entry.item)
  const limit = Math.max(0, Math.trunc(max))
  return { visible: sorted.slice(0, limit), hidden: sorted.slice(limit) }
}

export interface RefChipsProps {
  refs: readonly RefEntry[]
  currentBranch?: string | null
  max?: number
}

export function RefChips({ refs, currentBranch = null, max = MAX_REF_CHIPS }: RefChipsProps): ReactNode {
  if (refs.length === 0) return null
  const { visible, hidden } = splitRefs(refs, currentBranch, max)
  return (
    <span className={css.refs}>
      {visible.map((item) => (
        <Chip key={item.key} kind={item.kind} title={item.key}>{item.name}</Chip>
      ))}
      {hidden.length === 0 ? null : (
        <Chip kind="count" title={hidden.map((item) => item.name).join('\n')}>+{hidden.length}</Chip>
      )}
    </span>
  )
}
