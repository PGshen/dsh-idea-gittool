// 分支写操作（A3 T3，设计 §8.3）：签出、新建、重命名、删除（仅本地分支）。
// - 签出按 IntelliJ 行为（负责人 2026-10-26 确认）：normal 直接签出、改动随分支带走，只有 git 拒绝
//   （本地改动会被覆盖）时才返回 `git/would-overwrite` + 路径；stash = 智能签出（withSmartStash）；
//   force = `switch --discard-changes`。
// - 用户输入（分支名、修订号）先经 parseRefName（不以 `-` 开头、无空白），再由 git 校验
//   （`check-ref-format --branch`、`rev-parse --verify --end-of-options <rev>^{commit}`），
//   命令里一律用 `--end-of-options` / `--` 分隔。
// - 目标在执行时重新读取：分支不存在 → `git/stale-target`（target 'branch'）；删除时 tip 与
//   `expectedSha` 不一致 → `git/stale-target`，不删除意料之外的提交。

import type {
  CheckoutMode,
  CheckoutTargetKind,
  CheckoutValue,
  CreateBranchValue,
  DeleteBranchValue,
  RenameBranchValue,
  WouldOverwriteDetails,
} from '../../shared/protocol.ts'
import { DIRTY_PATHS_LIMIT } from '../../shared/protocol.ts'
import type { GitRunResult, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { queryOf, readHeadPosition, withSmartStash } from './smart-stash.ts'
import {
  OBJECT_ID_PATTERN,
  assertNoOperation,
  invalidPayload,
  parseRefName,
  payloadRecord,
  query,
  readHead,
  readRemotes,
  redactedFailure,
} from './write-support.ts'

const TARGET_KINDS: readonly CheckoutTargetKind[] = ['local', 'remote', 'tag', 'revision']
const CHECKOUT_MODES: readonly CheckoutMode[] = ['normal', 'stash', 'force']

function staleBranch(expected: string): GitCommandFailure {
  return new GitCommandFailure('git/stale-target', `branch "${expected}" is not what was expected`, {
    target: 'branch',
    expected,
  })
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw invalidPayload(`${key} must be a boolean`)
  return value
}

/** Full sha of `ref` when it exists, otherwise undefined (no error: callers decide). */
export async function refSha(ctx: WriteContext, ref: string): Promise<string | undefined> {
  const result = await query(ctx, ['rev-parse', '-q', '--verify', '--end-of-options', ref])
  const sha = result.stdout.trim()
  return result.exitCode === 0 && OBJECT_ID_PATTERN.test(sha) ? sha : undefined
}

/** The commit a user-supplied revision names, or `git/invalid-payload`. */
export async function resolveCommit(ctx: WriteContext, revision: string, label: string): Promise<string> {
  const sha = await refSha(ctx, `${revision}^{commit}`)
  if (sha === undefined) throw invalidPayload(`unknown ${label} "${revision}"`, { [label]: revision })
  return sha
}

/**
 * A valid new branch name per `check-ref-format --branch`. The output must equal the input:
 * `--branch` expands `@{-1}` and similar shorthands, which are never a new name.
 */
async function assertBranchName(ctx: WriteContext, name: string): Promise<void> {
  const result = await query(ctx, ['check-ref-format', '--branch', name])
  if (result.exitCode !== 0 || result.stdout.trim() !== name) {
    throw invalidPayload(`invalid branch name "${name}"`, { branch: name })
  }
}

async function assertBranchAbsent(ctx: WriteContext, name: string): Promise<void> {
  if ((await refSha(ctx, `refs/heads/${name}`)) !== undefined) {
    throw new GitCommandFailure('git/branch-exists', `branch "${name}" already exists`, { branch: name })
  }
}

/** Headers of the lists `switch` prints before refusing; `untracked` lists files git will not clobber. */
const OVERWRITE_HEADERS: ReadonlyArray<{ pattern: RegExp; untracked: boolean }> = [
  { pattern: /Your local changes to the following files would be overwritten by (checkout|switch|merge)/i, untracked: false },
  { pattern: /untracked working tree files would be (overwritten|removed) by (checkout|switch|merge)/i, untracked: true },
  { pattern: /Updating the following directories would lose untracked files in them/i, untracked: true },
]

/**
 * `git/would-overwrite` details from a refused `switch` or `stash apply` (git 2.50, LC_ALL=C): tracked local
 * changes go to `paths`, untracked files/directories in the way to `untracked`. Each listed
 * path is a tab-indented line after its header. Undefined when stderr is not such a refusal.
 */
export function wouldOverwriteDetails(stderr: string): WouldOverwriteDetails | undefined {
  const paths: string[] = []
  const untracked: string[] = []
  let matched = false
  let list: string[] | undefined
  for (const line of stderr.split('\n')) {
    const header = OVERWRITE_HEADERS.find((candidate) => candidate.pattern.test(line))
    if (header !== undefined) {
      matched = true
      list = header.untracked ? untracked : paths
      continue
    }
    if (list !== undefined && line.startsWith('\t')) {
      list.push(line.slice(1))
      continue
    }
    list = undefined
  }
  if (!matched) return undefined
  return {
    paths: paths.slice(0, DIRTY_PATHS_LIMIT),
    ...(untracked.length === 0 ? {} : { untracked: untracked.slice(0, DIRTY_PATHS_LIMIT) }),
  }
}

/** Classify a failed `switch`: would-overwrite (with paths) or a redacted generic failure. */
function switchFailure(result: GitRunResult): GitCommandFailure {
  const details = wouldOverwriteDetails(result.stderr)
  if (details !== undefined) {
    return new GitCommandFailure(
      'git/would-overwrite',
      'local changes or untracked files would be overwritten by checkout',
      { ...details },
    )
  }
  return redactedFailure(result, 'git switch')
}

async function runSwitch(ctx: WriteContext, args: readonly string[]): Promise<void> {
  const result = await ctx.git([...GIT_BASE_ARGV, 'switch', ...args])
  if (result.exitCode !== 0) throw switchFailure(result)
}

async function headValue(ctx: WriteContext): Promise<Pick<CheckoutValue, 'branch' | 'detached' | 'head'>> {
  const position = await readHeadPosition(queryOf(ctx))
  const head = (await readHead(ctx)).sha
  if (position.branch === null) return { branch: null, detached: true, head }
  return { branch: position.branch.replace(/^refs\/heads\//, ''), detached: false, head }
}

// --- checkout ----------------------------------------------------------------------

export interface CheckoutInput {
  kind: CheckoutTargetKind
  name: string
  mode: CheckoutMode
}

/** `switch` arguments (after the mode flag) for a target, re-resolved at execution time. */
async function switchArgs(ctx: WriteContext, input: CheckoutInput): Promise<string[]> {
  switch (input.kind) {
    case 'local':
      if ((await refSha(ctx, `refs/heads/${input.name}`)) === undefined) throw staleBranch(input.name)
      return ['--end-of-options', input.name]
    case 'remote': {
      const remote = (await readRemotes(ctx))
        .filter((candidate) => input.name.startsWith(`${candidate}/`))
        .sort((a, b) => b.length - a.length)[0]
      const local = remote === undefined ? '' : input.name.slice(remote.length + 1)
      if (remote === undefined || local === '') {
        throw invalidPayload(`"${input.name}" is not a branch of a configured remote`, { name: input.name })
      }
      if ((await refSha(ctx, `refs/remotes/${input.name}`)) === undefined) throw staleBranch(input.name)
      if ((await refSha(ctx, `refs/heads/${local}`)) !== undefined) return ['--end-of-options', local]
      await assertBranchName(ctx, local)
      return ['-c', local, '--track', '--end-of-options', `refs/remotes/${input.name}`]
    }
    case 'tag': {
      const sha = await refSha(ctx, `refs/tags/${input.name}^{commit}`)
      if (sha === undefined) throw invalidPayload(`unknown tag "${input.name}"`, { tag: input.name })
      return ['--detach', '--end-of-options', sha]
    }
    case 'revision':
      return ['--detach', '--end-of-options', await resolveCommit(ctx, input.name, 'revision')]
  }
}

export const checkoutOperation: WriteOperation<CheckoutInput, Omit<CheckoutValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const target = record.target
    if (typeof target !== 'object' || target === null || Array.isArray(target)) {
      throw invalidPayload('target must be an object')
    }
    const { kind, name } = target as Record<string, unknown>
    if (!TARGET_KINDS.includes(kind as CheckoutTargetKind)) {
      throw invalidPayload('target.kind must be local, remote, tag or revision')
    }
    const mode = record.mode ?? 'normal'
    if (!CHECKOUT_MODES.includes(mode as CheckoutMode)) throw invalidPayload('mode must be normal, stash or force')
    return { kind: kind as CheckoutTargetKind, name: parseRefName(name, 'target.name'), mode: mode as CheckoutMode }
  },

  async run(ctx, input) {
    await assertNoOperation(ctx)
    const args = await switchArgs(ctx, input)
    if (input.mode === 'normal') {
      await runSwitch(ctx, args)
      return await headValue(ctx)
    }
    if (input.mode === 'force') {
      await runSwitch(ctx, ['--discard-changes', ...args])
      return await headValue(ctx)
    }
    let switched = false
    try {
      const { outcome } = await withSmartStash(ctx, { stash: true, operation: 'checkout' }, async () => {
        await runSwitch(ctx, args)
        switched = true
      })
      return { ...(await headValue(ctx)), ...outcome }
    } catch (error) {
      // The checkout itself succeeded; only restoring the stash conflicted (it stays in the list).
      if (switched && error instanceof GitCommandFailure && error.code === 'git/conflict' && error.details?.stashKept === true) {
        return { ...(await headValue(ctx)), stashKept: true }
      }
      throw error
    }
  },
}

// --- createBranch ------------------------------------------------------------------

export interface CreateBranchInput {
  name: string
  startPoint: string
  checkout: boolean
}

export const createBranchOperation: WriteOperation<CreateBranchInput, Omit<CreateBranchValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return {
      name: parseRefName(record.name, 'name'),
      startPoint: parseRefName(record.startPoint, 'startPoint'),
      checkout: requiredBoolean(record, 'checkout'),
    }
  },

  async run(ctx, input) {
    await assertBranchName(ctx, input.name)
    await assertBranchAbsent(ctx, input.name)
    // Validate the start point, then hand git its NAME: starting from a remote-tracking branch
    // lets `branch.autoSetupMerge` set the upstream (设计 §11「跟踪远程」); a local branch or sha does not.
    await resolveCommit(ctx, input.startPoint, 'startPoint')
    if (input.checkout) {
      await assertNoOperation(ctx)
      await runSwitch(ctx, ['-c', input.name, '--end-of-options', input.startPoint])
    } else {
      const result = await ctx.git([...GIT_BASE_ARGV, 'branch', '--', input.name, input.startPoint])
      if (result.exitCode !== 0) throw redactedFailure(result, 'git branch')
    }
    const sha = await refSha(ctx, `refs/heads/${input.name}`)
    if (sha === undefined) throw new GitCommandFailure('git/exec-failed', `branch "${input.name}" was not created`)
    return { branch: input.name, sha, checkedOut: input.checkout }
  },
}

