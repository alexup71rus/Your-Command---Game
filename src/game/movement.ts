import { gameConfig } from '../config/game'
import type { MapCell, SquadObject } from './map'

export function terrainMovementOrderMultiplier(cell: Pick<MapCell, 'vegetation'>) {
  return cell.vegetation ? gameConfig.turn.forestMovementOrderMultiplier : 1
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
