import { describe, expect, it } from 'vitest'
import { createManualHeightGrid, generateMap } from './generator'
import {
  createMapScenario,
  evaluateRegionResourceBalance,
  foundMatch,
  isCastleSiteValid,
  isRegionBalanceAcceptable,
  type RegionScore,
  type RegionResourceBalance,
  type TerritoryMap,
} from './scenario'
import { mapPresets } from './presets'

function reachableCells(territories: TerritoryMap, regionId: string, start: { column: number; row: number }) {
  const visited = new Set<string>()
  const queue = [start]
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    const key = `${current.column}:${current.row}`
    if (visited.has(key) || territories[current.row]?.[current.column] !== regionId) continue
    visited.add(key)
    directions.forEach(([dx, dy]) => queue.push({ column: current.column + dx, row: current.row + dy }))
  }
  return visited.size
}

const withNeutralShape = (balance: RegionResourceBalance) => ({ ...balance, centerOffset: 0, perimeterRatio: 0 })

describe('starting domains', () => {
  const defaultPreset = mapPresets[0]
  const map = generateMap(defaultPreset.settings, createManualHeightGrid())

  it.each([2, 3, 4])('creates %i connected regions with castle sites', (participantCount) => {
    const result = createMapScenario(map, participantCount, defaultPreset.settings.seed)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.scenario.regions).toHaveLength(participantCount)
    result.scenario.regions.forEach((region) => {
      expect(region.validCastleCells.length).toBeGreaterThan(0)
      expect(reachableCells(result.scenario.territories, region.id, region.center)).toBe(region.score.cells)
      expect(isCastleSiteValid(result.scenario, region.id, region.validCastleCells[0])).toBe(true)
    })
  })

  it('is deterministic and keeps terrain separate from territories', () => {
    const first = createMapScenario(map, 4, defaultPreset.settings.seed)
    const second = createMapScenario(map, 4, defaultPreset.settings.seed)
    expect(second).toEqual(first)
    if (!first.ok) return
    expect(first.scenario.cells).toBe(map)
    expect(first.scenario.cells.flat().every((cell) => !('ownerId' in cell))).toBe(true)
  })

  it('places one castle for the human and one for every NPC', () => {
    const result = createMapScenario(map, 3, defaultPreset.settings.seed)
    if (!result.ok) throw new Error('Expected a valid scenario')
    const humanRegion = result.scenario.regions[1]
    const founded = foundMatch(result.scenario, humanRegion.id, humanRegion.validCastleCells[0])
    const castles = founded.cells.flat().filter((cell) => cell.object?.type === 'castle')
    expect(castles).toHaveLength(3)
    expect(founded.participants.filter((participant) => participant.kind === 'human')).toHaveLength(1)
    expect(founded.participants.filter((participant) => participant.kind === 'npc')).toHaveLength(2)
    expect(new Set(founded.participants.map((participant) => participant.regionId)).size).toBe(3)
  })

  it('rejects peaks, forests, occupied cells and cells near a border', () => {
    const result = createMapScenario(map, 2, defaultPreset.settings.seed)
    if (!result.ok) throw new Error('Expected a valid scenario')
    const region = result.scenario.regions[0]
    const borderCell = result.scenario.territories.flatMap((row, rowIndex) => row.map((id, column) => ({ id, column, row: rowIndex }))).find(({ id, column, row }) => (
      id === region.id && result.scenario.territories[row]?.[column - 1] !== region.id
    ))
    expect(borderCell).toBeDefined()
    expect(isCastleSiteValid(result.scenario, region.id, borderCell!)).toBe(false)

    const site = region.validCastleCells[0]
    const withCell = (patch: Partial<(typeof result.scenario.cells)[number][number]>) => {
      const cells = result.scenario.cells.map((row) => [...row])
      cells[site.row][site.column] = { ...cells[site.row][site.column], ...patch }
      return { cells, territories: result.scenario.territories }
    }
    expect(isCastleSiteValid(withCell({ landform: 'peak' }), region.id, site)).toBe(false)
    expect(isCastleSiteValid(withCell({ vegetation: true }), region.id, site)).toBe(false)
    expect(isCastleSiteValid(withCell({ object: { type: 'castle', ownerId: 'someone', hitPoints: 100, maxHitPoints: 100 } }), region.id, site)).toBe(false)
  })

  it('evaluates area, terrain density and zero-resource regions without NaN', () => {
    const balanced: RegionScore[] = [
      { cells: 100, forest: 0, hills: 0, quality: 100 },
      { cells: 100, forest: 0, hills: 0, quality: 100 },
    ]
    const uneven: RegionScore[] = [
      { cells: 100, forest: 90, hills: 80, quality: 139.6 },
      { cells: 55, forest: 0, hills: 0, quality: 55 },
    ]
    const balancedResult = evaluateRegionResourceBalance(balanced)
    expect(Number.isFinite(balancedResult.score)).toBe(true)
    expect(balancedResult.forestCoverageSpread).toBe(0)
    expect(balancedResult.hillCoverageSpread).toBe(0)
    expect(isRegionBalanceAcceptable(withNeutralShape(balancedResult))).toBe(true)
    expect(isRegionBalanceAcceptable(withNeutralShape(evaluateRegionResourceBalance(uneven)))).toBe(false)
  })

  it.each([
    ['area', [{ cells: 100, forest: 0, hills: 0, quality: 100 }, { cells: 70, forest: 0, hills: 0, quality: 100 }]],
    ['quality', [{ cells: 100, forest: 0, hills: 0, quality: 100 }, { cells: 100, forest: 0, hills: 0, quality: 125 }]],
    ['forest density', [{ cells: 100, forest: 80, hills: 0, quality: 100 }, { cells: 100, forest: 0, hills: 0, quality: 100 }]],
    ['hill density', [{ cells: 100, forest: 0, hills: 80, quality: 100 }, { cells: 100, forest: 0, hills: 0, quality: 100 }]],
  ] as Array<[string, RegionScore[]]>)('rejects an isolated %s imbalance', (_name, scores) => {
    expect(isRegionBalanceAcceptable(withNeutralShape(evaluateRegionResourceBalance(scores)))).toBe(false)
  })

  it.each([
    ['center offset', { centerOffset: 0.59, perimeterRatio: 1 }],
    ['perimeter', { centerOffset: 0.1, perimeterRatio: 8.1 }],
  ])('rejects excessive %s even with balanced resources', (_name, shape) => {
    const resources = evaluateRegionResourceBalance([
      { cells: 100, forest: 20, hills: 20, quality: 124 },
      { cells: 101, forest: 20, hills: 20, quality: 125 },
    ])
    expect(isRegionBalanceAcceptable({ ...resources, ...shape })).toBe(false)
  })

  it('rejects a deliberately lopsided map instead of approving an unfair split', () => {
    const rows = 70
    const columns = 100
    const lopsidedMap = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
      const inLargeRoom = column >= 4 && column <= 63 && row >= 5 && row <= 64
      const inSmallRoom = column >= 80 && column <= 94 && row >= 25 && row <= 44
      const inCorridor = row >= 33 && row <= 36 && column > 63 && column < 80
      const passable = inLargeRoom || inSmallRoom || inCorridor
      const isStart = (column === 25 && row === 35) || (column === 87 && row === 35)
      return passable
        ? { elevation: 0.2, landform: 'plain' as const, vegetation: !isStart }
        : { elevation: 0.95, landform: 'peak' as const, vegetation: false }
    }))
    const result = createMapScenario(lopsidedMap, 2, 4812)
    expect(result).toMatchObject({ ok: false, reason: 'unbalanced-regions' })
  })

  it('reports missing castle sites before balance problems', () => {
    const occupiedMap = Array.from({ length: 40 }, () => Array.from({ length: 60 }, () => ({
      elevation: 0.2,
      landform: 'plain' as const,
      vegetation: false,
      object: { type: 'castle' as const, ownerId: 'blocked', hitPoints: 100, maxHitPoints: 100 },
    })))
    expect(createMapScenario(occupiedMap, 2, 9127)).toMatchObject({ ok: false, reason: 'no-castle-sites' })
  })

  it.each(mapPresets.flatMap((preset) => [2, 3, 4].map((count) => ({ preset, count }))))(
    'supports $count participants on $preset.id',
    ({ preset, count }) => {
      const presetMap = generateMap(preset.settings, createManualHeightGrid())
      const result = createMapScenario(presetMap, count, preset.settings.seed)
      expect(result.ok).toBe(true)
      if (!result.ok) return
    },
  )

  it.each([50, 150])('supports a generated square map with %i cells per side', (mapSize) => {
    const sizedMap = generateMap({ ...defaultPreset.settings, mapSize }, createManualHeightGrid())
    const result = createMapScenario(sizedMap, 4, defaultPreset.settings.seed)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scenario.cells).toHaveLength(mapSize)
  })
})
