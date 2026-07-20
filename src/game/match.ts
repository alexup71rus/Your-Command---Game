import { buildingRules, castleProduction, combatRules, defaultTaxRate, marketPriceBatchSizes, marketPrices, resourceIds, starvationTroopOrder, startingResources, taxRates, tradeableResources, troopKinds, troopRules, workerBuildingKinds, type ResourceAmount, type TaxRate, type TradeResource } from '../config/rules'
import { gameConfig } from '../config/game'
import type {
  BuildingKind,
  BuildingObject,
  GameMap,
  MapCell,
  MapObject,
  ResourceId,
  SquadObject,
  TowerGarrison,
  TroopComposition,
  TroopKind,
} from './map'
import type { CellPosition, MapScenario, MatchParticipant } from './scenario'
import { cardinalDirections } from './geometry'
import { friendlyBarbicanPassage, squadMovementOrderCost, squadMovementOrderCostBetween } from './movement'
import { createAiMemory, type AiMemory } from './ai/model'

export interface DomainEconomy {
  resources: Record<ResourceId, number>
  population: number
  taxRate?: TaxRate
  diverseDiet: boolean
  marketActivity: MarketActivity
}

export interface MarketActivity {
  bought: Record<TradeResource, number>
  sold: Record<TradeResource, number>
}

export interface WorkerAssignment {
  kind: BuildingKind
  position: CellPosition
  required: number
  assigned: number
  blockedReason?: 'missing-support' | 'idle-support' | 'no-workers'
}

export interface WorkforceSummary {
  population: number
  employed: number
  free: number
  assignments: WorkerAssignment[]
}

export interface FoodDemand {
  civilians: number
  soldiers: number
  taxFood: number
  staple: number
  total: number
  servedCivilians: number
  unservedCivilians: number
}

export interface FoodConsumption {
  flour: number
  meat: number
  fruit: number
  fed: boolean
  diverseDiet: boolean
}

export interface TroopLoss {
  kind: TroopKind
  position: CellPosition
  source: 'squad' | 'garrison'
}

export interface TurnReport {
  ownerId: string
  resourcesBefore: Record<ResourceId, number>
  production: Record<ResourceId, number>
  taxIncome: number
  upkeep: Record<ResourceId, number>
  upkeepPaid: boolean
  processing: Record<ResourceId, number>
  food: FoodConsumption
  resourcesAfter: Record<ResourceId, number>
  populationBefore: number
  populationAfter: number
  populationReason: 'growth' | 'starvation' | 'capacity' | null
  desertion: TroopLoss | null
  starvation: 'civilian' | TroopLoss | null
}

export type MatchStatus = 'playing' | 'won' | 'lost'

export interface MatchEvent {
  kind: 'built' | 'recruited' | 'moved' | 'merged' | 'split' | 'dismissed' | 'garrisoned' | 'ungarrisoned' | 'attacked' | 'destroyed' | 'demolished' | 'traded' | 'tax-changed' | 'turn-ended'
  position?: CellPosition
  amount?: number
}

export interface MatchState {
  scenario: MapScenario
  playerId: string
  activeParticipantId: string
  turn: number
  ordersRemaining: number
  domains: Record<string, DomainEconomy>
  status: MatchStatus
  lastEvent: MatchEvent | null
  lastTurnReports: Record<string, TurnReport>
  aiMemory: Record<string, AiMemory>
}

export type CommandFailure =
  | 'game-over'
  | 'not-owned'
  | 'occupied'
  | 'invalid-terrain'
  | 'outside-domain'
  | 'outside-food-service'
  | 'requires-support'
  | 'requires-farm-site'
  | 'building-limit'
  | 'not-adjacent'
  | 'not-enough-orders'
  | 'not-enough-resources'
  | 'not-enough-population'
  | 'requires-barracks'
  | 'squad-full'
  | 'army-full'
  | 'invalid-squad'
  | 'invalid-garrison'
  | 'requires-garrison'
  | 'requires-target'
  | 'cannot-demolish'
  | 'requires-market'
  | 'invalid-trade'
  | 'market-exhausted'
  | 'ranged-shot-blocked'
  | 'out-of-range'

export type CommandResult =
  | { ok: true; state: MatchState }
  | { ok: false; state: MatchState; reason: CommandFailure }

const emptyComposition = (): TroopComposition => ({ militia: 0, spearmen: 0, archers: 0, knights: 0 })
const emptyTradeRecord = (): Record<TradeResource, number> => Object.fromEntries(tradeableResources.map((resource) => [resource, 0])) as Record<TradeResource, number>
const emptyMarketActivity = (): MarketActivity => ({ bought: emptyTradeRecord(), sold: emptyTradeRecord() })
const positionEquals = (a: CellPosition, b: CellPosition) => a.column === b.column && a.row === b.row
const isAdjacent = (a: CellPosition, b: CellPosition) => Math.abs(a.column - b.column) + Math.abs(a.row - b.row) === 1
const cellAt = (state: MatchState, position: CellPosition) => state.scenario.cells[position.row]?.[position.column]

function isValidComposition(units: TroopComposition) {
  return troopKinds.every((kind) => Number.isSafeInteger(units[kind] ?? 0) && (units[kind] ?? 0) >= 0)
}

export function buildingFootprintPositions(kind: BuildingKind, origin: CellPosition) {
  const footprint = buildingRules[kind].footprint ?? { columns: 1, rows: 1 }
  return Array.from({ length: footprint.rows }, (_, rowOffset) =>
    Array.from({ length: footprint.columns }, (_, columnOffset) => ({ column: origin.column + columnOffset, row: origin.row + rowOffset })),
  ).flat()
}

function buildingObjectPositions(building: BuildingObject, fallback: CellPosition) {
  if (!building.footprint) return [fallback]
  return Array.from({ length: building.footprint.rows }, (_, rowOffset) =>
    Array.from({ length: building.footprint!.columns }, (_, columnOffset) => ({
      column: building.footprint!.originColumn + columnOffset,
      row: building.footprint!.originRow + rowOffset,
    })),
  ).flat()
}

function isPrimaryObjectCell(object: MapObject, column: number, row: number) {
  return object.type !== 'building' || !object.footprint || (object.footprint.originColumn === column && object.footprint.originRow === row)
}

export function squadSize(squad: Pick<SquadObject, 'units'>) {
  return troopKinds.reduce((total, kind) => total + (squad.units[kind] ?? 0), 0)
}

export const armyCapacity = gameConfig.army.capacity

export function totalArmySize(state: MatchState, ownerId = state.playerId) {
  const totals = troopTotals(state, ownerId)
  return troopKinds.reduce((total, kind) => total + totals[kind], 0)
}

export function maxSquadHealth(squad: Pick<SquadObject, 'units'>) {
  return troopKinds.reduce((total, kind) => total + (squad.units[kind] ?? 0) * troopRules[kind].durability, 0)
}

export function squadHealth(squad: Pick<SquadObject, 'units' | 'health'>) {
  return Math.min(squad.health ?? maxSquadHealth(squad), maxSquadHealth(squad))
}

export function troopTotals(state: MatchState, ownerId: string): TroopComposition {
  return state.scenario.cells.flat().reduce((totals, cell) => {
    const object = cell.object
    if (!object || object.ownerId !== ownerId) return totals
    if (object.type === 'squad') troopKinds.forEach((kind) => { totals[kind] += object.units[kind] ?? 0 })
    if (object.type === 'building' && object.kind === 'tower' && object.garrison) totals.archers += object.garrison.archers
    return totals
  }, emptyComposition())
}

interface OwnedBuildingEntry {
  kind: BuildingKind
  position: CellPosition
}

function ownedBuildingEntries(state: MatchState, ownerId: string, kind?: BuildingKind): OwnedBuildingEntry[] {
  return state.scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
    const object = cell.object
    if (object?.type !== 'building' || object.ownerId !== ownerId || !isPrimaryObjectCell(object, column, rowIndex) || (kind && object.kind !== kind)) return []
    return [{ kind: object.kind, position: { column, row: rowIndex } }]
  }))
}

