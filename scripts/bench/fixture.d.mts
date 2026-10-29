export interface BenchRepo {
  root: string
  bigFile: string
  hugeFile: string
  hugeDiffSha: string
  mergeSha: string
  modified: string[]
  untracked: string[]
}

export function createBenchRepo(dir: string, options?: { commits?: number }): Promise<BenchRepo>
