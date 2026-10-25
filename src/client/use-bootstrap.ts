// 读取 bootstrap 快照的 React hooks：Git tab 与文档预览头部动作共用。
import { useCallback, useSyncExternalStore } from 'react'
import type { BootstrapValue } from '../shared/protocol.ts'
import type { BootstrapCache } from './bootstrap-cache.ts'
import { statusLetterOf, toRepoRelativePath } from './document-actions.tsx'
import type { FileStatusLetter } from './document-actions.tsx'

/** 订阅某会话的 bootstrap 快照；首次订阅会触发一次拉取。 */
export function useBootstrap(cache: BootstrapCache, sessionId: string): BootstrapValue | null {
  const subscribe = useCallback((onChange: () => void) => {
    cache.ensure(sessionId)
    return cache.subscribe(sessionId, onChange)
  }, [cache, sessionId])
  const snapshot = useCallback(() => cache.get(sessionId), [cache, sessionId])
  return useSyncExternalStore(subscribe, snapshot)
}

/** 一个文件在 git status 里的显示字母；没有数据或不在仓库内时为 null。 */
export function useStatusLetter(
  cache: BootstrapCache,
  sessionId: string,
  absolutePath: string,
): FileStatusLetter | null {
  const value = useBootstrap(cache, sessionId)
  if (value === null || value.status === null) return null
  const relative = toRepoRelativePath(absolutePath, value.repoRoot)
  if (relative === null) return null
  const entries = [
    ...value.status.conflicts,
    ...value.status.staged,
    ...value.status.unstaged,
    ...value.status.untracked,
  ]
  const entry = entries.find(candidate => candidate.path === relative)
  return entry === undefined ? null : statusLetterOf(entry.status)
}
