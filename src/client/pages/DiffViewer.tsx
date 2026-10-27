// 统一模式 Diff 查看器（设计 §9.1–9.5）：覆盖层占满 Git tab 内容区，顶部「← 返回 + 面包屑 +
// 文件切换 + 复制路径」，Esc 返回；内容按 §9.3 规则处理重命名/二进制/无变化/截断。
// 数据与交互状态在 diff-store（store + 控制器）里，组件只做呈现与事件转发。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'
import { languageForPath, useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommitFileEntry, DiffFileValue, DiffRequest, FileStatusCode } from '../../shared/protocol.ts'
import {
  createDiffStore,
  createDiffViewerController,
  fileIndexOf,
  formatBytes,
  hasNoTextChange,
  terminalCommandFor,
  truncationNotice,
  useDiffState,
} from '../store/diff-store.ts'
import type { DiffLoader, DiffState, DiffViewOptions, DiffViewerPosition } from '../store/diff-store.ts'
import { render, useT } from '../i18n.tsx'
import type { LocalizedText, Translate } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { StatusLetter } from '../ui/StatusLetter.tsx'
import { DiffFileList, DiffFileSelect } from './DiffFileList.tsx'
import { DiffHunks } from './DiffHunks.tsx'
import { readDiffMode, writeDiffMode } from '../settings.ts'
import type { DiffMode } from '../settings.ts'
import css from './DiffViewer.module.css'

