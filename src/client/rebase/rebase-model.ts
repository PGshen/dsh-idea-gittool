// Interactive rebase list model (plan b3a T4): pure functions over the rows of the rebase page.
// React-free and RPC-free; the store and the page drive it.

/**
 * What a log quick action asks the rebase model to start from (plan b3a T4/T6): the same rows and
 * entries as the full page, with one commit reworded/dropped or a run of commits squashed.
 */
export type RebasePreset =
  | { kind: 'reword'; sha: string }
  | { kind: 'drop'; sha: string }
  | { kind: 'squash'; shas: string[] }
