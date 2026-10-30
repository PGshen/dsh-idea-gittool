// 发布产物脚本（r1 T3）：build → smoke → pack → dist/SHA256SUMS，并打印安装命令。
// 只做发布打包，不做 git push / npm publish；那两步由负责人确认后执行（docs/runbooks/release.md）。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RELEASE_BASE = 'https://github.com/PGshen/dsh-idea-gittool/releases/download'

/** `@scope/pkg` 的 tarball 名按 npm 规则去掉 `@`、把 `/` 换成 `-`。 */
export function tarballName(pkg) {
  const name = pkg.name.startsWith('@') ? pkg.name.slice(1).replace('/', '-') : pkg.name
  return `${name}-${pkg.version}.tgz`
}

/** `shasum -a 256 -c` 认的格式：哈希、两个空格、文件名。 */
export function checksumLine(hash, file) {
  return `${hash}  ${file}`
}

export function formatSize(bytes) {
  const kb = bytes / 1024
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(2)} MB`
}

/** 收件人用 Release 附件 URL 安装；file 为 tarball 文件名。 */
export function releaseUrl(version, file) {
  return `${RELEASE_BASE}/v${version}/${file}`
}

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' })
}

function gitDirty() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const dirty = gitDirty()
  if (dirty !== '') {
    process.stderr.write(`警告：工作树不干净，发布前请确认改动已提交：\n${dirty}\n\n`)
  }

  run('pnpm', ['run', 'build'])
  run('pnpm', ['run', 'smoke'])

  const dir = join(ROOT, 'dist')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  run('pnpm', ['pack', '--pack-destination', dir])

  const file = tarballName(pkg)
  const path = join(dir, file)
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  writeFileSync(join(dir, 'SHA256SUMS'), `${checksumLine(hash, file)}\n`)
  const size = formatSize(statSync(path).size)

  process.stdout.write(
    [
      '',
      `发布产物：${path}（${size}）`,
      `sha256：${hash}`,
      '',
      '本机安装：',
      `  pnpm dsh plugin --profile web add ${path}`,
      '',
      '上传到 GitHub Release 后，收件人安装：',
      `  dsh plugin --profile web add ${releaseUrl(pkg.version, file)}`,
      '  # 然后重启 dsh web',
      '',
      '发布清单见 docs/runbooks/release.md。',
      '',
    ].join('\n'),
  )
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
