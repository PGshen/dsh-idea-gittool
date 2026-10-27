// 推送与推送预览（A2 T3，设计 §11）。
// - 推送：`push --porcelain [--set-upstream] [--force-with-lease] [--follow-tags] <remote> HEAD:refs/heads/<branch>`，
//   网络模式（confine、180s）；永不 `--force`、永不 `--no-verify`。本地推送源固定为 HEAD，
//   目标写全 `refs/heads/<branch>`，detached HEAD 也不会推到意外的引用。
// - 分类顺序：沙箱拒绝（references §13：工作区外 bare 远程表现为 `(unpacker error)`）→ 认证失败 →
//   porcelain `!` 行（`git/rejected`，附 fetch 后的远程新提交）→ 本地 pre-push hook → 其它。
// - 所有错误信息与 details 都经过凭据脱敏；`details.command` 只含远程名与分支名，不含 URL。
// - TD-10（A3 T4）：带 `expectedRemoteSha` 时用 `--force-with-lease=refs/heads/<branch>:<sha>`——只覆盖用户看过的
//   远程 tip，不依赖本地远程跟踪 ref（被拒后的 fetch 会更新它，单纯 `--force-with-lease` 会因此放行）。
//   被拒 details 带 fetch 后的远程 tip `remoteSha`，供客户端回传。