// --- renameBranch ------------------------------------------------------------------

export interface RenameBranchInput {
  from: string
  to: string
}

export const renameBranchOperation: WriteOperation<RenameBranchInput, Omit<RenameBranchValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return { from: parseRefName(record.from, 'from'), to: parseRefName(record.to, 'to') }
  },

  async run(ctx, input) {
    if ((await refSha(ctx, `refs/heads/${input.from}`)) === undefined) throw staleBranch(input.from)
    await assertBranchName(ctx, input.to)
    await assertBranchAbsent(ctx, input.to)
    const result = await ctx.git([...GIT_BASE_ARGV, 'branch', '-m', '--', input.from, input.to])
    if (result.exitCode !== 0) throw redactedFailure(result, 'git branch -m')
    return { branch: input.to }
  },
}

// --- deleteBranch ------------------------------------------------------------------

export interface DeleteBranchInput {
  name: string
  force: boolean
  expectedSha?: string
}

export const deleteBranchOperation: WriteOperation<DeleteBranchInput, Omit<DeleteBranchValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const input: DeleteBranchInput = {
      name: parseRefName(record.name, 'name'),
      force: requiredBoolean(record, 'force'),
    }
    const expected = record.expectedSha
    if (expected !== undefined) {
      if (typeof expected !== 'string' || !OBJECT_ID_PATTERN.test(expected)) {
        throw invalidPayload('expectedSha must be a full lowercase hexadecimal object name')
      }
      input.expectedSha = expected
    }
    return input
  },

  async run(ctx, input) {
    const head = await readHeadPosition(queryOf(ctx))
    if (head.branch === `refs/heads/${input.name}`) {
      throw invalidPayload('cannot delete the current branch', { branch: input.name })
    }
    const sha = await refSha(ctx, `refs/heads/${input.name}`)
    if (sha === undefined) throw staleBranch(input.name)
    if (input.expectedSha !== undefined && sha !== input.expectedSha) throw staleBranch(input.expectedSha)

    const result = await ctx.git([...GIT_BASE_ARGV, 'branch', input.force ? '-D' : '-d', '--', input.name])
    if (result.exitCode !== 0) {
      if (/not fully merged/i.test(result.stderr)) {
        throw new GitCommandFailure('git/not-merged', `branch "${input.name}" is not fully merged`, {
          branch: input.name,
        })
      }
      throw redactedFailure(result, 'git branch -d')
    }
    return { branch: input.name, sha }
  },
}
