import { gameConfig } from '../config/game'
import type { GeneratorSettings, ManualHeightGrid } from './generator'
import type { PresetId } from './presets'

export interface SavedMapDefinition {
  id: string
  name: string
  settings: GeneratorSettings
  manualGrid: ManualHeightGrid
  createdAt: number
}

export interface SavedMapDraft {
  name: string
  settings: GeneratorSettings
  manualGrid: ManualHeightGrid
}

export type MapSelection = `preset:${PresetId}` | `saved:${string}`

export const defaultMapSelection: MapSelection = 'preset:greenMarches'

const reliefModes = ['automatic', 'hybrid', 'manual'] as const
const heightPreferences = ['lowlands', 'balanced', 'highlands'] as const

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseSettings(value: unknown): GeneratorSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as GeneratorSettings
  if (!Number.isSafeInteger(candidate.seed)
    || !Number.isSafeInteger(candidate.mapSize)
    || candidate.mapSize < gameConfig.generator.minMapSize
    || candidate.mapSize > gameConfig.generator.maxMapSize) return null
  if (!reliefModes.includes(candidate.reliefMode)) return null
  if (!heightPreferences.includes(candidate.vegetationHeight)) return null
  const inIntegerRange = (number: unknown, minimum: number, maximum: number) => Number.isSafeInteger(number) && Number(number) >= minimum && Number(number) <= maximum
  if (!inIntegerRange(candidate.hillCoverage, 5, 75)
    || !inIntegerRange(candidate.peakCoverage, 0, 25)
    || candidate.peakCoverage > candidate.hillCoverage
    || !inIntegerRange(candidate.reliefScale, 18, 90)
    || !inIntegerRange(candidate.heightDistribution, -100, 100)
    || !inIntegerRange(candidate.vegetationDensity, 0, 80)
    || !inIntegerRange(candidate.vegetationDistribution, -100, 100)
    || !inIntegerRange(candidate.heightInfluence, 0, 100)) return null
  return candidate
}

function parseManualGrid(value: unknown): ManualHeightGrid | null {
  if (!Array.isArray(value) || value.length !== gameConfig.generator.editorRows) return null
  if (!value.every((row) => Array.isArray(row) && row.length === gameConfig.generator.editorColumns && row.every((cell) => cell === 0 || cell === 1 || cell === 2))) return null
  return value as ManualHeightGrid
}

export function parseSavedMaps(raw: string | null): SavedMapDefinition[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): SavedMapDefinition[] => {
      if (!value || typeof value !== 'object') return []
      const candidate = value as Partial<SavedMapDefinition>
      const settings = parseSettings(candidate.settings)
      const manualGrid = parseManualGrid(candidate.manualGrid)
      if (typeof candidate.id !== 'string' || !candidate.id.trim() || candidate.id.length > 128
        || typeof candidate.name !== 'string' || !candidate.name.trim()
        || !isFiniteNumber(candidate.createdAt) || candidate.createdAt < 0
        || !settings || !manualGrid) return []
      return [{ id: candidate.id, name: candidate.name.trim().slice(0, 48), settings, manualGrid, createdAt: candidate.createdAt }]
    })
  } catch {
    return []
  }
}

export function loadSavedMaps(): SavedMapDefinition[] {
  return loadSavedMapsResult().maps
}

export type SavedMapsLoadResult =
  | { ok: true; maps: SavedMapDefinition[] }
  | { ok: false; maps: []; error: Error }

export function loadSavedMapsResult(): SavedMapsLoadResult {
  try {
    const current = window.localStorage.getItem(gameConfig.savedMaps.storageKey)
    const raw = current ?? window.localStorage.getItem(gameConfig.savedMaps.legacyStorageKey)
    const maps = parseSavedMaps(raw)
    if (current === null && raw !== null) {
      try { window.localStorage.setItem(gameConfig.savedMaps.storageKey, JSON.stringify(maps)) } catch { /* Keep readable legacy maps for this session. */ }
    }
    return { ok: true, maps }
  } catch (cause) {
    return { ok: false, maps: [], error: cause instanceof Error ? cause : new Error('Could not read saved maps') }
  }
}

export type SavedMapsPersistResult =
  | { ok: true }
  | { ok: false; error: Error }

export function persistSavedMaps(maps: SavedMapDefinition[]): SavedMapsPersistResult {
  try {
    window.localStorage.setItem(gameConfig.savedMaps.storageKey, JSON.stringify(maps))
    return { ok: true }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause : new Error('Could not save maps') }
  }
}

export function createSavedMap(name: string, settings: GeneratorSettings, manualGrid: ManualHeightGrid): SavedMapDefinition {
  const suffix = Math.random().toString(36).slice(2, 8)
  return {
    id: `map-${Date.now().toString(36)}-${suffix}`,
    name: name.trim().slice(0, 48),
    settings: { ...settings },
    manualGrid: manualGrid.map((row) => [...row]),
    createdAt: Date.now(),
  }
}

export function presetSelection(id: PresetId): MapSelection {
  return `preset:${id}`
}

export function savedSelection(id: string): MapSelection {
  return `saved:${id}`
}
