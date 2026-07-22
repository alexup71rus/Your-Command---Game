import {
  buildingRules,
  castleProduction,
  defaultTaxRate,
  marketPriceBatchSizes,
  marketPrices,
  resourceIds,
  starvationTroopOrder,
  taxRates,
  tradeableResources,
  troopKinds,
  troopRules,
  type TaxRate,
  type TradeResource,
} from '../../config/rules'
import { gameConfig } from '../../config/game'
import type { GameMap, ResourceId } from '../map'
import type { CellPosition } from '../scenario'
import type {
  CommandResult,
  DomainEconomy,
  FoodConsumption,
  FoodDemand,
  MatchState,
  TroopLoss,
  TurnReport,
  WorkforceSummary,
} from './types'
import {
  activeDomain,
  applyResources,
  civilianPopulationCapacityFor,
  emptyMarketActivity,
  foodServiceCapacityFor,
  hasLivingCastle,
  hasResources,
  indexedMapObjects,
  maxSquadHealth,
  objectAt,
  positionKey,
  squadHealth,
  squadSize,
  totalArmySize,
  troopTotals,
  workforceFor,
} from './core'

export function productionFor(state: MatchState, ownerId: string, workforce = workforceFor(state, ownerId)) {
  const taxRule = taxRates[state.domains[ownerId]?.taxRate ?? defaultTaxRate]
  const production = Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  const assignments = new Map(
    workforce.assignments.map((assignment) => [`${assignment.position.column}:${assignment.position.row}`, assignment]),
  )
  indexedMapObjects(state, ownerId).forEach(({ object, position }) => {
    const amount = object.type === 'castle' ? castleProduction : object.type === 'building' ? buildingRules[object.kind].production : null
    if (!amount) return
    const assignment = object.type === 'building' ? assignments.get(positionKey(position)) : undefined
    const workerRatio = assignment ? assignment.assigned / assignment.required : 1
    resourceIds.forEach((resource) => {
      const produced = amount[resource] ?? 0
      const staffedProduction = Math.floor(produced * workerRatio)
      production[resource] +=
        object.type === 'building' ? (staffedProduction > 0 ? Math.max(0, staffedProduction + taxRule.productionAdjustment) : 0) : produced
    })
  })
  return production
}

export function upkeepFor(state: MatchState, ownerId: string) {
  const upkeep = Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  indexedMapObjects(state, ownerId).forEach(({ object }) => {
    if (object.type === 'building') {
      const amount = buildingRules[object.kind].upkeep
      if (amount)
        resourceIds.forEach((resource) => {
          upkeep[resource] += amount[resource] ?? 0
        })
      if (object.kind === 'tower' && object.garrison) {
        resourceIds.forEach((resource) => {
          upkeep[resource] += (troopRules.archers.upkeep[resource] ?? 0) * object.garrison!.archers
        })
      }
      return
    }
    if (object.type === 'squad') {
      troopKinds.forEach((kind) => {
        resourceIds.forEach((resource) => {
          upkeep[resource] += (troopRules[kind].upkeep[resource] ?? 0) * (object.units[kind] ?? 0)
        })
      })
    }
  })
  resourceIds.forEach((resource) => {
    upkeep[resource] = Math.ceil(upkeep[resource])
  })
  return upkeep
}

function populationGrowthFor(state: MatchState, ownerId: string) {
  return indexedMapObjects(state, ownerId).reduce(
    (growth, { object }) => (object.type === 'building' ? growth + (buildingRules[object.kind].populationGrowth ?? 0) : growth),
    0,
  )
}

