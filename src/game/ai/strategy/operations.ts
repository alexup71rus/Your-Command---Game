import { aiBuildingKindsByZone, aiPlannerConfig, aiStrategicConfig } from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import {
  buildingRules,
  marketPriceBatchSizes,
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
  build,
  demolish,
  objectAt,
  ownedBuildingCount,
  recruit,
  recruitmentFailure,
  setTaxRate,
  squadSize,
  totalArmySize,
  trade,
  tradeQuoteFor,
  troopTotals,
  turnEconomyForecastFor,
  upkeepFor,
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
  AiStrategicPhase,
} from '../model'
import {
  armyPowerFor,
  economicEmergencyFor,
  economySnapshotFor,
  estimatedTargetPower,
  fortificationReadyFor,
  homeThreatFor,
} from './assessment'
import {
  adaptiveBuildingLimitFor,
  desiredBuildingGoals,
  findStrategicBuildPosition,
  fortificationStarted,
  fundedStoneGoalFor,
  minimumFortificationCostFor,
  nextFortificationStep,
} from './development'
import {
  armyCeilingFor,
  canAfford,
  forceTargetFor,
  isPlannedFortification,
  isTemporarilyBlocked,
  minimumFieldArmySize,
  plannedBuildingLimit,
} from './shared'
import type { StrategicCandidate, StrategicCandidateMetrics } from './types'
import { projectedStrategicScore } from './scoring'

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
  return findStrategicBuildPosition(fundedState, analysis, memory, kind, countNode)
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
    // This helper exists only to fund an otherwise unreachable project. An
    // already affordable goal belongs to the normal build candidate path;
    // scanning its whole placement shortlist here duplicated the most
    // expensive work on every beam node and could starve large-map planning.
    if (shortages.length === 0) continue
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
    .filter((position) => !isPlannedFortification(memory, position))
    .sort((first, second) => first.row - second.row || first.column - second.column)
}

function criticalWorkerCountFor(state: MatchState, ownerId: string) {
  return workforceFor(state, ownerId).assignments.reduce((sum, assignment) => (
    aiStrategicConfig.recruitment.criticalWorkerBuildings.includes(assignment.kind)
      ? sum + assignment.assigned
      : sum
  ), 0)
}

function recruitmentWorkforceBudget(state: MatchState, phase: AiStrategicPhase) {
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const workforce = workforceFor(state, ownerId)
  const threat = homeThreatFor(state, ownerId)
  const emergencyDefense = phase === 'defense'
    && threat.nearest <= aiStrategicConfig.recruitment.emergencyDefenseRadius
    && armyPowerFor(state, ownerId) < threat.power * aiStrategicConfig.recruitment.emergencyDefensePowerRatio
  const criticalWorkers = criticalWorkerCountFor(state, ownerId)
  const minimumCivilians = emergencyDefense
    ? Math.max(
        aiStrategicConfig.minimumCivilianReserve,
        criticalWorkers + aiStrategicConfig.recruitment.emergencyCivilianReserve,
      )
    : Math.max(
        aiStrategicConfig.minimumCivilianReserve,
        workforce.employed + aiStrategicConfig.recruitment.civilianGrowthReserve,
      )
  return {
    available: Math.max(0, domain.population - minimumCivilians),
    criticalWorkers,
    emergencyDefense,
    workforce,
  }
}

