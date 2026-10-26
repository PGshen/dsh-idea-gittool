// 仓库栏（设计 §7.1）：仓库名 + 截断路径 + 非 Wide 档的「分支」入口 + `⋯` 菜单（刷新 / Git 控制台）。
// 获取/拉取/推送各自打开自己的表单（A3 T8 起获取与拉取在此）；只读或操作进行中时禁用并说明原因。
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useT } from '../i18n.tsx'
import type { PanelMode } from './branch-store.ts'
import css from './RepoBar.module.css'

export interface RepoBarProps {
  repoRoot: string | null
  onRefresh: () => void
  onOpenConsole: () => void
  /** 刷新进行中：禁用刷新项。 */
  refreshing?: boolean
  /** 当前档位；非 Wide 档且传了 onToggleBranches 时显示「分支」入口。 */
  mode?: PanelMode
  onToggleBranches?: () => void
  branchesOpen?: boolean
  /** 控制台里有失败命令时在 ⋯ 上加提示点。 */
  consoleHasErrors?: boolean
  /** 打开 Push 页（设计 §6 仓库栏「推送」）；未传时不显示。 */
  onPush?: () => void
  /** 待推送提交数，>0 时按钮带 ↑n。 */
  ahead?: number
  /** 打开获取弹层（A3 T8）；未传时不显示。 */
  onFetch?: () => void
  /** 获取进行中（同一个获取动作在别处运行）。 */
  fetching?: boolean
  /** 非空时获取按钮禁用，内容作为 title。 */
  fetchDisabledReason?: string | null
  /** 打开拉取页（A3 T8）；未传时不显示。 */
  onPull?: () => void
  /** 非空时拉取按钮禁用，内容作为 title。 */
  pullDisabledReason?: string | null
  /** 初始展开菜单（测试/静态渲染用）。 */
  defaultMenuOpen?: boolean
  /** 路径展示的最大字符数。 */
  maxPathChars?: number
}

/** 中间省略：保留开头约 40% 与结尾，总长恰好为 max。 */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max || max < 4) return text
  const keep = max - 1
  const head = Math.floor(keep * 0.4)
  const tail = keep - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** 仓库目录名：路径最后一段（兼容结尾分隔符与 Windows 路径）。 */
export function repoName(repoRoot: string | null): string {
  if (repoRoot === null) return ''
  const parts = repoRoot.split(/[\\/]+/).filter(part => part !== '')
  return parts.at(-1) ?? repoRoot
}

export function RepoBar(props: RepoBarProps): ReactNode {
  const t = useT()
  const { repoRoot, refreshing = false, mode = 'wide', maxPathChars = 48 } = props
  const [menuOpen, setMenuOpen] = useState(props.defaultMenuOpen === true)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current !== null && event.target instanceof Node && menuRef.current.contains(event.target)) return
      setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [menuOpen])

  const choose = (action: () => void): void => {
    setMenuOpen(false)
    action()
  }

  return (
    <div className={css.bar} data-dsh-git-repo-bar="">
      <span className={css.repoIcon} aria-hidden="true">▦</span>
      {repoRoot === null
        ? <span className={css.placeholder}>{t('repo.none')}</span>
        : (
            <span className={css.repo} title={repoRoot}>
              <strong className={css.name}>{repoName(repoRoot)}</strong>
              <span className={css.path}>{truncateMiddle(repoRoot, maxPathChars)}</span>
            </span>
          )}
      <span className={css.spacer} />
      {mode !== 'wide' && props.onToggleBranches !== undefined
        ? (
            <button
              type="button"
              className={css.button}
              data-branches-toggle=""
              aria-pressed={props.branchesOpen === true}
              onClick={props.onToggleBranches}
            >
              {t('repo.branches')}
            </button>
          )
        : null}
      {props.onFetch === undefined
        ? null
        : (
            <button
              type="button"
              className={css.button}
              data-repo-fetch=""
              aria-busy={props.fetching === true ? true : undefined}
              disabled={props.fetching === true || (props.fetchDisabledReason ?? null) !== null}
              {...(props.fetchDisabledReason ? { title: props.fetchDisabledReason } : {})}
              onClick={props.onFetch}
            >
              {props.fetching === true ? t('repo.fetching') : t('repo.fetch')}
            </button>
          )}
      {props.onPull === undefined
        ? null
        : (
            <button
              type="button"
              className={css.button}
              data-repo-pull=""
              disabled={(props.pullDisabledReason ?? null) !== null}
              {...(props.pullDisabledReason ? { title: props.pullDisabledReason } : {})}
              onClick={props.onPull}
            >
              {t('repo.pull')}
            </button>
          )}
      {props.onPush === undefined
        ? null
        : (
            <button type="button" className={css.button} data-repo-push="" onClick={props.onPush}>
              {t('repo.push')}
              {(props.ahead ?? 0) > 0 ? ` ↑${String(props.ahead)}` : ''}
            </button>
          )}
      <div className={css.menuAnchor} ref={menuRef}>
        <button
          type="button"
          className={css.button}
          aria-label={t('repo.more')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(open => !open)}
        >
          ⋯
          {props.consoleHasErrors === true ? <span className={css.dot} data-console-errors="true" aria-label={t('repo.consoleErrors')} /> : null}
        </button>
        {menuOpen
          ? (
              <div
                role="menu"
                className={css.menu}
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenuOpen(false) } }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={css.menuItem}
                  disabled={refreshing}
                  aria-busy={refreshing}
                  onClick={() => choose(props.onRefresh)}
                >
                  {refreshing ? t('repo.refreshing') : t('action.refresh')}
                </button>
                <button type="button" role="menuitem" className={css.menuItem} onClick={() => choose(props.onOpenConsole)}>
                  {t('console.title')}
                </button>
              </div>
            )
          : null}
      </div>
    </div>
  )
}
