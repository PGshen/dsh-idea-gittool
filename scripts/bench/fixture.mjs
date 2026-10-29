// B4c: synthetic benchmark repository built with `git fast-import` (10k commits in seconds).
// Deterministic: fixed authors, timestamps and contents, so the same options give the same shas.
// Shapes the bench needs: first-parent history with periodic merges, topic branches, tags,
// a 4500-line file touched every 500 commits (blame), a >256 KiB file added near the tip
// (truncated diff), and a dirty worktree (status / bootstrap).
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
}

const SMALL_FILES = 200
const MERGE_EVERY = 50
const TAG_EVERY = 200
const BIG_EVERY = 500
const BIG_LINES = 4500
const TOPIC_BRANCHES = 20
const AUTHORS = ['Ada <ada@example.com>', 'Linus <linus@example.com>', 'Grace <grace@example.com>', 'Ken <ken@example.com>']
const BASE_TIME = 1_700_000_000

function git(root, args, input) {
  const result = spawnSync('git', args, {
    cwd: root,
    env: GIT_ENV,
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${String(result.status)}: ${result.stderr}`)
  return result.stdout
}

function data(text) {
  return `data ${String(Buffer.byteLength(text))}\n${text}\n`
}

function bigFile(version) {
  const lines = []
  for (let line = 1; line <= BIG_LINES; line += 1) {
    // Every version rewrites a different slice of 300 lines so blame spreads over many commits.
    const owner = Math.floor((line - 1) / 300) <= version ? version - Math.floor((line - 1) / 300) : 0
    lines.push(`line ${String(line)} rev ${String(owner)}`)
  }
  return `${lines.join('\n')}\n`
}

function hugeFile() {
  const row = 'x'.repeat(99)
  const lines = []
  for (let line = 0; line < 4000; line += 1) lines.push(`${String(line).padStart(5, '0')} ${row}`)
  return `${lines.join('\n')}\n`
}

/**
 * Create the repository under `dir` (which must exist and be empty).
 * @param {string} dir
 * @param {{ commits?: number }} [options]
 */
export async function createBenchRepo(dir, options = {}) {
  const commits = options.commits ?? 10_000
  const root = realpathSync(dir)
  git(root, ['init', '-q', '-b', 'main'])

  const parts = []
  let mark = 0
  const mainMarks = []
  const topicMarks = []
  let lastMergeMark = 0
  let hugeMark = 0
  const hugeAt = Math.max(2, commits - 10)
  const tags = []

  const header = (ref, index) => {
    mark += 1
    const author = AUTHORS[index % AUTHORS.length]
    const time = `${String(BASE_TIME + index * 600)} +0000`
    parts.push(`commit ${ref}\nmark :${String(mark)}\nauthor ${author} ${time}\ncommitter ${author} ${time}\n`)
    return mark
  }

  for (let index = 1; index <= commits; index += 1) {
    let sideMark = 0
    // Offset by half a period so the tip is never a merge: the last 24 commits form a clean rebase plan.
    if (index % MERGE_EVERY === MERGE_EVERY / 2 && mainMarks.length >= 5) {
      sideMark = header('refs/heads/side', index)
      parts.push(data(`topic work ${String(index)}\n`))
      parts.push(`from :${String(mainMarks[mainMarks.length - 5])}\n`)
      parts.push(`M 100644 inline side/s${String(index)}.txt\n${data(`side ${String(index)}\n`)}`)
      topicMarks.push(sideMark)
    }

    const own = header('refs/heads/main', index)
    const subject = sideMark !== 0 ? `Merge topic ${String(index)}` : `change ${String(index)}: update f${String(index % SMALL_FILES)}`
    parts.push(data(`${subject}\n\nBody of commit ${String(index)}.\n`))
    if (mainMarks.length > 0) parts.push(`from :${String(mainMarks[mainMarks.length - 1])}\n`)
    if (sideMark !== 0) {
      parts.push(`merge :${String(sideMark)}\n`)
      lastMergeMark = own
    }
    if (index === 1) {
      for (let file = 0; file < SMALL_FILES; file += 1) {
        parts.push(`M 100644 inline src/f${String(file)}.txt\n${data(`file ${String(file)}\n`)}`)
      }
    }
    parts.push(`M 100644 inline src/f${String(index % SMALL_FILES)}.txt\n${data(`file ${String(index % SMALL_FILES)}\nchange ${String(index)}\n`)}`)
    if (index === 1 || index % BIG_EVERY === 0) {
      parts.push(`M 100644 inline big.txt\n${data(bigFile(Math.floor(index / BIG_EVERY)))}`)
    }
    if (index === hugeAt) {
      parts.push(`M 100644 inline huge.txt\n${data(hugeFile())}`)
      hugeMark = own
    }
    mainMarks.push(own)
    if (index % TAG_EVERY === 0) tags.push([`v${String(index / TAG_EVERY)}`, own])
  }

  topicMarks.slice(-TOPIC_BRANCHES).forEach((topic, index) => {
    parts.push(`reset refs/heads/topic-${String(index + 1)}\nfrom :${String(topic)}\n\n`)
  })
  for (const [name, target] of tags) parts.push(`reset refs/tags/${name}\nfrom :${String(target)}\n\n`)
  parts.push('reset refs/heads/side\nfrom 0000000000000000000000000000000000000000\n\n')

  const marksFile = join(root, '.git', 'bench-marks')
  git(root, ['fast-import', '--quiet', `--export-marks=${marksFile}`], parts.join(''))
  const marks = new Map(
    readFileSync(marksFile, 'utf8').trim().split('\n').map((line) => {
      const [key, sha] = line.split(' ')
      return [Number(key.slice(1)), sha]
    }),
  )
  git(root, ['reset', '-q', '--hard', 'main'])

  const modified = []
  for (let file = 0; file < 20; file += 1) {
    const path = `src/f${String(file)}.txt`
    writeFileSync(join(root, path), `file ${String(file)}\ndirty edit\n`)
    modified.push(path)
  }
  mkdirSync(join(root, 'new'), { recursive: true })
  const untracked = []
  for (let file = 0; file < 5; file += 1) {
    const path = `new/u${String(file)}.txt`
    writeFileSync(join(root, path), `untracked ${String(file)}\n`)
    untracked.push(path)
  }

  return {
    root,
    bigFile: 'big.txt',
    hugeFile: 'huge.txt',
    hugeDiffSha: marks.get(hugeMark),
    mergeSha: marks.get(lastMergeMark),
    modified,
    untracked,
  }
}
