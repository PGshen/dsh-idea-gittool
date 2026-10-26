// Push Rejected 所需的拉取（A2 T3）。完整 Pull/Update Project 在 A3。
// 骨架由 Lead 在 T1 建立，实现由 host-write 在 T3 完成。

import type { PullForPushValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { notImplemented } from '../git-executor.ts'

export const pullForPushOperation: WriteOperation<unknown, Omit<PullForPushValue, 'version'>> = {
  parse: (payload) => payload,
  run: async () => {
    throw notImplemented('pullForPush')
  },
}
