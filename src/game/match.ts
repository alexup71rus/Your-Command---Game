import { buildingRules, castleProduction, defaultTaxRate, marketPrices, resourceIds, starvationTroopOrder, startingResources, taxRates, tradeableResources, troopKinds, troopRules, workerBuildingKinds, type ResourceAmount, type TaxRate } from '../config/rules'
import { gameConfig } from '../config/game'
import type {
  BuildingKind,
  BuildingObject,
  GameMap,
  MapCell,
  MapObject,
  ResourceId,
  SquadObject,
  TroopComposition,
  TroopKind,
} from './map'
import type { CellPosition, MapScenario, MatchParticipant } from './scenario'
import { squadMovementOrderCost } from './movement'

export interface DomainEconomy {
  resources: Record<ResourceId, number>
  population: number
  populationCapacity: number
  taxRate?: TaxRate
  diverseDiet: boolean
}

export interface WorkerAssignment {
  kind: BuildingKind
  position: CellPosition
  required: number
  assigned: number
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
  taxGrain: number
  staple: number
  total: number
  servedCivilians: number
  unservedCivilians: number
}

export interface FoodConsumption {
  grain: number
  meat: number
  fed: boolean
  diverseDiet: boolean
}

export type MatchStatus = 'playing' | 'won' | 'lost'

export interface MatchEvent {
  kind: 'built' | 'recruited' | 'moved' | 'merged' | 'split' | 'attacked' | 'destroyed' | 'demolished' | 'traded' | 'tax-changed' | 'turn-ended'
  position?: CellPosition
  amount?: number
}

export interface MatchState {
  scenario: MapScenario
  playerId: string
  turn: number
  ordersRemaining: number
  domains: Record<string, DomainEconomy>
  status: MatchStatus
  lastEvent: MatchEvent | null
}

export type CommandFailure =
  | 'game-over'
  | 'not-owned'
  | 'occupied'
  | 'invalid-terrain'
  | 'outside-domain'
  | 'outside-food-service'
  | 'not-adjacent'
  | 'not-enough-orders'
  | 'not-enough-resources'
  | 'not-enough-population'
  | 'requires-barracks'
  | 'squad-full'
  | 'invalid-squad'
  | 'cannot-demolish'
  | 'requires-market'
  | 'invalid-trade'
  | 'ranged-shot-blocked'
  | 'out-of-range'

export type CommandResult =
  | { ok: true; state: MatchState }
  | { ok: false; state: MatchState; reason: CommandFailure }

const emptyComposition = (): TroopComposition => ({ militia: 0, spearmen: 0, archers: 0, knights: 0 })
const positionEquals = (a: CellPosition, b: CellPosition) => a.column === b.column && a.row === b.row
const isAdjacent = (a: CellPosition, b: CellPosition) => Math.abs(a.column - b.column) + Math.abs(a.row - b.row) === 1
const cellAt = (state: MatchState, position: CellPosition) => state.scenario.cells[position.row]?.[position.column]

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

export function maxSquadHealth(squad: Pick<SquadObject, 'units'>) {
  return troopKinds.reduce((total, kind) => total + (squad.units[kind] ?? 0) * troopRules[kind].durability, 0)
}

export function squadHealth(squad: Pick<SquadObject, 'units' | 'health'>) {
  return Math.min(squad.health ?? maxSquadHealth(squad), maxSquadHealth(squad))
}

export function troopTotals(state: MatchState, ownerId: string): TroopComposition {
  return state.scenario.cells.flat().reduce((totals, cell) => {
    const squad = cell.object
    if (squad?.type !== 'squad' || squad.ownerId !== ownerId) return totals
    troopKinds.forEach((kind) => { totals[kind] += squad.units[kind] ?? 0 })
    return totals
  }, emptyComposition())
}

