import { spawnSync } from 'node:child_process'

const checks = [
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'typecheck']],
  ['npm', ['test', '--', '--run']],
]

for (const [command, args] of checks) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
