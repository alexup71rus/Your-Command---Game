import type { GameMap } from './map'
import type { CellPosition } from './scenario'

const directions = [
  { column: 1, row: 0 },
  { column: -1, row: 0 },
  { column: 0, row: 1 },
  { column: 0, row: -1 },
]

const samePosition = (first: CellPosition, second: CellPosition) => first.column === second.column && first.row === second.row

export function findMovementPath(map: GameMap, from: CellPosition, to: CellPosition): CellPosition[] | null {
  const rows = map.length
  const columns = map[0]?.length ?? 0
  const insideMap = (position: CellPosition) => position.column >= 0 && position.column < columns && position.row >= 0 && position.row < rows
  if (!insideMap(from) || !insideMap(to)) return null
  if (samePosition(from, to)) return [from]
  const target = map[to.row]?.[to.column]
  if (!target || target.landform === 'peak' || target.object) return null

  const sourceIndex = from.row * columns + from.column
  const targetIndex = to.row * columns + to.column
  const previous = new Int32Array(rows * columns).fill(-1)
  const queue = new Int32Array(rows * columns)
  let queueStart = 0
  let queueEnd = 0
  queue[queueEnd++] = sourceIndex
  previous[sourceIndex] = sourceIndex

  while (queueStart < queueEnd && previous[targetIndex] === -1) {
    const currentIndex = queue[queueStart++]
    const current = { column: currentIndex % columns, row: Math.floor(currentIndex / columns) }
    for (const direction of directions) {
      const next = { column: current.column + direction.column, row: current.row + direction.row }
      if (!insideMap(next)) continue
      const nextIndex = next.row * columns + next.column
      if (previous[nextIndex] !== -1) continue
      const cell = map[next.row]?.[next.column]
      if (!cell || cell.landform === 'peak' || cell.object) continue
      previous[nextIndex] = currentIndex
      queue[queueEnd++] = nextIndex
    }
  }

  if (previous[targetIndex] === -1) return null
  const path: CellPosition[] = []
  for (let index = targetIndex; ; index = previous[index]) {
    path.push({ column: index % columns, row: Math.floor(index / columns) })
    if (index === sourceIndex) break
  }
  return path.reverse()
}
