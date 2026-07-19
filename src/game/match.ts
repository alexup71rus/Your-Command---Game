import { buildingRules, castleProduction, defaultTaxRate, marketPrices, resourceIds, startingResources, taxRates, tradeableResources, troopKinds, troopRules, type ResourceAmount, type TaxRate } from '../config/rules'
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
  taxRate?: TaxRate
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

export function squadSize(squad: Pick<SquadObject, 'units'>) {
  return troopKinds.reduce((total, kind) => total + (squad.units[kind] ?? 0), 0)
}

export function maxSquadHealth(squad: Pick<SquadObject, 'units'>) {
  return troopKinds.reduce((total, kind) => total + (squad.units[kind] ?? 0) * troopRules[kind].durability, 0)
}

export function squadHealth(squad: Pick<SquadObject, 'units' | 'health'>) {
  return Math.min(squad.health ?? maxSquadHealth(squad), maxSquadHealth(squad))
}

export function squadMovementOrderCost(squad: Pick<SquadObject, 'units'>) {
  return (squad.units.knights ?? 0) > 0 ? 2 : gameConfig.turn.movementOrderCost
}

export function troopTotals(state: MatchState, ownerId: string): TroopComposition {
  return state.scenario.cells.flat().reduce((totals, cell) => {
    const squad = cell.object
    if (squad?.type !== 'squad' || squad.ownerId !== ownerId) return totals
    troopKinds.forEach((kind) => { totals[kind] += squad.units[kind] ?? 0 })
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
      taxRate: defaultTaxRate,
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

function squadDamage(squad: SquadObject, cell: MapCell) {
  const terrainMultiplier = cell.landform === 'hill' ? 1.12 : cell.vegetation ? 1.08 : 1
  return troopKinds.reduce((sum, kind) => sum + (squad.units[kind] ?? 0) * troopRules[kind].damage, 0) * terrainMultiplier
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
  const archerDamage = (attacker.units.archers ?? 0) * troopRules.archers.damage * heightMultiplier * coverMultiplier
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
  const destroyed = hitPoints <= 0
  const next = withCell(state, to, (cell) => ({ ...cell, object: destroyed ? undefined : { ...defender, hitPoints } }), { kind: destroyed ? 'destroyed' : 'attacked', position: to, amount: damage }, gameConfig.turn.movementOrderCost)
  if (destroyed && defender.type === 'castle' && remainingEnemyCastles(next.scenario.cells, state.playerId) === 0) return { ...next, status: 'won' }
  return next
}

function resolveAttack(state: MatchState, from: CellPosition, to: CellPosition, attacker: SquadObject, defender: MapObject): MatchState {
  const fromCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  if (defender.type === 'squad') {
    const nextDefender = applySquadDamage(defender, squadDamage(attacker, fromCell) / 2.2)
    const nextAttacker = applySquadDamage(attacker, squadDamage(defender, targetCell) / 3)
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
  const damage = Math.max(1, Math.ceil(squadDamage(attacker, fromCell) * damageMultiplier))
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
    ? squadMovementOrderCost(source)
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
    state: withTwoCells(state, from, to, { ...fromCell, object: undefined }, { ...targetCell, object: source }, { kind: 'moved', position: to }, squadMovementOrderCost(source)),
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
  const next = withCell(state, position, (cell) => ({ ...cell, object: undefined }), { kind: 'demolished', position }, gameConfig.turn.demolishOrderCost)
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
  return state.scenario.cells.flat().reduce((production, cell) => {
    const object = cell.object
    if (object?.ownerId !== ownerId) return production
    const amount = object.type === 'castle' ? castleProduction : object.type === 'building' ? buildingRules[object.kind].production : null
    if (!amount) return production
    resourceIds.forEach((resource) => {
      const produced = amount[resource] ?? 0
      production[resource] += object.type === 'building' && produced > 0
        ? Math.max(0, produced + taxRule.productionAdjustment)
        : produced
    })
    return production
  }, Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>)
}

export function upkeepFor(state: MatchState, ownerId: string) {
  const upkeep = state.scenario.cells.flat().reduce((total, cell) => {
    const object = cell.object
    if (!object || object.ownerId !== ownerId) return total
    const amount = object.type === 'building'
      ? buildingRules[object.kind].upkeep
      : object.type === 'squad'
        ? troopKinds.reduce((squadUpkeep, kind) => {
            resourceIds.forEach((resource) => { squadUpkeep[resource] = (squadUpkeep[resource] ?? 0) + (troopRules[kind].upkeep[resource] ?? 0) * (object.units[kind] ?? 0) })
            return squadUpkeep
          }, {} as ResourceAmount)
        : null
    if (!amount) return total
    resourceIds.forEach((resource) => { total[resource] += amount[resource] ?? 0 })
    return total
  }, Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>)
  resourceIds.forEach((resource) => { upkeep[resource] = Math.ceil(upkeep[resource]) })
  return upkeep
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
  const baseDemand = Math.ceil(domain.population / 4) + Math.ceil(soldiers / 2)
  const taxDemand = Math.ceil(domain.population * taxRates[domain.taxRate ?? defaultTaxRate].foodPerPerson)
  return baseDemand + taxDemand
}

export function taxIncomeFor(state: MatchState, ownerId: string) {
  const domain = state.domains[ownerId]
  if (!domain) return 0
  return Math.floor(domain.population * taxRates[domain.taxRate ?? defaultTaxRate].goldPerPerson)
}

export function turnResourceDeltaFor(state: MatchState, ownerId: string) {
  const production = productionFor(state, ownerId)
  const upkeep = upkeepFor(state, ownerId)
  const delta = Object.fromEntries(resourceIds.map((resource) => [resource, production[resource] - upkeep[resource]])) as Record<ResourceId, number>
  delta.gold += taxIncomeFor(state, ownerId)
  delta.grain -= foodDemandFor(state, ownerId)
  return delta
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

export function endTurn(state: MatchState): CommandResult {
  if (state.status !== 'playing') return { ok: false, state, reason: 'game-over' }
  const domains = { ...state.domains }
  state.scenario.participants.forEach((participant) => {
    const current = domains[participant.id]
    if (!current) return
    const production = productionFor(state, participant.id)
    let resources = applyResources(current.resources, production)
    resources = { ...resources, gold: resources.gold + taxIncomeFor(state, participant.id) }
    const upkeep = upkeepFor(state, participant.id)
    const upkeepPaid = hasResources(resources, upkeep)
    resources = Object.fromEntries(resourceIds.map((resource) => [resource, Math.max(0, resources[resource] - upkeep[resource])])) as Record<ResourceId, number>
    const foodDemand = foodDemandFor(state, participant.id)
    const fed = resources.grain >= foodDemand
    resources = { ...resources, grain: Math.max(0, resources.grain - foodDemand) }
    const soldiers = squadSize({ units: troopTotals(state, participant.id) })
    const civilianCapacity = Math.max(1, current.populationCapacity - soldiers)
    const population = fed
      ? Math.min(civilianCapacity, current.population + 1 + (upkeepPaid ? populationGrowthFor(state, participant.id) : 0))
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
