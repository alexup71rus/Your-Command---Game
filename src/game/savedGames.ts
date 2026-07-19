import { gameConfig } from '../config/game'
import { buildingKinds, buildingRules, resourceIds, taxRates, tradeableResources, troopKinds, troopRules } from '../config/rules'
import type { BuildingKind, MapObject, ResourceId, TroopComposition } from './map'
import type { MatchEvent, MatchState, TurnReport } from './match'
import type { CellPosition, MapScenario, StartRegion } from './scenario'

export const SAVE_VERSION = 7

export interface SavedGameSummary {
  id: string
  name: string
  mapName: string
  turn: number
  updatedAt: number
}

export interface SavedGameRecord extends SavedGameSummary {
  version: typeof SAVE_VERSION
  match: MatchState
}

const eventKinds: MatchEvent['kind'][] = ['built', 'recruited', 'moved', 'merged', 'split', 'dismissed', 'garrisoned', 'ungarrisoned', 'attacked', 'destroyed', 'demolished', 'traded', 'tax-changed', 'turn-ended']
const statuses: MatchState['status'][] = ['playing', 'won', 'lost']

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isBoundedString(value: unknown, maximum = 128): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function isPosition(value: unknown, size: number): value is CellPosition {
  if (!isRecord(value)) return false
  return isNonNegativeInteger(value.column) && value.column < size
    && isNonNegativeInteger(value.row) && value.row < size
}

function isResourceRecord(value: unknown): value is Record<ResourceId, number> {
  return isRecord(value) && resourceIds.every((resource) => isFiniteNonNegative(value[resource]))
}

function isResourceAmount(value: unknown) {
  return isRecord(value)
    && Object.keys(value).every((resource) => resourceIds.includes(resource as ResourceId))
    && Object.values(value).every(isNonNegativeInteger)
}

function isSignedResourceRecord(value: unknown): value is Record<ResourceId, number> {
  return isRecord(value) && resourceIds.every((resource) => typeof value[resource] === 'number' && Number.isFinite(value[resource]))
}

function isMarketActivity(value: unknown) {
  if (!isRecord(value) || !isRecord(value.bought) || !isRecord(value.sold)) return false
  const bought = value.bought
  const sold = value.sold
  return tradeableResources.every((resource) => isNonNegativeInteger(bought[resource]) && isNonNegativeInteger(sold[resource]))
}

function isComposition(value: unknown): value is TroopComposition {
  return isRecord(value) && troopKinds.every((kind) => isNonNegativeInteger(value[kind]))
}

function compositionSize(units: TroopComposition) {
  return troopKinds.reduce((total, kind) => total + units[kind], 0)
}

function compositionHealth(units: TroopComposition) {
  return troopKinds.reduce((total, kind) => total + units[kind] * troopRules[kind].durability, 0)
}