export function workforceFor(state: MatchState, ownerId: string): WorkforceSummary {
  const population = Math.max(0, state.domains[ownerId]?.population ?? 0)
  const assignments = state.scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
    const object = cell.object
    if (object?.type !== 'building' || object.ownerId !== ownerId || !isPrimaryObjectCell(object, column, rowIndex)) return []
    const required = buildingRules[object.kind].workersRequired ?? 0
    return required > 0 ? [{ kind: object.kind, position: { column, row: rowIndex }, required, assigned: 0 }] : []
  })).sort((first, second) => {
    const kindOrder = workerBuildingKinds.indexOf(first.kind) - workerBuildingKinds.indexOf(second.kind)
    return kindOrder || first.position.row - second.position.row || first.position.column - second.position.column
  })
  let available = population
  assignments.forEach((assignment) => {
    assignment.assigned = Math.min(assignment.required, available)
    available -= assignment.assigned
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
  const soldiers = squadSize({ units: troopTotals(state, ownerId) })
  const dietBonus = domain.diverseDiet ? gameConfig.economy.diverseDietPopulationCapacityBonus : 0
  return Math.max(gameConfig.economy.minimumPopulation, domain.populationCapacity - soldiers + dietBonus)
}

export function foodServiceCapacityFor(state: MatchState, ownerId: string) {
  const assignments = new Map(workforceFor(state, ownerId).assignments.map((assignment) => [`${assignment.position.column}:${assignment.position.row}`, assignment]))
  let capacity = gameConfig.economy.castleFoodServiceCapacity
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
      populationCapacity: gameConfig.turn.basePopulationCapacity,
      taxRate: defaultTaxRate,
      diverseDiet: false,
    },
  ]))
  return {
    scenario,
    playerId: player.id,
    turn: 1,
    ordersRemaining: gameConfig.turn.maxOrders,
    domains,
    status: 'playing',
    lastEvent: null,
  }
}

export function participantForOwner(state: MatchState, ownerId: string): MatchParticipant | undefined {
  return state.scenario.participants.find((participant) => participant.id === ownerId)
}

export function humanDomain(state: MatchState) {
  return state.domains[state.playerId]
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

function playerRegionId(state: MatchState) {
  return participantForOwner(state, state.playerId)?.regionId
}

export function buildingPlacementFailure(state: MatchState, kind: BuildingKind, position: CellPosition): CommandFailure | null {
  const rule = buildingRules[kind]
  const guard = commandGuard(state, rule.actionCost)
  if (guard) return guard
  const positions = buildingFootprintPositions(kind, position)
  const cells = positions.map((candidate) => cellAt(state, candidate))
  if (cells.some((cell) => !cell || cell.landform === 'peak')) return 'invalid-terrain'
  if (cells.some((cell) => cell?.object)) return 'occupied'
  const regionId = playerRegionId(state)
  if (positions.some((candidate) => state.scenario.territories[candidate.row]?.[candidate.column] !== regionId)) return 'outside-domain'
  if (rule.requiresFoodServiceAccess) {
    const inRange = state.scenario.cells.some((row, rowIndex) => row.some((cell, column) => {
      const object = cell.object
      if (!object || object.ownerId !== state.playerId || !isPrimaryObjectCell(object, column, rowIndex)) return false
      const isServiceSource = object.type === 'castle' || (object.type === 'building' && (buildingRules[object.kind].foodServiceCapacity ?? 0) > 0)
      return isServiceSource && positions.some((candidate) => Math.abs(candidate.column - column) + Math.abs(candidate.row - rowIndex) <= gameConfig.economy.foodServiceRadius)
    }))
    if (!inRange) return 'outside-food-service'
  }
  const placement = rule.placement
  if (rule.minimumAdjacentForestCells) {
    const adjacentForestCells = new Set(positions.flatMap((candidate) => [
      { column: candidate.column + 1, row: candidate.row },
      { column: candidate.column - 1, row: candidate.row },
      { column: candidate.column, row: candidate.row + 1 },
      { column: candidate.column, row: candidate.row - 1 },
    ]).filter((neighbor) => cellAt(state, neighbor)?.vegetation).map((neighbor) => `${neighbor.column}:${neighbor.row}`))
    if (adjacentForestCells.size < rule.minimumAdjacentForestCells) return 'invalid-terrain'
  }
  if (placement === 'hill' && cells.some((cell) => cell?.landform !== 'hill' || cell.vegetation)) return 'invalid-terrain'
  if (placement === 'plain' && cells.some((cell) => cell?.landform !== 'plain' || cell.vegetation)) return 'invalid-terrain'
  if (placement === 'open' && cells.some((cell) => cell?.vegetation)) return 'invalid-terrain'
  const domain = humanDomain(state)
  if (!hasResources(domain.resources, rule.resourceCost)) return 'not-enough-resources'
  return null
}

export function build(state: MatchState, kind: BuildingKind, position: CellPosition): CommandResult {
  const failure = buildingPlacementFailure(state, kind, position)
  if (failure) return { ok: false, state, reason: failure }
  const rule = buildingRules[kind]
  const footprint = rule.footprint
  const object: BuildingObject = {
    type: 'building',
    kind,
    ownerId: state.playerId,
    hitPoints: rule.hitPoints,
    maxHitPoints: rule.hitPoints,
    footprint: footprint ? { originColumn: position.column, originRow: position.row, ...footprint } : undefined,
  }
  const next = withCells(state, buildingFootprintPositions(kind, position), (cell) => ({ ...cell, object }), { kind: 'built', position }, rule.actionCost)
  const domain = humanDomain(next)
  return {
    ok: true,
    state: {
      ...next,
      domains: {
        ...next.domains,
        [state.playerId]: {
          ...domain,
          resources: spendResources(domain.resources, rule.resourceCost),
          populationCapacity: domain.populationCapacity + rule.populationCapacity,
        },
      },
    },
  }
}

function recruitmentSourcePositions(state: MatchState) {
  const positions: CellPosition[] = []
  state.scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    if (object?.ownerId !== state.playerId) return
    if (object.type === 'castle' || (object.type === 'building' && object.kind === 'barracks')) positions.push({ column, row: rowIndex })
  }))
  return positions
}

