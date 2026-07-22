import { buildingRules, combatRules, troopKinds, troopRules, type ResourceAmount } from '../config/rules'
import { gameConfig } from '../config/game'
import type {
  BuildingKind,
  BuildingObject,
  GameMap,
  MapCell,
  MapObject,
  SquadObject,
  TowerGarrison,
  TroopComposition,
  TroopKind,
} from './map'
import { areOwnersHostile, participantTeamId, type CellPosition } from './scenario'
import { cardinalDirections } from './geometry'
import { friendlyBarbicanPassage, squadMovementOrderCost, squadMovementOrderCostBetween } from './movement'
import type { CommandFailure, CommandResult, MatchEvent, MatchState } from './match/types'
import {
  activeDomain,
  applyResources,
  armyCapacity,
  buildingDistance,
  buildingFootprintPositions,
  buildingObjectPositions,
  buildingResourceCostFor,
  cellAt,
  emptyComposition,
  hasLivingCastle,
  hasResources,
  indexedMapObjects,
  isAdjacent,
  isValidComposition,
  maxSquadHealth,
  objectAt,
  ownedBuildingCount,
  ownedBuildingEntries,
  participantForOwner,
  positionEquals,
  spendResources,
  squadHealth,
  squadSize,
  supportingMillFor,
  totalArmySize,
} from './match/core'

export {
  activeDomain,
  armyCapacity,
  buildingFootprintPositions,
  buildingResourceCostFor,
  civilianHousingCapacityFor,
  civilianPopulationCapacityFor,
  createMatch,
  defaultSplit,
  foodServiceCapacityFor,
  hasLivingCastle,
  humanDomain,
  isEmergencyBuildingFree,
  isOwnedObject,
  isSamePosition,
  maxSquadHealth,
  objectAt,
  ownedBuildingCount,
  participantForOwner,
  positionKey,
  positionsAround,
  squadHealth,
  squadSize,
  supportingMillFor,
  totalArmySize,
  troopTotals,
  withMatchObjectIndexCache,
  workerAssignmentAt,
  workerSeverity,
  workforceFor,
} from './match/core'
export {
  endTurn,
  foodConsumptionFor,
  foodDemandBreakdownFor,
  foodDemandFor,
  processingFor,
  productionFor,
  projectOwnerEconomy,
  setTaxRate,
  taxIncomeFor,
  trade,
  tradeQuoteFor,
  turnEconomyForecastFor,
  turnResourceDeltaFor,
  upkeepFor,
  type OwnerEconomyProjection,
  type TradeQuote,
  type TurnEconomyForecast,
} from './match/economy'
export type {
  CommandFailure,
  CommandResult,
  DomainEconomy,
  FoodConsumption,
  FoodDemand,
  MarketActivity,
  MatchEvent,
  MatchState,
  MatchStatus,
  TroopLoss,
  TurnReport,
  WorkerAssignment,
  WorkforceSummary,
} from './match/types'

