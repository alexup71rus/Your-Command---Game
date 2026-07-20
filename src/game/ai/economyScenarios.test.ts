import { describe, expect, it } from 'vitest'
import { economyBuildingKinds } from '../../config/rules'
import { createManualHeightGrid, generateMap } from '../generator'
import { createMatch, type MatchState } from '../match'
import { mapPresets, type PresetId } from '../presets'
import { createMapScenario, foundMatch, type AiProfileId } from '../scenario'
import { createAiScenario } from './testing/scenarioFixtures'
import { scenarioTranscript, runAiScenario } from './testing/scenarioHarness'

interface EconomyCase {
  presetId: PresetId
  profileId: AiProfileId
  regime: string
}

const cases: EconomyCase[] = [
  { presetId: 'greenMarches', profileId: 'radomir', regime: 'open mixed terrain' },
  { presetId: 'woodedBorder', profileId: 'velislava', regime: 'forest-constrained building space' },
  { presetId: 'highlandPasses', profileId: 'svyatobor', regime: 'highland-constrained building space' },
]

function createGeneratedEconomyCase(testCase: EconomyCase) {
  const preset = mapPresets.find((candidate) => candidate.id === testCase.presetId)
  if (!preset) throw new Error(`Unknown preset ${testCase.presetId}`)
  const settings = { ...preset.settings, mapSize: 50 }
  const generated = generateMap(settings, createManualHeightGrid())
  const result = createMapScenario(generated, 2, settings.seed, {
    id: `economy-${testCase.presetId}-${testCase.profileId}`,
    name: testCase.regime,
  })
  if (!result.ok) throw new Error(`Could not create ${testCase.presetId}: ${result.reason}`)
  const humanRegion = result.scenario.regions[0]
  const founded = foundMatch(
    result.scenario,
    humanRegion.id,
    humanRegion.validCastleCells[0],
    [testCase.profileId],
  )
  return createMatch(founded)
}

function terrainOpportunityLedger(state: MatchState, profileId: AiProfileId) {
  const ownerId = `ai-${profileId}`
  const regionId = state.scenario.participants.find((participant) => participant.id === ownerId)?.regionId
  if (!regionId) throw new Error(`Missing region for ${ownerId}`)
  let passable = 0
  let clearPlain = 0
  let clearHill = 0
  let forestEdges = 0
  state.scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    if (state.scenario.territories[rowIndex][column] !== regionId || cell.landform === 'peak') return
    passable += 1
    if (!cell.vegetation && !cell.object && cell.landform === 'plain') clearPlain += 1
    if (!cell.vegetation && !cell.object && cell.landform === 'hill') clearHill += 1
    if (!cell.vegetation && !cell.object) {
      const adjacentForest = [
        state.scenario.cells[rowIndex - 1]?.[column],
        state.scenario.cells[rowIndex + 1]?.[column],
        state.scenario.cells[rowIndex]?.[column - 1],
        state.scenario.cells[rowIndex]?.[column + 1],
      ].filter((neighbor) => neighbor?.vegetation).length
      if (adjacentForest >= 2) forestEdges += 1
    }
  }))
  return { passable, clearPlain, clearHill, forestEdges }
}

function economyFailureSummary(
  testCase: EconomyCase,
  opportunities: ReturnType<typeof terrainOpportunityLedger>,
  run: ReturnType<typeof runAiScenario>,
) {
  return JSON.stringify({
    testCase,
    opportunities,
    turns: run.turns.map((turn) => ({
      turn: turn.turn,
      commands: turn.executed.map((command) => command.type === 'build'
        ? `${command.type}:${command.building}`
        : command.type),
      failures: turn.failures,
      fed: turn.report.food.fed,
      upkeepPaid: turn.report.upkeepPaid,
      population: turn.report.populationAfter,
      buildings: turn.buildingCounts,
    })),
  })
}

const forbiddenDevelopmentCommands = new Set([
  'recruit',
  'move-or-attack',
  'split',
  'garrison',
  'ungarrison',
  'tower-attack',
])

describe('AI economy with combat waves explicitly disabled', () => {
  it.each(cases)('$profileId recovers and develops for 10 turns on $regime', (testCase) => {
    const initialState = createGeneratedEconomyCase(testCase)
    const opportunities = terrainOpportunityLedger(initialState, testCase.profileId)
    const first = runAiScenario(initialState, testCase.profileId, 10, 'economy-only')
    const summary = economyFailureSummary(testCase, opportunities, first)

    expect(first.mode).toBe('economy-only')
    expect(first.turns, summary).toHaveLength(10)
    expect(first.turns.flatMap((turn) => turn.failures), summary).toEqual([])
    expect(first.turns.every((turn) => turn.planned.length === turn.executed.length), summary).toBe(true)
    expect(first.turns.every((turn) => turn.executed.every((command) => {
      if (forbiddenDevelopmentCommands.has(command.type)) return false
      if (command.type !== 'build') return true
      return command.building !== 'barracks' && economyBuildingKinds.includes(command.building)
    })), summary).toBe(true)
    expect(first.turns.every((turn) => turn.report.upkeepPaid), summary).toBe(true)

    const firstFoodTurn = first.turns.findIndex((turn) => (
      turn.buildingCounts.farm
      + turn.buildingCounts.orchard
      + turn.buildingCounts.huntingLodge
    ) > 0)
    expect(firstFoodTurn, summary).toBeGreaterThanOrEqual(0)
    expect(firstFoodTurn, summary).toBeLessThan(8)
    expect(first.turns.slice(firstFoodTurn).every((turn) => turn.report.food.fed), summary).toBe(true)
    expect(first.turns.at(-1)?.report.populationAfter, summary).toBeGreaterThanOrEqual(5)
    expect(first.turns.some((turn) => turn.executed.some((command) => command.type === 'build')), summary).toBe(true)
    expect(opportunities.passable, summary).toBeGreaterThan(0)
    expect(opportunities.clearPlain + opportunities.clearHill + opportunities.forestEdges, summary).toBeGreaterThan(0)
  }, 20_000)

  it('replays the same economy-only fixture byte-for-byte', () => {
    const first = runAiScenario(createMatch(createAiScenario('radomir')), 'radomir', 8, 'economy-only')
    const replay = runAiScenario(createMatch(createAiScenario('radomir')), 'radomir', 8, 'economy-only')
    expect(scenarioTranscript(replay)).toEqual(scenarioTranscript(first))
  })

  it('establishes food production before the first starvation deadline', () => {
    const testCase = cases[0]
    const initialState = createGeneratedEconomyCase(testCase)
    const opportunities = terrainOpportunityLedger(initialState, testCase.profileId)
    const run = runAiScenario(initialState, testCase.profileId, 6, 'economy-only')
    const summary = economyFailureSummary(testCase, opportunities, run)
    expect(run.turns.every((turn) => turn.report.food.fed), summary).toBe(true)
    expect(run.turns.some((turn) => turn.buildingCounts.orchard
      + turn.buildingCounts.huntingLodge + turn.buildingCounts.farm > 0), summary).toBe(true)
  })
})
