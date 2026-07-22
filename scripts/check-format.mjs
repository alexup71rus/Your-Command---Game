import { extname } from 'node:path'
import { spawnSync } from 'node:child_process'

const diff = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' })
if (diff.status !== 0) process.exit(diff.status ?? 1)

const supportedExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.ts', '.tsx'])
const files = diff.stdout
  .split('\0')
  .filter(Boolean)
  .filter((file) => supportedExtensions.has(extname(file)))

if (files.length === 0) process.exit(0)

const check = spawnSync('prettier', ['--check', ...files], { stdio: 'inherit' })
process.exit(check.status ?? 1)
