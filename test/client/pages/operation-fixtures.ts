// A3 T9 shared OperationStateValue samples (merge / rebase / cherry-pick / revert). Data only.
import type { FileEntry, OperationStateValue } from '../../../src/shared/protocol.ts'

export const HEAD_SHA = '1'.repeat(40)
export const MERGE_HEAD_SHA = '2'.repeat(40)
export const ONTO_SHA = '3'.repeat(40)
export const PICK_SHA = '4abcdef'.padEnd(40, '4')

export function conflictEntry(path: string, conflict: FileEntry['conflict'] = 'both-modified'): FileEntry {
  return conflict === undefined ? { path, status: 'U' } : { path, status: 'U', conflict }
}

export function mergeState(overrides: Partial<OperationStateValue> = {}): OperationStateValue {
  return {
    operation: 'merge',
    ours: { label: 'main', ref: 'refs/heads/main', sha: HEAD_SHA },
    theirs: { label: 'feature', ref: 'refs/heads/feature', sha: MERGE_HEAD_SHA },
    message: "Merge branch 'feature' into main",
    conflicts: [conflictEntry('src/a.ts'), conflictEntry('src/b.ts')],
    resolved: ['src/c.ts'],
    pendingStash: false,
    ...overrides,
  }
}

export function rebaseState(overrides: Partial<OperationStateValue> = {}): OperationStateValue {
  return {
    operation: 'rebase',
    ours: { label: 'main', ref: 'refs/heads/main', sha: ONTO_SHA },
    theirs: { label: 'feat/x', ref: 'refs/heads/feat/x' },
    step: { current: 2, total: 5 },
    conflicts: [conflictEntry('src/a.ts')],
    resolved: [],
    pendingStash: false,
    ...overrides,
  }
}

export function pickState(operation: 'cherry-pick' | 'revert', overrides: Partial<OperationStateValue> = {}): OperationStateValue {
  return {
    operation,
    ours: { label: 'main', ref: 'refs/heads/main', sha: HEAD_SHA },
    theirs: { label: PICK_SHA.slice(0, 7), sha: PICK_SHA },
    conflicts: [conflictEntry('src/a.ts')],
    resolved: [],
    pendingStash: false,
    ...overrides,
  }
}

export function idleState(): OperationStateValue {
  return { operation: null, ours: { label: 'main' }, theirs: { label: '' }, conflicts: [], resolved: [], pendingStash: false }
}