function isMapObject(value: unknown, owners: Set<string>, size: number, column: number, row: number): value is MapObject {
  if (!isRecord(value) || !owners.has(String(value.ownerId))) return false
  if (value.type === 'squad') {
    if (!isComposition(value.units)) return false
    const count = compositionSize(value.units)
    if (count < 1 || count > gameConfig.turn.squadCapacity) return false
    return value.health === undefined || (isFiniteNonNegative(value.health) && value.health > 0 && value.health <= compositionHealth(value.units))
  }
  if (value.type !== 'castle' && value.type !== 'building') return false
  if (!isFiniteNonNegative(value.hitPoints) || value.hitPoints <= 0 || !isFiniteNonNegative(value.maxHitPoints) || value.maxHitPoints <= 0 || value.hitPoints > value.maxHitPoints) return false
  if (value.type === 'castle') return value.maxHitPoints === gameConfig.turn.castleHitPoints
  if (typeof value.kind !== 'string' || !buildingKinds.includes(value.kind as BuildingKind)) return false
  const kind = value.kind as BuildingKind
  if (value.maxHitPoints !== buildingRules[kind].hitPoints) return false
  if (!isResourceAmount(value.constructionCost)) return false
  const standardCost = buildingRules[kind].resourceCost
  const paidStandardCost = resourceIds.every((resource) => ((value.constructionCost as Record<string, number>)[resource] ?? 0) === (standardCost[resource] ?? 0))
  const paidEmergencyCost = Boolean(buildingRules[kind].emergencyFreeIfMissing)
    && resourceIds.every((resource) => ((value.constructionCost as Record<string, number>)[resource] ?? 0) === 0)
  if (!paidStandardCost && !paidEmergencyCost) return false
  const expected = buildingRules[kind].footprint ?? { columns: 1, rows: 1 }
  if (value.footprint !== undefined) {
    if (!isRecord(value.footprint)
      || !isNonNegativeInteger(value.footprint.originColumn)
      || !isNonNegativeInteger(value.footprint.originRow)
      || value.footprint.columns !== expected.columns
      || value.footprint.rows !== expected.rows
      || value.footprint.originColumn + expected.columns > size
      || value.footprint.originRow + expected.rows > size
      || column < value.footprint.originColumn
      || column >= value.footprint.originColumn + expected.columns
      || row < value.footprint.originRow
      || row >= value.footprint.originRow + expected.rows) return false
  } else if (expected.columns > 1 || expected.rows > 1) return false
  if (value.garrison === undefined) return true
  const garrisonRule = buildingRules[kind].garrison
  return Boolean(garrisonRule
    && isRecord(value.garrison)
    && isNonNegativeInteger(value.garrison.archers)
    && value.garrison.archers > 0
    && value.garrison.archers <= garrisonRule.capacity
    && isFiniteNonNegative(value.garrison.health)
    && value.garrison.health > 0
    && value.garrison.health <= value.garrison.archers * troopRules.archers.durability)
}

function isRegion(value: unknown, regionIds: Set<string>, size: number): value is StartRegion {
  if (!isRecord(value)
    || !isBoundedString(value.id, 64)
    || !regionIds.has(value.id)
    || !isNonNegativeInteger(value.index)
    || typeof value.color !== 'string'
    || !isPosition(value.center, size)
    || !Array.isArray(value.validCastleCells)
    || value.validCastleCells.length === 0
    || !value.validCastleCells.every((position) => isPosition(position, size))
    || !isRecord(value.score)
    || !isNonNegativeInteger(value.score.cells)
    || value.score.cells < 1
    || !isNonNegativeInteger(value.score.forest)
    || !isNonNegativeInteger(value.score.hills)
    || !isFiniteNonNegative(value.score.quality)
    || !isRecord(value.reservedBuildSites)) return false
  const reservedBuildSites = value.reservedBuildSites
  return ['plain', 'hill', 'extra', 'house'].every((key) => isPosition(reservedBuildSites[key], size))
}

