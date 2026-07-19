import { gameConfig } from '../config/game'
import type { GameMap, MapObject } from './map'
import type { CellPosition } from './scenario'

export type VisibilityMap = Uint8Array[]

function revealRadius(visibility: VisibilityMap, center: CellPosition, radius: number) {
  const rows = visibility.length
  const columns = visibility[0]?.length ?? 0
  const radiusSquared = radius * radius
  const firstRow = Math.max(0, center.row - radius)
  const lastRow = Math.min(rows - 1, center.row + radius)
  const firstColumn = Math.max(0, center.column - radius)
  const lastColumn = Math.min(columns - 1, center.column + radius)

  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const columnDistance = column - center.column
      const rowDistance = row - center.row
      if (columnDistance * columnDistance + rowDistance * rowDistance <= radiusSquared) visibility[row][column] = 1
    }
  }
}

export function calculateVisibility(map: GameMap, playerId: string): VisibilityMap {
  const visibility = map.map((row) => new Uint8Array(row.length))

  for (let row = 0; row < map.length; row += 1) {
    for (let column = 0; column < map[row].length; column += 1) {
      const cell = map[row][column]
      const object = cell.object
      if (!object || object.ownerId !== playerId) continue
      const radius = object.type === 'squad'
        ? cell.landform === 'hill' ? gameConfig.visibility.elevatedSquadRadius : gameConfig.visibility.squadRadius
        : gameConfig.visibility.buildingRadius
      revealRadius(visibility, { column, row }, radius)
    }
  }

  return visibility
}

export function isCellVisible(visibility: VisibilityMap | null | undefined, position: CellPosition) {
  return !visibility || visibility[position.row]?.[position.column] === 1
}

export function isConcealedEnemyObject(object: MapObject, playerId: string) {
  return object.ownerId !== playerId && (object.type === 'squad' || (object.type === 'building' && object.kind === 'barracks'))
}

export function isObjectVisible(
  map: GameMap,
  visibility: VisibilityMap | null | undefined,
  playerId: string,
  position: CellPosition,
) {
  const object = map[position.row]?.[position.column]?.object
  if (!object || !isConcealedEnemyObject(object, playerId)) return true
  if (isCellVisible(visibility, position)) return true
  if (object.type !== 'building' || !object.footprint) return false

  const { originColumn, originRow, columns, rows } = object.footprint
  for (let row = originRow; row < originRow + rows; row += 1) {
    for (let column = originColumn; column < originColumn + columns; column += 1) {
      if (isCellVisible(visibility, { column, row })) return true
    }
  }
  return false
}

export function visibleObjectAt(
  map: GameMap,
  visibility: VisibilityMap | null | undefined,
  playerId: string,
  position: CellPosition,
) {
  const object = map[position.row]?.[position.column]?.object
  return object && isObjectVisible(map, visibility, playerId, position) ? object : undefined
}
