// 获取、更新项目、重置到远程（A3 T4，设计 §11.3）。拉取（pull）在 pull.ts，与 A2 pullForPush 共用实现。
// - fetch：`fetch --porcelain [--prune] --no-recurse-submodules (-- <remote> | --all)`，网络模式；
//   `--porcelain` 需要 Git ≥ 2.41，旧版本报用法错误（退出 129、stderr 提到 porcelain，此时还没有联网）
//   就去掉它重跑一次，返回不带 updatedRefs 的成功。失败分类：沙箱拒绝 → 认证 → 通用（networkFailure）。
// - updateProject：需要当前分支有 upstream（否则 `git/invalid-payload` + reason 'no-upstream'）；
//   不带 `stash: true` 时联网前就检查已跟踪改动；只 fetch upstream 那一个分支
//   （`+<remoteref>:<upstream>`），比较 fetch 前后的远程跟踪 tip：旧 tip 不是新 tip 的祖先 →
//   `git/upstream-rewritten`（oldSha、newSha、localAhead），不合并/不变基；否则按方式 merge/rebase upstream。
//   upstream 是本地分支（remote '.'）时不 fetch。
// - resetToRemote：不贮藏；有已跟踪改动 → `git/dirty-worktree`（不带 operation）。backup 默认 true：
//   先在当前 HEAD 建 `backup/<branch>-<YYYYMMDD-HHmmss>`（Host 本地时间；重名追加 -2、-3…），
//   再 `reset --hard <upstream 的 sha>`。会被覆盖的未跟踪/忽略文件 → 同样 `git/dirty-worktree`（不建备份、不重置）。
// - 上游改写的判定（修复轮 1）：fetch 前后比较 + 远程跟踪 ref 的 reflog fork point（见 reflogForkPoint）。

import type { FetchValue, IntegrateValue, PullMode, ResetToRemoteValue } from '../../shared/protocol.ts'
import type { WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { refSha } from './branch-write.ts'
import { MERGE_HOOKS, REBASE_HOOKS, assertCleanUnlessStash, runIntegration } from './integrate.ts'
import { networkFailure } from './push.ts'
import { dirtyTrackedPaths, dirtyWorktree, queryOf, readHeadPosition } from './smart-stash.ts'
import {
  CLEAN_BATCH_MAX,
  assertNoOperation,
  batches,
  invalidPayload,
  optionalBoolean,
  parseRefName,
  payloadRecord,
  query,
  queryOk,
  readHead,
  readRemotes,
  redactedFailure,
} from './write-support.ts'

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** Backup names tried before giving up (`<base>`, `<base>-2` … `<base>-100`). */
const BACKUP_ATTEMPTS = 100

/**
 * Changed refs in `fetch --porcelain` output (`<flag> <old> <new> <ref>`): every line except
 * up-to-date (`=`) and rejected (`!`) ones.
 */
export function parseFetchPorcelain(stdout: string): number {
  let count = 0
  for (const line of stdout.split('\n')) {
    const match = /^(.) [0-9a-f]+ [0-9a-f]+ \S/.exec(line)
    if (match === null) continue
    if (match[1] === '=' || match[1] === '!') continue
    count += 1
  }
  return count
}

// --- fetch ---------------------------------------------------------------------------

export interface FetchInput {
  /** null: every remote (`--all`). */
  remote: string | null
  prune: boolean
}

function isPorcelainUnsupported(exitCode: number | null, stderr: string): boolean {
  return exitCode === 129 && /porcelain/.test(stderr)
}

export const fetchOperation: WriteOperation<FetchInput, Omit<FetchValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    if (typeof record.prune !== 'boolean') throw invalidPayload('prune must be a boolean')
    const remote = record.remote === null ? null : parseRefName(record.remote, 'remote')
    return { remote, prune: record.prune }
  },

  async run(ctx, input) {
    if (input.remote !== null && !(await readRemotes(ctx)).includes(input.remote)) {
      throw invalidPayload(`unknown remote "${input.remote}"`, { remote: input.remote })
    }
    const options = [...(input.prune ? ['--prune'] : []), '--no-recurse-submodules']
    const target = input.remote === null ? ['--all'] : ['--', input.remote]
    let porcelain = true
    let result = await ctx.git([...GIT_BASE_ARGV, 'fetch', '--porcelain', ...options, ...target], { mode: 'network' })
    if (isPorcelainUnsupported(result.exitCode, result.stderr)) {
      // Git < 2.41: the usage error happens before any network access, so one retry is safe.
      porcelain = false
      result = await ctx.git([...GIT_BASE_ARGV, 'fetch', ...options, ...target], { mode: 'network' })
    }
    if (result.exitCode !== 0) {
      const terminalArgs = ['fetch', ...(input.prune ? ['--prune'] : []), ...(input.remote === null ? ['--all'] : [input.remote])]
      throw networkFailure(result, ctx.repoRoot, terminalArgs, 'git fetch')
    }
    return porcelain ? { updatedRefs: parseFetchPorcelain(result.stdout) } : {}
  },
}

