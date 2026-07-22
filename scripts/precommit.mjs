import { spawnSync } from 'node:child_process'

const checks = [
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'format:check']],
  ['npm', ['run', 'typecheck']],
  // AI tests are intentionally behavioral and can take minutes. Run them via
  // `npm run test:ai` or `npm run test:ai:soak` when finalizing AI changes.
  ['npm', ['run', 'test:fast']],
  ['npm', ['run', 'build']],
]

for (const [command, args] of checks) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
