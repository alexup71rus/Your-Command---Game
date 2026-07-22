import { aiBuildingZoneByKind, aiPlannerConfig, aiSpatialConfig, aiStrategicConfig } from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import { buildingRules } from '../../../config/rules'
import type { BuildingKind, GameMap } from '../../map'
import {
  buildingFootprintPositions,
  buildingPlacementFailure,
  buildingResourceCostFor,
  buildingSiteFailure,
  ownedBuildingCount,
  tradeQuoteFor,
  type MatchState,
} from '../../match'
import type { CellPosition } from '../../scenario'
import { clockwiseCardinalDirections } from '../../geometry'
import { findMovementPath } from '../../pathfinding'
import { aiObjectEntries, footprintOpportunityCost, positionDistance, positionKey, samePosition, type AiWorldAnalysis } from '../analysis'
import type { AiMemory, AiProfileRules, AiSettlementPlan, AiStrategicPhase } from '../model'
import { economicEmergencyFor, economySnapshotFor, homeThreatFor, populationGrowthSupplyFor } from './assessment'
import { canAfford, isTemporarilyBlocked, minimumFieldArmySize, plannedBuildingLimit, settlementZoneKindFor } from './shared'
import type { BuildingGoal } from './types'
import {
  canFundMinimumFortification,
  fortificationLineActivated,
  fortificationStarted,
  nextFortificationStep,
  ownedBuildingAt,
} from './fortifications'
import {
  adaptiveBuildingLimitFor,
  desiredProducerCount,
  plannedResourceNeed,
  remainingConstructionNeed,
  seededBuildingGoalVariation,
  seededSiteRank,
  settlementZoneHasCapacity,
} from './developmentPolicy'

export {
  fortificationLineActivated,
  fortificationLineStarted,
  fortificationStarted,
  minimumFortificationCostFor,
  nextFortificationStep,
} from './fortifications'
export { adaptiveBuildingLimitFor } from './developmentPolicy'

const foodResources = gameConfig.economy.foodResources

interface PlacementSpatialMetrics {
  footprint: CellPosition[]
  opportunityCost: number
  tier: number
  zoneCoverage: number
  zoneDistance: number
}

interface PlacementGeometry {
  local: CellPosition[]
  regional: CellPosition[]
  metricsByPosition: Map<string, PlacementSpatialMetrics>
}

let activePlacementGeometryCache: WeakMap<AiSettlementPlan, WeakMap<AiWorldAnalysis, Map<string, PlacementGeometry>>> | null = null
let activeAccessPathCache: WeakMap<GameMap, Map<string, CellPosition[] | null>> | null = null

export function withStrategicPlacementCache<T>(run: () => T): T {
  const previousCache = activePlacementGeometryCache
  const previousAccessPathCache = activeAccessPathCache
  activePlacementGeometryCache = new WeakMap()
  activeAccessPathCache = new WeakMap()
  try {
    return run()
  } finally {
    activePlacementGeometryCache = previousCache
    activeAccessPathCache = previousAccessPathCache
  }
}

function placementGeometryFor(
  analysis: AiWorldAnalysis,
  memory: AiMemory,
  kind: BuildingKind,
  adaptiveShiftRadius: number,
): PlacementGeometry {
  const plan = memory.settlementPlan
  const zone = plan?.zones[settlementZoneKindFor(kind)]
  const create = () => {
    const localByKey = new Map<string, CellPosition>()
    if (zone?.cells.length) {
      zone.cells.forEach((origin) => {
        for (let deltaRow = -adaptiveShiftRadius; deltaRow <= adaptiveShiftRadius; deltaRow += 1) {
          const remaining = adaptiveShiftRadius - Math.abs(deltaRow)
          for (let deltaColumn = -remaining; deltaColumn <= remaining; deltaColumn += 1) {
            const position = { column: origin.column + deltaColumn, row: origin.row + deltaRow }
            const key = positionKey(position)
            if (!localByKey.has(key)) localByKey.set(key, position)
          }
        }
      })
    } else {
      analysis.cells.forEach((row, rowIndex) =>
        row.forEach((cell, column) => {
          if (!cell.inRegion) return
          const position = { column, row: rowIndex }
          localByKey.set(positionKey(position), position)
        }),
      )
    }
    const regional: CellPosition[] = []
    analysis.cells.forEach((row, rowIndex) =>
      row.forEach((cell, column) => {
        if (!cell.inRegion) return
        const position = { column, row: rowIndex }
        if (!localByKey.has(positionKey(position))) regional.push(position)
      }),
    )
    const zoneCells = zone?.cells ?? []
    const zoneKeys = new Set(zoneCells.map(positionKey))
    const metricsByPosition = new Map<string, PlacementSpatialMetrics>()
    const metricsFor = (position: CellPosition) => {
      const footprint = buildingFootprintPositions(kind, position)
      const zoneCoverage =
        footprint.length > 0 ? footprint.filter((candidate) => zoneKeys.has(positionKey(candidate))).length / footprint.length : 0
      const zoneDistance = zoneCells.length > 0 ? Math.min(...zoneCells.map((candidate) => positionDistance(position, candidate))) : 0
      const tier =
        zoneCoverage >= aiStrategicConfig.placement.preferredZoneCoverage ? 0 : zoneDistance <= (zone?.overflowRadius ?? 0) ? 1 : 2
      metricsByPosition.set(positionKey(position), {
        footprint,
        opportunityCost: footprintOpportunityCost(analysis, kind, position),
        tier,
        zoneCoverage,
        zoneDistance,
      })
    }
    localByKey.forEach(metricsFor)
    regional.forEach(metricsFor)
    return { local: [...localByKey.values()], regional, metricsByPosition }
  }
  if (!plan || !activePlacementGeometryCache) return create()
  let byAnalysis = activePlacementGeometryCache.get(plan)
  if (!byAnalysis) {
    byAnalysis = new WeakMap()
    activePlacementGeometryCache.set(plan, byAnalysis)
  }
  let byKindAndRadius = byAnalysis.get(analysis)
  if (!byKindAndRadius) {
    byKindAndRadius = new Map()
    byAnalysis.set(analysis, byKindAndRadius)
  }
  const key = `${kind}:${adaptiveShiftRadius}`
  let geometry = byKindAndRadius.get(key)
  if (!geometry) {
    geometry = create()
    byKindAndRadius.set(key, geometry)
  }
  return geometry
}

