// 逐文件解决冲突（A3 T3，设计 §10）：冲突列表覆盖页的「采用 <分支>」「删除」「标记已解决」。
// - 路径必须在执行时的冲突列表里（`ls-files -u`；status 是几秒前的快照），否则 `git/stale-target`（target 'conflict'）；
// - ours/theirs 按索引的 stage 决定：该侧有版本（stage 2/3）→ `checkout --ours|--theirs -- <path>` +
//   `add -- <path>`；该侧已删除 → `rm -- <path>`。stage 2 在合并/拣选/回滚中是当前分支，变基中是
//   目标分支（onto），与 operationState 的 ours/theirs 标签一致；
// - mark-resolved 前用 `git grep` 找残留的 `<<<<<<<`/`>>>>>>>` 标记（经 git 读，不跟随符号链接），
//   有标记且未带 force → `git/conflict` + `markers: true`；
// - 「在终端解决」的命令：`cd <repo> && git status && git mergetool`。

import type { ConflictCommandValue, ConflictResolution, ResolveConflictValue } from '../../shared/protocol.ts'
import type { WriteContext, WriteOperation } from '../git-executor.ts'
import { GIT_BASE_ARGV, GitCommandFailure } from '../git-executor.ts'
import { validateRepoPath } from './diff.ts'
import {
  invalidPayload,
  optionalBoolean,
  payloadRecord,
  query,
  queryOk,
  redactedFailure,
  terminalCommand,
} from './write-support.ts'

const RESOLUTIONS: readonly ConflictResolution[] = ['ours', 'theirs', 'delete', 'mark-resolved']

/** Default-size conflict markers at the start of a line (`conflict-marker-size` is not honored). */
const MARKER_PATTERN = '^(<{7}|>{7})( |$)'

export interface ResolveConflictInput {
  path: string
  resolution: ConflictResolution
  force: boolean
}

/**
 * Unmerged paths right now with the index stages each has (1 base, 2 ours, 3 theirs).
 * Read straight from the index (`ls-files -u`), so the status entry limit never hides one.
 */
async function unmergedStages(ctx: WriteContext): Promise<Map<string, Set<number>>> {
  const stdout = await queryOk(ctx, ['ls-files', '-u', '-z'], 'git ls-files')
  const unmerged = new Map<string, Set<number>>()
  for (const record of stdout.split('\0')) {
    // `<mode> SP <object> SP <stage> TAB <path>`
    const match = /^\d+ [0-9a-f]+ ([123])\t(.+)$/s.exec(record)
    if (match?.[1] === undefined || match[2] === undefined) continue
    const stages = unmerged.get(match[2]) ?? new Set<number>()
    stages.add(Number(match[1]))
    unmerged.set(match[2], stages)
  }
  return unmerged
}

async function hasMarkers(ctx: WriteContext, path: string): Promise<boolean> {
  const result = await query(ctx, ['grep', '-q', '-E', '-e', MARKER_PATTERN, '--', path])
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw redactedFailure(result, 'git grep')
}

async function write(ctx: WriteContext, args: readonly string[], label: string): Promise<void> {
  const result = await ctx.git([...GIT_BASE_ARGV, ...args])
  if (result.exitCode !== 0) throw redactedFailure(result, label)
}

async function removePath(ctx: WriteContext, path: string): Promise<void> {
  await write(ctx, ['rm', '-q', '--', path], 'git rm')
}

export const resolveConflictOperation: WriteOperation<ResolveConflictInput, Omit<ResolveConflictValue, 'version'>> = {
  parse(payload) {
    const record = payloadRecord(payload)
    const resolution = record.resolution
    if (!RESOLUTIONS.includes(resolution as ConflictResolution)) {
      throw invalidPayload('resolution must be ours, theirs, delete or mark-resolved')
    }
    return {
      path: validateRepoPath(record.path),
      resolution: resolution as ConflictResolution,
      force: optionalBoolean(record, 'force'),
    }
  },

  async run(ctx, input) {
    const { path } = input
    const stages = (await unmergedStages(ctx)).get(path)
    if (stages === undefined) {
      throw new GitCommandFailure('git/stale-target', `"${path}" is not an unresolved conflict`, {
        target: 'conflict',
        expected: path,
      })
    }

    switch (input.resolution) {
      case 'ours':
      case 'theirs': {
        const stage = input.resolution === 'ours' ? 2 : 3
        if (!stages.has(stage)) {
          // That side deleted the file: taking it means deleting.
          await removePath(ctx, path)
          break
        }
        await write(ctx, ['checkout', `--${input.resolution}`, '--', path], 'git checkout')
        await write(ctx, ['add', '--', path], 'git add')
        break
      }
      case 'delete':
        await removePath(ctx, path)
        break
      case 'mark-resolved':
        if (!input.force && (await hasMarkers(ctx, path))) {
          throw new GitCommandFailure('git/conflict', `"${path}" still contains conflict markers`, {
            markers: true,
          })
        }
        await write(ctx, ['add', '--', path], 'git add')
        break
    }
    return { path, remaining: (await unmergedStages(ctx)).size }
  },
}

/** `conflictCommand`: the copy-pasteable "resolve in a terminal" command. */
export function conflictCommandFor(repoRoot: string): ConflictCommandValue {
  return { command: `${terminalCommand(repoRoot, ['status'])} && git mergetool` }
}
