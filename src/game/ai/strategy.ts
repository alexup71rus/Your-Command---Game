import {
  aiBuildingKindsByZone,
  aiBuildingZoneByKind,
  aiPlannerConfig,
  aiStrategicConfig,
  aiTacticalConfig,
} from '../../config/ai'
import { buildingRules, marketPrices, resourceIds, troopRules, type ResourceAmount, type TaxRate } from '../../config/rules'
import { gameConfig } from '../../config/game'
import type { BuildingKind, BuildingObject, ResourceId, SquadObject, TroopComposition, TroopKind } from '../map'
import {
  buildingFootprintPositions,
  buildingPlacementFailure,
  buildingResourceCostFor,
  civilianHousingCapacityFor,
  civilianPopulationCapacityFor,
  demolish,
  foodServiceCapacityFor,
  foodDemandFor,
  objectAt,
  ownedBuildingCount,
  projectOwnerEconomy,
  productionFor,
  recruit,
  recruitmentFailure,
  squadHealth,
  squadSize,
  totalArmySize,
  trade,
  tradeQuoteFor,
  troopTotals,
  turnEconomyForecastFor,
  workforceFor,
  type MatchState,
} from '../match'
import type { CellPosition } from '../scenario'
import { findMovementPath } from '../pathfinding'
import { clockwiseCardinalDirections } from '../geometry'
import {
  aiObjectEntries,
  castlePositionFor,
  footprintOpportunityCost,
  positionDistance,
  positionKey,
  samePosition,
  type AiWorldAnalysis,
} from './analysis'
import type {
  AiCommand,
  AiMemory,
  AiPlanTraceEntry,
  AiProfileRules,
  AiSettlementZoneKind,
  AiStrategicPhase,
} from './model'

export interface StrategicCandidate {
  command: AiCommand
  utility: number
  goal: AiStrategicPhase | 'trade' | 'tax'
  factors: string[]
}

interface BuildingGoal {
  kind: BuildingKind
  utility: number
  factors: string[]
}

export interface AiEconomySnapshot {
  foodStock: number
  foodDemand: number
  foodRunway: number
  goldRunway: number
  workforceFree: number
  housingCapacity: number
  residentialCapacity: number
  foodServiceCapacity: number
  armySize: number
  armyPower: number
  forecastFed: boolean
  upkeepPaid: boolean
  resourceFlow: Record<ResourceId, number>
}

const foodResources = gameConfig.economy.foodResources

const isTemporarilyBlocked = (memory: AiMemory | undefined, position: CellPosition, turn: number) => memory?.blockedCells.some((entry) => (
  entry.expiresTurn >= turn && samePosition(entry.position, position)
)) ?? false

export function troopCompositionPower(units: TroopComposition, health?: number) {
  const power = aiStrategicConfig.power
  const maximumHealth = (Object.keys(units) as TroopKind[]).reduce((sum, troop) => sum + units[troop] * troopRules[troop].durability, 0)
  const healthShare = maximumHealth > 0 ? Math.max(0, Math.min(1, (health ?? maximumHealth) / maximumHealth)) : 0
  const base = (Object.keys(units) as TroopKind[]).reduce((sum, troop) => {
    const count = units[troop]
    const rangeValue = troop === 'archers' ? power.archerRangeBonus : 0
    const mobilityPenalty = troop === 'knights' ? power.knightMobilityPenalty : 0
    return sum + count * (troopRules[troop].damage * power.troopDamageWeight + troopRules[troop].durability + rangeValue - mobilityPenalty)
  }, 0)
  return base * (power.minimumHealthShare + healthShare * power.remainingHealthShare)
}

export function armyPowerFor(state: MatchState, ownerId: string) {
  return aiObjectEntries(state.scenario, ownerId).reduce((sum, entry) => {
    if (entry.object.type === 'squad') return sum + troopCompositionPower(entry.object.units, squadHealth(entry.object))
    if (entry.object.type === 'building' && entry.object.kind === 'tower' && entry.object.garrison) {
      return sum + troopCompositionPower({ militia: 0, spearmen: 0, archers: entry.object.garrison.archers, knights: 0 }, entry.object.garrison.health) * aiStrategicConfig.power.towerGarrisonMultiplier
    }
    return sum
  }, 0)
}

export function economySnapshotFor(state: MatchState, ownerId: string): AiEconomySnapshot {
  const domain = state.domains[ownerId]
  const forecast = turnEconomyForecastFor(state, ownerId)
  const workforce = workforceFor(state, ownerId)
  const foodStock = foodResources.reduce((sum, resource) => sum + domain.resources[resource], 0)
  const foodDemand = Math.max(1, forecast?.foodDemand ?? domain.population + totalArmySize(state, ownerId))
  const foodAfter = forecast ? foodResources.reduce((sum, resource) => sum + forecast.resources[resource], 0) : foodStock
  const foodFlow = foodAfter - foodStock
  const goldFlow = (forecast?.resources.gold ?? domain.resources.gold) - domain.resources.gold
  const resourceFlow = Object.fromEntries(resourceIds.map((resource) => [resource, (forecast?.resources[resource] ?? domain.resources[resource]) - domain.resources[resource]])) as Record<ResourceId, number>
  const upkeepGold = forecast?.upkeep.gold ?? 0
  return {
    foodStock,
    foodDemand,
    foodRunway: foodFlow < 0 ? foodStock / Math.max(1, -foodFlow) : foodStock / foodDemand + aiPlannerConfig.projectionTurns,
    goldRunway: goldFlow < 0
      ? domain.resources.gold / Math.max(aiStrategicConfig.minimumRunwayFlowMagnitude, -goldFlow)
      : upkeepGold > 0 ? domain.resources.gold / upkeepGold + aiPlannerConfig.projectionTurns : Number.POSITIVE_INFINITY,
    workforceFree: workforce.free,
    housingCapacity: civilianPopulationCapacityFor(state, ownerId),
    residentialCapacity: civilianHousingCapacityFor(state, ownerId),
    foodServiceCapacity: foodServiceCapacityFor(state, ownerId, workforce),
    armySize: totalArmySize(state, ownerId),
    armyPower: armyPowerFor(state, ownerId),
    forecastFed: forecast?.food.fed ?? false,
    upkeepPaid: forecast?.upkeepPaid ?? true,
    resourceFlow,
  }
}

function populationGrowthSupplyFor(state: MatchState, ownerId: string) {
  const domain = state.domains[ownerId]
  const foodProduction = foodResources.reduce((sum, resource) => sum + productionFor(state, ownerId)[resource], 0)
  const growthPopulation = domain.population + Math.min(
    aiStrategicConfig.populationGrowthLookahead,
    buildingRules.house.housingCapacity ?? 1,
  )
  const growthState: MatchState = {
    ...state,
    domains: { ...state.domains, [ownerId]: { ...domain, population: growthPopulation } },
  }
  const growthFoodDemand = foodDemandFor(growthState, ownerId)
  return { foodProduction, growthFoodDemand, sustainable: foodProduction >= growthFoodDemand }
}

function economicEmergencyFor(state: MatchState, ownerId: string) {
  const snapshot = economySnapshotFor(state, ownerId)
  return !snapshot.forecastFed || !snapshot.upkeepPaid
    || snapshot.foodRunway < aiPlannerConfig.emergencyRunwayTurns
    || snapshot.goldRunway < aiPlannerConfig.emergencyRunwayTurns
}

function visibleEnemySquads(state: MatchState, ownerId: string) {
  return aiObjectEntries(state.scenario).filter((entry): entry is typeof entry & { object: SquadObject } => entry.object.type === 'squad' && entry.object.ownerId !== ownerId)
}

function hasForestIndustryPotential(state: MatchState, ownerId: string) {
  const regionId = state.scenario.participants.find((participant) => participant.id === ownerId)?.regionId
  if (!regionId) return false
  return state.scenario.cells.some((row, rowIndex) => row.some((cell, column) => cell.landform !== 'peak'
    && !cell.vegetation
    && state.scenario.territories[rowIndex]?.[column] === regionId
    && clockwiseCardinalDirections.reduce((sum, direction) => (
      sum + Number(Boolean(state.scenario.cells[rowIndex + direction.row]?.[column + direction.column]?.vegetation))
    ), 0) >= (buildingRules.lumberMill.minimumAdjacentForestCells ?? 0)))
}

function hasHuntingTerrainPotential(state: MatchState, ownerId: string) {
  const regionId = state.scenario.participants.find((participant) => participant.id === ownerId)?.regionId
  if (!regionId) return false
  return state.scenario.cells.some((row, rowIndex) => row.some((cell, column) => cell.landform !== 'peak'
    && !cell.vegetation
    && state.scenario.territories[rowIndex]?.[column] === regionId
    && clockwiseCardinalDirections.reduce((sum, direction) => (
      sum + Number(Boolean(state.scenario.cells[rowIndex + direction.row]?.[column + direction.column]?.vegetation))
    ), 0) >= (buildingRules.huntingLodge.minimumAdjacentForestCells ?? 0)))
}

function rememberedSquadThreats(state: MatchState, memory: AiMemory | undefined, ownerId?: string) {
  return (memory?.contacts ?? []).flatMap((contact) => {
    if (contact.kind !== 'squad' || !contact.units || (ownerId && contact.ownerId !== ownerId)) return []
    const visible = objectAt(state, contact.position)
    if (visible?.type === 'squad' && visible.ownerId === contact.ownerId) return []
    const age = state.turn - contact.lastSeenTurn
    if (age < 0 || age > aiPlannerConfig.targetMemoryTurns) return []
    const minimumConfidence = aiStrategicConfig.targetSelection.minimumMemoryConfidence
    const confidence = minimumConfidence + (1 - minimumConfidence) * (1 - age / Math.max(1, aiPlannerConfig.targetMemoryTurns))
    return [{ ...contact, power: troopCompositionPower(contact.units, contact.health) * confidence }]
  })
}