export function recruitmentCandidate(state: MatchState, profile: AiProfileRules, phase: AiStrategicPhase, countNode: () => boolean, memory?: AiMemory): StrategicCandidate | null {
  if (phase === 'recovery' || phase === 'survival') return null
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const threat = homeThreatFor(state, ownerId)
  const currentArmySize = totalArmySize(state, ownerId)
  const currentArmyPower = armyPowerFor(state, ownerId)
  if (phase === 'defense' && currentArmyPower >= forceTargetFor(
    profile,
    'defense',
    threat.power,
    aiStrategicConfig.recruitment.defensePowerMultiplier,
  )) return null
  const targetPower = estimatedTargetPower(state, memory?.targetOwnerId ?? null, memory)
  const campaignPowerTarget = forceTargetFor(profile, 'assault', targetPower, profile.riskThreshold)
  const campaignUnderStrength = (phase === 'mobilization' || phase === 'regroup' || phase === 'assault')
    && currentArmyPower < campaignPowerTarget
  const minimumFortificationCost = memory && !fortificationReadyFor(state, memory)
    ? minimumFortificationCostFor(memory)
    : null
  const { available, criticalWorkers, emergencyDefense, workforce } = recruitmentWorkforceBudget(state, phase)
  const armyCeiling = armyCeilingFor(profile, state.turn, emergencyDefense)
  const remainingArmyCapacity = Math.max(0, armyCeiling - currentArmySize)
  if (available < 1 || remainingArmyCapacity < 1 || !turnEconomyForecastFor(state, ownerId)?.food.fed) return null
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
    const positions = recruitmentPositions(state, troop, memory).sort((first, second) => {
      const firstObject = objectAt(state, first)
      const secondObject = objectAt(state, second)
      const firstSize = firstObject?.type === 'squad' && firstObject.ownerId === ownerId ? squadSize(firstObject) : 0
      const secondSize = secondObject?.type === 'squad' && secondObject.ownerId === ownerId ? squadSize(secondObject) : 0
      // Reinforcement naturally grows an existing formation instead of
      // emitting a new one-unit column from another barracks exit every turn.
      return Number(secondSize > 0) - Number(firstSize > 0)
        || secondSize - firstSize
        || first.row - second.row || first.column - second.column
    })
    const maximumRecruitmentCellSpace = Math.max(0, ...positions.map((position) => {
      const object = objectAt(state, position)
      const occupied = object?.type === 'squad' ? squadSize(object) : 0
      return aiStrategicConfig.recruitmentCellCapacity - occupied
    }))
    const maximumQuantity = Math.min(
      aiStrategicConfig.maximumRecruitBatch,
      available,
      remainingArmyCapacity,
      maximumRecruitmentCellSpace,
    )
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
      for (const position of positions) {
        if (!countNode()) return null
        if (recruitmentFailure(state, troop, quantity, position) === null) {
          const simulated = recruit(state, troop, quantity, position)
          if (!simulated.ok) continue
          const forecast = turnEconomyForecastFor(simulated.state, ownerId)
          const postRecruit = economySnapshotFor(simulated.state, ownerId)
          const postWorkforce = workforceFor(simulated.state, ownerId)
          const postCriticalWorkers = criticalWorkerCountFor(simulated.state, ownerId)
          const sustainable = forecast?.food.fed && forecast.upkeepPaid
            && postRecruit.foodRunway >= aiPlannerConfig.foodRunwayTurns
            && postRecruit.goldRunway >= aiStrategicConfig.phase.campaignGoldRunway
          if (postCriticalWorkers < criticalWorkers) continue
          if (!emergencyDefense && postWorkforce.employed < workforce.employed) continue
          if (!sustainable && !emergencyDefense) continue
          return {
            command: { type: 'recruit', troop, quantity, position },
            utility: phase === 'defense' ? aiStrategicConfig.recruitment.defenseUtility : aiStrategicConfig.recruitment.ordinaryUtility,
            goal: phase,
            factors: [
              'composition-gap',
              `quantity:${quantity}`,
              `workers:${workforce.employed}->${postWorkforce.employed}`,
              `critical-workers:${criticalWorkers}->${postCriticalWorkers}`,
              `army-ceiling:${armyCeiling}`,
              ...(emergencyDefense ? ['emergency-draft'] : []),
            ],
          }
        }
      }
    }
  }
  return null
}

