// B4d T3: the client side of the git path setting — absolute-path check, error texts, and applying a
// path through the Host (stored only after the Host accepted it).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GitClient } from '../../src/client/git-client.ts'
import { applyGitPath, gitMissingOf, gitPathErrorText, isAbsoluteGitPath } from '../../src/client/git-path.ts'
import { readSettings, resetSettingsForTest, writeSettings } from '../../src/client/settings.ts'
import type { GitExecutableInfo, RpcResult } from '../../src/shared/protocol.ts'
import { enT, zhT } from './i18n-helpers.tsx'

const INFO: GitExecutableInfo = { path: '/opt/git/bin/git', version: '2.45.1', raw: 'git version 2.45.1', source: 'setting' }

function clientAnswering(result: RpcResult<GitExecutableInfo>): { client: GitClient; calls: unknown[] } {
  const calls: unknown[] = []
  const client = { gitExecutable: vi.fn(async (request: unknown) => { calls.push(request); return result }) } as unknown as GitClient
  return { client, calls }
}

beforeEach(() => { resetSettingsForTest() })
afterEach(() => { resetSettingsForTest() })

describe('isAbsoluteGitPath', () => {
  it.each([
    ['/usr/local/bin/git', true],
    ['C:\\Program Files\\Git\\cmd\\git.exe', true],
    ['c:/git/bin/git.exe', true],
    ['\\\\server\\share\\git.exe', true],
    ['git', false],
    ['./git', false],
    ['bin/git', false],
    ['C:git.exe', false],
    ['', false],
  ])('%j → %s', (path, expected) => {
    expect(isAbsoluteGitPath(path)).toBe(expected)
  })
})

describe('gitPathErrorText', () => {
  it('explains each Host rejection', () => {
    expect(gitPathErrorText({ code: 'git/invalid-payload', message: 'x', details: { reason: 'not-found' } }, zhT)).toBe('该路径不存在。')
    expect(gitPathErrorText({ code: 'git/invalid-payload', message: 'x', details: { reason: 'not-executable' } }, zhT)).toBe('该文件不可执行。')
    expect(gitPathErrorText({ code: 'git/invalid-payload', message: 'x', details: { reason: 'not-git' } }, zhT)).toContain('不是 git')
    expect(gitPathErrorText({ code: 'git/unsupported-version', message: 'x', details: { current: '2.20.1', minimum: '2.25.0' } }, enT))
      .toBe('Git 2.20.1 is too old; 2.25.0 or later is required.')
    expect(gitPathErrorText({ code: 'git/exec-failed', message: 'boom', details: {} }, zhT)).toBe('设置失败：boom')
    expect(gitPathErrorText({ code: 'git/invalid-payload', message: 'x', details: { reason: 'inside-workspace' } }, zhT)).toContain('工作区')
    expect(gitPathErrorText({ code: 'git/invalid-payload', message: 'x', details: { reason: 'not-local' } }, zhT)).toContain('本机')
  })
})

describe('applyGitPath', () => {
  it('refuses a relative path without asking the Host', async () => {
    const { client, calls } = clientAnswering({ ok: true, value: INFO })

    const outcome = await applyGitPath(client, 's', 'bin/git', zhT)

    expect(outcome).toEqual({ ok: false, message: expect.stringContaining('绝对路径') })
    expect(calls).toHaveLength(0)
    expect(readSettings().gitPath).toBeNull()
  })

  it('stores the path once the Host adopted it', async () => {
    const { client, calls } = clientAnswering({ ok: true, value: INFO })

    const outcome = await applyGitPath(client, 's', '  /opt/git/bin/git ', zhT)

    expect(outcome).toEqual({ ok: true, info: INFO })
    expect(calls).toEqual([{ sessionId: 's', path: '/opt/git/bin/git' }])
    expect(readSettings().gitPath).toBe('/opt/git/bin/git')
  })

  it('keeps the stored path when the Host rejects the new one', async () => {
    writeSettings({ gitPath: '/usr/bin/git' })
    const { client } = clientAnswering({ ok: false, error: { code: 'git/invalid-payload', message: 'x', details: { reason: 'not-git' } } })

    const outcome = await applyGitPath(client, 's', '/tmp/fake', zhT)

    expect(outcome.ok).toBe(false)
    expect(readSettings().gitPath).toBe('/usr/bin/git')
  })

  it('clears the setting (back to PATH) with an empty path', async () => {
    writeSettings({ gitPath: '/usr/bin/git' })
    const { client, calls } = clientAnswering({ ok: true, value: { ...INFO, source: 'path' } })

    await applyGitPath(client, 's', '', zhT)

    expect(calls).toEqual([{ sessionId: 's', path: null }])
    expect(readSettings().gitPath).toBeNull()
  })
})

describe('clearing the path when PATH has no git (B4d final review M4)', () => {
  it('still stores the clear: the Host has already gone back to PATH', async () => {
    writeSettings({ gitPath: '/usr/bin/git' })
    const { client } = clientAnswering({ ok: false, error: { code: 'git/not-found', message: 'no git' } })

    const outcome = await applyGitPath(client, 's', '', zhT)

    expect(outcome.ok).toBe(false)
    expect(readSettings().gitPath).toBeNull()
  })
})

describe('gitMissingOf', () => {
  it('turns the two bootstrap failures into the empty state, and nothing else', () => {
    expect(gitMissingOf({ code: 'git/not-found', message: 'x' })).toEqual({ kind: 'not-found' })
    expect(gitMissingOf({ code: 'git/unsupported-version', message: 'x', details: { current: '2.20.1', minimum: '2.25.0' } }))
      .toEqual({ kind: 'unsupported', current: '2.20.1', minimum: '2.25.0' })
    expect(gitMissingOf({ code: 'git/exec-failed', message: 'x' })).toBeNull()
    expect(gitMissingOf(null)).toBeNull()
  })
})
