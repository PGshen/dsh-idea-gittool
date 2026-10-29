// @vitest-environment happy-dom
// T1 (b3d review M3/M4/M7/M9): success notices for tag push / remote branch delete / upstream,
// the tag-push rejection reason, the worktree remove button's disabled reasons, and the URL hint.
import { act } from 'react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en, zh } from '../../../src/client/locales.ts'
import { text } from '../../../src/client/localized-text.ts'
import { ActionNotice } from '../../../src/client/pages/ActionNotice.tsx'
import { createBranchActionRunner, outcomeNotice, relayBranchRunnerDeps } from '../../../src/client/pages/branch-actions.ts'
import { RemoteBranchDeleteSheet, TagSheet, UpstreamSheet } from '../../../src/client/pages/RemoteSheets.tsx'
import { WorktreesPageView } from '../../../src/client/pages/RemotesPages.tsx'
import { actionErrorText } from '../../../src/client/store/action-store.ts'
import type { WorktreeEntry } from '../../../src/shared/protocol.ts'
import { allByRole, byRole, click, render } from '../dom.tsx'
import type { Rendered } from '../dom.tsx'
import { withLocale, zhT } from '../i18n-helpers.tsx'

let view: Rendered | null = null
afterEach(() => { view?.unmount(); view = null })

const done = { kind: 'done' as const, value: {} }

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

function submit(container: HTMLElement): void {
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (button === null) throw new Error('no submit button')
  click(button)
}

describe('success notices', () => {
  it('outcomeNotice turns a plain success into a success notice only when given a message', () => {
    const message = text('upstream.unset.done', { branch: 'feat' })
    expect(outcomeNotice(done, message)).toEqual({ tone: 'success', message })
    expect(outcomeNotice(done)).toBeNull()
    // A kept stash still wins over the success sentence.
    expect(outcomeNotice({ kind: 'done', value: { stashKept: true } }, message)?.tone).toBe('warning')
  })

  it('the notice bar announces a success politely', () => {
    view = render(withLocale(<ActionNotice notice={{ tone: 'success', message: text('upstream.unset.done', { branch: 'feat' }) }} onDismiss={() => {}} />) as ReactElement)
    const status = byRole(view.container, 'status')
    expect(status.getAttribute('data-notice')).toBe('success')
    expect(status.textContent).toContain('已取消 feat 的 upstream')
  })

  it('the workbench relay passes the success sentence through (review I1)', async () => {
    const onOutcome = vi.fn()
    const actions = { run: vi.fn(async () => done) } as never
    const target = { actions, openOverlay: () => {}, openPush: () => {}, copy: () => {}, showInLog: () => {}, filterLog: () => {}, onOutcome }
    const runner = createBranchActionRunner(relayBranchRunnerDeps(actions, () => target))
    await runner.run('unsetUpstream', { kind: 'local', name: 'feat', upstream: 'origin/feat' } as never, null)
    expect(onOutcome).toHaveBeenCalledWith(done, text('upstream.unset.done', { branch: 'feat' }))
  })

  it('unset upstream reports its success sentence', async () => {
    const onOutcome = vi.fn()
    const runner = createBranchActionRunner({
      actions: { run: vi.fn(async () => done) } as never,
      openOverlay: () => {}, openPush: () => {}, copy: () => {}, showInLog: () => {}, filterLog: () => {},
      onOutcome,
    })
    await runner.run('unsetUpstream', { kind: 'local', name: 'feat', upstream: 'origin/feat' } as never, null)
    expect(onOutcome).toHaveBeenCalledWith(done, text('upstream.unset.done', { branch: 'feat' }))
  })

  it('the tag push, remote branch delete and upstream sheets hand over their success sentence', async () => {
    const run = vi.fn(async () => done)
    const onOutcome = vi.fn()
    view = render(withLocale(<RemoteBranchDeleteSheet ref_="origin/topic" actions={{ run } as never} onOutcome={onOutcome} onClose={() => {}} />) as ReactElement)
    submit(view.container)
    await flush()
    expect(onOutcome).toHaveBeenLastCalledWith(done, text('remoteBranch.delete.done', { ref: 'origin/topic' }))
    view.unmount()

    view = render(withLocale(<UpstreamSheet branch="feat" remoteBranches={['origin/feat']} actions={{ run } as never} onOutcome={onOutcome} onClose={() => {}} />) as ReactElement)
    submit(view.container)
    await flush()
    expect(onOutcome).toHaveBeenLastCalledWith(done, text('upstream.set.done', { branch: 'feat', upstream: 'origin/feat' }))
    view.unmount()

    const loadRemotes = vi.fn(async () => ({ ok: true as const, value: { remotes: [{ name: 'origin', fetchUrl: 'x', pushUrl: 'x' }] } }))
    view = render(withLocale(<TagSheet mode="push" name="v1" loadRemotes={loadRemotes} actions={{ run } as never} onOutcome={onOutcome} onClose={() => {}} />) as ReactElement)
    await flush()
    submit(view.container)
    await flush()
    expect(run).toHaveBeenLastCalledWith('tagPush', { name: 'v1', remote: 'origin' }, expect.anything())
    expect(onOutcome).toHaveBeenLastCalledWith(done, text('tag.push.done', { name: 'v1', remote: 'origin' }))
  })
})