export function ownedBuildingCount(state: MatchState, ownerId: string, kind: BuildingKind) {
  return ownedBuildingEntries(state, ownerId, kind).length
}

export function buildingResourceCostFor(state: MatchState, ownerId: string, kind: BuildingKind): ResourceAmount {
  const rule = buildingRules[kind]
  const resources = state.domains[ownerId]?.resources
  const emergencyFree = rule.emergencyFreeIfMissing
    && ownedBuildingCount(state, ownerId, kind) === 0
    && resources
    && !hasResources(resources, rule.resourceCost)
  return emergencyFree ? {} : rule.resourceCost
}

export function isEmergencyBuildingFree(state: MatchState, ownerId: string, kind: BuildingKind) {
  return Boolean(buildingRules[kind].emergencyFreeIfMissing)
    && ownedBuildingCount(state, ownerId, kind) === 0
    && Object.keys(buildingResourceCostFor(state, ownerId, kind)).length === 0
}

function buildingDistance(first: OwnedBuildingEntry, second: OwnedBuildingEntry) {
  const firstCells = buildingFootprintPositions(first.kind, first.position)
  const secondCells = buildingFootprintPositions(second.kind, second.position)
  return Math.min(...firstCells.flatMap((a) => secondCells.map((b) => Math.abs(a.column - b.column) + Math.abs(a.row - b.row))))
}

function positionKey(position: CellPosition) {
  return `${position.column}:${position.row}`
}

function farmSupportAssignments(state: MatchState, ownerId: string) {
  const mills = ownedBuildingEntries(state, ownerId, 'mill').sort((a, b) => a.position.row - b.position.row || a.position.column - b.position.column)
  const farms = ownedBuildingEntries(state, ownerId, 'farm')
  farms.sort((a, b) => a.position.row - b.position.row || a.position.column - b.position.column)
  const millRule = buildingRules.mill.farmSupport!
  const slots = mills.flatMap((mill) => Array.from({ length: millRule.capacity }, (_, index) => ({ mill, index })))
  const slotOwner = new Map<number, string>()
  const farmByKey = new Map(farms.map((farm) => [positionKey(farm.position), farm]))

  const candidatesFor = (farm: OwnedBuildingEntry) => slots
    .map((slot, slotIndex) => ({ slot, slotIndex, distance: buildingDistance(farm, slot.mill) }))
    .filter(({ distance }) => distance <= millRule.radius)
    .sort((a, b) => a.distance - b.distance
      || a.slot.mill.position.row - b.slot.mill.position.row
      || a.slot.mill.position.column - b.slot.mill.position.column
      || a.slot.index - b.slot.index)

  const assign = (farm: OwnedBuildingEntry, visited: Set<number>): boolean => {
    for (const { slotIndex } of candidatesFor(farm)) {
      if (visited.has(slotIndex)) continue
      visited.add(slotIndex)
      const previousFarmKey = slotOwner.get(slotIndex)
      if (!previousFarmKey || assign(farmByKey.get(previousFarmKey)!, visited)) {
        slotOwner.set(slotIndex, positionKey(farm.position))
        return true
      }
    }
    return false
  }

  farms.forEach((farm) => assign(farm, new Set()))
  const result = new Map<string, CellPosition>()
  slotOwner.forEach((farmKey, slotIndex) => result.set(farmKey, slots[slotIndex].mill.position))
  return result
}

export function supportingMillFor(state: MatchState, ownerId: string, farm: CellPosition, includeCandidate = false): CellPosition | null {
  const assignments = farmSupportAssignments(state, ownerId)
  if (!includeCandidate) return assignments.get(positionKey(farm)) ?? null
  const millRule = buildingRules.mill.farmSupport!
  const assignedCounts = new Map<string, number>()
  assignments.forEach((mill) => assignedCounts.set(positionKey(mill), (assignedCounts.get(positionKey(mill)) ?? 0) + 1))
  const candidate = { kind: 'farm' as const, position: farm }
  return ownedBuildingEntries(state, ownerId, 'mill')
    .map((mill) => ({ mill, distance: buildingDistance(candidate, mill) }))
    .filter(({ mill, distance }) => distance <= millRule.radius && (assignedCounts.get(positionKey(mill.position)) ?? 0) < millRule.capacity)
    .sort((first, second) => first.distance - second.distance
      || first.mill.position.row - second.mill.position.row
      || first.mill.position.column - second.mill.position.column)[0]?.mill.position ?? null
}

export function workforceFor(state: MatchState, ownerId: string): WorkforceSummary {
  const population = Math.max(0, state.domains[ownerId]?.population ?? 0)
  const supports = farmSupportAssignments(state, ownerId)
  const usedMills = new Set([...supports.values()].map(positionKey))
  const assignments: WorkerAssignment[] = state.scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
    const object = cell.object
    if (object?.type !== 'building' || object.ownerId !== ownerId || !isPrimaryObjectCell(object, column, rowIndex)) return []
    const required = buildingRules[object.kind].workersRequired ?? 0
    if (required <= 0) return []
    const position = { column, row: rowIndex }
    const blockedReason = object.kind === 'farm' && !supports.has(positionKey(position))
      ? 'missing-support' as const
      : object.kind === 'mill' && !usedMills.has(positionKey(position))
        ? 'idle-support' as const
        : undefined
    return [{ kind: object.kind, position, required, assigned: 0, blockedReason }]
  })).sort((first, second) => {
    const kindOrder = workerBuildingKinds.indexOf(first.kind) - workerBuildingKinds.indexOf(second.kind)
    return kindOrder || first.position.row - second.position.row || first.position.column - second.position.column
  })
  let available = population
  assignments.forEach((assignment) => {
    if (assignment.blockedReason) return
    assignment.assigned = Math.min(assignment.required, available)
    available -= assignment.assigned
    if (assignment.assigned === 0) assignment.blockedReason = 'no-workers'
  })
  return { population, employed: population - available, free: available, assignments }
}

export function workerAssignmentAt(state: MatchState, position: CellPosition): WorkerAssignment | null {
  const object = objectAt(state, position)
  if (object?.type !== 'building' || !buildingRules[object.kind].workersRequired) return null
  const origin = object.footprint
    ? { column: object.footprint.originColumn, row: object.footprint.originRow }
    : position
  return workforceFor(state, object.ownerId).assignments.find((assignment) => positionEquals(assignment.position, origin)) ?? null
}

export function civilianHousingCapacityFor(state: MatchState, ownerId: string) {
  const domain = state.domains[ownerId]
  if (!domain) return 0
  const houses = state.scenario.cells.reduce((capacity, row) => capacity + row.reduce((rowCapacity, cell) => {
    const object = cell.object
    if (object?.type !== 'building' || object.kind !== 'house' || object.ownerId !== ownerId) return rowCapacity
    return rowCapacity + (buildingRules.house.housingCapacity ?? 0)
  }, 0), 0)
  return Math.max(0, gameConfig.turn.basePopulationCapacity + houses - totalArmySize(state, ownerId))
}

export function foodServiceCapacityFor(state: MatchState, ownerId: string, workforce = workforceFor(state, ownerId)) {
  const assignments = new Map(workforce.assignments.map((assignment) => [`${assignment.position.column}:${assignment.position.row}`, assignment]))
  const hasLivingCastle = state.scenario.cells.some((row) => row.some((cell) => cell.object?.type === 'castle' && cell.object.ownerId === ownerId))
  let capacity = hasLivingCastle ? gameConfig.economy.castleFoodServiceCapacity : 0
  state.scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    if (object?.type !== 'building' || object.ownerId !== ownerId || !isPrimaryObjectCell(object, column, rowIndex)) return
    const service = buildingRules[object.kind].foodServiceCapacity ?? 0
    if (!service) return
    const assignment = assignments.get(`${column}:${rowIndex}`)
    const workerRatio = assignment ? assignment.assigned / assignment.required : 1
    capacity += Math.floor(service * workerRatio)
  }))
  return capacity
}

