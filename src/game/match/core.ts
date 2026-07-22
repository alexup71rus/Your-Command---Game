import {
  buildingRules,
  defaultTaxRate,
  resourceIds,
  startingResources,
  tradeableResources,
  troopKinds,
  troopRules,
  workerBuildingKinds,
  type ResourceAmount,
  type TradeResource,
} from '../../config/rules'
import { gameConfig } from '../../config/game'
import { createAiMemory } from '../ai/model'
import { cardinalDirections } from '../geometry'
import type { BuildingKind, BuildingObject, GameMap, MapObject, ResourceId, SquadObject, TroopComposition } from '../map'
import { participantTeamId, type CellPosition, type MapScenario, type MatchParticipant } from '../scenario'
import type { MarketActivity, MatchState, WorkerAssignment, WorkforceSummary } from './types'

export const emptyComposition = (): TroopComposition => ({ militia: 0, spearmen: 0, archers: 0, knights: 0 })
const emptyTradeRecord = (): Record<TradeResource, number> =>
  Object.fromEntries(tradeableResources.map((resource) => [resource, 0])) as Record<TradeResource, number>
export const emptyMarketActivity = (): MarketActivity => ({ bought: emptyTradeRecord(), sold: emptyTradeRecord() })
export const positionEquals = (a: CellPosition, b: CellPosition) => a.column === b.column && a.row === b.row
export const isAdjacent = (a: CellPosition, b: CellPosition) => Math.abs(a.column - b.column) + Math.abs(a.row - b.row) === 1
export const cellAt = (state: MatchState, position: CellPosition) => state.scenario.cells[position.row]?.[position.column]

export function isValidComposition(units: TroopComposition) {
  return troopKinds.every((kind) => Number.isSafeInteger(units[kind] ?? 0) && (units[kind] ?? 0) >= 0)
}

export function buildingFootprintPositions(kind: BuildingKind, origin: CellPosition) {
  const footprint = buildingRules[kind].footprint ?? { columns: 1, rows: 1 }
  return Array.from({ length: footprint.rows }, (_, rowOffset) =>
    Array.from({ length: footprint.columns }, (_, columnOffset) => ({ column: origin.column + columnOffset, row: origin.row + rowOffset })),
  ).flat()
}

