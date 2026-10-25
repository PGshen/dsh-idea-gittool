// Diff 查看器的文件切换（设计 §9.2）：宽屏左侧 200px 列表，窄屏收进顶部下拉。
// 两个组件都无 hook，选中状态由 DiffViewer 的控制器持有。
import type { ReactNode } from 'react'
import type { CommitFileEntry } from '../../shared/protocol.ts'
import { StatusLetter } from '../ui/StatusLetter.tsx'
import css from './DiffFileList.module.css'

export interface DiffFileListProps {
  files: readonly CommitFileEntry[]
  /** 当前文件下标；-1 表示不在列表中。 */
  currentIndex: number
  onSelect: (file: CommitFileEntry) => void
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** 合并提交分组的文件可能同路径，key 需带上父提交。 */
function fileKey(file: CommitFileEntry): string {
  return file.parentSha === undefined ? file.path : `${file.parentSha}:${file.path}`
}

/**
 * 宽屏文件列表。
 * @param props - 文件、当前下标与选中回调。
 * @returns 文件列表导航。
 */
export function DiffFileList({ files, currentIndex, onSelect }: DiffFileListProps): ReactNode {
  return (
    <nav className={css.list} aria-label="变更文件" data-diff-file-list>
      <div className={css.title}>变更文件 ({files.length})</div>
      {files.map((file, index) => (
        <button
          key={fileKey(file)}
          type="button"
          className={index === currentIndex ? `${css.item} ${css.current}` : css.item}
          aria-current={index === currentIndex ? 'true' : undefined}
          data-path={file.path}
          title={file.origPath === undefined ? file.path : `${file.origPath} → ${file.path}`}
          onClick={() => onSelect(file)}
        >
          <StatusLetter status={file.status} />
          <span className={css.name}>{baseName(file.path)}</span>
        </button>
      ))}
    </nav>
  )
}

/**
 * 窄屏文件下拉。
 * @param props - 文件、当前下标与选中回调。
 * @returns 原生 select。
 */
export function DiffFileSelect({ files, currentIndex, onSelect }: DiffFileListProps): ReactNode {
  return (
    <select
      className={css.select}
      aria-label="切换文件"
      value={currentIndex === -1 ? '' : String(currentIndex)}
      onChange={(event) => {
        const file = files[Number(event.currentTarget.value)]
        if (file !== undefined) onSelect(file)
      }}
    >
      {currentIndex === -1 ? <option value="">—</option> : null}
      {files.map((file, index) => (
        <option key={fileKey(file)} value={String(index)}>{`${file.status} ${file.path}`}</option>
      ))}
    </select>
  )
}