/** 写入剪贴板；没有 navigator 的环境（SSR/单测）静默跳过。 */
function copyToClipboard(text: string): void {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

/** 请求的稳定身份（滚动位置缓存、内容区 key）。 */
function requestKey(request: DiffRequest): string {
  return [request.scope, request.sha ?? '', request.parent ?? '', request.path].join('\u0000')
}

function shortHash(sha: string | undefined): string {
  return sha === undefined ? '—' : sha.slice(0, 10)
}

// ---------------------------------------------------------------------------
// 顶部工具栏
// ---------------------------------------------------------------------------

/** 面包屑的一段：文案键（如「日志」）或原样显示的文本（如短哈希）。 */
export type DiffSourcePart = string | LocalizedText

export interface DiffViewerHeaderProps {
  t: Translate
  path: string
  status: FileStatusCode | undefined
  /** 来源面包屑，例如 [text('diff.source.log'), '7f3a2c1']。 */
  source: readonly DiffSourcePart[]
  files: readonly CommitFileEntry[]
  position: DiffViewerPosition
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onSelectFile: (file: CommitFileEntry) => void
  onCopy: (text: string) => void
  /** B3b：显示选项；省略时不显示这三个开关。 */
  options?: DiffHeaderOptions
  onOptions?: (next: Partial<Omit<DiffHeaderOptions, 'splitAvailable'>>) => void
}

/** B3b toolbar state: preferred mode, whether the content is wide enough for split, and the two diff options. */
export interface DiffHeaderOptions {
  mode: DiffMode
  splitAvailable: boolean
  ignoreWhitespace: boolean
  fullFile: boolean
}

/** Content width below which side-by-side is unavailable (design §9.2). */
export const SPLIT_MIN_WIDTH = 900

/**
 * 顶部工具栏（无 hook）：返回、面包屑、状态字母、文件切换、复制路径。
 * @param props - 当前文件、来源与回调。
 * @returns 工具栏。
 */
export function DiffViewerHeader({
  t,
  path,
  status,
  source,
  files,
  position,
  onClose,
  onPrev,
  onNext,
  onSelectFile,
  onCopy,
  options,
  onOptions,
}: DiffViewerHeaderProps): ReactNode {
  const switchable = files.length > 1
  return (
    <header className={css.header}>
      <Button className={css.back} title={t('diff.back.title')} onClick={onClose}>{t('diff.back')}</Button>
      <nav className={css.breadcrumb} aria-label={t('diff.source')}>
        {source.map((part, index) => (
          <span key={index} className={css.crumb}>
            {typeof part === 'string' ? part : render(t, part)}
            <span className={css.crumbSeparator} aria-hidden="true">/</span>
          </span>
        ))}
        <span className={css.path} title={path}>{path}</span>
      </nav>
      {status === undefined ? null : <StatusLetter status={status} />}
      <div className={css.tools}>
        {switchable ? (
          <>
            <span className={css.fileSelect}>
              <DiffFileSelect t={t} files={files} currentIndex={position.index} onSelect={onSelectFile} />
            </span>
            <Button title={t('diff.prevFile')} disabled={!position.hasPrev} onClick={onPrev}>↑</Button>
            <span className={css.position}>
              {position.index === -1 ? '—' : position.index + 1} / {position.total}
            </span>
            <Button title={t('diff.nextFile')} disabled={!position.hasNext} onClick={onNext}>↓</Button>
          </>
        ) : null}
        {options === undefined ? null : (
          <>
            <span className={css.segmented} role="group" aria-label={t('diff.mode.title')}>
              <Button aria-pressed={options.mode === 'unified' || !options.splitAvailable} onClick={() => onOptions?.({ mode: 'unified' })}>{t('diff.mode.unified')}</Button>
              <Button
                aria-pressed={options.mode === 'split' && options.splitAvailable}
                disabled={!options.splitAvailable}
                title={options.splitAvailable ? t('diff.mode.title') : t('diff.mode.narrow')}
                onClick={() => onOptions?.({ mode: 'split' })}
              >
                {t('diff.mode.split')}
              </Button>
            </span>
            <Button aria-pressed={options.ignoreWhitespace} title={t('diff.ignoreWhitespace.title')} onClick={() => onOptions?.({ ignoreWhitespace: !options.ignoreWhitespace })}>{t('diff.ignoreWhitespace')}</Button>
            <Button aria-pressed={options.fullFile} title={t('diff.fullFile.title')} onClick={() => onOptions?.({ fullFile: !options.fullFile })}>{t('diff.fullFile')}</Button>
          </>
        )}
        <Button title={t('diff.copyPath.title')} onClick={() => onCopy(path)}>{t('diff.copyPath')}</Button>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// 内容区（§9.3 内容规则）
// ---------------------------------------------------------------------------

export interface DiffContentProps {
  request: DiffRequest
  value: DiffFileValue
  /** 同一请求重新加载中（保留旧内容，避免闪烁）。 */
  loading?: boolean
  highlighter?: CodeHighlighter
  viewportHeight?: number
  initialScrollTop?: number
  onScrollTopChange?: (scrollTop: number) => void
  onCopy?: (text: string) => void
  /** B3b：实际使用的显示模式。 */
  mode?: DiffMode
}

function BinaryPanel({ value }: { value: DiffFileValue }): ReactNode {
  const t = useT()
  return (
    <div className={css.binary} data-binary>
      <strong className={css.binaryTitle}>{t('diff.binary')}</strong>
      <dl className={css.binaryFacts}>
        {value.oldSize === undefined && value.oldSha === undefined ? null : (
          <>
            <dt>{t('diff.binary.old')}</dt>
            <dd>
              {value.oldSize === undefined ? '' : formatBytes(value.oldSize)}
              <code className={css.hash} title={value.oldSha}>{shortHash(value.oldSha)}</code>
            </dd>
          </>
        )}
        {value.newSize === undefined && value.newSha === undefined ? null : (
          <>
            <dt>{t('diff.binary.new')}</dt>
            <dd>
              {value.newSize === undefined ? '' : formatBytes(value.newSize)}
              <code className={css.hash} title={value.newSha}>{shortHash(value.newSha)}</code>
            </dd>
          </>
        )}
      </dl>
    </div>
  )
}

/**
 * 单个文件的 diff 内容：重命名头、截断提示、二进制/无变化/hunk 三选一。
 * @param props - 请求、结构化 diff 与渲染参数。
 * @returns 内容区。
 */
export function DiffContent({
  request,
  value,
  loading = false,
  highlighter,
  viewportHeight,
  initialScrollTop,
  onScrollTopChange,
  onCopy = copyToClipboard,
  mode = 'unified',
}: DiffContentProps): ReactNode {
  const t = useT()
  const renamed = value.oldPath !== null && value.newPath !== null && value.oldPath !== value.newPath
  const notice = truncationNotice(value)
  const command = terminalCommandFor(request)

  let body: ReactNode
  if (value.binary) {
    body = <BinaryPanel value={value} />
  } else if (hasNoTextChange(value)) {
    body = renamed ? (
      <EmptyState title={t('diff.renameOnly')} />
    ) : (
      request.ignoreWhitespace === true
        ? <EmptyState title={t('diff.noTextChange.whitespace')} />
        : <EmptyState title={t('diff.noTextChange')} hint={t('diff.noTextChange.hint')} />
    )
  } else {
    body = (
      <DiffHunks
        hunks={value.hunks}
        highlighter={highlighter}
        viewportHeight={viewportHeight}
        initialScrollTop={initialScrollTop}
        onScrollTopChange={onScrollTopChange}
        mode={mode}
      />
    )
  }

  return (
    <div className={css.content} data-loading={loading ? 'true' : undefined} aria-busy={loading ? true : undefined}>
      {renamed ? (
        <div className={css.rename} data-rename>
          <span title={value.oldPath ?? undefined}>{value.oldPath}</span>
          <span className={css.arrow} aria-hidden="true">→</span>
          <span title={value.newPath ?? undefined}>{value.newPath}</span>
        </div>
      ) : null}
      {notice === undefined ? null : (
        <div className={css.notice} data-truncated role="note">
          <span>{render(t, notice)}</span>
          <span className={css.terminal}>
            {t('diff.viewInTerminal')}<code className={css.command}>{command}</code>
            <Button title={t('diff.copyCommand')} onClick={() => onCopy(command)}>{t('diff.copyCommand')}</Button>
          </span>
        </div>
      )}
      {body}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 覆盖层视图（无 hook）
// ---------------------------------------------------------------------------

export interface DiffViewerViewProps {
  t: Translate
  /** 当前文件请求（store 关闭后仍用它渲染最后一帧）。 */
  request: DiffRequest
  state: DiffState
  files: readonly CommitFileEntry[]
  position: DiffViewerPosition
  source: readonly DiffSourcePart[]
  highlighter?: CodeHighlighter
  viewportHeight?: number
  initialScrollTop?: number
  onScrollTopChange?: (scrollTop: number) => void
  rootRef?: Ref<HTMLDivElement>
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onSelectFile: (file: CommitFileEntry) => void
  onCopy: (text: string) => void
  onRetry: () => void
  onKeyDown: (event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'preventDefault'>) => void
  /** B3b toolbar options (container-owned). */
  options?: DiffHeaderOptions
  onOptions?: (next: Partial<Omit<DiffHeaderOptions, 'splitAvailable'>>) => void
  mainRef?: Ref<HTMLDivElement>
}

/**
 * Diff 覆盖层的纯呈现部分。
 * @param props - 当前请求、diff 状态、文件列表与回调。
 * @returns 覆盖层。
 */
export function DiffViewerView({
  t,
  request,
  state,
  files,
  position,
  source,
  highlighter,
  viewportHeight,
  initialScrollTop,
  onScrollTopChange,
  rootRef,
  onClose,
  onPrev,
  onNext,
  onSelectFile,
  onCopy,
  onRetry,
  onKeyDown,
  options,
  onOptions,
  mainRef,
}: DiffViewerViewProps): ReactNode {
  const current = state.request ?? request
  const status = state.value?.status ?? files[position.index]?.status

  let main: ReactNode
  if (state.value !== null) {
    main = (
      <DiffContent
        key={requestKey(current)}
        request={current}
        value={state.value}
        loading={state.status === 'loading'}
        highlighter={highlighter}
        viewportHeight={viewportHeight}
        initialScrollTop={initialScrollTop}
        onScrollTopChange={onScrollTopChange}
        onCopy={onCopy}
        mode={options !== undefined && options.mode === 'split' && options.splitAvailable ? 'split' : 'unified'}
      />
    )
  } else if (state.status === 'error') {
    main = (
      <div className={css.state}>
        <EmptyState
          error
          title={t('diff.loadFailed')}
          hint={state.error?.message ?? t('action.retryHint')}
          action={{ label: t('action.retry'), onClick: onRetry }}
        />
      </div>
    )
  } else {
    main = <p className={css.loading} role="status">{t('diff.loading')}</p>
  }

  return (
    <div
      ref={rootRef}
      className={css.root}
      role="dialog"
      aria-label={t('diff.dialog', { path: current.path })}
      tabIndex={-1}
      data-diff-viewer
      onKeyDown={onKeyDown}
    >
      <DiffViewerHeader
        t={t}
        path={current.path}
        status={status}
        source={source}
        files={files}
        position={position}
        onClose={onClose}
        onPrev={onPrev}
        onNext={onNext}
        onSelectFile={onSelectFile}
        onCopy={onCopy}
        {...(options === undefined ? {} : { options })}
        {...(onOptions === undefined ? {} : { onOptions })}
      />
      <div className={css.body}>
        {files.length > 1 ? (
          <div className={css.sideList}>
            <DiffFileList t={t} files={files} currentIndex={position.index} onSelect={onSelectFile} />
          </div>
        ) : null}
        <div ref={mainRef} className={css.main}>{main}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 容器
// ---------------------------------------------------------------------------

export interface DiffViewerProps {
  /** 初始打开的文件；变化时（按 scope/sha/parent/path 判断）重新打开。 */
  request: DiffRequest
  /** diff 加载函数，通常是 `(request, signal) => client.diff(request, signal)`。 */
  load: DiffLoader
  /** 可切换的文件（提交的变更文件；合并提交分组里的条目带 parentSha）。变化不会重开当前文件。 */
  files?: readonly CommitFileEntry[]
  /** 来源面包屑，例如 [text('diff.source.log'), shortSha]。 */
  source?: readonly DiffSourcePart[]
  /** 返回（Esc / ← 返回）。参数是关闭前最后打开的请求，调用方据此恢复来源页选中。 */
  onClose: (last: DiffRequest | null) => void
  /** 在查看器内切换文件后回调，便于来源页同步文件选中。 */
  onSwitchFile?: (request: DiffRequest, file: CommitFileEntry) => void
  /** 复制实现；默认 navigator.clipboard。 */
  onCopy?: (text: string) => void
  /** 是否启用语法高亮（ui-primitives useCodeHighlighter）；默认 true。 */
  highlight?: boolean
  /**
   * 高亮 hook，默认 ui-primitives 的 useCodeHighlighter。测试注入替身：单测里 ui-primitives 经
   * link 解析到 DSH 仓库自己的 React 副本，直接调用其 hook 会触发 invalid hook call（运行时是同一份 React external）。
   */
  useHighlighter?: (language: string | undefined) => CodeHighlighter
}

const EMPTY_FILES: readonly CommitFileEntry[] = []

/** 由当前请求推出文件位置（首帧 effect 还没跑时也正确）。 */
function positionOf(files: readonly CommitFileEntry[], request: DiffRequest): DiffViewerPosition {
  const index = fileIndexOf(files, request)
  return { index, total: files.length, hasPrev: index > 0, hasNext: index !== -1 && index < files.length - 1 }
}
const EMPTY_SOURCE: readonly DiffSourcePart[] = []

/**
 * Diff 查看器容器：持有 diff store 与控制器，挂载即打开 `request`，卸载/关闭时中止 RPC。
 * 调用方需要把它放进 `position: relative` 的内容区（覆盖层用 absolute 铺满）。
 * @param props - 初始请求、加载函数、文件列表与回调。
 * @returns 覆盖层。
 */
export function DiffViewer({
  request,
  load,
  files = EMPTY_FILES,
  source = EMPTY_SOURCE,
  onClose,
  onSwitchFile,
  onCopy = copyToClipboard,
  highlight = true,
  useHighlighter = useCodeHighlighter,
}: DiffViewerProps): ReactNode {
  const t = useT()
  // 回调走 ref，避免调用方每次渲染传新函数时重建 store / 控制器。
  const loadRef = useRef(load)
  const onCloseRef = useRef(onClose)
  const onSwitchRef = useRef(onSwitchFile)
  const filesRef = useRef(files)
  loadRef.current = load
  filesRef.current = files
  onCloseRef.current = onClose
  onSwitchRef.current = onSwitchFile

  const store = useMemo(() => createDiffStore({ load: (value, signal) => loadRef.current(value, signal) }), [])
  const controller = useMemo(() => createDiffViewerController({
    store,
    files: () => filesRef.current,
    onClose: last => onCloseRef.current(last),
    onSwitchFile: (value, file) => onSwitchRef.current?.(value, file),
  }), [store])
  const state = useDiffState(store)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollTops = useRef(new Map<string, number>())

  const startKey = requestKey(request)
  useEffect(() => {
    void controller.start(request)
    // request 的身份由 startKey 描述；对象引用变化但内容相同不重新加载。
  }, [controller, startKey, request.sessionId])

  // 卸载时中止在途请求（不回调 onClose：调用方已经在关闭）。
  useEffect(() => () => store.close(), [store])

  // 打开即聚焦，保证 Esc 能被覆盖层收到。
  useEffect(() => { rootRef.current?.focus() }, [])

  const current = state.request ?? request
  const currentKey = requestKey(current)
  const highlighter = useHighlighter(highlight ? languageForPath(current.path) : undefined)

  // B3b: preferred mode (remembered), width gate for side-by-side, and the two diff options.
  const [mode, setMode] = useState<DiffMode>(() => readDiffMode())
  const [diffOptions, setDiffOptions] = useState<DiffViewOptions>({ ignoreWhitespace: false, context: 'default' })
  const mainRef = useRef<HTMLDivElement | null>(null)
  const [mainWidth, setMainWidth] = useState(0)
  useEffect(() => {
    const node = mainRef.current
    if (node === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(entries => { setMainWidth(entries[0]?.contentRect.width ?? 0) })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [])
  const headerOptions: DiffHeaderOptions = {
    mode,
    splitAvailable: mainWidth >= SPLIT_MIN_WIDTH,
    ignoreWhitespace: diffOptions.ignoreWhitespace,
    fullFile: diffOptions.context === 'full',
  }
  const changeOptions = (next: Partial<Omit<DiffHeaderOptions, 'splitAvailable'>>): void => {
    if (next.mode !== undefined) {
      setMode(next.mode)
      writeDiffMode(next.mode)
    }
    if (next.ignoreWhitespace === undefined && next.fullFile === undefined) return
    const updated: DiffViewOptions = {
      ignoreWhitespace: next.ignoreWhitespace ?? diffOptions.ignoreWhitespace,
      context: (next.fullFile ?? diffOptions.context === 'full') ? 'full' : 'default',
    }
    setDiffOptions(updated)
    void controller.setOptions(updated)
  }

  return (
    <DiffViewerView
      t={t}
      request={current}
      state={state}
      files={files}
      position={positionOf(files, current)}
      source={source}
      highlighter={highlighter}
      initialScrollTop={scrollTops.current.get(currentKey) ?? 0}
      onScrollTopChange={(top) => { scrollTops.current.set(currentKey, top) }}
      rootRef={rootRef}
      onClose={() => controller.close()}
      onPrev={() => { void controller.prev() }}
      onNext={() => { void controller.next() }}
      onSelectFile={(file) => { void controller.switchTo(file) }}
      onCopy={onCopy}
      onRetry={() => { void store.reload() }}
      onKeyDown={(event) => {
        if (controller.handleKey(event)) event.preventDefault()
      }}
      options={headerOptions}
      onOptions={changeOptions}
      mainRef={mainRef}
    />
  )
}