import type {
  CommitSummary,
  PushPreviewValue,
  PushRejectReason,
  PushRejectedDetails,
  PushValue,
} from '../../shared/protocol.ts'
import { PUSH_PREVIEW_COMMIT_LIMIT } from '../../shared/protocol.ts'
import { redactCredentials } from '../console.ts'
import type { GitRunResult, GitRunner, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'
import {
  OBJECT_ID_PATTERN,
  assertPushTarget,
  authRequired,
  firstLine,
  hasHook,
  invalidPayload,
  isAuthFailure,
  isSandboxDenial,
  optionalBoolean,
  outputSummary,
  parseRefName,
  payloadRecord,
  query,
  redactedFailure,
} from './write-support.ts'

export interface PushInput {
  remote: string
  branch: string
  setUpstream: boolean
  forceWithLease: boolean
  tags: boolean
  /** TD-10: the remote tip the user saw; only together with `forceWithLease`. */
  expectedRemoteSha?: string
}

/** One porcelain ref line: `<flag>\t<from>:<to>\t<summary>`. */
export interface PushRefResult {
  flag: string
  from: string
  to: string
  summary: string
}

const FIELD_SEPARATOR = '\u001f'
const COMMIT_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%s'].join('%x1f')

/** Parse `git push --porcelain` stdout (the `To <url>` and `Done` lines are skipped). */
export function parsePushPorcelain(stdout: string): PushRefResult[] {
  const refs: PushRefResult[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [flagField = '', refspec = '', ...rest] = parts
    if (flagField.length !== 1) continue
    const colon = refspec.lastIndexOf(':')
    refs.push({
      flag: flagField,
      from: colon < 0 ? refspec : refspec.slice(0, colon),
      to: colon < 0 ? '' : refspec.slice(colon + 1),
      summary: rest.join('\t').trim(),
    })
  }
  return refs
}

/** Map a rejected ref's summary (plus stderr for server messages) to a reason. */
export function classifyRejection(summary: string, stderr: string): PushRejectReason {
  if (/stale info/i.test(summary)) return 'stale-lease'
  if (/fetch first/i.test(summary)) return 'fetch-first'
  if (/non-fast-forward/i.test(summary)) return 'non-fast-forward'
  if (/protected/i.test(summary) || /protected branch/i.test(stderr)) return 'protected'
  if (/hook declined/i.test(summary)) return 'hook-declined'
  return 'other'
}

/** Parse `log -z --format=<COMMIT_FORMAT>` output into summaries. */
export function parseCommitSummaries(stdout: string): CommitSummary[] {
  const commits: CommitSummary[] = []
  for (const record of stdout.split('\0')) {
    const trimmed = record.replace(/^\n+/, '')
    if (trimmed === '') continue
    const [sha = '', shortSha = '', parents = '', author = '', email = '', date = '', ...subject] =
      trimmed.split(FIELD_SEPARATOR)
    if (sha === '') continue
    commits.push({
      sha,
      shortSha,
      parents: parents === '' ? [] : parents.split(' '),
      author,
      email,
      date,
      subject: subject.join(FIELD_SEPARATOR),
    })
  }
  return commits
}

/** `log -z` argv in the format {@link parseCommitSummaries} reads. */
export function logArgv(limit: number, revisions: readonly string[]): string[] {
  return ['log', '-z', `--max-count=${String(limit)}`, `--format=${COMMIT_FORMAT}`, ...revisions, '--']
}

/**
 * Fetch one remote branch into its remote-tracking ref (network mode). Returns the raw
 * result; callers classify failures (push rejection treats them as best effort).
 */
export async function fetchRemoteBranch(ctx: WriteContext, remote: string, branch: string): Promise<GitRunResult> {
  return await ctx.git(
    [
      ...GIT_BASE_ARGV,
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-recurse-submodules',
      '--',
      remote,
      `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
    ],
    { mode: 'network' },
  )
}

/** Classify a failed network command: sandbox → auth → generic (all redacted). */
export function networkFailure(
  result: GitRunResult,
  repoRoot: string,
  terminalArgs: readonly string[],
  label: string,
): GitCommandFailure {
  if (isSandboxDenial(`${result.stderr}\n${result.stdout}`)) {
    return new GitCommandFailure('git/sandbox-denied', firstLine(result.stderr) || `${label} was denied by the sandbox`, {
      stderr: redactCredentials(result.stderr.trim()).slice(0, 2000),
    })
  }
  if (isAuthFailure(result.stderr)) return authRequired(result, repoRoot, terminalArgs)
  return redactedFailure(result, label)
}

/**
 * After a fetch: remote commits missing locally (`HEAD..<remote>/<branch>`) and the remote tip
 * (TD-10 `remoteSha`). Best effort: anything unreadable is left out.
 */
async function readRemoteState(
  ctx: WriteContext,
  remote: string,
  branch: string,
): Promise<{ remoteCommits: CommitSummary[]; remoteSha?: string }> {
  try {
    const fetched = await fetchRemoteBranch(ctx, remote, branch)
    if (fetched.exitCode !== 0) return { remoteCommits: [] }
    const tracking = `refs/remotes/${remote}/${branch}`
    const tip = await query(ctx, ['rev-parse', '-q', '--verify', tracking])
    const remoteSha = tip.exitCode === 0 && OBJECT_ID_PATTERN.test(tip.stdout.trim()) ? tip.stdout.trim() : undefined
    const log = await query(ctx, logArgv(PUSH_PREVIEW_COMMIT_LIMIT, [tracking, '--not', 'HEAD']))
    const remoteCommits = log.exitCode === 0 ? parseCommitSummaries(log.stdout) : []
    return remoteSha === undefined ? { remoteCommits } : { remoteCommits, remoteSha }
  } catch {
    return { remoteCommits: [] }
  }
}

/** Push 页数据（读命令，不经写队列）。 */
export async function readPushPreview(
  run: GitRunner,
  repoRoot: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<Omit<PushPreviewValue, 'version'>> {
  const git = async (args: readonly string[]): Promise<GitRunResult> =>
    await run([...GIT_BASE_ARGV, ...args], { cwd: repoRoot, signal: options.signal })

  const remotesResult = await git(['remote'])
  if (remotesResult.exitCode !== 0) throw failureFromExit(remotesResult, 'git remote')
  const remotes = remotesResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const symbolic = await git(['symbolic-ref', '-q', '--short', 'HEAD'])
  const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() || null : null

  let upstream: string | null = null
  let upstreamRef: string | null = null
  let upstreamRemote: string | null = null
  if (branch !== null) {
    const tracking = await git([
      'for-each-ref',
      '--format=%(upstream)%00%(upstream:short)%00%(upstream:remotename)',
      `refs/heads/${branch}`,
    ])
    if (tracking.exitCode === 0) {
      const [full = '', short = '', remoteName = ''] = tracking.stdout.replace(/\n$/, '').split('\0')
      if (full !== '') {
        upstreamRef = full
        upstream = short
        upstreamRemote = remotes.includes(remoteName) ? remoteName : null
      }
    }
  }

  const defaultRemote =
    upstreamRemote ?? (remotes.length === 1 ? (remotes[0] ?? null) : remotes.includes('origin') ? 'origin' : (remotes[0] ?? null))

  let commits: CommitSummary[] = []
  let truncated = false
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD'])
  if (head.exitCode === 0) {
    // Upstream exists and resolves: exactly `upstream..HEAD`; otherwise everything not on the remote.
    const exclusions =
      upstreamRef !== null && (await git(['rev-parse', '--verify', '-q', upstreamRef])).exitCode === 0
        ? [upstreamRef]
        : defaultRemote !== null
          ? [`--remotes=${defaultRemote}`]
          : []
    const log = await git(logArgv(PUSH_PREVIEW_COMMIT_LIMIT + 1, ['HEAD', '--not', ...exclusions]))
    if (log.exitCode !== 0) throw failureFromExit(log, 'git log')
    commits = parseCommitSummaries(log.stdout)
    if (commits.length > PUSH_PREVIEW_COMMIT_LIMIT) {
      commits = commits.slice(0, PUSH_PREVIEW_COMMIT_LIMIT)
      truncated = true
    }
  }

  return {
    remotes,
    branch,
    detached: branch === null,
    upstream,
    defaultRemote,
    commits,
    truncated,
  }
}

/** `--force-with-lease`, pinned to the expected remote tip when the user saw one (TD-10). */
function leaseOption(input: PushInput): string {
  return input.expectedRemoteSha === undefined
    ? '--force-with-lease'
    : `--force-with-lease=refs/heads/${input.branch}:${input.expectedRemoteSha}`
}

export const pushOperation: WriteOperation<PushInput, Omit<PushValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const input: PushInput = {
      remote: parseRefName(record.remote, 'remote'),
      branch: parseRefName(record.branch, 'branch'),
      setUpstream: optionalBoolean(record, 'setUpstream'),
      forceWithLease: optionalBoolean(record, 'forceWithLease'),
      tags: optionalBoolean(record, 'tags'),
    }
    const expected = record.expectedRemoteSha
    if (expected !== undefined) {
      if (typeof expected !== 'string' || !OBJECT_ID_PATTERN.test(expected)) {
        throw invalidPayload('expectedRemoteSha must be a full lowercase hexadecimal object name')
      }
      if (!input.forceWithLease) throw invalidPayload('expectedRemoteSha is only valid together with forceWithLease')
      input.expectedRemoteSha = expected
    }
    return input
  },

  async run(ctx, input) {
    await assertPushTarget(ctx, input.remote, input.branch)
    const options = [
      ...(input.setUpstream ? ['--set-upstream'] : []),
      ...(input.forceWithLease ? [leaseOption(input)] : []),
      ...(input.tags ? ['--follow-tags'] : []),
    ]
    const target = [input.remote, `HEAD:refs/heads/${input.branch}`]
    const result = await ctx.git([...GIT_BASE_ARGV, 'push', '--porcelain', ...options, '--', ...target], {
      mode: 'network',
    })
    const refs = parsePushPorcelain(result.stdout)
    const rejected = refs.filter((ref) => ref.flag === '!')

    if (result.exitCode !== 0 || rejected.length > 0) {
      const terminalArgs = ['push', ...options, input.remote, `HEAD:refs/heads/${input.branch}`]
      if (isSandboxDenial(`${result.stderr}\n${result.stdout}`) || isAuthFailure(result.stderr)) {
        throw networkFailure(result, ctx.repoRoot, terminalArgs, 'git push')
      }
      const first = rejected[0]
      if (first !== undefined) {
        const reason = classifyRejection(first.summary, result.stderr)
        const fetchable = reason === 'non-fast-forward' || reason === 'fetch-first' || reason === 'stale-lease'
        const remoteState = fetchable ? await readRemoteState(ctx, input.remote, input.branch) : { remoteCommits: [] }
        const details: PushRejectedDetails = {
          reason,
          remote: input.remote,
          branch: input.branch,
          ...remoteState,
          summary: redactCredentials(first.summary),
        }
        throw new GitCommandFailure('git/rejected', `push to ${input.remote}/${input.branch} was rejected (${reason})`, {
          ...details,
        })
      }
      if (refs.length === 0 && (await hasHook(ctx, ['pre-push']))) {
        throw new GitCommandFailure('git/hook-failed', 'the push was blocked by the pre-push hook', {
          exitCode: result.exitCode,
          output: outputSummary(result),
        })
      }
      throw redactedFailure(result, 'git push')
    }

    return {
      remote: input.remote,
      branch: input.branch,
      updated: refs.some((ref) => ref.flag !== '='),
    }
  },
}
