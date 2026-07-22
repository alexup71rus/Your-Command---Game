import { aiPlannerConfig } from '../../../config/ai'
import type { SquadObject } from '../../map'
import type { MatchState } from '../../match'
import type { CellPosition } from '../../scenario'
import { aiObjectEntries, positionKey, samePosition } from '../analysis'
import type { AiMemory } from '../model'

export interface SquadEntry {
  position: CellPosition
  object: SquadObject
}

export const squadEntries = (state: MatchState, ownerId: string): SquadEntry[] => (
  aiObjectEntries(state.scenario, ownerId)
    .flatMap((entry) => entry.object.type === 'squad'
      ? [{ position: entry.position, object: entry.object }]
      : [])
)

export const isTemporarilyBlocked = (
  memory: AiMemory,
  position: CellPosition,
  turn: number,
) => memory.blockedCells.some((entry) => (
  entry.expiresTurn >= turn && positionKey(entry.position) === positionKey(position)
))

export function revisitsRecentFormationTrail(
  memory: AiMemory,
  from: CellPosition,
  to: CellPosition,
  turn: number,
) {
  const recent = memory.recentMovements.filter((entry) => (
    turn - entry.turn <= aiPlannerConfig.movementHistoryTurns
  ))
  const trail = new Set<string>()
  let cursor = from
  for (let guard = 0; guard < recent.length; guard += 1) {
    const prior = [...recent].reverse().find((entry) => samePosition(entry.to, cursor))
    if (!prior) break
    const key = positionKey(prior.from)
    if (trail.has(key)) break
    trail.add(key)
    cursor = prior.from
  }
  return trail.has(positionKey(to))
}
