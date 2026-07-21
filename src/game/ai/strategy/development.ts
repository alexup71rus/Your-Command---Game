import {
  aiBuildingZoneByKind,
  aiPlannerConfig,
  aiSpatialConfig,
  aiStrategicConfig,
} from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import { buildingRules, resourceIds } from '../../../config/rules'
import type { BuildingKind } from '../../map'
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
  AiSettlementPlan,
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
  developmentBonusSlots,
  developmentHousingBonusSlots,
  isTemporarilyBlocked,
  minimumFieldArmySize,
  plannedBuildingLimit,
  settlementZoneKindFor,
} from './shared'
import type { BuildingGoal } from './types'

const foodResources = gameConfig.economy.foodResources

function seededSiteRank(seed: number, kind: BuildingKind, position: CellPosition) {
  const value = `${kind}:${position.column}:${position.row}`
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0
  }
  return hash
}

function seededBuildingGoalVariation(
  seed: number,
  ownerId: string,
  kind: BuildingKind,
  memory: AiMemory,
) {
  const value = `${ownerId}:${memory.settlementPlan?.layout ?? 'none'}:${memory.settlementPlan?.opening ?? 'none'}:${kind}`
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0
  }
  return (hash / 0xffffffff * 2 - 1) * aiStrategicConfig.buildingGoalVariation
}

function remainingConstructionNeed(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  resource: (typeof resourceIds)[number],
) {
  return profile.allowedBuildings.reduce((total, kind) => {
    const missing = Math.max(0, plannedBuildingLimit(memory, kind)
      - ownedBuildingCount(state, state.activeParticipantId, kind))
    return total + missing * (buildingRules[kind].resourceCost[resource] ?? 0)
  }, 0)
}

function desiredProducerCount(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  producer: 'lumberMill' | 'quarry',
  resource: 'wood' | 'stone',
) {
  const limit = plannedBuildingLimit(memory, producer)
  if (limit <= 0) return 0
  const perTurn = Math.max(1, buildingRules[producer].production[resource] ?? 0)
  const demandPerTurn = remainingConstructionNeed(state, profile, memory, resource)
    / aiStrategicConfig.constructionPlanningHorizonTurns
  return Math.min(limit, Math.max(1, Math.ceil(demandPerTurn / perTurn)))
}

function plannedResourceNeed(profile: AiProfileRules, kind: BuildingKind) {
  const cost = buildingRules[kind].resourceCost
  return resourceIds.reduce((sum, resource) => (
    sum + (cost[resource] ?? 0) * aiStrategicConfig.resourcePlanning.needWeights[resource]
  ), 0) + (profile.allowedBuildings.indexOf(kind) >= 0
    ? aiStrategicConfig.resourcePlanning.allowedBuildingBonus
    : aiStrategicConfig.resourcePlanning.unavailableBuildingPenalty)
}

export function adaptiveBuildingLimitFor(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  kind: BuildingKind,
) {
  const base = plannedBuildingLimit(memory, kind)
  const foodFallback = (kind === 'orchard' || kind === 'huntingLodge')
    && memory.stalledTurns >= aiPlannerConfig.relaxBlueprintAfterStalledTurns
    && economySnapshotFor(state, state.activeParticipantId).foodRunway < aiPlannerConfig.foodRunwayTurns
      ? Math.min(aiStrategicConfig.maximumFoodFallbackBuildings,
          Math.floor(memory.stalledTurns / aiPlannerConfig.relaxBlueprintAfterStalledTurns))
      : 0
  // Long-match milestones (and, when reached, stockpile overdrive) open extra
  // economy slots. Defense buildings are excluded: walls/towers/barbicans
  // follow the fortification plan.
  const zoneKind = settlementZoneKindFor(kind)
  const developmentSlots = zoneKind === 'defense'
    ? 0
    : kind === 'house'
      ? developmentHousingBonusSlots(state, profile, memory)
      : developmentBonusSlots(state, profile, memory)
  if (kind === 'orchard' && !hasHuntingTerrainPotential(state, state.activeParticipantId)) {
    return base + plannedBuildingLimit(memory, 'huntingLodge') + foodFallback + developmentSlots
  }
  return base + foodFallback + developmentSlots
}