function isScenario(value: unknown): value is MapScenario {
  if (!isRecord(value)
    || !isBoundedString(value.id)
    || !isBoundedString(value.name)
    || !Number.isSafeInteger(value.seed)
    || !isNonNegativeInteger(value.participantCount)
    || value.participantCount < gameConfig.match.minParticipants
    || value.participantCount > gameConfig.match.maxParticipants
    || !Array.isArray(value.cells)) return false
  const participantCount = value.participantCount
  const size = value.cells.length
  if (size < gameConfig.generator.minMapSize || size > gameConfig.generator.maxMapSize) return false
  if (!Array.isArray(value.territories) || value.territories.length !== size
    || !Array.isArray(value.regions) || value.regions.length !== value.participantCount
    || !Array.isArray(value.participants) || value.participants.length !== value.participantCount) return false

  const participants = value.participants
  if (!participants.every(isRecord)) return false
  const ownerIds = new Set(participants.map((participant) => participant.id).filter((id): id is string => isBoundedString(id, 64)))
  const regionIds = new Set(value.regions.flatMap((region) => isRecord(region) && isBoundedString(region.id, 64) ? [region.id] : []))
  if (ownerIds.size !== participantCount || regionIds.size !== participantCount) return false
  if (!participants.every((participant) => (
    isBoundedString(participant.id, 64)
    && (participant.kind === 'human' || participant.kind === 'npc')
    && isBoundedString(participant.regionId, 64)
    && regionIds.has(participant.regionId)
    && typeof participant.color === 'string'
  ))) return false
  if (participants.filter((participant) => participant.kind === 'human').length !== 1) return false
  if (new Set(participants.map((participant) => participant.regionId)).size !== participantCount) return false
  if (!value.regions.every((region) => isRegion(region, regionIds, size))) return false
  const regions = value.regions as StartRegion[]
  if (new Set(regions.map((region) => region.index)).size !== participantCount
    || regions.some((region) => region.index >= participantCount)) return false

  if (!value.cells.every((row, rowIndex) => Array.isArray(row) && row.length === size && row.every((cell, column) => (
    isRecord(cell)
    && isFiniteNonNegative(cell.elevation)
    && cell.elevation <= 1
    && (cell.landform === 'plain' || cell.landform === 'hill' || cell.landform === 'peak')
    && typeof cell.vegetation === 'boolean'
    && (cell.object === undefined || isMapObject(cell.object, ownerIds, size, column, rowIndex))
  )))) return false
  if (!value.territories.every((row) => Array.isArray(row) && row.length === size && row.every((regionId) => regionId === null || regionIds.has(String(regionId))))) return false
  const cells = value.cells as MapScenario['cells']
  const territories = value.territories as MapScenario['territories']

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const object = cells[row][column].object
      if (object?.type !== 'building' || !object.footprint) continue
      const origin = cells[object.footprint.originRow]?.[object.footprint.originColumn]?.object
      if (origin?.type !== 'building'
        || origin.kind !== object.kind
        || origin.ownerId !== object.ownerId
        || origin.footprint?.originColumn !== object.footprint.originColumn
        || origin.footprint.originRow !== object.footprint.originRow) return false
      if (object.footprint.originColumn !== column || object.footprint.originRow !== row) continue
      for (let dy = 0; dy < object.footprint.rows; dy += 1) {
        for (let dx = 0; dx < object.footprint.columns; dx += 1) {
          const member = cells[row + dy][column + dx].object
          if (member?.type !== 'building'
            || member.kind !== object.kind
            || member.ownerId !== object.ownerId
            || member.hitPoints !== object.hitPoints
            || member.maxHitPoints !== object.maxHitPoints
            || member.footprint?.originColumn !== column
            || member.footprint.originRow !== row
            || member.footprint.columns !== object.footprint.columns
            || member.footprint.rows !== object.footprint.rows) return false
        }
      }
    }
  }

  for (const region of regions) {
    const territoryCells: Array<{ column: number; row: number }> = []
    territories.forEach((territoryRow, row) => territoryRow.forEach((id, column) => {
      if (id === region.id) territoryCells.push({ column, row })
    }))
    const forest = territoryCells.filter(({ column, row }) => cells[row][column].vegetation).length
    const hills = territoryCells.filter(({ column, row }) => cells[row][column].landform === 'hill').length
    const quality = territoryCells.length + forest * gameConfig.match.forestRegionValue + hills * gameConfig.match.hillRegionValue
    if (region.score.cells !== territoryCells.length || region.score.forest !== forest || region.score.hills !== hills || Math.abs(region.score.quality - quality) > 1e-9) return false
    if (!region.validCastleCells.some(({ column, row }) => column === region.center.column && row === region.center.row)) return false
    if (region.validCastleCells.some(({ column, row }) => territories[row]?.[column] !== region.id)) return false
    const reserved = Object.entries(region.reservedBuildSites).flatMap(([kind, origin]) => (
      kind === 'house'
        ? [{ kind, column: origin.column, row: origin.row }]
        : [
            { kind, column: origin.column, row: origin.row },
            { kind, column: origin.column + 1, row: origin.row },
            { kind, column: origin.column, row: origin.row + 1 },
            { kind, column: origin.column + 1, row: origin.row + 1 },
          ]
    ))
    if (new Set(reserved.map(({ column, row }) => `${column}:${row}`)).size !== 13) return false
    if (reserved.some(({ kind, column, row }) => {
      const cell = cells[row]?.[column]
      return territories[row]?.[column] !== region.id
        || !cell || cell.landform === 'peak' || cell.vegetation
        || (kind === 'plain' && cell.landform !== 'plain')
        || (kind === 'hill' && cell.landform !== 'hill')
    })) return false
    const house = region.reservedBuildSites.house
    if (region.validCastleCells.some((castle) => Math.abs(castle.column - house.column) + Math.abs(castle.row - house.row) > gameConfig.economy.foodServiceRadius)) return false
    const participant = participants.find((candidate) => candidate.regionId === region.id)
    if (!participant || participant.color !== region.color) return false
  }
  return true
}

