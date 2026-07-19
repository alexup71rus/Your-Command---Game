import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config/game'
import { buildingRules, marketPrices, startingResources, troopRules } from '../config/rules'
import type { BuildingKind, GameMap, TroopComposition } from './map'
import {
  build,
  buildingFootprintPositions,
  civilianHousingCapacityFor,
  civilianPopulationCapacityFor,
  createMatch,
  defaultSplit,
  demolish,
  dismissSquad,
  endTurn,
  garrisonTower,
  humanDomain,
  foodDemandFor,
  foodConsumptionFor,
  foodServiceCapacityFor,
  maxSquadHealth,
  moveOrAttack,
  productionFor,
  recruit,
  setTaxRate,
  splitSquad,
  squadHealth,
  squadSize,
  taxIncomeFor,
  totalArmySize,
  troopTotals,
  trade,
  towerAttack,
  turnEconomyForecastFor,
  turnResourceDeltaFor,
  upkeepFor,
  ungarrisonTower,
  workforceFor,
} from './match'
import type { MapScenario } from './scenario'

function createScenario(size = 8): MapScenario {
  const cells: GameMap = Array.from({ length: size }, () => Array.from({ length: size }, () => ({
    elevation: 0.2,
    landform: 'plain' as const,
    vegetation: false,
  })))
  cells[1][1] = { ...cells[1][1], object: { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 } }
  const npcCastleColumn = size - 2
  cells[1][npcCastleColumn] = { ...cells[1][npcCastleColumn], object: { type: 'castle', ownerId: 'npc-2', hitPoints: 100, maxHitPoints: 100 } }
  return {
    id: 'test',
    name: 'Test',
    seed: 1,
    participantCount: 2,
    cells,
    territories: Array.from({ length: size }, () => Array.from({ length: size }, (_, column) => column < size / 2 ? 'region-0' : 'region-1')),
    regions: [
      { id: 'region-0', index: 0, color: '#d2b45f', center: { column: 1, row: 1 }, validCastleCells: [], reservedBuildSites: { plain: { column: 1, row: 1 }, hill: { column: 1, row: 1 }, extra: { column: 1, row: 1 } }, score: { cells: size * size / 2, forest: 0, hills: 0, quality: size * size / 2 } },
      { id: 'region-1', index: 1, color: '#6f9c83', center: { column: npcCastleColumn, row: 1 }, validCastleCells: [], reservedBuildSites: { plain: { column: npcCastleColumn, row: 1 }, hill: { column: npcCastleColumn, row: 1 }, extra: { column: npcCastleColumn, row: 1 } }, score: { cells: size * size / 2, forest: 0, hills: 0, quality: size * size / 2 } },
    ],
    participants: [
      { id: 'player', kind: 'human', regionId: 'region-0', color: '#d2b45f' },
      { id: 'npc-2', kind: 'npc', regionId: 'region-1', color: '#6f9c83' },
    ],
  }
}

function placeBuilding(scenario: MapScenario, kind: BuildingKind, column: number, row: number, ownerId = 'player') {
  const rule = buildingRules[kind]
  const footprint = rule.footprint
  const object = {
    type: 'building' as const,
    kind,
    ownerId,
    hitPoints: rule.hitPoints,
    maxHitPoints: rule.hitPoints,
    footprint: footprint ? { originColumn: column, originRow: row, ...footprint } : undefined,
  }
  buildingFootprintPositions(kind, { column, row }).forEach((position) => {
    scenario.cells[position.row][position.column] = { ...scenario.cells[position.row][position.column], object }
  })
}