function settlementZoneHasCapacity(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  kind: BuildingKind,
  phase: AiStrategicPhase,
) {
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
  const primaryFortification = memory.settlementPlan?.fortification?.lines[0]
  const addsFortificationPrerequisite = kind === 'quarry'
    && primaryFortification?.kind === 'enclosure'
    && ownedBuildingCount(state, state.activeParticipantId, 'house')
      >= aiStrategicConfig.buildingGoals.enclosureMinimumHouses
    && ownedBuildingCount(state, state.activeParticipantId, 'barracks') > 0
    && ownedBuildingCount(state, state.activeParticipantId, 'quarry')
      < aiStrategicConfig.buildingGoals.enclosureMinimumQuarries
  const addsMissingCapability = missingCapabilities.includes(kind) || addsFortificationPrerequisite
  // The heat map is a soft spatial budget. It controls settlement scale, but a
  // compact or damaged quarter may overflow far enough to restore every
  // missing prerequisite. Per-kind profile limits still bound final growth.
  const emergencyOverflow = phase === 'recovery' || phase === 'survival'
    || economicEmergencyFor(state, state.activeParticipantId) || addsMissingCapability ? 1 : 0
  const stalledOverflow = memory.stalledTurns >= aiPlannerConfig.relaxBlueprintAfterStalledTurns ? 1 : 0
  const capabilityOverflow = addsMissingCapability
    ? missingCapabilities.length + Number(addsFortificationPrerequisite)
    : 0
  // Development milestones raise the origin budget for economy zones (never
  // defense) so a mature domain can expand beyond its opening blueprint.
  const economySlots = developmentBonusSlots(state, profile, memory)
  const maturityOriginSlots = zoneKind === 'housing'
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
  return occupiedOrigins < baseOriginBudget + maturityOriginSlots + Math.max(
    emergencyOverflow,
    stalledOverflow,
    capabilityOverflow,
  )
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

type FortificationLine = NonNullable<AiSettlementPlan['fortification']>['lines'][number]

export function fortificationLineStarted(state: MatchState, line: FortificationLine) {
  return ownedBuildingAt(state, line.gate, 'barbican')
    || line.walls.some((position) => ownedBuildingAt(state, position, 'wall'))
    || line.towers.some((position) => ownedBuildingAt(state, position, 'tower'))
}

export function fortificationLineActivated(state: MatchState, line: FortificationLine) {
  if (line.purpose !== 'surplus' || fortificationLineStarted(state, line)) return true
  const remainingStone = Number(!ownedBuildingAt(state, line.gate, 'barbican'))
      * (buildingRules.barbican.resourceCost.stone ?? 0)
    + line.walls.filter((position) => !ownedBuildingAt(state, position, 'wall')).length
      * (buildingRules.wall.resourceCost.stone ?? 0)
    + line.towers.filter((position) => !ownedBuildingAt(state, position, 'tower')).length
      * (buildingRules.tower.resourceCost.stone ?? 0)
  const stone = state.domains[state.activeParticipantId]?.resources.stone ?? 0
  return stone >= remainingStone + (line.activationStoneReserve ?? 0)
}

export function nextFortificationStep(
  state: MatchState,
  memory: AiMemory,
  allowStandaloneOutpost = false,
): BuildingKind | null {
  const plan = memory.settlementPlan?.fortification
  if (plan) {
    for (const line of plan.lines) {
      if (!fortificationLineActivated(state, line)) continue
      const ownedWalls = line.walls.filter((position) => ownedBuildingAt(state, position, 'wall')).length
      const missingWall = ownedWalls < line.walls.length
      const ownsTower = line.towers.some((position) => ownedBuildingAt(state, position, 'tower'))
      const missingTower = line.towers.some((position) => !ownedBuildingAt(state, position, 'tower'))
      const minimumWallsBeforeTower = line.towers.length > 0
        ? Math.min(line.walls.length, aiStrategicConfig.buildingGoals.minimumViableFortificationWalls)
        : line.walls.length
      if (!ownedBuildingAt(state, line.gate, 'barbican')) {
        const gateOccupant = state.scenario.cells[line.gate.row]?.[line.gate.column]?.object
        const enemyHoldsBreach = Boolean(gateOccupant && gateOccupant.ownerId !== state.activeParticipantId)
        // A destroyed gate must not deadlock the whole defense plan while an
        // invader stands on its blueprint cell. Under active attack, finish a
        // usable tower behind the surviving curtain; rebuilding the gate
        // becomes the next priority as soon as the breach is clear.
        if (allowStandaloneOutpost && enemyHoldsBreach
          && ownedWalls >= minimumWallsBeforeTower && !ownsTower && missingTower) return 'tower'
        return 'barbican'
      }
      if (ownedWalls < minimumWallsBeforeTower) return 'wall'
      // A fighting tower makes a partial curtain useful immediately. Build the
      // first one before spending the entire stone reserve on enclosure walls.
      if (!ownsTower && missingTower) return 'tower'
      if (missingWall) return 'wall'
      if (missingTower) return 'tower'
    }
  }
  const outpost = memory.settlementPlan?.reservedSites.outpostTower
  if (outpost && (plan || allowStandaloneOutpost) && !ownedBuildingAt(state, outpost, 'tower')) return 'tower'
  return null
}

export function minimumFortificationCostFor(memory: AiMemory) {
  const firstLine = memory.settlementPlan?.fortification?.lines[0]
  if (!firstLine) return null
  const minimumWalls = firstLine.kind === 'enclosure'
    ? firstLine.walls.length
    : Math.min(firstLine.walls.length, aiStrategicConfig.buildingGoals.minimumViableFortificationWalls)
  const committedTowers = firstLine.kind === 'enclosure' ? firstLine.towers.length : 0
  return [
    buildingRules.barbican.resourceCost,
    ...Array.from({ length: minimumWalls }, () => buildingRules.wall.resourceCost),
    ...Array.from({ length: committedTowers }, () => buildingRules.tower.resourceCost),
  ]
    .reduce((total, current) => {
      resourceIds.forEach((resource) => { total[resource] = (total[resource] ?? 0) + (current[resource] ?? 0) })
      return total
    }, {} as Partial<Record<(typeof resourceIds)[number], number>>)
}

export function fortificationStarted(state: MatchState, memory: AiMemory) {
  const plan = memory.settlementPlan?.fortification
  return Boolean(plan && plan.lines.some((line) => (
    ownedBuildingAt(state, line.gate, 'barbican')
      || line.walls.some((position) => ownedBuildingAt(state, position, 'wall'))
      || line.towers.some((position) => ownedBuildingAt(state, position, 'tower'))
  ))) || Boolean(memory.settlementPlan?.reservedSites.outpostTower
    && ownedBuildingAt(state, memory.settlementPlan.reservedSites.outpostTower, 'tower'))
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
  const adaptiveLimit = (kind: BuildingKind) => adaptiveBuildingLimitFor(state, profile, memory, kind)
  const desiredLumberMills = desiredProducerCount(state, profile, memory, 'lumberMill', 'wood')
  const primaryFortification = memory.settlementPlan?.fortification?.lines[0]
  const enclosureFoundationMature = count('house') >= goalConfig.enclosureMinimumHouses
    && count('barracks') > 0
  const enclosureQuarryFloor = primaryFortification?.kind === 'enclosure' && enclosureFoundationMature
    ? Math.min(plannedBuildingLimit(memory, 'quarry'), goalConfig.enclosureMinimumQuarries)
    : 0
  const desiredQuarries = Math.max(
    desiredProducerCount(state, profile, memory, 'quarry', 'stone'),
    enclosureQuarryFloor,
  )
  const add = (kind: BuildingKind, utility: number, ...factors: string[]) => {
    const requiredWorkers = buildingRules[kind].workersRequired ?? 0
    const essentialInCrisis = (phase === 'survival' || phase === 'recovery' || economicEmergency)
      && aiStrategicConfig.crisisProductionBuildings.includes(kind)
    // Requiring two *additional* idle workers from every expansion building can
    // deadlock a compact settlement: its last free worker is exactly what must
    // start the food/service building that allows the next citizens to appear.
    const enablesFoodGrowth = aiBuildingZoneByKind[kind] === 'food'
      && snapshot.workforceFree >= requiredWorkers
    const enablesServiceGrowth = kind === 'kitchen'
      && snapshot.workforceFree >= requiredWorkers
      && snapshot.foodServiceCapacity <= domain.population
      && snapshot.residentialCapacity >= domain.population
    const enablesPopulationGrowth = enablesFoodGrowth || enablesServiceGrowth
    const structuralPrerequisite = kind === 'quarry' && count('quarry') < enclosureQuarryFloor
    const keepsWorkerReserve = requiredWorkers === 0 || snapshot.workforceFree >= requiredWorkers + aiStrategicConfig.workerReserve
      || essentialInCrisis || enablesPopulationGrowth || structuralPrerequisite
    if (profile.allowedBuildings.includes(kind)
      && count(kind) < adaptiveLimit(kind)
      && settlementZoneHasCapacity(state, profile, memory, kind, phase)
      && keepsWorkerReserve) {
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
  const wantsFood = !snapshot.forecastFed || snapshot.foodRunway < aiPlannerConfig.foodRunwayTurns
    || (!sustainablyFeedsGrowth && (expectsGrowth || snapshot.housingCapacity <= domain.population + 1))

  if (wantsFood) {
    const foodScale = Math.max(0, snapshot.foodDemand - foodProduction)
    if (count('huntingLodge') < adaptiveLimit('huntingLodge') && (count('huntingLodge') === 0 || foodProduction < growthFoodDemand)) add('huntingLodge', goalConfig.utility.huntingLodge + foodScale, 'food-runway', 'forest-edge')
    if (count('orchard') < adaptiveLimit('orchard') && (count('orchard') === 0 || foodProduction < growthFoodDemand)) add('orchard', goalConfig.utility.orchard + foodScale, 'food-runway', huntingTerrainAvailable ? 'compact-food' : 'substitute-missing-hunt')
    if (profile.allowedBuildings.includes('farm')) {
      if (count('mill') === 0) add('mill', goalConfig.utility.mill + foodScale, 'farm-chain')
      else if (foodProduction < Math.max(snapshot.foodDemand * goalConfig.farmDemandMultiplier, growthFoodDemand)) {
        const farmSupportCapacity = buildingRules.mill.farmSupport?.capacity ?? 0
        if (count('farm') < count('mill') * farmSupportCapacity) {
          const unusedClusterBonus = count('farm') < count('mill')
            ? goalConfig.farmClusterPriorityBonus
            : 0
          add('farm', goalConfig.utility.farm + foodScale + unusedClusterBonus,
            'supported-farm', ...(unusedClusterBonus > 0 ? ['fill-new-mill-cluster'] : []))
        }
        // One theoretically unused support slot is not proof that another
        // 2x2 farm can fit around this mill. In a mature settlement, opening a
        // second milling cluster gives placement search a new centre instead
        // of retrying the same unreachable farm forever.
        if (count('farm') > 0 && count('farm') >= count('mill')
          && count('mill') < adaptiveLimit('mill')) {
          add('mill', goalConfig.utility.mill + foodScale - 8, 'expand-farm-cluster')
        }
      }
    }
  }
  const hasLumberPotential = analysis.cells.some((row) => row.some((cell) => cell.inRegion && cell.passable
    && cell.adjacentForest >= (buildingRules.lumberMill.minimumAdjacentForestCells ?? 0)))
  if (hasLumberPotential && count('lumberMill') < Math.min(goalConfig.maximumLumberMills, desiredLumberMills)
    && (count('lumberMill') === 0 || snapshot.resourceFlow.wood < remainingConstructionNeed(state, profile, memory, 'wood')
      / aiStrategicConfig.constructionPlanningHorizonTurns
      || domain.resources.wood < goalConfig.lowWoodThreshold)) {
    add('lumberMill', goalConfig.utility.lumberMill, count('lumberMill') === 0 ? 'wood-recovery' : 'construction-throughput')
  }
  const housingSlack = snapshot.residentialCapacity - domain.population
  const serviceSlack = snapshot.foodServiceCapacity - domain.population
  const growthFoodReady = snapshot.forecastFed && snapshot.foodRunway >= aiPlannerConfig.foodRunwayTurns
    && sustainablyFeedsGrowth
  // Soldiers consume residential capacity too. A developed army can therefore
  // leave civilians exactly at the housing ceiling with too few free workers
  // to start the next food building. If the current population is fed and has
  // a real stockpile runway, a house is the bridge that supplies those workers;
  // the AI can then expand production before the reserve is exhausted.
  const workforceUnlockHousing = snapshot.forecastFed
    && snapshot.foodRunway >= aiPlannerConfig.foodRunwayTurns
    && housingSlack <= 0 && snapshot.workforceFree < aiStrategicConfig.workerReserve
  if (growthFoodReady && serviceSlack <= goalConfig.kitchenBeforeGrowthServiceSlack
    && housingSlack <= goalConfig.kitchenBeforeGrowthHousingSlack
    && snapshot.foodServiceCapacity <= snapshot.residentialCapacity
    && count('kitchen') < adaptiveLimit('kitchen')) add('kitchen', goalConfig.utility.kitchenBeforeGrowth, 'food-service-before-growth')
  if ((growthFoodReady || workforceUnlockHousing) && housingSlack <= goalConfig.houseHousingSlack
    && snapshot.foodServiceCapacity >= domain.population + goalConfig.houseFutureService) {
    add('house', goalConfig.utility.house + (workforceUnlockHousing ? 28 : 0),
      'housing-slack', ...(workforceUnlockHousing ? ['unlock-workforce'] : []))
  }
  if (growthFoodReady && serviceSlack <= goalConfig.kitchenServiceSlack && count('house') >= 1
    && snapshot.foodServiceCapacity < snapshot.residentialCapacity
    && count('kitchen') < adaptiveLimit('kitchen')) add('kitchen', goalConfig.utility.kitchen, 'food-service')

  const futureStoneNeed = remainingConstructionNeed(state, profile, memory, 'stone')
  const stoneTarget = Math.max(aiStrategicConfig.resourcePlanning.minimumStoneTarget,
    futureStoneNeed * aiStrategicConfig.resourcePlanning.futureStoneShare)
  const enclosureQuarryMissing = count('quarry') < enclosureQuarryFloor
  if (count('quarry') < desiredQuarries && (enclosureQuarryMissing || domain.resources.stone < stoneTarget
    || snapshot.resourceFlow.stone < futureStoneNeed / aiStrategicConfig.constructionPlanningHorizonTurns)) {
    add('quarry', goalConfig.utility.quarry,
      enclosureQuarryMissing ? 'fortification-foundation' : count('quarry') === 0 ? 'planned-stone' : 'construction-throughput')
  }
  const hasBarracks = count('barracks') > 0
  const expandsRecruitmentCapacity = hasBarracks
    && count('barracks') < adaptiveLimit('barracks')
    && snapshot.armySize >= count('barracks')
      * aiStrategicConfig.recruitmentCellCapacity
      * aiStrategicConfig.placement.minimumRecruitmentExits
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
  const stoneRecoveryGoal = count('market') === 0 && snapshot.resourceFlow.stone <= 0
    ? fundedStoneGoalFor(state, analysis, memory, goals, countNode)
    : null
  const stoneRecoveryFunded = stoneRecoveryGoal ? goldAfterMarket + saleGoldPotential >= (
    tradeQuoteFor(domain, 'stone', 'buy', stoneRecoveryGoal.shortfall).total
    + (buildingResourceCostFor(state, ownerId, stoneRecoveryGoal.kind).gold ?? 0)
  ) : false
  if (count('market') === 0 && ((marketHasFollowUp
    && (phase === 'recovery' || economicEmergency || domain.resources.gold < goalConfig.lowGoldMarketThreshold || usesIndustry || needsRecruitmentTrade)) || stoneRecoveryFunded)) {
    add('market', stoneRecoveryGoal ? goalConfig.utility.fundedMarket : goalConfig.utility.market, 'recovery-market', stoneRecoveryGoal ? `stone-for:${stoneRecoveryGoal.kind}` : 'funded-follow-up')
  }
  if ((!hasBarracks && domain.population >= goalConfig.barracksMinimumPopulation || expandsRecruitmentCapacity)
    && phase !== 'recovery') {
    const urgentMilitaryUnlock = phase === 'mobilization' || phase === 'assault'
      || phase === 'regroup' || phase === 'defense'
      || snapshot.armySize >= aiStrategicConfig.basicMilitiaBeforeBarracks
      || domain.population >= goalConfig.barracksUrgentPopulation
    add(
      'barracks',
      urgentMilitaryUnlock ? goalConfig.utility.urgentBarracks : goalConfig.utility.barracks,
      'military-unlock',
      expandsRecruitmentCapacity ? 'expand-recruitment-exits'
        : urgentMilitaryUnlock ? 'field-force-unlock' : 'civilian-opening',
    )
  }

  if (usesIndustry && phase !== 'recovery' && snapshot.foodRunway >= goalConfig.industryFoodRunway) {
    if (count('mine') === 0) add('mine', goalConfig.utility.mine, 'iron-chain')
    else if (count('smelter') === 0 && snapshot.forecastFed
      && (domain.resources.ore >= goalConfig.smelterOreStock || snapshot.resourceFlow.ore > 0)) {
      add('smelter', goalConfig.utility.smelter, 'iron-chain', 'food-secured')
    }
    if ((phase === 'expansion' || phase === 'mobilization') && count('church') === 0
      && domain.population >= goalConfig.churchMinimumPopulation && snapshot.foodRunway >= goalConfig.churchFoodRunway
      && snapshot.goldRunway >= goalConfig.churchGoldRunway) add('church', goalConfig.utility.church, 'late-growth')
  }

  const threat = homeThreatFor(state, ownerId, memory)
  const fortificationStep = nextFortificationStep(state, memory, phase === 'defense')
  const startedFortification = fortificationStarted(state, memory)
  const firstFortification = primaryFortification
  const enclosureFoundationReady = firstFortification?.kind !== 'enclosure'
    || (count('house') >= goalConfig.enclosureMinimumHouses
      && count('quarry') >= goalConfig.enclosureMinimumQuarries
      && count('barracks') > 0)
  const mayContinueFortification = startedFortification || phase === 'defense'
    || (enclosureFoundationReady && canFundMinimumFortification(state, memory))
  if (!economicEmergency && fortificationStep && mayContinueFortification
    && (phase === 'defense' || startedFortification
      || ((phase === 'expansion' || phase === 'mobilization' || phase === 'regroup')
        && enclosureFoundationReady && snapshot.armySize >= goalConfig.fortificationArmySize))) {
    const continuity = startedFortification ? goalConfig.fortificationContinuityBonus : 0
    if (fortificationStep === 'barbican') {
      add('barbican', (phase === 'defense' ? goalConfig.utility.defenseBarbican : goalConfig.utility.barbican) + continuity,
        'fortification-plan', 'gate-first', `foundation:${firstFortification?.kind ?? 'none'}:h${count('house')}:q${count('quarry')}:b${count('barracks')}`)
    } else if (fortificationStep === 'wall') {
      add('wall', (phase === 'defense' ? goalConfig.utility.defenseWall : goalConfig.utility.wall) + continuity,
        'fortification-plan', 'connected-curtain')
    } else if (profile.allowedBuildings.includes('tower') && count('tower') < adaptiveLimit('tower')
      && (phase === 'defense' || threat.power > 0 || snapshot.armySize >= goalConfig.towerArmySize)) {
      add('tower', goalConfig.utility.tower + continuity, 'fortification-plan', 'line-endpoint')
    }
  }

  return goals
    .filter((goal, index, all) => all.findIndex((candidate) => candidate.kind === goal.kind) === index)
    .sort((first, second) => second.utility - first.utility || plannedResourceNeed(profile, second.kind) - plannedResourceNeed(profile, first.kind) || first.kind.localeCompare(second.kind))
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
  if (kind === 'tower') return ownedBuildingCount(state, state.activeParticipantId, 'tower') === 0
    ? sites.leftTower ?? sites.rightTower ?? sites.military ?? null
    : sites.rightTower ?? sites.leftTower ?? sites.military ?? null
  return sites.military ?? null
}

function potentialFutureFarmSitesForMill(state: MatchState, mill: CellPosition, memory: AiMemory) {
  const support = buildingRules.mill.farmSupport
  const farmFootprint = buildingRules.farm.footprint
  const regionId = state.scenario.participants.find((participant) => (
    participant.id === state.activeParticipantId
  ))?.regionId
  if (!support || !farmFootprint || !regionId) return []
  const reserved = new Set([
    ...(memory.settlementPlan?.reservedCorridors ?? []),
    ...(memory.settlementPlan?.reservedAccessRoutes ?? []),
    ...(memory.settlementPlan?.fortification?.lines.flatMap((line) => (
      [line.gate, ...line.walls, ...line.towers]
    )) ?? []),
  ].map(positionKey))
  const result: Array<{ origin: CellPosition; positions: CellPosition[]; distance: number }> = []
  for (let row = mill.row - support.radius - farmFootprint.rows + 1;
    row <= mill.row + support.radius; row += 1) {
    for (let column = mill.column - support.radius - farmFootprint.columns + 1;
      column <= mill.column + support.radius; column += 1) {
      const origin = { column, row }
      const positions = buildingFootprintPositions('farm', origin)
      if (positions.length === 0 || positions.some((position) => samePosition(position, mill))) continue
      if (positions.some((position) => {
        const cell = state.scenario.cells[position.row]?.[position.column]
        return !cell || cell.object || cell.landform !== 'plain' || cell.vegetation
          || state.scenario.territories[position.row]?.[position.column] !== regionId
          || reserved.has(positionKey(position))
      })) continue
      const distance = Math.min(...positions.map((position) => positionDistance(position, mill)))
      if (distance <= support.radius) result.push({ origin, positions, distance })
    }
  }
  return result.sort((first, second) => first.distance - second.distance
    || first.origin.row - second.origin.row || first.origin.column - second.origin.column)
}

function reservedFutureFarmCells(state: MatchState, memory: AiMemory) {
  const capacity = buildingRules.mill.farmSupport?.capacity ?? 0
  const mills = aiObjectEntries(state.scenario, state.activeParticipantId)
    .filter((entry) => entry.object.type === 'building' && entry.object.kind === 'mill')
  const farms = aiObjectEntries(state.scenario, state.activeParticipantId)
    .filter((entry) => entry.object.type === 'building' && entry.object.kind === 'farm')
  const reserved = new Set<string>()
  mills.forEach((mill) => {
    const supported = farms.filter((farm) => buildingFootprintPositions('farm', farm.position)
      .some((position) => positionDistance(position, mill.position)
        <= (buildingRules.mill.farmSupport?.radius ?? 0))).length
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
  memory.settlementPlan?.reservedAccessRoutes?.forEach((position) => corridor.add(positionKey(position)))
  const fortification = new Set(memory.settlementPlan?.fortification?.lines
    .flatMap((line) => [line.gate, ...line.walls, ...line.towers])
    .map(positionKey) ?? [])
  const outpost = memory.settlementPlan?.reservedSites.outpostTower
  if (outpost) fortification.add(positionKey(outpost))
  if (aiBuildingZoneByKind[kind] !== 'defense'
    && [...footprint].some((key) => corridor.has(key) || fortification.has(key))) return false
  const capabilityReservations = new Set(Object.entries(memory.settlementPlan?.reservedBuildingSites ?? {})
    .flatMap(([reservedKind, origin]) => {
      const capability = reservedKind as BuildingKind
      if (!origin || capability === kind
        || ownedBuildingCount(state, state.activeParticipantId, capability) > 0) return []
      return buildingFootprintPositions(capability, origin).map(positionKey)
    }))
  if ([...footprint].some((key) => capabilityReservations.has(key))) return false
  if (kind !== 'farm' && kind !== 'mill') {
    const futureFarms = reservedFutureFarmCells(state, memory)
    if ([...footprint].some((key) => futureFarms.has(key))) return false
  }
  const castle = sources.find((entry) => entry.object.type === 'castle')?.position
  if (castle && memory.settlementPlan?.reservedAccessTargets?.some((target) => {
    // Evaluate roads against both the candidate and every still-missing
    // reserved capability. Otherwise the only quarry road may quietly route
    // through the empty smelter footprint and become impossible the moment the
    // planned smelter is finally placed.
    const routeBlocked = (position: CellPosition) => footprint.has(positionKey(position))
      || capabilityReservations.has(positionKey(position))
    const targetBlocked = routeBlocked(target)
      || Boolean(state.scenario.cells[target.row]?.[target.column]?.object)
    const destinations = targetBlocked
      ? clockwiseCardinalDirections.map((direction) => ({
          column: target.column + direction.column,
          row: target.row + direction.row,
        }))
      : [target]
    return !destinations.some((destination) => {
      const cell = state.scenario.cells[destination.row]?.[destination.column]
      if (!cell || cell.landform === 'peak' || routeBlocked(destination)) return false
      return samePosition(castle, destination) || Boolean(findMovementPath(
        state.scenario.cells,
        castle,
        destination,
        {
          ownerId: state.activeParticipantId,
          // Friendly squads are transient traffic, not permanent geometry.
          // Treating a mustering unit as a wall made the castle builder reject
          // the remaining enclosure cells even though that unit can move away.
          canEnterOccupiedCell: (pathPosition) => {
            const object = state.scenario.cells[pathPosition.row]?.[pathPosition.column]?.object
            return object?.type === 'squad' && object.ownerId === state.activeParticipantId
          },
          cellCost: (pathPosition) => routeBlocked(pathPosition)
            ? Number.POSITIVE_INFINITY
            : 1,
        },
      ))
    })
  })) return false
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
      return mapCell && mapCell.landform !== 'peak' && (!mapCell.object || movableSquad)
        && !footprint.has(positionKey(cell))
        && !fortification.has(positionKey(cell))
    }).length
    return free >= aiStrategicConfig.placement.minimumRecruitmentExits
  })
}

function viableFutureFarmSitesForMill(
  state: MatchState,
  mill: CellPosition,
  memory: AiMemory,
  accessSources: ReturnType<typeof aiObjectEntries>,
) {
  return potentialFutureFarmSitesForMill(state, mill, memory)
    .filter((candidate) => preservesAccess(state, 'farm', candidate.origin, memory, accessSources))
    .map((candidate) => candidate.origin)
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
  if (!['barbican', 'wall', 'tower'].includes(kind)) return null
  if (plan) {
    for (const line of plan.lines) {
      if (!fortificationLineActivated(state, line)) continue
      if (kind === 'barbican' && !ownedBuildingAt(state, line.gate, 'barbican')) return line.gate
      if (kind === 'wall') {
        if (!ownedBuildingAt(state, line.gate, 'barbican')) return null
        const ownedWalls = line.walls.filter((position) => ownedBuildingAt(state, position, 'wall')).length
        const ownsTower = line.towers.some((position) => ownedBuildingAt(state, position, 'tower'))
        const minimumWallsBeforeTower = line.towers.length > 0
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
  if (aiBuildingZoneByKind[kind] === 'defense' && memory.settlementPlan) {
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
      if (buildingSiteFailure(state, kind, position) !== null) continue
      if (kind === 'mill' && viableFutureFarmSitesForMill(state, position, memory, accessSources).length === 0) continue
      const score = buildingPositionScore(state, analysis, memory, kind, position, context)
      if (Number.isFinite(score)) candidates.push({ position, score })
    }
    candidates.sort((first, second) => {
      const firstTier = coverage(first.position) >= aiStrategicConfig.placement.preferredZoneCoverage ? 0 : distanceToZone(first.position) <= (zone?.overflowRadius ?? 0) ? 1 : 2
      const secondTier = coverage(second.position) >= aiStrategicConfig.placement.preferredZoneCoverage ? 0 : distanceToZone(second.position) <= (zone?.overflowRadius ?? 0) ? 1 : 2
      const scoreDifference = second.score - first.score
      if (firstTier !== secondTier) return firstTier - secondTier
      if (Math.abs(scoreDifference) > aiSpatialConfig.settlementPlan.scoreTieEpsilon) return scoreDifference
      return seededSiteRank(state.scenario.seed, kind, first.position)
        - seededSiteRank(state.scenario.seed, kind, second.position)
        || first.position.row - second.position.row
        || first.position.column - second.position.column
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
