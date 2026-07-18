import { gameConfig } from '../config/game'

export type Landform = 'plain' | 'hill' | 'peak'

export interface MapCell {
  elevation?: number
  landform?: Landform
  vegetation?: boolean
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
