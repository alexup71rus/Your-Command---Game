import { describe, expect, it } from 'vitest'
import { createManualHeightGrid, generateMap } from '../generator'
import { createMatch } from '../match'
import { mapPresets } from '../presets'
import { createMapScenario, foundAutomatedMatch, type AiProfileId } from '../scenario'
import { createEconomicScenario } from './testing/scenarioFixtures'
import {
  formatSkirmishCheckpointReport,
  runAiScenario,
  runAiSkirmish,
  skirmishCheckpointsFor,
  type ScenarioRun,
} from './testing/scenarioHarness'

const runtime = globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> }
}
const runManualSoak = runtime.process?.env?.RUN_AI_SOAK === '1'

const cases: Array<{ profileId: AiProfileId; seedOffset: number }> = [
  { profileId: 'radomir', seedOffset: 101 },
  { profileId: 'velislava', seedOffset: 211 },
  { profileId: 'svyatobor', seedOffset: 307 },
]

describe.skipIf(!runManualSoak)('manual 500-round AI behavioral soak', () => {
  it.each(cases)('runs three $profileId opponents with ten readable checkpoints', ({ profileId, seedOffset }) => {
    const preset = mapPresets.find((candidate) => candidate.id === 'greenMarches')
    if (!preset) throw new Error('Missing greenMarches map preset')
    const settings = {
      ...preset.settings,
      mapSize: 75,
      seed: preset.settings.seed + seedOffset,
    }
    const generated = generateMap(settings, createManualHeightGrid())
    const scenario = createMapScenario(generated, 3, settings.seed, {
      id: `ai-soak-${profileId}-${settings.seed}`,
      name: `500-round ${profileId} behavioral soak`,
    })
    if (!scenario.ok) throw new Error(`Could not create soak fixture: ${scenario.reason}`)
    const founded = foundAutomatedMatch(scenario.scenario, [profileId, profileId, profileId])
    const run = runAiSkirmish(createMatch(founded), { rounds: 500 })
    const checkpoints = skirmishCheckpointsFor(run, 50, 10)
    const report = formatSkirmishCheckpointReport(
      `${profileId}: three opponents, seed ${settings.seed}, maximum 500 rounds`,
      checkpoints,
    )
    console.info(report)

    const failures = run.turns.flatMap((turn) => turn.failures.map((failure) => ({
      round: turn.round,
      ownerId: turn.ownerId,
      ...failure,
    })))
    const ownerIds = founded.participants.map((participant) => participant.id)
    const attacks = run.turns.reduce((sum, turn) => sum + turn.events.filter((event) => (
      event?.kind === 'attacked' || event?.kind === 'destroyed'
    )).length, 0)
    expect(checkpoints, report).toHaveLength(10)
    expect(failures, report).toEqual([])
    expect(attacks, report).toBeGreaterThan(0)
    ownerIds.forEach((ownerId) => {
      expect(run.turns.some((turn) => turn.ownerId === ownerId && turn.executed.some((command) => (
        command.type === 'build' && command.building === 'barracks'
      ))), report).toBe(true)
      expect(run.turns.some((turn) => turn.ownerId === ownerId && turn.executed.some((command) => (
        command.type === 'recruit'
      ))), report).toBe(true)
    })
  }, 1_200_000)

  it('lets Svyatobor grow a peaceful economy and army through every late-game milestone', async () => {
    let state = createMatch(createEconomicScenario('svyatobor', 'open'))
    const turns: ScenarioRun['turns'] = []
    for (let checkpoint = 0; checkpoint < 10; checkpoint += 1) {
      const segment = runAiScenario(state, 'svyatobor', {
        turns: 50,
        mode: 'development-only',
      })
      state = segment.state
      turns.push(...segment.turns)
      // Let the test runner publish progress between the ten readable checkpoints.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    const run: ScenarioRun = { mode: 'development-only', state, turns }
    const at = (turn: number) => run.turns.find((entry) => entry.turn === turn) ?? run.turns.at(-1)
    const checkpoints = [50, 100, 200, 300, 400, 500].map((turn) => {
      const entry = at(turn)
      return {
        turn: entry?.turn,
        army: entry?.armySize,
        population: entry?.report.populationAfter,
        buildings: entry?.buildingCounts,
      }
    })
    const demolitions = run.turns.flatMap((turn) => turn.executed.flatMap((command) => (
      command.type === 'demolish' ? [{ turn: turn.turn, position: command.position }] : []
    )))
    const taxChanges = run.turns.flatMap((turn) => turn.executed.flatMap((command) => (
      command.type === 'tax' ? [{ turn: turn.turn, rate: command.rate }] : []
    )))
    const summary = JSON.stringify({
      checkpoints,
      finalResources: run.state.domains['ai-svyatobor'].resources,
      demolitions,
      taxChanges,
      unhealthy: run.turns.filter((turn) => !turn.report.food.fed || !turn.report.upkeepPaid)
        .map((turn) => ({
          turn: turn.turn,
          phase: turn.phase,
          fed: turn.report.food.fed,
          upkeep: turn.report.upkeepPaid,
          desertion: turn.report.desertion,
          commands: turn.executed,
        })),
      idleTail: run.turns.slice(-20).filter((turn) => turn.executed.length === 0).map((turn) => turn.turn),
    })
    console.info(`Svyatobor peaceful development milestones\n${JSON.stringify(checkpoints, null, 2)}`)
    console.info(`Svyatobor peaceful development diagnosis\n${summary}`)

    expect(run.turns.flatMap((turn) => turn.failures), summary).toEqual([])
    expect(run.turns.filter((turn) => turn.turn < 100).every((turn) => turn.armySize <= 30), summary).toBe(true)
    expect(run.turns.filter((turn) => turn.turn >= 100 && turn.turn < 200)
      .every((turn) => turn.armySize <= 40), summary).toBe(true)
    expect(run.turns.filter((turn) => turn.turn >= 200 && turn.turn < 300)
      .every((turn) => turn.armySize <= 50), summary).toBe(true)
    expect(run.turns.filter((turn) => turn.turn >= 300)
      .every((turn) => turn.armySize <= 60), summary).toBe(true)
    expect(at(500)?.armySize, summary).toBeGreaterThanOrEqual(58)
    expect(at(500)?.buildingCounts.house, summary).toBeGreaterThan(at(50)?.buildingCounts.house ?? 0)
    expect(at(500)?.buildingCounts.kitchen, summary).toBeGreaterThanOrEqual(at(50)?.buildingCounts.kitchen ?? 0)
    expect(at(50)?.buildingCounts.barbican, summary).toBeGreaterThanOrEqual(1)
    expect(at(50)?.buildingCounts.wall, summary).toBeGreaterThanOrEqual(6)
    expect(taxChanges.some((change) => change.rate === 'extortionate'), summary).toBe(true)
    expect(new Set(demolitions.map(({ position }) => `${position.column}:${position.row}`)).size, summary)
      .toBe(demolitions.length)
    expect(run.turns.some((turn) => !turn.report.food.fed || !turn.report.upkeepPaid), summary).toBe(false)
  }, 1_200_000)
})
