import wasmUrl from '../wasm/grid_kernels.wasm?url'
import type { DistanceFieldKernel } from './distanceField'

interface GridKernelExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory
  allocate_u32: (length: number) => number
  deallocate_u32: (pointer: number, length: number) => void
  multi_source_distances: (
    passabilityPointer: number,
    sourcePointer: number,
    sourceCount: number,
    rows: number,
    columns: number,
    outputPointer: number,
  ) => void
}

function wasmKernelFor(exports: GridKernelExports): DistanceFieldKernel {
  return ({ rows, columns, passability, sources }) => {
    const cellCount = rows * columns
    const passabilityPointer = exports.allocate_u32(cellCount)
    const sourcesPointer = exports.allocate_u32(sources.length)
    const outputPointer = exports.allocate_u32(cellCount)
    try {
      new Uint32Array(exports.memory.buffer, passabilityPointer, cellCount).set(passability)
      if (sources.length > 0) {
        new Uint32Array(exports.memory.buffer, sourcesPointer, sources.length).set(sources)
      }
      exports.multi_source_distances(
        passabilityPointer,
        sourcesPointer,
        sources.length,
        rows,
        columns,
        outputPointer,
      )
      return new Uint32Array(exports.memory.buffer, outputPointer, cellCount).slice()
    } finally {
      exports.deallocate_u32(outputPointer, cellCount)
      exports.deallocate_u32(sourcesPointer, sources.length)
      exports.deallocate_u32(passabilityPointer, cellCount)
    }
  }
}

export async function loadWasmDistanceFieldKernel(): Promise<DistanceFieldKernel> {
  const response = await fetch(wasmUrl)
  if (!response.ok) throw new Error(`Grid WASM request failed: ${response.status}`)
  return instantiateWasmDistanceFieldKernel(await response.arrayBuffer())
}

export async function instantiateWasmDistanceFieldKernel(
  bytes: BufferSource,
): Promise<DistanceFieldKernel> {
  const { instance } = await WebAssembly.instantiate(bytes)
  return wasmKernelFor(instance.exports as GridKernelExports)
}