function taxCandidate(
  state: MatchState,
  profile: AiProfileRules,
  phase: AiStrategicPhase,
  memory: AiMemory,
): StrategicCandidate | null {
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const snapshot = economySnapshotFor(state, ownerId)
  const current = domain.taxRate ?? 'moderate'
  const atRate = (rate: TaxRate) => {
    const changed = setTaxRate(state, rate)
    return changed.ok ? economySnapshotFor(changed.state, ownerId) : snapshot
  }
  const none = atRate('none')
  const moderate = atRate('moderate')
  const maximum = profile.taxation.maximumRate === 'extortionate'
    ? atRate('extortionate')
    : moderate
  let rate: TaxRate = current
  const config = aiStrategicConfig.taxation
  const foodEmergency = !snapshot.forecastFed || snapshot.foodRunway < config.disableFoodRunway
  const maximumFoodSecure = maximum.forecastFed
    && maximum.foodRunway >= profile.taxation.maximumRateFoodRunway
  // Revenue pressure is evaluated under the ordinary tax rate. This raises
  // taxes before the treasury is empty when army upkeep already exceeds the
  // recurring economy, while the counterfactual food forecast prevents an
  // unaffordable maximum rate.
  const revenuePressure = moderate.goldRunway < profile.taxation.desiredGoldRunway
  if (foodEmergency && none.forecastFed) rate = 'none'
  else if (profile.taxation.maximumRate === 'extortionate'
    && maximumFoodSecure && revenuePressure) rate = 'extortionate'
  else if (current === 'extortionate' && (!maximumFoodSecure
    || moderate.goldRunway >= profile.taxation.desiredGoldRunway + 1)) rate = 'moderate'
  else if (current === 'none' && moderate.forecastFed
    && moderate.foodRunway >= config.enableModerateFoodRunway) rate = 'moderate'
  if (current === rate) return null
  const emergencyRelief = rate === 'none' && (!snapshot.forecastFed || snapshot.foodRunway < config.emergencyReliefRunway)
  if (!emergencyRelief && state.turn - memory.lastTaxChangeTurn < aiPlannerConfig.minimumTaxHoldTurns) return null
  const projected = rate === 'none' ? none : rate === 'moderate' ? moderate : maximum
  return {
    command: { type: 'tax', rate },
    utility: phase === 'recovery' || rate === 'extortionate' ? config.recoveryUtility : config.ordinaryUtility,
    goal: 'tax',
    factors: [
      `rate:${rate}`,
      `moderate-gold-flow:${moderate.resourceFlow.gold}`,
      `projected-food-runway:${projected.foodRunway.toFixed(1)}`,
    ],
  }
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
  const snapshot = economySnapshotFor(state, state.activeParticipantId)
  const config = aiStrategicConfig.market
  const foodStock = foodResources.reduce((sum, resource) => sum + domain.resources[resource], 0)
  const foodReserve = snapshot.foodDemand * aiPlannerConfig.foodRunwayTurns
  const protectedReserve = (resource: (typeof resourceIds)[number], projectReserve = 0) => Math.max(
    profile.strategicReserve[resource] ?? 0,
    minimumFortificationCost?.[resource] ?? 0,
    projectReserve,
  )
  const sellableSurplus = (resource: (typeof tradeableResources)[number], projectReserve = 0) => {
    const ownSurplus = Math.max(0, domain.resources[resource] - protectedReserve(resource, projectReserve))
    if (!foodResources.includes(resource as (typeof foodResources)[number])) return ownSurplus
    // Food types are interchangeable for consumption. Preserve a total
    // operating stock instead of allowing three independent per-resource
    // sales to silently consume the settlement's whole growth runway.
    return Math.min(ownSurplus, Math.max(0, foodStock - foodReserve))
  }
  const bestSale = (
    resources: readonly (typeof tradeableResources)[number][],
    projectReserve: (resource: (typeof tradeableResources)[number]) => number = () => 0,
    minimumRevenue = 0,
  ) => resources
    .map((resource) => {
      const surplus = sellableSurplus(resource, projectReserve(resource))
      const positivePriceCapacity = Math.max(0,
        marketPrices[resource].sell * marketPriceBatchSizes[resource]
          - domain.marketActivity.sold[resource])
      const maximumQuantity = Math.min(Math.floor(surplus), Math.max(config.saleBatch, positivePriceCapacity))
      let quantity = Math.min(config.saleBatch, maximumQuantity)
      if (minimumRevenue > 0 && maximumQuantity > 0) {
        quantity = maximumQuantity
        for (let candidate = config.minimumSaleSurplus; candidate <= maximumQuantity; candidate += 1) {
          if (tradeQuoteFor(domain, resource, 'sell', candidate).total >= minimumRevenue) {
            quantity = candidate
            break
          }
        }
      }
      return { resource, surplus, quantity, quote: tradeQuoteFor(domain, resource, 'sell', quantity) }
    })
    .filter((entry) => entry.quantity >= config.minimumSaleSurplus && entry.quote.total > 0)
    // Rank what the market will actually pay, not the raw stockpile. In a
    // mature Svyatobor economy ten iron can fund far more upkeep than ten wood.
    .sort((first, second) => second.quote.total - first.quote.total
      || second.surplus - first.surplus || first.resource.localeCompare(second.resource))[0]
  const nextUpkeepGold = turnEconomyForecastFor(state, state.activeParticipantId)?.upkeep.gold ?? 0
  const hasMilitarySource = ownedBuildingCount(state, state.activeParticipantId, 'barracks') > 0
  const workforceBudget = recruitmentWorkforceBudget(state, phase)
  const hasRecruitableCivilian = workforceBudget.available > 0
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
  // Profiles without a complete iron industry still need access to their
  // advertised roster. Fund the currently most underrepresented preferred
  // troop through the market instead of falling back to militia forever. A
  // hypothetical fully-funded state is validated by recruitmentCandidate, but
  // the returned command purchases only one missing input; beam search can then
  // buy a second input and recruit in the same turn when orders allow it.
  if (hasMilitarySource && hasRecruitableCivilian
    && (snapshot.armySize < desiredArmySize || defensiveShortfall || campaignShortfall) && isBuildingArmy) {
    const totals = troopTotals(state, state.activeParticipantId)
    const army = Math.max(1, totalArmySize(state, state.activeParticipantId))
    const troopPreference = phase === 'defense' ? profile.doctrine.defensiveTroops : profile.doctrine.preferredTroops
    const preferred = troopPreference
      .filter((troop) => profile.allowedTroops.includes(troop))
      .sort((first, second) => {
        const deficit = (troop: TroopKind) => (profile.doctrine.targetComposition[troop] ?? 0) - totals[troop] / army
        return deficit(second) - deficit(first) || troopPreference.indexOf(first) - troopPreference.indexOf(second)
      })
    const maximumQuantity = Math.min(aiStrategicConfig.maximumRecruitBatch, workforceBudget.available)
    for (const troop of preferred) {
      for (let quantity = maximumQuantity; quantity >= 1; quantity -= 1) {
        const rule = troopRules[troop]
        const shortages = tradeableResources.flatMap((resource) => {
          const shortfall = Math.max(0, (rule.resourceCost[resource] ?? 0) * quantity - domain.resources[resource])
          return shortfall > 0 ? [{ resource, quantity: shortfall, quote: tradeQuoteFor(domain, resource, 'buy', shortfall) }] : []
        }).sort((first, second) => second.quote.total - first.quote.total
          || tradeableResources.indexOf(first.resource) - tradeableResources.indexOf(second.resource))
        if (shortages.length === 0) continue
        const purchaseGold = shortages.reduce((sum, shortage) => sum + shortage.quote.total, 0)
        const recruitGold = (rule.resourceCost.gold ?? 0) * quantity
        if (domain.resources.gold < purchaseGold + recruitGold) continue
        const fundedResources = { ...domain.resources, gold: domain.resources.gold - purchaseGold }
        shortages.forEach((shortage) => { fundedResources[shortage.resource] += shortage.quantity })
        const fundedState: MatchState = {
          ...state,
          domains: {
            ...state.domains,
            [state.activeParticipantId]: { ...domain, resources: fundedResources },
          },
        }
        const fundedRecruitment = recruitmentCandidate(fundedState, profile, phase, () => true, memory)
        if (fundedRecruitment?.command.type !== 'recruit' || fundedRecruitment.command.troop !== troop) continue
        const shortage = shortages[0]
        if (domain.marketActivity.bought[shortage.resource] > 0) continue
        return {
          command: {
            type: 'trade', market: market.position, resource: shortage.resource,
            direction: 'buy', quantity: shortage.quantity,
          },
          utility: phase === 'defense' ? config.defenseSupplyUtility : config.mobilizationSupplyUtility,
          goal: 'trade',
          factors: ['recruitment-input', `troop:${troop}`],
        }
      }
    }
  }
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
      || ownedBuildingCount(state, state.activeParticipantId, kind) >= adaptiveBuildingLimitFor(state, profile, memory!, kind)
      || !canAfford(domain.resources, buildingRules[kind].resourceCost)) return false
    return findStrategicBuildPosition(state, analysis!, memory!, kind, countNode) !== null
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
    if (funded?.shortage && domain.resources.gold >= funded.requiredGold + nextUpkeepGold
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
    if (funded && domain.resources.gold < funded.requiredGold + nextUpkeepGold) {
      const sellable = bestSale(
        tradeableResources.filter((resource) => domain.marketActivity.sold[resource] === 0),
        (resource) => funded.cost[resource] ?? 0,
      )
      if (sellable) {
        return {
          command: {
            type: 'trade',
            market: market.position,
            resource: sellable.resource,
            direction: 'sell',
            quantity: sellable.quantity,
          },
          utility: funded.goal.utility + aiStrategicConfig.market.constructionUtility,
          goal: 'trade',
          factors: ['capitalize-reachable-project', `building:${funded.goal.kind}`],
        }
      }
    }
  }
  const fortificationStep = memory && (phase === 'expansion' || phase === 'mobilization' || phase === 'regroup'
    || phase === 'defense' || (phase === 'assault' && fortificationStarted(state, memory)))
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
        return fundedStoneGoalFor(
          state,
          analysis,
          memory,
          desiredBuildingGoals(state, profile, analysis, memory, phase, countNode),
          countNode,
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
    const upkeepShortfall = turnEconomyForecastFor(state, state.activeParticipantId)?.uncoveredUpkeep.gold ?? 0
    const sellable = bestSale(tradeableResources, () => 0, upkeepShortfall)
    if (sellable) return {
      command: { type: 'trade', market: market.position, resource: sellable.resource, direction: 'sell', quantity: sellable.quantity },
      utility: config.recoverySaleUtility,
      goal: 'trade',
      factors: ['upkeep-recovery', `revenue:${sellable.quote.total}`],
    }
  }
  if (phase !== 'recovery' && domain.resources.wood < aiStrategicConfig.constructionWoodFloor
    && domain.resources.gold >= config.constructionGoldFloor) {
    return { command: { type: 'trade', market: market.position, resource: 'wood', direction: 'buy', quantity: config.constructionWoodBatch }, utility: config.constructionUtility, goal: 'trade', factors: ['unblock-construction'] }
  }
  return null
}