export function recruitmentFailure(state: MatchState, troop: TroopKind, quantity: number, position: CellPosition): CommandFailure | null {
  const rule = troopRules[troop]
  const guard = commandGuard(state, rule.actionCost)
  if (guard) return guard
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > gameConfig.turn.squadCapacity) return 'invalid-squad'
  const cell = cellAt(state, position)
  if (!cell || cell.landform === 'peak') return 'invalid-terrain'
  if (cell.object && (cell.object.type !== 'squad' || cell.object.ownerId !== state.playerId)) return 'occupied'
  const existingSize = cell.object?.type === 'squad' ? squadSize(cell.object) : 0
  if (existingSize + quantity > gameConfig.turn.squadCapacity) return 'squad-full'
  if (!recruitmentSourcePositions(state).some((source) => isAdjacent(source, position))) return 'requires-barracks'
  const domain = humanDomain(state)
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
  const squad: SquadObject = { type: 'squad', ownerId: state.playerId, units, health }
  const next = withCell(state, position, (cell) => ({ ...cell, object: squad }), { kind: 'recruited', position, amount: quantity }, rule.actionCost)
  const domain = humanDomain(next)
  return {
    ok: true,
    state: {
      ...next,
      domains: {
        ...next.domains,
        [state.playerId]: {
          ...domain,
          population: domain.population - rule.populationCost * quantity,
          resources: spendResources(domain.resources, rule.resourceCost, quantity),
        },
      },
    },
  }
}

function squadDamage(state: MatchState, squad: SquadObject, cell: MapCell) {
  const terrainMultiplier = cell.landform === 'hill' ? 1.12 : cell.vegetation ? 1.08 : 1
  const dietMultiplier = state.domains[squad.ownerId]?.diverseDiet ? gameConfig.economy.diverseDietDamageMultiplier : 1
  return troopKinds.reduce((sum, kind) => sum + (squad.units[kind] ?? 0) * troopRules[kind].damage, 0) * terrainMultiplier * dietMultiplier
}

function applySquadDamage(squad: SquadObject, damage: number): SquadObject | null {
  const nextHealth = Math.max(0, squadHealth(squad) - damage)
  if (nextHealth <= 0) return null

  const units = { ...squad.units }
  let remainingCapacity = maxSquadHealth({ units })
  const casualtyOrder: TroopKind[] = ['militia', 'archers', 'spearmen', 'knights']
  casualtyOrder.forEach((kind) => {
    const durability = troopRules[kind].durability
    while ((units[kind] ?? 0) > 0 && remainingCapacity - durability >= nextHealth - 0.0001) {
      units[kind] = (units[kind] ?? 0) - 1
      remainingCapacity -= durability
    }
  })

  return { ...squad, units, health: Math.min(nextHealth, remainingCapacity) }
}

function remainingEnemyCastles(cells: GameMap, playerId: string) {
  return cells.flat().filter((cell) => cell.object?.type === 'castle' && cell.object.ownerId !== playerId).length
}

