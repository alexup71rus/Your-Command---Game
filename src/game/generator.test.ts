import { describe, expect, it } from 'vitest'
import {
  createManualHeightGrid,
  defaultGeneratorSettings,
  generateMap,
} from './generator'
import { createEmptyMap } from './map'

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

  it('can regenerate vegetation without changing relief', () => {
    const grid = createManualHeightGrid()
    const original = generateMap(defaultGeneratorSettings, grid, createEmptyMap(32, 32))
    const regenerated = generateMap(
      { ...defaultGeneratorSettings, seed: defaultGeneratorSettings.seed + 10, vegetationDensity: 65 },
      grid,
      original,
      true,
    )

    expect(regenerated.flat().map((cell) => cell.elevation)).toEqual(
      original.flat().map((cell) => cell.elevation),
    )
    expect(regenerated.flat().filter((cell) => cell.vegetation)).not.toHaveLength(
      original.flat().filter((cell) => cell.vegetation).length,
    )
  })
})
