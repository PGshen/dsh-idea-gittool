// Worktrees (plan b3d T3, behind the client flag `worktrees`): list, add from an existing or a new
// branch at a path inside the repository (the write boundary of `workspace-write`), remove, prune.
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorktreeAddValue, WorktreeEntry, WorktreePruneValue, WorktreeRemoveValue } from '../../shared/protocol.ts'
import type { GitRunner, WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, failureFromExit } from '../git-executor.ts'
import { validateRepoPath } from './diff.ts'
import { invalidPayload, optionalBoolean, outputSummary, parseRefName, payloadRecord, query, readRunner, redactedFailure } from './write-support.ts'

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** `worktree list --porcelain`, with `current` marking the worktree of `cwd`. */
export async function readWorktreeList(run: GitRunner, cwd: string, options: { signal?: AbortSignal | undefined } = {}): Promise<WorktreeEntry[]> {
  const listed = await run([...GIT_BASE_ARGV, 'worktree', 'list', '--porcelain'], { cwd, signal: options.signal })
  if (listed.exitCode !== 0) throw failureFromExit(listed, 'git worktree list')
  const top = await run([...GIT_BASE_ARGV, 'rev-parse', '--show-toplevel'], { cwd, signal: options.signal })
  const here = await canonical(top.exitCode === 0 ? top.stdout.trim() : cwd)
  const entries: WorktreeEntry[] = []
  for (const block of listed.stdout.split('\n\n')) {
    const lines = block.split('\n').filter(line => line !== '')
    const pathLine = lines.find(line => line.startsWith('worktree '))
    if (pathLine === undefined) continue
    const path = await canonical(pathLine.slice('worktree '.length))
    const branchLine = lines.find(line => line.startsWith('branch '))
    entries.push({
      path,
      head: lines.find(line => line.startsWith('HEAD '))?.slice(5) ?? null,
      branch: branchLine === undefined ? null : branchLine.slice('branch '.length).replace(/^refs\/heads\//u, ''),
      current: path === here,
      locked: lines.some(line => line === 'locked' || line.startsWith('locked ')),
      prunable: lines.some(line => line === 'prunable' || line.startsWith('prunable ')),
      bare: lines.includes('bare'),
    })
  }
  return entries
}

async function listOf(ctx: WriteContext): Promise<WorktreeEntry[]> {
  return await readWorktreeList(readRunner(ctx), ctx.repoRoot)
}

export interface WorktreeAddInput {
  path: string
  branch: string
  createBranch: boolean
  startPoint: string | undefined
}

export const worktreeAddOperation: WriteOperation<WorktreeAddInput, Omit<WorktreeAddValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return {
      path: validateRepoPath(record.path),
      branch: parseRefName(record.branch, 'branch'),
      createBranch: optionalBoolean(record, 'createBranch'),
      startPoint: record.startPoint === undefined ? undefined : parseRefName(record.startPoint, 'startPoint'),
    }
  },

  async run(ctx, input) {
    const target = join(ctx.repoRoot, input.path)
    const ref = `refs/heads/${input.branch}`
    if ((await query(ctx, ['check-ref-format', ref])).exitCode !== 0) throw invalidPayload(`invalid branch name "${input.branch}"`, {})
    const exists = (await query(ctx, ['rev-parse', '-q', '--verify', ref])).exitCode === 0
    if (input.createBranch && exists) throw invalidPayload(`branch "${input.branch}" already exists`, { reason: 'branch-exists' })
    if (!input.createBranch && !exists) throw invalidPayload(`branch "${input.branch}" does not exist`, { reason: 'no-branch' })
    const args = input.createBranch
      ? ['worktree', 'add', '-b', input.branch, '--', target, input.startPoint ?? 'HEAD']
      : ['worktree', 'add', '--', target, input.branch]
    const result = await ctx.git([...GIT_BASE_ARGV, ...args])
    if (result.exitCode !== 0) {
      if (/already (checked out|used by worktree)/iu.test(result.stderr)) {
        throw invalidPayload(`branch "${input.branch}" is checked out in another worktree`, { reason: 'branch-checked-out', output: outputSummary(result) })
      }
      throw redactedFailure(result, 'git worktree add')
    }
    const path = await canonical(target)
    const worktree = (await listOf(ctx)).find(entry => entry.path === path)
    if (worktree === undefined) throw invalidPayload('the new worktree is not listed', {})
    return { worktree }
  },
}

export const worktreeRemoveOperation: WriteOperation<{ path: string; force: boolean }, Omit<WorktreeRemoveValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    if (typeof record.path !== 'string' || record.path === '' || record.path.includes('\0')) throw invalidPayload('path must be a worktree path', {})
    return { path: record.path, force: optionalBoolean(record, 'force') }
  },

  async run(ctx, input) {
    const path = await canonical(input.path)
    const entry = (await listOf(ctx)).find(candidate => candidate.path === path)
    if (entry === undefined) throw invalidPayload('not a worktree of this repository', { reason: 'not-a-worktree' })
    if (entry.current || entry.bare) throw invalidPayload('the current worktree cannot be removed', { reason: 'current-worktree' })
    const result = await ctx.git([...GIT_BASE_ARGV, 'worktree', 'remove', ...(input.force ? ['--force'] : []), '--', entry.path])
    if (result.exitCode !== 0) {
      if (/contains modified or untracked files|is dirty/iu.test(result.stderr)) {
        throw invalidPayload('the worktree has uncommitted changes', { reason: 'worktree-dirty', output: outputSummary(result) })
      }
      throw redactedFailure(result, 'git worktree remove')
    }
    return { path: entry.path }
  },
}

export const worktreePruneOperation: WriteOperation<Record<string, never>, Omit<WorktreePruneValue, 'version'>> = {
  parse() {
    return {}
  },

  async run(ctx) {
    const before = (await listOf(ctx)).filter(entry => entry.prunable).length
    const result = await ctx.git([...GIT_BASE_ARGV, 'worktree', 'prune'])
    if (result.exitCode !== 0) throw redactedFailure(result, 'git worktree prune')
    const after = (await listOf(ctx)).filter(entry => entry.prunable).length
    return { pruned: before - after }
  },
}
