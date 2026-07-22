import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config/game'
import { buildingRules, castleProduction, marketPrices, startingResources } from '../config/rules'
import type { GameMap } from './map'
import {
  build,
  buildingResourceCostFor,
  civilianHousingCapacityFor,
  civilianPopulationCapacityFor,
  createMatch,
  defaultSplit,
  demolitionRefundFor,
  demolish,
  endTurn,
  foodServiceCapacityFor,
  humanDomain,
  moveOrAttack,
  processingFor,
  productionFor,
  recruit,
  splitSquad,
  squadHealth,
  squadSize,
  trade,
  tradeQuoteFor,
  troopTotals,
  turnResourceDeltaFor,
  upkeepFor,
  workforceFor,
} from './match'
import { advanceRound, createScenario, placeBuilding, removePlayerCastle } from './matchTestFixtures'

describe('match economy and movement rules', () => {
  it('initializes a playable human domain with eight orders', () => {
    const match = createMatch(createScenario())
    expect(match.turn).toBe(1)
    expect(match.ordersRemaining).toBe(gameConfig.turn.maxOrders)
    expect(humanDomain(match).population).toBe(gameConfig.turn.startingPopulation)
    expect(humanDomain(match).population).toBe(5)
    expect(civilianPopulationCapacityFor(match, 'player')).toBe(5)
    expect(humanDomain(match).resources).toEqual(startingResources)
    expect(match.scenario.cells[1][1].object).toMatchObject({ type: 'castle', ownerId: 'player' })
  })

  it('survives four complete moderate-tax turns without a food building and starves on the fifth', () => {
    let state = createMatch(createScenario())
    for (let turn = 0; turn < 4; turn += 1) {
      const advanced = advanceRound(state)
      if (!advanced.ok) throw new Error('turn failed')
      expect(advanced.state.lastTurnReports.player.food.fed).toBe(true)
      state = advanced.state
    }
    expect(state.domains.player.resources.flour + state.domains.player.resources.meat + state.domains.player.resources.fruit).toBe(2)
    const fifth = advanceRound(state)
    if (!fifth.ok) throw new Error('turn failed')
    expect(fifth.state.lastTurnReports.player.food.fed).toBe(false)
    expect(fifth.state.domains.player.population).toBe(gameConfig.turn.startingPopulation - 1)
  })

  it('builds only on suitable owned cells and produces resources at turn end', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'mill', 1, 4)
    const match = createMatch(scenario)
    const built = build(match, 'farm', { column: 2, row: 2 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.state.ordersRemaining).toBe(4)
    expect(built.state.scenario.cells[2][2].object).toMatchObject({ type: 'building', kind: 'farm' })
    expect(
      [
        built.state.scenario.cells[2][2],
        built.state.scenario.cells[2][3],
        built.state.scenario.cells[3][2],
        built.state.scenario.cells[3][3],
      ].every((cell) => cell.object?.type === 'building' && cell.object.kind === 'farm'),
    ).toBe(true)
    expect(productionFor(built.state, 'player').flour).toBe(17)
    expect(productionFor(built.state, 'player').meat).toBe(0)
    expect(match.scenario.cells[2][2].object).toBeUndefined()

    const advanced = advanceRound(built.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.turn).toBe(2)
    expect(advanced.state.ordersRemaining).toBe(gameConfig.turn.maxOrders)
    expect(humanDomain(advanced.state).resources.flour).toBeGreaterThan(humanDomain(built.state).resources.flour)
    expect(advanced.state.domains['npc-2'].resources.gold).toBeGreaterThan(built.state.domains['npc-2'].resources.gold)
    expect(build(match, 'farm', { column: 5, row: 2 })).toMatchObject({ ok: false, reason: 'outside-domain' })
  })

  it('validates, removes and destroys a farm as one four-cell building', () => {
    const blockedScenario = createScenario()
    blockedScenario.cells[3][3] = {
      ...blockedScenario.cells[3][3],
      object: { type: 'building', kind: 'wall', ownerId: 'player', hitPoints: 50, maxHitPoints: 50 },
    }
    placeBuilding(blockedScenario, 'mill', 1, 4)
    expect(build(createMatch(blockedScenario), 'farm', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'occupied' })
    expect(build(createMatch(createScenario()), 'farm', { column: 7, row: 7 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })

    const supportedScenario = createScenario()
    placeBuilding(supportedScenario, 'mill', 1, 4)
    const built = build(createMatch(supportedScenario), 'farm', { column: 2, row: 2 })
    if (!built.ok) throw new Error('farm building failed')
    const removed = demolish(built.state, { column: 3, row: 3 })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(
      [
        removed.state.scenario.cells[2][2],
        removed.state.scenario.cells[2][3],
        removed.state.scenario.cells[3][2],
        removed.state.scenario.cells[3][3],
      ].every((cell) => !cell.object),
    ).toBe(true)

    const cells = built.state.scenario.cells.map((row) =>
      row.map((cell) => ({ ...cell, object: cell.object ? { ...cell.object } : undefined })),
    )
    for (const [column, row] of [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
    ]) {
      const object = cells[row][column].object
      if (object?.type === 'building') cells[row][column].object = { ...object, ownerId: 'npc-2', hitPoints: 3 }
    }
    cells[2][1].object = { type: 'squad', ownerId: 'player', units: { militia: 3, spearmen: 0, archers: 0, knights: 0 } }
    const attacked = moveOrAttack(
      { ...built.state, ordersRemaining: 8, scenario: { ...built.state.scenario, cells } },
      { column: 1, row: 2 },
      { column: 2, row: 2 },
    )
    expect(attacked.ok).toBe(true)
    if (!attacked.ok) return
    expect(attacked.state.scenario.cells[2][2].object).toMatchObject({ type: 'squad', ownerId: 'player' })
    expect(attacked.state.scenario.cells[2][3].object).toBeUndefined()
    expect(attacked.state.scenario.cells[3][2].object).toBeUndefined()
    expect(attacked.state.scenario.cells[3][3].object).toBeUndefined()
  })

  it('builds a quarry over four hill cells and produces only stone once', () => {
    const scenario = createScenario()
    for (const [column, row] of [
      [1, 2],
      [2, 2],
      [1, 3],
      [2, 3],
    ]) {
      scenario.cells[row][column] = { ...scenario.cells[row][column], elevation: 0.65, landform: 'hill' }
    }
    const quarry = build(createMatch(scenario), 'quarry', { column: 1, row: 2 })
    expect(quarry.ok).toBe(true)
    if (!quarry.ok) return
    expect(
      [
        quarry.state.scenario.cells[2][1],
        quarry.state.scenario.cells[2][2],
        quarry.state.scenario.cells[3][1],
        quarry.state.scenario.cells[3][2],
      ].every((cell) => cell.object?.type === 'building' && cell.object.kind === 'quarry'),
    ).toBe(true)
    expect(productionFor(quarry.state, 'player').stone).toBe(7)
    expect(productionFor(quarry.state, 'player').iron).toBe(0)
  })

  it('builds a compact mine on a clear hill and produces ore', () => {
    const scenario = createScenario()
    scenario.cells[2][2] = { ...scenario.cells[2][2], elevation: 0.65, landform: 'hill' }
    const mine = build(createMatch(scenario), 'mine', { column: 2, row: 2 })
    expect(mine.ok).toBe(true)
    if (!mine.ok) return
    expect(mine.state.scenario.cells[2][2].object).toMatchObject({ type: 'building', kind: 'mine' })
    expect(mine.state.scenario.cells[2][3].object).toBeUndefined()
    expect(productionFor(mine.state, 'player').ore).toBe(3)
    expect(productionFor(mine.state, 'player').iron).toBe(0)
    expect(productionFor(mine.state, 'player').stone).toBe(0)
    expect(build(createMatch(createScenario()), 'mine', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })
  })

  it('processes at most five ore per staffed smelter without upkeep', () => {
    const built = build(createMatch(createScenario()), 'smelter', { column: 1, row: 3 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(
      [
        built.state.scenario.cells[3][1],
        built.state.scenario.cells[3][2],
        built.state.scenario.cells[4][1],
        built.state.scenario.cells[4][2],
      ].every((cell) => cell.object?.type === 'building' && cell.object.kind === 'smelter'),
    ).toBe(true)

    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'mine', 0, 2)
    placeBuilding(scenario, 'smelter', 1, 3)
    const match = createMatch(scenario)
    const player = {
      ...match.domains.player,
      taxRate: 'none' as const,
      resources: { ...match.domains.player.resources, ore: 4, iron: 0, gold: 2 },
    }
    const advanced = endTurn({ ...match, domains: { ...match.domains, player } })
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.domains.player.resources).toMatchObject({ ore: 3, iron: 5, gold: 2 })
    expect(upkeepFor(match, 'player').gold).toBe(0)
  })

  it('reduces smelting throughput under moderate taxes and receives taxes before processing', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'smelter', 1, 3)
    const match = createMatch(scenario)
    const player = { ...match.domains.player, resources: { ...match.domains.player.resources, ore: 5, iron: 0, gold: 0 } }
    const available = { ...player.resources, ore: 5, iron: 0 }
    expect(
      processingFor({ ...match, domains: { ...match.domains, player: { ...player, taxRate: 'none' } } }, 'player', available).iron,
    ).toBe(5)
    expect(
      processingFor({ ...match, domains: { ...match.domains, player: { ...player, taxRate: 'moderate' } } }, 'player', available).iron,
    ).toBe(4)
    expect(
      processingFor({ ...match, domains: { ...match.domains, player: { ...player, taxRate: 'extortionate' } } }, 'player', available).iron,
    ).toBe(2)
    const advanced = endTurn({ ...match, domains: { ...match.domains, player } })
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.domains.player.resources).toMatchObject({ ore: 1, iron: 4, gold: 5 })
  })

  it('keeps the ore-to-iron market loop at a limited five-gold margin', () => {
    expect(marketPrices.ore).toEqual({ buy: 5, sell: 3 })
    expect(marketPrices.iron).toEqual({ buy: 10, sell: 6 })
    expect(marketPrices.iron.buy).toBe(Math.max(...Object.values(marketPrices).map(({ buy }) => buy)))
    const scenario = createScenario()
    placeBuilding(scenario, 'smelter', 0, 3)
    placeBuilding(scenario, 'market', 3, 3)
    const match = createMatch(scenario)
    const player = {
      ...match.domains.player,
      taxRate: 'none' as const,
      resources: { ...match.domains.player.resources, ore: 0, iron: 0, gold: 25 },
    }
    const bought = trade({ ...match, domains: { ...match.domains, player } }, { column: 3, row: 3 }, 'ore', 'buy', 5)
    expect(bought.ok).toBe(true)
    if (!bought.ok) return
    const advanced = advanceRound(bought.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.domains.player.resources).toMatchObject({ ore: 0, iron: 5, gold: castleProduction.gold })
    const sold = trade(advanced.state, { column: 3, row: 3 }, 'iron', 'sell', 5)
    expect(sold.ok).toBe(true)
    if (!sold.ok) return
    expect(sold.state.domains.player.resources.gold - (castleProduction.gold ?? 0)).toBe(30)
  })

  it('quotes every market unit, tracks domain activity and resets prices after a turn', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'market', 2, 2)
    const match = createMatch(scenario)
    expect(tradeQuoteFor(humanDomain(match), 'wood', 'sell', 10)).toMatchObject({ total: 10, currentUnitPrice: 1, nextUnitPrice: 0 })
    expect(tradeQuoteFor(humanDomain(match), 'stone', 'sell', 10).total).toBe(15)
    expect(tradeQuoteFor(humanDomain(match), 'ore', 'buy', 10).total).toBe(55)
    expect(tradeQuoteFor(humanDomain(match), 'iron', 'sell', 10).total).toBe(55)
    const firstSale = trade(match, { column: 2, row: 2 }, 'wood', 'sell', 10)
    if (!firstSale.ok) throw new Error('market sale failed')
    expect(trade(firstSale.state, { column: 2, row: 2 }, 'wood', 'sell', 1)).toMatchObject({ ok: false, reason: 'market-exhausted' })
    const advanced = endTurn(firstSale.state)
    if (!advanced.ok) throw new Error('turn failed')
    expect(tradeQuoteFor(humanDomain(advanced.state), 'wood', 'sell', 10).total).toBe(10)
    expect(trade(match, { column: 2, row: 2 }, 'ore', 'buy', Number.MAX_SAFE_INTEGER + 1)).toMatchObject({
      ok: false,
      reason: 'invalid-trade',
    })
  })

  it('builds a lumber mill on clear passable ground beside a forest', () => {
    expect(buildingRules.lumberMill.footprint).toBeUndefined()
    expect(buildingRules.lumberMill.resourceCost).toEqual({ wood: 14 })
    expect(buildingRules.lumberMill.production).toEqual({ wood: 10 })
    const scenario = createScenario()
    scenario.cells[2][3] = { ...scenario.cells[2][3], vegetation: true }
    const lumberMill = build(createMatch(scenario), 'lumberMill', { column: 2, row: 2 })
    expect(lumberMill.ok).toBe(true)
    if (!lumberMill.ok) return
    expect(lumberMill.state.scenario.cells[2][2]).toMatchObject({ vegetation: false, object: { type: 'building', kind: 'lumberMill' } })
    expect(lumberMill.state.scenario.cells[2][3].object).toBeUndefined()
    expect(lumberMill.state.ordersRemaining).toBe(4)
    expect(productionFor(lumberMill.state, 'player').wood).toBe(9)
    expect(build(createMatch(scenario), 'lumberMill', { column: 3, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })
    expect(build(createMatch(createScenario()), 'lumberMill', { column: 2, row: 2 })).toMatchObject({
      ok: false,
      reason: 'invalid-terrain',
    })

    const diagonalForest = createScenario()
    diagonalForest.cells[3][3] = { ...diagonalForest.cells[3][3], vegetation: true }
    expect(build(createMatch(diagonalForest), 'lumberMill', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })

    const occupiedSite = createScenario()
    occupiedSite.cells[2][3] = { ...occupiedSite.cells[2][3], vegetation: true }
    occupiedSite.cells[2][2] = {
      ...occupiedSite.cells[2][2],
      object: { type: 'building', kind: 'wall', ownerId: 'player', hitPoints: 50, maxHitPoints: 50 },
    }
    expect(build(createMatch(occupiedSite), 'lumberMill', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'occupied' })
  })

  it('provides a free emergency lumber mill without creating demolition resources', () => {
    const scenario = createScenario()
    scenario.cells[2][3] = { ...scenario.cells[2][3], vegetation: true }
    const match = createMatch(scenario)
    match.domains.player.resources.wood = 0
    expect(buildingResourceCostFor(match, 'player', 'lumberMill')).toEqual({})
    const built = build(match, 'lumberMill', { column: 2, row: 2 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.state.domains.player.resources.wood).toBe(0)
    expect(built.state.scenario.cells[2][2].object).toMatchObject({ type: 'building', constructionCost: {} })
    const removed = demolish({ ...built.state, ordersRemaining: 8 }, { column: 2, row: 2 })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.state.domains.player.resources.wood).toBe(0)
  })

  it('refunds half the paid construction cost only on voluntary demolition', () => {
    const match = createMatch(createScenario())
    const built = build(match, 'orchard', { column: 2, row: 2 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.state.domains.player.resources.wood).toBe(startingResources.wood - 20)
    expect(built.state.domains.player.resources.gold).toBe(startingResources.gold - 6)
    expect(demolitionRefundFor(built.state.scenario.cells[2][2].object)).toEqual({ wood: 10, gold: 3 })
    const removed = demolish({ ...built.state, ordersRemaining: 8 }, { column: 2, row: 2 })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.state.domains.player.resources.wood).toBe(startingResources.wood - 10)
    expect(removed.state.domains.player.resources.gold).toBe(startingResources.gold - 3)
  })

  it('allows only one gold-funded market per domain', () => {
    const first = build(createMatch(createScenario()), 'market', { column: 2, row: 2 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.state.domains.player.resources.gold).toBe(startingResources.gold - 28)
    expect(build({ ...first.state, ordersRemaining: 8 }, 'market', { column: 3, row: 3 })).toMatchObject({
      ok: false,
      reason: 'building-limit',
    })
    const removed = demolish({ ...first.state, ordersRemaining: 8 }, { column: 2, row: 2 })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.state.domains.player.resources.gold).toBe(startingResources.gold - 14)
    expect(build({ ...removed.state, ordersRemaining: 8 }, 'market', { column: 3, row: 3 }).ok).toBe(true)
  })

  it('scales farm production for two, one and zero assigned workers', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'mill', 1, 4)
    const farm = build(createMatch(scenario), 'farm', { column: 2, row: 2 })
    if (!farm.ok) throw new Error('farm building failed')
    expect(productionFor(farm.state, 'player')).toMatchObject({ flour: 13, meat: 0 })
    const oneFarmWorker = { ...farm.state, domains: { ...farm.state.domains, player: { ...farm.state.domains.player, population: 2 } } }
    const noWorkers = { ...farm.state, domains: { ...farm.state.domains, player: { ...farm.state.domains.player, population: 0 } } }
    expect(productionFor(oneFarmWorker, 'player').flour).toBe(6)
    expect(productionFor(noWorkers, 'player').flour).toBe(0)
  })

  it('requires a useful mill, supports only two nearby farms and stops farms with an unstaffed mill', () => {
    const scenario = createScenario()
    for (let row = 4; row < 8; row += 1)
      for (let column = 0; column < 4; column += 1) scenario.cells[row][column] = { ...scenario.cells[row][column], vegetation: true }
    scenario.cells[6][0] = { ...scenario.cells[6][0], vegetation: false }
    const state = createMatch(scenario)
    expect(build(state, 'mill', { column: 0, row: 6 })).toMatchObject({ ok: false, reason: 'requires-farm-site' })
    const supportedScenario = createScenario()
    removePlayerCastle(supportedScenario)
    const mill = build(createMatch(supportedScenario), 'mill', { column: 1, row: 2 })
    if (!mill.ok) throw new Error('mill building failed')
    expect(workforceFor(mill.state, 'player').assignments).toMatchObject([{ kind: 'mill', assigned: 0, blockedReason: 'idle-support' }])
    const first = build({ ...mill.state, ordersRemaining: 8 }, 'farm', { column: 0, row: 0 })
    if (!first.ok) throw new Error('first farm failed')
    const second = build({ ...first.state, ordersRemaining: 8 }, 'farm', { column: 0, row: 3 })
    if (!second.ok) throw new Error('second farm failed')
    expect(build({ ...second.state, ordersRemaining: 8 }, 'farm', { column: 2, row: 3 })).toMatchObject({
      ok: false,
      reason: 'requires-support',
    })
    const unstaffed = { ...second.state, domains: { ...second.state.domains, player: { ...second.state.domains.player, population: 0 } } }
    expect(productionFor(unstaffed, 'player').flour).toBe(0)
    const removedMill = demolish(second.state, { column: 1, row: 2 })
    if (!removedMill.ok) throw new Error('mill demolition failed')
    expect(productionFor(removedMill.state, 'player').flour).toBe(0)
    expect(
      workforceFor(removedMill.state, 'player').assignments.every((assignment) => assignment.blockedReason === 'missing-support'),
    ).toBe(true)

    const fullScenario = createScenario()
    removePlayerCastle(fullScenario)
    placeBuilding(fullScenario, 'mill', 1, 2)
    placeBuilding(fullScenario, 'farm', 0, 3)
    placeBuilding(fullScenario, 'farm', 2, 3)
    expect(build(createMatch(fullScenario), 'farm', { column: 0, row: 0 })).toMatchObject({ ok: false, reason: 'requires-support' })
  })

  it('builds and staffs a hunting lodge only beside at least two forest cells', () => {
    const scenario = createScenario()
    scenario.cells[2][1] = { ...scenario.cells[2][1], vegetation: true }
    scenario.cells[2][3] = { ...scenario.cells[2][3], vegetation: true }
    const lodge = build(createMatch(scenario), 'huntingLodge', { column: 2, row: 2 })
    expect(lodge.ok).toBe(true)
    if (!lodge.ok) return
    expect(lodge.state.scenario.cells[2][2]).toMatchObject({
      vegetation: false,
      object: { type: 'building', kind: 'huntingLodge', hitPoints: 12 },
    })
    expect(lodge.state.ordersRemaining).toBe(4)
    expect(productionFor(lodge.state, 'player').meat).toBe(5)
    expect(upkeepFor(lodge.state, 'player').meat).toBe(0)
    const meatBeforeTurn = humanDomain(lodge.state).resources.meat
    const advanced = endTurn(lodge.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(humanDomain(advanced.state).resources.meat).toBe(meatBeforeTurn + 2)
    const noWorker = { ...lodge.state, domains: { ...lodge.state.domains, player: { ...lodge.state.domains.player, population: 0 } } }
    expect(productionFor(noWorker, 'player').meat).toBe(0)

    const oneForest = createScenario()
    oneForest.cells[2][1] = { ...oneForest.cells[2][1], vegetation: true }
    expect(build(createMatch(oneForest), 'huntingLodge', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })
    scenario.cells[2][2] = { ...scenario.cells[2][2], vegetation: true }
    expect(build(createMatch(scenario), 'huntingLodge', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })
  })

  it('assigns workers by the configured deterministic priority', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'mill', 1, 2)
    placeBuilding(scenario, 'farm', 2, 3)
    placeBuilding(scenario, 'farm', 0, 3)
    placeBuilding(scenario, 'huntingLodge', 4, 3)
    const match = createMatch(scenario)
    const fourPeople = { ...match, domains: { ...match.domains, player: { ...match.domains.player, population: 4 } } }
    expect(workforceFor(fourPeople, 'player')).toMatchObject({
      employed: 4,
      free: 0,
      assignments: [
        { kind: 'mill', position: { column: 1, row: 2 }, assigned: 1, required: 1 },
        { kind: 'huntingLodge', position: { column: 4, row: 3 }, assigned: 1, required: 1 },
        { kind: 'farm', position: { column: 0, row: 3 }, assigned: 2, required: 2 },
        { kind: 'farm', position: { column: 2, row: 3 }, assigned: 0, required: 2 },
      ],
    })
    const threePeople = { ...match, domains: { ...match.domains, player: { ...match.domains.player, population: 3 } } }
    expect(workforceFor(threePeople, 'player').assignments.map(({ assigned }) => assigned)).toEqual([1, 1, 1, 0])
    const sixPeople = { ...match, domains: { ...match.domains, player: { ...match.domains.player, population: 6 } } }
    expect(workforceFor(sixPeople, 'player')).toMatchObject({ employed: 6, free: 0 })
    expect(productionFor(sixPeople, 'player')).toMatchObject({ flour: 26, meat: 5 })
  })

  it('staffs food, kitchens and industry in a deterministic priority order', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'mill', 0, 2)
    placeBuilding(scenario, 'farm', 0, 3)
    placeBuilding(scenario, 'huntingLodge', 2, 3)
    placeBuilding(scenario, 'kitchen', 3, 3)
    placeBuilding(scenario, 'lumberMill', 0, 5)
    placeBuilding(scenario, 'quarry', 1, 5)
    placeBuilding(scenario, 'mine', 3, 5)
    placeBuilding(scenario, 'smelter', 4, 5)
    const match = createMatch(scenario)
    const eightWorkers = {
      ...match,
      domains: {
        ...match.domains,
        player: { ...match.domains.player, population: 8, resources: { ...match.domains.player.resources, ore: 10 } },
      },
    }
    expect(workforceFor(eightWorkers, 'player').assignments.map(({ kind, assigned }) => ({ kind, assigned }))).toEqual([
      { kind: 'mill', assigned: 1 },
      { kind: 'huntingLodge', assigned: 1 },
      { kind: 'farm', assigned: 2 },
      { kind: 'kitchen', assigned: 1 },
      { kind: 'lumberMill', assigned: 1 },
      { kind: 'quarry', assigned: 2 },
      { kind: 'mine', assigned: 0 },
      { kind: 'smelter', assigned: 0 },
    ])
    expect(productionFor(eightWorkers, 'player')).toMatchObject({ flour: 13, meat: 5, wood: 9, stone: 7, ore: 0 })
    const elevenWorkers = {
      ...eightWorkers,
      domains: { ...eightWorkers.domains, player: { ...eightWorkers.domains.player, population: 11 } },
    }
    const advanced = endTurn(elevenWorkers)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.domains.player.resources.iron).toBe(startingResources.iron + 4)
  })

  it('requires housing to be near a castle or kitchen and limits serviced population', () => {
    const match = createMatch(createScenario())
    expect(build(match, 'house', { column: 3, row: 7 })).toMatchObject({ ok: false, reason: 'outside-food-service' })
    const kitchen = build(match, 'kitchen', { column: 3, row: 5 })
    expect(kitchen.ok).toBe(true)
    if (!kitchen.ok) return
    const house = build(kitchen.state, 'house', { column: 3, row: 7 })
    expect(house.ok).toBe(true)
    if (!house.ok) return
    expect(foodServiceCapacityFor(house.state, 'player')).toBe(30)
    expect(civilianHousingCapacityFor(house.state, 'player')).toBe(10)
    expect(civilianPopulationCapacityFor(house.state, 'player')).toBe(10)
    const unstaffed = { ...house.state, domains: { ...house.state.domains, player: { ...house.state.domains.player, population: 0 } } }
    expect(foodServiceCapacityFor(unstaffed, 'player')).toBe(10)

    const crowded = {
      ...house.state,
      ordersRemaining: 8,
      domains: { ...house.state.domains, player: { ...house.state.domains.player, population: 25 } },
    }
    const removed = demolish(crowded, { column: 3, row: 5 })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(foodServiceCapacityFor(removed.state, 'player')).toBe(10)
    const advanced = endTurn(removed.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.domains.player.population).toBe(24)
  })

  it('requires a kitchen to grow beyond the castle food-service limit', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'house', 0, 4)
    placeBuilding(scenario, 'house', 2, 4)
    const withoutKitchen = createMatch(scenario)
    expect(civilianHousingCapacityFor(withoutKitchen, 'player')).toBe(15)
    expect(foodServiceCapacityFor(withoutKitchen, 'player')).toBe(10)
    expect(civilianPopulationCapacityFor(withoutKitchen, 'player')).toBe(10)

    placeBuilding(scenario, 'kitchen', 3, 5)
    const withKitchen = createMatch(scenario)
    expect(foodServiceCapacityFor(withKitchen, 'player')).toBe(30)
    expect(civilianPopulationCapacityFor(withKitchen, 'player')).toBe(15)
  })

  it('recruits into a cell by the castle and spends people and two orders', () => {
    const match = createMatch(createScenario())
    const result = recruit(match, 'militia', 4, { column: 1, row: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ordersRemaining).toBe(6)
    expect(humanDomain(result.state).population).toBe(gameConfig.turn.startingPopulation - 4)
    expect(troopTotals(result.state, 'player').militia).toBe(4)
    expect(recruit(match, 'spearmen', 1, { column: 1, row: 2 })).toMatchObject({ ok: false, reason: 'requires-barracks' })
    expect(recruit(match, 'militia', 1, { column: 4, row: 4 })).toMatchObject({ ok: false, reason: 'requires-barracks' })
  })

  it('uses the full perimeter of a four-cell barracks for recruitment', () => {
    const barracks = build(createMatch(createScenario()), 'barracks', { column: 1, row: 2 })
    expect(barracks.ok).toBe(true)
    if (!barracks.ok) return
    expect(
      [
        barracks.state.scenario.cells[2][1],
        barracks.state.scenario.cells[2][2],
        barracks.state.scenario.cells[3][1],
        barracks.state.scenario.cells[3][2],
      ].every((cell) => cell.object?.type === 'building' && cell.object.kind === 'barracks'),
    ).toBe(true)
    const recruited = recruit(barracks.state, 'spearmen', 1, { column: 3, row: 2 })
    expect(recruited.ok).toBe(true)
    if (!recruited.ok) return
    expect(recruited.state.ordersRemaining).toBe(0)
    expect(recruited.state.scenario.cells[2][3].object).toMatchObject({ type: 'squad', units: { spearmen: 1 } })
  })

  it('charges two orders when a squad containing knights moves', () => {
    const scenario = createScenario()
    scenario.cells[2][1] = {
      ...scenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 0, knights: 2 } },
    }
    const match = createMatch(scenario)
    expect(troopTotals(match, 'player').knights).toBe(2)
    const moved = moveOrAttack(match, { column: 1, row: 2 }, { column: 2, row: 2 })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.state.ordersRemaining).toBe(6)
  })

  it('doubles movement cost when a squad enters a forest cell', () => {
    const ordinaryScenario = createScenario()
    ordinaryScenario.cells[2][1] = {
      ...ordinaryScenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } },
    }
    ordinaryScenario.cells[2][2] = { ...ordinaryScenario.cells[2][2], vegetation: true }
    const ordinaryMove = moveOrAttack(createMatch(ordinaryScenario), { column: 1, row: 2 }, { column: 2, row: 2 })
    expect(ordinaryMove.ok).toBe(true)
    if (!ordinaryMove.ok) return
    expect(ordinaryMove.state.ordersRemaining).toBe(6)

    const knightScenario = createScenario()
    knightScenario.cells[2][1] = {
      ...knightScenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 0, knights: 1 } },
    }
    knightScenario.cells[2][2] = { ...knightScenario.cells[2][2], vegetation: true }
    const knightMove = moveOrAttack(createMatch(knightScenario), { column: 1, row: 2 }, { column: 2, row: 2 })
    expect(knightMove.ok).toBe(true)
    if (!knightMove.ok) return
    expect(knightMove.state.ordersRemaining).toBe(4)

    expect(
      moveOrAttack({ ...createMatch(ordinaryScenario), ordersRemaining: 1 }, { column: 1, row: 2 }, { column: 2, row: 2 }),
    ).toMatchObject({ ok: false, reason: 'not-enough-orders' })
    expect(
      moveOrAttack({ ...createMatch(knightScenario), ordersRemaining: 3 }, { column: 1, row: 2 }, { column: 2, row: 2 }),
    ).toMatchObject({ ok: false, reason: 'not-enough-orders' })
  })

  it('charges church upkeep and applies its population growth bonus', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'house', 0, 4)
    const church = build(createMatch(scenario), 'church', { column: 2, row: 2 })
    expect(church.ok).toBe(true)
    if (!church.ok) return
    expect(
      [
        church.state.scenario.cells[2][2],
        church.state.scenario.cells[2][3],
        church.state.scenario.cells[3][2],
        church.state.scenario.cells[3][3],
      ].every((cell) => cell.object?.type === 'building' && cell.object.kind === 'church'),
    ).toBe(true)
    expect(turnResourceDeltaFor(church.state, 'player').gold).toBe(3)
    expect(turnResourceDeltaFor(church.state, 'player').flour).toBe(-4)
    expect(turnResourceDeltaFor(church.state, 'player').meat).toBe(0)
    const advanced = endTurn(church.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(humanDomain(advanced.state).population).toBe(gameConfig.turn.startingPopulation + 2)
    expect(humanDomain(advanced.state).resources.gold).toBe(28)
  })

  it('moves, splits and merges squads while respecting the ten-unit capacity', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'house', 0, 4)
    const match = createMatch(scenario)
    match.domains.player.population = 8
    match.domains.player.resources.flour = 100
    match.domains.player.resources.gold = 100
    const recruited = recruit(match, 'militia', 6, { column: 1, row: 2 })
    if (!recruited.ok) throw new Error('recruitment failed')
    const splitUnits = defaultSplit(
      recruited.state.scenario.cells[2][1].object as Extract<NonNullable<GameMap[number][number]['object']>, { type: 'squad' }>,
    )
    expect(squadSize({ units: splitUnits })).toBe(3)
    const split = splitSquad(recruited.state, { column: 1, row: 2 }, { column: 2, row: 2 }, splitUnits)
    expect(split.ok).toBe(true)
    if (!split.ok) return
    expect(split.state.ordersRemaining).toBe(4)
    const splitHealth = [split.state.scenario.cells[2][1].object, split.state.scenario.cells[2][2].object].reduce(
      (total, object) => total + (object?.type === 'squad' ? squadHealth(object) : 0),
      0,
    )
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
    scenario.cells[0][0] = {
      ...scenario.cells[0][0],
      object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } },
    }
    const route = [
      { column: 0, row: 0 },
      { column: 1, row: 0 },
      { column: 2, row: 0 },
      { column: 3, row: 0 },
      { column: 4, row: 0 },
      { column: 4, row: 1 },
      { column: 4, row: 2 },
      { column: 4, row: 3 },
      { column: 4, row: 4 },
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
})
