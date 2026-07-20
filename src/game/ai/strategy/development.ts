import {
  aiBuildingZoneByKind,
  aiPlannerConfig,
  aiStrategicConfig,
} from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import { buildingRules, resourceIds } from '../../../config/rules'
import type { BuildingKind } from '../../map'
import {
  buildingFootprintPositions,
  buildingPlacementFailure,
  buildingResourceCostFor,
  ownedBuildingCount,
  tradeQuoteFor,
  type MatchState,
} from '../../match'
import type { CellPosition } from '../../scenario'
import { clockwiseCardinalDirections } from '../../geometry'
import {
  aiObjectEntries,
  footprintOpportunityCost,
  positionDistance,
  positionKey,
  samePosition,
  type AiWorldAnalysis,
} from '../analysis'
import type {
  AiMemory,
  AiProfileRules,
  AiStrategicPhase,
} from '../model'
import {
  economicEmergencyFor,
  economySnapshotFor,
  hasHuntingTerrainPotential,
  homeThreatFor,
  populationGrowthSupplyFor,
} from './assessment'
import {
  canAfford,
  isTemporarilyBlocked,
  minimumFieldArmySize,
  plannedBuildingLimit,
  settlementZoneKindFor,
} from './shared'
import type { BuildingGoal } from './types'

const foodResources = gameConfig.economy.foodResources

function plannedResourceNeed(profile: AiProfileRules, kind: BuildingKind) {
  const cost = buildingRules[kind].resourceCost
  return resourceIds.reduce((sum, resource) => (
    sum + (cost[resource] ?? 0) * aiStrategicConfig.resourcePlanning.needWeights[resource]
  ), 0) + (profile.allowedBuildings.indexOf(kind) >= 0
    ? aiStrategicConfig.resourcePlanning.allowedBuildingBonus
    : aiStrategicConfig.resourcePlanning.unavailableBuildingPenalty)
}