export function civilianPopulationCapacityFor(state: MatchState, ownerId: string) {
  return Math.min(civilianHousingCapacityFor(state, ownerId), foodServiceCapacityFor(state, ownerId))
}

export function createMatch(scenario: MapScenario): MatchState {
  const player = scenario.participants.find((participant) => participant.kind === 'human')
  if (!player) throw new Error('A founded scenario must contain a human participant')
  const domains = Object.fromEntries(scenario.participants.map((participant) => [
    participant.id,
    {
      resources: { ...startingResources },
      population: gameConfig.turn.startingPopulation,
      taxRate: defaultTaxRate,
      diverseDiet: false,
      marketActivity: emptyMarketActivity(),
    },
  ]))
  return {
    scenario,
    playerId: player.id,
    activeParticipantId: player.id,
    turn: 1,
    ordersRemaining: gameConfig.turn.maxOrders,
    domains,
    status: 'playing',
    lastEvent: null,
    lastTurnReports: {},
    aiMemory: Object.fromEntries(scenario.participants
      .filter((participant) => participant.kind === 'ai')
      .map((participant) => [participant.id, createAiMemory()])),
  }
}

export function participantForOwner(state: MatchState, ownerId: string): MatchParticipant | undefined {
  return state.scenario.participants.find((participant) => participant.id === ownerId)
}

export function humanDomain(state: MatchState) {
  return state.domains[state.playerId]
}

export function activeDomain(state: MatchState) {
  return state.domains[state.activeParticipantId]
}

export function objectAt(state: MatchState, position: CellPosition) {
  return cellAt(state, position)?.object
}

export function isOwnedObject(state: MatchState, position: CellPosition, ownerId = state.playerId) {
  return objectAt(state, position)?.ownerId === ownerId
}

function hasResources(resources: Record<ResourceId, number>, cost: ResourceAmount, quantity = 1) {
  return resourceIds.every((resource) => resources[resource] >= (cost[resource] ?? 0) * quantity)
}

function applyResources(resources: Record<ResourceId, number>, amount: ResourceAmount, multiplier = 1) {
  const next = { ...resources }
  resourceIds.forEach((resource) => { next[resource] += (amount[resource] ?? 0) * multiplier })
  return next
}

function spendResources(resources: Record<ResourceId, number>, cost: ResourceAmount, quantity = 1) {
  return applyResources(resources, cost, -quantity)
}

function withCell(state: MatchState, position: CellPosition, transform: (cell: MapCell) => MapCell, event: MatchEvent, ordersSpent: number): MatchState {
  const cells: GameMap = [...state.scenario.cells]
  const row = [...cells[position.row]]
  cells[position.row] = row
  row[position.column] = transform(row[position.column])
  return {
    ...state,
    scenario: { ...state.scenario, cells },
    ordersRemaining: state.ordersRemaining - ordersSpent,
    lastEvent: event,
  }
}

function withCells(state: MatchState, positions: CellPosition[], transform: (cell: MapCell, position: CellPosition) => MapCell, event: MatchEvent, ordersSpent: number): MatchState {
  const cells: GameMap = [...state.scenario.cells]
  const rows = new Map<number, GameMap[number]>()
  positions.forEach((position) => {
    const row = rows.get(position.row) ?? [...cells[position.row]]
    rows.set(position.row, row)
    cells[position.row] = row
    row[position.column] = transform(row[position.column], position)
  })
  return {
    ...state,
    scenario: { ...state.scenario, cells },
    ordersRemaining: state.ordersRemaining - ordersSpent,
    lastEvent: event,
  }
}

function withTwoCells(
  state: MatchState,
  first: CellPosition,
  second: CellPosition,
  firstCell: MapCell,
  secondCell: MapCell,
  event: MatchEvent,
  ordersSpent: number = gameConfig.turn.movementOrderCost,
): MatchState {
  const cells: GameMap = [...state.scenario.cells]
  const rows = new Map<number, GameMap[number]>()
  const write = (position: CellPosition, cell: MapCell) => {
    const row = rows.get(position.row) ?? [...cells[position.row]]
    rows.set(position.row, row)
    cells[position.row] = row
    row[position.column] = cell
  }
  write(first, firstCell)
  write(second, secondCell)
  return {
    ...state,
    scenario: { ...state.scenario, cells },
    ordersRemaining: state.ordersRemaining - ordersSpent,
    lastEvent: event,
  }
}

function commandGuard(state: MatchState, actionCost: number): CommandFailure | null {
  if (state.status !== 'playing') return 'game-over'
  if (state.ordersRemaining < actionCost) return 'not-enough-orders'
  return null
}

export function buildingAvailabilityFailure(state: MatchState, kind: BuildingKind): CommandFailure | null {
  const guard = buildingCommandGuard(state, kind)
  if (guard) return guard
  if (!hasResources(activeDomain(state).resources, buildingResourceCostFor(state, state.activeParticipantId, kind))) return 'not-enough-resources'
  return null
}

function buildingCommandGuard(state: MatchState, kind: BuildingKind): CommandFailure | null {
  const rule = buildingRules[kind]
  const guard = commandGuard(state, rule.actionCost)
  if (guard) return guard
  return rule.maxPerOwner && ownedBuildingCount(state, state.activeParticipantId, kind) >= rule.maxPerOwner ? 'building-limit' : null
}

function activeRegionId(state: MatchState) {
  return participantForOwner(state, state.activeParticipantId)?.regionId
}

function hasPotentialFarmSiteForMill(state: MatchState, millPosition: CellPosition) {
  const farmRule = buildingRules.farm
  const millRule = buildingRules.mill.farmSupport!
  const footprint = farmRule.footprint!
  const regionId = activeRegionId(state)
  if (ownedBuildingEntries(state, state.activeParticipantId, 'farm').some((farm) => buildingDistance({ kind: 'mill', position: millPosition }, farm) <= millRule.radius)) return true
  for (let row = millPosition.row - millRule.radius - footprint.rows + 1; row <= millPosition.row + millRule.radius; row += 1) {
    for (let column = millPosition.column - millRule.radius - footprint.columns + 1; column <= millPosition.column + millRule.radius; column += 1) {
      const origin = { column, row }
      const positions = buildingFootprintPositions('farm', origin)
      if (positions.some((candidate) => positionEquals(candidate, millPosition))) continue
      const cells = positions.map((candidate) => cellAt(state, candidate))
      if (cells.some((cell) => !cell || cell.object || cell.landform !== 'plain' || cell.vegetation)) continue
      if (positions.some((candidate) => state.scenario.territories[candidate.row]?.[candidate.column] !== regionId)) continue
      if (buildingDistance({ kind: 'mill', position: millPosition }, { kind: 'farm', position: origin }) <= millRule.radius) return true
    }
  }
  return false
}

/**
 * Validates the authored map position independently from the current order and
 * resource budget. Planning code uses this to compare real build sites without
 * spending its search budget on occupied, unsupported, or invalid footprints.
 */
