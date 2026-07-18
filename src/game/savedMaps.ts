import { gameConfig } from '../config/game'
import { defaultGeneratorSettings, type GeneratorSettings, type ManualHeightGrid } from './generator'
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
  if (!value || typeof value !== 'object') return null
  const candidate = { ...defaultGeneratorSettings, ...value } as GeneratorSettings
  if (!isFiniteNumber(candidate.seed) || !isFiniteNumber(candidate.mapSize)) return null
  if (!reliefModes.includes(candidate.reliefMode)) return null
  if (!heightPreferences.includes(candidate.vegetationHeight)) return null
  const numericKeys: Array<keyof GeneratorSettings> = ['hillCoverage', 'peakCoverage', 'reliefScale', 'heightDistribution', 'vegetationDensity', 'vegetationDistribution', 'heightInfluence']
  if (numericKeys.some((key) => !isFiniteNumber(candidate[key]))) return null
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
      if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || !candidate.name.trim() || !isFiniteNumber(candidate.createdAt) || !settings || !manualGrid) return []
      return [{ id: candidate.id, name: candidate.name.trim().slice(0, 48), settings, manualGrid, createdAt: candidate.createdAt }]
    })
  } catch {
    return []
  }
}

export function loadSavedMaps(): SavedMapDefinition[] {
  try {
    return parseSavedMaps(window.localStorage.getItem(gameConfig.savedMaps.storageKey))
  } catch {
    return []
  }
}

export function persistSavedMaps(maps: SavedMapDefinition[]) {
  try {
    window.localStorage.setItem(gameConfig.savedMaps.storageKey, JSON.stringify(maps))
  } catch {
    // Keep the maps for this session when storage is unavailable.
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
