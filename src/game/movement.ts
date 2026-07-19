import { gameConfig } from '../config/game'
import { buildingRules } from '../config/rules'
import type { GameMap, MapCell, SquadObject, TroopKind } from './map'
import type { CellPosition } from './scenario'

export function terrainMovementOrderMultiplier(cell: Pick<MapCell, 'vegetation'>) {
  return cell.vegetation ? gameConfig.turn.forestMovementOrderMultiplier : 1
}

export function troopMovementOrderCost(troop: TroopKind) {
  return gameConfig.turn.movementOrderCost * (troop === 'knights'
    ? gameConfig.turn.knightMovementOrderMultiplier
    : 1)
}

export function squadMovementOrderCost(
  squad: Pick<SquadObject, 'units'>,
  destination: Pick<MapCell, 'vegetation'>,
) {
  const squadMultiplier = (squad.units.knights ?? 0) > 0
    ? gameConfig.turn.knightMovementOrderMultiplier
    : 1
  return gameConfig.turn.movementOrderCost * squadMultiplier * terrainMovementOrderMultiplier(destination)
}

export function friendlyBarbicanPassage(
  map: GameMap,
  from: CellPosition,
  to: CellPosition,
  ownerId: string,
) {
  const columnDistance = to.column - from.column
  const rowDistance = to.row - from.row
  if (Math.abs(columnDistance) + Math.abs(rowDistance) !== 2 || (columnDistance !== 0 && rowDistance !== 0)) return null
  const middle = {
    column: from.column + Math.sign(columnDistance),
    row: from.row + Math.sign(rowDistance),
  }
  const middleCell = map[middle.row]?.[middle.column]
  const destination = map[to.row]?.[to.column]
  const gate = middleCell?.object
  if (!destination || destination.landform === 'peak' || destination.object) return null
  if (gate?.type !== 'building' || gate.ownerId !== ownerId || !buildingRules[gate.kind].allowsFriendlyPassage) return null
  return { middle, middleCell, destination }
}

export function squadMovementOrderCostBetween(
  map: GameMap,
  squad: Pick<SquadObject, 'ownerId' | 'units'>,
  from: CellPosition,
  to: CellPosition,
) {
  const distance = Math.abs(to.column - from.column) + Math.abs(to.row - from.row)
  const destination = map[to.row]?.[to.column]
  if (distance === 1 && destination && destination.landform !== 'peak' && !destination.object) return squadMovementOrderCost(squad, destination)
  const passage = friendlyBarbicanPassage(map, from, to, squad.ownerId)
  if (!passage) return null
  const squadMultiplier = (squad.units.knights ?? 0) > 0 ? gameConfig.turn.knightMovementOrderMultiplier : 1
  return gameConfig.turn.movementOrderCost
    * squadMultiplier
    * (terrainMovementOrderMultiplier(passage.middleCell) + terrainMovementOrderMultiplier(passage.destination))
}
