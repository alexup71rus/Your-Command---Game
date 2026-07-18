import { gameConfig } from '../config/game'

export type MapCell = Record<string, never>
export type GameMap = MapCell[][]

export function createEmptyMap(
  rows = gameConfig.map.rows,
  columns = gameConfig.map.columns,
): GameMap {
  return Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => ({})),
  )
}