export function homeThreatFor(state: MatchState, ownerId: string, memory?: AiMemory) {
  const castle = castlePositionFor(state.scenario, ownerId)
  const participant = state.scenario.participants.find((candidate) => candidate.id === ownerId)
  if (!castle || !participant) return { threatened: false, power: 0, nearest: Number.POSITIVE_INFINITY }
  const visibleThreats = visibleEnemySquads(state, ownerId).map((entry) => ({
    distance: positionDistance(entry.position, castle),
    inside: state.scenario.territories[entry.position.row]?.[entry.position.column] === participant.regionId,
    power: troopCompositionPower(entry.object.units, squadHealth(entry.object)),
  }))
  const rememberedThreats = rememberedSquadThreats(state, memory).map((contact) => ({
    distance: positionDistance(contact.position, castle),
    inside: state.scenario.territories[contact.position.row]?.[contact.position.column] === participant.regionId,
    power: contact.power,
  }))
  const threats = [...visibleThreats, ...rememberedThreats]
  const threatConfig = aiStrategicConfig.threat
  return {
    threatened: threats.some((threat) => threat.inside
      || threat.distance <= threatConfig.immediateRadius
      || Math.ceil(threat.distance / threatConfig.assumedOrdersPerTurn) <= threatConfig.maximumArrivalTurns),
    power: threats.filter((threat) => threat.inside || threat.distance <= threatConfig.evaluationRadius)
      .reduce((sum, threat) => sum + threat.power, 0),
    nearest: Math.min(...threats.map((threat) => threat.distance), Number.POSITIVE_INFINITY),
  }
}

export function stagingAnchorsFor(state: MatchState, ownerId: string, memory: AiMemory) {
  const participant = state.scenario.participants.find((candidate) => candidate.id === ownerId)
  const castle = castlePositionFor(state.scenario, ownerId)
  if (!participant || !castle) return []
  const plan = memory.settlementPlan
  const sources = aiObjectEntries(state.scenario, ownerId)
    .flatMap((entry) => entry.object.type === 'squad' ? [entry.position] : [])
  if (sources.length === 0) sources.push(castle)
  const usable = (position: CellPosition) => {
    const cell = state.scenario.cells[position.row]?.[position.column]
    const stagingOccupant = !cell?.object || (cell.object.type === 'squad' && cell.object.ownerId === ownerId)
    return Boolean(cell && cell.landform !== 'peak'
      && state.scenario.territories[position.row]?.[position.column] === participant.regionId
      && stagingOccupant
      && !isTemporarilyBlocked(memory, position, state.turn))
  }
  const reachable = (position: CellPosition) => sources.some((source) => (
    samePosition(source, position) || Boolean(findMovementPath(state.scenario.cells, source, position, { ownerId }))
  ))
  const result: CellPosition[] = []
  const add = (position: CellPosition | undefined) => {
    if (!position || !usable(position) || !reachable(position)) return
    if (result.some((candidate) => positionDistance(candidate, position) < aiTacticalConfig.staging.minimumAnchorSpacing)) return
    result.push(position)
  }

  const corridor = (plan?.reservedCorridors ?? [])
    .filter((position) => state.scenario.territories[position.row]?.[position.column] === participant.regionId)
  const frontStart = Math.max(0, Math.floor(corridor.length * aiTacticalConfig.staging.corridorFrontShare))
  corridor.slice(frontStart).reverse().forEach((position) => {
    if (result.length < aiTacticalConfig.staging.maximumCorridorAnchors) add(position)
  })

  const front = plan?.front ?? castle
  const fallbackCenter = plan?.reservedSites.military ?? corridor[Math.max(0, corridor.length - 1)] ?? castle
  const fallback = state.scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
    const position = { column, row: rowIndex }
    if (!usable(position)) return []
    const centerDistance = positionDistance(position, fallbackCenter)
    if (centerDistance > aiTacticalConfig.staging.fallbackRadius) return []
    return [{
      position,
      score: positionDistance(position, front) * aiTacticalConfig.staging.fallbackFrontDistanceWeight + centerDistance,
    }]
  })).sort((first, second) => first.score - second.score
    || first.position.row - second.position.row || first.position.column - second.position.column)
  fallback.forEach(({ position }) => {
    if (result.length < aiTacticalConfig.staging.maximumAnchors) add(position)
  })
  return result
}

export function strategicPhaseFor(state: MatchState, profile: AiProfileRules, memory: AiMemory) {
  const ownerId = state.activeParticipantId
  const snapshot = economySnapshotFor(state, ownerId)
  const threat = homeThreatFor(state, ownerId, memory)
  if (threat.threatened) return 'defense' as const
  if (!snapshot.forecastFed || !snapshot.upkeepPaid
    || snapshot.foodRunway < aiPlannerConfig.emergencyRunwayTurns
    || snapshot.goldRunway < aiPlannerConfig.emergencyRunwayTurns) return 'recovery' as const
  const hasOperationalFoodProducer = workforceFor(state, ownerId).assignments.some((assignment) => (
    aiStrategicConfig.operationalFoodBuildings.includes(assignment.kind)
      && !assignment.blockedReason
      && assignment.assigned > 0
  ))
  const needsLumberIndustry = hasForestIndustryPotential(state, ownerId) && ownedBuildingCount(state, ownerId, 'lumberMill') === 0
  if (!hasOperationalFoodProducer || needsLumberIndustry || snapshot.foodRunway < aiPlannerConfig.foodRunwayTurns) return 'survival' as const
  if ((memory.phase === 'recovery' || memory.phase === 'survival') && memory.stableTurns < aiPlannerConfig.stableRecoveryTurns) return 'survival' as const
  const targetPower = estimatedTargetPower(state, memory.targetOwnerId, memory)
  const canCross = state.turn >= profile.earliestOffensiveRound || threat.threatened
  const economyReady = snapshot.foodRunway >= aiPlannerConfig.assaultFoodRunwayTurns && snapshot.goldRunway >= aiPlannerConfig.goldRunwayTurns
  const troops = troopTotals(state, ownerId)
  const hasBarracks = ownedBuildingCount(state, ownerId, 'barracks') > 0
  const advancedTroops = profile.allowedTroops.filter((troop) => troop !== 'militia')
  const advancedTotal = advancedTroops.reduce((sum, troop) => sum + troops[troop], 0)
  const hasViableFallbackArmy = snapshot.armySize >= minimumFieldArmySize(profile)
  const usesProfileArsenal = advancedTroops.length === 0
    ? hasViableFallbackArmy
    : hasBarracks && (
        advancedTotal >= aiStrategicConfig.minimumAdvancedTroopsForPreferredArmy
        || hasViableFallbackArmy
      )
  const readinessThreshold = targetPower * profile.riskThreshold * (1 - aiPlannerConfig.readinessEstimateTolerance)
  const offensiveWave = memory.wave === 'main' || memory.wave === 'probe' || memory.wave === 'support' || memory.wave === 'siege'
  const regroupThreshold = Math.max(aiStrategicConfig.phase.regroupMinimumPower,
    targetPower * profile.riskThreshold * aiStrategicConfig.phase.regroupTargetRatio)
  if (offensiveWave && snapshot.armyPower < regroupThreshold) return 'regroup' as const
  const campaignReady = snapshot.foodRunway >= aiPlannerConfig.foodRunwayTurns
    && snapshot.goldRunway >= aiStrategicConfig.phase.campaignGoldRunway
  if (canCross && offensiveWave && campaignReady && usesProfileArsenal) return 'assault' as const
  const profileProbeThreshold = targetPower * profile.doctrine.probeRiskThreshold * (1 - aiPlannerConfig.readinessEstimateTolerance)
  // A reconnaissance force must be viable, but it does not need to match every
  // defender that may be protecting the eventual target. Tactical movement and
  // retreat rules keep it from treating this permission as a mandatory battle.
  const probeThreshold = profile.doctrine.maneuverBias < aiStrategicConfig.phase.directDoctrineManeuverCutoff
    ? Math.max(profile.doctrine.minimumProbePower, readinessThreshold)
    : Math.min(aiStrategicConfig.phase.agileProbePowerCap, Math.max(profile.doctrine.minimumProbePower, profileProbeThreshold))
  const launchEconomyReady = snapshot.armyPower >= readinessThreshold ? economyReady : campaignReady
  const stalledProbeReady = memory.idleTurns >= aiPlannerConfig.stalledMobilizationProbeTurns
    && snapshot.armyPower >= profile.doctrine.minimumProbePower
  // A healthy army must not wait forever for an ideal force ratio or assembly.
  // After several genuinely idle mobilization turns it may scout toward the
  // objective. Tactical scoring still rejects bad exchanges, so this relaxes
  // reconnaissance rather than authorizing a suicidal attack.
  if (canCross && campaignReady && stalledProbeReady) return 'assault' as const
  const stagingAnchors = stagingAnchorsFor(state, ownerId, memory)
  const squads = aiObjectEntries(state.scenario, ownerId).filter((entry) => entry.object.type === 'squad')
  const assembledPower = stagingAnchors.length ? squads.reduce((sum, entry) => stagingAnchors.some((anchor) => (
    positionDistance(entry.position, anchor) <= aiTacticalConfig.staging.assembledRadius
  ))
    ? sum + troopCompositionPower(entry.object.type === 'squad' ? entry.object.units : { militia: 0, spearmen: 0, archers: 0, knights: 0 }, entry.object.type === 'squad' ? squadHealth(entry.object) : undefined)
    : sum, 0) : snapshot.armyPower
  const fieldPower = Math.max(0.1, snapshot.armyPower * (1 - profile.doctrine.reserveShare))
  const assemblyThreshold = aiStrategicConfig.phase.assemblyBaseShare
    - profile.doctrine.maneuverBias * aiStrategicConfig.phase.assemblyManeuverDiscount
  const assemblyReady = snapshot.armyPower > 0 && assembledPower / fieldPower >= assemblyThreshold
  if (canCross && launchEconomyReady && usesProfileArsenal && assemblyReady
    && snapshot.armyPower >= probeThreshold) return 'assault' as const
  const housingSlack = snapshot.housingCapacity - state.domains[ownerId].population
  const canBuildHouse = ownedBuildingCount(state, ownerId, 'house') < plannedBuildingLimit(memory, 'house')
    && snapshot.residentialCapacity <= snapshot.foodServiceCapacity
  const canBuildKitchen = ownedBuildingCount(state, ownerId, 'kitchen') < plannedBuildingLimit(memory, 'kitchen')
    && snapshot.foodServiceCapacity <= snapshot.residentialCapacity
  const canExpandHousing = canBuildHouse || canBuildKitchen
  const canSustainExpansion = populationGrowthSupplyFor(state, ownerId).sustainable
  // Reaching the size prescribed by the settlement plan is a valid end state,
  // not a reason to remain in expansion forever. A profile with a compact heat
  // map must be able to mobilize at its own sustainable population ceiling.
  if ((housingSlack <= 1 && canExpandHousing && canSustainExpansion)
    || (snapshot.workforceFree < 1 && snapshot.armySize === 0)) return 'expansion' as const
  return snapshot.armySize > 0 ? 'mobilization' as const : 'expansion' as const
}

