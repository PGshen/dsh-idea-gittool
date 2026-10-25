/**
 * Declaration merges owned by this plugin. DSH keeps its navigation-parameter
 * maps open for package augmentation; the `git.blame` page kind registers the
 * parameters it accepts here so `ctx.sidebarRight.openTab('git.blame', …)` is
 * type-checked against the same shape the body reads.
 */
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Navigation parameters of the blame page opened from a document header. */
    'git.blame': {
      /** Absolute path of the file the header action acted on. */
      readonly absolutePath: string
      /** Repo-relative POSIX path, when the opener could derive it. */
      readonly repoRelativePath?: string
    }
  }
}
