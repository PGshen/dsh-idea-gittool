// T5 commit page: orchestration (runCommit) and render snapshots of the panel and message box.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CommitMessage, historyPreview } from '../../../src/client/pages/CommitMessage.tsx'
import { CommitPanel, runCommit } from '../../../src/client/pages/CommitPanel.tsx'
import type { CommitPanelProps } from '../../../src/client/pages/CommitPanel.tsx'
import { createChangesStore } from '../../../src/client/store/changes-store.ts'
import { commitGate, createCommitStore } from '../../../src/client/store/commit-store.ts'
import type { CommitResultValue, GitError, RpcResult, StatusValue, WritePolicyValue } from '../../../src/shared/protocol.ts'
import { entry, statusFixture } from './changes-fixtures.ts'

const SHA = '7f3a2c1'.padEnd(40, 'e')

function setup(options: { status?: StatusValue; result?: RpcResult<CommitResultValue>; policy?: WritePolicyValue; pendingWrites?: number } = {}) {
  const status = options.status ?? statusFixture({ unstaged: [entry('a.ts', 'M'), entry('b.ts', 'M')], untracked: [entry('c.md', '?')] })
  const changesStore = createChangesStore()
  changesStore.setStatus(status)
  const commitFiles = vi.fn(async (): Promise<RpcResult<CommitResultValue>> => options.result ?? { ok: true, value: { sha: SHA, shortSha: SHA.slice(0, 7) } })
  const amendMessage = vi.fn(async (): Promise<RpcResult<CommitResultValue>> => ({ ok: true, value: { sha: SHA, shortSha: SHA.slice(0, 7) } }))
  const commitStore = createCommitStore({ sessionId: 's', repoRoot: '/r', client: { commitFiles, amendMessage }, storage: null, newRequestId: () => 'req' })
  const policy = options.policy ?? { mode: 'read-write' }
  const gate = () => commitGate({
    writePolicy: policy,
    status,
    pendingWrites: options.pendingWrites ?? 0,
    checkedCount: changesStore.getCheckedPaths().length,
    message: commitStore.getState().message,
    amend: commitStore.getState().amend,
    phase: commitStore.getState().phase,
  })
  const render = (overrides: Partial<CommitPanelProps> = {}): string => renderToStaticMarkup(
    <CommitPanel
      changesStore={changesStore}
      changes={changesStore.getState()}
      commitStore={commitStore}
      commit={commitStore.getState()}
      status={status}
      writePolicy={policy}
      pendingWrites={options.pendingWrites ?? 0}
      onOpenDiff={() => {}}
      onShowConsole={() => {}}
      {...overrides}
    />,
  )
  return { changesStore, commitStore, commitFiles, amendMessage, gate, render, status }
}

describe('runCommit', () => {
  it('commits checked paths, unchecks them and reports the result', async () => {
    const { changesStore, commitStore, commitFiles, gate } = setup()
    changesStore.setChecked(['c.md'], true)
    commitStore.setMessage('feat: x')
    const onCommitted = vi.fn()
    const outcome = await runCommit({ commitStore, changesStore, gate: gate(), onCommitted })
    expect(outcome?.ok).toBe(true)
    expect(commitFiles.mock.calls[0]).toEqual([{ sessionId: 's', requestId: 'req', paths: ['a.ts', 'b.ts', 'c.md'], message: 'feat: x' }])
    expect(changesStore.getCheckedPaths()).toEqual([])
    expect(onCommitted).toHaveBeenCalledWith({ sha: SHA, shortSha: '7f3a2c1' }, { mode: 'files', paths: ['a.ts', 'b.ts', 'c.md'] })
  })

  it('ignores a second trigger while the first is in flight (no double callbacks)', async () => {
    const { changesStore, commitStore, commitFiles, gate } = setup()
    commitStore.setMessage('feat: x')
    const onCommitted = vi.fn()
    const first = runCommit({ commitStore, changesStore, gate: gate(), onCommitted })
    const second = await runCommit({ commitStore, changesStore, gate: gate(), onCommitted })
    await first
    expect(second).toBeNull()
    expect(commitFiles).toHaveBeenCalledTimes(1)
    expect(onCommitted).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the gate says no', async () => {
    const { changesStore, commitStore, commitFiles, gate } = setup()
    expect(await runCommit({ commitStore, changesStore, gate: gate() })).toBeNull()
    expect(commitFiles).not.toHaveBeenCalled()
  })

  it('commit and push: direct push with upstream, push page without one or from the ▾ menu', async () => {
    const withUpstream = setup()
    withUpstream.commitStore.setMessage('feat: push')
    const onPush = vi.fn()
    await runCommit({ ...withUpstream, gate: withUpstream.gate(), push: true, onPushAfterCommit: onPush })
    expect(onPush).toHaveBeenLastCalledWith(expect.objectContaining({ shortSha: '7f3a2c1' }), { openPushPage: false })

    const viaMenu = setup()
    viaMenu.commitStore.setMessage('feat: push')
    await runCommit({ ...viaMenu, gate: viaMenu.gate(), push: true, openPushPage: true, onPushAfterCommit: onPush })
    expect(onPush).toHaveBeenLastCalledWith(expect.anything(), { openPushPage: true })

    const noUpstream = setup({ status: statusFixture({ upstream: null, unstaged: [entry('a.ts', 'M')] }) })
    noUpstream.commitStore.setMessage('feat: push')
    await runCommit({ ...noUpstream, gate: noUpstream.gate(), push: true, onPushAfterCommit: onPush })
    expect(onPush).toHaveBeenLastCalledWith(expect.anything(), { openPushPage: true })
    expect(onPush).toHaveBeenCalledTimes(3)
  })

  it('failure keeps checks and does not push', async () => {
    const error: GitError = { code: 'git/paths-changed', message: 'changed' }
    const { changesStore, commitStore, gate } = setup({ result: { ok: false, error } })
    commitStore.setMessage('feat: x')
    const onPush = vi.fn()
    const outcome = await runCommit({ commitStore, changesStore, gate: gate(), push: true, onPushAfterCommit: onPush })
    expect(outcome).toEqual({ ok: false, error })
    expect(changesStore.getCheckedPaths()).toEqual(['a.ts', 'b.ts'])
    expect(onPush).not.toHaveBeenCalled()
  })

  it('message-only amend sends no paths', async () => {
    const { changesStore, commitStore, amendMessage, gate } = setup()
    changesStore.checkAll(false)
    commitStore.setMessage('fix: reword')
    commitStore.setAmend(true)
    const outcome = await runCommit({ commitStore, changesStore, gate: gate() })
    expect(outcome).toMatchObject({ ok: true, mode: 'amend-message', paths: [] })
    expect(amendMessage).toHaveBeenCalledTimes(1)
  })
})

