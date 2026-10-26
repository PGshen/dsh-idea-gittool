// 推送与推送预览（A2 T3，设计 §11）。骨架由 Lead 在 T1 建立，实现由 host-write 在 T3 完成。

import type { PushPreviewValue, PushValue } from '../../shared/protocol.ts'
import type { GitRunner, WriteOperation } from '../git-executor.ts'
import { notImplemented } from '../git-executor.ts'

/** Push 页数据（读命令，不经写队列）。 */
export async function readPushPreview(
  _run: GitRunner,
  _repoRoot: string,
  _options: { signal?: AbortSignal | undefined } = {},
): Promise<Omit<PushPreviewValue, 'version'>> {
  throw notImplemented('pushPreview')
}

export const pushOperation: WriteOperation<unknown, Omit<PushValue, 'version'>> = {
  parse: (payload) => payload,
  run: async () => {
    throw notImplemented('push')
  },
}
