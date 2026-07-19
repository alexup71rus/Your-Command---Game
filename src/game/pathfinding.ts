import type { GameMap } from './map'
import { terrainMovementOrderMultiplier } from './movement'
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
  const distances = new Float64Array(rows * columns).fill(Number.POSITIVE_INFINITY)
  const queue: Array<{ index: number; cost: number; order: number }> = []
  let insertionOrder = 0
  const comesBefore = (first: (typeof queue)[number], second: (typeof queue)[number]) => first.cost < second.cost || (first.cost === second.cost && first.order < second.order)
  const push = (entry: (typeof queue)[number]) => {
    queue.push(entry)
    let child = queue.length - 1
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (comesBefore(queue[parent], entry)) break
      queue[child] = queue[parent]
      child = parent
    }
    queue[child] = entry
  }
  const pop = () => {
    const first = queue[0]
    const last = queue.pop()
    if (!last || queue.length === 0) return first
    let parent = 0
    while (true) {
      const left = parent * 2 + 1
      if (left >= queue.length) break
      const right = left + 1
      const child = right < queue.length && comesBefore(queue[right], queue[left]) ? right : left
      if (comesBefore(last, queue[child])) break
      queue[parent] = queue[child]
      parent = child
    }
    queue[parent] = last
    return first
  }

  distances[sourceIndex] = 0
  previous[sourceIndex] = sourceIndex
  push({ index: sourceIndex, cost: 0, order: insertionOrder++ })

  while (queue.length > 0) {
    const currentEntry = pop()
    if (!currentEntry || currentEntry.cost !== distances[currentEntry.index]) continue
    const currentIndex = currentEntry.index
    if (currentIndex === targetIndex) break
    const current = { column: currentIndex % columns, row: Math.floor(currentIndex / columns) }
    for (const direction of directions) {
      const next = { column: current.column + direction.column, row: current.row + direction.row }
      if (!insideMap(next)) continue
      const nextIndex = next.row * columns + next.column
      const cell = map[next.row]?.[next.column]
      if (!cell || cell.landform === 'peak' || cell.object) continue
      const cost = currentEntry.cost + terrainMovementOrderMultiplier(cell)
      if (cost >= distances[nextIndex]) continue
      distances[nextIndex] = cost
      previous[nextIndex] = currentIndex
      push({ index: nextIndex, cost, order: insertionOrder++ })
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
