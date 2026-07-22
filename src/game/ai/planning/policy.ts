import { aiPlannerConfig } from '../../../config/ai'
import { economyBuildingKinds, resourceIds } from '../../../config/rules'
import { buildingResourceCostFor, objectAt, type MatchState } from '../../match'
import type { AiCommand, AiMemory } from '../model'
import { immediateCriticalAssetAttackFor, nextFortificationStep } from '../strategy'

export type AiPlanningMode = 'full' | 'development-only' | 'economy-only' | 'combat-only'

const engagementCommandTypes = new Set<AiCommand['type']>([
  'move-or-attack',
  'split',
  'garrison',
  'ungarrison',
  'tower-attack',
])

export function commandAllowed(state: MatchState, command: AiCommand, mode: AiPlanningMode) {
  if (mode === 'full') return true
  const engagement = engagementCommandTypes.has(command.type)
  if (mode === 'combat-only') return engagement
  if (engagement) return false
  if (mode === 'development-only') return true
  if (command.type === 'build') {
    return command.building !== 'barracks' && economyBuildingKinds.includes(command.building)
  }
  if (command.type === 'demolish') {
    const object = objectAt(state, command.position)
    return object?.type === 'building'
      && object.kind !== 'barracks'
      && economyBuildingKinds.includes(object.kind)
  }
  return command.type === 'tax' || command.type === 'trade' || command.type === 'dismiss'
}

export function strategicOrderReserve(phase: AiMemory['phase']) {
  if (phase === 'defense') return aiPlannerConfig.defenseStrategicOrderReserve
  if (phase === 'assault') return aiPlannerConfig.assaultOrderReserve
  if (phase === 'mobilization' || phase === 'regroup') return aiPlannerConfig.ordinaryTacticalOrderReserve
  return 0
}

export function openingTacticalOrderReserve(state: MatchState, memory: AiMemory) {
  const ordinary = strategicOrderReserve(memory.phase)
  if (memory.phase === 'defense'
    && immediateCriticalAssetAttackFor(state, state.activeParticipantId).threatened) return 0
  if (memory.phase !== 'defense' || nextFortificationStep(state, memory, true) !== 'tower') return ordinary
  const resources = state.domains[state.activeParticipantId]?.resources
  const cost = buildingResourceCostFor(state, state.activeParticipantId, 'tower')
  const towerAffordable = resources && resourceIds.every((resource) => resources[resource] >= (cost[resource] ?? 0))
  return towerAffordable ? aiPlannerConfig.defenseTowerOrderReserve : ordinary
}