export function estimatedTargetPower(state: MatchState, ownerId: string | null, memory?: AiMemory) {
  const config = aiStrategicConfig.targetPower
  if (!ownerId) return config.minimum
  let power = armyPowerFor(state, ownerId)
  aiObjectEntries(state.scenario, ownerId).forEach((entry) => {
    if (entry.object.type === 'castle') power += config.castleBase + entry.object.hitPoints * config.castleHealthWeight
    if (entry.object.type === 'building') {
      if (entry.object.kind === 'wall') power += config.wall
      if (entry.object.kind === 'barbican') power += config.barbican
      if (entry.object.kind === 'tower') power += config.towerBase + (entry.object.garrison?.archers ?? 0) * config.towerGarrisonArcher
    }
  })
  power += rememberedSquadThreats(state, memory, ownerId).reduce((sum, contact) => sum + contact.power, 0)
  return Math.max(config.minimum, power)
}

function targetScore(state: MatchState, ownerId: string, targetId: string, memory: AiMemory) {
  const scoring = aiStrategicConfig.targetSelection
  const ownCastle = castlePositionFor(state.scenario, ownerId)
  const targetCastle = castlePositionFor(state.scenario, targetId)
  if (!ownCastle || !targetCastle) return Number.NEGATIVE_INFINITY
  const castleObject = objectAt(state, targetCastle)
  const damage = castleObject?.type === 'castle' ? castleObject.maxHitPoints - castleObject.hitPoints : 0
  const recentContacts = memory.contacts.filter((contact) => contact.ownerId === targetId && state.turn - contact.lastSeenTurn <= aiPlannerConfig.targetMemoryTurns)
  const retaliatoryThreat = recentContacts.reduce((sum, contact) => (
    sum + Math.max(0, scoring.retaliationWindow - (state.turn - contact.lastSeenTurn))
  ), 0)
  return -positionDistance(ownCastle, targetCastle) * scoring.distanceWeight
    - estimatedTargetPower(state, targetId, memory) * scoring.defensePowerWeight
    + damage * scoring.castleDamageWeight + retaliatoryThreat
}

export function chooseTargetOwner(state: MatchState, profile: AiProfileRules, memory: AiMemory) {
  const ownerId = state.activeParticipantId
  const candidates = state.scenario.participants
    .filter((participant) => participant.id !== ownerId && castlePositionFor(state.scenario, participant.id))
    .map((participant) => ({ id: participant.id, score: targetScore(state, ownerId, participant.id, memory) }))
    .sort((first, second) => second.score - first.score || first.id.localeCompare(second.id))
  const best = candidates[0]
  const current = candidates.find((candidate) => candidate.id === memory.targetOwnerId)
  if (!best) return null
  if (current && memory.idleTurns >= aiPlannerConfig.retargetAfterIdleTurns) {
    return candidates.find((candidate) => candidate.id !== current.id)?.id ?? current.id
  }
  if (current && best.id !== current.id && best.score < current.score * (1 + aiPlannerConfig.targetChangeMargin)
    + profile.doctrine.targetStickiness * aiStrategicConfig.targetSelection.stickinessScale) return current.id
  return best.id
}

function canAfford(resources: Record<ResourceId, number>, cost: ResourceAmount) {
  return resourceIds.every((resource) => resources[resource] >= (cost[resource] ?? 0))
}

function plannedResourceNeed(profile: AiProfileRules, kind: BuildingKind) {
  const cost = buildingRules[kind].resourceCost
  return resourceIds.reduce((sum, resource) => (
    sum + (cost[resource] ?? 0) * aiStrategicConfig.resourcePlanning.needWeights[resource]
  ), 0) + (profile.allowedBuildings.indexOf(kind) >= 0
    ? aiStrategicConfig.resourcePlanning.allowedBuildingBonus
    : aiStrategicConfig.resourcePlanning.unavailableBuildingPenalty)
}

function settlementZoneKindFor(kind: BuildingKind): AiSettlementZoneKind {
  return aiBuildingZoneByKind[kind]
}

function plannedBuildingLimit(memory: AiMemory, kind: BuildingKind) {
  return memory.settlementPlan?.zones[settlementZoneKindFor(kind)].maxBuildings[kind] ?? 1
}

function adaptiveBuildingLimitFor(state: MatchState, memory: AiMemory, kind: BuildingKind) {
  const base = plannedBuildingLimit(memory, kind)
  const foodFallback = (kind === 'orchard' || kind === 'huntingLodge')
    && memory.stalledTurns >= aiPlannerConfig.relaxBlueprintAfterStalledTurns
    && economySnapshotFor(state, state.activeParticipantId).foodRunway < aiPlannerConfig.foodRunwayTurns
      ? Math.min(aiStrategicConfig.maximumFoodFallbackBuildings,
          Math.floor(memory.stalledTurns / aiPlannerConfig.relaxBlueprintAfterStalledTurns))
      : 0
  if (kind === 'orchard' && !hasHuntingTerrainPotential(state, state.activeParticipantId)) {
    return base + plannedBuildingLimit(memory, 'huntingLodge') + foodFallback
  }
  return base + foodFallback
}

function settlementZoneHasCapacity(state: MatchState, memory: AiMemory, kind: BuildingKind, phase: AiStrategicPhase) {
  const zoneKind = settlementZoneKindFor(kind)
  const zone = memory.settlementPlan?.zones[zoneKind]
  if (!zone) return true
  const occupiedOrigins = aiObjectEntries(state.scenario, state.activeParticipantId)
    .filter((entry) => entry.object.type === 'building' && settlementZoneKindFor(entry.object.kind) === zoneKind)
    .length
  const ownedKinds = new Set(aiObjectEntries(state.scenario, state.activeParticipantId)
    .flatMap((entry) => entry.object.type === 'building' ? [entry.object.kind] : []))
  const missingCapabilities = aiStrategicConfig.restorableCapabilities.filter((candidate) => (
    settlementZoneKindFor(candidate) === zoneKind
    && (zone.maxBuildings[candidate] ?? 0) > 0
    && !ownedKinds.has(candidate)
  ))
  const addsMissingCapability = missingCapabilities.includes(kind)
  // The heat map is a soft spatial budget. It controls settlement scale, but a
  // compact or damaged quarter may overflow far enough to restore every
  // missing prerequisite. Per-kind profile limits still bound final growth.
  const emergencyOverflow = phase === 'recovery' || phase === 'survival'
    || economicEmergencyFor(state, state.activeParticipantId) || addsMissingCapability ? 1 : 0
  const stalledOverflow = memory.stalledTurns >= aiPlannerConfig.relaxBlueprintAfterStalledTurns ? 1 : 0
  const capabilityOverflow = addsMissingCapability ? missingCapabilities.length : 0
  return occupiedOrigins < zone.maxOrigins + Math.max(emergencyOverflow, stalledOverflow, capabilityOverflow)
}

function openingBuildingBonus(memory: AiMemory, kind: BuildingKind) {
  const opening = memory.settlementPlan?.opening
  if (!opening) return 0
  const bonuses: Partial<Record<BuildingKind, number>> = aiStrategicConfig.openingBuildingBonus[opening]
  return bonuses[kind] ?? 0
}

function minimumFieldArmySize(profile: AiProfileRules) {
  // Composition values are target shares, not absolute unit counts. The force
  // floor comes from the doctrine's minimum viable probe and remains adaptive:
  // recruitment itself is still bounded by available civilians and the live
  // economy forecast.
  return Math.max(aiStrategicConfig.minimumFieldArmySize, Math.ceil(profile.doctrine.minimumProbePower))
}