function withRangedStructureDamage(state: MatchState, position: CellPosition, defender: BuildingObject | Extract<MapObject, { type: 'castle' }>, hitPoints: number, damage: number) {
  const destroyed = hitPoints <= 0
  const positions = defender.type === 'building' ? buildingObjectPositions(defender, position) : [position]
  return withCells(
    state,
    positions,
    (cell) => ({ ...cell, object: destroyed ? undefined : { ...defender, hitPoints } }),
    { kind: destroyed ? 'destroyed' : 'attacked', position, amount: damage },
    gameConfig.turn.movementOrderCost,
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
  if (source?.type !== 'squad' || source.ownerId !== state.playerId || (source.units.archers ?? 0) < 1 || !target || target.ownerId === state.playerId) return false
  const columnDistance = Math.abs(to.column - from.column)
  const rowDistance = Math.abs(to.row - from.row)
  const distance = columnDistance + rowDistance
  if ((columnDistance !== 0 && rowDistance !== 0) || distance < 2 || distance > gameConfig.turn.archerRange) return false
  const columnStep = Math.sign(to.column - from.column)
  const rowStep = Math.sign(to.row - from.row)
  for (let step = 1; step < distance; step += 1) {
    const cell = cellAt(state, { column: from.column + columnStep * step, row: from.row + rowStep * step })
    if (!cell || cell.landform === 'peak' || cell.vegetation || cell.object) return false
  }
  return true
}

function resolveRangedAttack(state: MatchState, from: CellPosition, to: CellPosition, attacker: SquadObject, defender: MapObject): MatchState {
  const sourceCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  const heightMultiplier = sourceCell.landform === 'hill' ? 1.2 : 1
  const coverMultiplier = targetCell.vegetation ? 0.75 : 1
  const dietMultiplier = state.domains[attacker.ownerId]?.diverseDiet ? gameConfig.economy.diverseDietDamageMultiplier : 1
  const archerDamage = (attacker.units.archers ?? 0) * troopRules.archers.damage * heightMultiplier * coverMultiplier * dietMultiplier
  if (defender.type === 'squad') {
    const damage = archerDamage / 2.5
    const nextDefender = applySquadDamage(defender, damage)
    const losses = squadSize(defender) - (nextDefender ? squadSize(nextDefender) : 0)
    return withCell(state, to, (cell) => ({ ...cell, object: nextDefender ?? undefined }), { kind: nextDefender ? 'attacked' : 'destroyed', position: to, amount: losses }, gameConfig.turn.movementOrderCost)
  }
  const damageMultiplier = defender.type === 'building'
    ? defender.kind === 'wall' ? 0.35 : defender.kind === 'barbican' ? 0.5 : 1
    : 1
  const damage = Math.max(1, Math.ceil(archerDamage * 0.5 * damageMultiplier))
  const hitPoints = defender.hitPoints - damage
  const next = withRangedStructureDamage(state, to, defender, hitPoints, damage)
  if (hitPoints <= 0 && defender.type === 'castle' && remainingEnemyCastles(next.scenario.cells, state.playerId) === 0) return { ...next, status: 'won' }
  return next
}

function resolveAttack(state: MatchState, from: CellPosition, to: CellPosition, attacker: SquadObject, defender: MapObject): MatchState {
  const fromCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  if (defender.type === 'squad') {
    const nextDefender = applySquadDamage(defender, squadDamage(state, attacker, fromCell) / 2.2)
    const nextAttacker = applySquadDamage(attacker, squadDamage(state, defender, targetCell) / 3)
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
    ? defender.kind === 'wall' ? 0.35 : defender.kind === 'barbican' ? 0.5 : 1
    : 1
  const damage = Math.max(1, Math.ceil(squadDamage(state, attacker, fromCell) * damageMultiplier))
  const hitPoints = defender.hitPoints - damage
  const next = withMeleeStructureDamage(state, from, to, attacker, defender, hitPoints, damage)
  if (hitPoints <= 0 && defender.type === 'castle' && remainingEnemyCastles(next.scenario.cells, state.playerId) === 0) return { ...next, status: 'won' }
  return next
}

export function moveOrAttackFailure(state: MatchState, from: CellPosition, to: CellPosition): CommandFailure | null {
  const gameGuard = commandGuard(state, 0)
  if (gameGuard) return gameGuard
  const source = objectAt(state, from)
  if (source?.type !== 'squad' || source.ownerId !== state.playerId) return 'not-owned'
  const targetCell = cellAt(state, to)
  if (!targetCell || targetCell.landform === 'peak') return 'invalid-terrain'
  const target = targetCell.object
  if (!isAdjacent(from, to)) {
    if (isRangedAttack(state, from, to)) return commandGuard(state, gameConfig.turn.movementOrderCost)
    if (target && target.ownerId !== state.playerId && (source.units.archers ?? 0) > 0) {
      const aligned = from.column === to.column || from.row === to.row
      const distance = Math.abs(from.column - to.column) + Math.abs(from.row - to.row)
      return aligned && distance <= gameConfig.turn.archerRange ? 'ranged-shot-blocked' : 'out-of-range'
    }
    return 'not-adjacent'
  }
  if (target?.ownerId === state.playerId && target.type !== 'squad') return 'occupied'
  if (target?.type === 'squad' && target.ownerId === state.playerId && squadSize(source) + squadSize(target) > gameConfig.turn.squadCapacity) return 'squad-full'
  const orderCost = !target
    ? squadMovementOrderCost(source, targetCell)
    : target.ownerId === state.playerId
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
  if (!isAdjacent(from, to) && target) return { ok: true, state: resolveRangedAttack(state, from, to, source, target) }
  if (target && target.ownerId !== state.playerId) return { ok: true, state: resolveAttack(state, from, to, source, target) }
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
  if (source?.type !== 'squad' || source.ownerId !== state.playerId) return 'not-owned'
  if (!isAdjacent(from, to)) return 'not-adjacent'
  const targetCell = cellAt(state, to)
  if (!targetCell || targetCell.landform === 'peak') return 'invalid-terrain'
  if (targetCell.object) return 'occupied'
  const splitSize = troopKinds.reduce((sum, kind) => sum + (units[kind] ?? 0), 0)
  if (splitSize < 1 || splitSize >= squadSize(source) || troopKinds.some((kind) => (units[kind] ?? 0) < 0 || (units[kind] ?? 0) > (source.units[kind] ?? 0))) return 'invalid-squad'
  return null
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
      { ...targetCell, object: { type: 'squad', ownerId: state.playerId, units: { ...units }, health: splitHealth } },
      { kind: 'split', position: to, amount: squadSize({ units }) },
      gameConfig.turn.squadReorganizationOrderCost,
    ),
  }
}