export function foodDemandBreakdownFor(state: MatchState, ownerId: string, workforce = workforceFor(state, ownerId)): FoodDemand {
  const domain = state.domains[ownerId]
  if (!domain) return { civilians: 0, soldiers: 0, taxFood: 0, staple: 0, total: 0, servedCivilians: 0, unservedCivilians: 0 }
  const soldiers = squadSize({ units: troopTotals(state, ownerId) })
  const servedCivilians = Math.min(domain.population, foodServiceCapacityFor(state, ownerId, workforce))
  const unservedCivilians = Math.max(0, domain.population - servedCivilians)
  const civilianDemand = Math.ceil(domain.population * gameConfig.economy.civilianFoodPerPerson)
  const soldierDemand = Math.ceil(soldiers * gameConfig.economy.soldierFoodPerUnit)
  const foodDemandMultiplier = taxRates[domain.taxRate ?? defaultTaxRate].foodDemandMultiplier
  const taxFood = Math.ceil(civilianDemand * (foodDemandMultiplier - 1))
  const staple = civilianDemand + soldierDemand
  return {
    civilians: civilianDemand,
    soldiers: soldierDemand,
    taxFood,
    staple,
    total: staple + taxFood,
    servedCivilians,
    unservedCivilians,
  }
}

export function foodDemandFor(state: MatchState, ownerId: string) {
  return foodDemandBreakdownFor(state, ownerId).total
}

export function foodConsumptionFor(
  state: MatchState,
  ownerId: string,
  available: Pick<Record<ResourceId, number>, 'flour' | 'meat' | 'fruit'> = state.domains[ownerId]?.resources ?? {
    flour: 0,
    meat: 0,
    fruit: 0,
  },
): FoodConsumption {
  const demand = foodDemandBreakdownFor(state, ownerId)
  return consumeFood(demand, available)
}

function consumeFood(demand: FoodDemand, available: Pick<Record<ResourceId, number>, 'flour' | 'meat' | 'fruit'>): FoodConsumption {
  let remaining = demand.total
  const availableStaples = { flour: available.flour, meat: available.meat, fruit: available.fruit }
  const consumedStaples = { flour: 0, meat: 0, fruit: 0 }
  const evenShare = Math.floor(demand.total / gameConfig.economy.foodResources.length)
  const extraUnits = demand.total % gameConfig.economy.foodResources.length
  gameConfig.economy.foodResources.forEach((resource, index) => {
    const desired = evenShare + (index < extraUnits ? 1 : 0)
    const consumed = Math.min(availableStaples[resource], desired)
    consumedStaples[resource] += consumed
    availableStaples[resource] -= consumed
    remaining -= consumed
  })
  gameConfig.economy.foodResources.forEach((resource) => {
    const consumed = Math.min(availableStaples[resource], remaining)
    consumedStaples[resource] += consumed
    remaining -= consumed
  })
  const minimumVariety = Math.ceil(demand.total * gameConfig.economy.diverseDietMinimumShare)
  const fed = remaining === 0 && demand.unservedCivilians === 0
  const diverseDiet =
    fed &&
    minimumVariety > 0 &&
    minimumVariety * gameConfig.economy.foodResources.length <= demand.total &&
    gameConfig.economy.foodResources.every((resource) => consumedStaples[resource] >= minimumVariety)
  return { flour: consumedStaples.flour, meat: consumedStaples.meat, fruit: consumedStaples.fruit, fed, diverseDiet }
}

export function taxIncomeFor(state: MatchState, ownerId: string) {
  const domain = state.domains[ownerId]
  if (!domain) return 0
  return Math.floor(domain.population * taxRates[domain.taxRate ?? defaultTaxRate].goldPerPerson)
}

