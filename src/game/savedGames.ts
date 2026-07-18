import { gameConfig } from '../config/game'
import type { MatchState } from './match'

const SAVE_VERSION = 1

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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(gameConfig.savedGames.databaseName, gameConfig.savedGames.version)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(gameConfig.savedGames.storeName)) {
        database.createObjectStore(gameConfig.savedGames.storeName, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open saved games'))
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Saved game operation failed'))
  })
}

function isSavedGame(value: unknown): value is SavedGameRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<SavedGameRecord>
  return record.version === SAVE_VERSION
    && typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.updatedAt === 'number'
    && typeof record.match?.turn === 'number'
    && Array.isArray(record.match?.scenario?.cells)
}

export async function listSavedGames(): Promise<SavedGameSummary[]> {
  const database = await openDatabase()
  try {
    const records = await requestResult(database.transaction(gameConfig.savedGames.storeName).objectStore(gameConfig.savedGames.storeName).getAll())
    return records.filter(isSavedGame).map(({ id, name, mapName, turn, updatedAt }) => ({ id, name, mapName, turn, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt)
  } finally {
    database.close()
  }
}

export async function saveGame(match: MatchState): Promise<SavedGameSummary> {
  const database = await openDatabase()
  const updatedAt = Date.now()
  const id = crypto.randomUUID()
  const mapName = match.scenario.name || 'Map'
  const record: SavedGameRecord = { version: SAVE_VERSION, id, name: `${mapName} · ${match.turn}`, mapName, turn: match.turn, updatedAt, match }
  try {
    await requestResult(database.transaction(gameConfig.savedGames.storeName, 'readwrite').objectStore(gameConfig.savedGames.storeName).put(record))
    return { id, name: record.name, mapName, turn: match.turn, updatedAt }
  } finally {
    database.close()
  }
}

export async function loadSavedGame(id: string): Promise<SavedGameRecord> {
  const database = await openDatabase()
  try {
    const value: unknown = await requestResult(database.transaction(gameConfig.savedGames.storeName).objectStore(gameConfig.savedGames.storeName).get(id))
    if (!isSavedGame(value)) throw new Error('Invalid saved game')
    return value
  } finally {
    database.close()
  }
}

export async function deleteSavedGame(id: string): Promise<void> {
  const database = await openDatabase()
  try {
    await requestResult(database.transaction(gameConfig.savedGames.storeName, 'readwrite').objectStore(gameConfig.savedGames.storeName).delete(id))
  } finally {
    database.close()
  }
}
