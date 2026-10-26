// A3 T8 integrate forms (views are hook-free, so static rendering shows their gating and defaults).
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CommitContextMenu } from '../../../src/client/pages/CommitContextMenu.tsx'
import { commitActions } from '../../../src/client/pages/commit-actions.ts'
import { CommitOpSheetView } from '../../../src/client/pages/CommitOpSheet.tsx'
import { FetchSheetView } from '../../../src/client/pages/FetchSheet.tsx'
import { MergePageView, mergeBranchOptions, mergeCanSubmit } from '../../../src/client/pages/MergePage.tsx'
import { PullPageView, pullCanSubmit } from '../../../src/client/pages/PullPage.tsx'
import { ResetSheetView } from '../../../src/client/pages/ResetSheet.tsx'
import { UpdateProjectPageView } from '../../../src/client/pages/UpdateProjectPage.tsx'
import { initialSheetForm } from '../../../src/client/pages/BranchSheets.tsx'
import { routeResult } from '../../../src/client/pages/integrate-parts.tsx'
import { OVERLAY_LEVEL } from '../../../src/client/pages/workbench-overlay.ts'
import { zh } from '../../../src/client/locales.ts'
import { text } from '../../../src/client/localized-text.ts'
import { zhT } from '../i18n-helpers.tsx'
import { branchesFixture } from './branch-fixtures.ts'
import type { ResetPreviewValue } from '../../../src/shared/protocol.ts'

const noop = (): void => {}
const SHA = 'a'.repeat(40)

describe('merge / rebase page', () => {
  it('branch options: local (not the current one) then remote, with the preselected ref always present', () => {
    const options = mergeBranchOptions(branchesFixture(), 'main', undefined)
    expect(options[0]).toBe('feat/login')
    expect(options).not.toContain('main')
    expect(options.some(name => name.startsWith('origin/'))).toBe(true)
    expect(mergeBranchOptions(branchesFixture(), 'main', 'v1.0')).toContain('v1.0')
    expect(mergeBranchOptions(null, 'main', undefined)).toEqual([])
  })

  it('submit needs a target and no write block', () => {
    expect(mergeCanSubmit({ target: '', option: 'default' }, undefined, false)).toBe(false)
    expect(mergeCanSubmit({ target: 'x', option: 'default' }, undefined, false)).toBe(true)
    expect(mergeCanSubmit({ target: 'x', option: 'default' }, text('branch.disabled.readOnly'), false)).toBe(false)
    expect(mergeCanSubmit({ target: 'x', option: 'default' }, undefined, true)).toBe(false)
  })

  const view = (mode: 'merge' | 'rebase', extra: Record<string, unknown> = {}) => renderToStaticMarkup(
    <MergePageView
      t={zhT} mode={mode} current="main" options={['feat/login', 'origin/main']}
      form={{ target: 'feat/login', option: 'squash' }} busy={false} error={null}
      onChange={noop} onSubmit={noop} onBack={noop} {...extra}
    />,
  )

  it('merge shows the four merge choices with the remembered one checked; rebase has none', () => {
    const merge = view('merge')
    for (const option of ['default', 'noFf', 'squash', 'noCommit']) expect(merge).toContain(`data-merge-option="${option}"`)
    expect(merge).toMatch(/data-merge-option="squash"[^>]*checked|checked[^>]*data-merge-option="squash"/)
    expect(merge).toContain('data-primary')
    expect(view('rebase')).not.toContain('data-merge-option')
  })

  it('a write block is shown and disables the primary button', () => {
    const html = view('merge', { block: text('branch.disabled.readOnly') })
    expect(html).toContain(zh['branch.disabled.readOnly'])
    expect(html).toMatch(/disabled=""[^>]*data-primary|data-primary[^>]*disabled=""/)
  })
})

describe('pull page', () => {
  it('submit needs remote and branch', () => {
    const ok = { remote: 'origin', branch: 'main', mode: 'merge' as const }
    expect(pullCanSubmit(ok, undefined, false)).toBe(true)
    expect(pullCanSubmit({ ...ok, branch: ' ' }, undefined, false)).toBe(false)
    expect(pullCanSubmit({ ...ok, remote: '' }, undefined, false)).toBe(false)
    expect(pullCanSubmit(ok, text('branch.disabled.detached'), false)).toBe(false)
  })

  it('shows the remembered mode and the loaded remotes', () => {
    const html = renderToStaticMarkup(
      <PullPageView
        t={zhT} loading={false} loadError={null} remotes={['origin', 'upstream']} branchOptions={['main']}
        form={{ remote: 'origin', branch: 'main', mode: 'rebase' }} busy={false} error={null}
        onChange={noop} onSubmit={noop} onBack={noop} onRetry={noop}
      />,
    )
    expect(html).toContain('data-pull-remote')
    expect(html).toContain('upstream')
    expect(html).toMatch(/data-pull-mode="rebase"[^>]*checked|checked[^>]*data-pull-mode="rebase"/)
  })
})

