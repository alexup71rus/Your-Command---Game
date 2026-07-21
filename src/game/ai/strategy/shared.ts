import { aiBuildingZoneByKind, aiStrategicConfig } from '../../../config/ai'
import { resourceIds, type ResourceAmount } from '../../../config/rules'
import type { BuildingKind, ResourceId } from '../../map'
import type { MatchState } from '../../match'
import type { CellPosition } from '../../scenario'
import { samePosition } from '../analysis'
import type { AiMemory, AiProfileRules, AiSettlementZoneKind } from '../model'

export const isTemporarilyBlocked = (
  memory: AiMemory | undefined,
  position: CellPosition,
  turn: number,
) => memory?.blockedCells.some((entry) => (
  entry.expiresTurn >= turn && samePosition(entry.position, position)
)) ?? false

export function canAfford(resources: Record<ResourceId, number>, cost: ResourceAmount) {
  return resourceIds.every((resource) => resources[resource] >= (cost[resource] ?? 0))
}

export function settlementZoneKindFor(kind: BuildingKind): AiSettlementZoneKind {
  return aiBuildingZoneByKind[kind]
}

export function plannedBuildingLimit(memory: AiMemory, kind: BuildingKind) {
  return memory.settlementPlan?.zones[settlementZoneKindFor(kind)].maxBuildings[kind] ?? 1
}

/**
 * A position that belongs to the settlement plan's fortification blueprint
 * (the barbican gate, any planned wall/tower cell on any line, or the remote
 * outpost tower) must never be demolished by overflow/liquidation logic. Such
 * a demolition would oscillate against `nextFortificationStep`, which rebuilds
 * the same cell on the next planning pass — the visible symptom is "the AI
 * builds a wall and immediately deletes it".
 */
export function isPlannedFortification(memory: AiMemory | undefined, position: CellPosition) {
  const plan = memory?.settlementPlan
  if (!plan) return false
  if (plan.fortification) {
    for (const line of plan.fortification.lines) {
      if (samePosition(line.gate, position)) return true
      if (line.walls.some((cell) => samePosition(cell, position))) return true
      if (line.towers.some((cell) => samePosition(cell, position))) return true
    }
  }
  const outpost = plan.reservedSites.outpostTower
  return Boolean(outpost && samePosition(outpost, position))
}

export function minimumFieldArmySize(profile: AiProfileRules) {
  return Math.max(
    aiStrategicConfig.minimumFieldArmySize,
    Math.ceil(profile.doctrine.forceTargets.probe.minimum),
  )
}

export function forceTargetFor(
  profile: AiProfileRules,
  kind: keyof AiProfileRules['doctrine']['forceTargets'],
  knownEnemyPower: number,
  enemyPowerMultiplier: number,
) {
  const band = profile.doctrine.forceTargets[kind]
  return Math.min(band.maximum, Math.max(band.preferred, knownEnemyPower * enemyPowerMultiplier))
}

/**
 * Returns how many "extra development slots" a fully-settled domain has earned
 * by being resource-rich. For each resource we compute "stockpile divided by a
 * typical building cost", then take the minimum across resources — the tier is
 * bounded by whichever resource is scarcest, so a domain sitting on 9× wood but
 * 1× stone is not overdrive-tier 3. The tier then maps to a number of bonus
 * building slots via `overdrive.bonusSlotsPerTier`.
 *
 * Deliberately economy-only: it never raises army targets, so it cannot feed
 * the "endless reinforcement wave" symptom. Defense buildings are excluded at
 * the call sites (they follow the fortification plan, not this budget).
 */
export function overdriveTier(state: MatchState, memory: AiMemory | undefined) {
  const config = aiStrategicConfig.overdrive
  if (memory && memory.stableTurns < config.minStableTurns) return 0
  const ownerId = state.activeParticipantId
  const resources = state.domains[ownerId]?.resources
  if (!resources) return 0
  // Bounded by the scarcest resource: how many "reference buildings" worth of
  // that resource the domain could still afford right now.
  const reference = config.costReference
  const ratio = resourceIds.reduce((min, resource) => {
    const cost = reference[resource] ?? 1
    return Math.min(min, resources[resource] / cost)
  }, Number.POSITIVE_INFINITY)
  let tier = 0
  for (let index = 0; index < config.thresholds.length; index += 1) {
    if (ratio >= config.thresholds[index]) tier = index + 1
    else break
  }
  return tier
}

export function overdriveBonusSlots(state: MatchState, memory: AiMemory | undefined) {
  const tier = overdriveTier(state, memory)
  if (tier <= 0) return 0
  return aiStrategicConfig.overdrive.bonusSlotsPerTier[tier - 1] ?? 0
}
