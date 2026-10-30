// r1 T3：发布脚本的纯函数（产物命名、校验和格式、安装 URL）。
import { describe, expect, it } from 'vitest'

import { checksumLine, formatSize, releaseUrl, tarballName } from '../scripts/dist.mjs'

describe('tarballName', () => {
  it('uses npm pack naming for an unscoped package', () => {
    expect(tarballName({ name: 'dsh-idea-gittool', version: '1.0.0-rc.1' })).toBe('dsh-idea-gittool-1.0.0-rc.1.tgz')
  })

  it('drops the @ and replaces the scope slash', () => {
    expect(tarballName({ name: '@acme/git-tool', version: '2.0.0' })).toBe('acme-git-tool-2.0.0.tgz')
  })
})

describe('checksumLine', () => {
  it('writes the two-space form shasum -c accepts', () => {
    const line = checksumLine('a'.repeat(64), 'pkg-1.0.0.tgz')
    expect(line).toBe(`${'a'.repeat(64)}  pkg-1.0.0.tgz`)
    expect(line).toMatch(/^[0-9a-f]{64} {2}\S+$/)
  })
})

describe('formatSize', () => {
  it('reports kilobytes below one megabyte and megabytes above it', () => {
    expect(formatSize(358095)).toBe('349.7 KB')
    expect(formatSize(2 * 1024 * 1024)).toBe('2.00 MB')
  })
})

describe('releaseUrl', () => {
  it('points at the tagged GitHub Release asset', () => {
    expect(releaseUrl('1.0.0-rc.1', 'dsh-idea-gittool-1.0.0-rc.1.tgz')).toBe(
      'https://github.com/PGshen/dsh-idea-gittool/releases/download/v1.0.0-rc.1/dsh-idea-gittool-1.0.0-rc.1.tgz',
    )
  })
})
