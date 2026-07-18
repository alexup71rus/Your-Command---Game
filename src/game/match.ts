import { buildingRules, castleProduction, resourceIds, startingResources, troopKinds, troopRules, type ResourceAmount } from '../config/rules'
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

export interface DomainEconomy {
  resources: Record<ResourceId, number>
  population: number
  populationCapacity: number
}

export type MatchStatus = 'playing' | 'won' | 'lost'

export interface MatchEvent {
  kind: 'built' | 'recruited' | 'moved' | 'merged' | 'split' | 'attacked' | 'destroyed' | 'demolished' | 'turn-ended'
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
  | 'not-adjacent'
  | 'not-enough-orders'
  | 'not-enough-resources'
  | 'not-enough-population'
  | 'requires-barracks'
  | 'squad-full'
  | 'invalid-squad'
  | 'cannot-demolish'

export type CommandResult =
  | { ok: true; state: MatchState }
  | { ok: false; state: MatchState; reason: CommandFailure }

const emptyComposition = (): TroopComposition => ({ militia: 0, spearmen: 0, archers: 0 })
const positionEquals = (a: CellPosition, b: CellPosition) => a.column === b.column && a.row === b.row
const isAdjacent = (a: CellPosition, b: CellPosition) => Math.abs(a.column - b.column) + Math.abs(a.row - b.row) === 1
const cellAt = (state: MatchState, position: CellPosition) => state.scenario.cells[position.row]?.[position.column]

export function squadSize(squad: Pick<SquadObject, 'units'>) {
  return troopKinds.reduce((total, kind) => total + squad.units[kind], 0)
}

export function troopTotals(state: MatchState, ownerId: string): TroopComposition {
  return state.scenario.cells.flat().reduce((totals, cell) => {
    const squad = cell.object
    if (squad?.type !== 'squad' || squad.ownerId !== ownerId) return totals
    troopKinds.forEach((kind) => { totals[kind] += squad.units[kind] })
    return totals
  }, emptyComposition())
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

function withTwoCells(
  state: MatchState,
  first: CellPosition,
  second: CellPosition,
  firstCell: MapCell,
  secondCell: MapCell,
  event: MatchEvent,
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
    ordersRemaining: state.ordersRemaining - 1,
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
  const guard = commandGuard(state, buildingRules[kind].actionCost)
  if (guard) return guard
  const cell = cellAt(state, position)
  if (!cell || cell.landform === 'peak') return 'invalid-terrain'
  if (cell.object) return 'occupied'
  if (state.scenario.territories[position.row]?.[position.column] !== playerRegionId(state)) return 'outside-domain'
  const placement = buildingRules[kind].placement
  if (placement === 'forest' && !cell.vegetation) return 'invalid-terrain'
  if (placement === 'hill' && (cell.landform !== 'hill' || cell.vegetation)) return 'invalid-terrain'
  if (placement === 'open' && cell.vegetation) return 'invalid-terrain'
  const domain = humanDomain(state)
  if (!hasResources(domain.resources, buildingRules[kind].resourceCost)) return 'not-enough-resources'
  return null
}

export function build(state: MatchState, kind: BuildingKind, position: CellPosition): CommandResult {
  const failure = buildingPlacementFailure(state, kind, position)
  if (failure) return { ok: false, state, reason: failure }
  const rule = buildingRules[kind]
  const object: BuildingObject = { type: 'building', kind, ownerId: state.playerId, hitPoints: rule.hitPoints, maxHitPoints: rule.hitPoints }
  const next = withCell(state, position, (cell) => ({ ...cell, object }), { kind: 'built', position }, rule.actionCost)
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
  units[troop] += quantity
  const squad: SquadObject = { type: 'squad', ownerId: state.playerId, units }
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

function removeUnits(units: TroopComposition, losses: number) {
  const next = { ...units }
  let remaining = losses
  for (const kind of troopKinds) {
    const removed = Math.min(next[kind], remaining)
    next[kind] -= removed
    remaining -= removed
  }
  return next
}

function squadStrength(squad: SquadObject, cell: MapCell) {
  const terrainMultiplier = cell.landform === 'hill' ? 1.12 : cell.vegetation ? 1.08 : 1
  return troopKinds.reduce((sum, kind) => sum + squad.units[kind] * troopRules[kind].strength, 0) * terrainMultiplier
}

function remainingEnemyCastles(cells: GameMap, playerId: string) {
  return cells.flat().filter((cell) => cell.object?.type === 'castle' && cell.object.ownerId !== playerId).length
}

function resolveAttack(state: MatchState, from: CellPosition, to: CellPosition, attacker: SquadObject, defender: MapObject): MatchState {
  const fromCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  if (defender.type === 'squad') {
    const defenderLosses = Math.max(1, Math.min(squadSize(defender), Math.round(squadStrength(attacker, fromCell) / 2.2)))
    const attackerLosses = Math.max(0, Math.min(squadSize(attacker), Math.round(squadStrength(defender, targetCell) / 3)))
    const nextAttacker = { ...attacker, units: removeUnits(attacker.units, attackerLosses) }
    const nextDefender = { ...defender, units: removeUnits(defender.units, defenderLosses) }
    const attackerSurvives = squadSize(nextAttacker) > 0
    const defenderSurvives = squadSize(nextDefender) > 0
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
  const damage = Math.max(1, Math.ceil(squadSize(attacker) * damageMultiplier))
  const hitPoints = defender.hitPoints - damage
  const destroyed = hitPoints <= 0
  const targetObject = destroyed ? attacker : { ...defender, hitPoints }
  const next = withTwoCells(
    state,
    from,
    to,
    destroyed ? { ...fromCell, object: undefined } : fromCell,
    { ...targetCell, object: targetObject },
    { kind: destroyed ? 'destroyed' : 'attacked', position: to, amount: damage },
  )
  if (destroyed && defender.type === 'castle' && remainingEnemyCastles(next.scenario.cells, state.playerId) === 0) return { ...next, status: 'won' }
  return next
}

export function moveOrAttackFailure(state: MatchState, from: CellPosition, to: CellPosition): CommandFailure | null {
  const guard = commandGuard(state, 1)
  if (guard) return guard
  const source = objectAt(state, from)
  if (source?.type !== 'squad' || source.ownerId !== state.playerId) return 'not-owned'
  if (!isAdjacent(from, to)) return 'not-adjacent'
  const targetCell = cellAt(state, to)
  if (!targetCell || targetCell.landform === 'peak') return 'invalid-terrain'
  const target = targetCell.object
  if (target?.ownerId === state.playerId && target.type !== 'squad') return 'occupied'
  if (target?.type === 'squad' && target.ownerId === state.playerId && squadSize(source) + squadSize(target) > gameConfig.turn.squadCapacity) return 'squad-full'
  return null
}

export function moveOrAttack(state: MatchState, from: CellPosition, to: CellPosition): CommandResult {
  const failure = moveOrAttackFailure(state, from, to)
  if (failure) return { ok: false, state, reason: failure }
  const fromCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  const source = fromCell.object as SquadObject
  const target = targetCell.object
  if (target && target.ownerId !== state.playerId) return { ok: true, state: resolveAttack(state, from, to, source, target) }
  if (target?.type === 'squad') {
    const units = { ...target.units }
    troopKinds.forEach((kind) => { units[kind] += source.units[kind] })
    return {
      ok: true,
      state: withTwoCells(state, from, to, { ...fromCell, object: undefined }, { ...targetCell, object: { ...target, units } }, { kind: 'merged', position: to }),
    }
  }
  return {
    ok: true,
    state: withTwoCells(state, from, to, { ...fromCell, object: undefined }, { ...targetCell, object: source }, { kind: 'moved', position: to }),
  }
}

export function splitFailure(state: MatchState, from: CellPosition, to: CellPosition, units: TroopComposition): CommandFailure | null {
  const guard = commandGuard(state, 1)
  if (guard) return guard
  const source = objectAt(state, from)
  if (source?.type !== 'squad' || source.ownerId !== state.playerId) return 'not-owned'
  if (!isAdjacent(from, to)) return 'not-adjacent'
  const targetCell = cellAt(state, to)
  if (!targetCell || targetCell.landform === 'peak') return 'invalid-terrain'
  if (targetCell.object) return 'occupied'
  const splitSize = troopKinds.reduce((sum, kind) => sum + units[kind], 0)
  if (splitSize < 1 || splitSize >= squadSize(source) || troopKinds.some((kind) => units[kind] < 0 || units[kind] > source.units[kind])) return 'invalid-squad'
  return null
}

export function splitSquad(state: MatchState, from: CellPosition, to: CellPosition, units: TroopComposition): CommandResult {
  const failure = splitFailure(state, from, to, units)
  if (failure) return { ok: false, state, reason: failure }
  const fromCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  const source = fromCell.object as SquadObject
  const remaining = { ...source.units }
  troopKinds.forEach((kind) => { remaining[kind] -= units[kind] })
  return {
    ok: true,
    state: withTwoCells(
      state,
      from,
      to,
      { ...fromCell, object: { ...source, units: remaining } },
      { ...targetCell, object: { type: 'squad', ownerId: state.playerId, units: { ...units } } },
      { kind: 'split', position: to, amount: squadSize({ units }) },
    ),
  }
}

export function demolish(state: MatchState, position: CellPosition): CommandResult {
  const guard = commandGuard(state, 1)
  if (guard) return { ok: false, state, reason: guard }
  const object = objectAt(state, position)
  if (!object || object.ownerId !== state.playerId) return { ok: false, state, reason: 'not-owned' }
  if (object.type === 'castle') return { ok: false, state, reason: 'cannot-demolish' }
  const next = withCell(state, position, (cell) => ({ ...cell, object: undefined }), { kind: 'demolished', position }, 1)
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
  return state.scenario.cells.flat().reduce((production, cell) => {
    const object = cell.object
    if (object?.ownerId !== ownerId) return production
    const amount = object.type === 'castle' ? castleProduction : object.type === 'building' ? buildingRules[object.kind].production : null
    if (!amount) return production
    resourceIds.forEach((resource) => { production[resource] += amount[resource] ?? 0 })
    return production
  }, Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>)
}

export function upkeepFor(state: MatchState, ownerId: string) {
  return state.scenario.cells.flat().reduce((upkeep, cell) => {
    const object = cell.object
    if (object?.type !== 'building' || object.ownerId !== ownerId) return upkeep
    const amount = buildingRules[object.kind].upkeep
    if (!amount) return upkeep
    resourceIds.forEach((resource) => { upkeep[resource] += amount[resource] ?? 0 })
    return upkeep
  }, Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>)
}

function populationGrowthFor(state: MatchState, ownerId: string) {
  return state.scenario.cells.flat().reduce((growth, cell) => {
    const object = cell.object
    return object?.type === 'building' && object.ownerId === ownerId
      ? growth + (buildingRules[object.kind].populationGrowth ?? 0)
      : growth
  }, 0)
}

export function foodDemandFor(state: MatchState, ownerId: string) {
  const domain = state.domains[ownerId]
  if (!domain) return 0
  const soldiers = squadSize({ units: troopTotals(state, ownerId) })
  return Math.ceil(domain.population / 4) + Math.ceil(soldiers / 2)
}

export function turnResourceDeltaFor(state: MatchState, ownerId: string) {
  const production = productionFor(state, ownerId)
  const upkeep = upkeepFor(state, ownerId)
  const delta = Object.fromEntries(resourceIds.map((resource) => [resource, production[resource] - upkeep[resource]])) as Record<ResourceId, number>
  delta.grain -= foodDemandFor(state, ownerId)
  return delta
}

export function endTurn(state: MatchState): CommandResult {
  if (state.status !== 'playing') return { ok: false, state, reason: 'game-over' }
  const domains = { ...state.domains }
  state.scenario.participants.forEach((participant) => {
    const current = domains[participant.id]
    if (!current) return
    const production = productionFor(state, participant.id)
    let resources = applyResources(current.resources, production)
    const upkeep = upkeepFor(state, participant.id)
    const upkeepPaid = hasResources(resources, upkeep)
    if (upkeepPaid) resources = spendResources(resources, upkeep)
    const foodDemand = foodDemandFor(state, participant.id)
    const fed = resources.grain >= foodDemand
    resources = { ...resources, grain: Math.max(0, resources.grain - foodDemand) }
    const population = fed
      ? Math.min(current.populationCapacity, current.population + 1 + (upkeepPaid ? populationGrowthFor(state, participant.id) : 0))
      : Math.max(1, current.population - 1)
    domains[participant.id] = { ...current, resources, population }
  })
  return {
    ok: true,
    state: {
      ...state,
      turn: state.turn + 1,
      ordersRemaining: gameConfig.turn.maxOrders,
      domains,
      lastEvent: { kind: 'turn-ended' },
    },
  }
}

export function defaultSplit(squad: SquadObject) {
  const result = emptyComposition()
  let desired = Math.floor(squadSize(squad) / 2)
  for (const kind of troopKinds) {
    const amount = Math.min(desired, squad.units[kind])
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
