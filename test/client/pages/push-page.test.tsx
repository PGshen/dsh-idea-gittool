/**
 * T6 Push / Push Rejected overlays: rendering of form defaults, risk gating, detached HEAD,
 * read-only, rejection reasons, protected → no force, auth command, outcome / Esc dispatch.
 * No DOM library: static markup assertions + invoking handlers on the element tree.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { zh } from '../../../src/client/locales.ts'
import { zhT } from '../i18n-helpers.tsx'
import type { CommitSummary, GitError, PushPreviewValue, PushRejectedDetails, PushRejectReason } from '../../../src/shared/protocol.ts'
import { defaultPushForm } from '../../../src/client/store/push-store.ts'
import type { PushState } from '../../../src/client/store/push-store.ts'
import {
  handlePushEscape,
  handlePushOutcome,
  PushPage,
  PushPageView,
} from '../../../src/client/pages/PushPage.tsx'
import type { PushPageViewProps } from '../../../src/client/pages/PushPage.tsx'
import {
  PushRejectedView,
  WriteErrorNotice,
} from '../../../src/client/pages/PushRejectedPage.tsx'
import type { PushRejectedViewProps } from '../../../src/client/pages/PushRejectedPage.tsx'

interface AnyElement { type: unknown; props: Record<string, unknown> & { children?: unknown } }

function isElement(node: unknown): node is AnyElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node
}

function findAll(node: unknown, predicate: (element: AnyElement) => boolean): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, predicate))
  if (!isElement(node)) return []
  const own = predicate(node) ? [node] : []
  return [...own, ...findAll(node.props.children, predicate)]
}

function invoke(element: AnyElement | undefined, name: string, ...args: unknown[]): void {
  const handler = element?.props[name]
  if (typeof handler !== 'function') throw new Error(`element has no ${name}`)
  ;(handler as (...values: unknown[]) => void)(...args)
}

const byData = (key: string) => (element: AnyElement): boolean => element.props[key] !== undefined

function commit(sha: string, subject: string): CommitSummary {
  return { sha, shortSha: sha.slice(0, 7), parents: [], author: 'Ann', email: 'a@x', date: '2026-10-26T00:00:00Z', subject }
}

function preview(overrides: Partial<PushPreviewValue> = {}): PushPreviewValue {
  return {
    remotes: ['origin', 'upstream'],
    branch: 'feat/login',
    detached: false,
    upstream: null,
    defaultRemote: 'origin',
    commits: [commit('a1b2c3d4e5', 'feat: login form'), commit('b2c3d4e5f6', 'test: login')],
    truncated: false,
    ...overrides,
  }
}

function readyState(overrides: Partial<PushState> = {}, value: PushPreviewValue = preview()): PushState {
  return {
    view: 'push',
    previewStatus: 'ready',
    preview: value,
    previewError: null,
    form: defaultPushForm(value, null),
    busy: null,
    error: null,
    rejected: null,
    rejectedFromPush: false,
    choice: 'rebase',
    choiceRiskConfirmed: false,
    autoRetryRejected: false,
    ...overrides,
  }
}

function pushProps(state: PushState, overrides: Partial<PushPageViewProps> = {}): PushPageViewProps {
  return {
    t: zhT,
    state,
    readOnlyReason: null,
    onClose: vi.fn(),
    onRetryLoad: vi.fn(),
    onFormChange: vi.fn(),
    onSubmit: vi.fn(),
    onCopy: vi.fn(),
    ...overrides,
  }
}

function rejection(reason: PushRejectReason, overrides: Partial<PushRejectedDetails> = {}): PushRejectedDetails {
  return {
    reason,
    remote: 'origin',
    branch: 'feat/login',
    remoteCommits: [commit('f00dbabe11', 'fix: remote change')],
    summary: '[rejected] feat/login (non-fast-forward)',
    ...overrides,
  }
}

function rejectedProps(details: PushRejectedDetails, overrides: Partial<PushState> = {}, props: Partial<PushRejectedViewProps> = {}): PushRejectedViewProps {
  return {
    t: zhT,
    state: readyState({ view: 'rejected', rejected: details, rejectedFromPush: true, ...overrides }),
    readOnlyReason: null,
    onBack: vi.fn(),
    onCancel: vi.fn(),
    onChoice: vi.fn(),
    onRiskChange: vi.fn(),
    onSubmit: vi.fn(),
    onCopy: vi.fn(),
    ...props,
  }
}

const primaryOf = (tree: unknown): AnyElement | undefined => findAll(tree, byData('data-primary'))[0]
const fieldOf = (tree: unknown, name: string): AnyElement | undefined =>
  findAll(tree, element => element.props['data-field'] === name)[0]

describe('PushPageView', () => {
  it('renders defaults: remote select, branch, set-upstream ticked and the commits to push', () => {
    const html = renderToStaticMarkup(<PushPageView {...pushProps(readyState())} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('<option value="origin" selected="">origin</option>')
    expect(html).toContain('value="feat/login"')
    expect(html).toMatch(/data-field="setUpstream"[^>]*checked=""|checked=""[^>]*data-field="setUpstream"/)
    expect(html).toContain('将推送 2 个提交')
    expect(html).toContain('feat: login form')
    expect(html).toContain('feat/login → origin/feat/login')
    expect(html).not.toContain('data-force-risk')
  })

  it('primary is enabled and submits on form submit; Enter goes through the form', () => {
    const props = pushProps(readyState())
    const tree = PushPageView(props)
    expect(primaryOf(tree)?.props.disabled).toBe(false)
    const form = findAll(tree, element => element.type === 'form')[0]
    invoke(form, 'onSubmit', { preventDefault: vi.fn() })
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('force-with-lease shows the impact and blocks until the risk tick', () => {
    const state = readyState()
    const forced = readyState({ form: { ...state.form, forceWithLease: true } })
    const props = pushProps(forced)
    const tree = PushPageView(props)
    const html = renderToStaticMarkup(<PushPageView {...props} />)
    expect(html).toContain('data-force-risk')
    expect(html).toContain(zh['push.forceRisk'])
    expect(html).toContain(zh['push.block.risk-unconfirmed'])
    expect(primaryOf(tree)?.props.disabled).toBe(true)
    expect(primaryOf(tree)?.props.tone).toBe('danger')
    invoke(findAll(tree, element => element.type === 'form')[0], 'onSubmit', { preventDefault: vi.fn() })
    expect(props.onSubmit).not.toHaveBeenCalled()

    const confirmed = PushPageView(pushProps(readyState({ form: { ...state.form, forceWithLease: true, riskConfirmed: true } })))
    expect(primaryOf(confirmed)?.props.disabled).toBe(false)
  })

  it('ticking the risk checkbox reports a form patch', () => {
    const state = readyState()
    const props = pushProps(readyState({ form: { ...state.form, forceWithLease: true } }))
    invoke(fieldOf(PushPageView(props), 'riskConfirmed'), 'onChange', { currentTarget: { checked: true } })
    expect(props.onFormChange).toHaveBeenCalledWith({ riskConfirmed: true })
  })

  it('detached HEAD: empty branch, explicit hint and blocked primary', () => {
    const value = preview({ branch: null, detached: true })
    const props = pushProps(readyState({}, value))
    const html = renderToStaticMarkup(<PushPageView {...props} />)
    expect(html).toContain(zh['push.detachedHint'])
    expect(html).toContain(zh['push.block.detached-branch'])
    expect(html).toContain('HEAD（detached） → origin/?')
    expect(primaryOf(PushPageView(props))?.props.disabled).toBe(true)
  })

  it('read-only disables the primary and shows the reason', () => {
    const props = pushProps(readyState(), { readOnlyReason: '仓库不在工作区内' })
    const html = renderToStaticMarkup(<PushPageView {...props} />)
    expect(html).toContain('只读模式：仓库不在工作区内')
    expect(primaryOf(PushPageView(props))?.props.disabled).toBe(true)
  })

  it('busy: loading label, primary and cancel disabled', () => {
    const props = pushProps(readyState({ busy: 'push' }))
    const tree = PushPageView(props)
    expect(primaryOf(tree)?.props.disabled).toBe(true)
    expect(primaryOf(tree)?.props['aria-busy']).toBe(true)
    expect(renderToStaticMarkup(<PushPageView {...props} />)).toContain(zh['push.submitting'])
  })

  it('loading, error and no-remote states', () => {
    const loading = readyState({ previewStatus: 'loading', preview: null })
    expect(renderToStaticMarkup(<PushPageView {...pushProps(loading)} />)).toContain(zh['push.loading'])
    const failed = readyState({ previewStatus: 'error', preview: null, previewError: { code: 'git/exec-failed', message: 'boom' } })
    const html = renderToStaticMarkup(<PushPageView {...pushProps(failed)} />)
    expect(html).toContain(zh['push.loadFailed'])
    expect(html).toContain('boom')
    const none = preview({ remotes: [], defaultRemote: null })
    expect(renderToStaticMarkup(<PushPageView {...pushProps(readyState({}, none))} />)).toContain(zh['push.noRemotes'])
  })

  it('empty and truncated commit lists', () => {
    expect(renderToStaticMarkup(<PushPageView {...pushProps(readyState({}, preview({ commits: [] })))} />)).toContain(zh['push.noCommits'])
    expect(renderToStaticMarkup(<PushPageView {...pushProps(readyState({}, preview({ truncated: true })))} />)).toContain('仅显示前 2 个提交')
  })

  it('auth-required shows the copyable terminal command', () => {
    const error: GitError = { code: 'git/auth-required', message: 'could not read Username', details: { command: 'git push -u origin feat/login' } }
    const html = renderToStaticMarkup(<PushPageView {...pushProps(readyState({ error }))} />)
    expect(html).toContain('data-auth-command')
    expect(html).toContain('git push -u origin feat/login')
    expect(html).toContain(zh['write.error.git/auth-required'])
  })
})

describe('WriteErrorNotice', () => {
  it('copy button copies the command; console button opens the console', () => {
    const onCopy = vi.fn()
    const onShowConsole = vi.fn()
    const tree = WriteErrorNotice({
      t: zhT,
      error: { code: 'git/auth-required', message: '', details: { command: 'git push origin main' } },
      onCopy,
      onShowConsole,
    })
    const buttons = findAll(tree, element => typeof element.props.onClick === 'function')
    invoke(buttons[0], 'onClick')
    expect(onCopy).toHaveBeenCalledWith('git push origin main')
    invoke(buttons[1], 'onClick')
    expect(onShowConsole).toHaveBeenCalledTimes(1)
  })

  it('other codes get an actionable title and no command', () => {
    const html = renderToStaticMarkup(<WriteErrorNotice t={zhT} error={{ code: 'git/locked', message: 'index.lock exists' }} onCopy={vi.fn()} />)
    expect(html).toContain(zh['write.error.git/locked'])
    expect(html).toContain('index.lock exists')
    expect(html).not.toContain('data-auth-command')
    const unknown = renderToStaticMarkup(<WriteErrorNotice t={zhT} error={{ code: 'git/exec-failed', message: 'x' }} onCopy={vi.fn()} />)
    expect(unknown).toContain(zh['write.error.fallback'])
  })
})

describe('PushRejectedView', () => {
  const reasons: PushRejectReason[] = ['non-fast-forward', 'fetch-first', 'stale-lease', 'protected', 'hook-declined', 'other']

  it.each(reasons)('renders the reason text for %s', (reason) => {
    const html = renderToStaticMarkup(<PushRejectedView {...rejectedProps(rejection(reason))} />)
    expect(html).toContain(zh[`rejected.reason.${reason}`])
    expect(html).toContain(`data-reason="${reason}"`)
  })

  it('shows the remote new commits, summary and rebase as the checked default', () => {
    const html = renderToStaticMarkup(<PushRejectedView {...rejectedProps(rejection('non-fast-forward'))} />)
    expect(html).toContain('远程新提交（1）')
    expect(html).toContain('fix: remote change')
    expect(html).toContain('[rejected] feat/login (non-fast-forward)')
    expect(html).toContain('checked="" value="rebase"')
    expect(html).toContain(zh['rejected.submitPull'])
  })

  it('protected branches get no force option', () => {
    const tree = PushRejectedView(rejectedProps(rejection('protected')))
    const radios = findAll(tree, element => element.type === 'input' && element.props.type === 'radio')
    expect(radios.map(radio => radio.props.value)).toEqual(['rebase', 'merge'])
    expect(renderToStaticMarkup(<PushRejectedView {...rejectedProps(rejection('protected'))} />)).toContain(zh['rejected.protectedNoForce'])
  })

  it('non-protected offers force; choosing reports the choice', () => {
    const props = rejectedProps(rejection('non-fast-forward'))
    const radios = findAll(PushRejectedView(props), element => element.type === 'input' && element.props.type === 'radio')
    expect(radios.map(radio => radio.props.value)).toEqual(['rebase', 'merge', 'force'])
    invoke(radios[2], 'onChange')
    expect(props.onChoice).toHaveBeenCalledWith('force')
  })

  it('force choice needs the risk tick before the danger button works', () => {
    const blocked = rejectedProps(rejection('non-fast-forward'), { choice: 'force' })
    const tree = PushRejectedView(blocked)
    expect(primaryOf(tree)?.props.disabled).toBe(true)
    expect(primaryOf(tree)?.props.tone).toBe('danger')
    const html = renderToStaticMarkup(<PushRejectedView {...blocked} />)
    expect(html).toContain('将用本地分支覆盖 origin/feat/login，远程上的 1 个提交会从该分支上消失。')
    expect(html).toContain(zh['rejected.block.risk-unconfirmed'])
    invoke(findAll(tree, element => element.type === 'form')[0], 'onSubmit', { preventDefault: vi.fn() })
    expect(blocked.onSubmit).not.toHaveBeenCalled()

    const ready = rejectedProps(rejection('non-fast-forward'), { choice: 'force', choiceRiskConfirmed: true })
    const readyTree = PushRejectedView(ready)
    expect(primaryOf(readyTree)?.props.disabled).toBe(false)
    invoke(findAll(readyTree, element => element.type === 'form')[0], 'onSubmit', { preventDefault: vi.fn() })
    expect(ready.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('busy labels per phase', () => {
    expect(renderToStaticMarkup(<PushRejectedView {...rejectedProps(rejection('fetch-first'), { busy: 'pull' })} />)).toContain(zh['rejected.busy.pull'])
    expect(renderToStaticMarkup(<PushRejectedView {...rejectedProps(rejection('fetch-first'), { busy: 'retry' })} />)).toContain(zh['rejected.busy.retry'])
  })

  it('auto-retry rejection notice and auth command', () => {
    const error: GitError = { code: 'git/auth-required', message: 'auth', details: { command: 'git pull --rebase origin feat/login' } }
    const html = renderToStaticMarkup(<PushRejectedView {...rejectedProps(rejection('non-fast-forward'), { autoRetryRejected: true, error })} />)
    expect(html).toContain(zh['rejected.autoRetryRejected'])
    expect(html).toContain('git pull --rebase origin feat/login')
  })

  it('read-only disables the action with the reason', () => {
    const props = rejectedProps(rejection('non-fast-forward'), {}, { readOnlyReason: '沙箱外' })
    expect(primaryOf(PushRejectedView(props))?.props.disabled).toBe(true)
    expect(renderToStaticMarkup(<PushRejectedView {...props} />)).toContain('只读模式：沙箱外')
  })
})

describe('handlePushOutcome', () => {
  it('pushed → onPushed then onClose', () => {
    const calls: string[] = []
    handlePushOutcome({ kind: 'pushed', value: { remote: 'origin', branch: 'main', updated: true } }, {
      onPushed: () => calls.push('pushed'),
      onConflict: () => calls.push('conflict'),
      onClose: () => calls.push('close'),
    })
    expect(calls).toEqual(['pushed', 'close'])
  })

  it('conflict → onConflict then onClose (banner + console take over)', () => {
    const onConflict = vi.fn()
    const onClose = vi.fn()
    const error: GitError = { code: 'git/conflict', message: 'conflict' }
    handlePushOutcome({ kind: 'conflict', error }, { onPushed: vi.fn(), onConflict, onClose })
    expect(onConflict).toHaveBeenCalledWith(error)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('rejected / failed / blocked keep the overlay', () => {
    const callbacks = { onPushed: vi.fn(), onConflict: vi.fn(), onClose: vi.fn() }
    handlePushOutcome({ kind: 'rejected', details: rejection('other') }, callbacks)
    handlePushOutcome({ kind: 'failed', error: { code: 'git/locked', message: '' } }, callbacks)
    handlePushOutcome({ kind: 'blocked' }, callbacks)
    expect(callbacks.onClose).not.toHaveBeenCalled()
  })
})

describe('handlePushEscape', () => {
  const keyEvent = (key: string) => ({ key, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() })

  it('closes from the push view and stops propagation', () => {
    const event = keyEvent('Escape')
    const actions = { back: vi.fn(), close: vi.fn() }
    handlePushEscape(event, readyState(), actions)
    expect(actions.close).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalled()
  })

  it('goes back from a rejection reached via the push page', () => {
    const actions = { back: vi.fn(), close: vi.fn() }
    handlePushEscape(keyEvent('Escape'), readyState({ view: 'rejected', rejected: rejection('other'), rejectedFromPush: true }), actions)
    expect(actions.back).toHaveBeenCalledTimes(1)
    expect(actions.close).not.toHaveBeenCalled()
  })

  it('ignores Esc while busy and ignores other keys', () => {
    const actions = { back: vi.fn(), close: vi.fn() }
    handlePushEscape(keyEvent('Escape'), readyState({ busy: 'pull' }), actions)
    handlePushEscape(keyEvent('Enter'), readyState(), actions)
    expect(actions.back).not.toHaveBeenCalled()
    expect(actions.close).not.toHaveBeenCalled()
  })
})

describe('PushPage container (first render)', () => {
  const client = {
    pushPreview: vi.fn(async () => ({ ok: true as const, value: preview() })),
    push: vi.fn(),
    pullForPush: vi.fn(),
  }

  it('starts on the loading push view without sending any write', () => {
    const html = renderToStaticMarkup(
      <PushPage sessionId="s1" repoRoot="/repo" client={client as never} storage={null} onClose={vi.fn()} onPushed={vi.fn()} onConflict={vi.fn()} />,
    )
    expect(html).toContain(zh['push.loading'])
    expect(client.push).not.toHaveBeenCalled()
  })

  it('opens directly on Push Rejected with an initial rejection', () => {
    const html = renderToStaticMarkup(
      <PushPage
        sessionId="s1"
        repoRoot="/repo"
        client={client as never}
        storage={null}
        initialRejection={rejection('fetch-first')}
        onClose={vi.fn()}
        onPushed={vi.fn()}
        onConflict={vi.fn()}
      />,
    )
    expect(html).toContain(zh['rejected.reason.fetch-first'])
    expect(client.pullForPush).not.toHaveBeenCalled()
  })
})