export function processingFor(
  state: MatchState,
  ownerId: string,
  available: Record<ResourceId, number>,
  workforce = workforceFor(state, ownerId),
) {
  const taxRule = taxRates[state.domains[ownerId]?.taxRate ?? defaultTaxRate]
  const processed = Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  let resources = { ...available }
  const assignments = new Map(
    workforce.assignments.map((assignment) => [`${assignment.position.column}:${assignment.position.row}`, assignment]),
  )
  indexedMapObjects(state, ownerId).forEach(({ object, position }) => {
    if (object.type !== 'building') return
    const rule = buildingRules[object.kind].processing
    if (!rule) return
    const assignment = assignments.get(positionKey(position))
    const workerRatio = assignment ? assignment.assigned / assignment.required : 1
    const staffedCapacity = Math.floor(rule.maximumPerTurn * workerRatio)
    const processingCapacity = staffedCapacity > 0 ? Math.max(0, staffedCapacity + taxRule.productionAdjustment) : 0
    const amount = Math.min(processingCapacity, resources[rule.input])
    if (amount <= 0) return
    resources = { ...resources, [rule.input]: resources[rule.input] - amount, [rule.output]: resources[rule.output] + amount }
    processed[rule.input] -= amount
    processed[rule.output] += amount
  })
  return processed
}

export interface TurnEconomyForecast {
  resources: Record<ResourceId, number>
  foodDemand: number
  food: FoodConsumption
  upkeepPaid: boolean
  upkeep: Record<ResourceId, number>
  uncoveredUpkeep: Record<ResourceId, number>
  production: Record<ResourceId, number>
  taxIncome: number
  processing: Record<ResourceId, number>
  desertion: TroopLoss | null
  workforce: WorkforceSummary
}

interface TurnEconomyResolution extends TurnEconomyForecast {
  cells: GameMap
  production: Record<ResourceId, number>
  taxIncome: number
  upkeep: Record<ResourceId, number>
  processing: Record<ResourceId, number>
}

function resolveTurnEconomy(state: MatchState, ownerId: string): TurnEconomyResolution | null {
  const current = state.domains[ownerId]
  if (!current) return null
  const workforce = workforceFor(state, ownerId)
  const production = productionFor(state, ownerId, workforce)
  const taxIncome = taxIncomeFor(state, ownerId)
  let resources = applyResources(current.resources, production)
  resources = { ...resources, gold: resources.gold + taxIncome }
  const upkeep = upkeepFor(state, ownerId)
  const upkeepPaid = hasResources(resources, upkeep)
  const uncoveredUpkeep = Object.fromEntries(
    resourceIds.map((resource) => [resource, Math.max(0, upkeep[resource] - resources[resource])]),
  ) as Record<ResourceId, number>
  resources = Object.fromEntries(resourceIds.map((resource) => [resource, Math.max(0, resources[resource] - upkeep[resource])])) as Record<
    ResourceId,
    number
  >
  const desertionResult = upkeepPaid ? { cells: state.scenario.cells, loss: null } : removeCheapestTroop(state.scenario.cells, ownerId)
  const afterDesertion = { ...state, scenario: { ...state.scenario, cells: desertionResult.cells } }
  const processing = processingFor(afterDesertion, ownerId, resources, workforce)
  resources = applyResources(resources, processing)
  const demand = foodDemandBreakdownFor(afterDesertion, ownerId, workforce)
  const foodDemand = demand.total
  const food = consumeFood(demand, resources)
  resources = { ...resources, flour: resources.flour - food.flour, meat: resources.meat - food.meat, fruit: resources.fruit - food.fruit }
  return {
    resources,
    foodDemand,
    food,
    upkeepPaid,
    uncoveredUpkeep,
    desertion: desertionResult.loss,
    cells: desertionResult.cells,
    production,
    taxIncome,
    upkeep,
    processing,
    workforce,
  }
}

export function turnEconomyForecastFor(state: MatchState, ownerId: string): TurnEconomyForecast | null {
  const resolution = resolveTurnEconomy(state, ownerId)
  return resolution
    ? {
        resources: resolution.resources,
        foodDemand: resolution.foodDemand,
        food: resolution.food,
        upkeepPaid: resolution.upkeepPaid,
        upkeep: resolution.upkeep,
        uncoveredUpkeep: resolution.uncoveredUpkeep,
        production: resolution.production,
        taxIncome: resolution.taxIncome,
        processing: resolution.processing,
        desertion: resolution.desertion,
        workforce: resolution.workforce,
      }
    : null
}

