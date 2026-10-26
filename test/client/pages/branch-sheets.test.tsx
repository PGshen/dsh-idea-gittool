// A3 T7 branch sheets (new / rename / delete / checkout revision) and the smart checkout sheet.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CheckoutTarget, GitError } from '../../../src/shared/protocol.ts'
import { createBranchActionRunner } from '../../../src/client/pages/branch-actions.ts'
import { BranchSheetView, sheetCanSubmit, submitBranchSheet } from '../../../src/client/pages/BranchSheets.tsx'
import type { BranchSheetOverlay, SheetForm } from '../../../src/client/pages/BranchSheets.tsx'
import { SmartCheckoutSheetView, submitSmartCheckout } from '../../../src/client/pages/SmartCheckoutSheet.tsx'
import { text } from '../../../src/client/localized-text.ts'
import type { ActionOutcome } from '../../../src/client/store/action-store.ts'
import { zh } from '../../../src/client/locales.ts'
import { zhT } from '../i18n-helpers.tsx'

const trigger = { focus() {}, isConnected: true }
const SHA = 'bbb1111222233334444555566667777888899991'

function form(overrides: Partial<SheetForm> = {}): SheetForm {
  return { name: '', checkout: true, revision: '', force: false, forceConfirmed: false, ...overrides }
}

function failed(code: GitError['code'], details?: Record<string, unknown>): ActionOutcome<unknown> {
  const error: GitError = details === undefined ? { code, message: code } : { code, message: code, details }
  return { kind: 'failed', error, message: text('action.error.fallback', { code, message: code }) }
}

function harness(runImpl: (endpoint: string, payload: unknown) => Promise<ActionOutcome<unknown>>) {
  const run = vi.fn(runImpl)
  const opened: unknown[] = []
  const onOutcome = vi.fn()
  const actions = { run: run as never }
  const runner = createBranchActionRunner({
    actions,
    openOverlay: (overlay) => { opened.push(overlay) },
    copy: vi.fn(),
    showInLog: vi.fn(),
    filterLog: vi.fn(),
    openPush: vi.fn(),
    onOutcome,
  })
  return { deps: { actions, runner, onOutcome, trigger }, run, opened, onOutcome }
}

const newOverlay: BranchSheetOverlay = { kind: 'branchSheet', mode: 'new', startPoint: 'feat/login' }
const renameOverlay: BranchSheetOverlay = { kind: 'branchSheet', mode: 'rename', branch: 'feat/login' }
const deleteOverlay: BranchSheetOverlay = { kind: 'branchSheet', mode: 'delete', branch: 'feat/login', sha: SHA }
const revisionOverlay: BranchSheetOverlay = { kind: 'branchSheet', mode: 'checkoutRevision' }

describe('sheetCanSubmit', () => {
  it('new: needs a valid non-empty name', () => {
    expect(sheetCanSubmit(newOverlay, form())).toBe(false)
    expect(sheetCanSubmit(newOverlay, form({ name: 'a b' }))).toBe(false)
    expect(sheetCanSubmit(newOverlay, form({ name: 'feat/x' }))).toBe(true)
  })
  it('rename: needs a valid name different from the old one', () => {
    expect(sheetCanSubmit(renameOverlay, form({ name: 'feat/login' }))).toBe(false)
    expect(sheetCanSubmit(renameOverlay, form({ name: 'feat/signin' }))).toBe(true)
  })
  it('delete: always allowed; the forced stage needs the confirmation checkbox', () => {
    expect(sheetCanSubmit(deleteOverlay, form())).toBe(true)
    expect(sheetCanSubmit(deleteOverlay, form({ force: true }))).toBe(false)
    expect(sheetCanSubmit(deleteOverlay, form({ force: true, forceConfirmed: true }))).toBe(true)
  })
  it('checkout revision: needs a non-blank revision', () => {
    expect(sheetCanSubmit(revisionOverlay, form({ revision: '  ' }))).toBe(false)
    expect(sheetCanSubmit(revisionOverlay, form({ revision: 'v1.0' }))).toBe(true)
  })
})