function desiredBuildingGoals(
  state: MatchState,
  profile: AiProfileRules,
  analysis: AiWorldAnalysis,
  memory: AiMemory,
  phase: AiStrategicPhase,
  countNode: () => boolean = () => true,
) {
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const snapshot = economySnapshotFor(state, ownerId)
  const economicEmergency = economicEmergencyFor(state, ownerId)
  const goalConfig = aiStrategicConfig.buildingGoals
  const usesIndustry = profile.allowedBuildings.includes('mine') && profile.allowedBuildings.includes('smelter')
  const usesFortifications = profile.allowedBuildings.includes('wall') || profile.allowedBuildings.includes('barbican')
  const usesTowers = profile.allowedBuildings.includes('tower')
  const goals: BuildingGoal[] = []
  const count = (kind: BuildingKind) => ownedBuildingCount(state, ownerId, kind)
  const huntingTerrainAvailable = analysis.cells.some((row) => row.some((cell) => cell.inRegion && cell.passable
    && cell.adjacentForest >= (buildingRules.huntingLodge.minimumAdjacentForestCells ?? 0)))
  // A profile's food-quarter size is a total spatial budget, not a mandate to
  // starve when one intended food source is absent from the map.
  const adaptiveLimit = (kind: BuildingKind) => adaptiveBuildingLimitFor(state, memory, kind)
  const add = (kind: BuildingKind, utility: number, ...factors: string[]) => {
    const requiredWorkers = buildingRules[kind].workersRequired ?? 0
    const essentialInCrisis = (phase === 'survival' || phase === 'recovery' || economicEmergency)
      && aiStrategicConfig.crisisProductionBuildings.includes(kind)
    // Requiring two *additional* idle workers from every expansion building can
    // deadlock a compact settlement: its last free worker is exactly what must
    // start the food/service building that allows the next citizens to appear.
    const enablesPopulationGrowth = (aiBuildingZoneByKind[kind] === 'food' || kind === 'kitchen')
      && snapshot.workforceFree >= requiredWorkers
      && snapshot.housingCapacity > domain.population
    const keepsWorkerReserve = requiredWorkers === 0 || snapshot.workforceFree >= requiredWorkers + aiStrategicConfig.workerReserve
      || essentialInCrisis || enablesPopulationGrowth
    if (profile.allowedBuildings.includes(kind)
      && count(kind) < adaptiveLimit(kind)
      && settlementZoneHasCapacity(state, memory, kind, phase)
      && keepsWorkerReserve) goals.push({ kind, utility: utility + openingBuildingBonus(memory, kind), factors })
  }
  // Resource flow is production minus this turn's consumption. Treating that
  // net value as production made a sustainable settlement at its housing cap
  // look under-supplied, so it refused both the next house and the food needed
  // for growth. Use the authoritative gross production calculation instead.
  const { foodProduction, growthFoodDemand, sustainable: sustainablyFeedsGrowth } = populationGrowthSupplyFor(state, ownerId)
  const expectsGrowth = snapshot.housingCapacity > domain.population + 1 && snapshot.foodServiceCapacity > domain.population + 1
  const wantsFood = !snapshot.forecastFed || snapshot.foodRunway < aiPlannerConfig.foodRunwayTurns
    || (!sustainablyFeedsGrowth && (expectsGrowth || snapshot.housingCapacity <= domain.population + 1))

  if (wantsFood) {
    const foodScale = Math.max(0, snapshot.foodDemand - foodProduction)
    if (count('huntingLodge') < adaptiveLimit('huntingLodge') && (count('huntingLodge') === 0 || foodProduction < growthFoodDemand)) add('huntingLodge', goalConfig.utility.huntingLodge + foodScale, 'food-runway', 'forest-edge')
    if (count('orchard') < adaptiveLimit('orchard') && (count('orchard') === 0 || foodProduction < growthFoodDemand)) add('orchard', goalConfig.utility.orchard + foodScale, 'food-runway', huntingTerrainAvailable ? 'compact-food' : 'substitute-missing-hunt')
    if (profile.allowedBuildings.includes('farm')) {
      if (count('mill') === 0) add('mill', goalConfig.utility.mill + foodScale, 'farm-chain')
      else if (count('farm') < count('mill') * (buildingRules.mill.farmSupport?.capacity ?? 0)
        && foodProduction < Math.max(snapshot.foodDemand * goalConfig.farmDemandMultiplier, growthFoodDemand)) {
        add('farm', goalConfig.utility.farm + foodScale, 'supported-farm')
      }
    }
  }
  const hasLumberPotential = analysis.cells.some((row) => row.some((cell) => cell.inRegion && cell.passable
    && cell.adjacentForest >= (buildingRules.lumberMill.minimumAdjacentForestCells ?? 0)))
  if (hasLumberPotential && (count('lumberMill') === 0
    || (domain.resources.wood < goalConfig.lowWoodThreshold && snapshot.resourceFlow.wood <= 0
      && count('lumberMill') < goalConfig.maximumLumberMills))) add('lumberMill', goalConfig.utility.lumberMill, 'wood-recovery')
  const housingSlack = snapshot.residentialCapacity - domain.population
  const serviceSlack = snapshot.foodServiceCapacity - domain.population
  const growthFoodReady = snapshot.forecastFed && snapshot.foodRunway >= aiPlannerConfig.foodRunwayTurns
    && sustainablyFeedsGrowth
  if (growthFoodReady && serviceSlack <= goalConfig.kitchenBeforeGrowthServiceSlack
    && housingSlack <= goalConfig.kitchenBeforeGrowthHousingSlack
    && snapshot.foodServiceCapacity <= snapshot.residentialCapacity
    && count('kitchen') < plannedBuildingLimit(memory, 'kitchen')) add('kitchen', goalConfig.utility.kitchenBeforeGrowth, 'food-service-before-growth')
  if (growthFoodReady && housingSlack <= goalConfig.houseHousingSlack
    && snapshot.foodServiceCapacity >= domain.population + goalConfig.houseFutureService
    && count('house') * (buildingRules.house.housingCapacity ?? 0) <= domain.population + (buildingRules.house.housingCapacity ?? 0)) {
    add('house', goalConfig.utility.house, 'housing-slack')
  }
  if (growthFoodReady && serviceSlack <= goalConfig.kitchenServiceSlack && count('house') >= 1
    && snapshot.foodServiceCapacity < snapshot.residentialCapacity
    && count('kitchen') < plannedBuildingLimit(memory, 'kitchen')) add('kitchen', goalConfig.utility.kitchen, 'food-service')

  const futureStoneNeed = profile.allowedBuildings
    .filter((kind) => count(kind) === 0)
    .slice(0, aiStrategicConfig.resourcePlanning.futureBuildingWindow)
    .reduce((sum, kind) => sum + (buildingRules[kind].resourceCost.stone ?? 0), 0)
  if (count('quarry') === 0 && domain.resources.stone < Math.max(aiStrategicConfig.resourcePlanning.minimumStoneTarget,
    futureStoneNeed * aiStrategicConfig.resourcePlanning.futureStoneShare)) add('quarry', goalConfig.utility.quarry, 'planned-stone')
  const hasBarracks = count('barracks') > 0
  const desiredArmySize = minimumFieldArmySize(profile)
  const needsRecruitmentTrade = hasBarracks && snapshot.armySize < desiredArmySize
    && domain.resources.flour < aiStrategicConfig.market.recruitmentFlourThreshold
  const marketCost = buildingRules.market.resourceCost.gold ?? 0
  const emergencyFoodBatchCost = Math.min(...foodResources.map((resource) => (
    tradeQuoteFor(domain, resource, 'buy', aiStrategicConfig.emergencyFoodBatch).total
  )))
  const goldAfterMarket = domain.resources.gold - marketCost
  const saleGoldPotential = Math.max(0, ...(['wood', 'stone', 'ore', 'flour', 'meat', 'fruit'] as const).map((resource) => {
    const surplus = domain.resources[resource] - (profile.strategicReserve[resource] ?? 0)
    if (surplus < aiStrategicConfig.market.minimumSaleSurplus) return 0
    const quantity = Math.min(aiStrategicConfig.market.saleBatch, Math.floor(surplus))
    return tradeQuoteFor(domain, resource, 'sell', quantity).total
  }))
  const marketHasFollowUp = goldAfterMarket + saleGoldPotential >= emergencyFoodBatchCost
  let stoneGoalChecks = 0
  const stoneGoalCountNode = () => {
    if (stoneGoalChecks >= aiPlannerConfig.goalValidationNodeBudget) return false
    stoneGoalChecks += 1
    return countNode()
  }
  const stoneRecoveryGoal = count('market') === 0 && snapshot.resourceFlow.stone <= 0
    ? fundedStoneGoalFor(state, analysis, memory, goals, stoneGoalCountNode)
    : null
  const stoneRecoveryFunded = stoneRecoveryGoal ? goldAfterMarket + saleGoldPotential >= (
    tradeQuoteFor(domain, 'stone', 'buy', stoneRecoveryGoal.shortfall).total
    + (buildingResourceCostFor(state, ownerId, stoneRecoveryGoal.kind).gold ?? 0)
  ) : false
  if (count('market') === 0 && ((marketHasFollowUp
    && (phase === 'recovery' || economicEmergency || domain.resources.gold < goalConfig.lowGoldMarketThreshold || usesIndustry || needsRecruitmentTrade)) || stoneRecoveryFunded)) {
    add('market', stoneRecoveryGoal ? goalConfig.utility.fundedMarket : goalConfig.utility.market, 'recovery-market', stoneRecoveryGoal ? `stone-for:${stoneRecoveryGoal.kind}` : 'funded-follow-up')
  }
  if (!hasBarracks && domain.population >= goalConfig.barracksMinimumPopulation && phase !== 'recovery') add('barracks', goalConfig.utility.barracks, 'military-unlock')

  if (usesIndustry && phase !== 'recovery' && snapshot.foodRunway >= goalConfig.industryFoodRunway) {
    if (count('mine') === 0) add('mine', goalConfig.utility.mine, 'iron-chain')
    else if (count('smelter') === 0 && (domain.resources.ore >= goalConfig.smelterOreStock || snapshot.resourceFlow.ore > 0)) add('smelter', goalConfig.utility.smelter, 'iron-chain')
    if ((phase === 'expansion' || phase === 'mobilization') && count('church') === 0
      && domain.population >= goalConfig.churchMinimumPopulation && snapshot.foodRunway >= goalConfig.churchFoodRunway
      && snapshot.goldRunway >= goalConfig.churchGoldRunway) add('church', goalConfig.utility.church, 'late-growth')
  }

  const threat = homeThreatFor(state, ownerId, memory)
  if (!economicEmergency && usesFortifications && (phase === 'defense'
    || (phase === 'mobilization' && snapshot.armySize >= goalConfig.fortificationArmySize))) {
    if (count('barbican') === 0) add('barbican', phase === 'defense' ? goalConfig.utility.defenseBarbican : goalConfig.utility.barbican, 'front-gate')
    if (count('wall') < (usesTowers ? goalConfig.completeWallLimit : goalConfig.basicWallLimit)) {
      add('wall', phase === 'defense' ? goalConfig.utility.defenseWall : goalConfig.utility.wall, 'front-line')
    }
    if (usesTowers && count('tower') < goalConfig.towerLimit
      && (phase === 'defense' || threat.power > 0 || snapshot.armySize >= goalConfig.towerArmySize)) {
      add('tower', goalConfig.utility.tower, 'fire-control')
    }
  }

  return goals
    .filter((goal, index, all) => all.findIndex((candidate) => candidate.kind === goal.kind) === index)
    .sort((first, second) => second.utility - first.utility || plannedResourceNeed(profile, second.kind) - plannedResourceNeed(profile, first.kind) || first.kind.localeCompare(second.kind))
}

