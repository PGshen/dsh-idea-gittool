// Remotes, remote branches and upstreams (plan b3d T2). Remote URLs are only ever returned redacted;
// names and URLs are validated before they reach git and never start with `-`.
import type {
  RemoteBranchDeleteValue,
  RemoteEditRequest,
  RemoteEditValue,
  RemoteEntry,
  SetUpstreamValue,
} from '../../shared/protocol.ts'
import { redactCredentials } from '../console.ts'
import type { GitRunner, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { networkFailure } from './push.ts'
import { invalidPayload, parseRefName, payloadRecord, query, readRemotes, readRunner, redactedFailure } from './write-support.ts'

const URL_MAX = 2048

/** A remote name: a ref component (no `/`), never option-like. */
export function parseRemoteName(value: unknown, label = 'name'): string {
  const name = parseRefName(value, label)
  if (name.includes('/')) throw invalidPayload(`${label} must not contain "/"`, {})
  return name
}

function parseUrl(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > URL_MAX) throw invalidPayload('url must be a non-empty string', {})
  // eslint-disable-next-line no-control-regex
  if (value.startsWith('-') || /[\s\u0000-\u001f\u007f]/u.test(value)) throw invalidPayload('url must not look like an option or contain whitespace', {})
  return value
}

/** Configured remotes with redacted fetch/push URLs, in `git remote` order. */
export async function readRemoteList(run: GitRunner, cwd: string, options: { signal?: AbortSignal | undefined } = {}): Promise<RemoteEntry[]> {
  const result = await run([...GIT_BASE_ARGV, 'remote', '-v'], { cwd, signal: options.signal })
  // Redacted: the diagnostic may quote a configured URL with credentials (b3d review M6).
  if (result.exitCode !== 0) throw redactedFailure(result, 'git remote -v')
  const remotes = new Map<string, RemoteEntry>()
  for (const line of result.stdout.split('\n')) {
    const match = /^(\S+)\t(.*) \((fetch|push)\)$/u.exec(line)
    if (match === null) continue
    const [, name = '', url = '', kind] = match
    const entry = remotes.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch') entry.fetchUrl = redactCredentials(url)
    else entry.pushUrl = redactCredentials(url)
    remotes.set(name, entry)
  }
  return [...remotes.values()]
}

async function remotesOf(ctx: WriteContext): Promise<RemoteEntry[]> {
  return await readRemoteList(readRunner(ctx), ctx.repoRoot)
}

export const remoteEditOperation: WriteOperation<RemoteEditRequest, Omit<RemoteEditValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const base = { sessionId: String(record.sessionId), requestId: String(record.requestId) }
    switch (record.action) {
      case 'add':
      case 'setUrl':
        return { ...base, action: record.action, name: parseRemoteName(record.name), url: parseUrl(record.url) }
      case 'rename':
        return { ...base, action: 'rename', name: parseRemoteName(record.name), newName: parseRemoteName(record.newName, 'newName') }
      case 'remove':
        return { ...base, action: 'remove', name: parseRemoteName(record.name) }
      default:
        throw invalidPayload('action must be add, setUrl, rename or remove', {})
    }
  },

  async run(ctx, input) {
    const known = await readRemotes(ctx)
    if (input.action !== 'add' && !known.includes(input.name)) {
      throw new GitCommandFailure('git/stale-target', `remote "${input.name}" does not exist`, { target: 'remote', name: input.name })
    }
    const args = input.action === 'add'
      ? ['remote', 'add', '--', input.name, input.url]
      : input.action === 'setUrl'
        ? ['remote', 'set-url', '--', input.name, input.url]
        : input.action === 'rename'
          ? ['remote', 'rename', '--', input.name, input.newName]
          : ['remote', 'remove', '--', input.name]
    const result = await ctx.git([...GIT_BASE_ARGV, ...args])
    if (result.exitCode !== 0) throw redactedFailure(result, `git remote ${input.action}`)
    return { remotes: await remotesOf(ctx) }
  },
}

export const remoteBranchDeleteOperation: WriteOperation<{ remote: string; branch: string }, Omit<RemoteBranchDeleteValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return { remote: parseRemoteName(record.remote, 'remote'), branch: parseRefName(record.branch, 'branch') }
  },

  async run(ctx, input) {
    if (!(await readRemotes(ctx)).includes(input.remote)) throw invalidPayload(`unknown remote "${input.remote}"`, { remote: input.remote })
    const ref = `refs/heads/${input.branch}`
    if ((await query(ctx, ['check-ref-format', ref])).exitCode !== 0) throw invalidPayload(`invalid branch name "${input.branch}"`, {})
    const listed = await ctx.git([...GIT_BASE_ARGV, 'ls-remote', '--heads', '--', input.remote, ref], { mode: 'network' })
    if (listed.exitCode !== 0) throw networkFailure(listed, ctx.repoRoot, ['ls-remote', '--heads', input.remote, ref], 'git ls-remote')
    // `--no-deref`: `<remote>/HEAD` is a symbolic ref; without it git deletes the branch it points to.
    if (listed.stdout.trim() === '') {
      await ctx.git([...GIT_BASE_ARGV, 'update-ref', '--no-deref', '-d', `refs/remotes/${input.remote}/${input.branch}`])
      throw new GitCommandFailure('git/stale-target', `${input.remote}/${input.branch} no longer exists`, { target: 'remote-branch' })
    }
    const pushed = await ctx.git([...GIT_BASE_ARGV, 'push', '--porcelain', '--', input.remote, `:${ref}`], { mode: 'network' })
    if (pushed.exitCode !== 0) throw networkFailure(pushed, ctx.repoRoot, ['push', input.remote, `:${ref}`], 'git push')
    // `push` drops the tracking ref when it can; make sure it is gone.
    await ctx.git([...GIT_BASE_ARGV, 'update-ref', '--no-deref', '-d', `refs/remotes/${input.remote}/${input.branch}`])
    return { remote: input.remote, branch: input.branch }
  },
}

export const setUpstreamOperation: WriteOperation<{ branch: string; upstream: string | null }, Omit<SetUpstreamValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return { branch: parseRefName(record.branch, 'branch'), upstream: record.upstream === null ? null : parseRefName(record.upstream, 'upstream') }
  },

  async run(ctx, input) {
    if ((await query(ctx, ['rev-parse', '-q', '--verify', `refs/heads/${input.branch}`])).exitCode !== 0) {
      throw invalidPayload(`branch "${input.branch}" does not exist`, { branch: input.branch })
    }
    if (input.upstream !== null && (await query(ctx, ['rev-parse', '-q', '--verify', `refs/remotes/${input.upstream}`])).exitCode !== 0) {
      throw invalidPayload(`remote branch "${input.upstream}" does not exist`, { upstream: input.upstream })
    }
    const args = input.upstream === null
      ? ['branch', '--unset-upstream', input.branch]
      : ['branch', `--set-upstream-to=refs/remotes/${input.upstream}`, input.branch]
    const result = await ctx.git([...GIT_BASE_ARGV, ...args])
    if (result.exitCode !== 0) throw redactedFailure(result, 'git branch')
    return { branch: input.branch, upstream: input.upstream }
  },
}
