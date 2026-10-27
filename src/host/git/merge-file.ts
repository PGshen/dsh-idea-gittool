// 三栏合并窗口读三方（B1 T2，设计 §10.1）：
// - 路径必须是当前未解决冲突（`ls-files -u`），或本次操作中已解决（`ls-files --resolve-undo`，
//   仅在有操作进行时可信：操作结束后的残留不算，references/git-behavior.md §1）；否则 `git/stale-target`；
// - 三方内容只读索引 blob（决策 D2，不读工作区里的标记）：`cat-file blob`；blob 内容是 clean filter 之后的 LF 文本；
// - 单侧超过 2 MiB 或 20 000 行 → `text: null` + `tooLarge`；含 NUL 或不是合法 UTF-8（解码出替换字符）→ 二进制，
//   窗口降级为二选一，避免写回时破坏编码；
// - `worktreeSha` 与写回同一条 clean filter（`hash-object --path`），供 `mergeApply` 检测加载后工作区被改；
// - 草稿存在 `refs/worktree/dsh-git/merge-draft/<sha1(path)>`（ADR 0008），`version`/`stages`/形状不符或 JSON 损坏即作废；
// - 已解决路径另给 `worktreeText`（裁定 16）：只读、lstat 确认是普通文件、realpath 仍在仓库内，限额与文本规则同三方；
// - 未解决的文本冲突另给 `worktreeHasMarkers`（裁定 19）：工作区文件是否仍含冲突标记（与 mark-resolved 同一 `git grep`）；
//   为 false 说明加载前已被改过（手改、Agent、rerere），窗口提示「应用会覆盖」，「全部简单冲突」跳过；
// - 符号链接（120000）与子模块（160000）冲突给 `special`，不读三方内容（子模块的 commit 不在本仓库），窗口降级。

import { createHash } from 'node:crypto'

import type { ConflictKind, MergeDraft, MergeFileSpecial, MergeFileValue, MergeSide, MergeStageShas } from '../../shared/protocol.ts'
import { MERGE_DRAFT_VERSION, validDraftChunkRange } from '../../shared/protocol.ts'
import type { WriteContext } from '../git-executor.ts'
import { GitCommandFailure } from '../git-executor.ts'
import type { StageEntries } from './conflict.ts'
import { hasMarkers, parseStageRecords, unmergedEntries } from './conflict.ts'
import { detectOperation } from './status.ts'
import { readWorktreeFile } from './worktree-read.ts'
import { JsonRefInvalid, query, queryOk, readJsonRef, readRunner, redactedFailure } from './write-support.ts'

/** Per-side limits above which the window falls back to choose-one. */
export const MERGE_SIDE_MAX_BYTES = 2 * 1024 * 1024
export const MERGE_SIDE_MAX_LINES = 20_000

export const MERGE_DRAFT_REF_PREFIX = 'refs/worktree/dsh-git/merge-draft/'

/** Draft ref of a repo-relative path. */
export function mergeDraftRef(path: string): string {
  return `${MERGE_DRAFT_REF_PREFIX}${createHash('sha1').update(path, 'utf8').digest('hex')}`
}

/** Conflict kind from which stages exist (1 base, 2 ours, 3 theirs). */
export function kindFromStages(stages: ReadonlySet<number>): ConflictKind {
  const base = stages.has(1)
  const ours = stages.has(2)
  const theirs = stages.has(3)
  if (ours && theirs) return base ? 'both-modified' : 'both-added'
  if (ours) return base ? 'deleted-by-them' : 'added-by-us'
  if (theirs) return base ? 'deleted-by-us' : 'added-by-them'
  return 'both-deleted'
}

/** Symlink / submodule entries cannot be merged as text (any stage with that mode). */
export function specialOf(entries: StageEntries): MergeFileSpecial {
  const modes = [...entries.values()].map(entry => entry.mode)
  if (modes.includes('160000')) return 'submodule'
  if (modes.includes('120000')) return 'symlink'
  return null
}

export function staleConflict(path: string): GitCommandFailure {
  return new GitCommandFailure('git/stale-target', `"${path}" is not a conflict that can be opened in the merge window`, {
    target: 'conflict',
    expected: path,
  })
}

function countLines(text: string): number {
  if (text === '') return 0
  let lines = 1
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lines += 1
  // A trailing newline does not start another line.
  return text.endsWith('\n') ? lines - 1 : lines
}

async function readSide(
  ctx: WriteContext,
  sha: string,
): Promise<{ side: MergeSide; tooLarge: boolean }> {
  const size = Number((await queryOk(ctx, ['cat-file', '-s', sha], 'git cat-file -s')).trim())
  if (size > MERGE_SIDE_MAX_BYTES) return { side: { blob: sha, text: null, binary: false, size }, tooLarge: true }
  const result = await query(ctx, ['cat-file', 'blob', sha])
  if (result.exitCode !== 0) throw redactedFailure(result, 'git cat-file')
  const text = result.stdout
  // NUL: binary by git's own rule; U+FFFD: not valid UTF-8, writing it back would corrupt the file.
  if (text.includes('\0') || text.includes('�')) return { side: { blob: sha, text: null, binary: true, size }, tooLarge: false }
  if (countLines(text) > MERGE_SIDE_MAX_LINES) return { side: { blob: sha, text: null, binary: false, size }, tooLarge: true }
  return { side: { blob: sha, text, binary: false, size }, tooLarge: false }
}

/** Text by the side rules (NUL / invalid UTF-8 → not text; over the line limit → null). */
function textOf(text: string): string | null {
  if (text.includes('\0') || text.includes('\uFFFD')) return null
  return countLines(text) > MERGE_SIDE_MAX_LINES ? null : text
}

