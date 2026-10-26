// 提交写操作（A2 T2）：只提交勾选文件、仅改信息 Amend、加入 VCS。
// 骨架由 Lead 在 T1 建立，实现由 host-write 在 T2 完成。

import type { AddToVcsValue, CommitResultValue } from '../../shared/protocol.ts'
import type { WriteOperation } from '../git-executor.ts'
import { notImplemented } from '../git-executor.ts'

export const commitFilesOperation: WriteOperation<unknown, Omit<CommitResultValue, 'version'>> = {
  parse: (payload) => payload,
  run: async () => {
    throw notImplemented('commitFiles')
  },
}

export const amendMessageOperation: WriteOperation<unknown, Omit<CommitResultValue, 'version'>> = {
  parse: (payload) => payload,
  run: async () => {
    throw notImplemented('amendMessage')
  },
}

export const addToVcsOperation: WriteOperation<unknown, Omit<AddToVcsValue, 'version'>> = {
  parse: (payload) => payload,
  run: async () => {
    throw notImplemented('addToVcs')
  },
}
