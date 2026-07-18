import { gameConfig } from '../config/game'

export type Landform = 'plain' | 'hill' | 'peak'

export interface CastleObject {
  type: 'castle'
  ownerId: string
}

export interface MapCell {
  elevation?: number
  landform?: Landform
  vegetation?: boolean
  object?: CastleObject
}
export type GameMap = MapCell[][]

export function createEmptyMap(
  rows: number = gameConfig.map.rows,
  columns: number = gameConfig.map.columns,
): GameMap {
  return Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => ({})),
  )
}

export function clearMapObjects(map: GameMap): GameMap {
  return map.map((row) => row.map(({ object: _object, ...cell }) => cell))
}
