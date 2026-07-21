import { describe, expect, it } from 'vitest'
import { aiProfiles } from '../../config/ai'
import { buildingRules, troopRules } from '../../config/rules'
import type { BuildingKind } from '../map'
import { buildingFootprintPositions, createMatch, demolish, endTurn, trade, turnEconomyForecastFor, upkeepFor } from '../match'
import type { AiProfileId } from '../scenario'
import type { AiCommand } from './model'
import { createAiMemory } from './model'
import { analyzeAiWorld, createSettlementPlan } from './analysis'
import { desiredBuildingGoals, marketCandidate, strategicCandidates } from './strategy'
import {
  createEconomicScenario,
  createFortressConstructionState,
  placeTestBuilding,
  placeTestSquad,
  startAiTurn,
  type EconomicTerrain,
} from './testing/scenarioFixtures'
import { runAiScenario, type ScenarioRun } from './testing/scenarioHarness'

interface EconomyCase {
  profileId: AiProfileId
  terrain: EconomicTerrain
  description: string
}

const cases: EconomyCase[] = [
  { profileId: 'radomir', terrain: 'open', description: 'open plain' },
  { profileId: 'velislava', terrain: 'woodland', description: 'forest with authored clearings' },
  { profileId: 'svyatobor', terrain: 'highland', description: 'narrow highland basin' },
]

const tacticalCommandTypes = new Set<AiCommand['type']>([
  'move-or-attack',
  'split',
  'garrison',
  'ungarrison',
  'tower-attack',
])

const economyOnlyForbiddenCommandTypes = new Set<AiCommand['type']>([
  ...tacticalCommandTypes,
  'recruit',
])

function buildEvents(run: ScenarioRun) {
  return run.turns.flatMap((turn) => turn.executed.flatMap((command) => (
    command.type === 'build' ? [{ turn: turn.turn, kind: command.building, position: command.position }] : []
  )))
}

function tradeEvents(run: ScenarioRun) {
  return run.turns.flatMap((turn) => turn.executed.flatMap((command) => (
    command.type === 'trade' ? [{ turn: turn.turn, ...command }] : []
  )))
}

function demolitionEvents(run: ScenarioRun) {
  return run.turns.flatMap((turn) => turn.executed.flatMap((command) => (
    command.type === 'demolish' ? [{ turn: turn.turn, position: command.position }] : []
  )))
}

function behaviorSummary(testCase: EconomyCase | string, run: ScenarioRun) {
  const final = run.turns.at(-1)
  const populations = run.turns.map((turn) => turn.report.populationAfter)
  const ownerId = `ai-${typeof testCase === 'string' ? 'svyatobor' : testCase.profileId}`
  const reservedBuildingSites = run.state.aiMemory[ownerId]?.settlementPlan?.reservedBuildingSites
  return JSON.stringify({
    testCase,
    mode: run.mode,
    phases: run.turns.map((turn) => `${turn.turn}:${turn.phase}`),
    builds: buildEvents(run).map((event) => `${event.turn}:${event.kind}@${event.position.column},${event.position.row}`),
    demolitions: demolitionEvents(run),
    unhealthyTurns: run.turns.filter((turn) => !turn.report.food.fed || !turn.report.upkeepPaid)
      .map((turn) => ({ turn: turn.turn, fed: turn.report.food.fed, upkeepPaid: turn.report.upkeepPaid })),
    failures: run.turns.flatMap((turn) => turn.failures.map((failure) => ({ turn: turn.turn, ...failure }))),
    tacticalCommands: run.turns.flatMap((turn) => turn.executed.filter((command) => (
      tacticalCommandTypes.has(command.type)
    )).map((command) => ({ turn: turn.turn, command }))),
    population: {
      first: populations[0],
      peak: populations.length > 0 ? Math.max(...populations) : undefined,
      last: populations.at(-1),
    },
    finalBuildings: final?.buildingCounts,
    finalResources: run.state.domains[ownerId]?.resources,
    reservedBuildingSites,
    reservedBuildingOccupants: Object.entries(reservedBuildingSites ?? {}).map(([kind, origin]) => ({
      kind,
      origin,
      footprint: origin ? buildingFootprintPositions(kind as BuildingKind, origin).map((position) => {
        const object = run.state.scenario.cells[position.row]?.[position.column]?.object
        return { position, object: object?.type === 'building' ? object.kind : object?.type }
      }) : [],
    })),
    recentTrades: tradeEvents(run).slice(-20),
    planningRejections: run.turns.slice(-15).flatMap((turn) => turn.trace
      .filter((entry) => entry.rejectedReason)
      .map((entry) => ({ turn: turn.turn, factors: entry.factors, reason: entry.rejectedReason }))),
    fortificationTrace: run.turns.flatMap((turn) => turn.trace.filter((entry) => entry.factors.includes('fortification-plan'))
      .map((entry) => ({ turn: turn.turn, ...entry }))),
  })
}

