// 贮藏读写（A3 T5，设计 §8.5）：
// - 列表：一条 `stash list --format` 取 sha/父提交/信息/日期；文件数用一条 `diff-tree --stdin`
//   批量算「贮藏 vs 第一父」，超过 STASH_FILE_COUNT_LIMIT 条时省略（列表在页面可见时会被轮询）；
// - 文件：已跟踪改动 = 第一父 → 贮藏；未跟踪文件 = 第三父（`-u` 贮藏的根提交）。预览 diff 复用
//   `diff` 端点 `scope: 'commit'`；
// - 创建：`stash push [-u] [--keep-index] --message=<msg>`；没写信息时 Host 生成
//   `WIP on <branch>: <short> <subject>`（detached 为 `(no branch)`）。不带路径，所以关掉
//   写环境的字面路径模式（`--keep-index` 内部要用 `:/` 魔法路径）；无可贮藏的改动 →
//   `git/invalid-payload` + `reason: 'nothing-to-stash'`；
// - 应用/删除一律按 sha：在写队列里重新 `stash list`，找不到 → `git/stale-target`。apply 直接
//   按 sha（git 接受贮藏提交本身），先 `--index`，暂存区还原不了再只还原内容；冲突 →
//   `git/conflict` + `stashKept`，任何失败都不删贮藏。`pop` = 应用成功后再按 sha 删除；
//   删除时核对 git 报告删掉的 sha，不是预期的那条（列表在两条命令之间又变了）就立刻
//   `stash store` 放回去，不丢任何贮藏；
// - 有操作进行中或还有未解决的冲突时，创建/应用一律先拒绝（`git/operation-in-progress` / `git/conflict`）；
// - pop/drop 删掉的正是 T2 待恢复标记记录的贮藏时，经受限 git 写命令一起删掉标记（只 apply 不动标记）。

import type {
  CommitFileEntry,
  FileEntry,
  StashApplyValue,
  StashCreateValue,
  StashDropValue,
  StashEntry,
  StashFilesValue,
  StashListValue,
} from '../../shared/protocol.ts'
import { STASH_FILE_COUNT_LIMIT } from '../../shared/protocol.ts'
import type { GitRunResult, GitRunner, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure, failureFromExit } from '../git-executor.ts'
import { wouldOverwriteDetails } from './branch-write.ts'
import type { RawChange } from './commit.ts'
import { COMMIT_FILE_LIMIT, parseRawNumstat, toFileEntry } from './commit.ts'
import { parseFullSha } from './integrate.ts'
import { queryOf, readPendingStash, removePendingStash, stashTop } from './smart-stash.ts'
import { OBJECT_ID_PATTERN, assertNoOperation, invalidPayload, outputSummary, payloadRecord, queryOk, redactedFailure } from './write-support.ts'

/** Longest accepted stash message (characters, after whitespace is collapsed). */
export const STASH_MESSAGE_MAX = 1000

/** sha, parents, reflog subject, committer date. */
const LIST_FORMAT = '--format=%H%x00%P%x00%gs%x00%cI'

interface ListedStash {
  sha: string
  parents: string[]
  /** The reflog subject: `On <branch>: <message>` or `WIP on <branch>: <short> <subject>`. */
  subject: string
  date: string
}

function parseList(stdout: string): ListedStash[] {
  const stashes: ListedStash[] = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const [sha = '', parents = '', subject = '', date = ''] = line.split('\0')
    if (!OBJECT_ID_PATTERN.test(sha)) continue
    stashes.push({ sha, parents: parents === '' ? [] : parents.split(' '), subject, date })
  }
  return stashes
}

/** Branch and display message of a reflog subject (git 2.50 formats). */
export function describeStash(subject: string): { branch: string | null; message: string } {
  const custom = /^On ([^:]+): ([\s\S]*)$/.exec(subject)
  if (custom !== null) return { branch: branchOf(custom[1] ?? ''), message: custom[2] ?? '' }
  const wip = /^WIP on ([^:]+): /.exec(subject)
  if (wip !== null) return { branch: branchOf(wip[1] ?? ''), message: subject }
  return { branch: null, message: subject }
}

