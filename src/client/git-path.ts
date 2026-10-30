// The git path setting on the client (B4d T3, decision 1): stored in settings, handed to the Host
// through `gitExecutable`, and kept only once the Host accepted it.
import type { GitError, GitExecutableInfo } from '../shared/protocol.ts'
import type { GitClient } from './git-client.ts'
import type { Translate } from './i18n.tsx'
import { isAbsoluteGitPath, writeSettings } from './settings.ts'

export { isAbsoluteGitPath }

/** `readOnly`: the Host refused because the session is read-only (t2 T5). */
export type GitPathOutcome = { ok: true; info: GitExecutableInfo } | { ok: false; message: string; readOnly?: true }

/** What the empty state shows instead of the workbench (design §7.2). */
export type GitMissing = { kind: 'not-found' } | { kind: 'unsupported'; current: string; minimum: string }

function detail(error: GitError, key: string): string {
  const value = error.details?.[key]
  return typeof value === 'string' ? value : ''
}

/** Whether the Host refused a git path because the session's sandbox is read-only (t2 T5). */
export function isReadOnlySessionDenial(error: GitError): boolean {
  return error.code === 'git/sandbox-denied' && detail(error, 'reasonCode') === 'read-only-mode'
}

/** A rejected `gitExecutable` (or bootstrap) error as one sentence for the user. */
export function gitPathErrorText(error: GitError, t: Translate): string {
  if (error.code === 'git/unsupported-version') {
    return t('git.path.tooOld', { current: detail(error, 'current'), minimum: detail(error, 'minimum') })
  }
  if (error.code === 'git/not-found') return t('git.path.notFound')
  // t2 T5: only a session that may change state can set the Host-global git path (ADR 0014).
  if (error.code === 'git/sandbox-denied') return t(isReadOnlySessionDenial(error) ? 'git.path.readOnly' : 'git.path.sandboxDenied')
  if (error.code === 'git/stale-target' && detail(error, 'target') === 'git-path') return t('git.path.superseded')
  if (error.code === 'git/invalid-payload') {
    switch (detail(error, 'reason')) {
      case 'not-absolute': return t('git.path.notAbsolute')
      case 'not-found': return t('git.path.notFound')
      case 'not-executable': return t('git.path.notExecutable')
      case 'not-git': return t('git.path.notGit')
      case 'inside-workspace': return t('git.path.insideWorkspace')
      case 'not-local': return t('git.path.notLocal')
      default: break
    }
  }
  return t('git.path.failed', { message: error.message })
}

/**
 * Hand `path` to the Host (empty → back to PATH). The setting changes only when the Host accepted
 * it, so a typo never replaces a working path.
 */
export async function applyGitPath(client: GitClient, sessionId: string, path: string, t: Translate): Promise<GitPathOutcome> {
  const trimmed = path.trim()
  if (trimmed !== '' && !isAbsoluteGitPath(trimmed)) return { ok: false, message: t('git.path.notAbsolute') }
  const result = await client.gitExecutable({ sessionId, path: trimmed === '' ? null : trimmed })
  if (!result.ok) {
    // Clearing always takes effect on the Host (it is back on PATH even when PATH has no git);
    // keeping the old path would re-send it on the next mount (final review M4).
    if (trimmed === '' && result.error.code === 'git/not-found') writeSettings({ gitPath: null })
    const message = gitPathErrorText(result.error, t)
    return isReadOnlySessionDenial(result.error) ? { ok: false, message, readOnly: true } : { ok: false, message }
  }
  writeSettings({ gitPath: trimmed === '' ? null : trimmed })
  return { ok: true, info: result.value }
}

/** The bootstrap failures that mean "no usable git"; anything else is not this empty state. */
export function gitMissingOf(failure: GitError | null): GitMissing | null {
  if (failure?.code === 'git/not-found') return { kind: 'not-found' }
  if (failure?.code === 'git/unsupported-version') {
    return { kind: 'unsupported', current: detail(failure, 'current'), minimum: detail(failure, 'minimum') }
  }
  return null
}
