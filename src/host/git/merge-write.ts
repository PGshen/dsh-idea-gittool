// 三栏合并窗口的写端点（B1 T3，设计 §10）：
// - `mergeDraftSave`：草稿存为 `refs/worktree/dsh-git/merge-draft/<sha1(path)>` → JSON blob（ADR 0008，只经受限 git）；
//   `draft.stages` 必须等于当前三方，否则 `git/stale-target`（target `conflict`）；
// - `mergeApply`：校验三方与加载时的工作区哈希后，按 references/git-behavior.md §2 三步写回——
//   `hash-object -w --stdin --path=<p>`（Result 过 clean filter）→ `update-index --cacheinfo <mode>,<sha>,<p>`
//   （stage 0，同时清掉 1/2/3，并记 resolve-undo）→ `checkout-index -f -- <p>`（按 smudge 写工作区、刷新 stat）；
//   已解决路径（Review Changes 再应用）的三方取自 resolve-undo，与 `mergeFile` 同一资格；成功后删草稿；
// - `unresolveConflict`：只对 resolve-undo 含 stage 2 与 3 的已解决路径执行 `checkout -m -- <p>`；删除类（DU/UD）
//   `checkout -m` 做不到，提示在终端处理；草稿保留（AC9）；
// - 草稿清理：操作结束（走完、中止、合并提交）删全部草稿，操作继续时删已不在冲突列表中的路径的草稿。
//   清理是尽力而为：失败不影响已成功的操作。

import type {
  MergeApplyRequest,
  MergeChunkState,
  MergeDraft,
  MergeDraftChunk,
  MergeDraftSaveValue,
  MergeStageShas,
  ResolveConflictValue,
  UnresolveConflictValue,
} from '../../shared/protocol.ts'
import { MERGE_CHUNK_STATES, MERGE_DRAFT_VERSION, validDraftChunkRange } from '../../shared/protocol.ts'
import type { WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { unmergedEntries } from './conflict.ts'
import { validateRepoPath } from './diff.ts'
import {
  MERGE_DRAFT_REF_PREFIX,
  conflictStageEntries,
  hashWorktree,
  mergeDraftRef,
  resolveUndoEntries,
  sameStages,
  stageShas,
} from './merge-file.ts'
import { deleteRefs, invalidPayload, payloadRecord, redactedFailure, writeJsonRef } from './write-support.ts'

/** Largest `result` accepted by `mergeApply` (UTF-8 bytes). */
export const MERGE_APPLY_RESULT_MAX_BYTES = 8 * 1024 * 1024
/** Largest draft accepted by `mergeDraftSave` (result plus chunk list). */
const MERGE_DRAFT_MAX_CHUNKS = 100_000
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function parseNullableSha(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) throw invalidPayload(`${label} must be an object id or null`)
  return value
}

function parseStages(value: unknown): MergeStageShas {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidPayload('stages must be an object')
  const record = value as Record<string, unknown>
  return {
    base: parseNullableSha(record.base, 'stages.base'),
    ours: parseNullableSha(record.ours, 'stages.ours'),
    theirs: parseNullableSha(record.theirs, 'stages.theirs'),
  }
}

function parseResult(value: unknown): string {
  if (typeof value !== 'string') throw invalidPayload('result must be a string')
  if (value.includes('\0')) throw invalidPayload('result must not contain NUL')
  if (Buffer.byteLength(value, 'utf8') > MERGE_APPLY_RESULT_MAX_BYTES) {
    throw invalidPayload(`result exceeds ${String(MERGE_APPLY_RESULT_MAX_BYTES)} bytes`, { limit: MERGE_APPLY_RESULT_MAX_BYTES })
  }
  return value
}

function parseDraft(value: unknown): MergeDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidPayload('draft must be an object')
  const record = value as Record<string, unknown>
  if (record.version !== MERGE_DRAFT_VERSION) throw invalidPayload('unsupported draft version')
  if (typeof record.savedAt !== 'string') throw invalidPayload('draft.savedAt must be a string')
  const chunks = record.chunks
  if (!Array.isArray(chunks) || chunks.length > MERGE_DRAFT_MAX_CHUNKS) throw invalidPayload('draft.chunks must be a bounded array')
  return {
    version: MERGE_DRAFT_VERSION,
    stages: parseStages(record.stages),
    result: parseResult(record.result),
    chunks: chunks.map((chunk: unknown) => {
      const entry = typeof chunk === 'object' && chunk !== null ? (chunk as Record<string, unknown>) : {}
      if (!(MERGE_CHUNK_STATES as readonly unknown[]).includes(entry.state)) throw invalidPayload('draft.chunks[].state is invalid')
      if (typeof entry.leftDone !== 'boolean' || typeof entry.rightDone !== 'boolean') {
        throw invalidPayload('draft.chunks[].leftDone/rightDone must be booleans')
      }
      if (!validDraftChunkRange(entry)) {
        throw invalidPayload('draft.chunks[].resultStart/resultEnd must both be absent or non-negative integers with start <= end')
      }
      const parsed: MergeDraftChunk = { state: entry.state as MergeChunkState, leftDone: entry.leftDone, rightDone: entry.rightDone }
      if (entry.resultStart !== undefined) {
        parsed.resultStart = entry.resultStart as number
        parsed.resultEnd = entry.resultEnd as number
      }
      return parsed
    }),
    savedAt: record.savedAt,
  }
}

