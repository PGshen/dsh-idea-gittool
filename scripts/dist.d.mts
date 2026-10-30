// Types for the release script scripts/dist.mjs (r1 T3).
export interface PackageManifest {
  name: string
  version: string
}
export function tarballName(pkg: PackageManifest): string
export function checksumLine(hash: string, file: string): string
export function formatSize(bytes: number): string
export function releaseUrl(version: string, file: string): string