function openingBuildingBonus(memory: AiMemory, kind: BuildingKind) {
  const opening = memory.settlementPlan?.opening
  if (!opening) return 0
  const bonuses: Partial<Record<BuildingKind, number>> = aiStrategicConfig.openingBuildingBonus[opening]
  return bonuses[kind] ?? 0
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
  const huntingTerrainAvailable = analysis.cells.some((row) =>
    row.some(
      (cell) => cell.inRegion && cell.passable && cell.adjacentForest >= (buildingRules.huntingLodge.minimumAdjacentForestCells ?? 0),
    ),
  )
  // A profile's food-quarter size is a total spatial budget, not a mandate to
  // starve when one intended food source is absent from the map.
  const adaptiveLimit = (kind: BuildingKind) => adaptiveBuildingLimitFor(state, profile, memory, kind)
  const desiredLumberMills = desiredProducerCount(state, profile, memory, 'lumberMill', 'wood')
  const primaryFortification = memory.settlementPlan?.fortification?.lines[0]
  const enclosureFoundationMature = count('house') >= goalConfig.enclosureMinimumHouses && count('barracks') > 0
  const enclosureQuarryFloor =
    primaryFortification?.kind === 'enclosure' && enclosureFoundationMature
      ? Math.min(plannedBuildingLimit(memory, 'quarry'), goalConfig.enclosureMinimumQuarries)
      : 0
  const desiredQuarries = Math.max(desiredProducerCount(state, profile, memory, 'quarry', 'stone'), enclosureQuarryFloor)
  const add = (kind: BuildingKind, utility: number, ...factors: string[]) => {
    const requiredWorkers = buildingRules[kind].workersRequired ?? 0
    const essentialInCrisis =
      (phase === 'survival' || phase === 'recovery' || economicEmergency) && aiStrategicConfig.crisisProductionBuildings.includes(kind)
    // Requiring two *additional* idle workers from every expansion building can
    // deadlock a compact settlement: its last free worker is exactly what must
    // start the food/service building that allows the next citizens to appear.
    const enablesFoodGrowth = aiBuildingZoneByKind[kind] === 'food' && snapshot.workforceFree >= requiredWorkers
    const enablesServiceGrowth =
      kind === 'kitchen' &&
      snapshot.workforceFree >= requiredWorkers &&
      snapshot.foodServiceCapacity <= domain.population &&
      snapshot.residentialCapacity >= domain.population
    const enablesPopulationGrowth = enablesFoodGrowth || enablesServiceGrowth
    const structuralPrerequisite = kind === 'quarry' && count('quarry') < enclosureQuarryFloor
    const keepsWorkerReserve =
      requiredWorkers === 0 ||
      snapshot.workforceFree >= requiredWorkers + aiStrategicConfig.workerReserve ||
      essentialInCrisis ||
      enablesPopulationGrowth ||
      structuralPrerequisite
    if (
      profile.allowedBuildings.includes(kind) &&
      count(kind) < adaptiveLimit(kind) &&
      settlementZoneHasCapacity(state, profile, memory, kind, phase) &&
      keepsWorkerReserve
    ) {
      const variation = seededBuildingGoalVariation(state.scenario.seed, ownerId, kind, memory)
      goals.push({
        kind,
        utility: utility + openingBuildingBonus(memory, kind) + variation,
        factors: [...factors, `seed-variation:${variation.toFixed(1)}`],
      })
    }
  }
  // Resource flow is production minus this turn's consumption. Treating that
  // net value as production made a sustainable settlement at its housing cap
  // look under-supplied, so it refused both the next house and the food needed
  // for growth. Use the authoritative gross production calculation instead.
  const { foodProduction, growthFoodDemand, sustainable: sustainablyFeedsGrowth } = populationGrowthSupplyFor(state, ownerId)
  const expectsGrowth = snapshot.housingCapacity > domain.population + 1 && snapshot.foodServiceCapacity > domain.population + 1
  const wantsFood =
    !snapshot.forecastFed ||
    snapshot.foodRunway < aiPlannerConfig.foodRunwayTurns ||
    (!sustainablyFeedsGrowth && (expectsGrowth || snapshot.housingCapacity <= domain.population + 1))

  if (wantsFood) {
    const foodScale = Math.max(0, snapshot.foodDemand - foodProduction)
    if (count('huntingLodge') < adaptiveLimit('huntingLodge') && (count('huntingLodge') === 0 || foodProduction < growthFoodDemand))
      add('huntingLodge', goalConfig.utility.huntingLodge + foodScale, 'food-runway', 'forest-edge')
    if (count('orchard') < adaptiveLimit('orchard') && (count('orchard') === 0 || foodProduction < growthFoodDemand))
      add(
        'orchard',
        goalConfig.utility.orchard + foodScale,
        'food-runway',
        huntingTerrainAvailable ? 'compact-food' : 'substitute-missing-hunt',
      )
    if (profile.allowedBuildings.includes('farm')) {
      if (count('mill') === 0) add('mill', goalConfig.utility.mill + foodScale, 'farm-chain')
      else if (foodProduction < Math.max(snapshot.foodDemand * goalConfig.farmDemandMultiplier, growthFoodDemand)) {
        const farmSupportCapacity = buildingRules.mill.farmSupport?.capacity ?? 0
        if (count('farm') < count('mill') * farmSupportCapacity) {
          const unusedClusterBonus = count('farm') < count('mill') ? goalConfig.farmClusterPriorityBonus : 0
          add(
            'farm',
            goalConfig.utility.farm + foodScale + unusedClusterBonus,
            'supported-farm',
            ...(unusedClusterBonus > 0 ? ['fill-new-mill-cluster'] : []),
          )
        }
        // One theoretically unused support slot is not proof that another
        // 2x2 farm can fit around this mill. In a mature settlement, opening a
        // second milling cluster gives placement search a new centre instead
        // of retrying the same unreachable farm forever.
        if (count('farm') > 0 && count('farm') >= count('mill') && count('mill') < adaptiveLimit('mill')) {
          add('mill', goalConfig.utility.mill + foodScale - 8, 'expand-farm-cluster')
        }
      }
    }
  }
  const hasLumberPotential = analysis.cells.some((row) =>
    row.some((cell) => cell.inRegion && cell.passable && cell.adjacentForest >= (buildingRules.lumberMill.minimumAdjacentForestCells ?? 0)),
  )
  if (
    hasLumberPotential &&
    count('lumberMill') < Math.min(goalConfig.maximumLumberMills, desiredLumberMills) &&
    (count('lumberMill') === 0 ||
      snapshot.resourceFlow.wood <
        remainingConstructionNeed(state, profile, memory, 'wood') / aiStrategicConfig.constructionPlanningHorizonTurns ||
      domain.resources.wood < goalConfig.lowWoodThreshold)
  ) {
    add('lumberMill', goalConfig.utility.lumberMill, count('lumberMill') === 0 ? 'wood-recovery' : 'construction-throughput')
  }
  const housingSlack = snapshot.residentialCapacity - domain.population
  const serviceSlack = snapshot.foodServiceCapacity - domain.population
  const growthFoodReady = snapshot.forecastFed && snapshot.foodRunway >= aiPlannerConfig.foodRunwayTurns && sustainablyFeedsGrowth
  // Soldiers consume residential capacity too. A developed army can therefore
  // leave civilians exactly at the housing ceiling with too few free workers
  // to start the next food building. If the current population is fed and has
  // a real stockpile runway, a house is the bridge that supplies those workers;
  // the AI can then expand production before the reserve is exhausted.
  const workforceUnlockHousing =
    snapshot.forecastFed &&
    snapshot.foodRunway >= aiPlannerConfig.foodRunwayTurns &&
    housingSlack <= 0 &&
    snapshot.workforceFree < aiStrategicConfig.workerReserve
  if (
    growthFoodReady &&
    serviceSlack <= goalConfig.kitchenBeforeGrowthServiceSlack &&
    housingSlack <= goalConfig.kitchenBeforeGrowthHousingSlack &&
    snapshot.foodServiceCapacity <= snapshot.residentialCapacity &&
    count('kitchen') < adaptiveLimit('kitchen')
  )
    add('kitchen', goalConfig.utility.kitchenBeforeGrowth, 'food-service-before-growth')
  if (
    (growthFoodReady || workforceUnlockHousing) &&
    housingSlack <= goalConfig.houseHousingSlack &&
    snapshot.foodServiceCapacity >= domain.population + goalConfig.houseFutureService
  ) {
    add(
      'house',
      goalConfig.utility.house + (workforceUnlockHousing ? 28 : 0),
      'housing-slack',
      ...(workforceUnlockHousing ? ['unlock-workforce'] : []),
    )
  }
  if (
    growthFoodReady &&
    serviceSlack <= goalConfig.kitchenServiceSlack &&
    count('house') >= 1 &&
    snapshot.foodServiceCapacity < snapshot.residentialCapacity &&
    count('kitchen') < adaptiveLimit('kitchen')
  )
    add('kitchen', goalConfig.utility.kitchen, 'food-service')

  const futureStoneNeed = remainingConstructionNeed(state, profile, memory, 'stone')
  const stoneTarget = Math.max(
    aiStrategicConfig.resourcePlanning.minimumStoneTarget,
    futureStoneNeed * aiStrategicConfig.resourcePlanning.futureStoneShare,
  )
  const enclosureQuarryMissing = count('quarry') < enclosureQuarryFloor
  if (
    count('quarry') < desiredQuarries &&
    (enclosureQuarryMissing ||
      domain.resources.stone < stoneTarget ||
      snapshot.resourceFlow.stone < futureStoneNeed / aiStrategicConfig.constructionPlanningHorizonTurns)
  ) {
    add(
      'quarry',
      goalConfig.utility.quarry,
      enclosureQuarryMissing ? 'fortification-foundation' : count('quarry') === 0 ? 'planned-stone' : 'construction-throughput',
    )
  }
  const hasBarracks = count('barracks') > 0
  const expandsRecruitmentCapacity =
    hasBarracks &&
    count('barracks') < adaptiveLimit('barracks') &&
    snapshot.armySize >= count('barracks') * aiStrategicConfig.recruitmentCellCapacity * aiStrategicConfig.placement.minimumRecruitmentExits
  const desiredArmySize = minimumFieldArmySize(profile)
  const needsRecruitmentTrade =
    hasBarracks && snapshot.armySize < desiredArmySize && domain.resources.flour < aiStrategicConfig.market.recruitmentFlourThreshold
  const marketCost = buildingRules.market.resourceCost.gold ?? 0
  const emergencyFoodBatchCost = Math.min(
    ...foodResources.map((resource) => tradeQuoteFor(domain, resource, 'buy', aiStrategicConfig.emergencyFoodBatch).total),
  )
  const goldAfterMarket = domain.resources.gold - marketCost
  const saleGoldPotential = Math.max(
    0,
    ...(['wood', 'stone', 'ore', 'flour', 'meat', 'fruit'] as const).map((resource) => {
      const surplus = domain.resources[resource] - (profile.strategicReserve[resource] ?? 0)
      if (surplus < aiStrategicConfig.market.minimumSaleSurplus) return 0
      const quantity = Math.min(aiStrategicConfig.market.saleBatch, Math.floor(surplus))
      return tradeQuoteFor(domain, resource, 'sell', quantity).total
    }),
  )
  const marketHasFollowUp = goldAfterMarket + saleGoldPotential >= emergencyFoodBatchCost
  const stoneRecoveryGoal =
    count('market') === 0 && snapshot.resourceFlow.stone <= 0 ? fundedStoneGoalFor(state, analysis, memory, goals, countNode) : null
  const stoneRecoveryFunded = stoneRecoveryGoal
    ? goldAfterMarket + saleGoldPotential >=
      tradeQuoteFor(domain, 'stone', 'buy', stoneRecoveryGoal.shortfall).total +
        (buildingResourceCostFor(state, ownerId, stoneRecoveryGoal.kind).gold ?? 0)
    : false
  if (
    count('market') === 0 &&
    ((marketHasFollowUp &&
      (phase === 'recovery' ||
        economicEmergency ||
        domain.resources.gold < goalConfig.lowGoldMarketThreshold ||
        usesIndustry ||
        needsRecruitmentTrade)) ||
      stoneRecoveryFunded)
  ) {
    add(
      'market',
      stoneRecoveryGoal ? goalConfig.utility.fundedMarket : goalConfig.utility.market,
      'recovery-market',
      stoneRecoveryGoal ? `stone-for:${stoneRecoveryGoal.kind}` : 'funded-follow-up',
    )
  }
  if (((!hasBarracks && domain.population >= goalConfig.barracksMinimumPopulation) || expandsRecruitmentCapacity) && phase !== 'recovery') {
    const urgentMilitaryUnlock =
      phase === 'mobilization' ||
      phase === 'assault' ||
      phase === 'regroup' ||
      phase === 'defense' ||
      snapshot.armySize >= aiStrategicConfig.basicMilitiaBeforeBarracks ||
      domain.population >= goalConfig.barracksUrgentPopulation
    add(
      'barracks',
      urgentMilitaryUnlock ? goalConfig.utility.urgentBarracks : goalConfig.utility.barracks,
      'military-unlock',
      expandsRecruitmentCapacity ? 'expand-recruitment-exits' : urgentMilitaryUnlock ? 'field-force-unlock' : 'civilian-opening',
    )
  }

  if (usesIndustry && phase !== 'recovery' && snapshot.foodRunway >= goalConfig.industryFoodRunway) {
    if (count('mine') === 0) add('mine', goalConfig.utility.mine, 'iron-chain')
    else if (
      count('smelter') === 0 &&
      snapshot.forecastFed &&
      (domain.resources.ore >= goalConfig.smelterOreStock || snapshot.resourceFlow.ore > 0)
    ) {
      add('smelter', goalConfig.utility.smelter, 'iron-chain', 'food-secured')
    }
    if (
      (phase === 'expansion' || phase === 'mobilization') &&
      count('church') === 0 &&
      domain.population >= goalConfig.churchMinimumPopulation &&
      snapshot.foodRunway >= goalConfig.churchFoodRunway &&
      snapshot.goldRunway >= goalConfig.churchGoldRunway
    )
      add('church', goalConfig.utility.church, 'late-growth')
  }

  const threat = homeThreatFor(state, ownerId, memory)
  const fortificationStep = nextFortificationStep(state, memory, phase === 'defense')
  const startedFortification = fortificationStarted(state, memory)
  const firstFortification = primaryFortification
  const enclosureFoundationReady =
    firstFortification?.kind !== 'enclosure' ||
    (count('house') >= goalConfig.enclosureMinimumHouses && count('quarry') >= goalConfig.enclosureMinimumQuarries && count('barracks') > 0)
  const mayContinueFortification =
    startedFortification || phase === 'defense' || (enclosureFoundationReady && canFundMinimumFortification(state, memory))
  if (
    !economicEmergency &&
    fortificationStep &&
    mayContinueFortification &&
    (phase === 'defense' ||
      startedFortification ||
      ((phase === 'expansion' || phase === 'mobilization' || phase === 'regroup') &&
        enclosureFoundationReady &&
        snapshot.armySize >= goalConfig.fortificationArmySize))
  ) {
    const continuity = startedFortification ? goalConfig.fortificationContinuityBonus : 0
    if (fortificationStep === 'barbican') {
      add(
        'barbican',
        (phase === 'defense' ? goalConfig.utility.defenseBarbican : goalConfig.utility.barbican) + continuity,
        'fortification-plan',
        'gate-first',
        `foundation:${firstFortification?.kind ?? 'none'}:h${count('house')}:q${count('quarry')}:b${count('barracks')}`,
      )
    } else if (fortificationStep === 'wall') {
      add(
        'wall',
        (phase === 'defense' ? goalConfig.utility.defenseWall : goalConfig.utility.wall) + continuity,
        'fortification-plan',
        'connected-curtain',
      )
    } else if (
      profile.allowedBuildings.includes('tower') &&
      count('tower') < adaptiveLimit('tower') &&
      (phase === 'defense' || threat.power > 0 || snapshot.armySize >= goalConfig.towerArmySize)
    ) {
      add('tower', goalConfig.utility.tower + continuity, 'fortification-plan', 'line-endpoint')
    }
  }

  return goals
    .filter((goal, index, all) => all.findIndex((candidate) => candidate.kind === goal.kind) === index)
    .sort(
      (first, second) =>
        second.utility - first.utility ||
        plannedResourceNeed(profile, second.kind) - plannedResourceNeed(profile, first.kind) ||
        first.kind.localeCompare(second.kind),
    )
}