function isMatchEvent(value: unknown, size: number): value is MatchEvent {
  return isRecord(value)
    && typeof value.kind === 'string'
    && eventKinds.includes(value.kind as MatchEvent['kind'])
    && (value.position === undefined || isPosition(value.position, size))
    && (value.amount === undefined || isFiniteNonNegative(value.amount))
}

function isTroopLoss(value: unknown, size: number) {
  return isRecord(value)
    && typeof value.kind === 'string'
    && troopKinds.includes(value.kind as never)
    && isPosition(value.position, size)
    && (value.source === 'squad' || value.source === 'garrison')
}

function isTurnReport(value: unknown, owners: Set<string>, size: number): value is TurnReport {
  if (!isRecord(value)
    || !isBoundedString(value.ownerId, 64)
    || !owners.has(value.ownerId)
    || !isResourceRecord(value.resourcesBefore)
    || !isResourceRecord(value.production)
    || !isFiniteNonNegative(value.taxIncome)
    || !isResourceRecord(value.upkeep)
    || typeof value.upkeepPaid !== 'boolean'
    || !isSignedResourceRecord(value.processing)
    || !isRecord(value.food)
    || !isFiniteNonNegative(value.food.grain)
    || !isFiniteNonNegative(value.food.meat)
    || !isFiniteNonNegative(value.food.fruit)
    || typeof value.food.fed !== 'boolean'
    || typeof value.food.diverseDiet !== 'boolean'
    || !isResourceRecord(value.resourcesAfter)
    || !isNonNegativeInteger(value.populationBefore)
    || !isNonNegativeInteger(value.populationAfter)
    || (value.populationReason !== null && value.populationReason !== 'growth' && value.populationReason !== 'starvation' && value.populationReason !== 'capacity')
    || (value.desertion !== null && !isTroopLoss(value.desertion, size))) return false
  return value.starvation === null || value.starvation === 'civilian' || isTroopLoss(value.starvation, size)
}

function isMatchState(value: unknown): value is MatchState {
  if (!isRecord(value) || !isScenario(value.scenario)) return false
  const scenario = value.scenario
  const size = scenario.cells.length
  const owners = new Set(scenario.participants.map((participant) => participant.id))
  const human = scenario.participants.find((participant) => participant.kind === 'human')
  if (!isBoundedString(value.playerId, 64) || value.playerId !== human?.id
    || !isNonNegativeInteger(value.turn) || value.turn < 1
    || !isNonNegativeInteger(value.ordersRemaining) || value.ordersRemaining > gameConfig.turn.maxOrders
    || typeof value.status !== 'string' || !statuses.includes(value.status as MatchState['status'])
    || (value.lastEvent !== null && !isMatchEvent(value.lastEvent, size))
    || !isRecord(value.domains)
    || !isRecord(value.lastTurnReports)) return false
  const domains = value.domains
  if (Object.keys(domains).length !== owners.size || ![...owners].every((owner) => {
    const domain = domains[owner]
    return isRecord(domain)
      && isResourceRecord(domain.resources)
      && isNonNegativeInteger(domain.population)
      && (domain.taxRate === undefined || (typeof domain.taxRate === 'string' && domain.taxRate in taxRates))
      && typeof domain.diverseDiet === 'boolean'
      && isMarketActivity(domain.marketActivity)
  })) return false
  const armyCounts = Object.fromEntries([...owners].map((owner) => [owner, 0])) as Record<string, number>
  const buildingCounts = Object.fromEntries([...owners].map((owner) => [owner, Object.fromEntries(buildingKinds.map((kind) => [kind, 0])) as Record<BuildingKind, number>])) as Record<string, Record<BuildingKind, number>>
  scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    if (object?.type === 'squad') armyCounts[object.ownerId] += compositionSize(object.units)
    if (object?.type === 'building') {
      if (!object.footprint || (object.footprint.originColumn === column && object.footprint.originRow === rowIndex)) buildingCounts[object.ownerId][object.kind] += 1
      if (object.kind === 'tower' && object.garrison) armyCounts[object.ownerId] += object.garrison.archers
    }
  }))
  if (Object.values(armyCounts).some((count) => count > gameConfig.army.capacity)) return false
  if ([...owners].some((owner) => buildingKinds.some((kind) => {
    const maximum = buildingRules[kind].maxPerOwner
    return maximum !== undefined && buildingCounts[owner][kind] > maximum
  }))) return false
  return Object.entries(value.lastTurnReports).every(([owner, report]) => owners.has(owner) && isTurnReport(report, owners, size) && report.ownerId === owner)
}

