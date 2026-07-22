import { aiPlannerConfig, aiStrategicConfig } from '../../../config/ai'
import { buildingRules, resourceIds } from '../../../config/rules'
import type { BuildingKind } from '../../map'
import { ownedBuildingCount, type MatchState } from '../../match'
import type { CellPosition } from '../../scenario'
import { aiObjectEntries } from '../analysis'
import type { AiMemory, AiProfileRules, AiStrategicPhase } from '../model'
import { economicEmergencyFor, economySnapshotFor, hasHuntingTerrainPotential } from './assessment'
import { developmentBonusSlots, developmentHousingBonusSlots, plannedBuildingLimit, settlementZoneKindFor } from './shared'

export function seededSiteRank(seed: number, kind: BuildingKind, position: CellPosition) {
  const value = `${kind}:${position.column}:${position.row}`
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0
  }
  return hash
}

export function seededBuildingGoalVariation(seed: number, ownerId: string, kind: BuildingKind, memory: AiMemory) {
  const value = `${ownerId}:${memory.settlementPlan?.layout ?? 'none'}:${memory.settlementPlan?.opening ?? 'none'}:${kind}`
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0
  }
  return ((hash / 0xffffffff) * 2 - 1) * aiStrategicConfig.buildingGoalVariation
}

export function remainingConstructionNeed(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  resource: (typeof resourceIds)[number],
) {
  return profile.allowedBuildings.reduce((total, kind) => {
    const missing = Math.max(0, plannedBuildingLimit(memory, kind) - ownedBuildingCount(state, state.activeParticipantId, kind))
    return total + missing * (buildingRules[kind].resourceCost[resource] ?? 0)
  }, 0)
}

export function desiredProducerCount(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  producer: 'lumberMill' | 'quarry',
  resource: 'wood' | 'stone',
) {
  const limit = plannedBuildingLimit(memory, producer)
  if (limit <= 0) return 0
  const perTurn = Math.max(1, buildingRules[producer].production[resource] ?? 0)
  const demandPerTurn = remainingConstructionNeed(state, profile, memory, resource) / aiStrategicConfig.constructionPlanningHorizonTurns
  return Math.min(limit, Math.max(1, Math.ceil(demandPerTurn / perTurn)))
}

export function plannedResourceNeed(profile: AiProfileRules, kind: BuildingKind) {
  const cost = buildingRules[kind].resourceCost
  return (
    resourceIds.reduce((sum, resource) => sum + (cost[resource] ?? 0) * aiStrategicConfig.resourcePlanning.needWeights[resource], 0) +
    (profile.allowedBuildings.indexOf(kind) >= 0
      ? aiStrategicConfig.resourcePlanning.allowedBuildingBonus
      : aiStrategicConfig.resourcePlanning.unavailableBuildingPenalty)
  )
}

export function adaptiveBuildingLimitFor(state: MatchState, profile: AiProfileRules, memory: AiMemory, kind: BuildingKind) {
  const base = plannedBuildingLimit(memory, kind)
  const foodFallback =
    (kind === 'orchard' || kind === 'huntingLodge') &&
    memory.stalledTurns >= aiPlannerConfig.relaxBlueprintAfterStalledTurns &&
    economySnapshotFor(state, state.activeParticipantId).foodRunway < aiPlannerConfig.foodRunwayTurns
      ? Math.min(
          aiStrategicConfig.maximumFoodFallbackBuildings,
          Math.floor(memory.stalledTurns / aiPlannerConfig.relaxBlueprintAfterStalledTurns),
        )
      : 0
  // Long-match milestones (and, when reached, stockpile overdrive) open extra
  // economy slots. Defense buildings are excluded: walls/towers/barbicans
  // follow the fortification plan.
  const zoneKind = settlementZoneKindFor(kind)
  const developmentSlots =
    zoneKind === 'defense'
      ? 0
      : kind === 'house'
        ? developmentHousingBonusSlots(state, profile, memory)
        : developmentBonusSlots(state, profile, memory)
  if (kind === 'orchard' && !hasHuntingTerrainPotential(state, state.activeParticipantId)) {
    return base + plannedBuildingLimit(memory, 'huntingLodge') + foodFallback + developmentSlots
  }
  return base + foodFallback + developmentSlots
}

export function settlementZoneHasCapacity(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  kind: BuildingKind,
  phase: AiStrategicPhase,
) {
  const zoneKind = settlementZoneKindFor(kind)
  const zone = memory.settlementPlan?.zones[zoneKind]
  if (!zone) return true
  const occupiedOrigins = aiObjectEntries(state.scenario, state.activeParticipantId).filter(
    (entry) => entry.object.type === 'building' && settlementZoneKindFor(entry.object.kind) === zoneKind,
  ).length
  const ownedKinds = new Set(
    aiObjectEntries(state.scenario, state.activeParticipantId).flatMap((entry) =>
      entry.object.type === 'building' ? [entry.object.kind] : [],
    ),
  )
  const missingCapabilities = aiStrategicConfig.restorableCapabilities.filter(
    (candidate) => settlementZoneKindFor(candidate) === zoneKind && (zone.maxBuildings[candidate] ?? 0) > 0 && !ownedKinds.has(candidate),
  )
  const primaryFortification = memory.settlementPlan?.fortification?.lines[0]
  const addsFortificationPrerequisite =
    kind === 'quarry' &&
    primaryFortification?.kind === 'enclosure' &&
    ownedBuildingCount(state, state.activeParticipantId, 'house') >= aiStrategicConfig.buildingGoals.enclosureMinimumHouses &&
    ownedBuildingCount(state, state.activeParticipantId, 'barracks') > 0 &&
    ownedBuildingCount(state, state.activeParticipantId, 'quarry') < aiStrategicConfig.buildingGoals.enclosureMinimumQuarries
  const addsMissingCapability = missingCapabilities.includes(kind) || addsFortificationPrerequisite
  // The heat map is a soft spatial budget. It controls settlement scale, but a
  // compact or damaged quarter may overflow far enough to restore every
  // missing prerequisite. Per-kind profile limits still bound final growth.
  const emergencyOverflow =
    phase === 'recovery' || phase === 'survival' || economicEmergencyFor(state, state.activeParticipantId) || addsMissingCapability ? 1 : 0
  const stalledOverflow = memory.stalledTurns >= aiPlannerConfig.relaxBlueprintAfterStalledTurns ? 1 : 0
  const capabilityOverflow = addsMissingCapability ? missingCapabilities.length + Number(addsFortificationPrerequisite) : 0
  // Development milestones raise the origin budget for economy zones (never
  // defense) so a mature domain can expand beyond its opening blueprint.
  const economySlots = developmentBonusSlots(state, profile, memory)
  const maturityOriginSlots =
    zoneKind === 'housing'
      ? developmentHousingBonusSlots(state, profile, memory)
      : zoneKind === 'food'
        ? economySlots * 3
        : zoneKind === 'industry'
          ? economySlots * 2
          : zoneKind === 'military'
            ? economySlots
            : 0
  const profileTargetOverflow = Math.max(0, profile.settlement.zoneOriginTargets[zoneKind] - zone.maxOrigins)
  const baseOriginBudget = zone.maxOrigins + profileTargetOverflow
  // Maturity is growth beyond the opening settlement, so it must be additive.
  // Taking max(profile target, milestone) silently replaced part of the base
  // quarter and capped a late Svyatobor housing zone at sixteen origins.
  return occupiedOrigins < baseOriginBudget + maturityOriginSlots + Math.max(emergencyOverflow, stalledOverflow, capabilityOverflow)
}