function expectHealthyDeterministicRun(testCase: EconomyCase | string, run: ScenarioRun) {
  const summary = behaviorSummary(testCase, run)
  expect(run.turns.flatMap((turn) => turn.failures), summary).toEqual([])
  expect(run.turns.every((turn) => turn.planned.length === turn.executed.length), summary).toBe(true)
  expect(run.turns.every((turn) => turn.report.food.fed), summary).toBe(true)
  expect(run.turns.every((turn) => turn.report.upkeepPaid), summary).toBe(true)
  expect(run.turns.every((turn) => turn.executed.every((command) => (
    !tacticalCommandTypes.has(command.type)
  ))), summary).toBe(true)
}

function firstBuildTurn(events: ReturnType<typeof buildEvents>, kind: BuildingKind) {
  return events.find((event) => event.kind === kind)?.turn ?? Number.POSITIVE_INFINITY
}

describe('deterministic AI economy with combat waves disabled', () => {
  it('breaks the nine-of-ten population capacity deadlock with the next house', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    placeTestBuilding(state, ownerId, 'house', { column: 18, row: 8 })
    placeTestBuilding(state, ownerId, 'huntingLodge', { column: 18, row: 4 })
    placeTestBuilding(state, ownerId, 'huntingLodge', { column: 19, row: 4 })
    placeTestBuilding(state, ownerId, 'huntingLodge', { column: 20, row: 4 })
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      population: 9,
      resources: {
        ...state.domains[ownerId].resources,
        flour: 100, meat: 100, fruit: 100, gold: 200,
      },
    }
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing economic analysis')

    const memory = {
      ...createAiMemory(),
      settlementPlan: createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor),
    }
    const goals = desiredBuildingGoals(state, aiProfiles.svyatobor, analysis, memory, 'expansion')

    expect(goals.some((goal) => goal.kind === 'house' && goal.factors.includes('housing-slack')), JSON.stringify(goals)).toBe(true)
  })

  it.each(cases)('$profileId establishes food before starvation on $description', (testCase) => {
    const run = runAiScenario(
      createMatch(createEconomicScenario(testCase.profileId, testCase.terrain)),
      testCase.profileId,
      { turns: 6, mode: 'economy-only' },
    )
    const summary = behaviorSummary(testCase, run)
    const firstFoodTurn = run.turns.find((turn) => (
      turn.buildingCounts.farm + turn.buildingCounts.orchard + turn.buildingCounts.huntingLodge > 0
    ))?.turn

    expectHealthyDeterministicRun(testCase, run)
    expect(run.mode).toBe('economy-only')
    expect(run.turns.every((turn) => turn.executed.every((command) => (
      !economyOnlyForbiddenCommandTypes.has(command.type)
    ))), summary).toBe(true)
    expect(firstFoodTurn, summary).toBeLessThanOrEqual(2)
    expect(run.turns.at(-1)?.report.populationAfter, summary).toBeGreaterThanOrEqual(5)
  }, 30_000)

  it.each(cases)('$profileId develops a rich settlement on $description', (testCase) => {
    const run = runAiScenario(
      createMatch(createEconomicScenario(testCase.profileId, testCase.terrain)),
      testCase.profileId,
      // Svyatobor closes both the iron chain and the larger population
      // foundation; the broader opening is intentionally slower than the
      // simpler profiles rather than being fixture-funded.
      { turns: testCase.profileId === 'svyatobor' ? 65 : 30, mode: 'development-only' },
    )
    const summary = behaviorSummary(testCase, run)
    const events = buildEvents(run)
    const trades = tradeEvents(run)
    const finalBuildings = run.turns.at(-1)?.buildingCounts
    if (!finalBuildings) throw new Error('Missing final building ledger')
    const distinctBuildingKinds = Object.values(finalBuildings).filter((count) => count > 0).length
    const totalBuildings = Object.values(finalBuildings).reduce((sum, count) => sum + count, 0)
    const populationPeak = Math.max(...run.turns.map((turn) => turn.report.populationAfter))
    const firstConstructionTurn = events[0]?.turn ?? Number.POSITIVE_INFINITY
    const lastConstructionTurn = events.at(-1)?.turn ?? Number.NEGATIVE_INFINITY
    const hasDeliberateConstructionPause = run.turns.some((turn) => (
      turn.turn > firstConstructionTurn
        && turn.turn < lastConstructionTurn
        && !turn.executed.some((command) => command.type === 'build')
    ))

    expectHealthyDeterministicRun(testCase, run)
    expect(run.mode).toBe('development-only')
    expect(distinctBuildingKinds, summary).toBeGreaterThanOrEqual(6)
    expect(totalBuildings, summary).toBeGreaterThanOrEqual(10)
    expect(populationPeak, summary).toBeGreaterThanOrEqual(12)
    expect(finalBuildings.kitchen, summary).toBeGreaterThanOrEqual(1)
    expect(finalBuildings.house, summary).toBeGreaterThanOrEqual(3)
    expect(finalBuildings.barracks, summary).toBeGreaterThanOrEqual(1)
    expect(finalBuildings.market, summary).toBeGreaterThanOrEqual(1)
    expect(hasDeliberateConstructionPause, summary).toBe(true)

    if (testCase.profileId === 'radomir') {
      expect(finalBuildings.lumberMill, summary).toBeGreaterThanOrEqual(2)
      expect(finalBuildings.orchard, summary).toBeGreaterThanOrEqual(3)
      expect(run.turns.at(-1)?.report.populationAfter, summary).toBeGreaterThanOrEqual(12)
    } else if (testCase.profileId === 'velislava') {
      expect(finalBuildings.lumberMill, summary).toBeGreaterThanOrEqual(2)
      // Seeded woodland openings may lead with orchards or hunting lodges;
      // assert timely food and eventual diversification, not one build order.
      expect(Math.min(firstBuildTurn(events, 'huntingLodge'), firstBuildTurn(events, 'orchard')), summary)
        .toBeLessThanOrEqual(2)
      expect(firstBuildTurn(events, 'huntingLodge'), summary).toBeLessThan(firstBuildTurn(events, 'mill'))
      expect(finalBuildings.mill, summary).toBeGreaterThanOrEqual(1)
      // Woodland remains a mixed food economy: hunting and orchards carry
      // most of the load, so one supported farm is sufficient diversification.
      expect(finalBuildings.farm, summary).toBeGreaterThanOrEqual(1)
      expect(populationPeak, summary).toBeGreaterThanOrEqual(14)
    } else {
      expect(firstBuildTurn(events, 'quarry'), summary).toBeLessThan(firstBuildTurn(events, 'mine'))
      expect(firstBuildTurn(events, 'mine'), summary).toBeLessThan(firstBuildTurn(events, 'smelter'))
      expect(finalBuildings.quarry, summary).toBeGreaterThanOrEqual(2)
      expect(finalBuildings.mine, summary).toBeGreaterThanOrEqual(1)
      expect(finalBuildings.smelter, summary).toBeGreaterThanOrEqual(1)
      const knightIronCost = troopRules.knights.resourceCost.iron ?? 0
      const processedIron = run.turns.reduce((sum, turn) => sum + Math.max(0, turn.report.processing.iron), 0)
      expect(processedIron, summary).toBeGreaterThanOrEqual(knightIronCost)
      expect(run.state.domains['ai-svyatobor'].resources.iron, summary).toBeGreaterThanOrEqual(knightIronCost)
      expect(populationPeak, summary).toBeGreaterThanOrEqual(18)
      expect(trades.some((trade) => trade.direction === 'sell'
        && (trade.resource === 'stone' || trade.resource === 'ore')), summary).toBe(true)
      expect(trades.some((trade) => trade.direction === 'buy' && trade.resource === 'wood'), summary).toBe(true)
    }
  }, 60_000)

  it('raises Svyatobor taxes only when the food forecast can fund army upkeep, then lowers them after recovery', () => {
    const fixture = createFortressConstructionState('svyatobor', 'open')
    const started = endTurn(fixture.state)
    if (!started.ok) throw new Error(started.reason)
    const state = started.state
    const { ownerId, analysis } = fixture
    const memory = { ...state.aiMemory[ownerId], lastTaxChangeTurn: -10 }
    placeTestSquad(state, ownerId, { column: 12, row: 12 }, {
      militia: 0, spearmen: 0, archers: 0, knights: 10,
    })
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      population: 18,
      taxRate: 'moderate',
      resources: {
        ...state.domains[ownerId].resources,
        flour: 500, meat: 500, fruit: 500, gold: 30,
      },
    }

    const pressured = strategicCandidates(
      state, aiProfiles.svyatobor, analysis, memory, 'assault', () => true,
    )
    expect(pressured.find((candidate) => candidate.command.type === 'tax')?.command)
      .toEqual({ type: 'tax', rate: 'extortionate' })

    state.domains[ownerId] = {
      ...state.domains[ownerId],
      taxRate: 'extortionate',
      resources: { ...state.domains[ownerId].resources, gold: 5_000 },
    }
    const recovered = strategicCandidates(
      state, aiProfiles.svyatobor, analysis, memory, 'expansion', () => true,
    )
    expect(recovered.find((candidate) => candidate.command.type === 'tax')?.command)
      .toEqual({ type: 'tax', rate: 'moderate' })
  })

  it('liquidates valuable industrial surplus before bulk wood when upkeep is threatened', () => {
    const fixture = createFortressConstructionState('svyatobor', 'open')
    const started = endTurn(fixture.state)
    if (!started.ok) throw new Error(started.reason)
    const state = started.state
    const { ownerId, analysis } = fixture
    const memory = state.aiMemory[ownerId]
    const reinforcementSites = state.scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => (
      !cell.object && cell.landform !== 'peak' ? [{ column, row: rowIndex }] : []
    ))).slice(0, 4)
    reinforcementSites.forEach((position) => placeTestSquad(state, ownerId, position, {
      militia: 0, spearmen: 0, archers: 0, knights: 10,
    }))
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      taxRate: 'none',
      resources: {
        ...state.domains[ownerId].resources,
        wood: 1_000, stone: 1_000, iron: 100,
        flour: 500, meat: 500, fruit: 500, gold: 0,
      },
    }
    const candidate = marketCandidate(
      state, aiProfiles.svyatobor, 'recovery', memory, analysis, () => true,
    )
    expect(candidate?.command).toMatchObject({
      type: 'trade', resource: 'iron', direction: 'sell',
    })
    expect(candidate?.command.type === 'trade' ? candidate.command.quantity : 0).toBeGreaterThanOrEqual(5)
    if (candidate?.command.type !== 'trade') throw new Error('Expected an upkeep sale')
    const funded = trade(
      state,
      candidate.command.market,
      candidate.command.resource,
      candidate.command.direction,
      candidate.command.quantity,
    )
    expect(funded.ok).toBe(true)
    if (!funded.ok) throw new Error(funded.reason)
    expect(turnEconomyForecastFor(funded.state, ownerId)?.upkeepPaid).toBe(true)
  })

  it('does not spend the current army payroll on a discretionary barracks', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    placeTestSquad(state, ownerId, { column: 12, row: 12 }, {
      militia: 0, spearmen: 0, archers: 0, knights: 10,
    })
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      population: 12,
      taxRate: 'moderate',
      resources: {
        wood: 200, stone: 200, ore: 0, iron: 20,
        flour: 500, meat: 500, fruit: 500,
        gold: buildingRules.barracks.resourceCost.gold ?? 18,
      },
    }
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing payroll-reserve analysis')
    const memory = {
      ...createAiMemory(),
      settlementPlan: createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor),
    }
    const candidates = strategicCandidates(
      state, aiProfiles.svyatobor, analysis, memory, 'mobilization', () => true,
    )

    expect(candidates.some((candidate) => candidate.command.type === 'build'
      && candidate.command.building === 'barracks'), JSON.stringify(candidates)).toBe(false)
  })

  it('varies equivalent building sites by seed without weakening the economy', () => {
    const seeds = [91, 137, 223, 313, 419, 617, 773, 958]
    const runs = seeds.map((seed) => {
      const scenario = createEconomicScenario('radomir', 'open')
      scenario.id = `${scenario.id}-seed-${seed}`
      scenario.seed = seed
      return runAiScenario(createMatch(scenario), 'radomir', {
        turns: 18,
        mode: 'development-only',
      })
    })
    runs.forEach((run, index) => {
      const summary = behaviorSummary(`seed ${seeds[index]}`, run)
      expectHealthyDeterministicRun(`seed ${seeds[index]}`, run)
      expect(Object.values(run.turns.at(-1)?.buildingCounts ?? {})
        .reduce((sum, count) => sum + count, 0), summary).toBeGreaterThanOrEqual(8)
      expect(run.turns.at(-1)?.report.populationAfter, summary).toBeGreaterThanOrEqual(9)
    })
    const sitePlans = runs.map((run) => buildEvents(run).map((event) => (
      `${event.kind}@${event.position.column}:${event.position.row}`
    )).join('|'))
    const buildingOrders = runs.map((run) => buildEvents(run).map((event) => event.kind).join('|'))
    const variationSummary = JSON.stringify({
      buildingOrders,
      buildTraces: runs.map((run) => run.turns.map((turn) => ({
        turn: turn.turn,
        candidates: turn.trace.flatMap((entry) => entry.command?.type === 'build' ? [{
          kind: entry.command.building,
          score: entry.score,
          factors: entry.factors,
          rejected: entry.rejectedReason,
        }] : []),
      }))),
    })

    expect(new Set(sitePlans).size).toBeGreaterThan(1)
    expect(new Set(buildingOrders).size, variationSummary).toBeGreaterThan(1)
  }, 60_000)

  it('develops past the blueprint ceiling via overdrive when resources are abundant', () => {
    const scenario = createEconomicScenario('svyatobor', 'highland')
    const state = createMatch(scenario)
    const ownerId = 'ai-svyatobor'
    // Saturate every economy resource so overdrive tier 3 (9x reference cost)
    // is comfortably reached for the scarcest resource.
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      population: 14,
      taxRate: 'none',
      resources: {
        wood: 400, stone: 400, ore: 200, iron: 120,
        flour: 200, meat: 60, fruit: 120, gold: 600,
      },
    }
    const run = runAiScenario(state, 'svyatobor', { turns: 18, mode: 'development-only' })
    const summary = behaviorSummary('overdrive-svyatobor', run)
    const finalBuildings = run.turns.at(-1)?.buildingCounts ?? {}
    // At least one economy building kind must exceed the static profile limit
    // (svyatobor: house 5, kitchen 2, quarry 2, mine 2, ...). Overdrive is the
    // only mechanism that raises these limits, so exceeding any of them proves
    // the slot is actually open.
    const profileLimits: Partial<Record<BuildingKind, number>> = {
      house: 5, kitchen: 2, quarry: 2, mine: 2, smelter: 2,
      lumberMill: 2, orchard: 2, huntingLodge: 2,
    }
    const overdriveKinds = (Object.entries(profileLimits) as Array<[BuildingKind, number]>)
      .filter(([kind, limit]) => ((finalBuildings as Record<BuildingKind, number>)[kind] ?? 0) > limit)
    expect(overdriveKinds.length, summary).toBeGreaterThanOrEqual(1)
    expect(demolitionEvents(run), summary).toEqual([])
  }, 60_000)

  it('does not open overdrive slots before the settlement has stabilized', () => {
    const scenario = createEconomicScenario('svyatobor', 'highland')
    const state = createMatch(scenario)
    const ownerId = 'ai-svyatobor'
    // Plenty of resources, but the AI starts cold (stableTurns = 0). Overdrive
    // is gated by minStableTurns, so the first turns must stay within blueprint.
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      resources: {
        wood: 400, stone: 400, ore: 200, iron: 120,
        flour: 200, meat: 60, fruit: 120, gold: 600,
      },
    }
    const run = runAiScenario(state, 'svyatobor', { turns: 3, mode: 'development-only' })
    const summary = behaviorSummary('overdrive-gated', run)
    const profileLimits: Partial<Record<BuildingKind, number>> = {
      house: 5, kitchen: 2, quarry: 2, mine: 2, smelter: 2,
      lumberMill: 2, orchard: 2, huntingLodge: 2,
    }
    const finalBuildings = run.turns.at(-1)?.buildingCounts ?? {}
    const overdriveKinds = (Object.entries(profileLimits) as Array<[BuildingKind, number]>)
      .filter(([kind, limit]) => ((finalBuildings as Record<BuildingKind, number>)[kind] ?? 0) > limit)
    expect(overdriveKinds, summary).toEqual([])
  }, 60_000)

  it('does not demolish productive quarries merely because a compact industry zone is full', () => {
    const started = endTurn(createMatch(createEconomicScenario('svyatobor', 'highland')))
    if (!started.ok) throw new Error(started.reason)
    const state = started.state
    const ownerId = 'ai-svyatobor'
    placeTestBuilding(state, ownerId, 'quarry', { column: 14, row: 3 })
    placeTestBuilding(state, ownerId, 'quarry', { column: 16, row: 3 })
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      population: 5,
      taxRate: 'none',
      resources: {
        wood: 400, stone: 400, ore: 200, iron: 120,
        flour: 200, meat: 60, fruit: 120, gold: 600,
      },
    }
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing compact-industry analysis')
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor)
    expect(settlementPlan.fortification?.lines[0]?.kind).toBe('enclosure')
    settlementPlan.zones.industry.maxOrigins = 1
    state.aiMemory[ownerId] = {
      ...createAiMemory(),
      settlementPlan,
      targetOwnerId: 'player',
      phase: 'expansion',
      stableTurns: 10,
    }

    const candidates = strategicCandidates(
      state,
      aiProfiles.svyatobor,
      analysis,
      state.aiMemory[ownerId],
      'expansion',
      () => true,
    )

    const run = runAiScenario(state, 'svyatobor', { turns: 6, mode: 'development-only', cachedAnalysis: analysis })
    const summary = behaviorSummary('compact-industry-no-churn', run)

    expect(candidates.some((candidate) => candidate.command.type === 'demolish'), JSON.stringify(candidates)).toBe(false)
    expect(demolitionEvents(run), summary).toEqual([])
    expect(run.turns.at(-1)?.buildingCounts.quarry, summary).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('re-evaluates demolition from the live economy and allows an immediate useful rebuild', () => {
    const fixture = createFortressConstructionState('svyatobor', 'open')
    const started = endTurn(fixture.state)
    if (!started.ok) throw new Error(started.reason)
    const state = started.state
    const { ownerId, analysis } = fixture
    const housingZone = state.aiMemory[ownerId].settlementPlan?.zones.housing
    if (!housingZone) throw new Error('Missing housing zone in counterfactual fixture')
    housingZone.maxOrigins += 1
    housingZone.maxBuildings.church = 1
    const reserved = new Set([
      ...(state.aiMemory[ownerId].settlementPlan?.fortification?.lines.flatMap((line) => (
        [line.gate, ...line.walls, ...line.towers]
      )) ?? []),
      ...(state.aiMemory[ownerId].settlementPlan?.reservedSites.outpostTower
        ? [state.aiMemory[ownerId].settlementPlan!.reservedSites.outpostTower!]
        : []),
    ].map((position) => `${position.column}:${position.row}`))
    const church = state.scenario.cells.flatMap((row, rowIndex) => row.flatMap((_cell, column) => {
      const origin = { column, row: rowIndex }
      const footprint = buildingFootprintPositions('church', origin)
      return footprint.length > 0 && footprint.every((position) => {
        const cell = state.scenario.cells[position.row]?.[position.column]
        return Boolean(cell && !cell.object && cell.landform !== 'peak'
          && !reserved.has(`${position.column}:${position.row}`))
      }) ? [origin] : []
    }))[0]
    if (!church) throw new Error('No legal church site in counterfactual fixture')
    placeTestBuilding(state, ownerId, 'church', church, {
      constructionCost: { ...buildingRules.church.resourceCost },
    })
    const memory = state.aiMemory[ownerId]
    const healthyResources = { ...state.domains[ownerId].resources }
    const healthy = strategicCandidates(
      state, aiProfiles.svyatobor, analysis, memory, 'expansion', () => true,
    )
    expect(healthy.some((candidate) => candidate.command.type === 'demolish'
      && candidate.command.position.column === church.column
      && candidate.command.position.row === church.row), JSON.stringify(healthy)).toBe(false)

    const upkeepWithChurch = upkeepFor(state, ownerId).gold
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      taxRate: 'none',
      resources: { ...state.domains[ownerId].resources, gold: Math.max(0, upkeepWithChurch - 1) },
    }
    const recovery = strategicCandidates(
      state, aiProfiles.svyatobor, analysis, memory, 'recovery', () => true,
    )
    expect(recovery.some((candidate) => candidate.command.type === 'demolish'
      && candidate.command.position.column === church.column
      && candidate.command.position.row === church.row), JSON.stringify(recovery)).toBe(true)

    const removed = demolish(state, church)
    expect(removed.ok).toBe(true)
    if (!removed.ok) throw new Error(removed.reason)
    removed.state.domains[ownerId] = {
      ...removed.state.domains[ownerId],
      resources: healthyResources,
    }
    const restoredGoals = desiredBuildingGoals(
      removed.state, aiProfiles.svyatobor, analysis, memory, 'expansion', () => true,
    )
    expect(restoredGoals.some((goal) => goal.kind === 'church'), JSON.stringify(restoredGoals)).toBe(true)
  }, 60_000)
})