// --- upstream ------------------------------------------------------------------------

interface Upstream {
  /** Local branch name (without `refs/heads/`). */
  branch: string
  /** Full upstream ref, e.g. `refs/remotes/origin/main` (or `refs/heads/x` for a local upstream). */
  ref: string
  /** Remote name; `.` for a local upstream. */
  remote: string
  /** The branch's ref on the remote, e.g. `refs/heads/main`. */
  remoteRef: string
}

function noUpstream(message: string): GitCommandFailure {
  return invalidPayload(message, { reason: 'no-upstream' })
}

/** The current branch and its configured upstream, or `git/invalid-payload` reason 'no-upstream'. */
async function readUpstream(ctx: WriteContext): Promise<Upstream> {
  const head = await readHeadPosition(queryOf(ctx))
  if (head.branch === null) throw noUpstream('HEAD is detached and has no upstream')
  const stdout = await queryOk(
    ctx,
    ['for-each-ref', '--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)', head.branch],
    'git for-each-ref',
  )
  const [ref = '', remote = '', remoteRef = ''] = stdout.replace(/\n$/, '').split('\0')
  const branch = head.branch.replace(/^refs\/heads\//, '')
  if (ref === '') throw noUpstream(`branch "${branch}" has no upstream`)
  return { branch, ref, remote, remoteRef }
}

/** `merge-base --is-ancestor`: exit 0 yes, 1 no, anything else an error. */
async function isAncestor(ctx: WriteContext, ancestor: string, descendant: string): Promise<boolean> {
  const result = await query(ctx, ['merge-base', '--is-ancestor', ancestor, descendant])
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw redactedFailure(result, 'git merge-base')
}

/**
 * Fix round 1: a rewrite that an earlier fetch already brought in (fetch endpoint, Push Rejected,
 * pull, a terminal, a second Update click) is invisible to the before/after compare. The tracking
 * ref's reflog still has it: `merge-base --fork-point <upstream> HEAD` is the newest earlier
 * upstream tip HEAD is based on; when that is not an ancestor of the current tip, the upstream was
 * rewritten under HEAD. No reflog (or no fork point) → exit 1 → undefined (before/after compare only).
 */
async function reflogForkPoint(ctx: WriteContext, upstreamRef: string, newSha: string): Promise<string | undefined> {
  const result = await query(ctx, ['merge-base', '--fork-point', upstreamRef, 'HEAD'])
  const forkPoint = result.stdout.trim()
  if (result.exitCode !== 0 || !SHA_PATTERN.test(forkPoint)) return undefined
  return (await isAncestor(ctx, forkPoint, newSha)) ? undefined : forkPoint
}

// --- updateProject -------------------------------------------------------------------

export interface UpdateProjectInput {
  mode: PullMode
  stash: boolean
}

export const updateProjectOperation: WriteOperation<UpdateProjectInput, Omit<IntegrateValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const mode = record.mode
    if (mode !== 'rebase' && mode !== 'merge') throw invalidPayload('mode must be "rebase" or "merge"')
    return { mode, stash: optionalBoolean(record, 'stash') }
  },

  async run(ctx, input) {
    await assertNoOperation(ctx)
    const upstream = await readUpstream(ctx)
    await assertCleanUnlessStash(ctx, input.stash, 'update')

    if (upstream.remote !== '.') {
      if (!(await readRemotes(ctx)).includes(upstream.remote) || !upstream.remoteRef.startsWith('refs/heads/')) {
        throw noUpstream(`the upstream "${upstream.ref}" does not belong to a configured remote`)
      }
      const oldSha = await refSha(ctx, upstream.ref)
      const fetched = await ctx.git(
        [
          ...GIT_BASE_ARGV,
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-recurse-submodules',
          '--',
          upstream.remote,
          `+${upstream.remoteRef}:${upstream.ref}`,
        ],
        { mode: 'network' },
      )
      if (fetched.exitCode !== 0) {
        const terminalArgs = ['pull', input.mode === 'rebase' ? '--rebase' : '--no-rebase']
        throw networkFailure(fetched, ctx.repoRoot, terminalArgs, 'git fetch')
      }
      const newSha = await refSha(ctx, upstream.ref)
      if (newSha === undefined) {
        throw new GitCommandFailure('git/exec-failed', `the upstream "${upstream.ref}" is missing after the fetch`)
      }
      const rewrittenFrom =
        oldSha !== undefined && oldSha !== newSha && !(await isAncestor(ctx, oldSha, newSha))
          ? oldSha
          : await reflogForkPoint(ctx, upstream.ref, newSha)
      if (rewrittenFrom !== undefined) {
        const ahead = await queryOk(ctx, ['rev-list', '--count', 'HEAD', '--not', newSha, '--'], 'git rev-list')
        throw new GitCommandFailure('git/upstream-rewritten', `the upstream "${upstream.ref}" was rewritten`, {
          oldSha: rewrittenFrom,
          newSha,
          localAhead: Number.parseInt(ahead.trim(), 10) || 0,
        })
      }
    }

    return await runIntegration(ctx, {
      operation: 'update',
      args:
        input.mode === 'rebase'
          ? ['rebase', '--end-of-options', upstream.ref]
          : ['merge', '--no-edit', '--end-of-options', upstream.ref],
      label: input.mode,
      stash: input.stash,
      details: { mode: input.mode },
      hooks: input.mode === 'rebase' ? REBASE_HOOKS : MERGE_HOOKS,
    })
  },
}