describe('submitBranchSheet', () => {
  it('new: createBranch with the trimmed name, the start point and the checkout flag', async () => {
    const { deps, run, onOutcome } = harness(async () => ({ kind: 'done', value: { branch: 'feat/x', sha: SHA, checkedOut: true } }))
    const result = await submitBranchSheet(deps, newOverlay, form({ name: ' feat/x ', checkout: false }))
    expect(run).toHaveBeenCalledWith('createBranch', { name: 'feat/x', startPoint: 'feat/login', checkout: false }, { trigger })
    expect(result).toEqual({ kind: 'closed' })
    expect(onOutcome).toHaveBeenCalledTimes(1)
  })

  it('new without a start point branches from HEAD', async () => {
    const { deps, run } = harness(async () => ({ kind: 'done', value: {} }))
    await submitBranchSheet(deps, { kind: 'branchSheet', mode: 'new' }, form({ name: 'x' }))
    expect(run).toHaveBeenCalledWith('createBranch', { name: 'x', startPoint: 'HEAD', checkout: true }, { trigger })
  })

  it('new: a duplicate name keeps the sheet open with the localized error', async () => {
    const { deps } = harness(async () => failed('git/branch-exists', { branch: 'feat/x' }))
    const result = await submitBranchSheet(deps, newOverlay, form({ name: 'feat/x' }))
    expect(result.kind).toBe('error')
  })

  it('rename: renameBranch from → to', async () => {
    const { deps, run } = harness(async () => ({ kind: 'done', value: { branch: 'b' } }))
    await submitBranchSheet(deps, renameOverlay, form({ name: 'feat/signin' }))
    expect(run).toHaveBeenCalledWith('renameBranch', { from: 'feat/login', to: 'feat/signin' }, { trigger })
  })

  it('delete: first a normal delete with expectedSha (the tip the user saw)', async () => {
    const { deps, run } = harness(async () => ({ kind: 'done', value: { branch: 'feat/login', sha: SHA } }))
    const result = await submitBranchSheet(deps, deleteOverlay, form())
    expect(run).toHaveBeenCalledWith('deleteBranch', { name: 'feat/login', force: false, expectedSha: SHA }, { trigger })
    expect(result).toEqual({ kind: 'closed' })
  })

  it('delete: git/not-merged asks for the forced stage instead of failing', async () => {
    const { deps } = harness(async () => failed('git/not-merged', { branch: 'feat/login' }))
    const result = await submitBranchSheet(deps, deleteOverlay, form())
    expect(result).toMatchObject({ kind: 'error', needsForce: true })
  })

  it('delete: the forced stage sends force: true and keeps expectedSha', async () => {
    const { deps, run } = harness(async () => ({ kind: 'done', value: { branch: 'feat/login', sha: SHA } }))
    await submitBranchSheet(deps, deleteOverlay, form({ force: true, forceConfirmed: true }))
    expect(run).toHaveBeenCalledWith('deleteBranch', { name: 'feat/login', force: true, expectedSha: SHA }, { trigger })
  })

  it('delete: drift (git/stale-target) is a plain error, never forced', async () => {
    const { deps } = harness(async () => failed('git/stale-target', { target: 'branch' }))
    const result = await submitBranchSheet(deps, deleteOverlay, form())
    expect(result.kind).toBe('error')
    expect(result).not.toHaveProperty('needsForce')
  })

  it('checkout revision: normal checkout of a revision target; would-overwrite hands off to the smart sheet', async () => {
    const error = failed('git/would-overwrite', { paths: ['a.ts'] })
    const { deps, run, opened } = harness(async () => error)
    const result = await submitBranchSheet(deps, revisionOverlay, form({ revision: ' v1.0 ' }))
    expect(run).toHaveBeenCalledWith('checkout', { target: { kind: 'revision', name: 'v1.0' }, mode: 'normal' }, { trigger })
    expect(result).toEqual({ kind: 'handedOff' })
    expect(opened).toEqual([{ kind: 'smartCheckout', target: { kind: 'revision', name: 'v1.0' }, paths: ['a.ts'] }])
  })

  it('checkout revision: other failures stay in the sheet (and are not reported twice)', async () => {
    const { deps, onOutcome } = harness(async () => failed('git/invalid-payload'))
    const result = await submitBranchSheet(deps, revisionOverlay, form({ revision: 'nope' }))
    expect(result.kind).toBe('error')
    expect(onOutcome).not.toHaveBeenCalled()
  })
})

