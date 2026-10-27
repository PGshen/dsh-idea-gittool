// Revision arguments of the B2 read endpoints (plan B2 contract): a user-supplied ref or sha is resolved
// to a full commit sha first, and only that sha reaches later git calls. That closes option injection
// (`--output=…` never becomes an argument) and pins one request to one commit while refs move.
import type { GitRunner } from '../git-executor.ts'
import { GIT_BASE_ARGV, failureFromExit } from '../git-executor.ts'
import { invalidPayload } from './write-support.ts'

const MAX_REVISION_LENGTH = 1024

/**
 * Resolve a ref name or (abbreviated) sha to the full sha of the commit it names.
 * @param label - payload field name, used in error messages.
 * @throws GitCommandFailure `git/invalid-payload` for a non-string, an option-like value or a
 *   revision that names no commit.
 */
export async function resolveRevision(
  run: GitRunner,
  cwd: string,
  revision: unknown,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof revision !== 'string' || revision.length === 0 || revision.length > MAX_REVISION_LENGTH) {
    throw invalidPayload(`${label} must be a non-empty revision`, {})
  }
  if (revision.startsWith('-') || /[\0\n]/u.test(revision)) {
    throw invalidPayload(`${label} must not look like an option`, { [label]: revision })
  }
  const result = await run(
    [...GIT_BASE_ARGV, 'rev-parse', '-q', '--verify', '--end-of-options', `${revision}^{commit}`],
    { cwd, signal },
  )
  if (result.exitCode === 0) {
    const sha = result.stdout.trim()
    if (sha !== '') return sha
  }
  if (result.exitCode === 1) throw invalidPayload(`${label} does not name a commit`, { [label]: revision })
  throw failureFromExit(result, 'git rev-parse')
}
