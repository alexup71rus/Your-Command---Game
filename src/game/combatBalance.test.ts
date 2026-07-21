import { describe, expect, it } from 'vitest'
import { combatRules, troopRules } from '../config/rules'
import type { GameMap, SquadObject, TroopComposition, TroopKind } from './map'
import {
  createMatch,
  endTurn,
  moveOrAttack,
  objectAt,
  rangedDamageTakenMultiplierFor,
  squadHealth,
  type MatchState,
} from './match'
import type { CellPosition, MapScenario } from './scenario'

type ArmouredTroop = Extract<TroopKind, 'spearmen' | 'knights'>

function composition(kind: TroopKind, amount: number): TroopComposition {
  return {
    militia: kind === 'militia' ? amount : 0,
    spearmen: kind === 'spearmen' ? amount : 0,
    archers: kind === 'archers' ? amount : 0,
    knights: kind === 'knights' ? amount : 0,
  }
}

function createDuelScenario(archers: number, defenderKind: ArmouredTroop): MapScenario {
  const size = 12
  const cells: GameMap = Array.from({ length: size }, () => Array.from({ length: size }, () => ({
    elevation: 0.2,
    landform: 'plain' as const,
    vegetation: false,
  })))
  cells[0][0].object = { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 }
  cells[0][11].object = { type: 'castle', ownerId: 'npc-2', hitPoints: 100, maxHitPoints: 100 }
  cells[5][1].object = {
    type: 'squad', ownerId: 'player', units: composition('archers', archers),
    health: troopRules.archers.durability * archers,
  }
  cells[5][9].object = {
    type: 'squad', ownerId: 'npc-2', units: composition(defenderKind, 1),
    health: troopRules[defenderKind].durability,
  }
  return {
    id: 'combat-balance', name: 'Combat balance', seed: 1, participantCount: 2, cells,
    territories: Array.from({ length: size }, () => Array.from(
      { length: size }, (_, column) => column < size / 2 ? 'region-0' : 'region-1',
    )),
    regions: [
      {
        id: 'region-0', index: 0, color: '#a33', center: { column: 0, row: 0 }, validCastleCells: [],
        reservedBuildSites: { plain: { column: 0, row: 0 }, hill: { column: 0, row: 0 }, extra: { column: 0, row: 0 }, house: { column: 0, row: 0 } },
        score: { cells: 72, forest: 0, hills: 0, quality: 72 },
      },
      {
        id: 'region-1', index: 1, color: '#33a', center: { column: 11, row: 0 }, validCastleCells: [],
        reservedBuildSites: { plain: { column: 11, row: 0 }, hill: { column: 11, row: 0 }, extra: { column: 11, row: 0 }, house: { column: 11, row: 0 } },
        score: { cells: 72, forest: 0, hills: 0, quality: 72 },
      },
    ],
    participants: [
      { id: 'player', kind: 'human', regionId: 'region-0', color: '#a33' },
      { id: 'npc-2', kind: 'ai', profileId: 'radomir', regionId: 'region-1', color: '#33a' },
    ],
  }
}

function execute(state: MatchState, from: CellPosition, to: CellPosition) {
  const result = moveOrAttack(state, from, to)
  if (!result.ok) throw new Error(`Combat action failed: ${result.reason}`)
  return result.state
}

function advance(state: MatchState) {
  const result = endTurn(state)
  if (!result.ok) throw new Error(`Turn advance failed: ${result.reason}`)
  return result.state
}

function fireVolleys(state: MatchState, amount: number, target: CellPosition) {
  let current = state
  for (let shot = 0; shot < amount; shot += 1) {
    current = execute(current, { column: 1, row: 5 }, target)
  }
  return current
}

function moveKnight(state: MatchState, fromColumn: number, steps: number) {
  let current = state
  let column = fromColumn
  for (let step = 0; step < steps; step += 1) {
    current = execute(current, { column, row: 5 }, { column: column - 1, row: 5 })
    column -= 1
  }
  return { state: current, column }
}

describe('ranged combat balance', () => {
  it('charges two orders per field volley and lets one spearman reach one archer from maximum range', () => {
    let state = createMatch(createDuelScenario(1, 'spearmen'))
    state = fireVolleys(state, 4, { column: 9, row: 5 })

    expect(state.ordersRemaining).toBe(0)
    const woundedSpearman = objectAt(state, { column: 9, row: 5 })
    expect(woundedSpearman?.type === 'squad' ? squadHealth(woundedSpearman) : 0).toBeCloseTo(0.39)

    state = advance(state)
    for (let column = 9; column > 2; column -= 1) {
      state = execute(state, { column, row: 5 }, { column: column - 1, row: 5 })
    }
    state = execute(state, { column: 2, row: 5 }, { column: 1, row: 5 })

    const spearman = objectAt(state, { column: 2, row: 5 })
    const archer = objectAt(state, { column: 1, row: 5 })
    expect(spearman?.type === 'squad' ? squadHealth(spearman) : 0).toBeGreaterThan(0)
    expect(archer?.type === 'squad' ? squadHealth(archer) : 1).toBeLessThan(troopRules.archers.durability)
  })

  it('lets a knight cross four-archer fire and make a melee attack', () => {
    let state = createMatch(createDuelScenario(4, 'knights'))
    state = fireVolleys(state, 4, { column: 9, row: 5 })
    state = advance(state)
    state = moveKnight(state, 9, 4).state
    state = advance(state)
    state = fireVolleys(state, 4, { column: 5, row: 5 })

    const exposedKnight = objectAt(state, { column: 5, row: 5 })
    expect(exposedKnight?.type === 'squad' ? squadHealth(exposedKnight) : 0).toBeCloseTo(0.196)

    state = advance(state)
    const approach = moveKnight(state, 5, 3)
    state = execute(approach.state, { column: approach.column, row: 5 }, { column: 1, row: 5 })

    const archers = objectAt(state, { column: 1, row: 5 })
    expect(archers?.type === 'squad' ? squadHealth(archers) : 4).toBeLessThan(4)
    expect(state.lastEvent).toMatchObject({ kind: 'attacked', position: { column: 1, row: 5 } })
  })

  it('lets five archers stop a knight before it reaches melee', () => {
    let state = createMatch(createDuelScenario(5, 'knights'))
    state = fireVolleys(state, 4, { column: 9, row: 5 })
    state = advance(state)
    state = moveKnight(state, 9, 4).state
    state = advance(state)
    state = fireVolleys(state, 3, { column: 5, row: 5 })

    expect(objectAt(state, { column: 5, row: 5 })).toBeUndefined()
    const archers = objectAt(state, { column: 1, row: 5 })
    expect(archers?.type === 'squad' ? squadHealth(archers) : 0).toBe(5)
  })

  it('weights ranged protection by troop count so one knight cannot armour nine archers', () => {
    const mixed: SquadObject = {
      type: 'squad', ownerId: 'player',
      units: { militia: 0, spearmen: 0, archers: 9, knights: 1 },
    }
    expect(rangedDamageTakenMultiplierFor(mixed)).toBeCloseTo(0.918)
    expect(rangedDamageTakenMultiplierFor({ units: composition('knights', 10) })).toBe(0.18)
    expect(combatRules.ranged.orderCost).toBe(2)
  })
})