export function buildingSiteFailure(state: MatchState, kind: BuildingKind, position: CellPosition): CommandFailure | null {
  const rule = buildingRules[kind]
  const positions = buildingFootprintPositions(kind, position)
  const cells = positions.map((candidate) => cellAt(state, candidate))
  if (cells.some((cell) => !cell || cell.landform === 'peak')) return 'invalid-terrain'
  if (cells.some((cell) => cell?.object)) return 'occupied'
  const regionId = activeRegionId(state)
  if (positions.some((candidate) => state.scenario.territories[candidate.row]?.[candidate.column] !== regionId)) return 'outside-domain'
  if (rule.requiresFoodServiceAccess) {
    const inRange = state.scenario.cells.some((row, rowIndex) => row.some((cell, column) => {
      const object = cell.object
      if (!object || object.ownerId !== state.activeParticipantId || !isPrimaryObjectCell(object, column, rowIndex)) return false
      const isServiceSource = object.type === 'castle' || (object.type === 'building' && (buildingRules[object.kind].foodServiceCapacity ?? 0) > 0)
      return isServiceSource && positions.some((candidate) => Math.abs(candidate.column - column) + Math.abs(candidate.row - rowIndex) <= gameConfig.economy.foodServiceRadius)
    }))
    if (!inRange) return 'outside-food-service'
  }
  const placement = rule.placement
  if (rule.minimumAdjacentForestCells) {
    const adjacentForestCells = new Set(positions.flatMap((candidate) => cardinalDirections.map((direction) => ({
      column: candidate.column + direction.column,
      row: candidate.row + direction.row,
    }))).filter((neighbor) => cellAt(state, neighbor)?.vegetation).map((neighbor) => `${neighbor.column}:${neighbor.row}`))
    if (adjacentForestCells.size < rule.minimumAdjacentForestCells) return 'invalid-terrain'
  }
  if (placement === 'hill' && cells.some((cell) => cell?.landform !== 'hill' || cell.vegetation)) return 'invalid-terrain'
  if (placement === 'plain' && cells.some((cell) => cell?.landform !== 'plain' || cell.vegetation)) return 'invalid-terrain'
  if (placement === 'open' && cells.some((cell) => cell?.vegetation)) return 'invalid-terrain'
  if (kind === 'mill' && !hasPotentialFarmSiteForMill(state, position)) return 'requires-farm-site'
  if (rule.requiresMillSupport && !supportingMillFor(state, state.activeParticipantId, position, true)) return 'requires-support'
  return null
}

export function buildingPlacementFailure(state: MatchState, kind: BuildingKind, position: CellPosition): CommandFailure | null {
  const guard = buildingCommandGuard(state, kind)
  if (guard) return guard
  const siteFailure = buildingSiteFailure(state, kind, position)
  if (siteFailure) return siteFailure
  if (!hasResources(activeDomain(state).resources, buildingResourceCostFor(state, state.activeParticipantId, kind))) return 'not-enough-resources'
  return null
}

export function build(state: MatchState, kind: BuildingKind, position: CellPosition): CommandResult {
  const failure = buildingPlacementFailure(state, kind, position)
  if (failure) return { ok: false, state, reason: failure }
  const rule = buildingRules[kind]
  const constructionCost = buildingResourceCostFor(state, state.activeParticipantId, kind)
  const footprint = rule.footprint
  const object: BuildingObject = {
    type: 'building',
    kind,
    ownerId: state.activeParticipantId,
    hitPoints: rule.hitPoints,
    maxHitPoints: rule.hitPoints,
    constructionCost: { ...constructionCost },
    footprint: footprint ? { originColumn: position.column, originRow: position.row, ...footprint } : undefined,
  }
  const next = withCells(state, buildingFootprintPositions(kind, position), (cell) => ({ ...cell, object }), { kind: 'built', position }, rule.actionCost)
  const domain = activeDomain(next)
  return {
    ok: true,
    state: {
      ...next,
      domains: {
        ...next.domains,
        [state.activeParticipantId]: {
          ...domain,
          resources: spendResources(domain.resources, constructionCost),
        },
      },
    },
  }
}

function recruitmentSourcePositions(state: MatchState, troop: TroopKind) {
  const positions: CellPosition[] = []
  state.scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    if (object?.ownerId !== state.activeParticipantId) return
    if ((troop === 'militia' && object.type === 'castle') || (object.type === 'building' && object.kind === 'barracks')) positions.push({ column, row: rowIndex })
  }))
  return positions
}

export function hasRecruitmentSource(state: MatchState, troop: TroopKind) {
  return recruitmentSourcePositions(state, troop).length > 0
}

export function recruitmentFailure(state: MatchState, troop: TroopKind, quantity: number, position: CellPosition): CommandFailure | null {
  const rule = troopRules[troop]
  const guard = commandGuard(state, rule.actionCost)
  if (guard) return guard
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > gameConfig.turn.squadCapacity) return 'invalid-squad'
  const cell = cellAt(state, position)
  if (!cell || cell.landform === 'peak') return 'invalid-terrain'
  if (cell.object && (cell.object.type !== 'squad' || cell.object.ownerId !== state.activeParticipantId)) return 'occupied'
  const existingSize = cell.object?.type === 'squad' ? squadSize(cell.object) : 0
  if (existingSize + quantity > gameConfig.turn.squadCapacity) return 'squad-full'
  if (!recruitmentSourcePositions(state, troop).some((source) => isAdjacent(source, position))) return 'requires-barracks'
  const domain = activeDomain(state)
  if (totalArmySize(state, state.activeParticipantId) + quantity > armyCapacity) return 'army-full'
  if (domain.population < rule.populationCost * quantity) return 'not-enough-population'
  if (!hasResources(domain.resources, rule.resourceCost, quantity)) return 'not-enough-resources'
  return null
}

export function recruit(state: MatchState, troop: TroopKind, quantity: number, position: CellPosition): CommandResult {
  const failure = recruitmentFailure(state, troop, quantity, position)
  if (failure) return { ok: false, state, reason: failure }
  const rule = troopRules[troop]
  const current = cellAt(state, position).object
  const units = current?.type === 'squad' ? { ...current.units } : emptyComposition()
  units[troop] = (units[troop] ?? 0) + quantity
  const health = (current?.type === 'squad' ? squadHealth(current) : 0) + rule.durability * quantity
  const squad: SquadObject = { type: 'squad', ownerId: state.activeParticipantId, units, health }
  const next = withCell(state, position, (cell) => ({ ...cell, object: squad }), { kind: 'recruited', position, amount: quantity }, rule.actionCost)
  const domain = activeDomain(next)
  return {
    ok: true,
    state: {
      ...next,
      domains: {
        ...next.domains,
        [state.activeParticipantId]: {
          ...domain,
          population: domain.population - rule.populationCost * quantity,
          resources: spendResources(domain.resources, rule.resourceCost, quantity),
        },
      },
    },
  }
}

function squadDamage(state: MatchState, squad: SquadObject, cell: MapCell) {
  const terrainMultiplier = cell.landform === 'hill'
    ? combatRules.melee.hillDamageMultiplier
    : cell.vegetation
      ? combatRules.melee.forestDamageMultiplier
      : 1
  const dietMultiplier = state.domains[squad.ownerId]?.diverseDiet ? gameConfig.economy.diverseDietDamageMultiplier : 1
  return troopKinds.reduce((sum, kind) => sum + (squad.units[kind] ?? 0) * troopRules[kind].damage, 0) * terrainMultiplier * dietMultiplier
}

function applySquadDamage(squad: SquadObject, damage: number): SquadObject | null {
  const nextHealth = Math.max(0, squadHealth(squad) - damage)
  if (nextHealth <= 0) return null

  const units = { ...squad.units }
  let remainingCapacity = maxSquadHealth({ units })
  combatRules.casualtyOrder.forEach((kind) => {
    const durability = troopRules[kind].durability
    while ((units[kind] ?? 0) > 0 && remainingCapacity - durability >= nextHealth - 0.0001) {
      units[kind] = (units[kind] ?? 0) - 1
      remainingCapacity -= durability
    }
  })

  return { ...squad, units, health: Math.min(nextHealth, remainingCapacity) }
}

export function hasLivingCastle(state: Pick<MatchState, 'scenario'>, ownerId: string) {
  return state.scenario.cells.some((row) => row.some((cell) => cell.object?.type === 'castle' && cell.object.ownerId === ownerId))
}

function collapseDefeatedOwner(state: MatchState, ownerId: string) {
  const cells = state.scenario.cells.map((row) => row.map((cell) => cell.object?.ownerId === ownerId ? { ...cell, object: undefined } : cell))
  return { ...state, scenario: { ...state.scenario, cells } }
}

