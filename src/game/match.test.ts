import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config/game'
import type { GameMap, TroopComposition } from './map'
import {
  build,
  createMatch,
  defaultSplit,
  endTurn,
  humanDomain,
  moveOrAttack,
  recruit,
  splitSquad,
  squadSize,
  troopTotals,
  turnResourceDeltaFor,
} from './match'
import type { MapScenario } from './scenario'

function createScenario(): MapScenario {
  const cells: GameMap = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({
    elevation: 0.2,
    landform: 'plain' as const,
    vegetation: false,
  })))
  cells[1][1] = { ...cells[1][1], object: { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 } }
  cells[1][6] = { ...cells[1][6], object: { type: 'castle', ownerId: 'npc-2', hitPoints: 100, maxHitPoints: 100 } }
  return {
    id: 'test',
    name: 'Test',
    seed: 1,
    participantCount: 2,
    cells,
    territories: Array.from({ length: 8 }, () => Array.from({ length: 8 }, (_, column) => column < 4 ? 'region-0' : 'region-1')),
    regions: [
      { id: 'region-0', index: 0, color: '#d2b45f', center: { column: 1, row: 1 }, validCastleCells: [], score: { cells: 32, forest: 0, hills: 0, quality: 32 } },
      { id: 'region-1', index: 1, color: '#6f9c83', center: { column: 6, row: 1 }, validCastleCells: [], score: { cells: 32, forest: 0, hills: 0, quality: 32 } },
    ],
    participants: [
      { id: 'player', kind: 'human', regionId: 'region-0', color: '#d2b45f' },
      { id: 'npc-2', kind: 'npc', regionId: 'region-1', color: '#6f9c83' },
    ],
  }
}

describe('match rules', () => {
  it('initializes a playable human domain with four orders', () => {
    const match = createMatch(createScenario())
    expect(match.turn).toBe(1)
    expect(match.ordersRemaining).toBe(gameConfig.turn.maxOrders)
    expect(humanDomain(match).population).toBe(gameConfig.turn.startingPopulation)
    expect(match.scenario.cells[1][1].object).toMatchObject({ type: 'castle', ownerId: 'player' })
  })

  it('builds only on suitable owned cells and produces resources at turn end', () => {
    const match = createMatch(createScenario())
    const built = build(match, 'farm', { column: 2, row: 2 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.state.ordersRemaining).toBe(2)
    expect(built.state.scenario.cells[2][2].object).toMatchObject({ type: 'building', kind: 'farm' })
    expect(match.scenario.cells[2][2].object).toBeUndefined()

    const advanced = endTurn(built.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.turn).toBe(2)
    expect(advanced.state.ordersRemaining).toBe(gameConfig.turn.maxOrders)
    expect(humanDomain(advanced.state).resources.grain).toBeGreaterThan(humanDomain(built.state).resources.grain)
    expect(advanced.state.domains['npc-2'].resources.gold).toBeGreaterThan(built.state.domains['npc-2'].resources.gold)
    expect(build(match, 'farm', { column: 5, row: 2 })).toMatchObject({ ok: false, reason: 'outside-domain' })
  })

  it('recruits into a cell by the castle and spends people and one order', () => {
    const match = createMatch(createScenario())
    const result = recruit(match, 'militia', 4, { column: 1, row: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ordersRemaining).toBe(3)
    expect(humanDomain(result.state).population).toBe(gameConfig.turn.startingPopulation - 4)
    expect(troopTotals(result.state, 'player').militia).toBe(4)
    expect(recruit(match, 'militia', 1, { column: 4, row: 4 })).toMatchObject({ ok: false, reason: 'requires-barracks' })
  })

  it('charges church upkeep and applies its population growth bonus', () => {
    const church = build(createMatch(createScenario()), 'church', { column: 2, row: 2 })
    expect(church.ok).toBe(true)
    if (!church.ok) return
    expect(turnResourceDeltaFor(church.state, 'player').gold).toBe(6)
    expect(turnResourceDeltaFor(church.state, 'player').grain).toBe(5)
    const advanced = endTurn(church.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(humanDomain(advanced.state).population).toBe(gameConfig.turn.startingPopulation + 2)
    expect(humanDomain(advanced.state).resources.gold).toBe(51)
  })

  it('moves, splits and merges squads while respecting the ten-unit capacity', () => {
    const recruited = recruit(createMatch(createScenario()), 'militia', 6, { column: 1, row: 2 })
    if (!recruited.ok) throw new Error('recruitment failed')
    const splitUnits = defaultSplit(recruited.state.scenario.cells[2][1].object as Extract<NonNullable<GameMap[number][number]['object']>, { type: 'squad' }>)
    expect(squadSize({ units: splitUnits })).toBe(3)
    const split = splitSquad(recruited.state, { column: 1, row: 2 }, { column: 2, row: 2 }, splitUnits)
    expect(split.ok).toBe(true)
    if (!split.ok) return
    const merged = moveOrAttack(split.state, { column: 2, row: 2 }, { column: 1, row: 2 })
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(troopTotals(merged.state, 'player').militia).toBe(6)
    expect(merged.state.scenario.cells[2][2].object).toBeUndefined()
  })

  it('creates a valid default split for a two-unit mixed squad', () => {
    const split = defaultSplit({ type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 1, archers: 0 } })
    expect(squadSize({ units: split })).toBe(1)
  })

  it('damages and destroys an enemy castle, completing the match', () => {
    const scenario = createScenario()
    const units: TroopComposition = { militia: 3, spearmen: 0, archers: 0 }
    scenario.cells[1][5] = { ...scenario.cells[1][5], object: { type: 'squad', ownerId: 'player', units } }
    scenario.cells[1][6] = { ...scenario.cells[1][6], object: { type: 'castle', ownerId: 'npc-2', hitPoints: 3, maxHitPoints: 100 } }
    const result = moveOrAttack(createMatch(scenario), { column: 5, row: 1 }, { column: 6, row: 1 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe('won')
    expect(result.state.scenario.cells[1][5].object).toBeUndefined()
    expect(result.state.scenario.cells[1][6].object).toMatchObject({ type: 'squad', ownerId: 'player' })
  })

  it('reduces ordinary squad damage against walls', () => {
    const scenario = createScenario()
    scenario.cells[4][4] = { ...scenario.cells[4][4], object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0 } } }
    scenario.cells[4][5] = { ...scenario.cells[4][5], object: { type: 'building', kind: 'wall', ownerId: 'npc-2', hitPoints: 50, maxHitPoints: 50 } }
    const result = moveOrAttack(createMatch(scenario), { column: 4, row: 4 }, { column: 5, row: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.scenario.cells[4][5].object).toMatchObject({ type: 'building', kind: 'wall', hitPoints: 46 })
  })
})