function zoneTargetFor(state: MatchState, kind: BuildingKind, memory: AiMemory) {
  const reservedBuilding = memory.settlementPlan?.reservedBuildingSites?.[kind]
  if (reservedBuilding && ownedBuildingCount(state, state.activeParticipantId, kind) === 0) {
    return reservedBuilding
  }
  const sites = memory.settlementPlan?.reservedSites
  if (!sites) return null
  if (kind === 'house' || kind === 'kitchen' || kind === 'church' || kind === 'market') return sites.housing ?? null
  if (kind === 'farm' || kind === 'mill' || kind === 'orchard' || kind === 'huntingLodge') return sites.food ?? null
  if (kind === 'quarry' || kind === 'mine' || kind === 'smelter' || kind === 'lumberMill') return sites.industry ?? sites.food ?? null
  if (kind === 'barbican' || kind === 'wall') return sites.gate ?? sites.military ?? null
  if (kind === 'tower')
    return ownedBuildingCount(state, state.activeParticipantId, 'tower') === 0
      ? (sites.leftTower ?? sites.rightTower ?? sites.military ?? null)
      : (sites.rightTower ?? sites.leftTower ?? sites.military ?? null)
  return sites.military ?? null
}

function potentialFutureFarmSitesForMill(state: MatchState, mill: CellPosition, memory: AiMemory) {
  const support = buildingRules.mill.farmSupport
  const farmFootprint = buildingRules.farm.footprint
  const regionId = state.scenario.participants.find((participant) => participant.id === state.activeParticipantId)?.regionId
  if (!support || !farmFootprint || !regionId) return []
  const reserved = new Set(
    [
      ...(memory.settlementPlan?.reservedCorridors ?? []),
      ...(memory.settlementPlan?.reservedAccessRoutes ?? []),
      ...(memory.settlementPlan?.fortification?.lines.flatMap((line) => [line.gate, ...line.walls, ...line.towers]) ?? []),
    ].map(positionKey),
  )
  const result: Array<{ origin: CellPosition; positions: CellPosition[]; distance: number }> = []
  for (let row = mill.row - support.radius - farmFootprint.rows + 1; row <= mill.row + support.radius; row += 1) {
    for (let column = mill.column - support.radius - farmFootprint.columns + 1; column <= mill.column + support.radius; column += 1) {
      const origin = { column, row }
      const positions = buildingFootprintPositions('farm', origin)
      if (positions.length === 0 || positions.some((position) => samePosition(position, mill))) continue
      if (
        positions.some((position) => {
          const cell = state.scenario.cells[position.row]?.[position.column]
          return (
            !cell ||
            cell.object ||
            cell.landform !== 'plain' ||
            cell.vegetation ||
            state.scenario.territories[position.row]?.[position.column] !== regionId ||
            reserved.has(positionKey(position))
          )
        })
      )
        continue
      const distance = Math.min(...positions.map((position) => positionDistance(position, mill)))
      if (distance <= support.radius) result.push({ origin, positions, distance })
    }
  }
  return result.sort(
    (first, second) =>
      first.distance - second.distance || first.origin.row - second.origin.row || first.origin.column - second.origin.column,
  )
}

