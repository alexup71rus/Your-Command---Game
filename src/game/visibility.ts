import { gameConfig } from '../config/game'
import { buildingRules } from '../config/rules'
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

export function calculateVisibility(
  map: GameMap,
  playerId: string,
  fogEnabled: boolean = gameConfig.visibility.enabled,
): VisibilityMap {
  if (!fogEnabled) return map.map((row) => Uint8Array.from({ length: row.length }, () => 1))
  const visibility = map.map((row) => new Uint8Array(row.length))

  for (let row = 0; row < map.length; row += 1) {
    for (let column = 0; column < map[row].length; column += 1) {
      const cell = map[row][column]
      const object = cell.object
      if (!object || object.ownerId !== playerId) continue
      const radius = object.type === 'squad'
        ? cell.landform === 'hill' ? gameConfig.visibility.elevatedSquadRadius : gameConfig.visibility.squadRadius
        : object.type === 'building' && object.kind === 'tower'
          ? buildingRules.tower.garrison?.visibilityRadius ?? gameConfig.visibility.buildingRadius
          : gameConfig.visibility.buildingRadius
      revealRadius(visibility, { column, row }, radius)
    }
  }

  return visibility
}

/**
 * Memoizes visibility by immutable map identity. Economy-only state updates can
 * reuse the result while map-changing commands naturally invalidate it.
 */
export function createVisibilitySelector(fogEnabled: boolean = gameConfig.visibility.enabled) {
  let previousMap: GameMap | null = null
  let previousPlayerId: string | null = null
  let previousVisibility: VisibilityMap | null = null

  return (map: GameMap, playerId: string) => {
    if (map === previousMap && playerId === previousPlayerId && previousVisibility) return previousVisibility
    previousMap = map
    previousPlayerId = playerId
    previousVisibility = calculateVisibility(map, playerId, fogEnabled)
    return previousVisibility
  }
}

export function isCellVisible(visibility: VisibilityMap | null | undefined, position: CellPosition) {
  return !visibility || visibility[position.row]?.[position.column] === 1
}

export function hasNearbyEnemyThreat(map: GameMap, playerId: string, radius: number) {
  const ownedPositions: CellPosition[] = []
  const enemyThreats: CellPosition[] = []
  map.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    if (!object) return
    const position = { column, row: rowIndex }
    if (object.ownerId === playerId) ownedPositions.push(position)
    else if (object.type === 'squad'
      || (object.type === 'building' && object.kind === 'tower' && Boolean(object.garrison))) enemyThreats.push(position)
  }))
  const radiusSquared = radius * radius
  return enemyThreats.some((threat) => ownedPositions.some((owned) => {
    const columnDistance = threat.column - owned.column
    const rowDistance = threat.row - owned.row
    return columnDistance * columnDistance + rowDistance * rowDistance <= radiusSquared
  }))
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
): MapObject | undefined {
  const object = map[position.row]?.[position.column]?.object
  if (!object || !isObjectVisible(map, visibility, playerId, position)) return undefined
  if (object.type === 'building' && object.kind === 'tower' && object.ownerId !== playerId && !isCellVisible(visibility, position)) {
    const { garrison: _concealedGarrison, ...publicTower } = object
    return publicTower
  }
  return object
}