describe('update project page', () => {
  const view = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(
    <UpdateProjectPageView
      t={zhT} mode="merge" stashNote={false} noUpstream={false} rewritten={null} backup busy={false} error={null}
      onModeChange={noop} onBackupChange={noop} onSubmit={noop} onResetToRemote={noop} onBack={noop} {...extra}
    />,
  )

  it('shows the "will stash first" note only when there are tracked changes', () => {
    expect(view()).not.toContain('data-stash-note')
    expect(view({ stashNote: true })).toContain('data-stash-note')
  })

  it('without an upstream the submit is disabled and says why', () => {
    const html = view({ noUpstream: true })
    expect(html).toContain(zh['integrate.update.noUpstream'])
    expect(html).toMatch(/disabled=""[^>]*data-primary|data-primary[^>]*disabled=""/)
  })

  it('upstream rewritten: explanation, reset-to-remote with the backup ticked by default, cancel', () => {
    const html = view({ rewritten: { localAhead: 3 } })
    expect(html).toContain('data-upstream-rewritten')
    expect(html).toContain(zh['integrate.update.rewritten.reset'])
    expect(html).toMatch(/data-backup[^>]*checked|checked[^>]*data-backup/)
    expect(html).not.toContain('data-stash-note')
    expect(html).toContain('data-cancel')
    expect(view({ rewritten: { localAhead: 3 }, backup: false })).not.toMatch(/data-backup[^>]*checked|checked[^>]*data-backup/)
  })

  it('carry 5: the rewritten view focuses Cancel first (Enter cannot reset) and says local commits survive only in the backup', () => {
    const html = view({ rewritten: { localAhead: 3 } })
    expect(html).toMatch(/<button[^>]*data-cancel[^>]*data-autofocus|<button[^>]*data-autofocus[^>]*data-cancel/)
    expect(html).not.toMatch(/data-backup[^>]*data-autofocus|data-autofocus[^>]*data-backup/)
    expect(html).toContain(zh['integrate.update.rewritten.backupOnly'])
    expect(zh['integrate.update.rewritten.backupOnly']).toContain('备份分支')
    // The normal view keeps its own focus target (the mode radio), not Cancel.
    expect(view()).not.toMatch(/<button[^>]*data-cancel[^>]*data-autofocus/)
  })
})

describe('reset sheet', () => {
  const preview: ResetPreviewValue = {
    head: 'h'.repeat(40), discardCount: 3, truncated: false,
    commitsLost: [{ sha: 'c'.repeat(40), shortSha: 'ccccccc', parents: [], author: 'a', email: 'e', date: '2026-10-25T00:00:00Z', subject: 'lost commit' }],
  }
  const view = (mode: 'soft' | 'mixed' | 'hard', hardConfirmed: boolean, p: ResetPreviewValue | null = preview) => renderToStaticMarkup(
    <ResetSheetView
      t={zhT} sha={SHA} preview={p} loading={p === null} loadError={null} form={{ mode, hardConfirmed }} busy={false} error={null}
      onChange={noop} onSubmit={noop} onCancel={noop} onRetry={noop}
    />,
  )
  const primaryDisabled = (html: string): boolean => /disabled=""[^>]*data-primary|data-primary[^>]*disabled=""/.test(html)

  it('shows the three modes and the commits that would be lost', () => {
    const html = view('mixed', false)
    for (const mode of ['soft', 'mixed', 'hard']) expect(html).toContain(`data-reset-mode="${mode}"`)
    expect(html).toContain('lost commit')
    expect(primaryDisabled(html)).toBe(false)
  })

  it('hard shows the discard count and needs the risk tick before the button works', () => {
    const html = view('hard', false)
    expect(html).toContain('data-reset-risk')
    expect(primaryDisabled(html)).toBe(true)
    expect(primaryDisabled(view('hard', true))).toBe(false)
    expect(view('mixed', false)).not.toContain('data-reset-risk')
  })

  it('cannot submit before the preview is loaded', () => {
    expect(primaryDisabled(view('mixed', false, null))).toBe(true)
  })
})

describe('fetch sheet', () => {
  const view = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(
    <FetchSheetView
      t={zhT} remotes={['origin', 'upstream']} loading={false} form={{ remote: null, prune: false }} busy={false} error={null} result={null}
      onChange={noop} onSubmit={noop} onCancel={noop} {...extra}
    />,
  )
  it('offers "all remotes" first and each remote after it, plus prune', () => {
    const html = view()
    expect(html).toContain(zh['integrate.fetch.all'])
    expect(html).toContain('upstream')
    expect(html).toContain('data-fetch-prune')
  })
  it('after success shows the result and a close button instead of the form', () => {
    const html = view({ result: text('integrate.fetch.updated', { count: 4 }) })
    expect(html).toContain('更新了 4 个引用')
    expect(html).not.toContain('data-fetch-prune')
  })
})

