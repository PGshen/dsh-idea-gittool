// Facts about in-progress repository operations shared by stores and pages (React-free).
import type { RepoOperation } from '../shared/protocol.ts'

/** Operations the Host can skip a commit of (`operationControl skip`). */
export const SKIPPABLE: ReadonlySet<Exclude<RepoOperation, null>> = new Set(['rebase', 'cherry-pick'])