describe('CommitPanel render', () => {
  it('normal state: tree, message, enabled submit and commit-and-push', () => {
    const { commitStore, render } = setup()
    commitStore.setMessage('feat: x')
    const html = render()
    expect(html).toContain('data-changes-tree')
    expect(html).toContain('data-commit-message')
    expect(html).toMatch(/<button[^>]*data-commit-submit="files"[^>]*>提交<\/button>/)
    expect(html).not.toMatch(/disabled=""[^>]*data-commit-submit/)
    expect(html).toContain('提交并推送')
  })

  it('no message: submit disabled with the reason shown', () => {
    const { render } = setup()
    const html = render()
    expect(html).toMatch(/disabled=""[^>]*data-commit-submit/)
    expect(html).toContain('data-note="reason"')
    expect(html).toContain('请填写提交信息')
  })

  it('read-only: everything disabled with the policy reason', () => {
    const { commitStore, render } = setup({ policy: { mode: 'read-only', reason: '仓库在沙箱可写范围之外' } })
    commitStore.setMessage('feat: x')
    const html = render()
    expect(html).toContain('仓库在沙箱可写范围之外')
    expect(html).toMatch(/<textarea[^>]*disabled=""/)
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""/)
  })

  it('pending writes show 等待当前操作完成', () => {
    const { commitStore, render } = setup({ pendingWrites: 2 })
    commitStore.setMessage('feat: x')
    expect(render()).toContain('等待当前操作完成')
  })

  it('amend without checked files: message-only label and rewrite warning when HEAD is pushed', () => {
    const { changesStore, commitStore, render } = setup({ status: statusFixture({ ahead: 0, unstaged: [entry('a.ts', 'M')] }) })
    changesStore.checkAll(false)
    commitStore.setMessage('fix: reword')
    commitStore.setAmend(true)
    const html = render()
    expect(html).toContain('仅修改提交信息')
    expect(html).toContain('data-note="warning"')
    expect(html).toContain('改写已推送的历史')
  })

  it('detached HEAD hint', () => {
    const { commitStore, render } = setup({ status: statusFixture({ detached: true, branch: null, upstream: null, unstaged: [entry('a.ts', 'M')] }) })
    commitStore.setMessage('feat: x')
    expect(render()).toContain('游离')
  })

  it('success feedback shows the short sha', async () => {
    const { changesStore, commitStore, gate, render } = setup()
    commitStore.setMessage('feat: x')
    await runCommit({ commitStore, changesStore, gate: gate() })
    const html = render()
    expect(html).toContain('已提交 7f3a2c1')
    expect(html).toContain('role="status"')
  })

  it('hook failure shows title, output and the console action', async () => {
    const { changesStore, commitStore, gate, render } = setup({
      result: { ok: false, error: { code: 'git/hook-failed', message: 'pre-commit', details: { stderr: 'eslint: 2 errors' } } },
    })
    commitStore.setMessage('feat: x')
    await runCommit({ commitStore, changesStore, gate: gate() })
    const html = render()
    expect(html).toContain('提交被 Git hook 阻止')
    expect(html).toContain('eslint: 2 errors')
    expect(html).toContain('查看 Git 控制台')
  })

  it('paths changed offers refresh when the callback exists', async () => {
    const { changesStore, commitStore, gate, render } = setup({ result: { ok: false, error: { code: 'git/paths-changed', message: 'x' } } })
    commitStore.setMessage('feat: x')
    await runCommit({ commitStore, changesStore, gate: gate() })
    const html = render({ onRefresh: () => {} })
    expect(html).toContain('文件已变化，刷新后重试')
    expect(html).toContain('>刷新<')
  })
})

describe('CommitMessage render', () => {
  it('auto-sizes rows and shows the subject hint over 72 characters', () => {
    const short = renderToStaticMarkup(<CommitMessage value="" onChange={() => {}} onSubmit={() => {}} history={[]} onPickHistory={() => {}} />)
    expect(short).toContain('rows="3"')
    expect(short).not.toContain('data-subject-hint')
    const long = renderToStaticMarkup(
      <CommitMessage value={`${'x'.repeat(90)}\n\n1\n2\n3\n4\n5\n6\n7\n8`} onChange={() => {}} onSubmit={() => {}} history={[]} onPickHistory={() => {}} />,
    )
    expect(long).toContain('rows="8"')
    expect(long).toContain('data-subject-hint')
    expect(long).toContain('90')
  })

  it('history preview uses the subject line', () => {
    expect(historyPreview('feat: a\n\nbody')).toBe('feat: a')
  })
})