function branchOf(name: string): string | null {
  return name === '(no branch)' || name === '' ? null : name
}

/** Tracked file counts (stash vs. its first parent) for every listed stash in one call. */
async function fileCounts(
  git: (args: readonly string[], stdin?: string) => Promise<GitRunResult>,
  stashes: readonly ListedStash[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  const pairs = stashes.filter((stash) => stash.parents[0] !== undefined)
  if (pairs.length === 0) return counts
  for (const stash of pairs) counts.set(stash.sha, 0)
  const result = await git(
    ['diff-tree', '--stdin', '-r', '--name-only', '-z', '--no-renames'],
    pairs.map((stash) => `${stash.sha} ${stash.parents[0] ?? ''}\n`).join(''),
  )
  if (result.exitCode !== 0) throw failureFromExit(result, 'git diff-tree')
  // Output: `<commit sha>\0<path>\0...` per stash with changes; stashes without any are absent.
  let current: string | undefined
  for (const token of result.stdout.split('\0')) {
    if (token === '') continue
    if (counts.has(token) && token !== current) {
      current = token
      continue
    }
    if (current !== undefined) counts.set(current, (counts.get(current) ?? 0) + 1)
  }
  return counts
}

/** `stashList`: every stash in `stash@{n}` order. */
export async function readStashList(
  run: GitRunner,
  repoRoot: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<Omit<StashListValue, 'version'>> {
  const git = async (args: readonly string[], stdin?: string): Promise<GitRunResult> =>
    await run([...GIT_BASE_ARGV, ...args], {
      cwd: repoRoot,
      signal: options.signal,
      ...(stdin === undefined ? {} : { stdin }),
    })
  const listed = await git(['stash', 'list', LIST_FORMAT])
  if (listed.exitCode !== 0) throw failureFromExit(listed, 'git stash list')
  const stashes = parseList(listed.stdout)
  const counts = stashes.length > STASH_FILE_COUNT_LIMIT ? undefined : await fileCounts(git, stashes)
  const entries = stashes.map((stash, index): StashEntry => {
    const { branch, message } = describeStash(stash.subject)
    const fileCount = counts?.get(stash.sha)
    return {
      sha: stash.sha,
      index,
      message,
      branch,
      date: stash.date,
      ...(fileCount === undefined ? {} : { fileCount }),
    }
  })
  return { entries }
}

/** `stashFiles`: tracked changes (vs. the first parent) and untracked files (third parent). */
export async function readStashFiles(
  run: GitRunner,
  repoRoot: string,
  sha: unknown,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<Omit<StashFilesValue, 'version'>> {
  const full = parseFullSha(sha, 'sha')
  const git = async (args: readonly string[]): Promise<GitRunResult> =>
    await run([...GIT_BASE_ARGV, ...args], { cwd: repoRoot, signal: options.signal })

  const listed = await git(['rev-list', '--parents', '-n', '1', '--end-of-options', full, '--'])
  if (listed.exitCode !== 0) throw invalidPayload('sha does not name a commit', { sha: full })
  const [, parentSha, indexSha, untrackedSha] = listed.stdout.trim().split(' ')
  // A stash commit is a merge of HEAD and the index commit (plus the untracked commit with -u).
  if (parentSha === undefined || indexSha === undefined) {
    throw invalidPayload('sha does not name a stash', { sha: full })
  }

  const diffTree = async (range: readonly string[]): Promise<{ entries: RawChange[]; truncated: boolean }> => {
    const result = await git([
      'diff-tree',
      '-r',
      '-z',
      '-M',
      '--raw',
      '--numstat',
      '--no-abbrev',
      '--no-commit-id',
      '--no-ext-diff',
      ...range,
      '--',
    ])
    if (result.exitCode !== 0) throw failureFromExit(result, 'git diff-tree')
    const entries = parseRawNumstat(result.stdout)
    return { entries: entries.slice(0, COMMIT_FILE_LIMIT), truncated: entries.length > COMMIT_FILE_LIMIT }
  }

  const tracked = await diffTree([parentSha, full])
  const files: CommitFileEntry[] = tracked.entries.map((change) => toFileEntry(change, parentSha))
  let untracked: FileEntry[] = []
  let truncated = tracked.truncated
  if (untrackedSha !== undefined) {
    const added = await diffTree(['--root', untrackedSha])
    untracked = added.entries.map((change) => toFileEntry(change, null))
    truncated ||= added.truncated
  }
  return {
    sha: full,
    parentSha,
    untrackedSha: untrackedSha ?? null,
    files,
    untracked,
    ...(truncated ? { truncated } : {}),
  }
}

// --- writes ---------------------------------------------------------------------

/** The stash list as seen inside the write queue (shas and reflog subjects, `stash@{n}` order). */
async function listStashes(ctx: WriteContext): Promise<ListedStash[]> {
  return parseList(await queryOk(ctx, ['stash', 'list', LIST_FORMAT], 'git stash list'))
}

function staleStash(sha: string): GitCommandFailure {
  return new GitCommandFailure('git/stale-target', 'the stash no longer exists', { target: 'stash', expected: sha })
}

/** Throw `git/stale-target` unless a stash with this sha is in the list right now. */
async function assertStashListed(ctx: WriteContext, sha: string): Promise<void> {
  if (!(await listStashes(ctx)).some((stash) => stash.sha === sha)) throw staleStash(sha)
}

/**
 * Drop the stash with this sha. Resolves its current `stash@{n}`, drops it, and decides from
 * the list afterwards (fix round 1: never from git's output format): the sha gone → 'dropped';
 * still there → the list moved in between and another entry went instead, so every entry that
 * was listed before and is gone now is stored back at once → 'moved'. 'missing' when the sha
 * is not listed to begin with.
 */
async function dropBySha(ctx: WriteContext, sha: string): Promise<'dropped' | 'missing' | 'moved'> {
  const before = (await listStashes(ctx)).map((stash) => stash.sha)
  const index = before.indexOf(sha)
  if (index < 0) return 'missing'
  const result = await ctx.git([...GIT_BASE_ARGV, 'stash', 'drop', `stash@{${String(index)}}`])
  if (result.exitCode !== 0) throw redactedFailure(result, 'git stash drop')
  const after = new Set((await listStashes(ctx)).map((stash) => stash.sha))
  if (!after.has(sha)) return 'dropped'
  // Wrong entry: put it back (a stash commit's subject is its reflog message).
  for (const lost of before.filter((candidate) => !after.has(candidate))) {
    const subject = (await queryOk(ctx, ['log', '-1', '--format=%s', lost], 'git log')).trim()
    const stored = await ctx.git([...GIT_BASE_ARGV, 'stash', 'store', `--message=${subject}`, lost])
    if (stored.exitCode !== 0) throw redactedFailure(stored, 'git stash store')
  }
  return 'moved'
}

/** After a stash left the list: remove the T2 pending marker when it recorded this stash. */
async function clearPendingFor(ctx: WriteContext, sha: string): Promise<void> {
  const pending = await readPendingStash(queryOf(ctx))
  if (pending?.stashSha === sha) await removePendingStash(ctx)
}

const UNTRACKED_EXISTS = /^(.+) already exists, no checkout$/

async function unmergedPaths(ctx: WriteContext): Promise<string[]> {
  const stdout = await queryOk(ctx, ['diff', '--name-only', '-z', '--diff-filter=U'], 'git diff')
  return stdout.split('\0').filter((path) => path !== '')
}

/**
 * Applying or creating a stash inside an open merge/rebase/… would mix it into (or, for
 * `stash push`'s reset, wipe) the operation's state; unresolved conflicts from an earlier
 * apply would be misread as this apply's conflicts. Both are refused before git runs.
 */
async function assertQuietIndex(ctx: WriteContext): Promise<void> {
  await assertNoOperation(ctx)
  const unmerged = await unmergedPaths(ctx)
  if (unmerged.length > 0) {
    throw new GitCommandFailure('git/conflict', 'resolve the existing conflicts first', {
      conflicts: unmerged.length,
      stashKept: true,
    })
  }
}

/** Classify a failed `stash apply`: conflict, would-overwrite, or a redacted failure. Never drops. */
async function applyFailure(ctx: WriteContext, result: GitRunResult): Promise<GitCommandFailure> {
  const unmerged = await unmergedPaths(ctx)
  if (unmerged.length > 0) {
    return new GitCommandFailure('git/conflict', 'applying the stash stopped on conflicts; the stash was kept', {
      conflicts: unmerged.length,
      stashKept: true,
      output: outputSummary(result),
    })
  }
  const untracked = result.stderr
    .split('\n')
    .map((line) => UNTRACKED_EXISTS.exec(line.trim())?.[1])
    .filter((path): path is string => path !== undefined)
  const overwrite = wouldOverwriteDetails(result.stderr)
  if (overwrite !== undefined || untracked.length > 0) {
    return new GitCommandFailure('git/would-overwrite', 'local changes or untracked files would be overwritten by the stash', {
      paths: overwrite?.paths ?? [],
      ...(overwrite?.untracked !== undefined || untracked.length > 0
        ? { untracked: [...(overwrite?.untracked ?? []), ...untracked] }
        : {}),
      stashKept: true,
    })
  }
  const failure = redactedFailure(result, 'git stash apply')
  return new GitCommandFailure(failure.code, failure.message, { ...failure.details, stashKept: true })
}

export interface StashApplyInput {
  sha: string
  pop: boolean
}

export const stashApplyOperation: WriteOperation<StashApplyInput, Omit<StashApplyValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    if (typeof record.pop !== 'boolean') throw invalidPayload('pop must be a boolean')
    return { sha: parseFullSha(record.sha, 'sha'), pop: record.pop }
  },

  async run(ctx, input) {
    await assertStashListed(ctx, input.sha)
    await assertQuietIndex(ctx)
    let indexRestored = true
    const exact = await ctx.git([...GIT_BASE_ARGV, 'stash', 'apply', '--index', '--quiet', input.sha])
    if (exact.exitCode !== 0) {
      if ((await unmergedPaths(ctx)).length > 0 || !/conflicts in index/i.test(exact.stderr)) {
        throw await applyFailure(ctx, exact)
      }
      // The staging area cannot be rebuilt on the current index: restore the content only.
      const content = await ctx.git([...GIT_BASE_ARGV, 'stash', 'apply', '--quiet', input.sha])
      if (content.exitCode !== 0) throw await applyFailure(ctx, content)
      indexRestored = false
    }
    let dropped = false
    if (input.pop) {
      // The changes are applied: a failed drop must not read as a failed pop (a retry would
      // apply twice). Report success with the entry kept instead (fix round 1).
      try {
        dropped = (await dropBySha(ctx, input.sha)) === 'dropped'
      } catch {
        dropped = false
      }
      if (dropped) await clearPendingFor(ctx, input.sha).catch(() => undefined)
    }
    return { sha: input.sha, dropped, indexRestored }
  },
}

export interface StashDropInput {
  sha: string
}

export const stashDropOperation: WriteOperation<StashDropInput, Omit<StashDropValue, 'version'>> = {
  parse(payload) {
    return { sha: parseFullSha(payloadRecord(payload).sha, 'sha') }
  },

  async run(ctx, input) {
    const outcome = await dropBySha(ctx, input.sha)
    if (outcome !== 'dropped') throw staleStash(input.sha)
    await clearPendingFor(ctx, input.sha)
    return { sha: input.sha }
  },
}

export interface StashCreateInput {
  /** Whitespace-collapsed message; undefined → generated default. */
  message: string | undefined
  includeUntracked: boolean
  keepIndex: boolean
}

function parseStashMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidPayload('message must be a string')
  if (value.includes('\0')) throw invalidPayload('message must not contain NUL')
  // git folds a reflog message onto one line; do the same so the reply matches the list.
  const message = value.replace(/\s+/g, ' ').trim()
  if (message.length > STASH_MESSAGE_MAX) {
    throw invalidPayload(`message exceeds ${String(STASH_MESSAGE_MAX)} characters`, { limit: STASH_MESSAGE_MAX })
  }
  return message === '' ? undefined : message
}