function removePlayerCastle(scenario: MapScenario) {
  scenario.cells[1][1] = { ...scenario.cells[1][1], object: undefined }
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
    expect(startingResources.iron).toBe((troopRules.knights.resourceCost.iron ?? 0) * 2)
    expect(startingResources.ore).toBe(0)
    expect(buildingRules.quarry.production).toEqual({ stone: 12 })
    expect(buildingRules.mine.production).toEqual({ ore: 6 })
    expect(buildingRules.smelter).toMatchObject({ actionCost: 4, resourceCost: { wood: 32, stone: 28, gold: 24 }, processing: { input: 'ore', output: 'iron', maximumPerTurn: 5 }, hitPoints: 22, footprint: { columns: 2, rows: 2 } })
    expect(buildingRules.smelter.upkeep).toBeUndefined()
    expect(buildingRules.kitchen).toMatchObject({ actionCost: 4, resourceCost: { wood: 20, stone: 12, gold: 8 }, workersRequired: 1, foodServiceCapacity: 20, hitPoints: 14 })
    expect(buildingRules.lumberMill.workersRequired).toBe(1)
    expect(buildingRules.quarry.workersRequired).toBe(2)
    expect(buildingRules.mine.workersRequired).toBe(1)
    expect(buildingRules.smelter.workersRequired).toBe(2)
    expect(buildingRules.farm).toMatchObject({ resourceCost: { wood: 28, stone: 8, gold: 8 }, production: { grain: 18 }, workersRequired: 2 })
    expect(buildingRules.huntingLodge).toMatchObject({ actionCost: 4, resourceCost: { wood: 18, stone: 5, gold: 8 }, production: { meat: 6 }, hitPoints: 12, workersRequired: 1 })
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
    expect(productionFor(built.state, 'player').grain).toBe(22)
    expect(productionFor(built.state, 'player').meat).toBe(0)
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

  it('builds a quarry over four hill cells and produces only stone once', () => {
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
    expect(productionFor(quarry.state, 'player').iron).toBe(0)
  })

  it('builds a compact mine on a clear hill and produces ore', () => {
    const scenario = createScenario()
    scenario.cells[2][2] = { ...scenario.cells[2][2], elevation: .65, landform: 'hill' }
    const mine = build(createMatch(scenario), 'mine', { column: 2, row: 2 })
    expect(mine.ok).toBe(true)
    if (!mine.ok) return
    expect(mine.state.scenario.cells[2][2].object).toMatchObject({ type: 'building', kind: 'mine' })
    expect(mine.state.scenario.cells[2][3].object).toBeUndefined()
    expect(productionFor(mine.state, 'player').ore).toBe(6)
    expect(productionFor(mine.state, 'player').iron).toBe(0)
    expect(productionFor(mine.state, 'player').stone).toBe(0)
    expect(build(createMatch(createScenario()), 'mine', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })
  })

  it('processes at most five ore per staffed smelter without upkeep', () => {
    const built = build(createMatch(createScenario()), 'smelter', { column: 1, row: 3 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect([
      built.state.scenario.cells[3][1], built.state.scenario.cells[3][2],
      built.state.scenario.cells[4][1], built.state.scenario.cells[4][2],
    ].every((cell) => cell.object?.type === 'building' && cell.object.kind === 'smelter')).toBe(true)

    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'mine', 0, 2)
    placeBuilding(scenario, 'smelter', 1, 3)
    const match = createMatch(scenario)
    const player = { ...match.domains.player, taxRate: 'none' as const, resources: { ...match.domains.player.resources, ore: 4, iron: 0, gold: 2 } }
    const advanced = endTurn({ ...match, domains: { ...match.domains, player } })
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.domains.player.resources).toMatchObject({ ore: 5, iron: 5, gold: 2 })
    expect(upkeepFor(match, 'player').gold).toBe(0)
  })

  it('smelts without gold and receives taxes only after processing', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'smelter', 1, 3)
    const match = createMatch(scenario)
    const player = { ...match.domains.player, resources: { ...match.domains.player.resources, ore: 5, iron: 0, gold: 0 } }
    const advanced = endTurn({ ...match, domains: { ...match.domains, player } })
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.domains.player.resources).toMatchObject({ ore: 0, iron: 5, gold: 6 })
  })

  it('keeps the ore-to-iron market loop at a limited five-gold margin', () => {
    expect(marketPrices.ore).toEqual({ buy: 5, sell: 3 })
    expect(marketPrices.iron).toEqual({ buy: 10, sell: 6 })
    expect(marketPrices.iron.buy).toBe(Math.max(...Object.values(marketPrices).map(({ buy }) => buy)))
    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'smelter', 0, 3)
    placeBuilding(scenario, 'market', 3, 3)
    const match = createMatch(scenario)
    const player = { ...match.domains.player, taxRate: 'none' as const, resources: { ...match.domains.player.resources, ore: 0, iron: 0, gold: 25 } }
    const bought = trade({ ...match, domains: { ...match.domains, player } }, { column: 3, row: 3 }, 'ore', 'buy', 5)
    expect(bought.ok).toBe(true)
    if (!bought.ok) return
    const advanced = endTurn(bought.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.domains.player.resources).toMatchObject({ ore: 0, iron: 5, gold: 0 })
    const sold = trade(advanced.state, { column: 3, row: 3 }, 'iron', 'sell', 5)
    expect(sold.ok).toBe(true)
    if (!sold.ok) return
    expect(sold.state.domains.player.resources.gold).toBe(30)
  })

  it('builds a lumber mill on clear passable ground beside a forest', () => {
    expect(buildingRules.lumberMill.footprint).toBeUndefined()
    expect(buildingRules.lumberMill.resourceCost).toEqual({ wood: 14, stone: 5, gold: 5 })
    expect(buildingRules.lumberMill.production).toEqual({ wood: 16 })
    const scenario = createScenario()
    scenario.cells[2][3] = { ...scenario.cells[2][3], vegetation: true }
    const lumberMill = build(createMatch(scenario), 'lumberMill', { column: 2, row: 2 })
    expect(lumberMill.ok).toBe(true)
    if (!lumberMill.ok) return
    expect(lumberMill.state.scenario.cells[2][2]).toMatchObject({ vegetation: false, object: { type: 'building', kind: 'lumberMill' } })
    expect(lumberMill.state.scenario.cells[2][3].object).toBeUndefined()
    expect(lumberMill.state.ordersRemaining).toBe(4)
    expect(productionFor(lumberMill.state, 'player').wood).toBe(16)
    expect(build(createMatch(scenario), 'lumberMill', { column: 3, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })
    expect(build(createMatch(createScenario()), 'lumberMill', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })

    const diagonalForest = createScenario()
    diagonalForest.cells[3][3] = { ...diagonalForest.cells[3][3], vegetation: true }
    expect(build(createMatch(diagonalForest), 'lumberMill', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })

    const occupiedSite = createScenario()
    occupiedSite.cells[2][3] = { ...occupiedSite.cells[2][3], vegetation: true }
    occupiedSite.cells[2][2] = { ...occupiedSite.cells[2][2], object: { type: 'building', kind: 'wall', ownerId: 'player', hitPoints: 50, maxHitPoints: 50 } }
    expect(build(createMatch(occupiedSite), 'lumberMill', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'occupied' })
  })

  it('scales farm production for two, one and zero assigned workers', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    const farm = build(createMatch(scenario), 'farm', { column: 2, row: 2 })
    if (!farm.ok) throw new Error('farm building failed')
    expect(productionFor(farm.state, 'player')).toMatchObject({ grain: 18, meat: 0 })
    const oneWorker = { ...farm.state, domains: { ...farm.state.domains, player: { ...farm.state.domains.player, population: 1 } } }
    const noWorkers = { ...farm.state, domains: { ...farm.state.domains, player: { ...farm.state.domains.player, population: 0 } } }
    expect(productionFor(oneWorker, 'player').grain).toBe(9)
    expect(productionFor(noWorkers, 'player').grain).toBe(0)
  })

  it('builds and staffs a hunting lodge only beside at least two forest cells', () => {
    const scenario = createScenario()
    scenario.cells[2][1] = { ...scenario.cells[2][1], vegetation: true }
    scenario.cells[2][3] = { ...scenario.cells[2][3], vegetation: true }
    const lodge = build(createMatch(scenario), 'huntingLodge', { column: 2, row: 2 })
    expect(lodge.ok).toBe(true)
    if (!lodge.ok) return
    expect(lodge.state.scenario.cells[2][2]).toMatchObject({ vegetation: false, object: { type: 'building', kind: 'huntingLodge', hitPoints: 12 } })
    expect(lodge.state.ordersRemaining).toBe(4)
    expect(productionFor(lodge.state, 'player').meat).toBe(6)
    expect(upkeepFor(lodge.state, 'player').meat).toBe(0)
    const meatBeforeTurn = humanDomain(lodge.state).resources.meat
    const advanced = endTurn(lodge.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(humanDomain(advanced.state).resources.meat).toBe(meatBeforeTurn + 4)
    const noWorker = { ...lodge.state, domains: { ...lodge.state.domains, player: { ...lodge.state.domains.player, population: 0 } } }
    expect(productionFor(noWorker, 'player').meat).toBe(0)

    const oneForest = createScenario()
    oneForest.cells[2][1] = { ...oneForest.cells[2][1], vegetation: true }
    expect(build(createMatch(oneForest), 'huntingLodge', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })
    scenario.cells[2][2] = { ...scenario.cells[2][2], vegetation: true }
    expect(build(createMatch(scenario), 'huntingLodge', { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-terrain' })
  })

  it('assigns workers to farms, then hunting lodges, in coordinate order', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'farm', 2, 3)
    placeBuilding(scenario, 'farm', 0, 3)
    placeBuilding(scenario, 'huntingLodge', 4, 3)
    const match = createMatch(scenario)
    const fourPeople = { ...match, domains: { ...match.domains, player: { ...match.domains.player, population: 4 } } }
    expect(workforceFor(fourPeople, 'player')).toMatchObject({ employed: 4, free: 0, assignments: [
      { kind: 'farm', position: { column: 0, row: 3 }, assigned: 2, required: 2 },
      { kind: 'farm', position: { column: 2, row: 3 }, assigned: 2, required: 2 },
      { kind: 'huntingLodge', position: { column: 4, row: 3 }, assigned: 0, required: 1 },
    ] })
    const threePeople = { ...match, domains: { ...match.domains, player: { ...match.domains.player, population: 3 } } }
    expect(workforceFor(threePeople, 'player').assignments.map(({ assigned }) => assigned)).toEqual([2, 1, 0])
    const fivePeople = { ...match, domains: { ...match.domains, player: { ...match.domains.player, population: 5 } } }
    expect(workforceFor(fivePeople, 'player')).toMatchObject({ employed: 5, free: 0 })
    expect(productionFor(fivePeople, 'player')).toMatchObject({ grain: 36, meat: 6 })
  })

  it('staffs food, kitchens and industry in a deterministic priority order', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    placeBuilding(scenario, 'farm', 0, 3)
    placeBuilding(scenario, 'huntingLodge', 2, 3)
    placeBuilding(scenario, 'kitchen', 3, 3)
    placeBuilding(scenario, 'lumberMill', 0, 5)
    placeBuilding(scenario, 'quarry', 1, 5)
    placeBuilding(scenario, 'mine', 3, 5)
    placeBuilding(scenario, 'smelter', 4, 5)
    const match = createMatch(scenario)
    const eightWorkers = { ...match, domains: { ...match.domains, player: { ...match.domains.player, population: 8, resources: { ...match.domains.player.resources, ore: 10 } } } }
    expect(workforceFor(eightWorkers, 'player').assignments.map(({ kind, assigned }) => ({ kind, assigned }))).toEqual([
      { kind: 'farm', assigned: 2 }, { kind: 'huntingLodge', assigned: 1 }, { kind: 'kitchen', assigned: 1 },
      { kind: 'lumberMill', assigned: 1 }, { kind: 'quarry', assigned: 2 }, { kind: 'mine', assigned: 1 }, { kind: 'smelter', assigned: 0 },
    ])
    expect(productionFor(eightWorkers, 'player')).toMatchObject({ grain: 18, meat: 6, wood: 16, stone: 12, ore: 6 })
    const nineWorkers = { ...eightWorkers, domains: { ...eightWorkers.domains, player: { ...eightWorkers.domains.player, population: 9 } } }
    const advanced = endTurn(nineWorkers)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.domains.player.resources.iron).toBe(startingResources.iron + 2)
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
    expect(foodServiceCapacityFor(house.state, 'player')).toBe(40)
    expect(civilianHousingCapacityFor(house.state, 'player')).toBe(30)
    expect(civilianPopulationCapacityFor(house.state, 'player')).toBe(30)
    const unstaffed = { ...house.state, domains: { ...house.state.domains, player: { ...house.state.domains.player, population: 0 } } }
    expect(foodServiceCapacityFor(unstaffed, 'player')).toBe(20)

    const crowded = { ...house.state, ordersRemaining: 8, domains: { ...house.state.domains, player: { ...house.state.domains.player, population: 25 } } }
    const removed = demolish(crowded, { column: 3, row: 5 })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(foodServiceCapacityFor(removed.state, 'player')).toBe(20)
    const advanced = endTurn(removed.state)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.domains.player.population).toBe(24)
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
    const recruited = recruit(createMatch(createScenario()), 'knights', 2, { column: 1, row: 2 })
    expect(recruited.ok).toBe(true)
    if (!recruited.ok) return
    expect(recruited.state.ordersRemaining).toBe(6)
    expect(troopTotals(recruited.state, 'player').knights).toBe(2)
    const moved = moveOrAttack(recruited.state, { column: 1, row: 2 }, { column: 2, row: 2 })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.state.ordersRemaining).toBe(4)
    expect(turnResourceDeltaFor(moved.state, 'player').gold).toBe(2)
  })

  it('doubles movement cost when a squad enters a forest cell', () => {
    const ordinaryScenario = createScenario()
    ordinaryScenario.cells[2][1] = { ...ordinaryScenario.cells[2][1], object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } } }
    ordinaryScenario.cells[2][2] = { ...ordinaryScenario.cells[2][2], vegetation: true }
    const ordinaryMove = moveOrAttack(createMatch(ordinaryScenario), { column: 1, row: 2 }, { column: 2, row: 2 })
    expect(ordinaryMove.ok).toBe(true)
    if (!ordinaryMove.ok) return
    expect(ordinaryMove.state.ordersRemaining).toBe(6)

    const knightScenario = createScenario()
    knightScenario.cells[2][1] = { ...knightScenario.cells[2][1], object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 0, knights: 1 } } }
    knightScenario.cells[2][2] = { ...knightScenario.cells[2][2], vegetation: true }
    const knightMove = moveOrAttack(createMatch(knightScenario), { column: 1, row: 2 }, { column: 2, row: 2 })
    expect(knightMove.ok).toBe(true)
    if (!knightMove.ok) return
    expect(knightMove.state.ordersRemaining).toBe(4)

    expect(moveOrAttack({ ...createMatch(ordinaryScenario), ordersRemaining: 1 }, { column: 1, row: 2 }, { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'not-enough-orders' })
    expect(moveOrAttack({ ...createMatch(knightScenario), ordersRemaining: 3 }, { column: 1, row: 2 }, { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'not-enough-orders' })
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
    expect(turnResourceDeltaFor(church.state, 'player').grain).toBe(2)
    expect(turnResourceDeltaFor(church.state, 'player').meat).toBe(-2)
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

  it('lets archers attack up to eight clear cells away without moving', () => {
    const scenario = createScenario()
    scenario.cells[0][0] = { ...scenario.cells[0][0], object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 5, knights: 0 } } }
    scenario.cells[0][8] = { elevation: 0.2, landform: 'plain', vegetation: false, object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    const result = moveOrAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 8, row: 0 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ordersRemaining).toBe(7)
    expect(result.state.scenario.cells[0][0].object).toMatchObject({ type: 'squad', ownerId: 'player' })
    expect(result.state.scenario.cells[0][8].object).toMatchObject({ type: 'building', hitPoints: 7 })
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
    scenario.cells[0][8] = { elevation: 0.2, landform: 'plain', vegetation: false, object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    expect(moveOrAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 8, row: 0 })).toMatchObject({ ok: false, reason: 'ranged-shot-blocked' })
    scenario.cells[0][2] = { ...scenario.cells[0][2], vegetation: false }
    scenario.cells[0][9] = { elevation: 0.2, landform: 'plain', vegetation: false, object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    expect(moveOrAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 9, row: 0 })).toMatchObject({ ok: false, reason: 'out-of-range' })
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

  it('balances ordinary food consumption between grain and meat and falls back to either resource', () => {
    const match = createMatch(createScenario())
    const untaxed = setTaxRate(match, 'none')
    if (!untaxed.ok) throw new Error('tax change failed')
    expect(foodConsumptionFor(untaxed.state, 'player', { grain: 10, meat: 10 })).toEqual({ grain: 2, meat: 1, fed: true, diverseDiet: true })
    const largerScenario = createScenario()
    placeBuilding(largerScenario, 'kitchen', 2, 3)
    const largerMatch = createMatch(largerScenario)
    const largerPopulation = { ...largerMatch, domains: { ...largerMatch.domains, player: { ...largerMatch.domains.player, taxRate: 'none' as const, population: 32 } } }
    expect(foodConsumptionFor(largerPopulation, 'player', { grain: 10, meat: 10 })).toEqual({ grain: 4, meat: 4, fed: true, diverseDiet: true })
    expect(foodConsumptionFor(untaxed.state, 'player', { grain: 10, meat: 0 })).toEqual({ grain: 3, meat: 0, fed: true, diverseDiet: false })
    expect(foodConsumptionFor(untaxed.state, 'player', { grain: 0, meat: 10 })).toEqual({ grain: 0, meat: 3, fed: true, diverseDiet: false })
  })

  it('allows either food resource to satisfy the additional tax demand', () => {
    const match = createMatch(createScenario())
    expect(foodConsumptionFor(match, 'player', { grain: 1, meat: 10 })).toEqual({ grain: 1, meat: 3, fed: true, diverseDiet: true })
    expect(foodConsumptionFor(match, 'player', { grain: 0, meat: 10 })).toEqual({ grain: 0, meat: 4, fed: true, diverseDiet: false })
  })

  it('gains and loses the varied-diet bonus without stacking it', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    const initial = createMatch(scenario)
    const player = { ...initial.domains.player, taxRate: 'none' as const, resources: { ...initial.domains.player.resources, grain: 10, meat: 10 } }
    const fed = endTurn({ ...initial, domains: { ...initial.domains, player } })
    expect(fed.ok).toBe(true)
    if (!fed.ok) return
    expect(fed.state.domains.player.diverseDiet).toBe(true)
    expect(civilianHousingCapacityFor(fed.state, 'player')).toBe(gameConfig.turn.basePopulationCapacity + gameConfig.economy.diverseDietPopulationCapacityBonus)
    expect(civilianPopulationCapacityFor(fed.state, 'player')).toBe(gameConfig.economy.castleFoodServiceCapacity)

    const withoutMeat = { ...fed.state.domains.player, resources: { ...fed.state.domains.player.resources, grain: 10, meat: 0 } }
    const lost = endTurn({ ...fed.state, domains: { ...fed.state.domains, player: withoutMeat } })
    expect(lost.ok).toBe(true)
    if (!lost.ok) return
    expect(lost.state.domains.player.diverseDiet).toBe(false)
    expect(civilianHousingCapacityFor(lost.state, 'player')).toBe(gameConfig.turn.basePopulationCapacity)
  })

  it('applies the varied-diet damage bonus to every owned squad attack', () => {
    const scenario = createScenario()
    scenario.cells[4][4] = { ...scenario.cells[4][4], object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0, knights: 0 } } }
    scenario.cells[4][5] = { ...scenario.cells[4][5], object: { type: 'building', kind: 'house', ownerId: 'npc-2', hitPoints: 50, maxHitPoints: 50 } }
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
    placeBuilding(scenario, 'farm', 0, 3)
    placeBuilding(scenario, 'farm', 2, 3)
    scenario.cells[7][7] = { ...scenario.cells[7][7], object: { type: 'squad', ownerId: 'player', units: { militia: 100, spearmen: 0, archers: 0, knights: 0 } } }
    const match = createMatch(scenario)
    const player = { ...match.domains.player, population: 3, taxRate: 'none' as const, resources: { ...match.domains.player.resources, grain: 0, meat: 0 } }
    expect(workforceFor({ ...match, domains: { ...match.domains, player } }, 'player').assignments.map(({ assigned }) => assigned)).toEqual([2, 1])
    const starved = endTurn({ ...match, domains: { ...match.domains, player } })
    expect(starved.ok).toBe(true)
    if (!starved.ok) return
    expect(starved.state.domains.player.population).toBe(2)
    expect(workforceFor(starved.state, 'player').assignments.map(({ assigned }) => assigned)).toEqual([2, 0])
  })

  it('removes a troop deterministically when no civilians remain and preserves one last inhabitant', () => {
    const scenario = createScenario()
    removePlayerCastle(scenario)
    scenario.cells[0][0] = { ...scenario.cells[0][0], object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 1, archers: 0, knights: 0 } } }
    scenario.cells[0][1] = { ...scenario.cells[0][1], object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } } }
    const match = createMatch(scenario)
    const player = { ...match.domains.player, population: 0, taxRate: 'none' as const, resources: { ...match.domains.player.resources, grain: 0, meat: 0 } }
    const starved = endTurn({ ...match, domains: { ...match.domains, player } })
    expect(starved.ok).toBe(true)
    if (!starved.ok) return
    expect(starved.state.scenario.cells[0][0].object).toMatchObject({ type: 'squad', units: { militia: 0, spearmen: 1 } })
    expect(starved.state.scenario.cells[0][1].object).toMatchObject({ type: 'squad', units: { militia: 1 } })

    const oneLeftScenario = createScenario()
    removePlayerCastle(oneLeftScenario)
    oneLeftScenario.cells[0][0] = { ...oneLeftScenario.cells[0][0], object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } } }
    const oneLeftMatch = createMatch(oneLeftScenario)
    const lastPlayer = { ...oneLeftMatch.domains.player, population: 0, taxRate: 'none' as const, resources: { ...oneLeftMatch.domains.player.resources, grain: 0, meat: 0 } }
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
    expect(productionFor(restored, 'player').meat).toBe(6)
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
    expect(civilianHousingCapacityFor(state, 'player')).toBe(gameConfig.turn.basePopulationCapacity + 10 + gameConfig.economy.diverseDietPopulationCapacityBonus)
    expect(humanDomain(state).population).toBe(gameConfig.turn.startingPopulation + 6)
    expect(foodDemandFor(state, 'player')).toBeGreaterThan(initialDemand)
  })

  it('derives housing from living houses and reduces over-capacity population by only one per turn', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'kitchen', 5, 5)
    const match = createMatch(scenario)
    const house = build(match, 'house', { column: 2, row: 2 })
    if (!house.ok) throw new Error('house building failed')
    expect(civilianHousingCapacityFor(house.state, 'player')).toBe(30)
    const removed = demolish(house.state, { column: 2, row: 2 })
    if (!removed.ok) throw new Error('house demolition failed')
    expect(civilianHousingCapacityFor(removed.state, 'player')).toBe(20)

    const overCapacity = {
      ...removed.state,
      domains: {
        ...removed.state.domains,
        player: {
          ...removed.state.domains.player,
          population: 30,
          taxRate: 'none' as const,
          resources: { ...removed.state.domains.player.resources, grain: 100, meat: 100 },
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
    scenario.cells[2][1] = { ...scenario.cells[2][1], object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0, knights: 0 } } }
    scenario.cells[2][2] = { ...scenario.cells[2][2], object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0, knights: 0 } } }
    const match = createMatch(scenario)
    match.domains.player.population = 0
    match.domains.player.taxRate = 'none'
    match.domains.player.resources.grain = 100
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
    scenario.cells[4][4] = { ...scenario.cells[4][4], object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } } }
    const match = createMatch(scenario)
    expect(civilianHousingCapacityFor(match, 'npc-2')).toBe(30)
    const attacked = moveOrAttack(match, { column: 4, row: 4 }, { column: 5, row: 4 })
    if (!attacked.ok) throw new Error('attack failed')
    expect(civilianHousingCapacityFor(attacked.state, 'npc-2')).toBe(20)
  })

  it('collects taxes before upkeep and deserts exactly one cheapest troop on a deficit', () => {
    const paidScenario = createScenario()
    paidScenario.cells[2][1] = { ...paidScenario.cells[2][1], object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 4, archers: 0, knights: 0 } } }
    const paidMatch = createMatch(paidScenario)
    paidMatch.domains.player.resources.gold = 0
    const paid = endTurn(paidMatch)
    if (!paid.ok) throw new Error('turn failed')
    expect(paid.state.lastTurnReports.player).toMatchObject({ taxIncome: 6, upkeepPaid: true, desertion: null })
    expect(troopTotals(paid.state, 'player').spearmen).toBe(4)

    const deficitScenario = createScenario()
    deficitScenario.cells[2][1] = { ...deficitScenario.cells[2][1], object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 1 } } }
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
    scenario.cells[2][1] = { ...scenario.cells[2][1], object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 0, knights: 1 } } }
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
    scenario.cells[4][3] = { ...scenario.cells[4][3], object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 0, knights: 1 } } }
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
        scenario.cells[row][column] = { ...scenario.cells[row][column], object: { type: 'squad', ownerId: 'player', units: { militia: amount, spearmen: 0, archers: 0, knights: 0 } } }
        remaining -= amount
      }
    }
    const match = createMatch(scenario)
    expect(totalArmySize(match)).toBe(100)
    expect(recruit(match, 'militia', 1, { column: 1, row: 2 })).toMatchObject({ ok: false, reason: 'army-full' })
  })

  it('dismisses only a strict partial integer composition for two orders', () => {
    const scenario = createScenario()
    scenario.cells[2][1] = { ...scenario.cells[2][1], object: { type: 'squad', ownerId: 'player', units: { militia: 6, spearmen: 0, archers: 0, knights: 0 }, health: 6 } }
    const match = createMatch(scenario)
    const dismissed = dismissSquad(match, { column: 1, row: 2 }, { militia: 2, spearmen: 0, archers: 0, knights: 0 })
    if (!dismissed.ok) throw new Error('dismiss failed')
    expect(dismissed.state.ordersRemaining).toBe(6)
    expect(dismissed.state.domains.player.population).toBe(gameConfig.turn.startingPopulation + 2)
    expect(dismissed.state.scenario.cells[2][1].object).toMatchObject({ type: 'squad', units: { militia: 4 }, health: 4 })
    expect(dismissSquad(match, { column: 1, row: 2 }, { militia: 6, spearmen: 0, archers: 0, knights: 0 })).toMatchObject({ ok: false, reason: 'invalid-squad' })
    expect(dismissSquad(match, { column: 1, row: 2 }, { militia: Number.NaN, spearmen: 0, archers: 0, knights: 0 })).toMatchObject({ ok: false, reason: 'invalid-squad' })
    expect(splitSquad(match, { column: 1, row: 2 }, { column: 2, row: 2 }, { militia: 1.5, spearmen: 0, archers: 0, knights: 0 })).toMatchObject({ ok: false, reason: 'invalid-squad' })
  })

  it('moves up to five archers into a tower, exits only to an empty cell and protects an occupied tower from demolition', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'tower', 2, 2)
    scenario.cells[1][2] = { ...scenario.cells[1][2], object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 1, archers: 7, knights: 1 } } }
    const entered = garrisonTower(createMatch(scenario), { column: 2, row: 1 }, { column: 2, row: 2 })
    if (!entered.ok) throw new Error('garrison failed')
    expect(entered.state.ordersRemaining).toBe(6)
    expect(entered.state.scenario.cells[2][2].object).toMatchObject({ type: 'building', kind: 'tower', garrison: { archers: 5, health: 5 } })
    expect(entered.state.scenario.cells[1][2].object).toMatchObject({ type: 'squad', units: { militia: 1, spearmen: 1, archers: 2, knights: 1 }, health: 6.85 })
    expect(demolish(entered.state, { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'cannot-demolish' })

    entered.state.scenario.cells[2][3] = { ...entered.state.scenario.cells[2][3], object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } } }
    expect(ungarrisonTower(entered.state, { column: 2, row: 2 }, { column: 3, row: 2 })).toMatchObject({ ok: false, reason: 'occupied' })
    const exited = ungarrisonTower(entered.state, { column: 2, row: 2 }, { column: 1, row: 2 })
    if (!exited.ok) throw new Error('ungarrison failed')
    expect(exited.state.scenario.cells[2][1].object).toMatchObject({ type: 'squad', units: { archers: 5 }, health: 5 })
    expect(exited.state.scenario.cells[2][2].object).toMatchObject({ type: 'building', kind: 'tower', garrison: undefined })
    expect(demolish(exited.state, { column: 2, row: 2 }).ok).toBe(true)

    const invalidScenario = createScenario()
    placeBuilding(invalidScenario, 'tower', 2, 2)
    invalidScenario.cells[1][2] = { ...invalidScenario.cells[1][2], object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 1.5, knights: 0 } } }
    expect(garrisonTower(createMatch(invalidScenario), { column: 2, row: 1 }, { column: 2, row: 2 })).toMatchObject({ ok: false, reason: 'invalid-squad' })
  })

  it('lets a plain-ground tower fire with its fixed height bonus and kills its garrison when destroyed', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'tower', 0, 0)
    const tower = scenario.cells[0][0].object
    if (tower?.type !== 'building') throw new Error('tower missing')
    scenario.cells[0][0] = { ...scenario.cells[0][0], object: { ...tower, garrison: { archers: 5, health: 5 } } }
    scenario.cells[0][7] = { ...scenario.cells[0][7], object: { type: 'building', kind: 'farm', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    const fired = towerAttack(createMatch(scenario), { column: 0, row: 0 }, { column: 7, row: 0 })
    if (!fired.ok) throw new Error('tower attack failed')
    expect(fired.state.ordersRemaining).toBe(7)
    expect(fired.state.scenario.cells[0][7].object).toMatchObject({ hitPoints: 7 })

    const destructionScenario = createScenario()
    placeBuilding(destructionScenario, 'tower', 5, 4, 'npc-2')
    const enemyTower = destructionScenario.cells[4][5].object
    if (enemyTower?.type !== 'building') throw new Error('enemy tower missing')
    destructionScenario.cells[4][5] = { ...destructionScenario.cells[4][5], object: { ...enemyTower, hitPoints: 1, garrison: { archers: 5, health: 5 } } }
    destructionScenario.cells[4][4] = { ...destructionScenario.cells[4][4], object: { type: 'squad', ownerId: 'player', units: { militia: 1, spearmen: 0, archers: 0, knights: 0 } } }
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
    atMaximum.cells[0][10] = { ...atMaximum.cells[0][10], object: { type: 'building', kind: 'house', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    expect(towerAttack(createMatch(atMaximum), { column: 0, row: 0 }, { column: 10, row: 0 }).ok).toBe(true)

    const adjacent = createScenario(12)
    placeBuilding(adjacent, 'tower', 0, 0)
    const adjacentTower = adjacent.cells[0][0].object
    if (adjacentTower?.type !== 'building') throw new Error('tower missing')
    adjacent.cells[0][0] = { ...adjacent.cells[0][0], object: { ...adjacentTower, garrison: { archers: 1, health: 1 } } }
    adjacent.cells[0][1] = { ...adjacent.cells[0][1], object: { type: 'building', kind: 'house', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    adjacent.cells[0][11] = { ...adjacent.cells[0][11], object: { type: 'building', kind: 'house', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    expect(towerAttack(createMatch(adjacent), { column: 0, row: 0 }, { column: 1, row: 0 }).ok).toBe(true)
    expect(towerAttack(createMatch(adjacent), { column: 0, row: 0 }, { column: 11, row: 0 })).toMatchObject({ ok: false, reason: 'out-of-range' })

    const blocked = createScenario(12)
    placeBuilding(blocked, 'tower', 0, 0)
    const blockedTower = blocked.cells[0][0].object
    if (blockedTower?.type !== 'building') throw new Error('tower missing')
    blocked.cells[0][0] = { ...blocked.cells[0][0], object: { ...blockedTower, garrison: { archers: 1, health: 1 } } }
    blocked.cells[0][5] = { ...blocked.cells[0][5], vegetation: true }
    blocked.cells[0][10] = { ...blocked.cells[0][10], object: { type: 'building', kind: 'house', ownerId: 'npc-2', hitPoints: 10, maxHitPoints: 10 } }
    expect(towerAttack(createMatch(blocked), { column: 0, row: 0 }, { column: 10, row: 0 })).toMatchObject({ ok: false, reason: 'ranged-shot-blocked' })
  })

  it('removes housing immediately after a ranged house destruction', () => {
    const scenario = createScenario()
    placeBuilding(scenario, 'house', 7, 4, 'npc-2')
    const house = scenario.cells[4][7].object
    if (house?.type !== 'building') throw new Error('house missing')
    scenario.cells[4][7] = { ...scenario.cells[4][7], object: { ...house, hitPoints: 1 } }
    scenario.cells[4][0] = { ...scenario.cells[4][0], object: { type: 'squad', ownerId: 'player', units: { militia: 0, spearmen: 0, archers: 1, knights: 0 }, health: 1 } }
    const match = createMatch(scenario)
    expect(civilianHousingCapacityFor(match, 'npc-2')).toBe(30)
    const attacked = moveOrAttack(match, { column: 0, row: 4 }, { column: 7, row: 4 })
    if (!attacked.ok) throw new Error('ranged attack failed')
    expect(civilianHousingCapacityFor(attacked.state, 'npc-2')).toBe(20)
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
    scenario.cells[4][4] = { ...scenario.cells[4][4], object: { type: 'squad', ownerId: 'player', units: { militia: 10, spearmen: 0, archers: 0, knights: 0 } } }
    scenario.cells[4][5] = { ...scenario.cells[4][5], object: { type: 'building', kind: 'barbican', ownerId: 'npc-2', hitPoints: 20, maxHitPoints: 20 } }
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
    expect(moveOrAttack(createMatch(enemyGate), { column: 1, row: 4 }, { column: 3, row: 4 })).toMatchObject({ ok: false, reason: 'not-adjacent' })
  })
})