function withCell(
  state: MatchState,
  position: CellPosition,
  transform: (cell: MapCell) => MapCell,
  event: MatchEvent,
  ordersSpent: number,
): MatchState {
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

function withCells(
  state: MatchState,
  positions: CellPosition[],
  transform: (cell: MapCell, position: CellPosition) => MapCell,
  event: MatchEvent,
  ordersSpent: number,
): MatchState {
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
  if (!hasResources(activeDomain(state).resources, buildingResourceCostFor(state, state.activeParticipantId, kind)))
    return 'not-enough-resources'
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
  if (
    ownedBuildingEntries(state, state.activeParticipantId, 'farm').some(
      (farm) => buildingDistance({ kind: 'mill', position: millPosition }, farm) <= millRule.radius,
    )
  )
    return true
  for (let row = millPosition.row - millRule.radius - footprint.rows + 1; row <= millPosition.row + millRule.radius; row += 1) {
    for (
      let column = millPosition.column - millRule.radius - footprint.columns + 1;
      column <= millPosition.column + millRule.radius;
      column += 1
    ) {
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
 * treating occupied, unsupported, or invalid footprints as candidates.
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
    const inRange = indexedMapObjects(state, state.activeParticipantId).some(({ object, position: source }) => {
      const isServiceSource =
        object.type === 'castle' || (object.type === 'building' && (buildingRules[object.kind].foodServiceCapacity ?? 0) > 0)
      return (
        isServiceSource &&
        positions.some(
          (candidate) =>
            Math.abs(candidate.column - source.column) + Math.abs(candidate.row - source.row) <= gameConfig.economy.foodServiceRadius,
        )
      )
    })
    if (!inRange) return 'outside-food-service'
  }
  const placement = rule.placement
  if (rule.minimumAdjacentForestCells) {
    const adjacentForestCells = new Set(
      positions
        .flatMap((candidate) =>
          cardinalDirections.map((direction) => ({
            column: candidate.column + direction.column,
            row: candidate.row + direction.row,
          })),
        )
        .filter((neighbor) => cellAt(state, neighbor)?.vegetation)
        .map((neighbor) => `${neighbor.column}:${neighbor.row}`),
    )
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
  if (!hasResources(activeDomain(state).resources, buildingResourceCostFor(state, state.activeParticipantId, kind)))
    return 'not-enough-resources'
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
  const next = withCells(
    state,
    buildingFootprintPositions(kind, position),
    (cell) => ({ ...cell, object }),
    { kind: 'built', position },
    rule.actionCost,
  )
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
  return indexedMapObjects(state, state.activeParticipantId, false).flatMap(({ object, position }) =>
    (troop === 'militia' && object.type === 'castle') || (object.type === 'building' && object.kind === 'barracks') ? [position] : [],
  )
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
  const next = withCell(
    state,
    position,
    (cell) => ({ ...cell, object: squad }),
    { kind: 'recruited', position, amount: quantity },
    rule.actionCost,
  )
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
  const terrainMultiplier =
    cell.landform === 'hill' ? combatRules.melee.hillDamageMultiplier : cell.vegetation ? combatRules.melee.forestDamageMultiplier : 1
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

/**
 * A volley is spread across the formation, so protection is weighted by unit
 * count rather than durability. A single knight therefore cannot lend its full
 * armour to a mostly unarmoured squad.
 */
export function rangedDamageTakenMultiplierFor(squad: Pick<SquadObject, 'units'>) {
  const size = squadSize(squad)
  if (size <= 0) return 1
  return troopKinds.reduce((sum, kind) => sum + (squad.units[kind] ?? 0) * troopRules[kind].rangedDamageTakenMultiplier, 0) / size
}

function collapseDefeatedOwner(state: MatchState, ownerId: string) {
  const cells = state.scenario.cells.map((row) =>
    row.map((cell) => (cell.object?.ownerId === ownerId ? { ...cell, object: undefined } : cell)),
  )
  return { ...state, scenario: { ...state.scenario, cells } }
}

function afterCastleDestroyed(state: MatchState, defeatedOwnerId: string) {
  const spectatorMatch = state.scenario.participants.every((participant) => participant.kind === 'ai')
  const collapsed = collapseDefeatedOwner(state, defeatedOwnerId)
  if (spectatorMatch) {
    const livingRulers = collapsed.scenario.participants.filter((participant) => hasLivingCastle(collapsed, participant.id))
    const livingSides = new Set(livingRulers.map(participantTeamId))
    return livingSides.size > 1 ? collapsed : { ...collapsed, status: 'won' as const }
  }
  if (defeatedOwnerId === state.playerId) return { ...state, status: 'lost' as const }
  const hostileStillAlive = collapsed.scenario.participants.some(
    (participant) =>
      hasLivingCastle(collapsed, participant.id) && areOwnersHostile(collapsed.scenario.participants, state.playerId, participant.id),
  )
  return hostileStillAlive ? collapsed : { ...collapsed, status: 'won' as const }
}

function withRangedStructureDamage(
  state: MatchState,
  position: CellPosition,
  defender: BuildingObject | Extract<MapObject, { type: 'castle' }>,
  hitPoints: number,
  damage: number,
  orderCost: number,
) {
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

function withMeleeStructureDamage(
  state: MatchState,
  from: CellPosition,
  to: CellPosition,
  attacker: SquadObject,
  defender: BuildingObject | Extract<MapObject, { type: 'castle' }>,
  hitPoints: number,
  damage: number,
) {
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
  if (
    source?.type !== 'squad' ||
    source.ownerId !== state.activeParticipantId ||
    (source.units.archers ?? 0) < 1 ||
    !target ||
    !areOwnersHostile(state.scenario.participants, state.activeParticipantId, target.ownerId)
  )
    return false
  const columnDistance = Math.abs(to.column - from.column)
  const rowDistance = Math.abs(to.row - from.row)
  const distance = columnDistance + rowDistance
  if (
    (columnDistance !== 0 && rowDistance !== 0) ||
    distance < gameConfig.turn.archerMinimumRange ||
    distance > gameConfig.turn.archerRange
  )
    return false
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
  orderCost: number = combatRules.ranged.orderCost,
): MatchState {
  const sourceCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  const heightMultiplier = heightMultiplierOverride ?? (sourceCell.landform === 'hill' ? combatRules.ranged.hillDamageMultiplier : 1)
  const coverMultiplier = targetCell.vegetation ? combatRules.ranged.forestCoverMultiplier : 1
  const dietMultiplier = state.domains[attacker.ownerId]?.diverseDiet ? gameConfig.economy.diverseDietDamageMultiplier : 1
  const archerDamage = (attacker.units.archers ?? 0) * troopRules.archers.damage * heightMultiplier * coverMultiplier * dietMultiplier
  if (defender.type === 'squad') {
    const damage = (archerDamage / combatRules.ranged.squadDamageDivisor) * rangedDamageTakenMultiplierFor(defender)
    const nextDefender = applySquadDamage(defender, damage)
    const losses = squadSize(defender) - (nextDefender ? squadSize(nextDefender) : 0)
    return withCell(
      state,
      to,
      (cell) => ({ ...cell, object: nextDefender ?? undefined }),
      { kind: nextDefender ? 'attacked' : 'destroyed', position: to, amount: losses },
      orderCost,
    )
  }
  const damageMultiplier = defender.type === 'building' ? (buildingRules[defender.kind].incomingDamageMultiplier ?? 1) : 1
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
    const defenderSurvives = nextDefender !== null
    const defenderLosses = squadSize(defender) - (nextDefender ? squadSize(nextDefender) : 0)
    const next = withTwoCells(
      state,
      from,
      to,
      { ...fromCell, object: nextAttacker ?? undefined },
      { ...targetCell, object: nextDefender ?? undefined },
      { kind: defenderSurvives ? 'attacked' : 'destroyed', position: to, amount: defenderLosses },
    )
    return next
  }
  const damageMultiplier = defender.type === 'building' ? (buildingRules[defender.kind].incomingDamageMultiplier ?? 1) : 1
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
  if (
    target &&
    target.ownerId !== state.activeParticipantId &&
    !areOwnersHostile(state.scenario.participants, state.activeParticipantId, target.ownerId)
  )
    return 'occupied'
  if (!isAdjacent(from, to)) {
    const passageCost = squadMovementOrderCostBetween(state.scenario.cells, source, from, to)
    if (passageCost !== null) return commandGuard(state, passageCost)
    if (isRangedAttack(state, from, to)) return commandGuard(state, combatRules.ranged.orderCost)
    if (target && target.ownerId !== state.activeParticipantId && (source.units.archers ?? 0) > 0) {
      const aligned = from.column === to.column || from.row === to.row
      const distance = Math.abs(from.column - to.column) + Math.abs(from.row - to.row)
      return aligned && distance <= gameConfig.turn.archerRange ? 'ranged-shot-blocked' : 'out-of-range'
    }
    return 'not-adjacent'
  }
  if (target?.ownerId === state.activeParticipantId && target.type !== 'squad') return 'occupied'
  if (
    target?.type === 'squad' &&
    target.ownerId === state.activeParticipantId &&
    squadSize(source) + squadSize(target) > gameConfig.turn.squadCapacity
  )
    return 'squad-full'
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
      state: withTwoCells(
        state,
        from,
        to,
        { ...fromCell, object: undefined },
        { ...targetCell, object: source },
        { kind: 'moved', position: to },
        orderCost,
      ),
    }
  }
  if (!isAdjacent(from, to) && target) return { ok: true, state: resolveRangedAttack(state, from, to, source, target) }
  if (target && areOwnersHostile(state.scenario.participants, state.activeParticipantId, target.ownerId)) {
    return { ok: true, state: resolveAttack(state, from, to, source, target) }
  }
  if (target?.type === 'squad') {
    const units = { ...target.units }
    troopKinds.forEach((kind) => {
      units[kind] = (units[kind] ?? 0) + (source.units[kind] ?? 0)
    })
    const health = Math.min(maxSquadHealth({ units }), squadHealth(target) + squadHealth(source))
    return {
      ok: true,
      state: withTwoCells(
        state,
        from,
        to,
        { ...fromCell, object: undefined },
        { ...targetCell, object: { ...target, units, health } },
        { kind: 'merged', position: to },
        gameConfig.turn.squadReorganizationOrderCost,
      ),
    }
  }
  return {
    ok: true,
    state: withTwoCells(
      state,
      from,
      to,
      { ...fromCell, object: undefined },
      { ...targetCell, object: source },
      { kind: 'moved', position: to },
      squadMovementOrderCost(source, targetCell),
    ),
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
  if (splitSize < 1 || splitSize >= squadSize(source) || troopKinds.some((kind) => (units[kind] ?? 0) > (source.units[kind] ?? 0)))
    return 'invalid-squad'
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
  troopKinds.forEach((kind) => {
    remaining[kind] -= units[kind]
  })
  const sourceMaxHealth = maxSquadHealth(source)
  const dismissedMaxHealth = maxSquadHealth({ units })
  const dismissedHealth = sourceMaxHealth > 0 ? (squadHealth(source) * dismissedMaxHealth) / sourceMaxHealth : 0
  const remainingObject =
    squadSize({ units: remaining }) > 0
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
  return Boolean(
    garrison &&
    Number.isSafeInteger(garrison.archers) &&
    garrison.archers > 0 &&
    garrison.archers <= towerRule.capacity &&
    Number.isFinite(garrison.health) &&
    garrison.health > 0 &&
    garrison.health <= garrison.archers * troopRules.archers.durability,
  )
}

export function garrisonFailure(
  state: MatchState,
  from: CellPosition,
  towerPosition: CellPosition,
  requestedArchers?: number,
): CommandFailure | null {
  const guard = commandGuard(state, towerRule.transferOrderCost)
  if (guard) return guard
  if (!isAdjacent(from, towerPosition)) return 'not-adjacent'
  const squad = objectAt(state, from)
  if (squad?.type !== 'squad' || squad.ownerId !== state.activeParticipantId) return 'not-owned'
  if (!isValidComposition(squad.units) || (squad.units.archers ?? 0) < 1 || !Number.isFinite(squadHealth(squad)) || squadHealth(squad) <= 0)
    return 'invalid-squad'
  const tower = objectAt(state, towerPosition)
  if (tower?.type !== 'building' || tower.kind !== 'tower' || tower.ownerId !== state.activeParticipantId) return 'not-owned'
  if (tower.garrison && !isValidGarrison(tower.garrison)) return 'invalid-garrison'
  if ((tower.garrison?.archers ?? 0) >= towerRule.capacity) return 'squad-full'
  if (
    requestedArchers !== undefined &&
    (!Number.isSafeInteger(requestedArchers) ||
      requestedArchers < 1 ||
      requestedArchers > squad.units.archers ||
      requestedArchers > towerRule.capacity - (tower.garrison?.archers ?? 0))
  )
    return 'invalid-squad'
  return null
}

export function garrisonTower(
  state: MatchState,
  from: CellPosition,
  towerPosition: CellPosition,
  requestedArchers?: number,
): CommandResult {
  const failure = garrisonFailure(state, from, towerPosition, requestedArchers)
  if (failure) return { ok: false, state, reason: failure }
  const fromCell = cellAt(state, from)
  const towerCell = cellAt(state, towerPosition)
  const squad = fromCell.object as SquadObject
  const tower = towerCell.object as BuildingObject
  const transferred = requestedArchers ?? Math.min(squad.units.archers, towerRule.capacity - (tower.garrison?.archers ?? 0))
  const transferredMaximumHealth = transferred * troopRules.archers.durability
  const sourceMaximumHealth = maxSquadHealth(squad)
  const transferredHealth = sourceMaximumHealth > 0 ? (squadHealth(squad) * transferredMaximumHealth) / sourceMaximumHealth : 0
  const remaining = { ...squad.units, archers: squad.units.archers - transferred }
  const remainingObject =
    squadSize({ units: remaining }) > 0
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
  if (!target || !areOwnersHostile(state.scenario.participants, state.activeParticipantId, target.ownerId)) return 'requires-target'
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
  return {
    ok: true,
    state: resolveRangedAttack(
      state,
      towerPosition,
      to,
      attacker,
      objectAt(state, to)!,
      towerRule.heightDamageMultiplier,
      towerRule.attackOrderCost,
    ),
  }
}

export function splitSquad(state: MatchState, from: CellPosition, to: CellPosition, units: TroopComposition): CommandResult {
  const failure = splitFailure(state, from, to, units)
  if (failure) return { ok: false, state, reason: failure }
  const fromCell = cellAt(state, from)
  const targetCell = cellAt(state, to)
  const source = fromCell.object as SquadObject
  const remaining = { ...source.units }
  troopKinds.forEach((kind) => {
    remaining[kind] = (remaining[kind] ?? 0) - (units[kind] ?? 0)
  })
  const sourceMaxHealth = maxSquadHealth(source)
  const splitMaxHealth = maxSquadHealth({ units })
  const splitHealth = sourceMaxHealth > 0 ? Math.min(splitMaxHealth, (squadHealth(source) * splitMaxHealth) / sourceMaxHealth) : 0
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
  if (object.type === 'castle' || (object.type === 'building' && object.kind === 'tower' && object.garrison))
    return { ok: false, state, reason: 'cannot-demolish' }
  if (object.type === 'squad' && !isValidComposition(object.units)) return { ok: false, state, reason: 'invalid-squad' }
  const positions = object.type === 'building' ? buildingObjectPositions(object, position) : [position]
  const next = withCells(
    state,
    positions,
    (cell) => ({ ...cell, object: undefined }),
    { kind: 'demolished', position },
    gameConfig.turn.demolishOrderCost,
  )
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
