// 回滚写操作（A2 T2，设计 §8.2.5）。骨架由 Lead 在 T1 建立，实现由 host-write 在 T2 完成。

import type { RollbackValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { notImplemented } from '../git-executor.ts'

export const rollbackOperation: WriteOperation<unknown, Omit<RollbackValue, 'version'>> = {
  parse: (payload) => payload,
  run: async () => {
    throw notImplemented('rollback')
  },
}
