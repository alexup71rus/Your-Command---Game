import { describe, expect, it } from 'vitest'
import { mapSizeForSelection, profilesForSetup, teamsForSetup } from './battleSetup'
import { createManualHeightGrid } from './generator'
import { mapPresets } from './presets'
import type { SavedMapDefinition } from './savedMaps'

describe('battle setup model', () => {
  it('keeps participant profiles within the available seats', () => {
    expect(profilesForSetup(true, ['radomir', 'velislava', 'svyatobor'], 2)).toEqual(['radomir'])
    expect(profilesForSetup(false, [], 4)).toEqual(['radomir'])
    expect(profilesForSetup(true, ['velislava'], 4, 4)).toHaveLength(3)
  })

  it('normalizes team slots without mutating the source', () => {
    const teams = [3, 1, 4]
    expect(teamsForSetup(teams, 2)).toEqual([3, 1])
    expect(teamsForSetup(teams, 4)).toEqual([3, 1, 4, 4])
    expect(teams).toEqual([3, 1, 4])
  })

  it('resolves preset and saved map sizes with a safe fallback', () => {
    const preset = mapPresets[0]
    const savedMap: SavedMapDefinition = {
      id: 'custom',
      name: 'Custom',
      settings: { ...preset.settings, mapSize: 100 },
      manualGrid: createManualHeightGrid(),
      createdAt: 0,
    }

    expect(mapSizeForSelection(`preset:${preset.id}`, [])).toBe(preset.settings.mapSize)
    expect(mapSizeForSelection('saved:custom', [savedMap])).toBe(100)
    expect(mapSizeForSelection('saved:missing', [])).toBeGreaterThan(0)
  })
})