function afterCastleDestroyed(state: MatchState, defeatedOwnerId: string) {
  if (defeatedOwnerId === state.playerId) return { ...state, status: 'lost' as const }
  const collapsed = collapseDefeatedOwner(state, defeatedOwnerId)
  const aiStillAlive = collapsed.scenario.participants.some((participant) => participant.kind === 'ai' && hasLivingCastle(collapsed, participant.id))
  return aiStillAlive ? collapsed : { ...collapsed, status: 'won' as const }
}

function withRangedStructureDamage(state: MatchState, position: CellPosition, defender: BuildingObject | Extract<MapObject, { type: 'castle' }>, hitPoints: number, damage: number, orderCost: number) {
  const destroyed = hitPoints <= 0
  const positions = defender.type === 'building' ? buildingObjectPositions(defender, position) : [position]
  return withCells(
    state,
    positions,
    (cell) => ({ ...cell, object: destroyed ? undefined : { ...defender, hitPoints } }),
    { kind: destroyed ? 'destroyed' : 'attacked', position, amount: damage },
    orderCost,
  )
}

function withMeleeStructureDamage(state: MatchState, from: CellPosition, to: CellPosition, attacker: SquadObject, defender: BuildingObject | Extract<MapObject, { type: 'castle' }>, hitPoints: number, damage: number) {
  const destroyed = hitPoints <= 0
  const structurePositions = defender.type === 'building' ? buildingObjectPositions(defender, to) : [to]
  return withCells(
    state,
    [...structurePositions, from],
    (cell, position) => {
      if (positionEquals(position, from)) return destroyed ? { ...cell, object: undefined } : cell
      if (positionEquals(position, to)) return { ...cell, object: destroyed ? attacker : { ...defender, hitPoints } }
      return { ...cell, object: destroyed ? undefined : { ...defender, hitPoints } }
    },
    { kind: destroyed ? 'destroyed' : 'attacked', position: to, amount: damage },
    gameConfig.turn.movementOrderCost,
  )
}

export function isRangedAttack(state: MatchState, from: CellPosition, to: CellPosition) {
  const source = objectAt(state, from)
  const target = objectAt(state, to)
  if (source?.type !== 'squad' || source.ownerId !== state.activeParticipantId || (source.units.archers ?? 0) < 1 || !target || target.ownerId === state.activeParticipantId) return false
  const columnDistance = Math.abs(to.column - from.column)
  const rowDistance = Math.abs(to.row - from.row)
  const distance = columnDistance + rowDistance
  if ((columnDistance !== 0 && rowDistance !== 0)
    || distance < gameConfig.turn.archerMinimumRange
    || distance > gameConfig.turn.archerRange) return false
  const columnStep = Math.sign(to.column - from.column)
  const rowStep = Math.sign(to.row - from.row)
  for (let step = 1; step < distance; step += 1) {
    const cell = cellAt(state, { column: from.column + columnStep * step, row: from.row + rowStep * step })
    if (!cell || cell.landform === 'peak' || cell.vegetation || cell.object) return false
  }
  return true
}

function resolveRangedAttack(
  state: MatchState,
  from: CellPosition,
  to: CellPosition,
  attacker: SquadObject,
  defender: MapObject,
  heightMultiplierOverride?: number,
  orderCost: number = gameConfig.turn.movementOrderCost,
): MatchState {
  const sourceCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  const heightMultiplier = heightMultiplierOverride
    ?? (sourceCell.landform === 'hill' ? combatRules.ranged.hillDamageMultiplier : 1)
  const coverMultiplier = targetCell.vegetation ? combatRules.ranged.forestCoverMultiplier : 1
  const dietMultiplier = state.domains[attacker.ownerId]?.diverseDiet ? gameConfig.economy.diverseDietDamageMultiplier : 1
  const archerDamage = (attacker.units.archers ?? 0) * troopRules.archers.damage * heightMultiplier * coverMultiplier * dietMultiplier
  if (defender.type === 'squad') {
    const damage = archerDamage / combatRules.ranged.squadDamageDivisor
    const nextDefender = applySquadDamage(defender, damage)
    const losses = squadSize(defender) - (nextDefender ? squadSize(nextDefender) : 0)
    return withCell(state, to, (cell) => ({ ...cell, object: nextDefender ?? undefined }), { kind: nextDefender ? 'attacked' : 'destroyed', position: to, amount: losses }, orderCost)
  }
  const damageMultiplier = defender.type === 'building'
    ? buildingRules[defender.kind].incomingDamageMultiplier ?? 1
    : 1
  const damage = Math.max(1, Math.ceil(archerDamage * combatRules.ranged.structureDamageMultiplier * damageMultiplier))
  const hitPoints = defender.hitPoints - damage
  const next = withRangedStructureDamage(state, to, defender, hitPoints, damage, orderCost)
  if (hitPoints <= 0 && defender.type === 'castle') return afterCastleDestroyed(next, defender.ownerId)
  return next
}

function resolveAttack(state: MatchState, from: CellPosition, to: CellPosition, attacker: SquadObject, defender: MapObject): MatchState {
  const fromCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  if (defender.type === 'squad') {
    const nextDefender = applySquadDamage(defender, squadDamage(state, attacker, fromCell) / combatRules.melee.defenderDamageDivisor)
    const nextAttacker = applySquadDamage(attacker, squadDamage(state, defender, targetCell) / combatRules.melee.retaliationDamageDivisor)
    const attackerSurvives = nextAttacker !== null
    const defenderSurvives = nextDefender !== null
    const defenderLosses = squadSize(defender) - (nextDefender ? squadSize(nextDefender) : 0)
    const next = withTwoCells(
      state,
      from,
      to,
      { ...fromCell, object: attackerSurvives && defenderSurvives ? nextAttacker : undefined },
      { ...targetCell, object: defenderSurvives ? nextDefender : attackerSurvives ? nextAttacker : undefined },
      { kind: defenderSurvives ? 'attacked' : 'destroyed', position: to, amount: defenderLosses },
    )
    return next
  }
  const damageMultiplier = defender.type === 'building'
    ? buildingRules[defender.kind].incomingDamageMultiplier ?? 1
    : 1
  const damage = Math.max(1, Math.ceil(squadDamage(state, attacker, fromCell) * damageMultiplier))
  const hitPoints = defender.hitPoints - damage
  const next = withMeleeStructureDamage(state, from, to, attacker, defender, hitPoints, damage)
  if (hitPoints <= 0 && defender.type === 'castle') return afterCastleDestroyed(next, defender.ownerId)
  return next
}

export function moveOrAttackFailure(state: MatchState, from: CellPosition, to: CellPosition): CommandFailure | null {
  const gameGuard = commandGuard(state, 0)
  if (gameGuard) return gameGuard
  const source = objectAt(state, from)
  if (source?.type !== 'squad' || source.ownerId !== state.activeParticipantId) return 'not-owned'
  const targetCell = cellAt(state, to)
  if (!targetCell || targetCell.landform === 'peak') return 'invalid-terrain'
  const target = targetCell.object
  if (!isAdjacent(from, to)) {
    const passageCost = squadMovementOrderCostBetween(state.scenario.cells, source, from, to)
    if (passageCost !== null) return commandGuard(state, passageCost)
    if (isRangedAttack(state, from, to)) return commandGuard(state, gameConfig.turn.movementOrderCost)
    if (target && target.ownerId !== state.activeParticipantId && (source.units.archers ?? 0) > 0) {
      const aligned = from.column === to.column || from.row === to.row
      const distance = Math.abs(from.column - to.column) + Math.abs(from.row - to.row)
      return aligned && distance <= gameConfig.turn.archerRange ? 'ranged-shot-blocked' : 'out-of-range'
    }
    return 'not-adjacent'
  }
  if (target?.ownerId === state.activeParticipantId && target.type !== 'squad') return 'occupied'
  if (target?.type === 'squad' && target.ownerId === state.activeParticipantId && squadSize(source) + squadSize(target) > gameConfig.turn.squadCapacity) return 'squad-full'
  const orderCost = !target
    ? squadMovementOrderCost(source, targetCell)
    : target.ownerId === state.activeParticipantId
      ? gameConfig.turn.squadReorganizationOrderCost
      : gameConfig.turn.movementOrderCost
  const orderGuard = commandGuard(state, orderCost)
  if (orderGuard) return orderGuard
  return null
}