/** `WIP on <branch>: <short> <subject>` as `git stash` itself would write it. */
async function defaultMessage(ctx: WriteContext): Promise<string> {
  const branch = await ctx.git([...GIT_BASE_ARGV, 'symbolic-ref', '-q', '--short', 'HEAD'], { mode: 'read' })
  const name = branch.exitCode === 0 && branch.stdout.trim() !== '' ? branch.stdout.trim() : '(no branch)'
  const head = await ctx.git([...GIT_BASE_ARGV, 'log', '-1', '--format=%h %s', 'HEAD'], { mode: 'read' })
  if (head.exitCode !== 0) throw redactedFailure(head, 'git log HEAD')
  return `WIP on ${name}: ${head.stdout.trim()}`
}

/** Whether `stash push` has anything to save (tracked changes, or untracked files with -u). */
async function hasStashableChanges(ctx: WriteContext, includeUntracked: boolean): Promise<boolean> {
  const stdout = await queryOk(
    ctx,
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      `--untracked-files=${includeUntracked ? 'all' : 'no'}`,
      '--ignore-submodules=none',
    ],
    'git status',
  )
  return stdout !== ''
}

function nothingToStash(): GitCommandFailure {
  return invalidPayload('there are no local changes to stash', { reason: 'nothing-to-stash' })
}

