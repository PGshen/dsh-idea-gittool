// B4c: bundle the log-scroll harness (React included, CSS Modules as in build.mjs) into
// .evidence/b4c/harness/. Not shipped; the output folder is git-ignored.
import { copyFileSync, mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const out = '.evidence/b4c/harness'
mkdirSync(out, { recursive: true })
await build({
  entryPoints: ['scripts/bench-client/entry.tsx'],
  outfile: `${out}/entry.js`,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.module.css': 'local-css', '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
})
copyFileSync('scripts/bench-client/index.html', `${out}/index.html`)
console.log(`harness built: ${out}/index.html — run \`await harness.measure()\` in its console`)