describe('commit operation sheet', () => {
  it('names the operation and the commit, and uses the verb as the button', () => {
    const html = renderToStaticMarkup(
      <CommitOpSheetView t={zhT} op="revert" shortSha="aaaaaaa" subject="feat: x" busy={false} error={null} onSubmit={noop} onCancel={noop} />,
    )
    expect(html).toContain('aaaaaaa')
    expect(html).toContain('feat: x')
    expect(html).toContain(zh['integrate.commitOp.revert.submit'])
  })
})

describe('commit context menu', () => {
  it('renders items with danger and disabled reasons', () => {
    const commit = { sha: SHA, shortSha: 'aaaaaaa', parents: ['b'.repeat(40), 'c'.repeat(40)], author: 'a', email: 'e', date: '', subject: 's' }
    const html = renderToStaticMarkup(
      <CommitContextMenu
        commit={commit}
        items={commitActions(commit, { writable: true, operation: null, parentLoaded: true, childLoaded: false })}
        onSelect={noop}
      />,
    )
    expect(html).toContain('role="menu"')
    expect(html).toContain('data-action="resetTo"')
    expect(html).toMatch(/data-action="resetTo"[^>]*data-danger|data-danger[^>]*data-action="resetTo"/)
    expect(html).toContain(zh['commit.disabled.mergeParent'])
    expect(html).toMatch(/data-action="cherryPick"[^>]*aria-disabled|aria-disabled[^>]*data-action="cherryPick"/)
  })
})

describe('overlay kinds and branch sheet prefill', () => {
  it('fetch and commitOp are sheets (level 2)', () => {
    expect(OVERLAY_LEVEL.fetch).toBe(2)
    expect(OVERLAY_LEVEL.commitOp).toBe(2)
  })
  it('the checkout-revision sheet can be prefilled with a commit', () => {
    const form = initialSheetForm({ kind: 'branchSheet', mode: 'checkoutRevision', revision: SHA })
    expect(form.revision).toBe(SHA)
  })
})

describe('routeResult (the form may be gone when a smart operation finishes)', () => {
  const failure = text('action.error.fallback', { code: 'git/exec-failed', message: 'boom' })
  function setup() {
    const options = { onOutcome: vi.fn(), onNotice: vi.fn(), onClose: vi.fn() }
    return { options, showError: vi.fn() }
  }

  it('mounted: success is reported and the overlay closed; an error stays in the form', () => {
    const { options, showError } = setup()
    const outcome = { kind: 'done', value: {} } as const
    routeResult({ kind: 'closed', outcome }, true, options, {}, showError)
    expect(options.onOutcome).toHaveBeenCalledWith(outcome)
    expect(options.onClose).toHaveBeenCalledTimes(1)
    routeResult({ kind: 'error', message: failure }, true, options, {}, showError)
    expect(showError).toHaveBeenCalledWith(failure)
    expect(options.onNotice).not.toHaveBeenCalled()
  })

  it('unmounted (replaced by the stash question): success still reported, no second close, failure becomes a notice', () => {
    const { options, showError } = setup()
    routeResult({ kind: 'closed', outcome: { kind: 'done', value: {} } }, false, options, {}, showError)
    expect(options.onOutcome).toHaveBeenCalledTimes(1)
    expect(options.onClose).not.toHaveBeenCalled()
    routeResult({ kind: 'error', message: failure }, false, options, {}, showError)
    expect(options.onNotice).toHaveBeenCalledWith({ tone: 'error', message: failure })
    expect(showError).not.toHaveBeenCalled()
  })

  it('stay (stash question cancelled) does nothing; stale and rewritten reach their hooks only while mounted', () => {
    const { options, showError } = setup()
    const hooks = { stale: vi.fn(), rewritten: vi.fn() }
    routeResult({ kind: 'stay' }, true, options, hooks, showError)
    expect(options.onOutcome).not.toHaveBeenCalled()
    routeResult({ kind: 'error', message: failure, stale: true }, true, options, hooks, showError)
    expect(hooks.stale).toHaveBeenCalledTimes(1)
    routeResult({ kind: 'rewritten', localAhead: 2 }, true, options, hooks, showError)
    expect(hooks.rewritten).toHaveBeenCalledWith(2)
    routeResult({ kind: 'rewritten', localAhead: 2 }, false, options, hooks, showError)
    expect(options.onNotice).toHaveBeenCalledTimes(1)
  })
})