function reservedFutureFarmCells(state: MatchState, memory: AiMemory) {
  const capacity = buildingRules.mill.farmSupport?.capacity ?? 0
  const mills = aiObjectEntries(state.scenario, state.activeParticipantId).filter(
    (entry) => entry.object.type === 'building' && entry.object.kind === 'mill',
  )
  const farms = aiObjectEntries(state.scenario, state.activeParticipantId).filter(
    (entry) => entry.object.type === 'building' && entry.object.kind === 'farm',
  )
  const reserved = new Set<string>()
  mills.forEach((mill) => {
    const supported = farms.filter((farm) =>
      buildingFootprintPositions('farm', farm.position).some(
        (position) => positionDistance(position, mill.position) <= (buildingRules.mill.farmSupport?.radius ?? 0),
      ),
    ).length
    let needed = Math.max(0, capacity - supported)
    for (const candidate of potentialFutureFarmSitesForMill(state, mill.position, memory)) {
      if (needed <= 0) break
      if (candidate.positions.some((position) => reserved.has(positionKey(position)))) continue
      candidate.positions.forEach((position) => reserved.add(positionKey(position)))
      needed -= 1
    }
  })
  return reserved
}

function baselineAccessPath(state: MatchState, from: CellPosition, to: CellPosition, capabilityReservations: ReadonlySet<string>) {
  const calculate = () =>
    findMovementPath(state.scenario.cells, from, to, {
      ownerId: state.activeParticipantId,
      canEnterOccupiedCell: (pathPosition) => {
        const object = state.scenario.cells[pathPosition.row]?.[pathPosition.column]?.object
        return object?.type === 'squad' && object.ownerId === state.activeParticipantId
      },
      cellCost: (pathPosition) => (capabilityReservations.has(positionKey(pathPosition)) ? Number.POSITIVE_INFINITY : 1),
    })
  if (!activeAccessPathCache) return calculate()
  let pathsForMap = activeAccessPathCache.get(state.scenario.cells)
  if (!pathsForMap) {
    pathsForMap = new Map()
    activeAccessPathCache.set(state.scenario.cells, pathsForMap)
  }
  const key = `${state.activeParticipantId}:${positionKey(from)}>${positionKey(to)}:${[...capabilityReservations].join(',')}`
  if (!pathsForMap.has(key)) pathsForMap.set(key, calculate())
  const path = pathsForMap.get(key)
  return path?.map((position) => ({ ...position })) ?? null
}