export function isSavedGameRecord(value: unknown): value is SavedGameRecord {
  if (!isRecord(value)
    || value.version !== SAVE_VERSION
    || !isBoundedString(value.id)
    || !isBoundedString(value.name)
    || !isBoundedString(value.mapName)
    || !isNonNegativeInteger(value.turn)
    || value.turn < 1
    || !isNonNegativeInteger(value.updatedAt)
    || !isMatchState(value.match)) return false
  return value.turn === value.match.turn && value.mapName === value.match.scenario.name
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const request = indexedDB.open(gameConfig.savedGames.databaseName, gameConfig.savedGames.version)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(gameConfig.savedGames.storeName)) {
        database.createObjectStore(gameConfig.savedGames.storeName, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      reject(request.error ?? new Error('Could not open saved games'))
    }
    request.onblocked = () => {
      if (settled) return
      settled = true
      reject(new Error('Saved games database is blocked by another tab'))
    }
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Saved game operation failed'))
  })
}

export function transactionCompletion(transaction: Pick<IDBTransaction, 'error' | 'oncomplete' | 'onabort' | 'onerror'>): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    transaction.oncomplete = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const fail = () => {
      if (settled) return
      settled = true
      reject(transaction.error ?? new Error('Saved game transaction failed'))
    }
    transaction.onerror = fail
    transaction.onabort = fail
  })
}

export async function listSavedGames(): Promise<SavedGameSummary[]> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(gameConfig.savedGames.storeName)
    const [records] = await Promise.all([
      requestResult(transaction.objectStore(gameConfig.savedGames.storeName).getAll()),
      transactionCompletion(transaction),
    ])
    return records.filter(isSavedGameRecord).map(({ id, name, mapName, turn, updatedAt }) => ({ id, name, mapName, turn, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt)
  } finally {
    database.close()
  }
}

export async function saveGame(match: MatchState): Promise<SavedGameSummary> {
  const updatedAt = Date.now()
  const id = crypto.randomUUID()
  const mapName = match.scenario.name || 'Map'
  const record: SavedGameRecord = { version: SAVE_VERSION, id, name: `${mapName} · ${match.turn}`, mapName, turn: match.turn, updatedAt, match }
  if (!isSavedGameRecord(record)) throw new Error('Current match state cannot be saved')
  const database = await openDatabase()
  try {
    const transaction = database.transaction(gameConfig.savedGames.storeName, 'readwrite')
    await Promise.all([
      requestResult(transaction.objectStore(gameConfig.savedGames.storeName).put(record)),
      transactionCompletion(transaction),
    ])
    return { id, name: record.name, mapName, turn: match.turn, updatedAt }
  } finally {
    database.close()
  }
}

export async function loadSavedGame(id: string): Promise<SavedGameRecord> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(gameConfig.savedGames.storeName)
    const [value] = await Promise.all([
      requestResult(transaction.objectStore(gameConfig.savedGames.storeName).get(id)),
      transactionCompletion(transaction),
    ])
    if (!isSavedGameRecord(value)) throw new Error('Invalid or incompatible saved game')
    return value
  } finally {
    database.close()
  }
}

export async function deleteSavedGame(id: string): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(gameConfig.savedGames.storeName, 'readwrite')
    await Promise.all([
      requestResult(transaction.objectStore(gameConfig.savedGames.storeName).delete(id)),
      transactionCompletion(transaction),
    ])
  } finally {
    database.close()
  }
}