function zoneTargetFor(state: MatchState, kind: BuildingKind, memory: AiMemory) {
  const sites = memory.settlementPlan?.reservedSites
  if (!sites) return null
  if (kind === 'house' || kind === 'kitchen' || kind === 'church' || kind === 'market') return sites.housing ?? null
  if (kind === 'farm' || kind === 'mill' || kind === 'orchard' || kind === 'huntingLodge') return sites.food ?? null
  if (kind === 'quarry' || kind === 'mine' || kind === 'smelter' || kind === 'lumberMill') return sites.industry ?? sites.food ?? null
  if (kind === 'barbican' || kind === 'wall') return sites.gate ?? sites.military ?? null
  if (kind === 'tower') return ownedBuildingCount(state, state.activeParticipantId, 'tower') === 0
    ? sites.leftTower ?? sites.rightTower ?? sites.military ?? null
    : sites.rightTower ?? sites.leftTower ?? sites.military ?? null
  return sites.military ?? null
}

function preservesAccess(
  state: MatchState,
  kind: BuildingKind,
  position: CellPosition,
  memory: AiMemory,
  sources = aiObjectEntries(state.scenario, state.activeParticipantId)
    .filter((entry) => entry.object.type === 'castle' || (entry.object.type === 'building' && entry.object.kind === 'barracks')),
) {
  const footprint = new Set(buildingFootprintPositions(kind, position).map(positionKey))
  const corridor = new Set(memory.settlementPlan?.reservedCorridors.map(positionKey) ?? [])
  if (aiBuildingZoneByKind[kind] !== 'defense' && [...footprint].some((key) => corridor.has(key))) return false
  const accessSources = kind === 'barracks'
    ? [...sources, { object: { type: 'building' as const, kind, ownerId: state.activeParticipantId, hitPoints: 1, maxHitPoints: 1, constructionCost: {} }, position }]
    : sources
  return accessSources.every((source) => {
    const sourceCells = source.object.type === 'building' ? buildingFootprintPositions(source.object.kind, source.position) : [source.position]
    const perimeter = sourceCells.flatMap((cell) => clockwiseCardinalDirections.map((direction) => ({ column: cell.column + direction.column, row: cell.row + direction.row })))
      .filter((cell, index, all) => !sourceCells.some((sourceCell) => samePosition(sourceCell, cell)) && all.findIndex((candidate) => samePosition(candidate, cell)) === index)
    const free = perimeter.filter((cell) => {
      const mapCell = state.scenario.cells[cell.row]?.[cell.column]
      const movableSquad = mapCell?.object?.type === 'squad' && mapCell.object.ownerId === state.activeParticipantId
      return mapCell && mapCell.landform !== 'peak' && (!mapCell.object || movableSquad) && !footprint.has(positionKey(cell))
    }).length
    return free >= aiStrategicConfig.placement.minimumRecruitmentExits
  })
}

interface BuildingPositionContext {
  target: CellPosition | null
  existingKind: CellPosition[]
  sameQuarter: CellPosition[]
  defenses: CellPosition[]
}

function buildingPositionScore(
  state: MatchState,
  analysis: AiWorldAnalysis,
  memory: AiMemory,
  kind: BuildingKind,
  position: CellPosition,
  context: BuildingPositionContext,
) {
  const scoring = aiStrategicConfig.placement
  const cell = analysis.cells[position.row]?.[position.column]
  if (!cell?.inRegion) return Number.NEGATIVE_INFINITY
  const target = context.target
  const targetDistance = target ? positionDistance(position, target) : cell.distanceToCastle
  const zone = memory.settlementPlan?.zones[settlementZoneKindFor(kind)]
  const zoneKeys = new Set(zone?.cells.map(positionKey) ?? [])
  const footprint = buildingFootprintPositions(kind, position)
  const zoneCoverage = footprint.length > 0 ? footprint.filter((candidate) => zoneKeys.has(positionKey(candidate))).length / footprint.length : 0
  const zoneDistance = zone?.cells.length ? Math.min(...zone.cells.map((candidate) => positionDistance(candidate, position))) : 0
  let score = -targetDistance * scoring.targetDistanceWeight - footprintOpportunityCost(analysis, kind, position)
    + zoneCoverage * scoring.zoneCoverageWeight - zoneDistance * scoring.zoneDistanceWeight
  if (kind === 'lumberMill' || kind === 'huntingLodge') {
    score += cell.adjacentForest * scoring.forestAdjacencyWeight - cell.distanceToForest * scoring.forestDistanceWeight
  }
  if (kind === 'quarry' || kind === 'mine') score += cell.hillOpportunity * scoring.hillOpportunityWeight
  if (kind === 'house' || kind === 'kitchen') score += Math.max(0, scoring.homeRadius - cell.distanceToCastle) * scoring.homeProximityWeight
  if (kind === 'barbican') score += cell.chokeScore * scoring.barbicanChokeWeight
  if (kind === 'wall') score += cell.chokeScore * scoring.wallChokeWeight + (target ? Math.max(0, scoring.wallFrontRadius - targetDistance) : 0)
  if (kind === 'tower') score += cell.visibilityScore * scoring.towerVisibilityWeight + cell.hillOpportunity * scoring.towerHillWeight
  if (context.existingKind.some((entry) => entry.row === position.row || entry.column === position.column)) score += scoring.alignmentBonus
  if (context.sameQuarter.length > 0) {
    const nearestQuarterBuilding = Math.min(...context.sameQuarter.map((entry) => positionDistance(entry, position)))
    score += Math.max(0, scoring.quarterRadius - nearestQuarterBuilding) * scoring.quarterProximityWeight
  }
  if (aiBuildingZoneByKind[kind] === 'defense') {
    const linkedDefenses = context.defenses.filter((entry) => positionDistance(entry, position) <= scoring.linkedDefenseRadius).length
    score += linkedDefenses * scoring.linkedDefenseWeight
  }
  if (memory.settlementPlan?.layout === 'courtyard') {
    const preferredRadius = ['farm', 'orchard', 'huntingLodge'].includes(kind)
      ? scoring.courtyardFoodRadius : scoring.courtyardOrdinaryRadius
    score -= Math.abs(cell.distanceToCastle - preferredRadius) * scoring.courtyardRadiusPenalty
  }
  if (memory.settlementPlan?.layout === 'strongpoint' && (aiBuildingZoneByKind[kind] === 'defense' || kind === 'barracks')) {
    score += Math.max(0, scoring.strongpointFrontRadius - positionDistance(position, analysis.front)) * scoring.strongpointFrontWeight
  }
  return score
}

