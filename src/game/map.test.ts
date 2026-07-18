import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config/game'
import { createEmptyMap } from './map'

describe('createEmptyMap', () => {
  it('creates the configured number of independent empty cells', () => {
    const map = createEmptyMap()
    const cells = map.flat()

    expect(map).toHaveLength(gameConfig.map.rows)
    expect(map.every((row) => row.length === gameConfig.map.columns)).toBe(true)
    expect(cells).toHaveLength(gameConfig.map.rows * gameConfig.map.columns)
    expect(cells.every((cell) => Object.keys(cell).length === 0)).toBe(true)
    expect(new Set(cells).size).toBe(gameConfig.map.rows * gameConfig.map.columns)
  })
})