export function moveOrAttack(state: MatchState, from: CellPosition, to: CellPosition): CommandResult {
  const failure = moveOrAttackFailure(state, from, to)
  if (failure) return { ok: false, state, reason: failure }
  const fromCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  const source = fromCell.object as SquadObject
  const target = targetCell.object
  const passage = friendlyBarbicanPassage(state.scenario.cells, from, to, source.ownerId)
  if (passage) {
    const orderCost = squadMovementOrderCostBetween(state.scenario.cells, source, from, to)!
    return {
      ok: true,
      state: withTwoCells(state, from, to, { ...fromCell, object: undefined }, { ...targetCell, object: source }, { kind: 'moved', position: to }, orderCost),
    }
  }
  if (!isAdjacent(from, to) && target) return { ok: true, state: resolveRangedAttack(state, from, to, source, target) }
  if (target && target.ownerId !== state.activeParticipantId) return { ok: true, state: resolveAttack(state, from, to, source, target) }
  if (target?.type === 'squad') {
    const units = { ...target.units }
    troopKinds.forEach((kind) => { units[kind] = (units[kind] ?? 0) + (source.units[kind] ?? 0) })
    const health = Math.min(maxSquadHealth({ units }), squadHealth(target) + squadHealth(source))
    return {
      ok: true,
      state: withTwoCells(state, from, to, { ...fromCell, object: undefined }, { ...targetCell, object: { ...target, units, health } }, { kind: 'merged', position: to }, gameConfig.turn.squadReorganizationOrderCost),
    }
  }
  return {
    ok: true,
    state: withTwoCells(state, from, to, { ...fromCell, object: undefined }, { ...targetCell, object: source }, { kind: 'moved', position: to }, squadMovementOrderCost(source, targetCell)),
  }
}

export function splitFailure(state: MatchState, from: CellPosition, to: CellPosition, units: TroopComposition): CommandFailure | null {
  const guard = commandGuard(state, gameConfig.turn.squadReorganizationOrderCost)
  if (guard) return guard
  const source = objectAt(state, from)
  if (source?.type !== 'squad' || source.ownerId !== state.activeParticipantId) return 'not-owned'
  if (!isAdjacent(from, to)) return 'not-adjacent'
  const targetCell = cellAt(state, to)
  if (!targetCell || targetCell.landform === 'peak') return 'invalid-terrain'
  if (targetCell.object) return 'occupied'
  if (!isValidComposition(units)) return 'invalid-squad'
  const splitSize = troopKinds.reduce((sum, kind) => sum + (units[kind] ?? 0), 0)
  if (splitSize < 1 || splitSize >= squadSize(source) || troopKinds.some((kind) => (units[kind] ?? 0) > (source.units[kind] ?? 0))) return 'invalid-squad'
  return null
}

export function dismissFailure(state: MatchState, sourcePosition: CellPosition, units: TroopComposition): CommandFailure | null {
  const guard = commandGuard(state, gameConfig.turn.squadReorganizationOrderCost)
  if (guard) return guard
  const source = objectAt(state, sourcePosition)
  if (source?.type !== 'squad' || source.ownerId !== state.activeParticipantId) return 'not-owned'
  if (!isValidComposition(units)) return 'invalid-squad'
  const amount = squadSize({ units })
  if (amount < 1 || amount > squadSize(source) || troopKinds.some((kind) => units[kind] > (source.units[kind] ?? 0))) return 'invalid-squad'
  return null
}

export function dismissSquad(state: MatchState, sourcePosition: CellPosition, units: TroopComposition): CommandResult {
  const failure = dismissFailure(state, sourcePosition, units)
  if (failure) return { ok: false, state, reason: failure }
  const sourceCell = cellAt(state, sourcePosition)
  const source = sourceCell.object as SquadObject
  const remaining = { ...source.units }
  troopKinds.forEach((kind) => { remaining[kind] -= units[kind] })
  const sourceMaxHealth = maxSquadHealth(source)
  const dismissedMaxHealth = maxSquadHealth({ units })
  const dismissedHealth = sourceMaxHealth > 0 ? squadHealth(source) * dismissedMaxHealth / sourceMaxHealth : 0
  const remainingObject = squadSize({ units: remaining }) > 0
    ? { ...source, units: remaining, health: Math.max(0, squadHealth(source) - dismissedHealth) }
    : undefined
  const next = withCell(
    state,
    sourcePosition,
    (cell) => ({ ...cell, object: remainingObject }),
    { kind: 'dismissed', position: sourcePosition, amount: squadSize({ units }) },
    gameConfig.turn.squadReorganizationOrderCost,
  )
  const domain = activeDomain(next)
  return {
    ok: true,
    state: {
      ...next,
      domains: {
        ...next.domains,
        [state.activeParticipantId]: { ...domain, population: domain.population + squadSize({ units }) },
      },
    },
  }
}

const towerRule = buildingRules.tower.garrison!

function isValidGarrison(garrison: TowerGarrison | undefined) {
  return Boolean(garrison
    && Number.isSafeInteger(garrison.archers)
    && garrison.archers > 0
    && garrison.archers <= towerRule.capacity
    && Number.isFinite(garrison.health)
    && garrison.health > 0
    && garrison.health <= garrison.archers * troopRules.archers.durability)
}

export function garrisonFailure(state: MatchState, from: CellPosition, towerPosition: CellPosition): CommandFailure | null {
  const guard = commandGuard(state, towerRule.transferOrderCost)
  if (guard) return guard
  if (!isAdjacent(from, towerPosition)) return 'not-adjacent'
  const squad = objectAt(state, from)
  if (squad?.type !== 'squad' || squad.ownerId !== state.activeParticipantId) return 'not-owned'
  if (!isValidComposition(squad.units) || (squad.units.archers ?? 0) < 1 || !Number.isFinite(squadHealth(squad)) || squadHealth(squad) <= 0) return 'invalid-squad'
  const tower = objectAt(state, towerPosition)
  if (tower?.type !== 'building' || tower.kind !== 'tower' || tower.ownerId !== state.activeParticipantId) return 'not-owned'
  if (tower.garrison && !isValidGarrison(tower.garrison)) return 'invalid-garrison'
  if ((tower.garrison?.archers ?? 0) >= towerRule.capacity) return 'squad-full'
  return null
}

export function garrisonTower(state: MatchState, from: CellPosition, towerPosition: CellPosition): CommandResult {
  const failure = garrisonFailure(state, from, towerPosition)
  if (failure) return { ok: false, state, reason: failure }
  const fromCell = cellAt(state, from)
  const towerCell = cellAt(state, towerPosition)
  const squad = fromCell.object as SquadObject
  const tower = towerCell.object as BuildingObject
  const transferred = Math.min(squad.units.archers, towerRule.capacity - (tower.garrison?.archers ?? 0))
  const transferredMaximumHealth = transferred * troopRules.archers.durability
  const sourceMaximumHealth = maxSquadHealth(squad)
  const transferredHealth = sourceMaximumHealth > 0 ? squadHealth(squad) * transferredMaximumHealth / sourceMaximumHealth : 0
  const remaining = { ...squad.units, archers: squad.units.archers - transferred }
  const remainingObject = squadSize({ units: remaining }) > 0
    ? { ...squad, units: remaining, health: Math.max(0, squadHealth(squad) - transferredHealth) }
    : undefined
  const garrison: TowerGarrison = {
    archers: (tower.garrison?.archers ?? 0) + transferred,
    health: (tower.garrison?.health ?? 0) + transferredHealth,
  }
  return {
    ok: true,
    state: withTwoCells(
      state,
      from,
      towerPosition,
      { ...fromCell, object: remainingObject },
      { ...towerCell, object: { ...tower, garrison } },
      { kind: 'garrisoned', position: towerPosition, amount: transferred },
      towerRule.transferOrderCost,
    ),
  }
}