export function findStrategicBuildPosition(
  state: MatchState,
  analysis: AiWorldAnalysis,
  memory: AiMemory,
  kind: BuildingKind,
  countNode: () => boolean,
) {
  const zone = memory.settlementPlan?.zones[settlementZoneKindFor(kind)]
  const ownedEntries = aiObjectEntries(state.scenario, state.activeParticipantId)
  const buildingEntries = ownedEntries.flatMap((entry) => entry.object.type === 'building'
    ? [{ position: entry.position, kind: entry.object.kind }]
    : [])
  const context: BuildingPositionContext = {
    target: zoneTargetFor(state, kind, memory),
    existingKind: buildingEntries.filter((entry) => entry.kind === kind).map((entry) => entry.position),
    sameQuarter: buildingEntries.filter((entry) => settlementZoneKindFor(entry.kind) === settlementZoneKindFor(kind)).map((entry) => entry.position),
    defenses: buildingEntries.filter((entry) => aiBuildingZoneByKind[entry.kind] === 'defense').map((entry) => entry.position),
  }
  const accessSources = ownedEntries.filter((entry) => entry.object.type === 'castle'
    || (entry.object.type === 'building' && entry.object.kind === 'barracks'))
  const stalledExpansion = Math.min(aiStrategicConfig.adaptiveBlueprintExpansionLimit,
    Math.floor(memory.stalledTurns / aiPlannerConfig.relaxBlueprintAfterStalledTurns))
  const adaptiveShiftRadius = (zone?.overflowRadius ?? 0) + Math.max(
    aiStrategicConfig.placement.adaptiveShiftMinimum,
    Math.ceil(Math.sqrt(zone?.cells.length ?? 0) / aiStrategicConfig.placement.adaptiveShiftAreaDivisor),
  ) + stalledExpansion
  const localKeys = new Set<string>()
  if (zone?.cells.length) {
    zone.cells.forEach((origin) => {
      for (let deltaRow = -adaptiveShiftRadius; deltaRow <= adaptiveShiftRadius; deltaRow += 1) {
        const remaining = adaptiveShiftRadius - Math.abs(deltaRow)
        for (let deltaColumn = -remaining; deltaColumn <= remaining; deltaColumn += 1) {
          localKeys.add(positionKey({ column: origin.column + deltaColumn, row: origin.row + deltaRow }))
        }
      }
    })
  } else {
    analysis.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
      if (cell.inRegion) localKeys.add(positionKey({ column, row: rowIndex }))
    }))
  }
  const zoneKeys = new Set(zone?.cells.map(positionKey) ?? [])
  const coverage = (position: CellPosition) => {
    const footprint = buildingFootprintPositions(kind, position)
    return footprint.length > 0 ? footprint.filter((candidate) => zoneKeys.has(positionKey(candidate))).length / footprint.length : 0
  }
  const distanceToZone = (position: CellPosition) => zone?.cells.length
    ? Math.min(...zone.cells.map((candidate) => positionDistance(position, candidate)))
    : 0
  const tryKeys = (keys: Iterable<string>) => {
    const candidates: Array<{ position: CellPosition; score: number }> = []
    let scanned = 0
    for (const key of keys) {
      if (scanned % aiStrategicConfig.placement.scanCheckInterval === 0 && !countNode()) break
      scanned += 1
      const [column, row] = key.split(':').map(Number)
      const position = { column, row }
      if (!analysis.cells[row]?.[column]?.inRegion) continue
      const cell = state.scenario.cells[row]?.[column]
      if (!cell || cell.object || cell.landform === 'peak') continue
      const score = buildingPositionScore(state, analysis, memory, kind, position, context)
      if (Number.isFinite(score)) candidates.push({ position, score })
    }
    candidates.sort((first, second) => {
      const firstTier = coverage(first.position) >= aiStrategicConfig.placement.preferredZoneCoverage ? 0 : distanceToZone(first.position) <= (zone?.overflowRadius ?? 0) ? 1 : 2
      const secondTier = coverage(second.position) >= aiStrategicConfig.placement.preferredZoneCoverage ? 0 : distanceToZone(second.position) <= (zone?.overflowRadius ?? 0) ? 1 : 2
      return firstTier - secondTier || second.score - first.score || first.position.row - second.position.row || first.position.column - second.position.column
    })
    const shortlist = candidates.slice(0, aiStrategicConfig.buildingPlacementShortlist)
    for (const candidate of shortlist) {
      if (!countNode()) break
      if (buildingFootprintPositions(kind, candidate.position).some((position) => isTemporarilyBlocked(memory, position, state.turn))) continue
      if (!preservesAccess(state, kind, candidate.position, memory, accessSources)) continue
      if (buildingPlacementFailure(state, kind, candidate.position) === null) return candidate.position
    }
    return null
  }
  const local = tryKeys(localKeys)
  if (local) return local
  const regionalKeys: string[] = []
  analysis.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const key = positionKey({ column, row: rowIndex })
    if (cell.inRegion && !localKeys.has(key)) regionalKeys.push(key)
  }))
  return tryKeys(regionalKeys)
}

function fundedStoneGoalFor(
  state: MatchState,
  analysis: AiWorldAnalysis,
  memory: AiMemory,
  goals: BuildingGoal[],
  countNode: () => boolean,
) {
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  for (const goal of goals.filter((candidate) => candidate.kind !== 'market')) {
    const cost = buildingResourceCostFor(state, ownerId, goal.kind)
    const stoneNeeded = cost.stone ?? 0
    if (stoneNeeded <= domain.resources.stone) continue
    const fundedResources = { ...domain.resources, stone: stoneNeeded }
    if (!canAfford(fundedResources, cost)) continue
    const fundedState: MatchState = {
      ...state,
      ordersRemaining: Math.max(state.ordersRemaining, buildingRules[goal.kind].actionCost),
      domains: {
        ...state.domains,
        [ownerId]: { ...domain, resources: fundedResources },
      },
    }
    const position = findStrategicBuildPosition(fundedState, analysis, memory, goal.kind, countNode)
    if (position) return { kind: goal.kind, shortfall: stoneNeeded - domain.resources.stone, position }
  }
  return null
}

function recruitmentPositions(state: MatchState, troop: TroopKind, memory?: AiMemory) {
  return aiObjectEntries(state.scenario, state.activeParticipantId)
    .filter((entry) => (troop === 'militia' && entry.object.type === 'castle') || (entry.object.type === 'building' && entry.object.kind === 'barracks'))
    .flatMap((entry) => {
      const sourceCells = entry.object.type === 'building' ? buildingFootprintPositions(entry.object.kind, entry.position) : [entry.position]
      return sourceCells.flatMap((position) => clockwiseCardinalDirections.map((direction) => ({ column: position.column + direction.column, row: position.row + direction.row })))
    })
    .filter((position, index, all) => all.findIndex((candidate) => samePosition(candidate, position)) === index)
    .filter((position) => !isTemporarilyBlocked(memory, position, state.turn))
    .sort((first, second) => first.row - second.row || first.column - second.column)
}

export function recruitmentCandidate(state: MatchState, profile: AiProfileRules, phase: AiStrategicPhase, countNode: () => boolean, memory?: AiMemory): StrategicCandidate | null {
  if (phase === 'recovery' || phase === 'survival') return null
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const workforce = workforceFor(state, ownerId)
  const threat = homeThreatFor(state, ownerId)
  const currentArmySize = totalArmySize(state, ownerId)
  const currentArmyPower = armyPowerFor(state, ownerId)
  const targetPower = estimatedTargetPower(state, memory?.targetOwnerId ?? null, memory)
  const campaignUnderStrength = (phase === 'mobilization' || phase === 'regroup' || phase === 'assault')
    && currentArmyPower < targetPower * profile.riskThreshold
  const minimumCivilians = phase === 'defense'
    ? Math.max(aiStrategicConfig.minimumCivilianReserve, Math.ceil(workforce.employed * aiStrategicConfig.defenseWorkerReserveShare))
    : Math.max(aiStrategicConfig.minimumCivilianReserve, workforce.employed + 1)
  const available = Math.max(0, domain.population - minimumCivilians)
  if (available < 1 || !turnEconomyForecastFor(state, ownerId)?.food.fed) return null
  const totals = troopTotals(state, ownerId)
  const hasBarracks = ownedBuildingCount(state, ownerId, 'barracks') > 0
  const preference = [...profile.doctrine.preferredTroops].sort((first, second) => {
    const targetShare = (troop: TroopKind) => profile.doctrine.targetComposition[troop] ?? 0
    const army = Math.max(1, totalArmySize(state, ownerId))
    return targetShare(second) - totals[second] / army - targetShare(first) + totals[first] / army
  })
  for (const troop of preference.filter((candidate) => profile.allowedTroops.includes(candidate))) {
    if (troop === 'militia' && profile.allowedTroops.some((candidate) => candidate !== 'militia')
      && !hasBarracks && totals.militia >= aiStrategicConfig.basicMilitiaBeforeBarracks) continue
    const maximumQuantity = Math.min(aiStrategicConfig.maximumRecruitBatch, available,
      aiStrategicConfig.recruitmentCellCapacity - Math.max(...recruitmentPositions(state, troop, memory).map((position) => {
      const object = objectAt(state, position)
      return object?.type === 'squad' ? squadSize(object) : 0
    }), 0))
    for (let quantity = maximumQuantity; quantity >= 1; quantity -= 1) {
      const cost = troopRules[troop].resourceCost
      const preserve = phase !== 'defense' && resourceIds.some((resource) => {
        if ((cost[resource] ?? 0) <= 0) return false
        const reserve = profile.strategicReserve[resource] ?? 0
        const after = domain.resources[resource] - (cost[resource] ?? 0) * quantity
        // Before the first viable field force exists, reserves are a runway,
        // not a hard lock. The post-recruit forecast below remains the final
        // authority for food and upkeep safety.
        const reserveShare = currentArmySize < minimumFieldArmySize(profile) || campaignUnderStrength
          ? 0
          : phase === 'assault'
            ? aiStrategicConfig.recruitment.assaultReserveShare
            : aiStrategicConfig.recruitment.ordinaryReserveShare
        return after < reserve * reserveShare
      })
      if (preserve && !threat.threatened) continue
      for (const position of recruitmentPositions(state, troop, memory)) {
        if (!countNode()) return null
        if (recruitmentFailure(state, troop, quantity, position) === null) {
          const simulated = recruit(state, troop, quantity, position)
          if (!simulated.ok) continue
          const forecast = turnEconomyForecastFor(simulated.state, ownerId)
          const postRecruit = economySnapshotFor(simulated.state, ownerId)
          const emergencyDefense = phase === 'defense'
            && threat.nearest <= aiStrategicConfig.recruitment.emergencyDefenseRadius
            && currentArmyPower < threat.power * aiStrategicConfig.recruitment.emergencyDefensePowerRatio
          const sustainable = forecast?.food.fed && forecast.upkeepPaid
            && postRecruit.foodRunway >= aiPlannerConfig.foodRunwayTurns
            && postRecruit.goldRunway >= aiStrategicConfig.phase.campaignGoldRunway
          if (!sustainable && !emergencyDefense) continue
          return {
            command: { type: 'recruit', troop, quantity, position },
            utility: phase === 'defense' ? aiStrategicConfig.recruitment.defenseUtility : aiStrategicConfig.recruitment.ordinaryUtility,
            goal: phase,
            factors: ['composition-gap', `quantity:${quantity}`],
          }
        }
      }
    }
  }
  return null
}

