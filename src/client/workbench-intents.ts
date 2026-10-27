// Per-session intents for the Git tab (plan B2 T4): the document header and the `git.blame` page ask
// the Git tab to open an overlay or reveal a commit. Same bundle, so a module-level queue suffices;
// intents posted while no Git tab listens wait and are delivered once to the first subscriber.
// Not routed through `openTab` params, which a restored tab could replay (references §15).
import type { StatusValue } from '../shared/protocol.ts'

export type WorkbenchIntent =
  | { kind: 'fileHistory'; path: string }
  | { kind: 'worktreeDiff'; path: string }
  /** Switch to the Commit page and select this change. */
  | { kind: 'selectChange'; path: string }
  /** Reveal one commit in the log. */
  | { kind: 'showCommit'; sha: string }

type Listener = (intent: WorkbenchIntent) => void

interface Channel {
  queue: WorkbenchIntent[]
  listeners: Set<Listener>
}

const channels = new Map<string, Channel>()

function channelOf(sessionId: string): Channel {
  let channel = channels.get(sessionId)
  if (channel === undefined) {
    channel = { queue: [], listeners: new Set() }
    channels.set(sessionId, channel)
  }
  return channel
}

/** Deliver to the session's Git tab now, or queue until one subscribes. */
export function postIntent(sessionId: string, intent: WorkbenchIntent): void {
  const channel = channelOf(sessionId)
  if (channel.listeners.size === 0) {
    channel.queue.push(intent)
    return
  }
  for (const listener of channel.listeners) listener(intent)
}

/** Receive queued intents first (then the queue is empty), then live ones. */
export function subscribeIntents(sessionId: string, listener: Listener): () => void {
  const channel = channelOf(sessionId)
  channel.listeners.add(listener)
  const queued = channel.queue.splice(0)
  for (const intent of queued) listener(intent)
  return () => { channel.listeners.delete(listener) }
}

/** Test seam: forget every channel. */
export function resetIntentsForTest(): void {
  channels.clear()
}

/** What the Git tab does for one intent (React-free so the mapping is testable). */
export type IntentEffect =
  | { kind: 'overlay'; overlay: { kind: 'fileHistory'; path: string } }
  | { kind: 'diff'; path: string; scope: 'worktree' | 'staged' }
  | { kind: 'selectChange'; path: string }
  | { kind: 'showCommit'; sha: string }

export function intentEffect(intent: WorkbenchIntent, status: StatusValue | null): IntentEffect {
  switch (intent.kind) {
    case 'fileHistory': return { kind: 'overlay', overlay: { kind: 'fileHistory', path: intent.path } }
    case 'selectChange': return { kind: 'selectChange', path: intent.path }
    case 'showCommit': return { kind: 'showCommit', sha: intent.sha }
    case 'worktreeDiff': {
      // A file with only staged changes has an empty worktree diff; show what it does have.
      const onlyStaged = status !== null
        && status.staged.some(entry => entry.path === intent.path)
        && !status.unstaged.some(entry => entry.path === intent.path)
      return { kind: 'diff', path: intent.path, scope: onlyStaged ? 'staged' : 'worktree' }
    }
  }
}
