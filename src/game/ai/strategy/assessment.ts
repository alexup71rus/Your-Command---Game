import { aiPlannerConfig, aiStrategicConfig, aiTacticalConfig } from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import { buildingRules, resourceIds, troopRules } from '../../../config/rules'
import type { ResourceId, SquadObject, TroopComposition, TroopKind } from '../../map'
import {
  civilianHousingCapacityFor,
  civilianPopulationCapacityFor,
  foodDemandFor,
  foodServiceCapacityFor,
  objectAt,
  ownedBuildingCount,
  productionFor,
  squadHealth,
  totalArmySize,
  troopTotals,
  turnEconomyForecastFor,
  workforceFor,
  type MatchState,
} from '../../match'
import { findMovementPath } from '../../pathfinding'
import type { CellPosition } from '../../scenario'
import { clockwiseCardinalDirections } from '../../geometry'
import {
  aiObjectEntries,
  castlePositionFor,
  positionDistance,
  samePosition,
} from '../analysis'
import type { AiMemory, AiProfileRules } from '../model'
import { forceTargetFor, isTemporarilyBlocked, minimumFieldArmySize, plannedBuildingLimit } from './shared'
import type { AiEconomySnapshot } from './types'

const foodResources = gameConfig.economy.foodResources

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

export function fortificationReadyFor(state: MatchState, memory: AiMemory) {
  const plan = memory.settlementPlan?.fortification
  if (!plan) return true
  const firstLine = plan.lines[0]
  if (!firstLine) return true
  const owns = (position: CellPosition, kind: 'barbican' | 'wall') => {
    const object = state.scenario.cells[position.row]?.[position.column]?.object
    return object?.type === 'building' && object.ownerId === state.activeParticipantId && object.kind === kind
  }
  return owns(firstLine.gate, 'barbican')
    && firstLine.walls.filter((position) => owns(position, 'wall')).length
      >= Math.min(aiStrategicConfig.buildingGoals.minimumViableFortificationWalls, firstLine.walls.length)
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

export function populationGrowthSupplyFor(state: MatchState, ownerId: string) {
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

export function economicEmergencyFor(state: MatchState, ownerId: string) {
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

export function hasHuntingTerrainPotential(state: MatchState, ownerId: string) {
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
  const protectedAssets = aiObjectEntries(state.scenario, ownerId)
    .flatMap((entry) => entry.object.type === 'castle' || entry.object.type === 'building' ? [entry.position] : [])
  const distanceToProtectedAsset = (position: CellPosition) => Math.min(
    ...protectedAssets.map((asset) => positionDistance(position, asset)),
    positionDistance(position, castle),
  )
  const visibleThreats = visibleEnemySquads(state, ownerId).map((entry) => ({
    distance: distanceToProtectedAsset(entry.position),
    inside: state.scenario.territories[entry.position.row]?.[entry.position.column] === participant.regionId,
    power: troopCompositionPower(entry.object.units, squadHealth(entry.object)),
  }))
  const rememberedThreats = rememberedSquadThreats(state, memory).map((contact) => ({
    distance: distanceToProtectedAsset(contact.position),
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
  const offensivePauseActive = memory.lastOffensiveEndTurn > 0
    && state.turn - memory.lastOffensiveEndTurn <= profile.doctrine.offensivePauseTurns
  const canLaunch = canCross && !offensivePauseActive
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
  const readinessThreshold = forceTargetFor(profile, 'assault', targetPower, profile.riskThreshold)
    * (1 - aiPlannerConfig.readinessEstimateTolerance)
  const offensiveWave = memory.wave === 'main' || memory.wave === 'probe' || memory.wave === 'support' || memory.wave === 'siege'
  const regroupThreshold = Math.max(aiStrategicConfig.phase.regroupMinimumPower,
    Math.min(profile.doctrine.forceTargets.assault.maximum,
      targetPower * profile.riskThreshold * aiStrategicConfig.phase.regroupTargetRatio))
  if (offensiveWave && snapshot.armyPower < regroupThreshold) return 'regroup' as const
  const campaignReady = snapshot.foodRunway >= aiPlannerConfig.foodRunwayTurns
    && snapshot.goldRunway >= aiStrategicConfig.phase.campaignGoldRunway
  const ownParticipant = state.scenario.participants.find((participant) => participant.id === ownerId)
  const hasFieldedArmy = Boolean(ownParticipant && aiObjectEntries(state.scenario, ownerId).some((entry) => (
    entry.object.type === 'squad'
      && state.scenario.territories[entry.position.row]?.[entry.position.column] !== ownParticipant.regionId
  )))
  const followUpTarget = forceTargetFor(profile, 'raid', targetPower,
    aiTacticalConfig.formation.supportAssemblyTargetRatioMinimum)
  if ((memory.wave === 'support' || memory.wave === 'siege') && !hasFieldedArmy
    && snapshot.armyPower < followUpTarget) return 'regroup' as const
  if (canLaunch && offensiveWave && campaignReady && usesProfileArsenal) return 'assault' as const
  const profileProbeThreshold = forceTargetFor(profile, 'probe', targetPower, profile.doctrine.probeRiskThreshold)
    * (1 - aiPlannerConfig.readinessEstimateTolerance)
  // A reconnaissance force must be viable, but it does not need to match every
  // defender that may be protecting the eventual target. Tactical movement and
  // retreat rules keep it from treating this permission as a mandatory battle.
  const probeThreshold = profile.doctrine.maneuverBias < aiStrategicConfig.phase.directDoctrineManeuverCutoff
    ? Math.min(profile.doctrine.forceTargets.probe.maximum, Math.max(profileProbeThreshold, readinessThreshold))
    : profileProbeThreshold
  const launchEconomyReady = snapshot.armyPower >= readinessThreshold ? economyReady : campaignReady
  const stalledProbeReady = memory.idleTurns >= aiPlannerConfig.stalledMobilizationProbeTurns
    && snapshot.armyPower >= profile.doctrine.forceTargets.probe.minimum
  // A healthy army must not wait forever for an ideal force ratio or assembly.
  // After several genuinely idle mobilization turns it may scout toward the
  // objective. Tactical scoring still rejects bad exchanges, so this relaxes
  // reconnaissance rather than authorizing a suicidal attack.
  if (canLaunch && campaignReady && stalledProbeReady) return 'assault' as const
  const stagingAnchors = stagingAnchorsFor(state, ownerId, memory)
  const squads = aiObjectEntries(state.scenario, ownerId).filter((entry) => entry.object.type === 'squad')
  const assembledPower = stagingAnchors.length ? squads.reduce((sum, entry) => stagingAnchors.some((anchor) => (
    positionDistance(entry.position, anchor) <= aiTacticalConfig.staging.assembledRadius
  ))
    ? sum + troopCompositionPower(entry.object.type === 'squad' ? entry.object.units : { militia: 0, spearmen: 0, archers: 0, knights: 0 }, entry.object.type === 'squad' ? squadHealth(entry.object) : undefined)
    : sum, 0) : snapshot.armyPower
  const fieldPower = Math.max(0.1, snapshot.armyPower * (1 - profile.doctrine.defenseForceShare))
  const assemblyThreshold = aiStrategicConfig.phase.assemblyBaseShare
    - profile.doctrine.maneuverBias * aiStrategicConfig.phase.assemblyManeuverDiscount
    + profile.doctrine.musterBias * aiStrategicConfig.phase.assemblyMusterBonus
  const assemblyReady = snapshot.armyPower > 0 && assembledPower / fieldPower >= assemblyThreshold
  if (canLaunch && launchEconomyReady && usesProfileArsenal && assemblyReady && fortificationReadyFor(state, memory)
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