function taxCandidate(state: MatchState, phase: AiStrategicPhase, memory: AiMemory): StrategicCandidate | null {
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const snapshot = economySnapshotFor(state, ownerId)
  const current = domain.taxRate ?? 'moderate'
  let rate: TaxRate = current
  const config = aiStrategicConfig.taxation
  if (!snapshot.forecastFed || snapshot.foodRunway < config.disableFoodRunway) rate = 'none'
  else if (current === 'none' && snapshot.foodRunway >= config.enableModerateFoodRunway) rate = 'moderate'
  else if (current === 'moderate' && snapshot.goldRunway < config.enableExtortionateGoldRunway
    && snapshot.foodRunway > config.enableExtortionateFoodRunway) rate = 'extortionate'
  else if (current === 'extortionate' && (snapshot.goldRunway > config.disableExtortionateGoldRunway
    || snapshot.foodRunway < config.disableExtortionateFoodRunway)) rate = 'moderate'
  if (current === rate) return null
  const emergencyRelief = rate === 'none' && (!snapshot.forecastFed || snapshot.foodRunway < config.emergencyReliefRunway)
  if (!emergencyRelief && state.turn - memory.lastTaxChangeTurn < aiPlannerConfig.minimumTaxHoldTurns) return null
  return { command: { type: 'tax', rate }, utility: phase === 'recovery' ? config.recoveryUtility : config.ordinaryUtility, goal: 'tax', factors: [`rate:${rate}`] }
}

export function marketCandidate(
  state: MatchState,
  profile: AiProfileRules,
  phase: AiStrategicPhase,
  memory?: AiMemory,
  analysis?: AiWorldAnalysis,
  countNode: () => boolean = () => true,
): StrategicCandidate | null {
  if (!profile.capabilities.trade) return null
  const market = aiObjectEntries(state.scenario, state.activeParticipantId)
    .find((entry) => entry.object.type === 'building' && entry.object.kind === 'market')
  if (!market) return null
  const domain = state.domains[state.activeParticipantId]
  const snapshot = economySnapshotFor(state, state.activeParticipantId)
  const config = aiStrategicConfig.market
  const hasMilitarySource = ownedBuildingCount(state, state.activeParticipantId, 'barracks') > 0
  const workforce = workforceFor(state, state.activeParticipantId)
  const civilianReserve = phase === 'defense'
    ? Math.max(aiStrategicConfig.minimumCivilianReserve, Math.ceil(workforce.employed * aiStrategicConfig.defenseWorkerReserveShare))
    : Math.max(aiStrategicConfig.minimumCivilianReserve, workforce.employed + 1)
  const hasRecruitableCivilian = domain.population > civilianReserve
  const defensiveShortfall = phase === 'defense'
    && snapshot.armyPower < Math.max(config.minimumDefensePower,
      homeThreatFor(state, state.activeParticipantId).power * config.defenseThreatPowerMultiplier)
  const campaignShortfall = memory && (phase === 'mobilization' || phase === 'regroup' || phase === 'assault')
    && snapshot.armyPower < estimatedTargetPower(state, memory.targetOwnerId, memory) * profile.riskThreshold
  const desiredArmySize = minimumFieldArmySize(profile)
  const isBuildingArmy = phase === 'mobilization' || phase === 'expansion' || phase === 'regroup' || phase === 'assault' || phase === 'defense'
  if (hasMilitarySource && hasRecruitableCivilian
    && (snapshot.armySize < desiredArmySize || defensiveShortfall || campaignShortfall) && isBuildingArmy
    && domain.resources.flour < config.recruitmentFlourThreshold && domain.marketActivity.bought.flour === 0) {
    const minimumRecruitGold = Math.min(...profile.allowedTroops.map((troop) => troopRules[troop].resourceCost.gold ?? 0))
    const mobilizationGoldNeed = config.mobilizationBaseGold + minimumRecruitGold
      + (profile.strategicReserve.gold ?? 0) * config.mobilizationReserveGoldShare
    const supplied = trade(state, market.position, 'flour', 'buy', aiStrategicConfig.emergencyFoodBatch)
    const canUseSupply = supplied.ok && recruitmentCandidate(supplied.state, profile, phase, () => true, memory) !== null
    if (domain.resources.gold >= mobilizationGoldNeed && canUseSupply) {
      return { command: { type: 'trade', market: market.position, resource: 'flour', direction: 'buy', quantity: aiStrategicConfig.emergencyFoodBatch }, utility: phase === 'defense' ? config.defenseSupplyUtility : config.mobilizationSupplyUtility, goal: 'trade', factors: [phase === 'defense' ? 'defensive-flour' : 'mobilization-flour'] }
    }
    const woodSurplus = domain.resources.wood - (profile.strategicReserve.wood ?? 0)
    if (woodSurplus >= config.saleBatch && domain.marketActivity.sold.wood === 0) {
      return { command: { type: 'trade', market: market.position, resource: 'wood', direction: 'sell', quantity: config.saleBatch }, utility: config.mobilizationSaleUtility, goal: 'trade', factors: ['fund-mobilization'] }
    }
  }
  const durableFoodInvestmentAvailable = Boolean(memory && analysis) && aiStrategicConfig.basicFoodBuildings.some((kind) => {
    if (!profile.allowedBuildings.includes(kind)
      || ownedBuildingCount(state, state.activeParticipantId, kind) >= adaptiveBuildingLimitFor(state, memory!, kind)
      || !canAfford(domain.resources, buildingRules[kind].resourceCost)) return false
    let checks = 0
    const placementCountNode = () => {
      if (checks >= aiPlannerConfig.goalValidationNodeBudget) return false
      checks += 1
      return countNode()
    }
    return findStrategicBuildPosition(state, analysis!, memory!, kind, placementCountNode) !== null
  })
  if ((!snapshot.forecastFed || snapshot.foodRunway < aiPlannerConfig.emergencyRunwayTurns) && !durableFoodInvestmentAvailable) {
    const food = foodResources.slice().sort((first, second) => marketPrices[first].buy - marketPrices[second].buy
      || domain.resources[first] - domain.resources[second] || first.localeCompare(second))[0]
    if (domain.resources.gold >= marketPrices[food].buy * aiStrategicConfig.emergencyFoodBatch) {
      return { command: { type: 'trade', market: market.position, resource: food, direction: 'buy', quantity: aiStrategicConfig.emergencyFoodBatch }, utility: config.emergencyFoodUtility, goal: 'trade', factors: ['emergency-food'] }
    }
  }
  const blockedStoneGoal = analysis && memory
    ? (() => {
        let checks = 0
        const limitedCountNode = () => {
          if (checks >= aiPlannerConfig.goalValidationNodeBudget) return false
          checks += 1
          return countNode()
        }
        return fundedStoneGoalFor(
          state,
          analysis,
          memory,
          desiredBuildingGoals(state, profile, analysis, memory, phase, limitedCountNode),
          limitedCountNode,
        )
      })()
    : null
  const stoneProductionUnavailable = ownedBuildingCount(state, state.activeParticipantId, 'quarry') === 0
    || snapshot.resourceFlow.stone <= 0
  if (blockedStoneGoal && stoneProductionUnavailable && domain.marketActivity.bought.stone === 0) {
    const quote = tradeQuoteFor(domain, 'stone', 'buy', blockedStoneGoal.shortfall)
    if (domain.resources.gold >= quote.total + (profile.strategicReserve.gold ?? 0) * config.stoneReserveGoldShare) {
      return {
        command: { type: 'trade', market: market.position, resource: 'stone', direction: 'buy', quantity: blockedStoneGoal.shortfall },
        utility: config.stoneUtility,
        goal: 'trade',
        factors: ['unblock-stone-goal', `building:${blockedStoneGoal.kind}`],
      }
    }
  }
  if (profile.allowedBuildings.includes('smelter') && domain.resources.iron < config.industrialIronTarget
    && domain.resources.gold >= config.industrialIronGoldFloor
    && ownedBuildingCount(state, state.activeParticipantId, 'smelter') === 0) {
    return { command: { type: 'trade', market: market.position, resource: 'iron', direction: 'buy', quantity: config.industrialIronBatch }, utility: config.industrialIronUtility, goal: 'trade', factors: ['industry-fallback'] }
  }
  if (phase === 'recovery' || !snapshot.upkeepPaid || snapshot.goldRunway < config.upkeepGoldRunway) {
    const sellable = (['wood', 'stone', 'ore', 'flour', 'meat', 'fruit'] as const)
      .map((resource) => ({ resource, surplus: domain.resources[resource] - (profile.strategicReserve[resource] ?? 0) }))
      .filter((entry) => entry.surplus >= config.minimumSaleSurplus)
      .sort((first, second) => second.surplus - first.surplus || first.resource.localeCompare(second.resource))[0]
    if (sellable) return { command: { type: 'trade', market: market.position, resource: sellable.resource, direction: 'sell', quantity: Math.min(config.saleBatch, Math.floor(sellable.surplus)) }, utility: config.recoverySaleUtility, goal: 'trade', factors: ['upkeep-recovery'] }
  }
  if (phase !== 'recovery' && domain.resources.wood < aiStrategicConfig.constructionWoodFloor
    && domain.resources.gold >= config.constructionGoldFloor) {
    return { command: { type: 'trade', market: market.position, resource: 'wood', direction: 'buy', quantity: config.constructionWoodBatch }, utility: config.constructionUtility, goal: 'trade', factors: ['unblock-construction'] }
  }
  return null
}

