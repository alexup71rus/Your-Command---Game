import { afterEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config/game'
import { createManualHeightGrid, defaultGeneratorSettings } from './generator'
import { loadSavedMapsResult, parseSavedMaps, persistSavedMaps, type SavedMapDefinition } from './savedMaps'

const savedMap: SavedMapDefinition = {
  id: 'map-1',
  name: 'Northern road',
  settings: { ...defaultGeneratorSettings },
  manualGrid: createManualHeightGrid(),
  createdAt: 1_000,
}

afterEach(() => vi.unstubAllGlobals())

describe('saved map parameters', () => {
  it('round-trips a complete generator definition', () => {
    expect(parseSavedMaps(JSON.stringify([savedMap]))).toEqual([savedMap])
  })

  it.each([
    { mapSize: 49 },
    { mapSize: 151 },
    { mapSize: 99.5 },
    { hillCoverage: 76 },
    { peakCoverage: 26 },
    { hillCoverage: 5, peakCoverage: 6 },
    { reliefScale: 17 },
    { vegetationDensity: 81 },
    { heightInfluence: Number.NaN },
  ])('rejects settings outside generator limits: %o', (patch) => {
    const candidate = { ...savedMap, settings: { ...savedMap.settings, ...patch } }
    expect(parseSavedMaps(JSON.stringify([candidate]))).toEqual([])
  })

  it('reports a localStorage write failure instead of claiming success', () => {
    vi.stubGlobal('window', { localStorage: { setItem: () => { throw new Error('quota') } } })
    expect(persistSavedMaps([savedMap])).toMatchObject({ ok: false, error: { message: 'quota' } })
  })

  it('reports a localStorage read failure', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('denied') } } })
    expect(loadSavedMapsResult()).toMatchObject({ ok: false, maps: [], error: { message: 'denied' } })
  })

  it('writes to the configured storage key', () => {
    const setItem = vi.fn()
    vi.stubGlobal('window', { localStorage: { setItem } })
    expect(persistSavedMaps([savedMap])).toEqual({ ok: true })
    expect(setItem).toHaveBeenCalledWith(gameConfig.savedMaps.storageKey, JSON.stringify([savedMap]))
  })
})