function staleStages(path: string): GitCommandFailure {
  return new GitCommandFailure('git/stale-target', `the base/ours/theirs versions of "${path}" changed; reload the merge window`, {
    target: 'conflict',
    expected: path,
    reason: 'stages-changed',
  })
}

async function write(ctx: WriteContext, args: readonly string[], label: string, stdin?: string): Promise<string> {
  const result = await ctx.git([...GIT_BASE_ARGV, ...args], stdin === undefined ? undefined : { stdin })
  if (result.exitCode !== 0) throw redactedFailure(result, label)
  return result.stdout
}

export interface MergeDraftSaveInput {
  path: string
  draft: MergeDraft
}

export const mergeDraftSaveOperation: WriteOperation<MergeDraftSaveInput, Omit<MergeDraftSaveValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    return { path: validateRepoPath(record.path), draft: parseDraft(record.draft) }
  },

  async run(ctx, input) {
    const { entries } = await conflictStageEntries(ctx, input.path)
    if (!sameStages(input.draft.stages, stageShas(entries))) throw staleStages(input.path)
    await writeJsonRef(ctx, mergeDraftRef(input.path), input.draft)
    return { path: input.path }
  },
}

export type MergeApplyInput = Pick<MergeApplyRequest, 'path' | 'result' | 'stages' | 'expectedWorktreeSha'>

export const mergeApplyOperation: WriteOperation<MergeApplyInput, Omit<ResolveConflictValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const expected = record.expectedWorktreeSha
    if (expected !== null && (typeof expected !== 'string' || !SHA_PATTERN.test(expected))) {
      throw invalidPayload('expectedWorktreeSha must be an object id or null')
    }
    return {
      path: validateRepoPath(record.path),
      result: parseResult(record.result),
      stages: parseStages(record.stages),
      expectedWorktreeSha: expected,
    }
  },

  async run(ctx, input) {
    const { path } = input
    const { entries } = await conflictStageEntries(ctx, path)
    if (!sameStages(input.stages, stageShas(entries))) throw staleStages(path)
    if ((await hashWorktree(ctx, path)) !== input.expectedWorktreeSha) {
      throw new GitCommandFailure('git/stale-target', `"${path}" changed in the working tree after it was loaded`, {
        target: 'conflict',
        expected: path,
        reason: 'worktree-changed',
      })
    }
    // Conflicts with a text result have both sides; the mode follows ours (the checked-out side).
    const mode = entries.get(2)?.mode ?? entries.get(3)?.mode ?? '100644'
    if (mode !== '100644' && mode !== '100755') {
      throw new GitCommandFailure('git/exec-failed', `"${path}" is not a regular file; resolve it in a terminal`)
    }

    const sha = (await write(ctx, ['hash-object', '-w', '--stdin', `--path=${path}`], 'git hash-object', input.result)).trim()
    if (!SHA_PATTERN.test(sha)) throw new GitCommandFailure('git/exec-failed', 'git hash-object returned no object id')
    await write(ctx, ['update-index', '--cacheinfo', `${mode},${sha},${path}`], 'git update-index')
    await write(ctx, ['checkout-index', '-f', '--', path], 'git checkout-index')
    await deleteRefs(ctx, mergeDraftRef(path)).catch(() => undefined)
    return { path, remaining: (await unmergedEntries(ctx)).size }
  },
}

export interface UnresolveConflictInput {
  path: string
}

export const unresolveConflictOperation: WriteOperation<UnresolveConflictInput, Omit<UnresolveConflictValue, 'version'>> = {
  parse(payload) {
    return { path: validateRepoPath(payloadRecord(payload).path) }
  },

  async run(ctx, input) {
    const { path } = input
    const staleTarget = new GitCommandFailure('git/stale-target', `"${path}" is not a resolved conflict of this operation`, {
      target: 'conflict',
      expected: path,
    })
    if ((await unmergedEntries(ctx)).has(path)) throw staleTarget
    const undo = await resolveUndoEntries(ctx, path)
    if (undo === undefined) throw staleTarget
    if (!undo.has(2) || !undo.has(3)) {
      // Delete-kind conflicts: `checkout -m` cannot rebuild them (git-behavior.md §1).
      throw new GitCommandFailure(
        'git/exec-failed',
        `"${path}" was a delete-type conflict, which cannot be reopened here; restore it in a terminal`,
        { reason: 'delete-kind' },
      )
    }
    await write(ctx, ['checkout', '-m', '--', path], 'git checkout -m')
    return { path, remaining: (await unmergedEntries(ctx)).size }
  },
}

/**
 * Remove merge drafts: all of them, or all except those of `keepPaths` (paths still in conflict).
 * Best effort; never throws, so a finished operation is never reported as failed over a stale draft.
 */
export async function cleanupMergeDrafts(ctx: WriteContext, keepPaths?: Iterable<string>): Promise<void> {
  try {
    const keep = new Set<string>()
    for (const path of keepPaths ?? []) keep.add(mergeDraftRef(path))
    await deleteRefs(ctx, MERGE_DRAFT_REF_PREFIX, keep)
  } catch {
    // Orphaned drafts are harmless: their stages never match a later conflict.
  }
}

/** Cleanup after an operation step: all drafts when it ended, else those of paths no longer unmerged. */
export async function cleanupDraftsAfterStep(ctx: WriteContext, operationEnded: boolean): Promise<void> {
  if (operationEnded) return await cleanupMergeDrafts(ctx)
  try {
    await cleanupMergeDrafts(ctx, (await unmergedEntries(ctx)).keys())
  } catch {
    // See cleanupMergeDrafts.
  }
}