function preservesAccess(
  state: MatchState,
  kind: BuildingKind,
  position: CellPosition,
  memory: AiMemory,
  sources = aiObjectEntries(state.scenario, state.activeParticipantId).filter(
    (entry) => entry.object.type === 'castle' || (entry.object.type === 'building' && entry.object.kind === 'barracks'),
  ),
) {
  const footprint = new Set(buildingFootprintPositions(kind, position).map(positionKey))
  const corridor = new Set(memory.settlementPlan?.reservedCorridors.map(positionKey) ?? [])
  memory.settlementPlan?.reservedAccessRoutes?.forEach((position) => corridor.add(positionKey(position)))
  const fortification = new Set(
    memory.settlementPlan?.fortification?.lines.flatMap((line) => [line.gate, ...line.walls, ...line.towers]).map(positionKey) ?? [],
  )
  const outpost = memory.settlementPlan?.reservedSites.outpostTower
  if (outpost) fortification.add(positionKey(outpost))
  if (aiBuildingZoneByKind[kind] !== 'defense' && [...footprint].some((key) => corridor.has(key) || fortification.has(key))) return false
  const capabilityReservations = new Set(
    Object.entries(memory.settlementPlan?.reservedBuildingSites ?? {}).flatMap(([reservedKind, origin]) => {
      const capability = reservedKind as BuildingKind
      if (!origin || capability === kind || ownedBuildingCount(state, state.activeParticipantId, capability) > 0) return []
      return buildingFootprintPositions(capability, origin).map(positionKey)
    }),
  )
  if ([...footprint].some((key) => capabilityReservations.has(key))) return false
  if (kind !== 'farm' && kind !== 'mill') {
    const futureFarms = reservedFutureFarmCells(state, memory)
    if ([...footprint].some((key) => futureFarms.has(key))) return false
  }
  const castle = sources.find((entry) => entry.object.type === 'castle')?.position
  if (
    castle &&
    memory.settlementPlan?.reservedAccessTargets?.some((target) => {
      // Evaluate roads against both the candidate and every still-missing
      // reserved capability. Otherwise the only quarry road may quietly route
      // through the empty smelter footprint and become impossible the moment the
      // planned smelter is finally placed.
      const routeBlocked = (position: CellPosition) =>
        footprint.has(positionKey(position)) || capabilityReservations.has(positionKey(position))
      const targetBlocked = routeBlocked(target) || Boolean(state.scenario.cells[target.row]?.[target.column]?.object)
      const destinations = targetBlocked
        ? clockwiseCardinalDirections.map((direction) => ({
            column: target.column + direction.column,
            row: target.row + direction.row,
          }))
        : [target]
      return !destinations.some((destination) => {
        const cell = state.scenario.cells[destination.row]?.[destination.column]
        if (!cell || cell.landform === 'peak' || routeBlocked(destination)) return false
        if (samePosition(castle, destination)) return true
        const baseline = baselineAccessPath(state, castle, destination, capabilityReservations)
        if (!baseline) return false
        if (baseline.every((pathPosition) => !footprint.has(positionKey(pathPosition)))) return true
        return Boolean(
          findMovementPath(state.scenario.cells, castle, destination, {
            ownerId: state.activeParticipantId,
            // Friendly squads are transient traffic, not permanent geometry.
            // Treating a mustering unit as a wall made the castle builder reject
            // the remaining enclosure cells even though that unit can move away.
            canEnterOccupiedCell: (pathPosition) => {
              const object = state.scenario.cells[pathPosition.row]?.[pathPosition.column]?.object
              return object?.type === 'squad' && object.ownerId === state.activeParticipantId
            },
            cellCost: (pathPosition) => (routeBlocked(pathPosition) ? Number.POSITIVE_INFINITY : 1),
          }),
        )
      })
    })
  )
    return false
  const accessSources =
    kind === 'barracks'
      ? [
          ...sources,
          {
            object: {
              type: 'building' as const,
              kind,
              ownerId: state.activeParticipantId,
              hitPoints: 1,
              maxHitPoints: 1,
              constructionCost: {},
            },
            position,
          },
        ]
      : sources
  return accessSources.every((source) => {
    const sourceCells =
      source.object.type === 'building' ? buildingFootprintPositions(source.object.kind, source.position) : [source.position]
    const perimeter = sourceCells
      .flatMap((cell) =>
        clockwiseCardinalDirections.map((direction) => ({ column: cell.column + direction.column, row: cell.row + direction.row })),
      )
      .filter(
        (cell, index, all) =>
          !sourceCells.some((sourceCell) => samePosition(sourceCell, cell)) &&
          all.findIndex((candidate) => samePosition(candidate, cell)) === index,
      )
    const free = perimeter.filter((cell) => {
      const mapCell = state.scenario.cells[cell.row]?.[cell.column]
      const movableSquad = mapCell?.object?.type === 'squad' && mapCell.object.ownerId === state.activeParticipantId
      return (
        mapCell &&
        mapCell.landform !== 'peak' &&
        (!mapCell.object || movableSquad) &&
        !footprint.has(positionKey(cell)) &&
        !fortification.has(positionKey(cell))
      )
    }).length
    return free >= aiStrategicConfig.placement.minimumRecruitmentExits
  })
}

