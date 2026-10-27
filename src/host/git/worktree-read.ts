// Read-only worktree file access shared by mergeFile (B1 ruling 16) and blame (B2): a regular file
// (not a symlink) whose real path stays inside the repository; a symlinked parent directory could
// otherwise lead outside it. Never writes.
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

export type WorktreeFile =
  | { kind: 'missing' }
  /** Exists but is not a regular file inside the repository (symlink, directory, escapes the root). */
  | { kind: 'not-file' }
  | { kind: 'too-large'; size: number }
  | { kind: 'file'; bytes: Buffer }

/** One worktree file, at most `maxBytes` long. */
export async function readWorktreeFile(repoRoot: string, path: string, maxBytes: number): Promise<WorktreeFile> {
  const file = join(repoRoot, path)
  let info
  try {
    info = await lstat(file)
  } catch {
    return { kind: 'missing' }
  }
  if (!info.isFile()) return { kind: 'not-file' }
  if (info.size > maxBytes) return { kind: 'too-large', size: info.size }
  try {
    const inside = relative(await realpath(repoRoot), await realpath(file))
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return { kind: 'not-file' }
    const bytes = await readFile(file)
    return bytes.length > maxBytes ? { kind: 'too-large', size: bytes.length } : { kind: 'file', bytes }
  } catch {
    return { kind: 'missing' }
  }
}
