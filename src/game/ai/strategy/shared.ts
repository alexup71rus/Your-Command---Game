import { aiBuildingZoneByKind, aiStrategicConfig } from '../../../config/ai'
import { resourceIds, type ResourceAmount } from '../../../config/rules'
import type { BuildingKind, ResourceId } from '../../map'
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