export function ungarrisonFailure(state: MatchState, towerPosition: CellPosition, to: CellPosition): CommandFailure | null {
  const guard = commandGuard(state, towerRule.transferOrderCost)
  if (guard) return guard
  if (!isAdjacent(towerPosition, to)) return 'not-adjacent'
  const tower = objectAt(state, towerPosition)
  if (tower?.type !== 'building' || tower.kind !== 'tower' || tower.ownerId !== state.activeParticipantId) return 'not-owned'
  if (!isValidGarrison(tower.garrison)) return 'requires-garrison'
  const targetCell = cellAt(state, to)
  if (!targetCell || targetCell.landform === 'peak') return 'invalid-terrain'
  if (targetCell.object) return 'occupied'
  return null
}

export function ungarrisonTower(state: MatchState, towerPosition: CellPosition, to: CellPosition): CommandResult {
  const failure = ungarrisonFailure(state, towerPosition, to)
  if (failure) return { ok: false, state, reason: failure }
  const towerCell = cellAt(state, towerPosition)
  const targetCell = cellAt(state, to)
  const tower = towerCell.object as BuildingObject
  const garrison = tower.garrison!
  const units = { ...emptyComposition(), archers: garrison.archers }
  const squad: SquadObject = {
    type: 'squad',
    ownerId: state.activeParticipantId,
    units,
    health: garrison.health,
  }
  return {
    ok: true,
    state: withTwoCells(
      state,
      towerPosition,
      to,
      { ...towerCell, object: { ...tower, garrison: undefined } },
      { ...targetCell, object: squad },
      { kind: 'ungarrisoned', position: to, amount: garrison.archers },
      towerRule.transferOrderCost,
    ),
  }
}

export function towerAttackFailure(state: MatchState, towerPosition: CellPosition, to: CellPosition): CommandFailure | null {
  const guard = commandGuard(state, towerRule.attackOrderCost)
  if (guard) return guard
  const tower = objectAt(state, towerPosition)
  if (tower?.type !== 'building' || tower.kind !== 'tower' || tower.ownerId !== state.activeParticipantId) return 'not-owned'
  if (!isValidGarrison(tower.garrison)) return 'requires-garrison'
  const target = objectAt(state, to)
  if (!target || target.ownerId === state.activeParticipantId) return 'requires-target'
  const columnDistance = Math.abs(to.column - towerPosition.column)
  const rowDistance = Math.abs(to.row - towerPosition.row)
  const distance = columnDistance + rowDistance
  if ((columnDistance !== 0 && rowDistance !== 0) || distance < 1 || distance > towerRule.attackRange) return 'out-of-range'
  const columnStep = Math.sign(to.column - towerPosition.column)
  const rowStep = Math.sign(to.row - towerPosition.row)
  for (let step = 1; step < distance; step += 1) {
    const cell = cellAt(state, { column: towerPosition.column + columnStep * step, row: towerPosition.row + rowStep * step })
    if (!cell || cell.landform === 'peak' || cell.vegetation || cell.object) return 'ranged-shot-blocked'
  }
  return null
}

export function towerAttack(state: MatchState, towerPosition: CellPosition, to: CellPosition): CommandResult {
  const failure = towerAttackFailure(state, towerPosition, to)
  if (failure) return { ok: false, state, reason: failure }
  const tower = objectAt(state, towerPosition) as BuildingObject
  const attacker: SquadObject = {
    type: 'squad',
    ownerId: state.activeParticipantId,
    units: { ...emptyComposition(), archers: tower.garrison!.archers },
    health: tower.garrison!.health,
  }
  return { ok: true, state: resolveRangedAttack(state, towerPosition, to, attacker, objectAt(state, to)!, towerRule.heightDamageMultiplier, towerRule.attackOrderCost) }
}

export function splitSquad(state: MatchState, from: CellPosition, to: CellPosition, units: TroopComposition): CommandResult {
  const failure = splitFailure(state, from, to, units)
  if (failure) return { ok: false, state, reason: failure }
  const fromCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  const source = fromCell.object as SquadObject
  const remaining = { ...source.units }
  troopKinds.forEach((kind) => { remaining[kind] = (remaining[kind] ?? 0) - (units[kind] ?? 0) })
  const sourceMaxHealth = maxSquadHealth(source)
  const splitMaxHealth = maxSquadHealth({ units })
  const splitHealth = sourceMaxHealth > 0 ? Math.min(splitMaxHealth, squadHealth(source) * splitMaxHealth / sourceMaxHealth) : 0
  const remainingHealth = Math.max(0, squadHealth(source) - splitHealth)
  return {
    ok: true,
    state: withTwoCells(
      state,
      from,
      to,
      { ...fromCell, object: { ...source, units: remaining, health: remainingHealth } },
      { ...targetCell, object: { type: 'squad', ownerId: state.activeParticipantId, units: { ...units }, health: splitHealth } },
      { kind: 'split', position: to, amount: squadSize({ units }) },
      gameConfig.turn.squadReorganizationOrderCost,
    ),
  }
}

export function demolitionRefundFor(object: MapObject | null | undefined): ResourceAmount {
  if (object?.type !== 'building') return {}
  return Object.fromEntries(
    Object.entries(object.constructionCost ?? {})
      .map(([resource, amount]) => [resource, Math.floor((amount ?? 0) * gameConfig.turn.demolitionRefundRate)])
      .filter(([, amount]) => Number(amount) > 0),
  ) as ResourceAmount
}

export function demolish(state: MatchState, position: CellPosition): CommandResult {
  const guard = commandGuard(state, gameConfig.turn.demolishOrderCost)
  if (guard) return { ok: false, state, reason: guard }
  const object = objectAt(state, position)
  if (!object || object.ownerId !== state.activeParticipantId) return { ok: false, state, reason: 'not-owned' }
  if (object.type === 'castle' || (object.type === 'building' && object.kind === 'tower' && object.garrison)) return { ok: false, state, reason: 'cannot-demolish' }
  if (object.type === 'squad' && !isValidComposition(object.units)) return { ok: false, state, reason: 'invalid-squad' }
  const positions = object.type === 'building' ? buildingObjectPositions(object, position) : [position]
  const next = withCells(state, positions, (cell) => ({ ...cell, object: undefined }), { kind: 'demolished', position }, gameConfig.turn.demolishOrderCost)
  const domain = activeDomain(next)
  const populationReturn = object.type === 'squad' ? squadSize(object) : 0
  const refund = demolitionRefundFor(object)
  return {
    ok: true,
    state: {
      ...next,
      domains: {
        ...next.domains,
        [state.activeParticipantId]: {
          ...domain,
          population: domain.population + populationReturn,
          resources: applyResources(domain.resources, refund),
        },
      },
    },
  }
}

export function productionFor(state: MatchState, ownerId: string, workforce = workforceFor(state, ownerId)) {
  const taxRule = taxRates[state.domains[ownerId]?.taxRate ?? defaultTaxRate]
  const production = Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  const assignments = new Map(workforce.assignments.map((assignment) => [`${assignment.position.column}:${assignment.position.row}`, assignment]))
  state.scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    if (object?.ownerId !== ownerId || !isPrimaryObjectCell(object, column, rowIndex)) return
    const amount = object.type === 'castle' ? castleProduction : object.type === 'building' ? buildingRules[object.kind].production : null
    if (!amount) return
    const assignment = object.type === 'building' ? assignments.get(`${column}:${rowIndex}`) : undefined
    const workerRatio = assignment ? assignment.assigned / assignment.required : 1
    resourceIds.forEach((resource) => {
      const produced = amount[resource] ?? 0
      const staffedProduction = Math.floor(produced * workerRatio)
      production[resource] += object.type === 'building'
        ? staffedProduction > 0 ? Math.max(0, staffedProduction + taxRule.productionAdjustment) : 0
        : produced
    })
  }))
  return production
}