// --- resetToRemote -------------------------------------------------------------------

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/** `backup/<branch>-<YYYYMMDD-HHmmss>` in the Host's local time. */
export function backupBranchName(branch: string, now: Date): string {
  const date = `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `backup/${branch}-${date}-${time}`
}

export interface ResetToRemoteInput {
  backup: boolean
}

/** First free backup name: `<base>`, then `<base>-2`, `<base>-3`, … */
async function freeBackupName(ctx: WriteContext, base: string): Promise<string> {
  for (let attempt = 1; attempt <= BACKUP_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${String(attempt)}`
    if ((await refSha(ctx, `refs/heads/${name}`)) === undefined) {
      const check = await query(ctx, ['check-ref-format', '--branch', name])
      if (check.exitCode !== 0 || check.stdout.trim() !== name) {
        throw invalidPayload(`invalid backup branch name "${name}"`, { branch: name })
      }
      return name
    }
  }
  throw new GitCommandFailure('git/branch-exists', `no free backup branch name for "${base}"`, { branch: base })
}

/**
 * Fix round 1: untracked or ignored files that `reset --hard <target>` would overwrite. With a clean
 * index (checked first) those are the target's files missing from HEAD (`diff --diff-filter=A`)
 * that exist untracked/ignored in the worktree (`ls-files --others` without exclude rules lists
 * both). `ls-files` has no `--pathspec-from-file`, so paths go in argv batches.
 */
async function untrackedInTheWay(ctx: WriteContext, target: string): Promise<string[]> {
  const added = (
    await queryOk(
      ctx,
      ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', 'HEAD', target, '--'],
      'git diff',
    )
  )
    .split('\0')
    .filter((path) => path !== '')
  const found: string[] = []
  for (const batch of batches(added, CLEAN_BATCH_MAX)) {
    const stdout = await queryOk(ctx, ['--literal-pathspecs', 'ls-files', '-z', '--others', '--', ...batch], 'git ls-files')
    found.push(...stdout.split('\0').filter((path) => path !== ''))
  }
  return found.sort()
}

/** The operation with an injectable clock (tests pin the backup timestamp). */
export function createResetToRemoteOperation(
  now: () => Date = () => new Date(),
): WriteOperation<ResetToRemoteInput, Omit<ResetToRemoteValue, 'version'>> {
  return {
    parse(payload) {
      const record = payloadRecord(payload)
      return { backup: record.backup === undefined ? true : optionalBoolean(record, 'backup') }
    },

    async run(ctx, input) {
      await assertNoOperation(ctx)
      const upstream = await readUpstream(ctx)
      const target = await refSha(ctx, `${upstream.ref}^{commit}`)
      if (target === undefined) throw noUpstream(`the upstream "${upstream.ref}" does not exist locally`)
      const dirty = await dirtyTrackedPaths(ctx)
      if (dirty.length > 0) throw dirtyWorktree(dirty)
      const inTheWay = await untrackedInTheWay(ctx, target)
      if (inTheWay.length > 0) throw dirtyWorktree(inTheWay)

      let backupBranch: string | undefined
      if (input.backup) {
        const head = (await readHead(ctx)).sha
        backupBranch = await freeBackupName(ctx, backupBranchName(upstream.branch, now()))
        const created = await ctx.git([...GIT_BASE_ARGV, 'branch', '--no-track', '--', backupBranch, head])
        if (created.exitCode !== 0) throw redactedFailure(created, 'git branch')
      }
      const reset = await ctx.git([...GIT_BASE_ARGV, 'reset', '-q', '--hard', target, '--'])
      if (reset.exitCode !== 0) throw redactedFailure(reset, 'git reset --hard')
      const head = (await readHead(ctx)).sha
      return backupBranch === undefined ? { head } : { head, backupBranch }
    },
  }
}

export const resetToRemoteOperation = createResetToRemoteOperation()
