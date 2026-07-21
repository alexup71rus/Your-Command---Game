import { aiBuildingKindsByZone, aiPlannerConfig, aiStrategicConfig } from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import {
  buildingRules,
  marketPrices,
  resourceIds,
  tradeableResources,
  troopRules,
  type TaxRate,
} from '../../../config/rules'
import type {
  BuildingKind,
  BuildingObject,
  SquadObject,
  TroopComposition,
  TroopKind,
} from '../../map'
import {
  buildingFootprintPositions,
  buildingResourceCostFor,
  demolish,
  objectAt,
  ownedBuildingCount,
  recruit,
  recruitmentFailure,
  squadSize,
  totalArmySize,
  trade,
  tradeQuoteFor,
  troopTotals,
  turnEconomyForecastFor,
  workforceFor,
  type MatchState,
} from '../../match'
import { clockwiseCardinalDirections } from '../../geometry'
import type { CellPosition } from '../../scenario'
import {
  aiObjectEntries,
  samePosition,
  type AiWorldAnalysis,
} from '../analysis'
import type {
  AiMemory,
  AiPlanTraceEntry,
  AiProfileRules,
  AiSettlementZoneKind,
  AiStrategicPhase,
} from '../model'
import {
  armyPowerFor,
  economicEmergencyFor,
  economySnapshotFor,
  estimatedTargetPower,
  fortificationReadyFor,
  hasHuntingTerrainPotential,
  homeThreatFor,
} from './assessment'
import {
  adaptiveBuildingLimitFor,
  desiredBuildingGoals,
  findStrategicBuildPosition,
  fundedStoneGoalFor,
  minimumFortificationCostFor,
  nextFortificationStep,
} from './development'
import {
  canAfford,
  forceTargetFor,
  isPlannedFortification,
  isTemporarilyBlocked,
  minimumFieldArmySize,
  plannedBuildingLimit,
  settlementZoneKindFor,
} from './shared'
import type { StrategicCandidate } from './types'

const foodResources = gameConfig.economy.foodResources

function reachableBuildPositionFor(
  state: MatchState,
  analysis: AiWorldAnalysis,
  memory: AiMemory,
  kind: BuildingKind,
  countNode: () => boolean,
) {
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const cost = buildingResourceCostFor(state, ownerId, kind)
  const fundedResources = { ...domain.resources }
  resourceIds.forEach((resource) => {
    fundedResources[resource] = Math.max(fundedResources[resource], cost[resource] ?? 0)
  })
  const fundedState: MatchState = {
    ...state,
    ordersRemaining: Math.max(state.ordersRemaining, buildingRules[kind].actionCost),
    domains: {
      ...state.domains,
      [ownerId]: { ...domain, resources: fundedResources },
    },
  }
  let checks = 0
  const placementCountNode = () => {
    if (checks >= aiPlannerConfig.goalValidationNodeBudget) return false
    checks += 1
    return countNode()
  }
  return findStrategicBuildPosition(fundedState, analysis, memory, kind, placementCountNode)
}