export function buildingObjectPositions(building: BuildingObject, fallback: CellPosition) {
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

interface IndexedMapObject {
  object: MapObject
  position: CellPosition
}

interface MatchObjectIndex {
  all: IndexedMapObject[]
  allByOwner: Map<string, IndexedMapObject[]>
  primary: IndexedMapObject[]
  primaryByOwner: Map<string, IndexedMapObject[]>
}

let activeMatchObjectIndexes: WeakMap<GameMap, MatchObjectIndex> | null = null

function createMatchObjectIndex(cells: GameMap): MatchObjectIndex {
  const all: IndexedMapObject[] = []
  const allByOwner = new Map<string, IndexedMapObject[]>()
  const primary: IndexedMapObject[] = []
  const primaryByOwner = new Map<string, IndexedMapObject[]>()
  cells.forEach((row, rowIndex) =>
    row.forEach((cell, column) => {
      if (!cell.object) return
      const entry = { object: cell.object, position: { column, row: rowIndex } }
      all.push(entry)
      const ownerObjects = allByOwner.get(cell.object.ownerId) ?? []
      ownerObjects.push(entry)
      allByOwner.set(cell.object.ownerId, ownerObjects)
      if (!isPrimaryObjectCell(cell.object, column, rowIndex)) return
      primary.push(entry)
      const ownerPrimaryObjects = primaryByOwner.get(cell.object.ownerId) ?? []
      ownerPrimaryObjects.push(entry)
      primaryByOwner.set(cell.object.ownerId, ownerPrimaryObjects)
    }),
  )
  return { all, allByOwner, primary, primaryByOwner }
}

export function indexedMapObjects(state: Pick<MatchState, 'scenario'>, ownerId?: string, primaryOnly = true): readonly IndexedMapObject[] {
  if (!activeMatchObjectIndexes) {
    const index = createMatchObjectIndex(state.scenario.cells)
    return ownerId ? ((primaryOnly ? index.primaryByOwner : index.allByOwner).get(ownerId) ?? []) : primaryOnly ? index.primary : index.all
  }
  let index = activeMatchObjectIndexes.get(state.scenario.cells)
  if (!index) {
    index = createMatchObjectIndex(state.scenario.cells)
    activeMatchObjectIndexes.set(state.scenario.cells, index)
  }
  return ownerId ? ((primaryOnly ? index.primaryByOwner : index.allByOwner).get(ownerId) ?? []) : primaryOnly ? index.primary : index.all
}

/** Reuses immutable map-object indexes only within one synchronous command/planning request. */
export function withMatchObjectIndexCache<T>(run: () => T): T {
  const previousIndexes = activeMatchObjectIndexes
  activeMatchObjectIndexes = new WeakMap()
  try {
    return run()
  } finally {
    activeMatchObjectIndexes = previousIndexes
  }
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
  return indexedMapObjects(state, ownerId, false).reduce((totals, { object }) => {
    if (object.type === 'squad')
      troopKinds.forEach((kind) => {
        totals[kind] += object.units[kind] ?? 0
      })
    if (object.type === 'building' && object.kind === 'tower' && object.garrison) totals.archers += object.garrison.archers
    return totals
  }, emptyComposition())
}

interface OwnedBuildingEntry {
  kind: BuildingKind
  position: CellPosition
}

export function ownedBuildingEntries(state: MatchState, ownerId: string, kind?: BuildingKind): OwnedBuildingEntry[] {
  return indexedMapObjects(state, ownerId).flatMap(({ object, position }) =>
    object.type === 'building' && (!kind || object.kind === kind) ? [{ kind: object.kind, position }] : [],
  )
}

export function ownedBuildingCount(state: MatchState, ownerId: string, kind: BuildingKind) {
  return ownedBuildingEntries(state, ownerId, kind).length
}

export function buildingResourceCostFor(state: MatchState, ownerId: string, kind: BuildingKind): ResourceAmount {
  const rule = buildingRules[kind]
  const resources = state.domains[ownerId]?.resources
  const emergencyFree =
    rule.emergencyFreeIfMissing &&
    ownedBuildingCount(state, ownerId, kind) === 0 &&
    resources &&
    !hasResources(resources, rule.resourceCost)
  return emergencyFree ? {} : rule.resourceCost
}

export function isEmergencyBuildingFree(state: MatchState, ownerId: string, kind: BuildingKind) {
  return (
    Boolean(buildingRules[kind].emergencyFreeIfMissing) &&
    ownedBuildingCount(state, ownerId, kind) === 0 &&
    Object.keys(buildingResourceCostFor(state, ownerId, kind)).length === 0
  )
}

export function buildingDistance(first: OwnedBuildingEntry, second: OwnedBuildingEntry) {
  const firstCells = buildingFootprintPositions(first.kind, first.position)
  const secondCells = buildingFootprintPositions(second.kind, second.position)
  return Math.min(...firstCells.flatMap((a) => secondCells.map((b) => Math.abs(a.column - b.column) + Math.abs(a.row - b.row))))
}

export function positionKey(position: CellPosition) {
  return `${position.column}:${position.row}`
}

/**
 * Worker assignment severity for on-map indicators.
 * - 'stopped' — production is halted (no workers, or blocked by missing/idle support).
 * - 'reduced' — understaffed but still producing (assigned < required, no block).
 * - null — fully staffed.
 */
export function workerSeverity(assignment: WorkerAssignment): 'stopped' | 'reduced' | null {
  if (assignment.assigned === 0 || assignment.blockedReason !== undefined) return 'stopped'
  if (assignment.assigned < assignment.required) return 'reduced'
  return null
}

function farmSupportAssignments(state: MatchState, ownerId: string) {
  const mills = ownedBuildingEntries(state, ownerId, 'mill').sort(
    (a, b) => a.position.row - b.position.row || a.position.column - b.position.column,
  )
  const farms = ownedBuildingEntries(state, ownerId, 'farm')
  farms.sort((a, b) => a.position.row - b.position.row || a.position.column - b.position.column)
  const millRule = buildingRules.mill.farmSupport!
  const slots = mills.flatMap((mill) => Array.from({ length: millRule.capacity }, (_, index) => ({ mill, index })))
  const slotOwner = new Map<number, string>()
  const farmByKey = new Map(farms.map((farm) => [positionKey(farm.position), farm]))

  const candidatesFor = (farm: OwnedBuildingEntry) =>
    slots
      .map((slot, slotIndex) => ({ slot, slotIndex, distance: buildingDistance(farm, slot.mill) }))
      .filter(({ distance }) => distance <= millRule.radius)
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          a.slot.mill.position.row - b.slot.mill.position.row ||
          a.slot.mill.position.column - b.slot.mill.position.column ||
          a.slot.index - b.slot.index,
      )

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
  return (
    ownedBuildingEntries(state, ownerId, 'mill')
      .map((mill) => ({ mill, distance: buildingDistance(candidate, mill) }))
      .filter(
        ({ mill, distance }) => distance <= millRule.radius && (assignedCounts.get(positionKey(mill.position)) ?? 0) < millRule.capacity,
      )
      .sort(
        (first, second) =>
          first.distance - second.distance ||
          first.mill.position.row - second.mill.position.row ||
          first.mill.position.column - second.mill.position.column,
      )[0]?.mill.position ?? null
  )
}

