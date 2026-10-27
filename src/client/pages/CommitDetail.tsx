// 提交详情（设计 §8.1.5）：主题、短哈希 + 复制、refs、作者/提交者、父提交、正文、变更文件。
// 合并提交按父提交分组，每组可折叠；分组内的文件树复用 ChangedFilesTree。
import { useState } from 'react'
import type { ReactNode } from 'react'
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RelativeTime, RelativeTimeUnit } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CommitDetailValue,
  CommitFileEntry,
  CommitParentValue,
  GitError,
  RefEntry,
} from '../../shared/protocol.ts'
import { render, text, useT } from '../i18n.tsx'
import type { LocalizedText, Translate } from '../i18n.tsx'
import type { GitWorkbenchKey } from '../locales.ts'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { ChangedFilesTree } from './ChangedFilesTree.tsx'
import type { ChangedFilesMode } from './ChangedFilesTree.tsx'
import type { MenuAnchor } from './menu-position.ts'
import css from './CommitDetail.module.css'

/** 正文超过这个行数就折叠（设计 §8.1.5「超长折叠」）。 */
export const BODY_COLLAPSE_LINES = 20
/** 正文超过这个字符数也折叠（单行超长提交信息）。 */
export const BODY_COLLAPSE_CHARS = 1200
/** 是否折叠正文：行数或字符数任一超阈值。 */
export function shouldCollapseBody(body: string): boolean {
  if (body.length > BODY_COLLAPSE_CHARS) return true
  return body.split('\n').length > BODY_COLLAPSE_LINES
}

/** 绝对时间：本地时区的 `YYYY-MM-DD HH:mm`；非法输入原样返回。 */
export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const RELATIVE_KEYS: Record<RelativeTimeUnit, GitWorkbenchKey> = {
  now: 'time.now',
  minutes: 'time.minutes',
  hours: 'time.hours',
  days: 'time.days',
  months: 'time.months',
  years: 'time.years',
}

/** 把 ui-primitives 的相对时间桶翻成文案键；hover 到绝对时间上显示。 */
export function relativeLabel(bucket: RelativeTime): LocalizedText {
  return text(RELATIVE_KEYS[bucket.unit], { n: bucket.n })
}

/** 相对时间文案；`now` 由调用方注入，保证快照可复现。 */
export function formatRelativeTime(iso: string, now: number, t: Translate): string {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return iso
  return render(t, relativeLabel(relativeTime(at, now)))
}

/** 作者与提交者不同时才单独显示「提交者」（设计 §8.1.5 第 5 条）。 */
export function committerDiffers(
  detail: Pick<CommitDetailValue, 'author' | 'committer'>,
): boolean {
  return detail.committer.name !== detail.author.name || detail.committer.email !== detail.author.email
}

export interface CommitDetailProps {
  detail: CommitDetailValue | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: GitError | null
  /** 相对时间的基准（毫秒）；默认取当前时间，测试可注入固定值。 */
  now?: number
  /** 正文初始是否展开；默认按长度自动折叠。 */
  defaultBodyExpanded?: boolean
  /** 初始折叠的父提交分组 sha（合并提交）。 */
  defaultCollapsedParents?: string[]
  /** 变更文件初始分组模式；默认按目录（设计 §8.1.5）。 */
  defaultFilesMode?: ChangedFilesMode
  /** 当前选中的文件（Diff 返回后保留选中）；合并提交还要匹配 parentSha。 */
  selectedFile?: { path: string; parentSha?: string }
  onOpenFile?: (file: CommitFileEntry, parentSha?: string) => void
  /** B2：变更文件右键菜单（文件历史、Blame 此版本、与工作区比较…）。 */
  onFileMenu?: (file: CommitFileEntry, parentSha: string | undefined, anchor: MenuAnchor) => void
  /** 点击父提交/跳转时回调，参数是完整 sha。 */
  onNavigate?: (sha: string) => void
  onRetry?: () => void
  onCopy?: (text: string) => void
}

