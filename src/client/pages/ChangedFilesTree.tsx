// 变更文件树（设计 §8.1.5）：按目录分组或扁平列表，行内是状态字母 + 文件名 + 增删行数。
// 合并提交的「按父提交分组」由 CommitDetail 渲染多个本组件实例。
import { useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CommitFileEntry } from '../../shared/protocol.ts'
import { useT } from '../i18n.tsx'
import { StatusLetter } from '../ui/StatusLetter.tsx'
import css from './ChangedFilesTree.module.css'

/** 目录节点：`count` 是子树里的文件总数（根节点展示它）。 */
export interface ChangedTreeDir {
  kind: 'dir'
  name: string
  path: string
  count: number
  children: ChangedTreeNode[]
}

/** 文件节点：保留原条目，点击时把整条传给打开 diff 的回调。 */
export interface ChangedTreeFile {
  kind: 'file'
  name: string
  path: string
  file: CommitFileEntry
}

export type ChangedTreeNode = ChangedTreeDir | ChangedTreeFile

/** 树/扁平两种分组模式。 */
export type ChangedFilesMode = 'tree' | 'flat'

export interface ChangedFilesTreeProps {
  files: CommitFileEntry[]
  /** 根节点标题；省略时不渲染根行（合并提交分组自带标题）。 */
  label?: string
  mode?: ChangedFilesMode
  /** 初次渲染就折叠的目录路径。 */
  initialCollapsedDirs?: string[]
  onOpenFile?: (file: CommitFileEntry) => void
  /** 没有变更文件时的提示；由调用方本地化。 */
  emptyHint?: string
  /** 当前选中的文件路径（从 Diff 返回时保留选中，设计 §8.1.6）。 */
  selectedPath?: string
  /** 根行右侧的附加控件（如树/扁平切换）；只有渲染根行时才显示。 */
  headerExtra?: ReactNode
}