/**
 * Worktree content of a resolved path (ruling 16): a regular file (not a symlink) whose real path is
 * inside the repository, within the side limits and valid UTF-8 text; anything else is null.
 */
export async function readWorktreeText(repoRoot: string, path: string): Promise<string | null> {
  const file = await readWorktreeFile(repoRoot, path, MERGE_SIDE_MAX_BYTES)
  return file.kind === 'file' ? textOf(file.bytes.toString('utf8')) : null
}

/** Blob of `path` in the worktree through the clean filter; null when the file is missing. */
export async function hashWorktree(ctx: WriteContext, path: string): Promise<string | null> {
  const result = await query(ctx, ['hash-object', `--path=${path}`, '--', path])
  if (result.exitCode === 0) return result.stdout.trim()
  if (/could not open|no such file|cannot open|does not exist|not a regular file/i.test(result.stderr)) return null
  throw redactedFailure(result, 'git hash-object')
}

export function stageShas(entries: StageEntries): MergeStageShas {
  return { base: entries.get(1)?.sha ?? null, ours: entries.get(2)?.sha ?? null, theirs: entries.get(3)?.sha ?? null }
}

export function sameStages(a: MergeStageShas, b: MergeStageShas): boolean {
  return a.base === b.base && a.ours === b.ours && a.theirs === b.theirs
}

function nullableSha(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** A well-formed draft for exactly these stages, or null. */
function validDraft(raw: unknown, current: MergeStageShas): MergeDraft | null {
  if (typeof raw !== 'object' || raw === null) return null
  const draft = raw as Partial<MergeDraft>
  if (draft.version !== MERGE_DRAFT_VERSION) return null
  const stages = draft.stages
  if (typeof stages !== 'object' || stages === null) return null
  if (!nullableSha(stages.base) || !nullableSha(stages.ours) || !nullableSha(stages.theirs)) return null
  if (!sameStages(stages, current)) return null
  if (typeof draft.result !== 'string' || !Array.isArray(draft.chunks) || typeof draft.savedAt !== 'string') return null
  const chunks: unknown[] = draft.chunks
  if (!chunks.every((c) => typeof c === 'object' && c !== null && validDraftChunkRange(c))) return null
  return draft as MergeDraft
}

/**
 * Index entries of a path the merge window may work on: an unresolved conflict (`ls-files -u`), or a
 * path resolved in the current operation whose resolve-undo records both stage 2 and stage 3.
 * Anything else is `git/stale-target` (target `conflict`).
 */
export async function conflictStageEntries(
  ctx: WriteContext,
  path: string,
): Promise<{ entries: StageEntries; resolved: boolean }> {
  const unmerged = (await unmergedEntries(ctx)).get(path)
  if (unmerged !== undefined) return { entries: unmerged, resolved: false }
  const undo = await resolveUndoEntries(ctx, path)
  // Only text-style resolutions (stages 2 and 3 both recorded) can be restored and re-applied;
  // resolved delete-kind conflicts cannot (git-behavior.md §1), so they do not open.
  if (undo?.has(2) === true && undo.has(3)) return { entries: undo, resolved: true }
  throw staleConflict(path)
}

/** Resolve-undo records of a path; only trusted while an operation is in progress (else undefined). */
export async function resolveUndoEntries(ctx: WriteContext, path: string): Promise<StageEntries | undefined> {
  const operation = await detectOperation(readRunner(ctx), ctx.repoRoot, ctx.signal)
  if (operation === null || operation === 'bisect') return undefined
  const undo = await queryOk(ctx, ['ls-files', '--resolve-undo', '-z'], 'git ls-files --resolve-undo')
  return parseStageRecords(undo).get(path)
}

/** `mergeFile`: the three sides, the worktree hash and the saved draft of one conflict. */
export async function readMergeFile(ctx: WriteContext, path: string): Promise<Omit<MergeFileValue, 'version'>> {
  const { entries, resolved } = await conflictStageEntries(ctx, path)

  const stages = stageShas(entries)
  const special = specialOf(entries)
  const sides: Record<'base' | 'ours' | 'theirs', MergeSide | null> = { base: null, ours: null, theirs: null }
  let tooLarge = false
  for (const key of ['base', 'ours', 'theirs'] as const) {
    const sha = stages[key]
    if (sha === null) continue
    if (special !== null) {
      // A gitlink names a commit of another repository; a symlink's target is not merged as text.
      sides[key] = { blob: sha, text: null, binary: false, size: 0 }
      continue
    }
    const read = await readSide(ctx, sha)
    sides[key] = read.side
    tooLarge ||= read.tooLarge
  }
  const textConflict = !resolved && special === null && !tooLarge && sides.ours?.text != null && sides.theirs?.text != null

  let draft: MergeDraft | null = null
  let draftStale = false
  try {
    const raw = await readJsonRef(ctx, mergeDraftRef(path))
    if (raw !== null) {
      draft = validDraft(raw, stages)
      draftStale = draft === null
    }
  } catch (error) {
    if (!(error instanceof JsonRefInvalid)) throw error
    draftStale = true
  }

  return {
    path,
    kind: kindFromStages(new Set(entries.keys())),
    ...sides,
    tooLarge,
    // Special entries are never written back by mergeApply (regular files only); a submodule directory cannot be hashed.
    worktreeSha: special === null ? await hashWorktree(ctx, path) : null,
    draft,
    draftStale,
    resolved,
    special,
    ...(textConflict ? { worktreeHasMarkers: await hasMarkers(ctx, path) } : {}),
    ...(resolved ? { worktreeText: await readWorktreeText(ctx.repoRoot, path) } : {}),
  }
}