function dismissalCandidate(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  phase: AiStrategicPhase,
): StrategicCandidate | null {
  if ((phase !== 'recovery' && !economicEmergencyFor(state, state.activeParticipantId))
    || turnEconomyForecastFor(state, state.activeParticipantId)?.upkeepPaid) return null
  const ownerId = state.activeParticipantId
  const domain = state.domains[ownerId]
  const market = aiObjectEntries(state.scenario, ownerId)
    .some((entry) => entry.object.type === 'building' && entry.object.kind === 'market')
  if (market) {
    const fortificationReserve = !fortificationReadyFor(state, memory)
      ? minimumFortificationCostFor(memory)
      : null
    const snapshot = economySnapshotFor(state, ownerId)
    const foodStock = foodResources.reduce((sum, resource) => sum + domain.resources[resource], 0)
    const foodSurplus = Math.max(0, foodStock - snapshot.foodDemand * aiPlannerConfig.foodRunwayTurns)
    let remainingFoodSurplus = foodSurplus
    const liquidGold = tradeableResources.reduce((sum, resource) => {
      const reserve = Math.max(
        profile.strategicReserve[resource] ?? 0,
        fortificationReserve?.[resource] ?? 0,
      )
      const ownSurplus = Math.max(0, domain.resources[resource] - reserve)
      const surplus = foodResources.includes(resource as (typeof foodResources)[number])
        ? Math.min(ownSurplus, remainingFoodSurplus)
        : ownSurplus
      const quantity = Math.min(aiStrategicConfig.market.saleBatch, Math.floor(surplus))
      if (foodResources.includes(resource as (typeof foodResources)[number])) {
        remainingFoodSurplus = Math.max(0, remainingFoodSurplus - quantity)
      }
      return quantity >= aiStrategicConfig.market.minimumSaleSurplus
        ? sum + tradeQuoteFor(domain, resource, 'sell', quantity).total
        : sum
    }, 0)
    const immediateShortfall = Math.max(1, upkeepFor(state, ownerId).gold - domain.resources.gold)
    if (liquidGold >= immediateShortfall) return null
  }
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
  const projectedBefore = projectedStrategicScore(
    state, profile, phase,
  )
  const safeToRemove = (position: CellPosition) => {
    // A planned fortification cell (gate / wall / tower / outpost) is part of
    // the settlement blueprint. Demolishing it would make `nextFortificationStep`
    // rebuild the same cell next pass, producing a build-demolish oscillation.
    // Recovery must liquidate surplus economy buildings instead.
    if (isPlannedFortification(memory, position)) return false
    const current = objectAt(state, position)
    if (current?.type === 'building' && current.kind === 'quarry'
      && memory.settlementPlan?.fortification?.lines[0]?.kind === 'enclosure'
      && count('quarry') <= aiStrategicConfig.buildingGoals.enclosureMinimumQuarries) return false
    const result = demolish(state, position)
    if (!result.ok) return false
    const after = economySnapshotFor(result.state, ownerId)
    const population = state.domains[ownerId].population
    if (after.housingCapacity < population || after.foodServiceCapacity < population) return false
    if (snapshot.forecastFed && !after.forecastFed) return false
    if (recoveryMode) {
      const runwayImproved = (before: number, next: number) => next === Number.POSITIVE_INFINITY
        ? before !== Number.POSITIVE_INFINITY
        : Number.isFinite(before) && next >= before + recoveryConfig.meaningfulRunwayDelta
      const improvesEmergency = (!snapshot.forecastFed && after.forecastFed)
        || (!snapshot.upkeepPaid && after.upkeepPaid)
        || (snapshot.foodRunway < aiPlannerConfig.emergencyRunwayTurns
          && runwayImproved(snapshot.foodRunway, after.foodRunway))
        || (snapshot.goldRunway < aiPlannerConfig.emergencyRunwayTurns
          && runwayImproved(snapshot.goldRunway, after.goldRunway))
      if (!improvesEmergency) return false
    }
    const projectedAfter = projectedStrategicScore(
      result.state, profile, phase,
    )
    const projectedGain = projectedAfter - projectedBefore
    return { projectedGain }
  }
  const candidateFor = (position: CellPosition, utility: number, factors: string[]): StrategicCandidate | null => {
    const counterfactual = safeToRemove(position)
    return counterfactual
      ? {
          command: { type: 'demolish', position },
          utility: utility + counterfactual.projectedGain,
          goal: phase,
          factors: [...factors, `projected-gain:${counterfactual.projectedGain.toFixed(1)}`],
        }
      : null
  }

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

  // Capacity limits decide whether another building may be started; they are
  // not a reason to destroy a functioning investment in a stable settlement.
  // In particular, stockpile-funded slots can shrink after construction spends
  // the stockpile that unlocked them. Grandfather the result unless the domain
  // is genuinely in recovery, otherwise the AI pays half the build cost forever.
  const excess = recoveryMode ? profile.allowedBuildings.flatMap((kind) => {
    const limit = adaptiveBuildingLimitFor(state, profile, memory, kind)
    const sameKind = entries
      .filter((entry) => entry.object.type === 'building' && entry.object.kind === kind)
      .sort((first, second) => second.position.row - first.position.row || second.position.column - first.position.column)
    return sameKind.slice(limit)
  })[0] : undefined
  if (excess) {
    const candidate = candidateFor(excess.position, recoveryMode
      ? recoveryConfig.excessBuildingUtility.recovery
      : recoveryConfig.excessBuildingUtility.stable, ['outside-building-capacity'])
    if (candidate) return candidate
  }

  if (recoveryMode) {
    // Zero-upkeep production chains are capital, not a source of recurring
    // savings. Selling their output or leaving their late-priority workers idle
    // is always preferable to repeatedly refunding half the build cost and
    // reconstructing them after the emergency. Excess/blocked checks above
    // still remove genuinely invalid investments.
    const liquidationOrder: BuildingKind[] = ['church', ...aiBuildingKindsByZone.defense]
    for (const kind of liquidationOrder) {
      if (kind === 'barracks' && count(kind) <= recoveryConfig.protectedBarracksCount) continue
      const entry = entries.find((candidate) => candidate.object.type === 'building' && candidate.object.kind === kind)
      if (!entry) continue
      const candidate = candidateFor(entry.position, recoveryConfig.liquidationUtility, [`liquidate:${kind}`])
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
  metrics?: StrategicCandidateMetrics,
): StrategicCandidate[] {
  const measure = <T>(key: keyof StrategicCandidateMetrics, operation: () => T) => {
    const startedAt = performance.now()
    try {
      return operation()
    } finally {
      if (metrics) metrics[key] += performance.now() - startedAt
    }
  }
  const candidates: StrategicCandidate[] = []
  measure('otherCandidatesMs', () => {
    const tax = taxCandidate(state, profile, phase, memory)
    if (tax) candidates.push(tax)
    const market = marketCandidate(state, profile, phase, memory, analysis, countNode)
    if (market) candidates.push(market)
    const dismiss = dismissalCandidate(state, profile, memory, phase)
    if (dismiss) candidates.push(dismiss)
    const demolition = demolitionCandidate(state, profile, memory, phase)
    if (demolition) candidates.push(demolition)
    const recruitment = recruitmentCandidate(state, profile, phase, countNode, memory)
    if (recruitment) candidates.push(recruitment)
  })
  const buildingGoals = measure('buildingGoalsMs', () => (
    desiredBuildingGoals(state, profile, analysis, memory, phase, countNode)
  ))
  for (const goal of buildingGoals.slice(0, aiStrategicConfig.maximumBuildingGoalsPerSearch)) {
    if (!countNode()) break
    const cost = buildingResourceCostFor(state, state.activeParticipantId, goal.kind)
    if (!canAfford(state.domains[state.activeParticipantId].resources, cost)) {
      const reachable = measure('buildingPlacementMs', () => (
        reachableBuildPositionFor(state, analysis, memory, goal.kind, countNode)
      ))
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
    const position = measure('buildingPlacementMs', () => (
      findStrategicBuildPosition(state, analysis, memory, goal.kind, countNode)
    ))
    if (position) {
      const simulated = build(state, goal.kind, position)
      const postBuildForecast = simulated.ok
        ? turnEconomyForecastFor(simulated.state, state.activeParticipantId)
        : null
      const essentialCrisisBuild = (phase === 'recovery' || phase === 'survival')
        && aiStrategicConfig.crisisProductionBuildings.includes(goal.kind)
      if (!postBuildForecast?.upkeepPaid && phase !== 'defense' && !essentialCrisisBuild) {
        diagnostics?.push({
          goal: phase,
          score: goal.utility,
          factors: [...goal.factors, `building:${goal.kind}`],
          rejectedReason: 'breaks-upkeep-reserve',
        })
        continue
      }
      candidates.push({
        command: { type: 'build', building: goal.kind, position },
        utility: goal.utility,
        goal: phase,
        factors: goal.factors,
      })
    }
    else diagnostics?.push({ goal: phase, score: goal.utility, factors: [...goal.factors, `building:${goal.kind}`], rejectedReason: 'no-strategic-build-position' })
  }
  return candidates.sort((first, second) => second.utility - first.utility || JSON.stringify(first.command).localeCompare(JSON.stringify(second.command)))
}
