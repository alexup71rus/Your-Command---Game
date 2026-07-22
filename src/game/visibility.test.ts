import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config/game'
import { createEmptyMap, type BuildingObject, type GameMap, type SquadObject } from './map'
import { calculateVisibility, createVisibilitySelector, hasNearbyEnemyThreat, isCellVisible, isObjectVisible, visibleObjectAt } from './visibility'

const squad = (ownerId: string): SquadObject => ({
  type: 'squad',
  ownerId,
  units: { militia: 1, spearmen: 0, archers: 0, knights: 0 },
})

const building = (ownerId: string, kind: BuildingObject['kind']): BuildingObject => ({
  type: 'building',
  ownerId,
  kind,
  hitPoints: 10,
  maxHitPoints: 10,
})

function mapWithTerrain(size = 40): GameMap {
  return createEmptyMap(size, size).map((row) => row.map((cell) => ({ ...cell, elevation: 0.2, landform: 'plain' as const, vegetation: false })))
}

describe('visibility', () => {
  it('keeps the current game fully visible while retaining the dormant fog calculation', () => {
    const map = mapWithTerrain()
    map[4][4].object = { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 }
    map[30][30].object = squad('enemy')

    const openVisibility = calculateVisibility(map, 'player')
    expect(gameConfig.visibility.enabled).toBe(false)
    expect(isCellVisible(openVisibility, { column: 30, row: 30 })).toBe(true)
    expect(visibleObjectAt(map, openVisibility, 'player', { column: 30, row: 30 })).toMatchObject({ type: 'squad' })

    const dormantFog = calculateVisibility(map, 'player', true)
    expect(isCellVisible(dormantFog, { column: 30, row: 30 })).toBe(false)
  })

  it('reuses visibility while the immutable map and player stay unchanged', () => {
    const selectVisibility = createVisibilitySelector()
    const map = mapWithTerrain()
    map[20][20].object = squad('player')

    const first = selectVisibility(map, 'player')
    expect(selectVisibility(map, 'player')).toBe(first)
    expect(selectVisibility(map, 'enemy')).not.toBe(first)
    expect(selectVisibility(map.map((row) => row.slice()), 'player')).not.toBe(first)
  })

  it('reveals a circular radius of eight cells around owned buildings', () => {
    const map = mapWithTerrain()
    map[20][20].object = { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 }
    const visibility = calculateVisibility(map, 'player', true)

    expect(isCellVisible(visibility, { column: 28, row: 20 })).toBe(true)
    expect(isCellVisible(visibility, { column: 29, row: 20 })).toBe(false)
    expect(isCellVisible(visibility, { column: 28, row: 28 })).toBe(false)
  })

  it('extends squad sight from ten to twelve cells on traversable heights', () => {
    const plainMap = mapWithTerrain()
    plainMap[20][20].object = squad('player')
    const plainVisibility = calculateVisibility(plainMap, 'player', true)
    expect(isCellVisible(plainVisibility, { column: 30, row: 20 })).toBe(true)
    expect(isCellVisible(plainVisibility, { column: 31, row: 20 })).toBe(false)

    const hillMap = mapWithTerrain()
    hillMap[20][20] = { ...hillMap[20][20], landform: 'hill', object: squad('player') }
    const hillVisibility = calculateVisibility(hillMap, 'player', true)
    expect(isCellVisible(hillVisibility, { column: 32, row: 20 })).toBe(true)
    expect(isCellVisible(hillVisibility, { column: 33, row: 20 })).toBe(false)
    expect(gameConfig.visibility.elevatedSquadRadius).toBeGreaterThan(gameConfig.visibility.squadRadius)
  })

  it('uses the tower visibility radius and conceals an unseen enemy garrison', () => {
    const map = mapWithTerrain()
    map[20][20].object = { ...building('player', 'tower'), garrison: { archers: 3, health: 3 } }
    const visibility = calculateVisibility(map, 'player', true)
    expect(isCellVisible(visibility, { column: 32, row: 20 })).toBe(true)
    expect(isCellVisible(visibility, { column: 33, row: 20 })).toBe(false)

    map[35][35].object = { ...building('enemy', 'tower'), garrison: { archers: 4, health: 4 } }
    expect(visibleObjectAt(map, visibility, 'player', { column: 35, row: 35 })).toMatchObject({ type: 'building', kind: 'tower' })
    expect(visibleObjectAt(map, visibility, 'player', { column: 35, row: 35 })).not.toHaveProperty('garrison')
  })

  it('conceals only enemy squads and barracks outside sight', () => {
    const map = mapWithTerrain()
    map[4][4].object = { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 }
    map[30][28].object = squad('enemy')
    map[30][29].object = building('enemy', 'barracks')
    map[30][30].object = building('enemy', 'farm')
    const visibility = calculateVisibility(map, 'player', true)

    expect(visibleObjectAt(map, visibility, 'player', { column: 28, row: 30 })).toBeUndefined()
    expect(visibleObjectAt(map, visibility, 'player', { column: 29, row: 30 })).toBeUndefined()
    expect(visibleObjectAt(map, visibility, 'player', { column: 30, row: 30 })).toMatchObject({ type: 'building', kind: 'farm' })
  })

  it('starts battle ambience only for threats near player objects', () => {
    const map = mapWithTerrain()
    map[4][4].object = { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 }
    map[20][20].object = squad('enemy')
    expect(hasNearbyEnemyThreat(map, 'player', gameConfig.audio.combatThreatRadius)).toBe(false)

    map[12][4].object = squad('enemy')
    expect(hasNearbyEnemyThreat(map, 'player', gameConfig.audio.combatThreatRadius)).toBe(true)
  })

  it('reveals an enemy barracks when any footprint cell enters sight', () => {
    const map = mapWithTerrain()
    map[20][20].object = squad('player')
    const barracks = {
      ...building('enemy', 'barracks'),
      footprint: { originColumn: 31, originRow: 19, columns: 2, rows: 2 },
    }
    for (let row = 19; row <= 20; row += 1) {
      for (let column = 31; column <= 32; column += 1) map[row][column].object = barracks
    }
    const visibility = calculateVisibility(map, 'player', true)

    expect(isCellVisible(visibility, { column: 31, row: 19 })).toBe(false)
    expect(isCellVisible(visibility, { column: 31, row: 20 })).toBe(false)
    expect(isCellVisible(visibility, { column: 30, row: 20 })).toBe(true)
    expect(isObjectVisible(map, visibility, 'player', { column: 31, row: 19 })).toBe(false)

    map[20][21].object = squad('player')
    const closerVisibility = calculateVisibility(map, 'player', true)
    expect(isObjectVisible(map, closerVisibility, 'player', { column: 31, row: 19 })).toBe(true)
  })
})