/** 目录在前、文件在后，同类按名称排序；不依赖 locale，保证快照稳定。 */
function compareNodes(left: ChangedTreeNode, right: ChangedTreeNode): number {
  if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

interface MutableDir {
  name: string
  path: string
  directories: Map<string, MutableDir>
  files: { name: string; file: CommitFileEntry }[]
}

function createDir(name: string, path: string): MutableDir {
  return { name, path, directories: new Map(), files: [] }
}

function insert(dir: MutableDir, parts: string[], file: CommitFileEntry): void {
  const head = parts[0]
  if (head === undefined || parts.length === 1) {
    if (head !== undefined) dir.files.push({ name: head, file })
    return
  }
  let child = dir.directories.get(head)
  if (child === undefined) {
    child = createDir(head, dir.path === '' ? head : `${dir.path}/${head}`)
    dir.directories.set(head, child)
  }
  insert(child, parts.slice(1), file)
}

function finalize(dir: MutableDir): ChangedTreeNode[] {
  const directories: ChangedTreeDir[] = []
  for (const child of dir.directories.values()) {
    const children = finalize(child)
    const count = children.reduce((total, node) => total + (node.kind === 'dir' ? node.count : 1), 0)
    directories.push({ kind: 'dir', name: child.name, path: child.path, count, children })
  }
  directories.sort(compareNodes)
  const files: ChangedTreeFile[] = dir.files
    .map(entry => ({ kind: 'file' as const, name: entry.name, path: entry.file.path, file: entry.file }))
    .sort(compareNodes)
  return [...directories, ...files]
}

/**
 * 把变更文件按路径分段聚成目录树。
 * @param files - 提交里的变更文件（repo 相对 POSIX 路径）。
 * @returns 已排序的树节点；根级文件排在同级目录之后。
 */
export function buildChangedTree(files: readonly CommitFileEntry[]): ChangedTreeNode[] {
  const root = createDir('', '')
  for (const file of files) insert(root, file.path.split('/'), file)
  return finalize(root)
}

/** 扁平模式：按路径排序的一行一个文件。 */
export function flattenChangedFiles(files: readonly CommitFileEntry[]): CommitFileEntry[] {
  return [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/** 文件名的目录部分；没有目录时为空串（扁平模式用它显示目录列）。 */
export function directoryOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

function statText(file: CommitFileEntry): string | undefined {
  if (file.additions === undefined && file.deletions === undefined) return undefined
  return `+${file.additions ?? 0} −${file.deletions ?? 0}`
}

export interface FileRowProps {
  file: CommitFileEntry
  name: string
  depth: number
  showDirectory: boolean
  selected?: boolean
  onOpenFile?: ((file: CommitFileEntry) => void) | undefined
}

/**
 * 单个文件行（无 hook，便于无 DOM 单测直接取元素触发点击）。
 * @param props - 文件条目、显示名、缩进深度与点击回调。
 * @returns 文件行按钮。
 */
export function FileRow({ file, name, depth, showDirectory, selected = false, onOpenFile }: FileRowProps): ReactNode {
  const stat = statText(file)
  const directory = directoryOf(file.path)
  return (
    <button
      type="button"
      className={selected ? `${css.row} ${css.selected}` : css.row}
      aria-current={selected ? 'true' : undefined}
      style={{ '--git-tree-depth': depth } as CSSProperties}
      title={file.origPath === undefined ? file.path : `${file.origPath} → ${file.path}`}
      data-path={file.path}
      data-parent={file.parentSha}
      onClick={onOpenFile === undefined ? undefined : () => onOpenFile(file)}
    >
      <StatusLetter status={file.status} />
      <span className={css.name}>{name}</span>
      {showDirectory && directory !== '' ? <span className={css.directory}>{directory}</span> : null}
      {stat === undefined ? null : <span className={css.stat}>{stat}</span>}
    </button>
  )
}

function TreeRows({ nodes, depth, collapsed, selectedPath, onToggle, onOpenFile }: {
  nodes: ChangedTreeNode[]
  depth: number
  collapsed: ReadonlySet<string>
  selectedPath: string | undefined
  onToggle: (path: string) => void
  onOpenFile?: ((file: CommitFileEntry) => void) | undefined
}): ReactNode {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'file') {
          return <FileRow key={node.path} file={node.file} name={node.name} depth={depth} showDirectory={false} selected={node.path === selectedPath} onOpenFile={onOpenFile} />
        }
        const isCollapsed = collapsed.has(node.path)
        return (
          <div key={node.path} className={css.group} data-dir={node.path}>
            <button
              type="button"
              className={css.directoryRow}
              style={{ '--git-tree-depth': depth } as CSSProperties}
              aria-expanded={!isCollapsed}
              onClick={() => onToggle(node.path)}
            >
              <span className={css.chevron} aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
              <span className={css.name}>{node.name}</span>
              <span className={css.count}>{node.count}</span>
            </button>
            {isCollapsed ? null : (
              <TreeRows nodes={node.children} depth={depth + 1} collapsed={collapsed} selectedPath={selectedPath} onToggle={onToggle} onOpenFile={onOpenFile} />
            )}
          </div>
        )
      })}
    </>
  )
}

/**
 * 渲染变更文件树。
 * @param props - 文件列表、标题、分组模式与打开 diff 的回调。
 * @returns 文件树或空态提示。
 */
export function ChangedFilesTree({
  files,
  label,
  mode = 'tree',
  initialCollapsedDirs,
  onOpenFile,
  emptyHint,
  selectedPath,
  headerExtra,
}: ChangedFilesTreeProps): ReactNode {
  const t = useT()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(initialCollapsedDirs ?? []))
  const tree = useMemo(() => buildChangedTree(files), [files])
  const flat = useMemo(() => flattenChangedFiles(files), [files])

  if (files.length === 0) {
    return <p className={css.empty}>{emptyHint ?? t('detail.noFiles')}</p>
  }

  const toggle = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className={css.root} data-changed-files data-file-count={files.length} data-mode={mode}>
      {label === undefined ? null : (
        <div className={css.rootRow} data-root>
          <span className={css.rootLabel}>{label}</span>
          <span className={css.count}>{files.length}</span>
          {headerExtra === undefined ? null : <span className={css.headerExtra}>{headerExtra}</span>}
        </div>
      )}
      {mode === 'flat' ? (
        flat.map(file => (
          <FileRow
            key={file.path}
            file={file}
            name={file.path.slice(file.path.lastIndexOf('/') + 1)}
            depth={0}
            showDirectory
            selected={file.path === selectedPath}
            onOpenFile={onOpenFile}
          />
        ))
      ) : (
        <TreeRows nodes={tree} depth={0} collapsed={collapsed} selectedPath={selectedPath} onToggle={toggle} onOpenFile={onOpenFile} />
      )}
    </div>
  )
}
