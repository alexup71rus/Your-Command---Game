import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config/game'
import { buildingRules, startingResources, taxRates } from '../config/rules'
import type { GameMap, TroopComposition } from './map'
import {
  build,
  civilianHousingCapacityFor,
  civilianPopulationCapacityFor,
  createMatch,
  demolish,
  dismissSquad,
  endTurn,
  foodConsumptionFor,
  foodDemandFor,
  garrisonTower,
  humanDomain,
  maxSquadHealth,
  moveOrAttack,
  productionFor,
  recruit,
  setTaxRate,
  splitSquad,
  squadHealth,
  taxIncomeFor,
  totalArmySize,
  towerAttack,
  trade,
  troopTotals,
  turnEconomyForecastFor,
  turnResourceDeltaFor,
  ungarrisonTower,
  upkeepFor,
  workforceFor,
} from './match'
import { advanceRound, createScenario, placeBuilding, removePlayerCastle } from './matchTestFixtures'

describe('match combat and progression rules', () => {
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

  it('keeps a surviving squad in place after its final melee strike', () => {
    const scenario = createScenario()
    scenario.cells[4][4] = {
      ...scenario.cells[4][4],
      object: { type: 'squad', ownerId: 'player', units: { militia: 3, spearmen: 0, archers: 0, knights: 0 } },
    }
    scenario.cells[4][5] = {
      ...scenario.cells[4][5],
      object: { type: 'squad', ownerId: 'npc-2', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } },
    }

    const result = moveOrAttack(createMatch(scenario), { column: 4, row: 4 }, { column: 5, row: 4 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.lastEvent).toMatchObject({ kind: 'destroyed', position: { column: 5, row: 4 } })
    expect(result.state.ordersRemaining).toBe(gameConfig.turn.maxOrders - gameConfig.turn.movementOrderCost)
    expect(result.state.scenario.cells[4][4].object).toMatchObject({ type: 'squad', ownerId: 'player' })
    expect(result.state.scenario.cells[4][5].object).toBeUndefined()
  })

  it('reduces ordinary squad damage against walls', () => {
    const scenario = createScenario()
    scenario.cells[4][4] = {
      ...scenario.cells[4][4],
      object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0, knights: 0 } },
    }
    scenario.cells[4][5] = {
      ...scenario.cells[4][5],
      object: { type: 'building', kind: 'wall', ownerId: 'npc-2', hitPoints: 50, maxHitPoints: 50 },
    }
    const result = moveOrAttack(createMatch(scenario), { column: 4, row: 4 }, { column: 5, row: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.scenario.cells[4][5].object).toMatchObject({ type: 'building', kind: 'wall', hitPoints: 46 })
  })

  it('lets archers attack up to eight clear cells away without moving', () => {
    const scenario = createScenario()
    scenario.cells[0][0] = {
      ...scenario.cells[0][0],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 5, knights: 0 } },
    }
    scenario.cells[0][8] = {
      elevation: 0.2,
      landform: 'plain',
      vegetation: false,
      object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 },
    }
    const result = moveOrAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 8, row: 0 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ordersRemaining).toBe(6)
    expect(result.state.scenario.cells[0][0].object).toMatchObject({ type: 'squad', ownerId: 'player' })
    expect(result.state.scenario.cells[0][8].object).toMatchObject({ type: 'building', hitPoints: 7 })
  })

  it('accumulates damage and makes knights substantially harder to kill than militia', () => {
    const createDuel = (defender: 'militia' | 'knights') => {
      const scenario = createScenario()
      scenario.cells[0][0] = {
        ...scenario.cells[0][0],
        object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 1, knights: 0 } },
      }
      scenario.cells[0][2] = {
        ...scenario.cells[0][2],
        object: {
          type: 'squad',
          ownerId: 'npc-2',
          units: { militia: defender === 'militia' ? 1 : 0, spearmen: 0, archers: 0, knights: defender === 'knights' ? 1 : 0 },
        },
      }
      return createMatch(scenario)
    }
    const shoot = (state: ReturnType<typeof createMatch>) => {
      const result = moveOrAttack(state, { column: 0, row: 0 }, { column: 2, row: 0 })
      if (!result.ok) throw new Error(`ranged attack failed: ${result.reason}`)
      return result.state
    }

    let militiaState = createDuel('militia')
    let knightState = createDuel('knights')
    expect(
      maxSquadHealth(
        militiaState.scenario.cells[0][2].object as Extract<NonNullable<GameMap[number][number]['object']>, { type: 'squad' }>,
      ),
    ).toBe(1)
    expect(
      maxSquadHealth(knightState.scenario.cells[0][2].object as Extract<NonNullable<GameMap[number][number]['object']>, { type: 'squad' }>),
    ).toBe(2.5)
    for (let shot = 0; shot < 3; shot += 1) {
      militiaState = shoot(militiaState)
      knightState = shoot(knightState)
    }
    expect(militiaState.scenario.cells[0][2].object).toBeUndefined()
    expect(knightState.scenario.cells[0][2].object).toMatchObject({ type: 'squad', units: { knights: 1 } })
    const knight = knightState.scenario.cells[0][2].object
    expect(knight?.type === 'squad' ? squadHealth(knight) : 0).toBeCloseTo(2.284)
  })

  it('blocks ranged attacks through forests and beyond archer range', () => {
    const scenario = createScenario()
    scenario.cells[0][0] = {
      ...scenario.cells[0][0],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 5, knights: 0 } },
    }
    scenario.cells[0][2] = { ...scenario.cells[0][2], vegetation: true }
    scenario.cells[0][8] = {
      elevation: 0.2,
      landform: 'plain',
      vegetation: false,
      object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 },
    }
    expect(moveOrAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 8, row: 0 })).toMatchObject({
      ok: false,
      reason: 'ranged-shot-blocked',
    })
    scenario.cells[0][2] = { ...scenario.cells[0][2], vegetation: false }
    scenario.cells[0][9] = {
      elevation: 0.2,
      landform: 'plain',
      vegetation: false,
      object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 },
    }
    expect(moveOrAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 9, row: 0 })).toMatchObject({
      ok: false,
      reason: 'out-of-range',
    })
  })

  it('scales taxes with population and changes food demand and production', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'mill', 1, 4)
    const farm = build(createMatch(scenario), 'farm', { column: 2, row: 2 })
    if (!farm.ok) throw new Error('building failed')
    const untaxed = setTaxRate(farm.state, 'none')
    const extortionate = setTaxRate(farm.state, 'extortionate')
    if (!untaxed.ok || !extortionate.ok) throw new Error('tax change failed')
    expect(turnResourceDeltaFor(untaxed.state, 'player').gold).toBe(2)
    expect(turnResourceDeltaFor(extortionate.state, 'player').gold).toBe(12)
    expect(foodDemandFor(untaxed.state, 'player')).toBe(5)
    expect(foodDemandFor(farm.state, 'player')).toBe(8)
    expect(foodDemandFor(extortionate.state, 'player')).toBe(10)
    expect(taxRates).toMatchObject({
      none: { foodDemandMultiplier: 1, productionAdjustment: 0 },
      moderate: { foodDemandMultiplier: 1.5, productionAdjustment: -1 },
      extortionate: { foodDemandMultiplier: 2, productionAdjustment: -3 },
    })
    const largerPopulation = {
      ...extortionate.state,
      domains: { ...extortionate.state.domains, player: { ...extortionate.state.domains.player, population: 20 } },
    }
    expect(taxIncomeFor(largerPopulation, 'player')).toBe(40)
    expect(foodDemandFor(untaxed.state, 'player')).toBeLessThan(foodDemandFor(extortionate.state, 'player'))
    expect(productionFor(untaxed.state, 'player').flour - productionFor(farm.state, 'player').flour).toBe(1)
    expect(productionFor(untaxed.state, 'player').flour - productionFor(extortionate.state, 'player').flour).toBe(3)
    expect(turnResourceDeltaFor(untaxed.state, 'player').flour).toBeGreaterThan(turnResourceDeltaFor(extortionate.state, 'player').flour)
  })

  it('can build the first mill, farm and house from starting resources', () => {
    const scenario = createScenario()
    const mill = build(createMatch(scenario), 'mill', { column: 2, row: 2 })
    if (!mill.ok) throw new Error('mill building failed')
    const farm = build(mill.state, 'farm', { column: 0, row: 3 })
    if (!farm.ok) throw new Error('farm building failed')
    expect(farm.state.ordersRemaining).toBe(0)
    const firstTurn = advanceRound(farm.state)
    if (!firstTurn.ok) throw new Error('turn failed')
    const house = build(firstTurn.state, 'house', { column: 2, row: 4 })
    if (!house.ok) throw new Error('house building failed')
    let state = house.state
    for (let turn = 0; turn < 5; turn += 1) {
      const advanced = advanceRound(state)
      if (!advanced.ok) throw new Error('turn failed')
      expect(advanced.state.lastTurnReports.player.food.fed).toBe(true)
      state = advanced.state
    }
    expect(state.domains.player.population).toBe(10)
    const forecast = turnEconomyForecastFor(state, 'player')
    expect(forecast?.foodDemand).toBe(15)
    expect((forecast?.production.flour ?? 0) + (forecast?.production.meat ?? 0) + (forecast?.production.fruit ?? 0)).toBe(17)
  })

  it('charges troop upkeep and allows resource trade through an owned market', () => {
    const recruited = recruit(createMatch(createScenario()), 'militia', 4, { column: 1, row: 2 })
    if (!recruited.ok) throw new Error('recruitment failed')
    expect(upkeepFor(recruited.state, 'player').gold).toBe(2)
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

  it('balances food between three interchangeable resources and falls back to any one', () => {
    const match = createMatch(createScenario())
    const untaxed = setTaxRate(match, 'none')
    if (!untaxed.ok) throw new Error('tax change failed')
    expect(foodConsumptionFor(untaxed.state, 'player', { flour: 10, meat: 10, fruit: 0 })).toEqual({
      flour: 3,
      meat: 2,
      fruit: 0,
      fed: true,
      diverseDiet: false,
    })
    const largerScenario = createScenario()
    placeBuilding(largerScenario, 'kitchen', 2, 3)
    const largerMatch = createMatch(largerScenario)
    const largerPopulation = {
      ...largerMatch,
      domains: { ...largerMatch.domains, player: { ...largerMatch.domains.player, taxRate: 'none' as const, population: 30 } },
    }
    expect(foodConsumptionFor(largerPopulation, 'player', { flour: 20, meat: 20, fruit: 20 })).toEqual({
      flour: 10,
      meat: 10,
      fruit: 10,
      fed: true,
      diverseDiet: true,
    })
    expect(foodConsumptionFor(untaxed.state, 'player', { flour: 10, meat: 0, fruit: 0 })).toEqual({
      flour: 5,
      meat: 0,
      fruit: 0,
      fed: true,
      diverseDiet: false,
    })
    expect(foodConsumptionFor(untaxed.state, 'player', { flour: 0, meat: 10, fruit: 0 })).toEqual({
      flour: 0,
      meat: 5,
      fruit: 0,
      fed: true,
      diverseDiet: false,
    })
  })

  it('allows either food resource to satisfy the additional tax demand', () => {
    const match = createMatch(createScenario())
    expect(foodConsumptionFor(match, 'player', { flour: 1, meat: 10, fruit: 0 })).toEqual({
      flour: 1,
      meat: 7,
      fruit: 0,
      fed: true,
      diverseDiet: false,
    })
    expect(foodConsumptionFor(match, 'player', { flour: 0, meat: 10, fruit: 0 })).toEqual({
      flour: 0,
      meat: 8,
      fruit: 0,
      fed: true,
      diverseDiet: false,
    })
  })

  it('gains and loses the varied-diet growth bonus without changing capacity', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'house', 0, 4)
    const initial = createMatch(scenario)
    const player = {
      ...initial.domains.player,
      taxRate: 'none' as const,
      resources: { ...initial.domains.player.resources, flour: 10, meat: 10, fruit: 10 },
    }
    const fed = advanceRound({ ...initial, domains: { ...initial.domains, player } })
    expect(fed.ok).toBe(true)
    if (!fed.ok) return
    expect(fed.state.domains.player.diverseDiet).toBe(true)
    expect(civilianHousingCapacityFor(fed.state, 'player')).toBe(gameConfig.turn.basePopulationCapacity + 5)
    expect(civilianPopulationCapacityFor(fed.state, 'player')).toBe(gameConfig.turn.basePopulationCapacity + 5)
    expect(fed.state.domains.player.population).toBe(gameConfig.turn.startingPopulation + 2)

    const withoutMeat = { ...fed.state.domains.player, resources: { ...fed.state.domains.player.resources, flour: 10, meat: 0, fruit: 10 } }
    const lost = advanceRound({ ...fed.state, domains: { ...fed.state.domains, player: withoutMeat } })
    expect(lost.ok).toBe(true)
    if (!lost.ok) return
    expect(lost.state.domains.player.diverseDiet).toBe(false)
    expect(civilianHousingCapacityFor(lost.state, 'player')).toBe(gameConfig.turn.basePopulationCapacity + 5)
    expect(lost.state.domains.player.population).toBe(gameConfig.turn.startingPopulation + 3)
  })

  it('keeps the target minimal, medium and developed settlements sustainable for twenty turns', () => {
    const simulate = (state: ReturnType<typeof createMatch>, turns = 20) => {
      let current = state
      for (let turn = 0; turn < turns; turn += 1) {
        const advanced = advanceRound(current)
        if (!advanced.ok) throw new Error('turn failed')
        expect(advanced.state.lastTurnReports.player.food.fed).toBe(true)
        expect(advanced.state.lastTurnReports.player.desertion).toBeNull()
        current = advanced.state
      }
      return current
    }

    const minimalScenario = createScenario(12)
    placeBuilding(minimalScenario, 'house', 0, 4)
    placeBuilding(minimalScenario, 'orchard', 2, 3)
    minimalScenario.cells[2][1] = {
      ...minimalScenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 4, spearmen: 0, archers: 0, knights: 0 } },
    }
    const minimal = createMatch(minimalScenario)
    minimal.domains.player.population = 6
    minimal.domains.player.taxRate = 'none'
    const minimalResult = simulate(minimal)
    expect(minimalResult.domains.player.resources.gold).toBe(startingResources.gold)
    expect(minimalResult.domains.player.population).toBe(6)

    const mediumScenario = createScenario(12)
    placeBuilding(mediumScenario, 'mill', 1, 2)
    placeBuilding(mediumScenario, 'farm', 0, 3)
    placeBuilding(mediumScenario, 'orchard', 3, 3)
    placeBuilding(mediumScenario, 'house', 0, 6)
    placeBuilding(mediumScenario, 'house', 1, 6)
    mediumScenario.cells[2][2] = {
      ...mediumScenario.cells[2][2],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 5, knights: 0 } },
    }
    const medium = createMatch(mediumScenario)
    medium.domains.player.population = 10
    const mediumResult = simulate(medium)
    expect(mediumResult.domains.player.population).toBe(10)
    expect(mediumResult.domains.player.resources.gold).toBe(startingResources.gold + 100)

    const developedScenario = createScenario(16)
    placeBuilding(developedScenario, 'mill', 2, 2)
    placeBuilding(developedScenario, 'farm', 0, 3)
    placeBuilding(developedScenario, 'farm', 2, 3)
    placeBuilding(developedScenario, 'orchard', 4, 3)
    placeBuilding(developedScenario, 'huntingLodge', 4, 6)
    placeBuilding(developedScenario, 'kitchen', 5, 6)
    placeBuilding(developedScenario, 'church', 0, 6)
    for (let column = 0; column < 4; column += 1) placeBuilding(developedScenario, 'house', column, 9)
    developedScenario.cells[2][1] = {
      ...developedScenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 0, knights: 6 } },
    }
    const developed = createMatch(developedScenario)
    developed.domains.player.population = 19
    const developedForecast = turnEconomyForecastFor(developed, 'player')
    expect(developedForecast?.foodDemand).toBe(35)
    expect(gameConfig.economy.foodResources.reduce((total, resource) => total + (developedForecast?.production[resource] ?? 0), 0)).toBe(40)
    expect(developedForecast?.taxIncome).toBe(19)
    expect(developedForecast?.upkeep.gold).toBe(19)
    expect(developedForecast?.food.diverseDiet).toBe(false)
    const extortionateDeveloped = {
      ...developed,
      domains: { ...developed.domains, player: { ...developed.domains.player, taxRate: 'extortionate' as const } },
    }
    const extortionateForecast = turnEconomyForecastFor(extortionateDeveloped, 'player')
    expect(extortionateForecast?.foodDemand).toBe(44)
    expect(gameConfig.economy.foodResources.reduce((total, resource) => total + (extortionateForecast?.production[resource] ?? 0), 0)).toBe(
      32,
    )
    expect(extortionateForecast?.taxIncome).toBe(38)
    const developedResult = simulate(developed)
    expect(developedResult.domains.player.population).toBe(19)
    expect(developedResult.domains.player.resources.gold).toBe(startingResources.gold + 40)
    expect(
      developedResult.domains.player.resources.flour +
        developedResult.domains.player.resources.meat +
        developedResult.domains.player.resources.fruit,
    ).toBe(startingResources.flour + 100)

    const variedScenario = structuredClone(developedScenario)
    placeBuilding(variedScenario, 'orchard', 6, 3)
    placeBuilding(variedScenario, 'huntingLodge', 6, 6)
    const varied = createMatch(variedScenario)
    varied.domains.player.population = 19
    expect(turnEconomyForecastFor(varied, 'player')?.food.diverseDiet).toBe(true)
  })

  it('leaves a recovery path after one expensive mistake and tolerates five militia', () => {
    const mistaken = build(createMatch(createScenario()), 'church', { column: 2, row: 2 })
    if (!mistaken.ok) throw new Error('expensive building failed')
    const nextTurn = advanceRound(mistaken.state)
    if (!nextTurn.ok) throw new Error('turn failed')
    const orchard = build(nextTurn.state, 'orchard', { column: 0, row: 4 })
    if (!orchard.ok) throw new Error('orchard recovery failed')
    const house = build(orchard.state, 'house', { column: 2, row: 4 })
    expect(house.ok).toBe(true)

    const scenario = createScenario()
    placeBuilding(scenario, 'house', 0, 4)
    placeBuilding(scenario, 'orchard', 2, 3)
    scenario.cells[2][1] = {
      ...scenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 5, spearmen: 0, archers: 0, knights: 0 } },
    }
    let state = createMatch(scenario)
    state.domains.player.population = 5
    state.domains.player.taxRate = 'none'
    for (let turn = 0; turn < 20; turn += 1) {
      const advanced = advanceRound(state)
      if (!advanced.ok) throw new Error('turn failed')
      expect(advanced.state.lastTurnReports.player.food.fed).toBe(true)
      expect(advanced.state.lastTurnReports.player.desertion).toBeNull()
      state = advanced.state
    }
    expect(state.domains.player.resources.gold).toBe(startingResources.gold - 20)
  })

  it('applies the varied-diet damage bonus to every owned squad attack', () => {
    const scenario = createScenario()
    scenario.cells[4][4] = {
      ...scenario.cells[4][4],
      object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0, knights: 0 } },
    }
    scenario.cells[4][5] = {
      ...scenario.cells[4][5],
      object: { type: 'building', kind: 'house', ownerId: 'npc-2', hitPoints: 50, maxHitPoints: 50 },
    }
    const match = createMatch(scenario)
    const ordinary = moveOrAttack(match, { column: 4, row: 4 }, { column: 5, row: 4 })
    const boostedState = { ...match, domains: { ...match.domains, player: { ...match.domains.player, diverseDiet: true } } }
    const boosted = moveOrAttack(boostedState, { column: 4, row: 4 }, { column: 5, row: 4 })
    expect(ordinary.ok).toBe(true)
    expect(boosted.ok).toBe(true)
    if (!ordinary.ok || !boosted.ok) return
    expect(ordinary.state.scenario.cells[4][5].object).toMatchObject({ hitPoints: 40 })
    expect(boosted.state.scenario.cells[4][5].object).toMatchObject({ hitPoints: 39 })
  })

  it('removes workers from the end of the allocation order when civilians starve', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'mill', 1, 2)
    placeBuilding(scenario, 'farm', 0, 3)
    placeBuilding(scenario, 'farm', 2, 3)
    scenario.cells[7][7] = {
      ...scenario.cells[7][7],
      object: { type: 'squad', ownerId: 'player', units: { militia: 100, spearmen: 0, archers: 0, knights: 0 } },
    }
    const match = createMatch(scenario)
    const player = {
      ...match.domains.player,
      population: 3,
      taxRate: 'none' as const,
      resources: { ...match.domains.player.resources, flour: 0, meat: 0, fruit: 0 },
    }
    expect(workforceFor({ ...match, domains: { ...match.domains, player } }, 'player').assignments.map(({ assigned }) => assigned)).toEqual(
      [1, 2, 0],
    )
    const starved = endTurn({ ...match, domains: { ...match.domains, player } })
    expect(starved.ok).toBe(true)
    if (!starved.ok) return
    expect(starved.state.domains.player.population).toBe(2)
    expect(workforceFor(starved.state, 'player').assignments.map(({ assigned }) => assigned)).toEqual([1, 1, 0])
  })

  it('removes a troop deterministically when no civilians remain and preserves one last inhabitant', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    scenario.cells[0][0] = {
      ...scenario.cells[0][0],
      object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 1, archers: 0, knights: 0 } },
    }
    scenario.cells[0][1] = {
      ...scenario.cells[0][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } },
    }
    const match = createMatch(scenario)
    const player = {
      ...match.domains.player,
      population: 0,
      taxRate: 'none' as const,
      resources: { ...match.domains.player.resources, flour: 0, meat: 0 },
    }
    const starved = endTurn({ ...match, domains: { ...match.domains, player } })
    expect(starved.ok).toBe(true)
    if (!starved.ok) return
    expect(starved.state.scenario.cells[0][0].object).toMatchObject({ type: 'squad', units: { militia: 0, spearmen: 1 } })
    expect(starved.state.scenario.cells[0][1].object).toMatchObject({ type: 'squad', units: { militia: 1 } })

    const oneLeftScenario = createScenario()
    removePlayerCastle(oneLeftScenario)
    oneLeftScenario.cells[0][0] = {
      ...oneLeftScenario.cells[0][0],
      object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } },
    }
    const oneLeftMatch = createMatch(oneLeftScenario)
    const lastPlayer = {
      ...oneLeftMatch.domains.player,
      population: 0,
      taxRate: 'none' as const,
      resources: { ...oneLeftMatch.domains.player.resources, flour: 0, meat: 0 },
    }
    const preserved = endTurn({ ...oneLeftMatch, domains: { ...oneLeftMatch.domains, player: lastPlayer } })
    expect(preserved.ok).toBe(true)
    if (!preserved.ok) return
    expect(troopTotals(preserved.state, 'player').militia).toBe(1)
  })

  it('serializes the current hunting lodge and diet state', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'huntingLodge', 2, 2)
    const match = createMatch(scenario)
    match.domains.player.diverseDiet = true
    const restored = JSON.parse(JSON.stringify(match)) as typeof match
    expect(restored.domains.player.diverseDiet).toBe(true)
    expect(restored.scenario.cells[2][2].object).toMatchObject({ type: 'building', kind: 'huntingLodge' })
    expect(productionFor(restored, 'player').meat).toBe(5)
  })

  it('increases food demand as houses allow the civilian population to grow', () => {
    const house = build(createMatch(createScenario()), 'house', { column: 2, row: 2 })
    if (!house.ok) throw new Error('house building failed')
    const untaxed = setTaxRate(house.state, 'none')
    if (!untaxed.ok) throw new Error('tax change failed')
    untaxed.state.domains.player.resources.flour = 100
    untaxed.state.domains.player.resources.meat = 100
    const initialDemand = foodDemandFor(untaxed.state, 'player')
    let state = untaxed.state
    for (let turn = 0; turn < 6; turn += 1) {
      const advanced = advanceRound(state)
      if (!advanced.ok) throw new Error('turn failed')
      state = advanced.state
    }
    expect(civilianHousingCapacityFor(state, 'player')).toBe(gameConfig.turn.basePopulationCapacity + 5)
    expect(humanDomain(state).population).toBe(10)
    expect(foodDemandFor(state, 'player')).toBeGreaterThan(initialDemand)
  })

  it('derives housing from living houses and reduces over-capacity population by only one per turn', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'kitchen', 5, 5)
    const match = createMatch(scenario)
    const house = build(match, 'house', { column: 2, row: 2 })
    if (!house.ok) throw new Error('house building failed')
    expect(civilianHousingCapacityFor(house.state, 'player')).toBe(10)
    const removed = demolish(house.state, { column: 2, row: 2 })
    if (!removed.ok) throw new Error('house demolition failed')
    expect(civilianHousingCapacityFor(removed.state, 'player')).toBe(5)

    const overCapacity = {
      ...removed.state,
      domains: {
        ...removed.state.domains,
        player: {
          ...removed.state.domains.player,
          population: 30,
          taxRate: 'none' as const,
          resources: { ...removed.state.domains.player.resources, flour: 100, meat: 100 },
        },
      },
    }
    const advanced = endTurn(overCapacity)
    if (!advanced.ok) throw new Error('turn failed')
    expect(advanced.state.domains.player.population).toBe(29)
    expect(advanced.state.lastTurnReports.player.populationReason).toBe('capacity')
  })

  it('does not create a civilian when soldiers already fill the total housing capacity', () => {
    const scenario = createScenario()
    scenario.cells[2][1] = {
      ...scenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0, knights: 0 } },
    }
    scenario.cells[2][2] = {
      ...scenario.cells[2][2],
      object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0, knights: 0 } },
    }
    const match = createMatch(scenario)
    match.domains.player.population = 0
    match.domains.player.taxRate = 'none'
    match.domains.player.resources.flour = 100
    match.domains.player.resources.meat = 0
    const advanced = endTurn(match)
    if (!advanced.ok) throw new Error('turn failed')
    expect(civilianHousingCapacityFor(advanced.state, 'player')).toBe(0)
    expect(advanced.state.domains.player.population).toBe(0)
    expect(totalArmySize(advanced.state)).toBe(20)
  })

  it('immediately derives lower housing after an enemy house is destroyed', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'house', 5, 4, 'npc-2')
    const house = scenario.cells[4][5].object
    if (house?.type !== 'building') throw new Error('house missing')
    scenario.cells[4][5] = { ...scenario.cells[4][5], object: { ...house, hitPoints: 1 } }
    scenario.cells[4][4] = {
      ...scenario.cells[4][4],
      object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } },
    }
    const match = createMatch(scenario)
    expect(civilianHousingCapacityFor(match, 'npc-2')).toBe(10)
    const attacked = moveOrAttack(match, { column: 4, row: 4 }, { column: 5, row: 4 })
    if (!attacked.ok) throw new Error('attack failed')
    expect(civilianHousingCapacityFor(attacked.state, 'npc-2')).toBe(5)
  })

  it('collects taxes before upkeep and deserts exactly one cheapest troop on a deficit', () => {
    const paidScenario = createScenario()
    paidScenario.cells[2][1] = {
      ...paidScenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 4, archers: 0, knights: 0 } },
    }
    const paidMatch = createMatch(paidScenario)
    paidMatch.domains.player.resources.gold = 0
    const paid = endTurn(paidMatch)
    if (!paid.ok) throw new Error('turn failed')
    expect(paid.state.lastTurnReports.player).toMatchObject({ taxIncome: 5, upkeepPaid: true, desertion: null })
    expect(troopTotals(paid.state, 'player').spearmen).toBe(4)

    const deficitScenario = createScenario()
    deficitScenario.cells[2][1] = {
      ...deficitScenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 1 } },
    }
    const deficitMatch = createMatch(deficitScenario)
    deficitMatch.domains.player.taxRate = 'none'
    deficitMatch.domains.player.resources.gold = 0
    const deficit = endTurn(deficitMatch)
    if (!deficit.ok) throw new Error('turn failed')
    expect(deficit.state.lastTurnReports.player.upkeepPaid).toBe(false)
    expect(deficit.state.lastTurnReports.player.desertion).toMatchObject({ kind: 'militia', source: 'squad' })
    expect(troopTotals(deficit.state, 'player')).toMatchObject({ militia: 0, knights: 1 })
  })

  it('forecasts food demand after a pending desertion', () => {
    const scenario = createScenario()
    scenario.cells[2][1] = {
      ...scenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 0, knights: 1 } },
    }
    const match = createMatch(scenario)
    match.domains.player.taxRate = 'none'
    match.domains.player.resources.gold = 0
    const forecast = turnEconomyForecastFor(match, 'player')
    expect(forecast?.desertion).toMatchObject({ kind: 'knights' })
    expect(forecast?.foodDemand).toBe(foodDemandFor(match, 'player') - 1)
  })

  it('counts garrison upkeep and can desert the cheapest fighter from a tower', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'tower', 4, 4)
    const tower = scenario.cells[4][4].object
    if (tower?.type !== 'building') throw new Error('tower missing')
    scenario.cells[4][4] = { ...scenario.cells[4][4], object: { ...tower, garrison: { archers: 2, health: 2 } } }
    scenario.cells[4][3] = {
      ...scenario.cells[4][3],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 0, knights: 1 } },
    }
    const match = createMatch(scenario)
    match.domains.player.taxRate = 'none'
    match.domains.player.resources.gold = 0

    expect(upkeepFor(match, 'player').gold).toBe(5)
    const advanced = endTurn(match)
    if (!advanced.ok) throw new Error('turn failed')
    expect(advanced.state.lastTurnReports.player.desertion).toMatchObject({ kind: 'archers', source: 'garrison' })
    expect(advanced.state.scenario.cells[4][4].object).toMatchObject({ garrison: { archers: 1, health: 1 } })
    expect(troopTotals(advanced.state, 'player')).toMatchObject({ archers: 1, knights: 1 })
  })

  it('enforces the global 100-unit army cap including tower garrisons', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'tower', 4, 4)
    const tower = scenario.cells[4][4].object
    if (tower?.type !== 'building') throw new Error('tower missing')
    scenario.cells[4][4] = { ...scenario.cells[4][4], object: { ...tower, garrison: { archers: 5, health: 5 } } }
    let remaining = 95
    for (let row = 0; row < scenario.cells.length && remaining > 0; row += 1) {
      for (let column = 0; column < scenario.cells[row].length && remaining > 0; column += 1) {
        if (scenario.cells[row][column].object || (column === 1 && row === 2)) continue
        const amount = Math.min(10, remaining)
        scenario.cells[row][column] = {
          ...scenario.cells[row][column],
          object: { type: 'squad', ownerId: 'player', units: { militia: amount, spearmen: 0, archers: 0, knights: 0 } },
        }
        remaining -= amount
      }
    }
    const match = createMatch(scenario)
    expect(totalArmySize(match)).toBe(100)
    expect(recruit(match, 'militia', 1, { column: 1, row: 2 })).toMatchObject({ ok: false, reason: 'army-full' })
  })

  it('dismisses a partial or complete integer composition for two orders', () => {
    const scenario = createScenario()
    scenario.cells[2][1] = {
      ...scenario.cells[2][1],
      object: { type: 'squad', ownerId: 'player', units: { militia: 6, spearmen: 0, archers: 0, knights: 0 }, health: 6 },
    }
    const match = createMatch(scenario)
    const dismissed = dismissSquad(match, { column: 1, row: 2 }, { militia: 2, spearmen: 0, archers: 0, knights: 0 })
    if (!dismissed.ok) throw new Error('dismiss failed')
    expect(dismissed.state.ordersRemaining).toBe(6)
    expect(dismissed.state.domains.player.population).toBe(gameConfig.turn.startingPopulation + 2)
    expect(dismissed.state.scenario.cells[2][1].object).toMatchObject({ type: 'squad', units: { militia: 4 }, health: 4 })
    const disbanded = dismissSquad(match, { column: 1, row: 2 }, { militia: 6, spearmen: 0, archers: 0, knights: 0 })
    if (!disbanded.ok) throw new Error('disband failed')
    expect(disbanded.state.scenario.cells[2][1].object).toBeUndefined()
    expect(disbanded.state.domains.player.population).toBe(gameConfig.turn.startingPopulation + 6)
    expect(dismissSquad(match, { column: 1, row: 2 }, { militia: Number.NaN, spearmen: 0, archers: 0, knights: 0 })).toMatchObject({
      ok: false,
      reason: 'invalid-squad',
    })
    expect(
      splitSquad(match, { column: 1, row: 2 }, { column: 2, row: 2 }, { militia: 1.5, spearmen: 0, archers: 0, knights: 0 }),
    ).toMatchObject({ ok: false, reason: 'invalid-squad' })
  })

  it('moves up to five archers into a tower, exits only to an empty cell and protects an occupied tower from demolition', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'tower', 2, 2)
    scenario.cells[1][2] = {
      ...scenario.cells[1][2],
      object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 1, archers: 7, knights: 1 } },
    }
    const entered = garrisonTower(createMatch(scenario), { column: 2, row: 1 }, { column: 2, row: 2 })
    if (!entered.ok) throw new Error('garrison failed')
    expect(entered.state.ordersRemaining).toBe(6)
    expect(entered.state.scenario.cells[2][2].object).toMatchObject({
      type: 'building',
      kind: 'tower',
      garrison: { archers: 5, health: 5 },
    })
    expect(entered.state.scenario.cells[1][2].object).toMatchObject({
      type: 'squad',
      units: { militia: 1, spearmen: 1, archers: 2, knights: 1 },
      health: 6.85,
    })
    expect(demolish(entered.state, { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'cannot-demolish' })

    entered.state.scenario.cells[2][3] = {
      ...entered.state.scenario.cells[2][3],
      object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } },
    }
    expect(ungarrisonTower(entered.state, { column: 2, row: 2 }, { column: 3, row: 2 })).toMatchObject({ ok: false, reason: 'occupied' })
    const exited = ungarrisonTower(entered.state, { column: 2, row: 2 }, { column: 1, row: 2 })
    if (!exited.ok) throw new Error('ungarrison failed')
    expect(exited.state.scenario.cells[2][1].object).toMatchObject({ type: 'squad', units: { archers: 5 }, health: 5 })
    expect(exited.state.scenario.cells[2][2].object).toMatchObject({ type: 'building', kind: 'tower', garrison: undefined })
    expect(demolish(exited.state, { column: 2, row: 2 }).ok).toBe(true)

    const invalidScenario = createScenario()
    placeBuilding(invalidScenario, 'tower', 2, 2)
    invalidScenario.cells[1][2] = {
      ...invalidScenario.cells[1][2],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 1.5, knights: 0 } },
    }
    expect(garrisonTower(createMatch(invalidScenario), { column: 2, row: 1 }, { column: 2, row: 2 })).toMatchObject({
      ok: false,
      reason: 'invalid-squad',
    })
  })

  it('lets a plain-ground tower fire with its fixed height bonus and kills its garrison when destroyed', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'tower', 0, 0)
    const tower = scenario.cells[0][0].object
    if (tower?.type !== 'building') throw new Error('tower missing')
    scenario.cells[0][0] = { ...scenario.cells[0][0], object: { ...tower, garrison: { archers: 5, health: 5 } } }
    scenario.cells[0][7] = {
      ...scenario.cells[0][7],
      object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 },
    }
    const fired = towerAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 7, row: 0 })
    if (!fired.ok) throw new Error('tower attack failed')
    expect(fired.state.ordersRemaining).toBe(6)
    expect(fired.state.scenario.cells[0][7].object).toMatchObject({ hitPoints: 7 })

    const destructionScenario = createScenario()
    placeBuilding(destructionScenario, 'tower', 5, 4, 'npc-2')
    const enemyTower = destructionScenario.cells[4][5].object
    if (enemyTower?.type !== 'building') throw new Error('enemy tower missing')
    destructionScenario.cells[4][5] = {
      ...destructionScenario.cells[4][5],
      object: { ...enemyTower, hitPoints: 1, garrison: { archers: 5, health: 5 } },
    }
    destructionScenario.cells[4][4] = {
      ...destructionScenario.cells[4][4],
      object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } },
    }
    const destroyed = moveOrAttack(createMatch(destructionScenario), { column: 4, row: 4 }, { column: 5, row: 4 })
    if (!destroyed.ok) throw new Error('tower destruction failed')
    expect(destroyed.state.scenario.cells[4][5].object).toMatchObject({ type: 'squad', ownerId: 'player' })
    expect(troopTotals(destroyed.state, 'npc-2').archers).toBe(0)
  })

  it('enforces tower range endpoints and line-of-fire blockers', () => {
    const atMaximum = createScenario(12)
    placeBuilding(atMaximum, 'tower', 0, 0)
    const tower = atMaximum.cells[0][0].object
    if (tower?.type !== 'building') throw new Error('tower missing')
    atMaximum.cells[0][0] = { ...atMaximum.cells[0][0], object: { ...tower, garrison: { archers: 1, health: 1 } } }
    atMaximum.cells[0][10] = {
      ...atMaximum.cells[0][10],
      object: { type: 'building', kind: 'house', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 },
    }
    expect(towerAttack(createMatch(atMaximum), { column: 0, row: 0 }, { column: 10, row: 0 }).ok).toBe(true)

    const adjacent = createScenario(12)
    placeBuilding(adjacent, 'tower', 0, 0)
    const adjacentTower = adjacent.cells[0][0].object
    if (adjacentTower?.type !== 'building') throw new Error('tower missing')
    adjacent.cells[0][0] = { ...adjacent.cells[0][0], object: { ...adjacentTower, garrison: { archers: 1, health: 1 } } }
    adjacent.cells[0][1] = {
      ...adjacent.cells[0][1],
      object: { type: 'building', kind: 'house', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 },
    }
    adjacent.cells[0][11] = {
      ...adjacent.cells[0][11],
      object: { type: 'building', kind: 'house', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 },
    }
    expect(towerAttack(createMatch(adjacent), { column: 0, row: 0 }, { column: 1, row: 0 }).ok).toBe(true)
    expect(towerAttack(createMatch(adjacent), { column: 0, row: 0 }, { column: 11, row: 0 })).toMatchObject({
      ok: false,
      reason: 'out-of-range',
    })

    const blocked = createScenario(12)
    placeBuilding(blocked, 'tower', 0, 0)
    const blockedTower = blocked.cells[0][0].object
    if (blockedTower?.type !== 'building') throw new Error('tower missing')
    blocked.cells[0][0] = { ...blocked.cells[0][0], object: { ...blockedTower, garrison: { archers: 1, health: 1 } } }
    blocked.cells[0][5] = { ...blocked.cells[0][5], vegetation: true }
    blocked.cells[0][10] = {
      ...blocked.cells[0][10],
      object: { type: 'building', kind: 'house', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 },
    }
    expect(towerAttack(createMatch(blocked), { column: 0, row: 0 }, { column: 10, row: 0 })).toMatchObject({
      ok: false,
      reason: 'ranged-shot-blocked',
    })
  })

  it('removes housing immediately after a ranged house destruction', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'house', 7, 4, 'npc-2')
    const house = scenario.cells[4][7].object
    if (house?.type !== 'building') throw new Error('house missing')
    scenario.cells[4][7] = { ...scenario.cells[4][7], object: { ...house, hitPoints: 1 } }
    scenario.cells[4][0] = {
      ...scenario.cells[4][0],
      object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 1, knights: 0 }, health: 1 },
    }
    const match = createMatch(scenario)
    expect(civilianHousingCapacityFor(match, 'npc-2')).toBe(10)
    const attacked = moveOrAttack(match, { column: 0, row: 4 }, { column: 7, row: 4 })
    if (!attacked.ok) throw new Error('ranged attack failed')
    expect(civilianHousingCapacityFor(attacked.state, 'npc-2')).toBe(5)
  })

  it('uses per-building wall and barbican mitigation rules', () => {
    expect(buildingRules.wall.incomingDamageMultiplier).toBe(0.35)
    expect(buildingRules.tower.resourceCost.iron).toBeUndefined()
    expect(buildingRules.barbican).toMatchObject({
      actionCost: 4,
      resourceCost: { wood: 16, stone: 28, iron: 2, gold: 8 },
      hitPoints: 20,
      allowsFriendlyPassage: true,
    })
    expect(buildingRules.barbican.hitPoints).toBeLessThan(buildingRules.tower.hitPoints)
    expect(buildingRules.barbican.incomingDamageMultiplier).toBeUndefined()
    const scenario = createScenario()
    scenario.cells[4][4] = {
      ...scenario.cells[4][4],
      object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0, knights: 0 } },
    }
    scenario.cells[4][5] = {
      ...scenario.cells[4][5],
      object: { type: 'building', kind: 'barbican', ownerId: 'npc-2', hitPoints: 20, maxHitPoints: 20 },
    }
    const attacked = moveOrAttack(createMatch(scenario), { column: 4, row: 4 }, { column: 5, row: 4 })
    if (!attacked.ok) throw new Error('barbican attack failed')
    expect(attacked.state.scenario.cells[4][5].object).toMatchObject({ hitPoints: 10 })
  })

  it('moves through an owned barbican while enemies must break it first', () => {
    const createGateScenario = (units: TroopComposition, ownerId = 'player') => {
      const scenario = createScenario()
      placeBuilding(scenario, 'barbican', 2, 4, ownerId)
      scenario.cells[4][1] = { ...scenario.cells[4][1], object: { type: 'squad', ownerId: 'player', units } }
      return scenario
    }

    const militia = createGateScenario({ militia: 1, spearmen: 0, archers: 0, knights: 0 })
    const crossed = moveOrAttack(createMatch(militia), { column: 1, row: 4 }, { column: 3, row: 4 })
    if (!crossed.ok) throw new Error('barbican passage failed')
    expect(crossed.state.ordersRemaining).toBe(6)
    expect(crossed.state.scenario.cells[4][1].object).toBeUndefined()
    expect(crossed.state.scenario.cells[4][2].object).toMatchObject({ type: 'building', kind: 'barbican' })
    expect(crossed.state.scenario.cells[4][3].object).toMatchObject({ type: 'squad', units: { militia: 1 } })

    const knights = createGateScenario({ militia: 0, spearmen: 0, archers: 0, knights: 1 })
    const knightCrossing = moveOrAttack(createMatch(knights), { column: 1, row: 4 }, { column: 3, row: 4 })
    expect(knightCrossing.ok && knightCrossing.state.ordersRemaining).toBe(4)

    const enemyGate = createGateScenario({ militia: 1, spearmen: 0, archers: 0, knights: 0 }, 'npc-2')
    expect(moveOrAttack(createMatch(enemyGate), { column: 1, row: 4 }, { column: 3, row: 4 })).toMatchObject({
      ok: false,
      reason: 'not-adjacent',
    })
  })
})
