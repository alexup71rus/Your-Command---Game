import { aiPlannerConfig, aiStrategicConfig } from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import { buildingRules, resourceIds } from '../../../config/rules'
import { projectOwnerEconomy, type MatchState } from '../../match'
import type {
  AiCommand,
  AiPlanTraceEntry,
  AiProfileRules,
  AiStrategicPhase,
} from '../model'
import {
  armyPowerFor,
  economySnapshotFor,
  homeThreatFor,
} from './assessment'
import { canAfford } from './shared'
import type { StrategicCandidate } from './types'

const foodResources = gameConfig.economy.foodResources

export function projectedStrategicScore(
  state: MatchState,
  profile: AiProfileRules,
  phase: AiStrategicPhase,
  projectionTurns: number = aiPlannerConfig.projectionTurns,
) {
  const scoring = aiStrategicConfig.projection
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const projection = projectOwnerEconomy(state, ownerId, projectionTurns)
  const projectedDomain = projection.state.domains[ownerId]
  const reports = projection.reports
  const starved = reports.filter((report) => !report.food.fed).length
  const unpaid = reports.filter((report) => !report.upkeepPaid).length
  const populationLoss = Math.max(0, domain.population - projectedDomain.population)
  const snapshot = economySnapshotFor(state, ownerId)
  let score = projectedDomain.population * scoring.populationWeight + armyPowerFor(state, ownerId) * scoring.armyPowerWeight
    + Math.min(scoring.resourceCaps.wood, projectedDomain.resources.wood) * scoring.resourceWeights.wood
    + Math.min(scoring.resourceCaps.stone, projectedDomain.resources.stone) * scoring.resourceWeights.stone
    + Math.min(scoring.resourceCaps.gold, projectedDomain.resources.gold) * scoring.resourceWeights.gold
    + Math.min(scoring.resourceCaps.iron, projectedDomain.resources.iron) * (profile.allowedBuildings.includes('smelter')
      ? scoring.industrialIronWeight : scoring.resourceWeights.iron)
    + Math.min(scoring.foodCap, foodResources.reduce((sum, resource) => sum + projectedDomain.resources[resource], 0)) * scoring.foodWeight
    - starved * scoring.starvationPenalty - unpaid * scoring.unpaidUpkeepPenalty - populationLoss * scoring.populationLossPenalty
  const reserveScale = scoring.reserveScale[phase]
  score -= resourceIds.reduce((penalty, resource) => {
    const floor = (profile.strategicReserve[resource] ?? 0) * reserveScale
    return penalty + Math.max(0, floor - projectedDomain.resources[resource]) * scoring.reserveWeights[resource]
  }, 0)
  if (snapshot.housingCapacity - domain.population > scoring.excessiveHousingSlack) {
    score -= (snapshot.housingCapacity - domain.population - scoring.excessiveHousingSlack) * scoring.excessiveHousingPenalty
  }
  if (phase === 'assault') score += snapshot.armyPower * scoring.assaultArmyWeight
  if (phase === 'defense') score += Math.min(snapshot.armyPower, homeThreatFor(state, ownerId).power) * scoring.defenseArmyWeight
  return score
}

export function traceForCandidate(candidate: StrategicCandidate, rejectedReason?: string): AiPlanTraceEntry {
  return { goal: candidate.goal, command: candidate.command, score: candidate.utility, factors: candidate.factors, rejectedReason }
}

export function canAffordStrategicGoal(state: MatchState, command: AiCommand) {
  if (command.type !== 'build') return true
  return canAfford(state.domains[state.activeParticipantId].resources, buildingRules[command.building].resourceCost)
}