/** 写入剪贴板；没有 navigator 的环境（SSR/单测）静默跳过。 */
function copyToClipboard(text: string): void {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

export interface ParentLinksProps {
  t: Translate
  parents: CommitParentValue[]
  onNavigate?: (sha: string) => void
}

/**
 * 父提交行：每个父提交一个可点击短哈希（合并提交显示多个）；根提交给出提示。
 * 无 hook，便于无 DOM 单测直接触发点击。
 * @param props - 父提交列表与跳转回调。
 * @returns 父提交信息行。
 */
export function ParentLinks({ t, parents, onNavigate }: ParentLinksProps): ReactNode {
  if (parents.length === 0) {
    return (
      <div className={css.metaRow}>
        <span className={css.muted}>{t('detail.root')}</span>
      </div>
    )
  }
  return (
    <div className={css.metaRow} data-parents>
      <span className={css.muted}>{t('detail.parents')}</span>
      {parents.map(parent => parentButton(parent, onNavigate))}
    </div>
  )
}

export interface HashRowProps {
  t: Translate
  sha: string
  shortSha: string
  refs: RefEntry[]
  copied: boolean
  /** 点击复制按钮时用完整 sha 回调。 */
  onCopy: (sha: string) => void
}

/**
 * 短哈希 + 复制按钮 + refs 胶囊（无 hook）。
 * @param props - 哈希、refs、是否已复制与复制回调。
 * @returns 哈希信息行。
 */
export function HashRow({ t, sha, shortSha, refs, copied, onCopy }: HashRowProps): ReactNode {
  return (
    <div className={css.metaRow}>
      <code className={css.hash} title={sha}>{shortSha}</code>
      <Button className={css.copyButton} title={t('detail.copyHash.title')} onClick={() => onCopy(sha)}>
        {copied ? t('detail.copied') : t('detail.copyHash')}
      </Button>
      {refs.map(ref => (
        <Chip key={ref.ref} kind={ref.kind} title={ref.ref}>{ref.name}</Chip>
      ))}
    </div>
  )
}

export interface FilesModeToggleProps {
  t: Translate
  mode: ChangedFilesMode
  onChange: (mode: ChangedFilesMode) => void
}

/**
 * 变更文件「按目录 / 扁平」切换按钮：显示的是切换后的目标模式。
 * @param props - 当前模式与切换回调。
 * @returns 切换按钮。
 */
export function FilesModeToggle({ t, mode, onChange }: FilesModeToggleProps): ReactNode {
  const next: ChangedFilesMode = mode === 'tree' ? 'flat' : 'tree'
  return (
    <Button
      className={css.modeToggle}
      data-files-mode-toggle
      title={t(next === 'flat' ? 'detail.mode.toFlat' : 'detail.mode.toTree')}
      onClick={() => onChange(next)}
    >
      {t(next === 'flat' ? 'detail.mode.flat' : 'detail.mode.tree')}
    </Button>
  )
}

function parentButton(parent: CommitParentValue, onNavigate: ((sha: string) => void) | undefined): ReactNode {
  return (
    <button
      key={parent.sha}
      type="button"
      className={css.parentLink}
      title={parent.subject}
      data-parent-sha={parent.sha}
      disabled={onNavigate === undefined}
      onClick={onNavigate === undefined ? undefined : () => onNavigate(parent.sha)}
    >
      {parent.shortSha}
    </button>
  )
}

/** 合并提交的分组标题：「对父提交 1a2b3c4 的变更」。 */
function parentGroupLabel(t: Translate, parent: CommitParentValue | undefined, parentSha: string): string {
  return t('detail.parentGroup', { sha: parent?.shortSha ?? parentSha.slice(0, 8) })
}

/**
 * 渲染提交详情。
 * @param props - 详情数据、加载状态与打开文件/跳转/复制回调。
 * @returns 详情面板；初始、加载、错误态各有独立呈现。
 */
export function CommitDetail({
  detail,
  status,
  error,
  now = Date.now(),
  defaultBodyExpanded,
  defaultCollapsedParents,
  defaultFilesMode,
  selectedFile,
  onOpenFile,
  onFileMenu,
  onNavigate,
  onRetry,
  onCopy,
}: CommitDetailProps): ReactNode {
  const t = useT()
  const [bodyExpanded, setBodyExpanded] = useState<boolean>(defaultBodyExpanded ?? false)
  const [collapsedParents, setCollapsedParents] = useState<ReadonlySet<string>>(
    () => new Set(defaultCollapsedParents ?? []),
  )
  const [filesMode, setFilesMode] = useState<ChangedFilesMode>(defaultFilesMode ?? 'tree')
  // 切换到另一个提交时复位「已复制」提示。
  const [copiedFor, setCopiedFor] = useState<string | null>(null)

  if (status === 'error') {
    return (
      <div className={css.stateBox}>
        <EmptyState
          error
          title={t('detail.loadFailed')}
          hint={error?.message ?? t('action.retryHint')}
          action={onRetry === undefined ? undefined : { label: t('action.retry'), onClick: onRetry }}
        />
      </div>
    )
  }
  if (detail === null) {
    return (
      <p className={css.state} role="status">
        {t(status === 'loading' ? 'detail.loading' : 'detail.placeholder')}
      </p>
    )
  }

  const copy = onCopy ?? copyToClipboard
  const collapsedBody = shouldCollapseBody(detail.body)
  const expanded = bodyExpanded || !collapsedBody
  const parents = new Map<string, CommitParentValue>(detail.parents.map(parent => [parent.sha, parent]))
  const hasParentGroups = detail.parentGroups !== undefined && detail.parentGroups.length > 0

  const toggleParentGroup = (sha: string): void => {
    setCollapsedParents((current) => {
      const next = new Set(current)
      if (next.has(sha)) next.delete(sha)
      else next.add(sha)
      return next
    })
  }

  return (
    <article
      className={css.root}
      data-commit-sha={detail.sha}
      data-loading={status === 'loading' ? 'true' : undefined}
      aria-busy={status === 'loading' ? true : undefined}
    >
      <h2 className={css.subject} title={detail.subject}>{detail.subject}</h2>

      <HashRow
        t={t}
        sha={detail.sha}
        shortSha={detail.shortSha}
        refs={detail.refs}
        copied={copiedFor === detail.sha}
        onCopy={(sha) => {
          copy(sha)
          setCopiedFor(sha)
        }}
      />

      <div className={css.metaRow}>
        <span className={css.author}>{detail.author.name} &lt;{detail.author.email}&gt;</span>
        <span className={css.separator}>·</span>
        <time dateTime={detail.author.date} title={formatRelativeTime(detail.author.date, now, t)}>
          {formatAbsoluteTime(detail.author.date)}
        </time>
      </div>

      {committerDiffers(detail) ? (
        <div className={css.metaRow} data-committer>
          <span className={css.author}>
            {t('detail.committer', { name: detail.committer.name, email: detail.committer.email })}
          </span>
          <span className={css.separator}>·</span>
          <time dateTime={detail.committer.date} title={formatRelativeTime(detail.committer.date, now, t)}>
            {formatAbsoluteTime(detail.committer.date)}
          </time>
        </div>
      ) : null}

      <ParentLinks t={t} parents={detail.parents} onNavigate={onNavigate} />

      {detail.body.trim() === '' ? null : (
        <div className={css.body} data-body-collapsed={collapsedBody && !expanded ? 'true' : undefined}>
          <pre className={expanded ? css.bodyText : `${css.bodyText} ${css.bodyClamped}`}>{detail.body}</pre>
          {collapsedBody ? (
            <Button className={css.bodyToggle} onClick={() => setBodyExpanded(current => !current)}>
              {t(expanded ? 'detail.body.collapse' : 'detail.body.expand')}
            </Button>
          ) : null}
        </div>
      )}

      {detail.truncated ? (
        <p className={css.note} data-detail-truncated>{t('detail.truncated', { count: detail.files.length })}</p>
      ) : null}

      {hasParentGroups ? (
        <div className={css.groups}>
          <div className={css.filesToolbar} data-files-toolbar>
            <span className={css.filesLabel}>{t('detail.files')}</span>
            <span className={css.count}>{detail.files.length}</span>
            <FilesModeToggle t={t} mode={filesMode} onChange={setFilesMode} />
          </div>
          {detail.parentGroups?.map((group) => {
            const isCollapsed = collapsedParents.has(group.parentSha)
            return (
              <section key={group.parentSha} className={css.group} data-parent-group={group.parentSha}>
                <button
                  type="button"
                  className={css.groupHeader}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleParentGroup(group.parentSha)}
                >
                  <span className={css.chevron} aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                  <span>{parentGroupLabel(t, parents.get(group.parentSha), group.parentSha)}</span>
                  <span className={css.count}>{group.files.length}</span>
                </button>
                {isCollapsed ? null : (
                  <ChangedFilesTree
                    files={group.files}
                    mode={filesMode}
                    selectedPath={selectedFile?.parentSha === group.parentSha ? selectedFile.path : undefined}
                    onOpenFile={file => onOpenFile?.(file, group.parentSha)}
                    {...(onFileMenu === undefined ? {} : { onFileMenu: (file: CommitFileEntry, anchor: MenuAnchor) => { onFileMenu(file, group.parentSha, anchor) } })}
                  />
                )}
              </section>
            )
          })}
        </div>
      ) : (
        <ChangedFilesTree
          files={detail.files}
          label={t('detail.files')}
          mode={filesMode}
          selectedPath={selectedFile?.path}
          headerExtra={<FilesModeToggle t={t} mode={filesMode} onChange={setFilesMode} />}
          onOpenFile={onOpenFile}
          {...(onFileMenu === undefined ? {} : { onFileMenu: (file: CommitFileEntry, anchor: MenuAnchor) => { onFileMenu(file, undefined, anchor) } })}
        />
      )}
    </article>
  )
}
