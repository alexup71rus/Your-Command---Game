import { copyFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = resolve(root, 'wasm/grid-kernels/Cargo.toml')
const output = resolve(root, 'src/game/wasm/grid_kernels.wasm')
const build = spawnSync('cargo', [
  'build',
  '--manifest-path', manifest,
  '--target', 'wasm32-unknown-unknown',
  '--release',
], { cwd: root, stdio: 'inherit' })

if (build.status !== 0) process.exit(build.status ?? 1)

mkdirSync(dirname(output), { recursive: true })
copyFileSync(
  resolve(root, 'wasm/grid-kernels/target/wasm32-unknown-unknown/release/castle_turns_grid_kernels.wasm'),
  output,
)