export function workforceFor(state: MatchState, ownerId: string): WorkforceSummary {
  const population = Math.max(0, state.domains[ownerId]?.population ?? 0)
  const supports = farmSupportAssignments(state, ownerId)
  const usedMills = new Set([...supports.values()].map(positionKey))
  const assignments: WorkerAssignment[] = indexedMapObjects(state, ownerId)
    .flatMap(({ object, position }) => {
      if (object.type !== 'building') return []
      const required = buildingRules[object.kind].workersRequired ?? 0
      if (required <= 0) return []
      const blockedReason =
        object.kind === 'farm' && !supports.has(positionKey(position))
          ? ('missing-support' as const)
          : object.kind === 'mill' && !usedMills.has(positionKey(position))
            ? ('idle-support' as const)
            : undefined
      return [{ kind: object.kind, position, required, assigned: 0, blockedReason }]
    })
    .sort((first, second) => {
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
  const origin = object.footprint ? { column: object.footprint.originColumn, row: object.footprint.originRow } : position
  return workforceFor(state, object.ownerId).assignments.find((assignment) => positionEquals(assignment.position, origin)) ?? null
}

export function civilianHousingCapacityFor(state: MatchState, ownerId: string) {
  const domain = state.domains[ownerId]
  if (!domain) return 0
  const houses = indexedMapObjects(state, ownerId, false).reduce(
    (capacity, { object }) =>
      object.type === 'building' && object.kind === 'house' ? capacity + (buildingRules.house.housingCapacity ?? 0) : capacity,
    0,
  )
  return Math.max(0, gameConfig.turn.basePopulationCapacity + houses - totalArmySize(state, ownerId))
}

export function foodServiceCapacityFor(state: MatchState, ownerId: string, workforce = workforceFor(state, ownerId)) {
  const assignments = new Map(
    workforce.assignments.map((assignment) => [`${assignment.position.column}:${assignment.position.row}`, assignment]),
  )
  const ownerObjects = indexedMapObjects(state, ownerId)
  let capacity = ownerObjects.some(({ object }) => object.type === 'castle') ? gameConfig.economy.castleFoodServiceCapacity : 0
  ownerObjects.forEach(({ object, position }) => {
    if (object.type !== 'building') return
    const service = buildingRules[object.kind].foodServiceCapacity ?? 0
    if (!service) return
    const assignment = assignments.get(positionKey(position))
    const workerRatio = assignment ? assignment.assigned / assignment.required : 1
    capacity += Math.floor(service * workerRatio)
  })
  return capacity
}

export function civilianPopulationCapacityFor(state: MatchState, ownerId: string) {
  return Math.min(civilianHousingCapacityFor(state, ownerId), foodServiceCapacityFor(state, ownerId))
}

export function createMatch(scenario: MapScenario): MatchState {
  const player = scenario.participants.find((participant) => participant.kind === 'human') ?? scenario.participants[0]
  if (!player) throw new Error('A founded scenario must contain at least one participant')
  const domains = Object.fromEntries(
    scenario.participants.map((participant) => [
      participant.id,
      {
        resources: { ...startingResources },
        population: gameConfig.turn.startingPopulation,
        taxRate: defaultTaxRate,
        diverseDiet: false,
        marketActivity: emptyMarketActivity(),
      },
    ]),
  )
  return {
    scenario,
    playerId: player.id,
    activeParticipantId: player.id,
    turn: 1,
    ordersRemaining: gameConfig.turn.maxOrders,
    domains,
    status: scenario.participants.length > 1 && new Set(scenario.participants.map(participantTeamId)).size === 1 ? 'won' : 'playing',
    lastEvent: null,
    lastTurnReports: {},
    aiMemory: Object.fromEntries(
      scenario.participants.filter((participant) => participant.kind === 'ai').map((participant) => [participant.id, createAiMemory()]),
    ),
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

export function hasResources(resources: Record<ResourceId, number>, cost: ResourceAmount, quantity = 1) {
  return resourceIds.every((resource) => resources[resource] >= (cost[resource] ?? 0) * quantity)
}

export function applyResources(resources: Record<ResourceId, number>, amount: ResourceAmount, multiplier = 1) {
  const next = { ...resources }
  resourceIds.forEach((resource) => {
    next[resource] += (amount[resource] ?? 0) * multiplier
  })
  return next
}

export function spendResources(resources: Record<ResourceId, number>, cost: ResourceAmount, quantity = 1) {
  return applyResources(resources, cost, -quantity)
}

export function hasLivingCastle(state: Pick<MatchState, 'scenario'>, ownerId: string) {
  return indexedMapObjects(state, ownerId, false).some(({ object }) => object.type === 'castle')
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