export function turnResourceDeltaFor(state: MatchState, ownerId: string) {
  const current = state.domains[ownerId]
  if (!current) return Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  const resolution = turnEconomyForecastFor(state, ownerId)
  if (!resolution) return Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  return Object.fromEntries(
    resourceIds.map((resource) => [resource, resolution.resources[resource] - current.resources[resource]]),
  ) as Record<ResourceId, number>
}

export function setTaxRate(state: MatchState, rate: TaxRate): CommandResult {
  if (state.status !== 'playing') return { ok: false, state, reason: 'game-over' }
  const domain = activeDomain(state)
  return {
    ok: true,
    state: {
      ...state,
      domains: { ...state.domains, [state.activeParticipantId]: { ...domain, taxRate: rate } },
      lastEvent: { kind: 'tax-changed' },
    },
  }
}

export interface TradeQuote {
  total: number
  currentUnitPrice: number
  nextUnitPrice: number
  unitsUntilNextPrice: number
  includesUnavailableUnits: boolean
}

export function tradeQuoteFor(domain: DomainEconomy, resource: TradeResource, direction: 'buy' | 'sell', quantity: number): TradeQuote {
  const activity = domain.marketActivity ?? emptyMarketActivity()
  const traded = direction === 'buy' ? activity.bought[resource] : activity.sold[resource]
  const batchSize = marketPriceBatchSizes[resource]
  const basePrice = marketPrices[resource][direction]
  const quotedQuantity = Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0
  const priceAt = (offset: number) => {
    const tier = Math.floor((traded + offset) / batchSize)
    return direction === 'buy' ? basePrice + tier : Math.max(0, basePrice - tier)
  }
  const tierSumBefore = (units: number) => {
    const fullBatches = Math.floor(units / batchSize)
    const remainder = units % batchSize
    return (batchSize * fullBatches * (fullBatches - 1)) / 2 + fullBatches * remainder
  }
  const pricedQuantity = direction === 'sell' ? Math.min(quotedQuantity, Math.max(0, basePrice * batchSize - traded)) : quotedQuantity
  const tierSum = tierSumBefore(traded + pricedQuantity) - tierSumBefore(traded)
  const currentUnitPrice = priceAt(0)
  return {
    total: direction === 'buy' ? pricedQuantity * basePrice + tierSum : pricedQuantity * basePrice - tierSum,
    currentUnitPrice,
    nextUnitPrice: direction === 'buy' ? currentUnitPrice + 1 : Math.max(0, currentUnitPrice - 1),
    unitsUntilNextPrice: batchSize - (traded % batchSize),
    includesUnavailableUnits: direction === 'sell' && pricedQuantity < quotedQuantity,
  }
}

export function trade(
  state: MatchState,
  marketPosition: CellPosition,
  resource: TradeResource,
  direction: 'buy' | 'sell',
  quantity: number,
): CommandResult {
  if (state.status !== 'playing') return { ok: false, state, reason: 'game-over' }
  const market = objectAt(state, marketPosition)
  if (market?.type !== 'building' || market.kind !== 'market' || market.ownerId !== state.activeParticipantId)
    return { ok: false, state, reason: 'requires-market' }
  if (!tradeableResources.includes(resource) || !Number.isSafeInteger(quantity) || quantity < 1)
    return { ok: false, state, reason: 'invalid-trade' }
  const domain = activeDomain(state)
  const quote = tradeQuoteFor(domain, resource, direction, quantity)
  if (quote.includesUnavailableUnits) return { ok: false, state, reason: 'market-exhausted' }
  const price = quote.total
  if (direction === 'buy' && domain.resources.gold < price) return { ok: false, state, reason: 'not-enough-resources' }
  if (direction === 'sell' && domain.resources[resource] < quantity) return { ok: false, state, reason: 'not-enough-resources' }
  const resources = { ...domain.resources }
  if (direction === 'buy') {
    resources.gold -= price
    resources[resource] += quantity
  } else {
    resources[resource] -= quantity
    resources.gold += price
  }
  const marketActivity = domain.marketActivity ?? emptyMarketActivity()
  const activityKey = direction === 'buy' ? 'bought' : 'sold'
  const nextActivity = { ...marketActivity[activityKey], [resource]: marketActivity[activityKey][resource] + quantity }
  return {
    ok: true,
    state: {
      ...state,
      domains: {
        ...state.domains,
        [state.activeParticipantId]: { ...domain, resources, marketActivity: { ...marketActivity, [activityKey]: nextActivity } },
      },
      lastEvent: { kind: 'traded', amount: quantity },
    },
  }
}

