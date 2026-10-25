// shell-ui（T7/T8）测试共用的协议样例：BranchesValue / StatusValue。
// 只放数据，不含断言，避免测试文件之间互相 import。
import type { BranchesValue, StatusValue } from '../../../src/shared/protocol.ts'

const SHA = {
  main: 'aaa1111222233334444555566667777888899990',
  login: 'bbb1111222233334444555566667777888899991',
  ui: 'ccc1111222233334444555566667777888899992',
  chore: 'ddd1111222233334444555566667777888899993',
  tag: 'eee1111222233334444555566667777888899994',
  oldTag: 'fff1111222233334444555566667777888899995',
  detached: 'deadbee11112222333344445555666677778888',
} as const

/** 常规仓库：当前分支 main 带 upstream；local 有 feat/ 目录；remote 有 origin。 */
export function branchesFixture(): BranchesValue {
  return {
    head: { branch: 'main', detached: false, sha: SHA.main },
    local: [
      {
        ref: 'refs/heads/main',
        name: 'main',
        kind: 'local',
        sha: SHA.main,
        head: true,
        current: true,
        upstream: 'origin/main',
        ahead: 1,
        behind: 2,
      },
      {
        ref: 'refs/heads/feat/login',
        name: 'feat/login',
        kind: 'local',
        sha: SHA.login,
        head: false,
        current: false,
        ahead: 0,
        behind: 0,
      },
      {
        ref: 'refs/heads/feat/ui',
        name: 'feat/ui',
        kind: 'local',
        sha: SHA.ui,
        head: false,
        current: false,
        upstream: 'origin/feat/ui',
        ahead: 3,
        behind: 0,
      },
      {
        ref: 'refs/heads/chore',
        name: 'chore',
        kind: 'local',
        sha: SHA.chore,
        head: false,
        current: false,
        ahead: 0,
        behind: 0,
      },
    ],
    remote: [
      {
        ref: 'refs/remotes/origin/main',
        name: 'origin/main',
        kind: 'remote',
        sha: SHA.main,
        head: false,
        current: false,
        ahead: 0,
        behind: 0,
      },
      {
        ref: 'refs/remotes/origin/feat/login',
        name: 'origin/feat/login',
        kind: 'remote',
        sha: SHA.login,
        head: false,
        current: false,
        ahead: 0,
        behind: 0,
      },
    ],
    tags: [
      {
        ref: 'refs/tags/v1.0.0',
        name: 'v1.0.0',
        kind: 'tag',
        sha: SHA.tag,
        head: false,
        current: false,
        ahead: 0,
        behind: 0,
      },
      {
        ref: 'refs/tags/v0.9.0',
        name: 'v0.9.0',
        kind: 'tag',
        sha: SHA.oldTag,
        head: false,
        current: false,
        ahead: 0,
        behind: 0,
      },
    ],
    truncated: false,
    version: 7,
  }
}

/** detached HEAD：没有当前分支，HEAD 组要显示 detached 说明。 */
export function detachedBranchesFixture(): BranchesValue {
  return {
    head: { branch: null, detached: true, sha: SHA.detached },
    local: [
      {
        ref: 'refs/heads/main',
        name: 'main',
        kind: 'local',
        sha: SHA.main,
        head: false,
        current: false,
        ahead: 0,
        behind: 0,
      },
    ],
    remote: [],
    tags: [],
    truncated: false,
    version: 3,
  }
}

/** 常规 status：main 上 1 ahead / 2 behind，工作区 3 个改动（无冲突）。 */
export function statusFixture(overrides: Partial<StatusValue> = {}): StatusValue {
  return {
    branch: 'main',
    detached: false,
    head: SHA.main,
    upstream: 'origin/main',
    ahead: 1,
    behind: 2,
    staged: [],
    unstaged: [
      { path: 'src/a.ts', status: 'M' },
      { path: 'src/b.ts', status: 'M' },
    ],
    untracked: [{ path: 'notes.md', status: '?' }],
    conflicts: [],
    operation: null,
    truncated: false,
    version: 5,
    ...overrides,
  }
}

export { SHA as BRANCH_SHAS }
