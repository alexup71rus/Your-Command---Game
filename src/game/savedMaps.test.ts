import { describe, expect, it } from 'vitest'
import { createManualHeightGrid, defaultGeneratorSettings } from './generator'
import { parseSavedMaps } from './savedMaps'

describe('saved maps', () => {
  it('restores a compact generator recipe', () => {
    const raw = JSON.stringify([{ id: 'map-1', name: '  Borderlands  ', settings: defaultGeneratorSettings, manualGrid: createManualHeightGrid(), createdAt: 42 }])
    expect(parseSavedMaps(raw)).toEqual([{ id: 'map-1', name: 'Borderlands', settings: defaultGeneratorSettings, manualGrid: createManualHeightGrid(), createdAt: 42 }])
  })

  it('ignores malformed and incompatible entries', () => {
    expect(parseSavedMaps('not json')).toEqual([])
    expect(parseSavedMaps(JSON.stringify([{ id: 'broken', name: 'Broken', settings: {}, manualGrid: [[9]], createdAt: 1 }]))).toEqual([])
  })
})