function fundedConstructionGoalFor(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  phase: AiStrategicPhase,
  analysis: AiWorldAnalysis,
  countNode: () => boolean,
) {
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const goals = desiredBuildingGoals(state, profile, analysis, memory, phase, countNode)
  for (const goal of goals) {
    const cost = buildingResourceCostFor(state, ownerId, goal.kind)
    const shortages = tradeableResources.flatMap((resource) => {
      const quantity = Math.max(0, (cost[resource] ?? 0) - domain.resources[resource])
      return quantity > 0 ? [{ resource, quantity }] : []
    })
    const purchaseGold = shortages.reduce((sum, shortage) => (
      sum + tradeQuoteFor(domain, shortage.resource, 'buy', shortage.quantity).total
    ), 0)
    const position = reachableBuildPositionFor(state, analysis, memory, goal.kind, countNode)
    if (!position) continue
    shortages.sort((first, second) => (
      tradeQuoteFor(domain, second.resource, 'buy', second.quantity).total
        - tradeQuoteFor(domain, first.resource, 'buy', first.quantity).total
      || first.resource.localeCompare(second.resource)
    ))
    return {
      goal,
      shortage: shortages[0],
      position,
      cost,
      requiredGold: purchaseGold + (cost.gold ?? 0),
    }
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
  const campaignPowerTarget = forceTargetFor(profile, 'assault', targetPower, profile.riskThreshold)
  const campaignUnderStrength = (phase === 'mobilization' || phase === 'regroup' || phase === 'assault')
    && currentArmyPower < campaignPowerTarget
  const minimumFortificationCost = memory && !fortificationReadyFor(state, memory)
    ? minimumFortificationCostFor(memory)
    : null
  const minimumCivilians = phase === 'defense'
    ? Math.max(aiStrategicConfig.minimumCivilianReserve, Math.ceil(workforce.employed * aiStrategicConfig.defenseWorkerReserveShare))
    : Math.max(
        aiStrategicConfig.minimumCivilianReserve,
        workforce.employed + aiStrategicConfig.recruitment.civilianGrowthReserve,
      )
  const available = Math.max(0, domain.population - minimumCivilians)
  if (available < 1 || !turnEconomyForecastFor(state, ownerId)?.food.fed) return null
  const totals = troopTotals(state, ownerId)
  const hasBarracks = ownedBuildingCount(state, ownerId, 'barracks') > 0
  const troopPreference = phase === 'defense'
    ? profile.doctrine.defensiveTroops
    : profile.doctrine.preferredTroops
  const preference = [...troopPreference].sort((first, second) => {
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
        const reserve = Math.max(
          profile.strategicReserve[resource] ?? 0,
          minimumFortificationCost?.[resource] ?? 0,
        )
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
  const minimumFortificationCost = memory && !fortificationReadyFor(state, memory)
    ? minimumFortificationCostFor(memory)
    : null
  const protectedReserve = (resource: (typeof resourceIds)[number]) => Math.max(
    profile.strategicReserve[resource] ?? 0,
    minimumFortificationCost?.[resource] ?? 0,
  )
  const snapshot = economySnapshotFor(state, state.activeParticipantId)
  const config = aiStrategicConfig.market
  const hasMilitarySource = ownedBuildingCount(state, state.activeParticipantId, 'barracks') > 0
  const workforce = workforceFor(state, state.activeParticipantId)
  const civilianReserve = phase === 'defense'
    ? Math.max(aiStrategicConfig.minimumCivilianReserve, Math.ceil(workforce.employed * aiStrategicConfig.defenseWorkerReserveShare))
    : Math.max(
        aiStrategicConfig.minimumCivilianReserve,
        workforce.employed + aiStrategicConfig.recruitment.civilianGrowthReserve,
      )
  const hasRecruitableCivilian = domain.population > civilianReserve
  const defensiveShortfall = phase === 'defense'
    && snapshot.armyPower < Math.max(config.minimumDefensePower, forceTargetFor(
      profile,
      'defense',
      homeThreatFor(state, state.activeParticipantId).power,
      config.defenseThreatPowerMultiplier,
    ))
  const campaignShortfall = memory && (phase === 'mobilization' || phase === 'regroup' || phase === 'assault')
    && snapshot.armyPower < forceTargetFor(
      profile,
      'assault',
      estimatedTargetPower(state, memory.targetOwnerId, memory),
      profile.riskThreshold,
    )
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
    const woodSurplus = domain.resources.wood - protectedReserve('wood')
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
  if (memory && analysis) {
    const funded = fundedConstructionGoalFor(state, profile, memory, phase, analysis, countNode)
    if (funded?.shortage && domain.resources.gold >= funded.requiredGold
      && domain.marketActivity.bought[funded.shortage.resource] === 0) {
      return {
        command: {
          type: 'trade',
          market: market.position,
          resource: funded.shortage.resource,
          direction: 'buy',
          quantity: funded.shortage.quantity,
        },
        utility: funded.goal.utility + aiStrategicConfig.market.constructionUtility,
        goal: 'trade',
        factors: ['fund-reachable-project', `building:${funded.goal.kind}`],
      }
    }
    if (funded && domain.resources.gold < funded.requiredGold) {
      const sellable = tradeableResources
        .map((resource) => ({
          resource,
          surplus: domain.resources[resource] - Math.max(
            profile.strategicReserve[resource] ?? 0,
            funded.cost[resource] ?? 0,
          ),
        }))
        .filter((entry) => entry.surplus >= aiStrategicConfig.market.minimumSaleSurplus
          && domain.marketActivity.sold[entry.resource] === 0)
        .sort((first, second) => second.surplus - first.surplus || first.resource.localeCompare(second.resource))[0]
      if (sellable) {
        return {
          command: {
            type: 'trade',
            market: market.position,
            resource: sellable.resource,
            direction: 'sell',
            quantity: Math.min(aiStrategicConfig.market.saleBatch, Math.floor(sellable.surplus)),
          },
          utility: funded.goal.utility + aiStrategicConfig.market.constructionUtility,
          goal: 'trade',
          factors: ['capitalize-reachable-project', `building:${funded.goal.kind}`],
        }
      }
    }
  }
  const fortificationStep = memory && (phase === 'expansion' || phase === 'mobilization' || phase === 'regroup' || phase === 'defense')
    ? nextFortificationStep(state, memory, phase === 'defense')
    : null
  if (fortificationStep) {
    const cost = buildingResourceCostFor(state, state.activeParticipantId, fortificationStep)
    const shortage = tradeableResources
      .flatMap((resource) => {
        const quantity = Math.max(0, (cost[resource] ?? 0) - domain.resources[resource])
        return quantity > 0 && domain.marketActivity.bought[resource] === 0 ? [{ resource, quantity }] : []
      })
      .sort((first, second) => second.quantity - first.quantity || first.resource.localeCompare(second.resource))[0]
    if (shortage) {
      const quote = tradeQuoteFor(domain, shortage.resource, 'buy', shortage.quantity)
      if (domain.resources.gold >= quote.total + (cost.gold ?? 0)) {
        return {
          command: { type: 'trade', market: market.position, resource: shortage.resource, direction: 'buy', quantity: shortage.quantity },
          utility: config.fortificationSupplyUtility,
          goal: 'trade',
          factors: ['fund-fortification', `building:${fortificationStep}`],
        }
      }
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
  if (profile.allowedBuildings.includes('smelter') && !profile.allowedBuildings.includes('mine')
    && domain.resources.iron < config.industrialIronTarget
    && domain.resources.gold >= config.industrialIronGoldFloor
    && ownedBuildingCount(state, state.activeParticipantId, 'smelter') === 0) {
    return { command: { type: 'trade', market: market.position, resource: 'iron', direction: 'buy', quantity: config.industrialIronBatch }, utility: config.industrialIronUtility, goal: 'trade', factors: ['industry-fallback'] }
  }
  if (phase === 'recovery' || !snapshot.upkeepPaid || snapshot.goldRunway < config.upkeepGoldRunway) {
    const sellable = (['wood', 'stone', 'ore', 'flour', 'meat', 'fruit'] as const)
      .map((resource) => ({ resource, surplus: domain.resources[resource] - protectedReserve(resource) }))
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
    // A planned fortification cell (gate / wall / tower / outpost) is part of
    // the settlement blueprint. Demolishing it would make `nextFortificationStep`
    // rebuild the same cell next pass, producing a build-demolish oscillation.
    // Recovery must liquidate surplus economy buildings instead.
    if (isPlannedFortification(memory, position)) return false
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
    const cost = buildingResourceCostFor(state, state.activeParticipantId, goal.kind)
    if (!canAfford(state.domains[state.activeParticipantId].resources, cost)) {
      const reachable = reachableBuildPositionFor(state, analysis, memory, goal.kind, countNode)
      diagnostics?.push({
        goal: phase,
        score: goal.utility,
        factors: [...goal.factors, `building:${goal.kind}`],
        rejectedReason: reachable ? 'not-enough-resources' : 'no-strategic-build-position',
      })
      // A legal higher-priority project is an intentional saving target. Do
      // not spend its inputs on a cheaper discretionary building while the
      // market and end-of-turn production are closing the shortfall.
      if (reachable) break
      continue
    }
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
