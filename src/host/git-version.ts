// git version parsing and feature gates (B4d T1, design §16.7 `git/unsupported-version`, §16.9).
// Every version comparison lives here; endpoints ask `gitSupports` instead of comparing numbers.

export interface ParsedGitVersion {
  major: number
  minor: number
  patch: number
}

/** Oldest supported git: `--pathspec-from-file` for add/commit/reset/restore (2.25). */
export const GIT_MIN_VERSION = '2.25.0'

/** Features that only some supported versions have, with the first release that has them. */
const FEATURE_MIN_VERSION = {
  /** `rebase --update-refs`. */
  updateRefs: { major: 2, minor: 38, patch: 0 },
} as const satisfies Record<string, ParsedGitVersion>

export type GitFeature = keyof typeof FEATURE_MIN_VERSION

/**
 * `git version 2.39.3 (Apple Git-146)`, `git version 2.45.1.windows.1`, `git version 2.40.0.rc1`
 * or a bare `2.50.1`. Anything after major.minor[.patch] is ignored; other text → null.
 */
export function parseGitVersion(raw: string): ParsedGitVersion | null {
  const match = /^\s*(?:git version )?(\d+)\.(\d+)(?:\.(\d+))?/u.exec(raw)
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) }
}

export function formatGitVersion(version: ParsedGitVersion): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`
}

function atLeast(version: ParsedGitVersion, minimum: ParsedGitVersion): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major
  if (version.minor !== minimum.minor) return version.minor > minimum.minor
  return version.patch >= minimum.patch
}

const MIN_PARSED = parseGitVersion(GIT_MIN_VERSION) ?? { major: 2, minor: 25, patch: 0 }

export function isSupportedGitVersion(version: ParsedGitVersion): boolean {
  return atLeast(version, MIN_PARSED)
}

export function gitSupports(version: ParsedGitVersion, feature: GitFeature): boolean {
  return atLeast(version, FEATURE_MIN_VERSION[feature])
}