describe('tag push rejected', () => {
  it('shows git\'s own reason', () => {
    const message = actionErrorText({
      code: 'git/rejected',
      message: 'push of tag v1 to origin was rejected: [rejected] (already exists)',
      details: { target: 'tag', name: 'v1', remote: 'origin', summary: '[rejected] (already exists)', remoteMessage: '' },
    })
    expect(message).toEqual(text('tag.push.rejected', { name: 'v1', remote: 'origin', reason: '[rejected] (already exists)' }))
    const withHook = actionErrorText({
      code: 'git/rejected',
      message: 'x',
      details: { target: 'tag', name: 'v1', remote: 'origin', summary: '[remote rejected] (pre-receive hook declined)', remoteMessage: 'tags are frozen' },
    })
    expect(zhT(withHook.key, withHook.params)).toContain('tags are frozen')
  })

  it('names the Host\'s worktree refusals', () => {
    expect(actionErrorText({ code: 'git/invalid-payload', message: 'x', details: { reason: 'worktree-locked' } })).toEqual(text('worktrees.remove.locked'))
    expect(actionErrorText({ code: 'git/invalid-payload', message: 'x', details: { reason: 'main-worktree' } })).toEqual(text('worktrees.remove.main'))
  })
})

describe('worktree remove button', () => {
  const entry = (patch: Partial<WorktreeEntry>): WorktreeEntry => ({ path: '/r', head: 'a'.repeat(40), branch: 'main', current: false, locked: false, prunable: false, bare: false, main: false, ...patch })

  it('stays focusable but unavailable, with the reason, for the main, the current and a locked worktree', () => {
    const onAskRemove = vi.fn()
    const worktrees = [
      entry({ path: '/r', branch: 'main', main: true }),
      entry({ path: '/r/.worktrees/here', branch: 'here', current: true }),
      entry({ path: '/r/.worktrees/kept', branch: 'kept', locked: true }),
      entry({ path: '/r/.worktrees/free', branch: 'free' }),
    ]
    view = render(withLocale(<WorktreesPageView t={zhT} worktrees={worktrees} loadError={null} removing={null} busy={false} error={null} message={null} onAdd={() => {}} onPrune={() => {}} onCopy={() => {}} onAskRemove={onAskRemove} onRemove={() => {}} onBack={() => {}} />) as ReactElement)
    const buttons = allByRole(view.container, 'button', '删除…')
    expect(buttons).toHaveLength(4)
    const reasons = buttons.map((button) => {
      const described = button.getAttribute('aria-describedby')
      return described === null ? null : document.getElementById(described)?.textContent ?? ''
    })
    expect(reasons).toEqual([zh['worktrees.remove.main'], zh['worktrees.remove.current'], zh['worktrees.remove.locked'], null])
    for (const button of buttons.slice(0, 3)) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
      expect((button as HTMLButtonElement).disabled).toBe(false)
      click(button)
    }
    expect(onAskRemove).not.toHaveBeenCalled()
    click(buttons[3] as HTMLElement)
    expect(onAskRemove).toHaveBeenCalledWith({ path: '/r/.worktrees/free', force: false })
  })
})

describe('remote URL hint', () => {
  it('no longer promises that an empty URL keeps the old one (submit is disabled when empty)', () => {
    expect(zh['remotes.url.new']).not.toContain('留空')
    expect(en['remotes.url.new']).not.toMatch(/empty/iu)
  })
})
