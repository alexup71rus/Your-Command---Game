// @ts-expect-error Vitest provides Node built-ins; the browser bundle intentionally omits Node types.
import { readFileSync } from 'node:fs'
// @ts-expect-error Vitest provides Node built-ins; the browser bundle intentionally omits Node types.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  UNREACHABLE_DISTANCE,
  typescriptDistanceFieldKernel,
  type DistanceFieldKernel,
  type DistanceFieldRequest,
} from './distanceField'
import { instantiateWasmDistanceFieldKernel } from './distanceFieldWasm'

const request: DistanceFieldRequest = {
  rows: 4,
  columns: 5,
  passability: Uint32Array.from([
    1, 1, 1, 0, 1,
    1, 0, 1, 0, 1,
    1, 0, 1, 1, 1,
    1, 1, 1, 0, 1,
  ]),
  sources: Uint32Array.from([0, 19]),
}

function expectedDistances() {
  return [
    0, 1, 2, UNREACHABLE_DISTANCE, 3,
    1, UNREACHABLE_DISTANCE, 3, UNREACHABLE_DISTANCE, 2,
    2, UNREACHABLE_DISTANCE, 3, 2, 1,
    3, 4, 4, UNREACHABLE_DISTANCE, 0,
  ]
}

function expectKernelResult(kernel: DistanceFieldKernel) {
  expect([...kernel(request)]).toEqual(expectedDistances())
}

describe('distance field kernels', () => {
  it('computes deterministic multi-source distances in TypeScript', () => {
    expectKernelResult(typescriptDistanceFieldKernel)
  })

  it('keeps blocked source cells as valid distance origins', () => {
    const result = typescriptDistanceFieldKernel({
      rows: 1,
      columns: 3,
      passability: Uint32Array.from([1, 0, 1]),
      sources: Uint32Array.from([1]),
    })
    expect([...result]).toEqual([1, 0, 1])
  })

  it('matches the compiled WASM kernel exactly', async () => {
    const file = readFileSync(fileURLToPath(new URL('../wasm/grid_kernels.wasm', import.meta.url)))
    const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
    expectKernelResult(await instantiateWasmDistanceFieldKernel(bytes))
  })
})
