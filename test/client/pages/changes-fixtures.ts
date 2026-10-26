// Shared StatusValue fixtures for the commit page (changes tree, badge, title dot, commit store).
import type { FileEntry, StatusValue } from '../../../src/shared/protocol.ts'

export function statusFixture(overrides: Partial<StatusValue> = {}): StatusValue {
  return {
    branch: 'main',
    detached: false,
    head: 'a'.repeat(40),
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
    operation: null,
    truncated: false,
    version: 1,
    ...overrides,
  }
}

export function entry(path: string, status: FileEntry['status'], extra: Partial<FileEntry> = {}): FileEntry {
  return { path, status, ...extra }
}

/** A mixed working tree: every group present, one path both staged and unstaged. */
export function mixedStatus(overrides: Partial<StatusValue> = {}): StatusValue {
  return statusFixture({
    conflicts: [entry('src/merge.ts', 'U')],
    staged: [
      entry('src/client/new.ts', 'A', { additions: 10, deletions: 0 }),
      entry('src/both.ts', 'M', { additions: 1, deletions: 1 }),
      entry('docs/renamed.md', 'R', { origPath: 'docs/old.md' }),
    ],
    unstaged: [
      entry('src/both.ts', 'M', { additions: 2, deletions: 0 }),
      entry('src/client/log/LogTable.tsx', 'M', { additions: 128, deletions: 32 }),
      entry('README.md', 'M', { additions: 3, deletions: 1 }),
      entry('src/gone.ts', 'D', { additions: 0, deletions: 7 }),
    ],
    untracked: [entry('scratch.md', '?')],
    ...overrides,
  })
}
