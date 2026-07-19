import { describe, expect, it } from 'vitest'
import type { GameMap } from './map'
import { findMovementPath } from './pathfinding'

function createMap(size = 5): GameMap {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => ({ landform: 'plain' as const, vegetation: false })))
}

describe('movement pathfinding', () => {
  it('finds a shortest orthogonal route around impassable cells and objects', () => {
    const map = createMap()
    map[0][1] = { ...map[0][1], landform: 'peak' }
    map[1][1] = { ...map[1][1], object: { type: 'building', kind: 'wall', ownerId: 'npc', hitPoints: 50, maxHitPoints: 50 } }
    const path = findMovementPath(map, { column: 0, row: 0 }, { column: 2, row: 0 })
    expect(path).toEqual([
      { column: 0, row: 0 },
      { column: 0, row: 1 },
      { column: 0, row: 2 },
      { column: 1, row: 2 },
      { column: 2, row: 2 },
      { column: 2, row: 1 },
      { column: 2, row: 0 },
    ])
  })

  it('returns no route for an occupied destination or a sealed-off target', () => {
    const occupied = createMap()
    occupied[2][2] = { ...occupied[2][2], object: { type: 'castle', ownerId: 'npc', hitPoints: 100, maxHitPoints: 100 } }
    expect(findMovementPath(occupied, { column: 0, row: 0 }, { column: 2, row: 2 })).toBeNull()

    const sealed = createMap()
    sealed[1][2] = { ...sealed[1][2], landform: 'peak' }
    sealed[2][1] = { ...sealed[2][1], landform: 'peak' }
    sealed[2][3] = { ...sealed[2][3], landform: 'peak' }
    sealed[3][2] = { ...sealed[3][2], landform: 'peak' }
    expect(findMovementPath(sealed, { column: 0, row: 0 }, { column: 2, row: 2 })).toBeNull()
  })
})
