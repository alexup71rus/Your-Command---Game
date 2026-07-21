export const UNREACHABLE_DISTANCE = 0xffff_ffff

export interface DistanceFieldRequest {
  rows: number
  columns: number
  passability: Uint32Array
  sources: Uint32Array
}

export type DistanceFieldKernel = (request: DistanceFieldRequest) => Uint32Array

export const typescriptDistanceFieldKernel: DistanceFieldKernel = ({
  rows,
  columns,
  passability,
  sources,
}) => {
  const cellCount = rows * columns
  const distances = new Uint32Array(cellCount)
  distances.fill(UNREACHABLE_DISTANCE)
  if (rows === 0 || columns === 0) return distances

  const queue = new Uint32Array(cellCount)
  let head = 0
  let tail = 0
  sources.forEach((source) => {
    if (source >= cellCount || distances[source] === 0) return
    distances[source] = 0
    queue[tail] = source
    tail += 1
  })

  const visit = (index: number, distance: number) => {
    if (passability[index] === 0 || distance >= distances[index]) return
    distances[index] = distance
    queue[tail] = index
    tail += 1
  }

  while (head < tail) {
    const current = queue[head]
    head += 1
    const row = Math.floor(current / columns)
    const column = current % columns
    const nextDistance = distances[current] + 1
    if (column > 0) visit(current - 1, nextDistance)
    if (column + 1 < columns) visit(current + 1, nextDistance)
    if (row > 0) visit(current - columns, nextDistance)
    if (row + 1 < rows) visit(current + columns, nextDistance)
  }
  return distances
}

export function distanceAt(
  field: Uint32Array,
  columns: number,
  row: number,
  column: number,
) {
  const distance = field[row * columns + column] ?? UNREACHABLE_DISTANCE
  return distance === UNREACHABLE_DISTANCE ? Number.POSITIVE_INFINITY : distance
}