export const stashCreateOperation: WriteOperation<StashCreateInput, Omit<StashCreateValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    if (typeof record.includeUntracked !== 'boolean') throw invalidPayload('includeUntracked must be a boolean')
    if (typeof record.keepIndex !== 'boolean') throw invalidPayload('keepIndex must be a boolean')
    return {
      message: parseStashMessage(record.message),
      includeUntracked: record.includeUntracked,
      keepIndex: record.keepIndex,
    }
  },

  async run(ctx, input) {
    await assertQuietIndex(ctx)
    if (!(await hasStashableChanges(ctx, input.includeUntracked))) throw nothingToStash()
    const message = input.message ?? (await defaultMessage(ctx))
    const before = await stashTop(ctx)
    const pushed = await ctx.git([
      ...GIT_BASE_ARGV,
      // `--keep-index` re-checks-out the index with the magic pathspec ":/", which the write
      // environment's GIT_LITERAL_PATHSPECS=1 turns into a literal path: git 2.50 then fails
      // *after* stashing ("pathspec ':/' did not match"). No pathspec is passed here, so the
      // literal mode protects nothing for this command.
      '--no-literal-pathspecs',
      'stash',
      'push',
      '--quiet',
      ...(input.includeUntracked ? ['--include-untracked'] : []),
      ...(input.keepIndex ? ['--keep-index'] : []),
      // One argv element: a message starting with "-" can never be read as an option.
      `--message=${message}`,
    ])
    if (pushed.exitCode !== 0) throw redactedFailure(pushed, 'git stash push')
    const sha = await stashTop(ctx)
    // git exits 0 with "No local changes to save" when the changes vanished meanwhile.
    if (sha === undefined || sha === before) throw nothingToStash()
    return { sha, message }
  },
}