export function demolish(state: MatchState, position: CellPosition): CommandResult {
  const guard = commandGuard(state, gameConfig.turn.demolishOrderCost)
  if (guard) return { ok: false, state, reason: guard }
  const object = objectAt(state, position)
  if (!object || object.ownerId !== state.playerId) return { ok: false, state, reason: 'not-owned' }
  if (object.type === 'castle') return { ok: false, state, reason: 'cannot-demolish' }
  const positions = object.type === 'building' ? buildingObjectPositions(object, position) : [position]
  const next = withCells(state, positions, (cell) => ({ ...cell, object: undefined }), { kind: 'demolished', position }, gameConfig.turn.demolishOrderCost)
  const domain = humanDomain(next)
  const populationReturn = object.type === 'squad' ? squadSize(object) : 0
  const capacityLoss = object.type === 'building' ? buildingRules[object.kind].populationCapacity : 0
  return {
    ok: true,
    state: {
      ...next,
      domains: {
        ...next.domains,
        [state.playerId]: {
          ...domain,
          population: domain.population + populationReturn,
          populationCapacity: Math.max(gameConfig.turn.basePopulationCapacity, domain.populationCapacity - capacityLoss),
        },
      },
    },
  }
}

export function productionFor(state: MatchState, ownerId: string) {
  const taxRule = taxRates[state.domains[ownerId]?.taxRate ?? defaultTaxRate]
  const production = Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  const assignments = new Map(workforceFor(state, ownerId).assignments.map((assignment) => [`${assignment.position.column}:${assignment.position.row}`, assignment]))
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
    const amount = object.type === 'building'
      ? buildingRules[object.kind].upkeep
      : object.type === 'squad'
        ? troopKinds.reduce((squadUpkeep, kind) => {
            resourceIds.forEach((resource) => { squadUpkeep[resource] = (squadUpkeep[resource] ?? 0) + (troopRules[kind].upkeep[resource] ?? 0) * (object.units[kind] ?? 0) })
            return squadUpkeep
          }, {} as ResourceAmount)
        : null
    if (!amount) return
    resourceIds.forEach((resource) => { upkeep[resource] += amount[resource] ?? 0 })
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

export function foodDemandBreakdownFor(state: MatchState, ownerId: string): FoodDemand {
  const domain = state.domains[ownerId]
  if (!domain) return { civilians: 0, soldiers: 0, taxGrain: 0, staple: 0, total: 0, servedCivilians: 0, unservedCivilians: 0 }
  const soldiers = squadSize({ units: troopTotals(state, ownerId) })
  const servedCivilians = Math.min(domain.population, foodServiceCapacityFor(state, ownerId))
  const unservedCivilians = Math.max(0, domain.population - servedCivilians)
  const civilianDemand = Math.ceil(servedCivilians / gameConfig.economy.civilianFoodDivisor)
  const soldierDemand = Math.ceil(soldiers / gameConfig.economy.soldierFoodDivisor)
  const taxDemand = Math.ceil(domain.population * taxRates[domain.taxRate ?? defaultTaxRate].foodPerPerson)
  const staple = civilianDemand + soldierDemand
  return { civilians: civilianDemand, soldiers: soldierDemand, taxGrain: taxDemand, staple, total: staple + taxDemand, servedCivilians, unservedCivilians }
}

export function foodDemandFor(state: MatchState, ownerId: string) {
  return foodDemandBreakdownFor(state, ownerId).total
}

export function foodConsumptionFor(
  state: MatchState,
  ownerId: string,
  available: Pick<Record<ResourceId, number>, 'grain' | 'meat'> = state.domains[ownerId]?.resources ?? { grain: 0, meat: 0 },
): FoodConsumption {
  const demand = foodDemandBreakdownFor(state, ownerId)
  let grainAvailable = available.grain
  const meatAvailable = available.meat
  const taxGrain = Math.min(grainAvailable, demand.taxGrain)
  grainAvailable -= taxGrain
  let grain = taxGrain
  let meat = 0
  let remaining = demand.staple
  const availableStaples = { grain: grainAvailable, meat: meatAvailable }
  const consumedStaples = { grain: 0, meat: 0 }
  const evenShare = Math.floor(demand.staple / gameConfig.economy.foodResources.length)
  const extraUnits = demand.staple % gameConfig.economy.foodResources.length
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
  grain += consumedStaples.grain
  meat += consumedStaples.meat
  const minimumVariety = Math.ceil(demand.staple * gameConfig.economy.diverseDietMinimumShare)
  const fed = taxGrain === demand.taxGrain && remaining === 0 && demand.unservedCivilians === 0
  const diverseDiet = fed
    && minimumVariety > 0
    && minimumVariety * 2 <= demand.staple
    && consumedStaples.grain >= minimumVariety
    && consumedStaples.meat >= minimumVariety
  return { grain, meat, fed, diverseDiet }
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
) {
  const processed = Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>
  let resources = { ...available }
  const assignments = new Map(workforceFor(state, ownerId).assignments.map((assignment) => [`${assignment.position.column}:${assignment.position.row}`, assignment]))
  state.scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    if (object?.type !== 'building' || object.ownerId !== ownerId || !isPrimaryObjectCell(object, column, rowIndex)) return
    const rule = buildingRules[object.kind].processing
    if (!rule) return
    const assignment = assignments.get(`${column}:${rowIndex}`)
    const workerRatio = assignment ? assignment.assigned / assignment.required : 1
    const processingCapacity = Math.floor(rule.maximumPerTurn * workerRatio)
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
  food: FoodConsumption
  upkeepPaid: boolean
}

export function turnEconomyForecastFor(state: MatchState, ownerId: string): TurnEconomyForecast | null {
  const current = state.domains[ownerId]
  if (!current) return null

  // Phase order is intentional: taxes collected later in the turn cannot fund upkeep or processing.
  let resources = applyResources(current.resources, productionFor(state, ownerId))
  const upkeep = upkeepFor(state, ownerId)
  const upkeepPaid = hasResources(resources, upkeep)
  resources = Object.fromEntries(resourceIds.map((resource) => [resource, Math.max(0, resources[resource] - upkeep[resource])])) as Record<ResourceId, number>
  resources = applyResources(resources, processingFor(state, ownerId, resources))
  const food = foodConsumptionFor(state, ownerId, resources)
  resources = { ...resources, grain: resources.grain - food.grain, meat: resources.meat - food.meat }
  resources = { ...resources, gold: resources.gold + taxIncomeFor(state, ownerId) }
  return { resources, food, upkeepPaid }
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
  const domain = humanDomain(state)
  return {
    ok: true,
    state: {
      ...state,
      domains: { ...state.domains, [state.playerId]: { ...domain, taxRate: rate } },
      lastEvent: { kind: 'tax-changed' },
    },
  }
}

export function trade(state: MatchState, marketPosition: CellPosition, resource: Exclude<ResourceId, 'gold'>, direction: 'buy' | 'sell', quantity: number): CommandResult {
  if (state.status !== 'playing') return { ok: false, state, reason: 'game-over' }
  const market = objectAt(state, marketPosition)
  if (market?.type !== 'building' || market.kind !== 'market' || market.ownerId !== state.playerId) return { ok: false, state, reason: 'requires-market' }
  if (!tradeableResources.includes(resource) || !Number.isInteger(quantity) || quantity < 1) return { ok: false, state, reason: 'invalid-trade' }
  const domain = humanDomain(state)
  const price = marketPrices[resource][direction] * quantity
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
  return {
    ok: true,
    state: {
      ...state,
      domains: { ...state.domains, [state.playerId]: { ...domain, resources } },
      lastEvent: { kind: 'traded', amount: quantity },
    },
  }
}

function removeStarvationTroop(cells: GameMap, ownerId: string): GameMap {
  for (let row = 0; row < cells.length; row += 1) {
    for (let column = 0; column < cells[row].length; column += 1) {
      const squad = cells[row][column].object
      if (squad?.type !== 'squad' || squad.ownerId !== ownerId) continue
      const kind = starvationTroopOrder.find((candidate) => (squad.units[candidate] ?? 0) > 0)
      if (!kind) continue
      const units = { ...squad.units, [kind]: (squad.units[kind] ?? 0) - 1 }
      const nextCells = [...cells]
      const nextRow = [...nextCells[row]]
      nextCells[row] = nextRow
      nextRow[column] = {
        ...nextRow[column],
        object: squadSize({ units }) > 0
          ? { ...squad, units, health: Math.min(squadHealth(squad), maxSquadHealth({ units })) }
          : undefined,
      }
      return nextCells
    }
  }
  return cells
}

export function endTurn(state: MatchState): CommandResult {
  if (state.status !== 'playing') return { ok: false, state, reason: 'game-over' }
  const domains = { ...state.domains }
  let cells = state.scenario.cells
  state.scenario.participants.forEach((participant) => {
    const current = domains[participant.id]
    if (!current) return
    const turnState = { ...state, scenario: { ...state.scenario, cells }, domains }
    const resolution = turnEconomyForecastFor(turnState, participant.id)
    if (!resolution) return
    const { resources, food, upkeepPaid } = resolution
    let population = current.population
    if (food.fed) {
      const capacityState = {
        ...turnState,
        domains: { ...turnState.domains, [participant.id]: { ...current, diverseDiet: food.diverseDiet } },
      }
      const civilianCapacity = civilianPopulationCapacityFor(capacityState, participant.id)
      population = Math.min(civilianCapacity, current.population + gameConfig.economy.basePopulationGrowth + (upkeepPaid ? populationGrowthFor(turnState, participant.id) : 0))
    } else {
      const soldiers = squadSize({ units: troopTotals(turnState, participant.id) })
      if (current.population > 0 && current.population + soldiers > gameConfig.economy.minimumPopulation) {
        population = Math.max(0, current.population - gameConfig.economy.starvationPopulationLoss)
      } else if (current.population === 0 && soldiers > gameConfig.economy.minimumPopulation) {
        cells = removeStarvationTroop(cells, participant.id)
      }
    }
    domains[participant.id] = { ...current, resources, population, diverseDiet: food.diverseDiet }
  })
  return {
    ok: true,
    state: {
      ...state,
      turn: state.turn + 1,
      ordersRemaining: gameConfig.turn.maxOrders,
      domains,
      scenario: { ...state.scenario, cells },
      lastEvent: { kind: 'turn-ended' },
    },
  }
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
  return [
    { column: position.column + 1, row: position.row },
    { column: position.column - 1, row: position.row },
    { column: position.column, row: position.row + 1 },
    { column: position.column, row: position.row - 1 },
  ]
}

export function isSamePosition(a: CellPosition | null, b: CellPosition | null) {
  return Boolean(a && b && positionEquals(a, b))
}
