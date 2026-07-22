import { describe, expect, it } from 'vitest'
import { createManualHeightGrid, generateMap } from '../generator'
import { createMatch } from '../match'
import { mapPresets } from '../presets'
import { createMapScenario, foundAutomatedMatch } from '../scenario'
import { runAiSkirmish, type SkirmishRun, type SkirmishTurn } from './testing/scenarioHarness'

function maximumInactiveCampaignStreak(turns: SkirmishTurn[], ownerId: string) {
  let longest = 0
  let current = 0
  turns.filter((turn) => turn.ownerId === ownerId).forEach((turn) => {
    const campaignPhase = turn.phase === 'mobilization' || turn.phase === 'assault' || turn.phase === 'regroup'
    current = campaignPhase && turn.planned.length === 0 ? current + 1 : 0
    longest = Math.max(longest, current)
  })
  return longest
}

describe('deterministic authoritative AI skirmish', () => {
  it('balances development, a coherent fortress and active campaigns in one authoritative match', async () => {
    const preset = mapPresets.find((candidate) => candidate.id === 'greenMarches')
    if (!preset) throw new Error('Missing greenMarches map preset')
    const settings = { ...preset.settings, mapSize: 50 }
    const generated = generateMap(settings, createManualHeightGrid())
    const scenario = createMapScenario(generated, 2, settings.seed, {
      id: 'ai-skirmish-regression', name: 'AI skirmish regression',
    })
    if (!scenario.ok) throw new Error(`Could not create skirmish fixture: ${scenario.reason}`)

    let state = createMatch(foundAutomatedMatch(scenario.scenario, ['svyatobor', 'radomir']))
    let run: SkirmishRun | null = null
    const turns: SkirmishTurn[] = []
    for (let segmentIndex = 0; segmentIndex < 4 && state.status === 'playing'; segmentIndex += 1) {
      const segment = runAiSkirmish(state, { rounds: 15 })
      run ??= segment
      turns.push(...segment.turns)
      state = segment.state
      // Yield between readable simulation windows so Vitest can publish its
      // worker heartbeat during this intentionally expensive smoke scenario.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    if (!run) throw new Error('Skirmish did not start')
    run = { ...run, state, turns }
    const failures = run.turns.flatMap((turn) => turn.failures.map((failure) => ({
      round: turn.round, ownerId: turn.ownerId, ...failure,
    })))
    const cancellations = run.turns.flatMap((turn) => turn.cancellations.map((failure) => ({
      round: turn.round, ownerId: turn.ownerId, ...failure,
    })))
    const builds = run.turns.flatMap((turn) => turn.executed.flatMap((command) => (
      command.type === 'build' ? [{ ownerId: turn.ownerId, round: turn.round, kind: command.building }] : []
    )))
    const recruits = run.turns.flatMap((turn) => turn.executed.flatMap((command) => (
      command.type === 'recruit' ? [{ ownerId: turn.ownerId, troop: command.troop, quantity: command.quantity }] : []
    )))
    const attacks = run.turns.flatMap((turn) => turn.events.flatMap((event) => (
      event?.kind === 'attacked' || event?.kind === 'destroyed' ? [{ ownerId: turn.ownerId, kind: event.kind }] : []
    )))
    const maximumBuildingCount = (ownerId: string, kind: 'wall' | 'tower') => Math.max(0, ...run.turns.map((turn) => (
      turn.snapshot.objects.filter((entry) => entry.object.type === 'building'
        && entry.object.ownerId === ownerId && entry.object.kind === kind).length
    )))
    const summary = JSON.stringify({
      status: run.state.status,
      failures,
      cancellations,
      inactiveCampaignStreaks: Object.fromEntries(['ai-svyatobor', 'ai-radomir'].map((ownerId) => [
        ownerId, maximumInactiveCampaignStreak(run.turns, ownerId),
      ])),
      builds,
      recruits,
      attacks,
      phases: Object.fromEntries(['ai-svyatobor', 'ai-radomir'].map((ownerId) => [
        ownerId, run.turns.filter((turn) => turn.ownerId === ownerId).map((turn) => turn.phase),
      ])),
    })

    expect(failures, summary).toEqual([])
    expect(cancellations, summary).toEqual([])
    expect(maximumInactiveCampaignStreak(run.turns, 'ai-svyatobor'), summary).toBeLessThanOrEqual(6)
    expect(maximumInactiveCampaignStreak(run.turns, 'ai-radomir'), summary).toBeLessThanOrEqual(6)

    for (const ownerId of ['ai-svyatobor', 'ai-radomir']) {
      expect(builds.some((build) => build.ownerId === ownerId && build.kind === 'barracks'), summary).toBe(true)
      expect(attacks.some((attack) => attack.ownerId === ownerId), summary).toBe(true)
    }
    expect(run.turns.some((turn) => turn.ownerId === 'ai-radomir' && turn.phase === 'assault'), summary).toBe(true)
    expect(recruits.some((recruit) => recruit.ownerId === 'ai-svyatobor' && recruit.troop === 'archers'), summary).toBe(true)
    expect(recruits.some((recruit) => recruit.ownerId === 'ai-svyatobor' && recruit.troop === 'spearmen'), summary).toBe(true)
    expect(recruits.some((recruit) => recruit.ownerId === 'ai-radomir' && recruit.troop === 'spearmen'), summary).toBe(true)

    const svyatoborBuilds = builds.filter((build) => build.ownerId === 'ai-svyatobor')
    const gateIndex = svyatoborBuilds.findIndex((build) => build.kind === 'barbican')
    const firstWallIndex = svyatoborBuilds.findIndex((build) => build.kind === 'wall')
    const firstTowerIndex = svyatoborBuilds.findIndex((build) => build.kind === 'tower')
    expect(gateIndex, summary).toBeGreaterThanOrEqual(0)
    expect(firstWallIndex, summary).toBeGreaterThan(gateIndex)
    expect(firstTowerIndex, summary).toBeGreaterThan(firstWallIndex)
    expect(maximumBuildingCount('ai-svyatobor', 'wall'), summary).toBeGreaterThanOrEqual(2)
    expect(maximumBuildingCount('ai-svyatobor', 'tower'), summary).toBeGreaterThanOrEqual(1)
    expect(maximumBuildingCount('ai-radomir', 'wall'), summary).toBe(0)

    const firstDamagedCastleTurn = run.turns.find((turn) => turn.snapshot.objects.some((entry) => (
      entry.object.type === 'castle' && entry.object.ownerId === 'ai-svyatobor'
        && entry.object.hitPoints < entry.object.maxHitPoints
    )))
    expect(firstDamagedCastleTurn, summary).toBeDefined()
    expect(run.turns.at(-1)?.snapshot.objects.some((entry) => (
      entry.object.type === 'castle' && entry.object.ownerId === 'ai-svyatobor'
    )), summary).toBe(true)
    expect(run.turns.some((turn) => turn.ownerId === 'ai-svyatobor'
      && turn.round >= (firstDamagedCastleTurn?.round ?? Number.POSITIVE_INFINITY)
      && turn.events.some((event) => event?.kind === 'attacked' || event?.kind === 'destroyed')), summary)
      .toBe(true)
  }, 300_000)
})
