// B4c T3: CodeMirror (≈85 KB gzip) is not in lib/client.js. build.mjs emits merge-editor.ts as the
// package-local chunk lib/client.merge.js, which DSH's client-modules serves next to client.js and
// loads through the factory's `require.async` (references §「按需 chunk」). Tests and type checks
// run on source, where the define is absent and a plain dynamic import is used instead.
import type * as MergeEditorModule from './merge-editor.ts'

export type MergeEditor = typeof MergeEditorModule

/** Replaced with `true` by build.mjs for lib/client.js; undeclared (typeof → 'undefined') elsewhere. */
declare const __DSH_GIT_MERGE_CHUNK__: boolean | undefined

/** The factory's module-table require; `async` loads a package-local chunk. */
declare const require: { async: (specifier: string) => Promise<unknown> }

function defaultImporter(): Promise<MergeEditor> {
  if (typeof __DSH_GIT_MERGE_CHUNK__ !== 'undefined' && __DSH_GIT_MERGE_CHUNK__) {
    return require.async('./client.merge.js') as Promise<MergeEditor>
  }
  return import('./merge-editor.ts')
}

let importer: () => Promise<MergeEditor> = defaultImporter
let loaded: MergeEditor | undefined
let pending: Promise<MergeEditor> | undefined

/** The editor module once it has loaded; lets a re-mounted window create its panes synchronously. */
export function loadedMergeEditor(): MergeEditor | undefined {
  return loaded
}

/** Load the editor module; concurrent callers share one import, a failed import is retried next time. */
export function loadMergeEditor(): Promise<MergeEditor> {
  if (loaded !== undefined) return Promise.resolve(loaded)
  if (pending === undefined) {
    const attempt = importer().then((module) => {
      loaded = module
      return module
    })
    pending = attempt
    attempt.catch(() => undefined).finally(() => {
      if (pending === attempt) pending = undefined
    })
  }
  return pending
}

/** Test seam: replace the importer (null restores the default) and forget any loaded module. */
export function setMergeEditorImporterForTest(next: (() => Promise<MergeEditor>) | null): void {
  importer = next ?? defaultImporter
  loaded = undefined
  pending = undefined
}
