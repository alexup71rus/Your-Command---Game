import { createManualHeightGrid, generateMap, type GeneratorSettings, type ManualHeightGrid } from '../../game/generator'
import type { GameMap } from '../../game/map'
import type { AiProfileId } from '../../game/scenario'

const previewCache = new Map<string, GameMap>()

export const defaultPreviewGrid = createManualHeightGrid()

export interface BattleSeatPreview {
  kind: 'player' | 'ai'
  name: string
  regionIndex: number
  teamId: number
  profileId?: AiProfileId
  opponentIndex?: number
}

export function getPreviewMap(cacheKey: string, settings: GeneratorSettings, manualGrid: ManualHeightGrid) {
  const cached = previewCache.get(cacheKey)
  if (cached) return cached
  const map = generateMap(settings, manualGrid)
  previewCache.set(cacheKey, map)
  return map
}
