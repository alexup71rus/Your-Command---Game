import { describe, expect, it } from 'vitest'
import {
  createManualHeightGrid,
  defaultGeneratorSettings,
  generateMap,
} from './generator'

describe('map generator', () => {
  it('is deterministic for the same seed and settings', () => {
    const grid = createManualHeightGrid()
    const first = generateMap(defaultGeneratorSettings, grid)
    const second = generateMap(defaultGeneratorSettings, grid)

    expect(second).toEqual(first)
  })

  it('creates configured relief coverage and keeps peaks free of vegetation', () => {
    const map = generateMap(defaultGeneratorSettings, createManualHeightGrid())
    const cells = map.flat()
    const peaks = cells.filter((cell) => cell.landform === 'peak')
    const elevated = cells.filter((cell) => cell.landform !== 'plain')

    expect(peaks.length / cells.length).toBeCloseTo(defaultGeneratorSettings.peakCoverage / 100, 2)
    expect(elevated.length / cells.length).toBeCloseTo(defaultGeneratorSettings.hillCoverage / 100, 2)
    expect(peaks.every((cell) => cell.vegetation === false)).toBe(true)
  })

  it.each([50, 150])('creates a square map with %i cells per side', (mapSize) => {
    const map = generateMap({ ...defaultGeneratorSettings, mapSize }, createManualHeightGrid())
    expect(map).toHaveLength(mapSize)
    expect(map.every((row) => row.length === mapSize)).toBe(true)
  })

})
