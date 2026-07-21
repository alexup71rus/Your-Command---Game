import { describe, expect, it } from 'vitest'
import type { BuildingKind } from '../map'
import { createMatch } from '../match'
import type { AiProfileId } from '../scenario'
import type { AiCommand } from './model'
import {
  createEconomicScenario,
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

function behaviorSummary(testCase: EconomyCase | string, run: ScenarioRun) {
  const final = run.turns.at(-1)
  const populations = run.turns.map((turn) => turn.report.populationAfter)
  return JSON.stringify({
    testCase,
    mode: run.mode,
    builds: buildEvents(run).map((event) => `${event.turn}:${event.kind}`),
    unhealthyTurns: run.turns.filter((turn) => !turn.report.food.fed || !turn.report.upkeepPaid)
      .map((turn) => ({ turn: turn.turn, fed: turn.report.food.fed, upkeepPaid: turn.report.upkeepPaid })),
    failures: run.turns.flatMap((turn) => turn.failures.map((failure) => ({ turn: turn.turn, ...failure }))),
    partialTurns: run.turns.filter((turn) => turn.partial).map((turn) => turn.turn),
    tacticalCommands: run.turns.flatMap((turn) => turn.executed.filter((command) => (
      tacticalCommandTypes.has(command.type)
    )).map((command) => ({ turn: turn.turn, command }))),
    population: {
      first: populations[0],
      peak: populations.length > 0 ? Math.max(...populations) : undefined,
      last: populations.at(-1),
    },
    finalBuildings: final?.buildingCounts,
  })
}

function expectHealthyDeterministicRun(testCase: EconomyCase | string, run: ScenarioRun) {
  const summary = behaviorSummary(testCase, run)
  expect(run.turns.flatMap((turn) => turn.failures), summary).toEqual([])
  expect(run.turns.every((turn) => turn.planned.length === turn.executed.length), summary).toBe(true)
  expect(run.turns.every((turn) => !turn.partial), summary).toBe(true)
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
      { turns: 30, mode: 'development-only' },
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
      expect(firstBuildTurn(events, 'huntingLodge'), summary).toBeLessThanOrEqual(2)
      expect(firstBuildTurn(events, 'huntingLodge'), summary).toBeLessThan(firstBuildTurn(events, 'mill'))
      expect(finalBuildings.mill, summary).toBeGreaterThanOrEqual(1)
      expect(finalBuildings.farm, summary).toBeGreaterThanOrEqual(2)
      expect(populationPeak, summary).toBeGreaterThanOrEqual(14)
    } else {
      expect(firstBuildTurn(events, 'quarry'), summary).toBeLessThan(firstBuildTurn(events, 'mine'))
      expect(firstBuildTurn(events, 'mine'), summary).toBeLessThan(firstBuildTurn(events, 'smelter'))
      expect(finalBuildings.quarry, summary).toBeGreaterThanOrEqual(2)
      expect(finalBuildings.mine, summary).toBeGreaterThanOrEqual(1)
      expect(finalBuildings.smelter, summary).toBeGreaterThanOrEqual(1)
      expect(run.state.domains['ai-svyatobor'].resources.iron, summary).toBeGreaterThanOrEqual(20)
      expect(populationPeak, summary).toBeGreaterThanOrEqual(18)
      expect(trades.some((trade) => trade.direction === 'sell'
        && (trade.resource === 'stone' || trade.resource === 'ore')), summary).toBe(true)
      expect(trades.some((trade) => trade.direction === 'buy' && trade.resource === 'wood'), summary).toBe(true)
    }
  }, 60_000)

  it('varies equivalent building sites by seed without weakening the economy', () => {
    const runs = [91, 137, 223].map((seed) => {
      const scenario = createEconomicScenario('radomir', 'open')
      scenario.id = `${scenario.id}-seed-${seed}`
      scenario.seed = seed
      return runAiScenario(createMatch(scenario), 'radomir', {
        turns: 10,
        mode: 'development-only',
      })
    })
    runs.forEach((run, index) => {
      const summary = behaviorSummary(`seed ${[91, 137, 223][index]}`, run)
      expectHealthyDeterministicRun(`seed ${[91, 137, 223][index]}`, run)
      expect(Object.values(run.turns.at(-1)?.buildingCounts ?? {})
        .reduce((sum, count) => sum + count, 0), summary).toBeGreaterThanOrEqual(8)
      expect(run.turns.at(-1)?.report.populationAfter, summary).toBeGreaterThanOrEqual(9)
    })
    const sitePlans = runs.map((run) => buildEvents(run).map((event) => (
      `${event.kind}@${event.position.column}:${event.position.row}`
    )).join('|'))

    expect(new Set(sitePlans).size).toBeGreaterThan(1)
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
})
