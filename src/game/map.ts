import { gameConfig } from '../config/game'

export type Landform = 'plain' | 'hill' | 'peak'

export type ResourceId = 'wood' | 'stone' | 'iron' | 'grain' | 'meat' | 'gold'
export type BuildingKind = 'farm' | 'lumberMill' | 'quarry' | 'house' | 'barracks' | 'church' | 'market' | 'wall' | 'tower' | 'barbican'
export type TroopKind = 'militia' | 'spearmen' | 'archers' | 'knights'
export type TroopComposition = Record<TroopKind, number>

export interface CastleObject {
  type: 'castle'
  ownerId: string
  hitPoints: number
  maxHitPoints: number
}

export interface BuildingObject {
  type: 'building'
  kind: BuildingKind
  ownerId: string
  hitPoints: number
  maxHitPoints: number
  footprint?: {
    originColumn: number
    originRow: number
    columns: number
    rows: number
  }
}

export interface SquadObject {
  type: 'squad'
  ownerId: string
  units: TroopComposition
  health?: number
}

export type MapObject = CastleObject | BuildingObject | SquadObject

export interface MapCell {
  elevation?: number
  landform?: Landform
  vegetation?: boolean
  object?: MapObject
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