function hasViableFutureFarmSiteForMill(
  state: MatchState,
  mill: CellPosition,
  memory: AiMemory,
  accessSources: ReturnType<typeof aiObjectEntries>,
) {
  return potentialFutureFarmSitesForMill(state, mill, memory).some((candidate) =>
    preservesAccess(state, 'farm', candidate.origin, memory, accessSources),
  )
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
  spatial: PlacementSpatialMetrics,
) {
  const scoring = aiStrategicConfig.placement
  const cell = analysis.cells[position.row]?.[position.column]
  if (!cell?.inRegion) return Number.NEGATIVE_INFINITY
  const target = context.target
  const targetDistance = target ? positionDistance(position, target) : cell.distanceToCastle
  let score =
    -targetDistance * scoring.targetDistanceWeight -
    spatial.opportunityCost +
    spatial.zoneCoverage * scoring.zoneCoverageWeight -
    spatial.zoneDistance * scoring.zoneDistanceWeight
  if (kind === 'lumberMill' || kind === 'huntingLodge') {
    score += cell.adjacentForest * scoring.forestAdjacencyWeight - cell.distanceToForest * scoring.forestDistanceWeight
  }
  if (kind === 'quarry' || kind === 'mine') score += cell.hillOpportunity * scoring.hillOpportunityWeight
  if (kind === 'house' || kind === 'kitchen') score += Math.max(0, scoring.homeRadius - cell.distanceToCastle) * scoring.homeProximityWeight
  if (kind === 'barbican') score += cell.chokeScore * scoring.barbicanChokeWeight
  if (kind === 'wall')
    score += cell.chokeScore * scoring.wallChokeWeight + (target ? Math.max(0, scoring.wallFrontRadius - targetDistance) : 0)
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
      ? scoring.courtyardFoodRadius
      : scoring.courtyardOrdinaryRadius
    score -= Math.abs(cell.distanceToCastle - preferredRadius) * scoring.courtyardRadiusPenalty
  }
  if (memory.settlementPlan?.layout === 'strongpoint' && (aiBuildingZoneByKind[kind] === 'defense' || kind === 'barracks')) {
    score += Math.max(0, scoring.strongpointFrontRadius - positionDistance(position, analysis.front)) * scoring.strongpointFrontWeight
  }
  return score
}

