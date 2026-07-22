import { aiTacticalConfig } from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import type { GameMap } from '../../map'
import type { MatchState } from '../../match'
import { clockwiseCardinalDirections } from '../../geometry'
import { findMovementPath } from '../../pathfinding'
import { areOwnersHostile, type CellPosition } from '../../scenario'
import { castlePositionFor, positionDistance } from '../analysis'
import type { AiMemory, AiSquadRole } from '../model'

export const adjacentDestinations = (target: CellPosition) => clockwiseCardinalDirections
  .map((direction) => ({
    column: target.column + direction.column,
    row: target.row + direction.row,
  }))

export function musterDestinations(state: MatchState, target: CellPosition) {
  const result: CellPosition[] = []
  for (let radius = 0; radius <= aiTacticalConfig.route.musterRadius; radius += 1) {
    for (let deltaRow = -radius; deltaRow <= radius; deltaRow += 1) {
      const deltaColumn = radius - Math.abs(deltaRow)
      const columns = deltaColumn === 0
        ? [target.column]
        : [target.column - deltaColumn, target.column + deltaColumn]
      columns.forEach((column) => {
        const position = { column, row: target.row + deltaRow }
        const cell = state.scenario.cells[position.row]?.[position.column]
        if (cell && cell.landform !== 'peak' && !cell.object) result.push(position)
      })
    }
  }
  return result
}

export function mapWithRememberedThreats(
  state: MatchState,
  memory: AiMemory,
  ownerId: string,
): GameMap {
  let result = state.scenario.cells
  const changedRows = new Map<number, GameMap[number]>()
  memory.contacts.forEach((contact) => {
    if (!areOwnersHostile(state.scenario.participants, ownerId, contact.ownerId)
      || contact.kind !== 'squad'
      || state.turn - contact.lastSeenTurn > gameConfig.ai.memoryRouteAvoidanceTurns) return
    const cell = result[contact.position.row]?.[contact.position.column]
    if (!cell || cell.object) return
    const row = changedRows.get(contact.position.row) ?? [...result[contact.position.row]]
    if (!changedRows.has(contact.position.row)) {
      result = [...result]
      changedRows.set(contact.position.row, row)
      result[contact.position.row] = row
    }
    row[contact.position.column] = {
      ...cell,
      object: {
        type: 'squad',
        ownerId: contact.ownerId,
        units: contact.units ?? { militia: 1, spearmen: 0, archers: 0, knights: 0 },
        health: contact.health,
      },
    }
  })
  return result
}

export function approachDestinations(
  state: MatchState,
  target: CellPosition,
  role: AiSquadRole,
  navigationMap: GameMap = state.scenario.cells,
) {
  if (role === 'ranged') {
    const result: CellPosition[] = []
    for (let radius = gameConfig.turn.archerMinimumRange; radius <= gameConfig.turn.archerRange; radius += 1) {
      for (const direction of clockwiseCardinalDirections) {
        const position = {
          column: target.column + direction.column * radius,
          row: target.row + direction.row * radius,
        }
        const cell = navigationMap[position.row]?.[position.column]
        if (cell && cell.landform !== 'peak' && !cell.object) result.push(position)
      }
    }
    return result
  }
  const minimum = role === 'scout'
    ? aiTacticalConfig.route.scoutApproachMinimum
    : aiTacticalConfig.route.ordinaryApproachMinimum
  const maximum = role === 'reserve'
    ? aiTacticalConfig.route.reserveApproachRadius
    : aiTacticalConfig.route.ordinaryApproachRadius
  const result: CellPosition[] = []
  for (let radius = minimum; radius <= maximum; radius += 1) {
    for (let deltaRow = -radius; deltaRow <= radius; deltaRow += 1) {
      const deltaColumn = radius - Math.abs(deltaRow)
      const columns = deltaColumn === 0
        ? [target.column]
        : [target.column - deltaColumn, target.column + deltaColumn]
      columns.forEach((column) => {
        const position = { column, row: target.row + deltaRow }
        const cell = navigationMap[position.row]?.[position.column]
        if (cell && cell.landform !== 'peak' && !cell.object) result.push(position)
      })
    }
  }
  return result
}

export function retreatDestination(
  state: MatchState,
  from: CellPosition,
  ownerId: string,
  navigationMap: GameMap,
) {
  const castle = castlePositionFor(state.scenario, ownerId)
  if (!castle) return null
  const currentDistance = positionDistance(from, castle)
  for (const destination of adjacentDestinations(castle)) {
    const cell = state.scenario.cells[destination.row]?.[destination.column]
    if (!cell || cell.landform === 'peak' || cell.object) continue
    const path = findMovementPath(navigationMap, from, destination, { ownerId })
    if (path && path.length > 1
      && positionDistance(path[1], castle) < currentDistance) return path[1]
  }
  return null
}
