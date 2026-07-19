import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config/game'
import { marketPrices, troopRules } from '../config/rules'
import type { GameMap, TroopComposition } from './map'
import {
  build,
  createMatch,
  defaultSplit,
  demolish,
  endTurn,
  humanDomain,
  foodDemandFor,
  maxSquadHealth,
  moveOrAttack,
  productionFor,
  recruit,
  setTaxRate,
  splitSquad,
  squadHealth,
  squadSize,
  taxIncomeFor,
  troopTotals,
  trade,
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
  it('keeps troop roles and recruitment prices in the intended order', () => {
    const recruitmentValue = (kind: keyof typeof troopRules) => Object.entries(troopRules[kind].resourceCost).reduce((total, [resource, amount]) => {
      if (!amount) return total
      return total + (resource === 'gold' ? amount : amount * marketPrices[resource as keyof typeof marketPrices].buy)
    }, 0)

    expect(troopRules.archers.damage).toBe(troopRules.militia.damage)
    expect(troopRules.archers.durability).toBe(troopRules.militia.durability)
    expect(troopRules.spearmen.damage).toBeGreaterThan(troopRules.militia.damage)
    expect(troopRules.spearmen.durability).toBeGreaterThan(troopRules.militia.durability)
    expect(troopRules.knights.damage).toBe(troopRules.spearmen.damage)
    expect(troopRules.knights.durability).toBeGreaterThan(troopRules.spearmen.durability * 1.8)
    expect(recruitmentValue('militia')).toBeLessThan(recruitmentValue('spearmen'))
    expect(recruitmentValue('spearmen')).toBeLessThan(recruitmentValue('archers'))
    expect(recruitmentValue('knights')).toBeGreaterThan(recruitmentValue('archers') * 2)
  })

  it('initializes a playable human domain with eight orders', () => {
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
    expect(built.state.ordersRemaining).toBe(4)
    expect(built.state.scenario.cells[2][2].object).toMatchObject({ type: 'building', kind: 'farm' })
    expect([
      built.state.scenario.cells[2][2], built.state.scenario.cells[2][3],
      built.state.scenario.cells[3][2], built.state.scenario.cells[3][3],
    ].every((cell) => cell.object?.type === 'building' && cell.object.kind === 'farm')).toBe(true)
    expect(productionFor(built.state, 'player').grain).toBe(26)
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

  it('validates, removes and destroys a farm as one four-cell building', () => {
    const blockedScenario = createScenario()
    blockedScenario.cells[3][3] = { ...blockedScenario.cells[3][3], object: { type: 'building', kind: 'wall', ownerId: 'player', hitPoints: 50, maxHitPoints: 50 } }
    expect(build(createMatch(blockedScenario), 'farm', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'occupied' })
    expect(build(createMatch(createScenario()), 'farm', { column: 7, row: 7 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })

    const built = build(createMatch(createScenario()), 'farm', { column: 2, row: 2 })
    if (!built.ok) throw new Error('farm building failed')
    const removed = demolish(built.state, { column: 3, row: 3 })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect([removed.state.scenario.cells[2][2], removed.state.scenario.cells[2][3], removed.state.scenario.cells[3][2], removed.state.scenario.cells[3][3]].every((cell) => !cell.object)).toBe(true)

    const cells = built.state.scenario.cells.map((row) => row.map((cell) => ({ ...cell, object: cell.object ? { ...cell.object } : undefined })))
    for (const [column, row] of [[2, 2], [3, 2], [2, 3], [3, 3]]) {
      const object = cells[row][column].object
      if (object?.type === 'building') cells[row][column].object = { ...object, ownerId: 'npc-2', hitPoints: 3 }
    }
    cells[2][1].object = { type: 'squad', ownerId: 'player', units: { militia: 3, spearmen: 0, archers: 0, knights: 0 } }
    const attacked = moveOrAttack({ ...built.state, ordersRemaining: 8, scenario: { ...built.state.scenario, cells } }, { column: 1, row: 2 }, { column: 2, row: 2 })
    expect(attacked.ok).toBe(true)
    if (!attacked.ok) return
    expect(attacked.state.scenario.cells[2][2].object).toMatchObject({ type: 'squad', ownerId: 'player' })
    expect(attacked.state.scenario.cells[2][3].object).toBeUndefined()
    expect(attacked.state.scenario.cells[3][2].object).toBeUndefined()
    expect(attacked.state.scenario.cells[3][3].object).toBeUndefined()
  })

  it('builds a quarry over four hill cells without multiplying its production', () => {
    const scenario = createScenario()
    for (const [column, row] of [[1, 2], [2, 2], [1, 3], [2, 3]]) {
      scenario.cells[row][column] = { ...scenario.cells[row][column], elevation: .65, landform: 'hill' }
    }
    const quarry = build(createMatch(scenario), 'quarry', { column: 1, row: 2 })
    expect(quarry.ok).toBe(true)
    if (!quarry.ok) return
    expect([
      quarry.state.scenario.cells[2][1], quarry.state.scenario.cells[2][2],
      quarry.state.scenario.cells[3][1], quarry.state.scenario.cells[3][2],
    ].every((cell) => cell.object?.type === 'building' && cell.object.kind === 'quarry')).toBe(true)
    expect(productionFor(quarry.state, 'player').stone).toBe(12)
    expect(productionFor(quarry.state, 'player').iron).toBe(2)
  })

  it('recruits into a cell by the castle and spends people and two orders', () => {
    const match = createMatch(createScenario())
    const result = recruit(match, 'militia', 4, { column: 1, row: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ordersRemaining).toBe(6)
    expect(humanDomain(result.state).population).toBe(gameConfig.turn.startingPopulation - 4)
    expect(troopTotals(result.state, 'player').militia).toBe(4)
    expect(recruit(match, 'militia', 1, { column: 4, row: 4 })).toMatchObject({ ok: false, reason: 'requires-barracks' })
  })

  it('uses the full perimeter of a four-cell barracks for recruitment', () => {
    const barracks = build(createMatch(createScenario()), 'barracks', { column: 1, row: 2 })
    expect(barracks.ok).toBe(true)
    if (!barracks.ok) return
    expect([
      barracks.state.scenario.cells[2][1], barracks.state.scenario.cells[2][2],
      barracks.state.scenario.cells[3][1], barracks.state.scenario.cells[3][2],
    ].every((cell) => cell.object?.type === 'building' && cell.object.kind === 'barracks')).toBe(true)
    const recruited = recruit(barracks.state, 'militia', 1, { column: 3, row: 2 })
    expect(recruited.ok).toBe(true)
    if (!recruited.ok) return
    expect(recruited.state.ordersRemaining).toBe(0)
    expect(recruited.state.scenario.cells[2][3].object).toMatchObject({ type: 'squad', units: { militia: 1 } })
  })

  it('charges two orders when a squad containing knights moves', () => {
    const recruited = recruit(createMatch(createScenario()), 'knights', 3, { column: 1, row: 2 })
    expect(recruited.ok).toBe(true)
    if (!recruited.ok) return
    expect(recruited.state.ordersRemaining).toBe(6)
    expect(troopTotals(recruited.state, 'player').knights).toBe(3)
    const moved = moveOrAttack(recruited.state, { column: 1, row: 2 }, { column: 2, row: 2 })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.state.ordersRemaining).toBe(4)
    expect(turnResourceDeltaFor(moved.state, 'player').gold).toBe(-2)
  })

  it('charges church upkeep and applies its population growth bonus', () => {
    const church = build(createMatch(createScenario()), 'church', { column: 2, row: 2 })
    expect(church.ok).toBe(true)
    if (!church.ok) return
    expect([
      church.state.scenario.cells[2][2], church.state.scenario.cells[2][3],
      church.state.scenario.cells[3][2], church.state.scenario.cells[3][3],
    ].every((cell) => cell.object?.type === 'building' && cell.object.kind === 'church')).toBe(true)
    expect(turnResourceDeltaFor(church.state, 'player').gold).toBe(4)
    expect(turnResourceDeltaFor(church.state, 'player').grain).toBe(4)
    const advanced = endTurn(church.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(humanDomain(advanced.state).population).toBe(gameConfig.turn.startingPopulation + 2)
    expect(humanDomain(advanced.state).resources.gold).toBe(49)
  })

  it('moves, splits and merges squads while respecting the ten-unit capacity', () => {
    const recruited = recruit(createMatch(createScenario()), 'militia', 6, { column: 1, row: 2 })
    if (!recruited.ok) throw new Error('recruitment failed')
    const splitUnits = defaultSplit(recruited.state.scenario.cells[2][1].object as Extract<NonNullable<GameMap[number][number]['object']>, { type: 'squad' }>)
    expect(squadSize({ units: splitUnits })).toBe(3)
    const split = splitSquad(recruited.state, { column: 1, row: 2 }, { column: 2, row: 2 }, splitUnits)
    expect(split.ok).toBe(true)
    if (!split.ok) return
    expect(split.state.ordersRemaining).toBe(4)
    const splitHealth = [split.state.scenario.cells[2][1].object, split.state.scenario.cells[2][2].object]
      .reduce((total, object) => total + (object?.type === 'squad' ? squadHealth(object) : 0), 0)
    expect(splitHealth).toBe(6)
    const merged = moveOrAttack(split.state, { column: 2, row: 2 }, { column: 1, row: 2 })
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.state.ordersRemaining).toBe(2)
    expect(troopTotals(merged.state, 'player').militia).toBe(6)
    expect(merged.state.scenario.cells[2][2].object).toBeUndefined()
  })

  it('allows eight consecutive squad steps when all orders are available', () => {
    const scenario = createScenario()
    scenario.cells[0][0] = { ...scenario.cells[0][0], object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } } }
    const route = [
      { column: 0, row: 0 }, { column: 1, row: 0 }, { column: 2, row: 0 }, { column: 3, row: 0 }, { column: 4, row: 0 },
      { column: 4, row: 1 }, { column: 4, row: 2 }, { column: 4, row: 3 }, { column: 4, row: 4 },
    ]
    let state = createMatch(scenario)
    for (let index = 1; index < route.length; index += 1) {
      const moved = moveOrAttack(state, route[index - 1], route[index])
      expect(moved.ok).toBe(true)
      if (!moved.ok) return
      state = moved.state
    }
    expect(state.ordersRemaining).toBe(0)
    expect(state.scenario.cells[4][4].object).toMatchObject({ type: 'squad', ownerId: 'player' })
  })

  it('creates a valid default split for a two-unit mixed squad', () => {
    const split = defaultSplit({ type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 1, archers: 0, knights: 0 } })
    expect(squadSize({ units: split })).toBe(1)
  })

  it('damages and destroys an enemy castle, completing the match', () => {
    const scenario = createScenario()
    const units: TroopComposition = { militia: 3, spearmen: 0, archers: 0, knights: 0 }
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
    scenario.cells[4][4] = { ...scenario.cells[4][4], object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0, knights: 0 } } }
    scenario.cells[4][5] = { ...scenario.cells[4][5], object: { type: 'building', kind: 'wall', ownerId: 'npc-2', hitPoints: 50, maxHitPoints: 50 } }
    const result = moveOrAttack(createMatch(scenario), { column: 4, row: 4 }, { column: 5, row: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.scenario.cells[4][5].object).toMatchObject({ type: 'building', kind: 'wall', hitPoints: 46 })
  })

  it('lets archers attack up to five clear cells away without moving', () => {
    const scenario = createScenario()
    scenario.cells[0][0] = { ...scenario.cells[0][0], object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 5, knights: 0 } } }
    scenario.cells[0][5] = { ...scenario.cells[0][5], object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    const result = moveOrAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 5, row: 0 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ordersRemaining).toBe(7)
    expect(result.state.scenario.cells[0][0].object).toMatchObject({ type: 'squad', ownerId: 'player' })
    expect(result.state.scenario.cells[0][5].object).toMatchObject({ type: 'building', hitPoints: 7 })
  })

  it('accumulates damage and makes knights substantially harder to kill than militia', () => {
    const createDuel = (defender: 'militia' | 'knights') => {
      const scenario = createScenario()
      scenario.cells[0][0] = { ...scenario.cells[0][0], object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 1, knights: 0 } } }
      scenario.cells[0][2] = { ...scenario.cells[0][2], object: { type: 'squad', ownerId: 'npc-2', units: { militia: defender === 'militia' ? 1 : 0, spearmen: 0, archers: 0, knights: defender === 'knights' ? 1 : 0 } } }
      return createMatch(scenario)
    }
    const shoot = (state: ReturnType<typeof createMatch>) => {
      const result = moveOrAttack(state, { column: 0, row: 0 }, { column: 2, row: 0 })
      if (!result.ok) throw new Error(`ranged attack failed: ${result.reason}`)
      return result.state
    }

    let militiaState = createDuel('militia')
    let knightState = createDuel('knights')
    expect(maxSquadHealth(militiaState.scenario.cells[0][2].object as Extract<NonNullable<GameMap[number][number]['object']>, { type: 'squad' }>)).toBe(1)
    expect(maxSquadHealth(knightState.scenario.cells[0][2].object as Extract<NonNullable<GameMap[number][number]['object']>, { type: 'squad' }>)).toBe(2.5)
    for (let shot = 0; shot < 3; shot += 1) {
      militiaState = shoot(militiaState)
      knightState = shoot(knightState)
    }
    expect(militiaState.scenario.cells[0][2].object).toBeUndefined()
    expect(knightState.scenario.cells[0][2].object).toMatchObject({ type: 'squad', units: { knights: 1 } })
    const knight = knightState.scenario.cells[0][2].object
    expect(knight?.type === 'squad' ? squadHealth(knight) : 0).toBeCloseTo(1.3)
  })

  it('blocks ranged attacks through forests and beyond archer range', () => {
    const scenario = createScenario()
    scenario.cells[0][0] = { ...scenario.cells[0][0], object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 5, knights: 0 } } }
    scenario.cells[0][2] = { ...scenario.cells[0][2], vegetation: true }
    scenario.cells[0][5] = { ...scenario.cells[0][5], object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    expect(moveOrAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 5, row: 0 })).toMatchObject({ ok: false, reason: 'ranged-shot-blocked' })
    scenario.cells[0][2] = { ...scenario.cells[0][2], vegetation: false }
    scenario.cells[0][6] = { ...scenario.cells[0][6], object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    expect(moveOrAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 6, row: 0 })).toMatchObject({ ok: false, reason: 'out-of-range' })
  })

  it('scales taxes with population and changes food demand and production', () => {
    const farm = build(createMatch(createScenario()), 'farm', { column: 2, row: 2 })
    if (!farm.ok) throw new Error('building failed')
    const untaxed = setTaxRate(farm.state, 'none')
    const extortionate = setTaxRate(farm.state, 'extortionate')
    if (!untaxed.ok || !extortionate.ok) throw new Error('tax change failed')
    expect(turnResourceDeltaFor(untaxed.state, 'player').gold).toBe(2)
    expect(turnResourceDeltaFor(extortionate.state, 'player').gold).toBe(14)
    const largerPopulation = { ...extortionate.state, domains: { ...extortionate.state.domains, player: { ...extortionate.state.domains.player, population: 20 } } }
    expect(taxIncomeFor(largerPopulation, 'player')).toBe(20)
    expect(foodDemandFor(untaxed.state, 'player')).toBeLessThan(foodDemandFor(extortionate.state, 'player'))
    expect(productionFor(untaxed.state, 'player').grain).toBe(productionFor(farm.state, 'player').grain)
    expect(productionFor(untaxed.state, 'player').grain - productionFor(extortionate.state, 'player').grain).toBe(1)
    expect(turnResourceDeltaFor(untaxed.state, 'player').grain).toBeGreaterThan(turnResourceDeltaFor(extortionate.state, 'player').grain)
  })

  it('charges troop upkeep and allows resource trade through an owned market', () => {
    const recruited = recruit(createMatch(createScenario()), 'spearmen', 4, { column: 1, row: 2 })
    if (!recruited.ok) throw new Error('recruitment failed')
    expect(turnResourceDeltaFor(recruited.state, 'player').gold).toBe(2)
    const market = build(recruited.state, 'market', { column: 2, row: 2 })
    if (!market.ok) throw new Error('market building failed')
    const before = humanDomain(market.state).resources
    const sold = trade(market.state, { column: 2, row: 2 }, 'stone', 'sell', 5)
    expect(sold.ok).toBe(true)
    if (!sold.ok) return
    expect(humanDomain(sold.state).resources.stone).toBe(before.stone - 5)
    expect(humanDomain(sold.state).resources.gold).toBe(before.gold + 10)
    const boughtBack = trade(sold.state, { column: 2, row: 2 }, 'stone', 'buy', 5)
    expect(boughtBack.ok).toBe(true)
    if (!boughtBack.ok) return
    expect(humanDomain(boughtBack.state).resources.stone).toBe(before.stone)
    expect(humanDomain(boughtBack.state).resources.gold).toBe(before.gold - 10)
    expect(trade(recruited.state, { column: 2, row: 2 }, 'wood', 'sell', 1)).toMatchObject({ ok: false, reason: 'requires-market' })
  })

  it('increases food demand as houses allow the civilian population to grow', () => {
    const house = build(createMatch(createScenario()), 'house', { column: 2, row: 2 })
    if (!house.ok) throw new Error('house building failed')
    const initialDemand = foodDemandFor(house.state, 'player')
    let state = house.state
    for (let turn = 0; turn < 6; turn += 1) {
      const advanced = endTurn(state)
      if (!advanced.ok) throw new Error('turn failed')
      state = advanced.state
    }
    expect(humanDomain(state).populationCapacity).toBe(gameConfig.turn.basePopulationCapacity + 10)
    expect(humanDomain(state).population).toBe(gameConfig.turn.startingPopulation + 6)
    expect(foodDemandFor(state, 'player')).toBeGreaterThan(initialDemand)
  })
})
