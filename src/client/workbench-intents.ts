// Per-session intents for the Git tab (plan B2 T4): the document header and the `git.blame` page ask
// the Git tab to open an overlay or reveal a commit. Same bundle, so a module-level queue suffices;
// intents posted while no Git tab listens wait and are delivered once to the first subscriber.
// Not routed through `openTab` params, which a restored tab could replay (references §15).

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