function dismissalCandidate(state: MatchState, phase: AiStrategicPhase): StrategicCandidate | null {
  if ((phase !== 'recovery' && !economicEmergencyFor(state, state.activeParticipantId))
    || turnEconomyForecastFor(state, state.activeParticipantId)?.upkeepPaid) return null
  const squads = aiObjectEntries(state.scenario, state.activeParticipantId)
    .filter((entry): entry is typeof entry & { object: SquadObject } => entry.object.type === 'squad')
    .sort((first, second) => squadSize(second.object) - squadSize(first.object) || first.position.row - second.position.row || first.position.column - second.position.column)
  for (const squad of squads) {
    const kind = (['knights', 'archers', 'spearmen', 'militia'] as TroopKind[]).find((troop) => squad.object.units[troop] > 0)
    if (!kind) continue
    const units: TroopComposition = { militia: 0, spearmen: 0, archers: 0, knights: 0, [kind]: 1 }
    return {
      command: { type: 'dismiss', from: squad.position, units },
      utility: aiStrategicConfig.recovery.dismissalUtility,
      goal: 'recovery',
      factors: ['unpaid-upkeep', `dismiss:${kind}`],
    }
  }
  return null
}

function demolitionCandidate(state: MatchState, profile: AiProfileRules, memory: AiMemory, phase: AiStrategicPhase): StrategicCandidate | null {
  if (!profile.capabilities.demolition) return null
  const ownerId = state.activeParticipantId
  const recoveryMode = phase === 'recovery' || economicEmergencyFor(state, ownerId)
  const workforce = workforceFor(state, ownerId)
  const snapshot = economySnapshotFor(state, ownerId)
  const recoveryConfig = aiStrategicConfig.recovery
  const entries = aiObjectEntries(state.scenario, ownerId)
    .flatMap((entry) => entry.object.type === 'building' ? [{ ...entry, object: entry.object as BuildingObject }] : [])
  const count = (kind: BuildingKind) => ownedBuildingCount(state, ownerId, kind)
  const safeToRemove = (position: CellPosition) => {
    const result = demolish(state, position)
    if (!result.ok) return false
    const after = economySnapshotFor(result.state, ownerId)
    const population = state.domains[ownerId].population
    if (after.housingCapacity < population || after.foodServiceCapacity < population) return false
    if (snapshot.forecastFed && !after.forecastFed) return false
    return true
  }
  const candidateFor = (position: CellPosition, utility: number, factors: string[]): StrategicCandidate | null => safeToRemove(position)
    ? { command: { type: 'demolish', position }, utility, goal: phase, factors }
    : null

  if (recoveryMode && !snapshot.upkeepPaid) {
    const church = entries.find((entry) => entry.object.type === 'building' && entry.object.kind === 'church')
    if (church) {
      const candidate = candidateFor(church.position, recoveryConfig.removeUnpaidChurchUtility, ['remove-unpaid-upkeep'])
      if (candidate) return candidate
    }
  }

  const blocked = workforce.assignments
    .filter((assignment) => {
      if (assignment.blockedReason === 'missing-support') return !profile.allowedBuildings.includes('mill') || plannedBuildingLimit(memory, 'mill') <= 0
      if (assignment.blockedReason === 'idle-support') return !profile.allowedBuildings.includes('farm') || plannedBuildingLimit(memory, 'farm') <= 0
      return false
    })
    .sort((first, second) => first.position.row - second.position.row || first.position.column - second.position.column)[0]
  if (blocked && recoveryMode) {
    const candidate = candidateFor(blocked.position, recoveryConfig.removeIrrecoverableBuildingUtility, [`irrecoverable:${blocked.blockedReason}`])
    if (candidate) return candidate
  }

  const excess = profile.allowedBuildings.flatMap((kind) => {
    const limit = adaptiveBuildingLimitFor(state, memory, kind)
    const sameKind = entries
      .filter((entry) => entry.object.type === 'building' && entry.object.kind === kind)
      .sort((first, second) => second.position.row - first.position.row || second.position.column - first.position.column)
    return sameKind.slice(limit)
  })[0]
  if (excess) {
    const candidate = candidateFor(excess.position, recoveryMode
      ? recoveryConfig.excessBuildingUtility.recovery
      : recoveryConfig.excessBuildingUtility.stable, ['outside-building-capacity'])
    if (candidate) return candidate
  }

  const crowdedZone = (Object.keys(memory.settlementPlan?.zones ?? {}) as AiSettlementZoneKind[]).flatMap((zoneKind) => {
    const zone = memory.settlementPlan?.zones[zoneKind]
    if (!zone) return []
    const zoneEntries = entries.filter((entry) => entry.object.type === 'building' && settlementZoneKindFor(entry.object.kind) === zoneKind)
    const substitutedFoodOrigin = zoneKind === 'food' && !hasHuntingTerrainPotential(state, ownerId)
      && count('orchard') > plannedBuildingLimit(memory, 'orchard')
    const adaptiveOverflow = phase === 'recovery' || phase === 'survival' || economicEmergencyFor(state, ownerId)
      || memory.stalledTurns >= aiPlannerConfig.relaxBlueprintAfterStalledTurns || substitutedFoodOrigin ? 1 : 0
    return zoneEntries.length > zone.maxOrigins + adaptiveOverflow ? zoneEntries : []
  }).sort((first, second) => {
    const retention = (kind: BuildingKind) => {
      if (kind === 'barracks' && count('barracks') > recoveryConfig.protectedBarracksCount) {
        return recoveryConfig.duplicateBarracksRetention
      }
      return recoveryConfig.retentionByKind[kind] ?? recoveryConfig.retentionDefault
    }
    return retention(first.object.kind) - retention(second.object.kind)
      || first.position.row - second.position.row || first.position.column - second.position.column
  })[0]
  if (crowdedZone && (recoveryMode || memory.stableTurns >= aiPlannerConfig.stableRecoveryTurns)) {
    const candidate = candidateFor(crowdedZone.position, recoveryMode
      ? recoveryConfig.crowdedZoneUtility.recovery
      : recoveryConfig.crowdedZoneUtility.stable, ['trim-overflow'])
    if (candidate) return candidate
  }

  if (recoveryMode) {
    const liquidationOrder: BuildingKind[] = ['church', ...aiBuildingKindsByZone.defense, 'smelter', 'mine', 'quarry', 'barracks']
    for (const kind of liquidationOrder) {
      if (kind === 'barracks' && count(kind) <= recoveryConfig.protectedBarracksCount) continue
      const entry = entries.find((candidate) => candidate.object.type === 'building' && candidate.object.kind === kind)
      if (!entry) continue
      const candidate = candidateFor(entry.position, recoveryConfig.liquidationUtility, [`liquidate:${kind}`])
      if (candidate) return candidate
    }
  }

  const foodZone = memory.settlementPlan?.zones.food
  const foodOrigins = entries.filter((entry) => entry.object.type === 'building' && settlementZoneKindFor(entry.object.kind) === 'food').length
  const basicFood = entries.filter((entry) => entry.object.type === 'building'
    && aiStrategicConfig.basicFoodBuildings.includes(entry.object.kind))
  const canRedevelop = (phase === 'expansion' || phase === 'mobilization')
    && memory.stableTurns >= aiPlannerConfig.stableRecoveryTurns
    && profile.allowedBuildings.includes('mill') && profile.allowedBuildings.includes('farm')
    && Boolean(foodZone && foodOrigins >= foodZone.maxOrigins)
    && snapshot.foodRunway < recoveryConfig.redevelopmentFoodRunway
    && (count('mill') === 0 || count('farm') < count('mill') * (buildingRules.mill.farmSupport?.capacity ?? 0))
  if (canRedevelop) {
    const duplicate = basicFood.find((entry) => entry.object.type === 'building'
      && basicFood.filter((candidate) => candidate.object.type === 'building' && candidate.object.kind === entry.object.kind).length > 1)
    if (duplicate) {
      const candidate = candidateFor(duplicate.position, recoveryConfig.redevelopmentUtility, ['redevelop-food-quarter'])
      if (candidate) return candidate
    }
  }
  return null
}

export function strategicCandidates(
  state: MatchState,
  profile: AiProfileRules,
  analysis: AiWorldAnalysis,
  memory: AiMemory,
  phase: AiStrategicPhase,
  countNode: () => boolean,
  diagnostics?: AiPlanTraceEntry[],
): StrategicCandidate[] {
  const candidates: StrategicCandidate[] = []
  const tax = taxCandidate(state, phase, memory)
  if (tax) candidates.push(tax)
  const market = marketCandidate(state, profile, phase, memory, analysis, countNode)
  if (market) candidates.push(market)
  const dismiss = dismissalCandidate(state, phase)
  if (dismiss) candidates.push(dismiss)
  const demolition = demolitionCandidate(state, profile, memory, phase)
  if (demolition) candidates.push(demolition)
  const recruitment = recruitmentCandidate(state, profile, phase, countNode, memory)
  if (recruitment) candidates.push(recruitment)
  const buildingGoals = desiredBuildingGoals(state, profile, analysis, memory, phase, countNode)
  for (const goal of buildingGoals.slice(0, aiStrategicConfig.maximumBuildingGoalsPerSearch)) {
    if (!countNode()) break
    let placementChecks = 0
    const placementCountNode = () => {
      if (placementChecks >= aiPlannerConfig.goalValidationNodeBudget) return false
      placementChecks += 1
      return countNode()
    }
    const position = findStrategicBuildPosition(state, analysis, memory, goal.kind, placementCountNode)
    if (position) candidates.push({ command: { type: 'build', building: goal.kind, position }, utility: goal.utility, goal: phase, factors: goal.factors })
    else diagnostics?.push({ goal: phase, score: goal.utility, factors: [...goal.factors, `building:${goal.kind}`], rejectedReason: 'no-strategic-build-position' })
  }
  return candidates.sort((first, second) => second.utility - first.utility || JSON.stringify(first.command).localeCompare(JSON.stringify(second.command)))
}

export function projectedStrategicScore(state: MatchState, profile: AiProfileRules, phase: AiStrategicPhase) {
  const scoring = aiStrategicConfig.projection
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const projection = projectOwnerEconomy(state, ownerId, aiPlannerConfig.projectionTurns)
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