function plannedFortificationPosition(state: MatchState, memory: AiMemory, kind: BuildingKind) {
  const plan = memory.settlementPlan?.fortification
  if (!['barbican', 'wall', 'tower'].includes(kind)) return null
  if (plan) {
    for (const line of plan.lines) {
      if (!fortificationLineActivated(state, line)) continue
      if (kind === 'barbican' && !ownedBuildingAt(state, line.gate, 'barbican')) return line.gate
      if (kind === 'wall') {
        if (!ownedBuildingAt(state, line.gate, 'barbican')) return null
        const ownedWalls = line.walls.filter((position) => ownedBuildingAt(state, position, 'wall')).length
        const ownsTower = line.towers.some((position) => ownedBuildingAt(state, position, 'tower'))
        const minimumWallsBeforeTower =
          line.towers.length > 0
            ? Math.min(line.walls.length, aiStrategicConfig.buildingGoals.minimumViableFortificationWalls)
            : line.walls.length
        if (!ownsTower && ownedWalls >= minimumWallsBeforeTower && line.towers.length > 0) return null
        const wall = line.walls.find((position) => !ownedBuildingAt(state, position, 'wall'))
        if (wall) return wall
      }
      if (kind === 'tower') {
        const ownedWalls = line.walls.filter((position) => ownedBuildingAt(state, position, 'wall')).length
        const ownsTower = line.towers.some((position) => ownedBuildingAt(state, position, 'tower'))
        const requiredWalls = ownsTower
          ? line.walls.length
          : Math.min(line.walls.length, aiStrategicConfig.buildingGoals.minimumViableFortificationWalls)
        if (ownedWalls < requiredWalls) return null
        const tower = line.towers.find((position) => !ownedBuildingAt(state, position, 'tower'))
        if (tower) return tower
      }
    }
  }
  const outpost = memory.settlementPlan?.reservedSites.outpostTower
  if (kind === 'tower' && outpost && !ownedBuildingAt(state, outpost, 'tower')) return outpost
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
  const buildingEntries = ownedEntries.flatMap((entry) =>
    entry.object.type === 'building' ? [{ position: entry.position, kind: entry.object.kind }] : [],
  )
  const context: BuildingPositionContext = {
    target: zoneTargetFor(state, kind, memory),
    existingKind: buildingEntries.filter((entry) => entry.kind === kind).map((entry) => entry.position),
    sameQuarter: buildingEntries
      .filter((entry) => settlementZoneKindFor(entry.kind) === settlementZoneKindFor(kind))
      .map((entry) => entry.position),
    defenses: buildingEntries.filter((entry) => aiBuildingZoneByKind[entry.kind] === 'defense').map((entry) => entry.position),
  }
  const accessSources = ownedEntries.filter(
    (entry) => entry.object.type === 'castle' || (entry.object.type === 'building' && entry.object.kind === 'barracks'),
  )
  if (aiBuildingZoneByKind[kind] === 'defense' && memory.settlementPlan) {
    const planned = plannedFortificationPosition(state, memory, kind)
    if (!planned || isTemporarilyBlocked(memory, planned, state.turn) || !preservesAccess(state, kind, planned, memory, accessSources))
      return null
    return buildingPlacementFailure(state, kind, planned) === null ? planned : null
  }
  const stalledExpansion = Math.min(
    aiStrategicConfig.adaptiveBlueprintExpansionLimit,
    Math.floor(memory.stalledTurns / aiPlannerConfig.relaxBlueprintAfterStalledTurns),
  )
  const adaptiveShiftRadius =
    (zone?.overflowRadius ?? 0) +
    Math.max(
      aiStrategicConfig.placement.adaptiveShiftMinimum,
      Math.ceil(Math.sqrt(zone?.cells.length ?? 0) / aiStrategicConfig.placement.adaptiveShiftAreaDivisor),
    ) +
    stalledExpansion
  const geometry = placementGeometryFor(analysis, memory, kind, adaptiveShiftRadius)
  const tryPositions = (positions: readonly CellPosition[]) => {
    const candidates: Array<{ position: CellPosition; score: number; tier: number }> = []
    let scanned = 0
    for (const position of positions) {
      if (scanned % aiStrategicConfig.placement.scanCheckInterval === 0 && !countNode()) break
      scanned += 1
      if (!analysis.cells[position.row]?.[position.column]?.inRegion) continue
      const cell = state.scenario.cells[position.row]?.[position.column]
      if (!cell || cell.object || cell.landform === 'peak') continue
      if (buildingSiteFailure(state, kind, position) !== null) continue
      const spatial = geometry.metricsByPosition.get(positionKey(position))
      if (!spatial) continue
      const score = buildingPositionScore(state, analysis, memory, kind, position, context, spatial)
      if (Number.isFinite(score)) candidates.push({ position, score, tier: spatial.tier })
    }
    candidates.sort((first, second) => {
      const scoreDifference = second.score - first.score
      if (first.tier !== second.tier) return first.tier - second.tier
      if (Math.abs(scoreDifference) > aiSpatialConfig.settlementPlan.scoreTieEpsilon) return scoreDifference
      return (
        seededSiteRank(state.scenario.seed, kind, first.position) - seededSiteRank(state.scenario.seed, kind, second.position) ||
        first.position.row - second.position.row ||
        first.position.column - second.position.column
      )
    })
    let viableCandidates = 0
    for (const candidate of candidates) {
      if (!countNode()) break
      if (kind === 'mill' && !hasViableFutureFarmSiteForMill(state, candidate.position, memory, accessSources)) continue
      viableCandidates += 1
      if (viableCandidates > aiStrategicConfig.buildingPlacementShortlist) break
      const spatial = geometry.metricsByPosition.get(positionKey(candidate.position))
      if (!spatial || spatial.footprint.some((position) => isTemporarilyBlocked(memory, position, state.turn))) continue
      if (!preservesAccess(state, kind, candidate.position, memory, accessSources)) continue
      if (buildingPlacementFailure(state, kind, candidate.position) === null) return candidate.position
    }
    return null
  }
  const local = tryPositions(geometry.local)
  if (local) return local
  return tryPositions(geometry.regional)
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
