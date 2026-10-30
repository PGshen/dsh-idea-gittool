// @vitest-environment happy-dom
// t2 T5: the Git tab hands the stored git path to the Host on mount. A session that may not change
// it (git/sandbox-denied) is not an error to show; a read-only one also hides the path entry.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BootstrapCache } from '../../src/client/bootstrap-cache.ts'
import type { GitClient } from '../../src/client/git-client.ts'
import { GitBody } from '../../src/client/GitBody.tsx'
import type { GitBodyProps } from '../../src/client/GitBody.tsx'
import { resetSettingsForTest, writeSettings } from '../../src/client/settings.ts'
import type { GitError, GitExecutableInfo, RpcResult } from '../../src/shared/protocol.ts'
import { render, visibleText } from './dom.tsx'
import type { Rendered } from './dom.tsx'
import { zhT } from './i18n-helpers.tsx'

let view: Rendered | null = null
beforeEach(() => { resetSettingsForTest() })
afterEach(() => {
  view?.unmount()
  view = null
  resetSettingsForTest()
})

/** A bootstrap cache whose session has no usable git (the「未找到 git」empty state). */
function missingGitCache(): BootstrapCache {
  return {
    get: () => null,
    getFailure: () => ({ code: 'git/not-found', message: 'no git' }),
    subscribe: () => () => {},
    ensure: () => {},
    refresh: async () => 0,
    reload: async () => 0,
  }
}

async function mount(answer: RpcResult<GitExecutableInfo>): Promise<ReturnType<typeof vi.fn>> {
  const gitExecutable = vi.fn(async () => answer)
  const props = {
    sessionId: 's',
    t: zhT,
    useTabInfo: () => ({ tab: { visible: true }, sidebar: { fullscreen: false } }),
    useSessions: (select: (state: { byId: Record<string, unknown> }) => unknown) => select({ byId: {} }),
    bootstrapCache: missingGitCache(),
    gitClient: { gitExecutable } as unknown as GitClient,
  } as unknown as GitBodyProps
  view = render(<GitBody {...props} />)
  await act(async () => { await Promise.resolve() })
  return gitExecutable
}

const denied = (reasonCode: string): RpcResult<GitExecutableInfo> => ({
  ok: false,
  error: { code: 'git/sandbox-denied', message: '会话沙箱为只读模式', details: { mode: 'read-only', reasonCode } } satisfies GitError,
})

describe('GitBody re-sending the stored git path', () => {
  it('ignores a read-only rejection silently and hides the path entry', async () => {
    writeSettings({ gitPath: '/opt/git/bin/git' })
    const call = await mount(denied('read-only-mode'))

    expect(call).toHaveBeenCalledWith({ sessionId: 's', path: '/opt/git/bin/git' })
    expect(view!.container.querySelector('[role="alert"]')).toBeNull()
    expect(view!.container.querySelector('input')).toBeNull()
    expect(visibleText(view!.container)).toContain('只读会话不能修改 git 路径；请在可写会话中设置')
  })

  it('ignores other sandbox denials silently but keeps the path entry', async () => {
    writeSettings({ gitPath: '/opt/git/bin/git' })
    await mount(denied('session-not-live'))

    expect(view!.container.querySelector('[role="alert"]')).toBeNull()
    expect(view!.container.querySelector('input')).not.toBeNull()
  })

  it('still reports other rejections', async () => {
    writeSettings({ gitPath: '/opt/git/bin/git' })
    await mount({ ok: false, error: { code: 'git/invalid-payload', message: 'x', details: { reason: 'not-found' } } })

    expect(visibleText(view!.container.querySelector('[role="alert"]')!)).toBe('该路径不存在。')
  })
})