export function adaptiveBuildingLimitFor(state: MatchState, memory: AiMemory, kind: BuildingKind) {
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

function ownedBuildingAt(state: MatchState, position: CellPosition, kind?: BuildingKind) {
  const object = state.scenario.cells[position.row]?.[position.column]?.object
  return object?.type === 'building' && object.ownerId === state.activeParticipantId
    && (!kind || object.kind === kind)
}

export function nextFortificationStep(state: MatchState, memory: AiMemory): BuildingKind | null {
  const plan = memory.settlementPlan?.fortification
  if (!plan) return null
  for (const line of plan.lines) {
    if (!ownedBuildingAt(state, line.gate, 'barbican')) return 'barbican'
    if (line.walls.some((position) => !ownedBuildingAt(state, position, 'wall'))) return 'wall'
    if (line.towers.some((position) => !ownedBuildingAt(state, position, 'tower'))) return 'tower'
  }
  return null
}

export function minimumFortificationCostFor(memory: AiMemory) {
  const firstLine = memory.settlementPlan?.fortification?.lines[0]
  if (!firstLine) return null
  const minimumWalls = Math.min(firstLine.walls.length, aiStrategicConfig.buildingGoals.minimumViableFortificationWalls)
  return [buildingRules.barbican.resourceCost, ...Array.from({ length: minimumWalls }, () => buildingRules.wall.resourceCost)]
    .reduce((total, current) => {
      resourceIds.forEach((resource) => { total[resource] = (total[resource] ?? 0) + (current[resource] ?? 0) })
      return total
    }, {} as Partial<Record<(typeof resourceIds)[number], number>>)
}

function fortificationStarted(state: MatchState, memory: AiMemory) {
  const plan = memory.settlementPlan?.fortification
  return Boolean(plan && plan.lines.some((line) => (
    [line.gate, ...line.walls, ...line.towers].some((position) => ownedBuildingAt(state, position))
  )))
}

function canFundMinimumFortification(state: MatchState, memory: AiMemory) {
  const plan = memory.settlementPlan?.fortification
  if (!plan) return false
  const cost = minimumFortificationCostFor(memory)
  if (!cost) return false
  const resources = state.domains[state.activeParticipantId].resources
  if (resourceIds.every((resource) => resources[resource] >= (cost[resource] ?? 0))) return true
  const hasMarket = ownedBuildingCount(state, state.activeParticipantId, 'market') > 0
  if (!hasMarket) return false
  const domain = state.domains[state.activeParticipantId]
  const purchaseGold = resourceIds.reduce((total, resource) => {
    if (resource === 'gold') return total
    const shortfall = Math.max(0, (cost[resource] ?? 0) - resources[resource])
    return total + (shortfall > 0 ? tradeQuoteFor(domain, resource, 'buy', shortfall).total : 0)
  }, cost.gold ?? 0)
  return resources.gold >= purchaseGold
}

export function desiredBuildingGoals(
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
  const fortificationStep = nextFortificationStep(state, memory)
  const startedFortification = fortificationStarted(state, memory)
  const mayContinueFortification = startedFortification || phase === 'defense' || canFundMinimumFortification(state, memory)
  if (!economicEmergency && fortificationStep && mayContinueFortification
    && (phase === 'defense' || startedFortification
      || ((phase === 'expansion' || phase === 'mobilization' || phase === 'regroup')
        && snapshot.armySize >= goalConfig.fortificationArmySize))) {
    const continuity = startedFortification ? goalConfig.fortificationContinuityBonus : 0
    if (fortificationStep === 'barbican') {
      add('barbican', (phase === 'defense' ? goalConfig.utility.defenseBarbican : goalConfig.utility.barbican) + continuity,
        'fortification-plan', 'gate-first')
    } else if (fortificationStep === 'wall') {
      add('wall', (phase === 'defense' ? goalConfig.utility.defenseWall : goalConfig.utility.wall) + continuity,
        'fortification-plan', 'connected-curtain')
    } else if (profile.allowedBuildings.includes('tower') && count('tower') < goalConfig.towerLimit
      && (phase === 'defense' || threat.power > 0 || snapshot.armySize >= goalConfig.towerArmySize)) {
      add('tower', goalConfig.utility.tower + continuity, 'fortification-plan', 'line-endpoint')
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
  const fortification = new Set(memory.settlementPlan?.fortification?.lines
    .flatMap((line) => [line.gate, ...line.walls, ...line.towers])
    .map(positionKey) ?? [])
  if (aiBuildingZoneByKind[kind] !== 'defense'
    && [...footprint].some((key) => corridor.has(key) || fortification.has(key))) return false
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
  if (kind === 'tower') score += cell.lineOfFireScore * scoring.towerLineOfFireWeight + cell.hillOpportunity * scoring.towerHillWeight
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

function plannedFortificationPosition(state: MatchState, memory: AiMemory, kind: BuildingKind) {
  const plan = memory.settlementPlan?.fortification
  if (!plan || !['barbican', 'wall', 'tower'].includes(kind)) return null
  for (const line of plan.lines) {
    if (kind === 'barbican' && !ownedBuildingAt(state, line.gate, 'barbican')) return line.gate
    if (kind === 'wall') {
      if (!ownedBuildingAt(state, line.gate, 'barbican')) return null
      const wall = line.walls.find((position) => !ownedBuildingAt(state, position, 'wall'))
      if (wall) return wall
    }
    if (kind === 'tower') {
      if (line.walls.some((position) => !ownedBuildingAt(state, position, 'wall'))) return null
      const tower = line.towers.find((position) => !ownedBuildingAt(state, position, 'tower'))
      if (tower) return tower
    }
  }
  return null
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
  if (aiBuildingZoneByKind[kind] === 'defense' && memory.settlementPlan?.fortification) {
    const planned = plannedFortificationPosition(state, memory, kind)
    if (!planned || isTemporarilyBlocked(memory, planned, state.turn)
      || !preservesAccess(state, kind, planned, memory, accessSources)) return null
    return buildingPlacementFailure(state, kind, planned) === null ? planned : null
  }
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

export function fundedStoneGoalFor(
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