function removeCheapestTroop(cells: GameMap, ownerId: string): { cells: GameMap; loss: TroopLoss | null } {
  for (const kind of starvationTroopOrder) {
    for (let row = 0; row < cells.length; row += 1) {
      for (let column = 0; column < cells[row].length; column += 1) {
        const object = cells[row][column].object
        if (!object || object.ownerId !== ownerId) continue
        if (object.type === 'squad' && (object.units[kind] ?? 0) > 0) {
          const units = { ...object.units, [kind]: object.units[kind] - 1 }
          const nextCells = [...cells]
          const nextRow = [...nextCells[row]]
          nextCells[row] = nextRow
          nextRow[column] = {
            ...nextRow[column],
            object:
              squadSize({ units }) > 0 ? { ...object, units, health: Math.min(squadHealth(object), maxSquadHealth({ units })) } : undefined,
          }
          return { cells: nextCells, loss: { kind, position: { column, row }, source: 'squad' } }
        }
        if (kind === 'archers' && object.type === 'building' && object.kind === 'tower' && (object.garrison?.archers ?? 0) > 0) {
          const nextCells = [...cells]
          const nextRow = [...nextCells[row]]
          nextCells[row] = nextRow
          const archers = object.garrison!.archers - 1
          nextRow[column] = {
            ...nextRow[column],
            object: {
              ...object,
              garrison:
                archers > 0 ? { archers, health: Math.min(object.garrison!.health, archers * troopRules.archers.durability) } : undefined,
            },
          }
          return { cells: nextCells, loss: { kind, position: { column, row }, source: 'garrison' } }
        }
      }
    }
  }
  return { cells, loss: null }
}