describe('BranchSheetView', () => {
  const base = { t: zhT, form: form(), busy: false, error: null, onChange: () => {}, onSubmit: () => {}, onCancel: () => {} }

  it('new: name field, read-only start point, checkout checkbox on by default', () => {
    const html = renderToStaticMarkup(<BranchSheetView {...base} overlay={newOverlay} />)
    expect(html).toContain(zh['branch.sheet.new.title'])
    expect(html).toContain('feat/login')
    expect(html).toMatch(/data-start-point[^>]*readonly|readOnly/i)
    expect(html).toMatch(/type="checkbox"[^>]*checked/)
    expect(html).toContain(zh['branch.sheet.create'])
  })

  it('new: shows the validation hint for illegal characters and disables submit', () => {
    const html = renderToStaticMarkup(<BranchSheetView {...base} overlay={newOverlay} form={form({ name: 'a b' })} />)
    expect(html).toContain(zh['branch.sheet.name.invalidChars'])
    expect(html).toMatch(/<button[^>]*data-primary[^>]*disabled|<button[^>]*disabled[^>]*data-primary/)
  })

  it('delete: names the branch and the sha; forced stage shows the warning, checkbox and danger button', () => {
    const normal = renderToStaticMarkup(<BranchSheetView {...base} overlay={deleteOverlay} />)
    expect(normal).toContain('feat/login')
    expect(normal).toContain(SHA.slice(0, 7))
    expect(normal).not.toContain(zh['branch.sheet.forceDelete'])
    const forced = renderToStaticMarkup(<BranchSheetView {...base} overlay={deleteOverlay} form={form({ force: true })} />)
    expect(forced).toContain(zh['branch.sheet.forceDelete'])
    expect(forced).toContain('data-danger')
    expect(forced).toContain(zh['branch.sheet.delete.forceConfirm'].replace('{name}', 'feat/login'))
    expect(forced).toContain(zh['branch.sheet.delete.notMerged'].replace('{name}', 'feat/login'))
  })

  it('checkout revision: explains the detached HEAD', () => {
    const html = renderToStaticMarkup(<BranchSheetView {...base} overlay={revisionOverlay} />)
    expect(html).toContain(zh['branch.sheet.revision.hint'])
    expect(html).toContain(zh['branch.sheet.checkout'])
  })

  it('renders a submit error and a busy state', () => {
    const html = renderToStaticMarkup(
      <BranchSheetView {...base} overlay={newOverlay} busy error={text('action.error.git/branch-exists', { branch: 'x' })} />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('分支 x 已存在')
    expect(html).toContain(zh['branch.sheet.working'])
  })
})

const target: CheckoutTarget = { kind: 'local', name: 'feat/login' }

describe('submitSmartCheckout', () => {
  it('stash and force resend the checkout with that mode', async () => {
    const { deps, run } = harness(async () => ({ kind: 'done', value: { branch: 'feat/login', detached: false, head: 'x', stashRestored: true } }))
    await submitSmartCheckout(deps.actions, target, 'stash', trigger)
    await submitSmartCheckout(deps.actions, target, 'force', trigger)
    expect(run).toHaveBeenNthCalledWith(1, 'checkout', { target, mode: 'stash' }, { trigger })
    expect(run).toHaveBeenNthCalledWith(2, 'checkout', { target, mode: 'force' }, { trigger })
  })

  it('done closes with the outcome; failure stays open with the message', async () => {
    const ok = harness(async () => ({ kind: 'done', value: { stashKept: true } }))
    expect(await submitSmartCheckout(ok.deps.actions, target, 'stash', trigger)).toEqual({ kind: 'closed', outcome: { kind: 'done', value: { stashKept: true } } })
    const bad = harness(async () => failed('git/exec-failed'))
    expect((await submitSmartCheckout(bad.deps.actions, target, 'stash', trigger)).kind).toBe('error')
  })
})

describe('SmartCheckoutSheetView', () => {
  const props = { t: zhT, target, paths: ['a.ts', 'b.ts'], forceConfirmed: false, busy: false, error: null, onStash: () => {}, onForce: () => {}, onCancel: () => {}, onForceConfirmChange: () => {} }

  it('lists the overwritten files and offers stash / force / cancel', () => {
    const html = renderToStaticMarkup(<SmartCheckoutSheetView {...props} />)
    expect(html).toContain(zh['branch.smart.title'])
    expect(html).toContain('a.ts')
    expect(html).toContain('b.ts')
    expect(html).toContain('贮藏并签出')
    expect(html).toContain('强制签出（丢弃改动）')
    expect(html).toContain('取消')
  })

  it('force is danger-toned and disabled until the discard is confirmed', () => {
    const locked = renderToStaticMarkup(<SmartCheckoutSheetView {...props} />)
    expect(locked).toMatch(/<button[^>]*data-force[^>]*disabled|<button[^>]*disabled[^>]*data-force/)
    expect(locked).toContain('data-danger')
    const unlocked = renderToStaticMarkup(<SmartCheckoutSheetView {...props} forceConfirmed />)
    expect(unlocked).not.toMatch(/<button[^>]*data-force[^>]*disabled|<button[^>]*disabled[^>]*data-force/)
  })

  it('shows an error from a failed resend', () => {
    const html = renderToStaticMarkup(<SmartCheckoutSheetView {...props} error={text('action.error.fallback', { code: 'x', message: 'boom' })} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('boom')
  })
})
