/**
 * `git.blame` page body for M0: an empty state that proves the document
 * header's action can open a page type and hand it the file it acted on. The
 * line-level blame data arrives in B2 from the Host RPC.
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Loads the SlotMap declarations for 'sidebar.right.pane.tab'.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import css from './blame-page.module.css'

/** The file a blame page was opened for. */
export interface BlameTarget {
  /** Absolute path in the file's execution environment. */
  readonly absolutePath: string
  /** Repo-relative POSIX path, when the opener could derive it. */
  readonly repoRelativePath?: string
}

/** Props of the tab body: the framework's bound tab reader. */
export type BlamePageProps = PropsRuntime<'sidebar.right.pane.tab'>

/**
 * Narrow the opaque navigation parameters to a blame target.
 * @param params - `tab.navigation.params`, typed only as a union by the Sidebar.
 * @returns the target, or null when the opener gave no usable absolute path.
 */
export function readBlameTarget(params: unknown): BlameTarget | null {
  if (typeof params !== 'object' || params === null) return null
  const candidate = params as { absolutePath?: unknown; repoRelativePath?: unknown }
  if (typeof candidate.absolutePath !== 'string' || candidate.absolutePath.length === 0) return null
  if (typeof candidate.repoRelativePath === 'string' && candidate.repoRelativePath.length > 0) {
    return { absolutePath: candidate.absolutePath, repoRelativePath: candidate.repoRelativePath }
  }
  return { absolutePath: candidate.absolutePath }
}

/**
 * Render the M0 empty state, including the file it would annotate.
 * @param props - the target, or null when the tab opened without one.
 * @returns the page body.
 */
export function BlameEmptyState(props: { readonly target: BlameTarget | null }): ReactNode {
  const { target } = props
  return (
    <div className={`git-blame-page ${css.page}`}>
      <h2 className={`git-blame-page__title ${css.title}`}>Blame 视图将在 B2 实现</h2>
      {target === null
        ? <p className={`git-blame-page__missing ${css.body}`}>未提供文件路径，无法定位要标注的文件。</p>
        : (
          <div className="git-blame-page__target">
            <p className={css.body}>
              文件：<code>{target.absolutePath}</code>
            </p>
            {target.repoRelativePath === undefined
              ? null
              : (
                <p className={css.body}>
                  仓库相对路径：<code>{target.repoRelativePath}</code>
                </p>
              )}
          </div>
        )}
      <p className={`git-blame-page__note ${css.muted}`}>
        M0 只验证文档预览头部动作与 openTab 跳转；行级 blame 数据由 Host RPC 在 B2 提供。
      </p>
    </div>
  )
}

/**
 * The registered tab body: read the file from the tab's navigation parameters.
 * @param props - framework props carrying the bound `useTabInfo` reader.
 * @returns the empty-state body.
 */
export function BlamePage({ useTabInfo }: BlamePageProps): ReactNode {
  const { tab } = useTabInfo()
  return <BlameEmptyState target={readBlameTarget(tab.navigation.params)} />
}