export function endTurn(state: MatchState): CommandResult {
  if (state.status !== 'playing') return { ok: false, state, reason: 'game-over' }
  const ownerId = state.activeParticipantId
  const current = state.domains[ownerId]
  if (!current) return { ok: false, state, reason: 'not-owned' }
  const resolution = resolveTurnEconomy(state, ownerId)
  if (!resolution) return { ok: false, state, reason: 'not-owned' }
  const { resources, food, upkeepPaid } = resolution
  let cells = resolution.cells
  let population = current.population
  let populationReason: TurnReport['populationReason'] = null
  let starvation: TurnReport['starvation'] = null
  const afterEconomyState = { ...state, scenario: { ...state.scenario, cells } }
  if (food.fed) {
    const capacityState = {
      ...afterEconomyState,
      domains: { ...afterEconomyState.domains, [ownerId]: { ...current, diverseDiet: food.diverseDiet } },
    }
    const civilianCapacity = civilianPopulationCapacityFor(capacityState, ownerId)
    if (current.population > civilianCapacity) {
      population = Math.max(civilianCapacity, current.population - Math.min(1, gameConfig.economy.starvationPopulationLoss))
      populationReason = 'capacity'
    } else if (current.population < civilianCapacity) {
      const dietGrowth = food.diverseDiet ? gameConfig.economy.diverseDietPopulationGrowthBonus : 0
      population = Math.min(
        civilianCapacity,
        current.population +
          gameConfig.economy.basePopulationGrowth +
          dietGrowth +
          (upkeepPaid ? populationGrowthFor(afterEconomyState, ownerId) : 0),
      )
      if (population > current.population) populationReason = 'growth'
    }
  } else {
    const soldiers = totalArmySize(afterEconomyState, ownerId)
    if (current.population > 0 && current.population + soldiers > gameConfig.economy.minimumPopulation) {
      population = Math.max(0, current.population - gameConfig.economy.starvationPopulationLoss)
      populationReason = 'starvation'
      starvation = 'civilian'
    } else if (current.population === 0 && soldiers > gameConfig.economy.minimumPopulation) {
      const starvationResult = removeCheapestTroop(cells, ownerId)
      cells = starvationResult.cells
      starvation = starvationResult.loss
    }
  }
  const domains = {
    ...state.domains,
    [ownerId]: { ...current, resources, population, diverseDiet: food.diverseDiet, marketActivity: emptyMarketActivity() },
  }
  const report: TurnReport = {
    ownerId,
    resourcesBefore: { ...current.resources },
    production: resolution.production,
    taxIncome: resolution.taxIncome,
    upkeep: resolution.upkeep,
    upkeepPaid,
    processing: resolution.processing,
    food,
    resourcesAfter: { ...resources },
    populationBefore: current.population,
    populationAfter: population,
    populationReason,
    desertion: resolution.desertion,
    starvation,
  }
  const participants = state.scenario.participants
  const currentIndex = Math.max(
    0,
    participants.findIndex((participant) => participant.id === ownerId),
  )
  let nextParticipant = participants[currentIndex]
  for (let offset = 1; offset <= participants.length; offset += 1) {
    const candidate = participants[(currentIndex + offset) % participants.length]
    if (hasLivingCastle({ scenario: { ...state.scenario, cells } }, candidate.id)) {
      nextParticipant = candidate
      break
    }
  }
  const nextParticipantIndex = participants.findIndex((participant) => participant.id === nextParticipant.id)
  const spectatorMatch = participants.every((participant) => participant.kind === 'ai')
  const wrappedToNextRound =
    participants.length === 1
      ? true
      : spectatorMatch
        ? nextParticipantIndex <= currentIndex
        : nextParticipant.id === state.playerId && ownerId !== state.playerId
  return {
    ok: true,
    state: {
      ...state,
      turn: state.turn + (wrappedToNextRound ? 1 : 0),
      activeParticipantId: nextParticipant.id,
      ordersRemaining: gameConfig.turn.maxOrders,
      domains,
      scenario: { ...state.scenario, cells },
      lastEvent: { kind: 'turn-ended' },
      lastTurnReports: { ...state.lastTurnReports, [ownerId]: report },
    },
  }
}

export interface OwnerEconomyProjection {
  state: MatchState
  reports: TurnReport[]
}

/**
 * Runs the authoritative end-of-turn economy repeatedly for one owner without
 * advancing the real participant cycle. Used by forecasts and AI evaluation.
 */
export function projectOwnerEconomy(state: MatchState, ownerId: string, turns: number): OwnerEconomyProjection {
  let projected: MatchState = { ...state, activeParticipantId: ownerId, ordersRemaining: gameConfig.turn.maxOrders }
  const reports: TurnReport[] = []
  for (let index = 0; index < Math.max(0, Math.floor(turns)); index += 1) {
    const result = endTurn(projected)
    if (!result.ok) break
    const report = result.state.lastTurnReports[ownerId]
    if (report) reports.push(report)
    projected = {
      ...result.state,
      activeParticipantId: ownerId,
      ordersRemaining: gameConfig.turn.maxOrders,
      turn: state.turn + index + 1,
    }
  }
  return { state: projected, reports }
}