export function upkeepFor(state: MatchState, ownerId: string) {
  const upkeep = Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  state.scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    if (!object || object.ownerId !== ownerId || !isPrimaryObjectCell(object, column, rowIndex)) return
    if (object.type === 'building') {
      const amount = buildingRules[object.kind].upkeep
      if (amount) resourceIds.forEach((resource) => { upkeep[resource] += amount[resource] ?? 0 })
      if (object.kind === 'tower' && object.garrison) {
        resourceIds.forEach((resource) => { upkeep[resource] += (troopRules.archers.upkeep[resource] ?? 0) * object.garrison!.archers })
      }
      return
    }
    if (object.type === 'squad') {
      troopKinds.forEach((kind) => {
        resourceIds.forEach((resource) => { upkeep[resource] += (troopRules[kind].upkeep[resource] ?? 0) * (object.units[kind] ?? 0) })
      })
    }
  }))
  resourceIds.forEach((resource) => { upkeep[resource] = Math.ceil(upkeep[resource]) })
  return upkeep
}

function populationGrowthFor(state: MatchState, ownerId: string) {
  let growth = 0
  state.scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    if (object?.type === 'building' && object.ownerId === ownerId && isPrimaryObjectCell(object, column, rowIndex)) growth += buildingRules[object.kind].populationGrowth ?? 0
  }))
  return growth
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
  return { civilians: civilianDemand, soldiers: soldierDemand, taxFood, staple, total: staple + taxFood, servedCivilians, unservedCivilians }
}

export function foodDemandFor(state: MatchState, ownerId: string) {
  return foodDemandBreakdownFor(state, ownerId).total
}

export function foodConsumptionFor(
  state: MatchState,
  ownerId: string,
  available: Pick<Record<ResourceId, number>, 'flour' | 'meat' | 'fruit'> = state.domains[ownerId]?.resources ?? { flour: 0, meat: 0, fruit: 0 },
): FoodConsumption {
  const demand = foodDemandBreakdownFor(state, ownerId)
  return consumeFood(demand, available)
}

function consumeFood(
  demand: FoodDemand,
  available: Pick<Record<ResourceId, number>, 'flour' | 'meat' | 'fruit'>,
): FoodConsumption {
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
  const diverseDiet = fed
    && minimumVariety > 0
    && minimumVariety * gameConfig.economy.foodResources.length <= demand.total
    && gameConfig.economy.foodResources.every((resource) => consumedStaples[resource] >= minimumVariety)
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
  const assignments = new Map(workforce.assignments.map((assignment) => [`${assignment.position.column}:${assignment.position.row}`, assignment]))
  state.scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    if (object?.type !== 'building' || object.ownerId !== ownerId || !isPrimaryObjectCell(object, column, rowIndex)) return
    const rule = buildingRules[object.kind].processing
    if (!rule) return
    const assignment = assignments.get(`${column}:${rowIndex}`)
    const workerRatio = assignment ? assignment.assigned / assignment.required : 1
    const staffedCapacity = Math.floor(rule.maximumPerTurn * workerRatio)
    const processingCapacity = staffedCapacity > 0
      ? Math.max(0, staffedCapacity + taxRule.productionAdjustment)
      : 0
    const amount = Math.min(processingCapacity, resources[rule.input])
    if (amount <= 0) return
    resources = { ...resources, [rule.input]: resources[rule.input] - amount, [rule.output]: resources[rule.output] + amount }
    processed[rule.input] -= amount
    processed[rule.output] += amount
  }))
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
  const uncoveredUpkeep = Object.fromEntries(resourceIds.map((resource) => [resource, Math.max(0, upkeep[resource] - resources[resource])])) as Record<ResourceId, number>
  resources = Object.fromEntries(resourceIds.map((resource) => [resource, Math.max(0, resources[resource] - upkeep[resource])])) as Record<ResourceId, number>
  const desertionResult = upkeepPaid ? { cells: state.scenario.cells, loss: null } : removeCheapestTroop(state.scenario.cells, ownerId)
  const afterDesertion = { ...state, scenario: { ...state.scenario, cells: desertionResult.cells } }
  const processing = processingFor(afterDesertion, ownerId, resources, workforce)
  resources = applyResources(resources, processing)
  const demand = foodDemandBreakdownFor(afterDesertion, ownerId, workforce)
  const foodDemand = demand.total
  const food = consumeFood(demand, resources)
  resources = { ...resources, flour: resources.flour - food.flour, meat: resources.meat - food.meat, fruit: resources.fruit - food.fruit }
  return { resources, foodDemand, food, upkeepPaid, uncoveredUpkeep, desertion: desertionResult.loss, cells: desertionResult.cells, production, taxIncome, upkeep, processing, workforce }
}

export function turnEconomyForecastFor(state: MatchState, ownerId: string): TurnEconomyForecast | null {
  const resolution = resolveTurnEconomy(state, ownerId)
  return resolution ? {
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
  } : null
}

export function turnResourceDeltaFor(state: MatchState, ownerId: string) {
  const current = state.domains[ownerId]
  if (!current) return Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  const resolution = turnEconomyForecastFor(state, ownerId)
  if (!resolution) return Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  return Object.fromEntries(resourceIds.map((resource) => [resource, resolution.resources[resource] - current.resources[resource]])) as Record<ResourceId, number>
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
    return batchSize * fullBatches * (fullBatches - 1) / 2 + fullBatches * remainder
  }
  const pricedQuantity = direction === 'sell'
    ? Math.min(quotedQuantity, Math.max(0, basePrice * batchSize - traded))
    : quotedQuantity
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

export function trade(state: MatchState, marketPosition: CellPosition, resource: TradeResource, direction: 'buy' | 'sell', quantity: number): CommandResult {
  if (state.status !== 'playing') return { ok: false, state, reason: 'game-over' }
  const market = objectAt(state, marketPosition)
  if (market?.type !== 'building' || market.kind !== 'market' || market.ownerId !== state.activeParticipantId) return { ok: false, state, reason: 'requires-market' }
  if (!tradeableResources.includes(resource) || !Number.isSafeInteger(quantity) || quantity < 1) return { ok: false, state, reason: 'invalid-trade' }
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
      domains: { ...state.domains, [state.activeParticipantId]: { ...domain, resources, marketActivity: { ...marketActivity, [activityKey]: nextActivity } } },
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
            object: squadSize({ units }) > 0
              ? { ...object, units, health: Math.min(squadHealth(object), maxSquadHealth({ units })) }
              : undefined,
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
              garrison: archers > 0
                ? { archers, health: Math.min(object.garrison!.health, archers * troopRules.archers.durability) }
                : undefined,
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
      population = Math.min(civilianCapacity, current.population + gameConfig.economy.basePopulationGrowth + dietGrowth + (upkeepPaid ? populationGrowthFor(afterEconomyState, ownerId) : 0))
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
  const currentIndex = Math.max(0, participants.findIndex((participant) => participant.id === ownerId))
  let nextParticipant = participants[currentIndex]
  for (let offset = 1; offset <= participants.length; offset += 1) {
    const candidate = participants[(currentIndex + offset) % participants.length]
    if (hasLivingCastle({ scenario: { ...state.scenario, cells } }, candidate.id)) {
      nextParticipant = candidate
      break
    }
  }
  const wrappedToPlayer = nextParticipant.id === state.playerId && ownerId !== state.playerId
  return {
    ok: true,
    state: {
      ...state,
      turn: state.turn + (wrappedToPlayer ? 1 : 0),
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

export function defaultSplit(squad: SquadObject) {
  const result = emptyComposition()
  let desired = Math.floor(squadSize(squad) / 2)
  for (const kind of troopKinds) {
    const amount = Math.min(desired, squad.units[kind] ?? 0)
    result[kind] = amount
    desired -= amount
  }
  return result
}

export function positionsAround(position: CellPosition) {
  return cardinalDirections.map((direction) => ({
    column: position.column + direction.column,
    row: position.row + direction.row,
  }))
}

export function isSamePosition(a: CellPosition | null, b: CellPosition | null) {
  return Boolean(a && b && positionEquals(a, b))
}
