import { describe, expect, it } from 'vitest'
import { aiPlannerConfig } from '../../config/ai'
import { buildingKinds } from '../../config/rules'
import { createManualHeightGrid, generateMap, type GeneratorSettings } from '../generator'
import { createMatch, endTurn, hasLivingCastle, ownedBuildingCount, totalArmySize, troopTotals, workforceFor, type MatchState } from '../match'
import { mapPresets } from '../presets'
import { createMapScenario, foundMatch, type AiProfileId } from '../scenario'
import { executeAiCommand, rememberAiCommandFailure } from './commands'
import { aiProfileIds, createAiMemory } from './model'
import { planAiTurn } from './planner'
import { economySnapshotFor, estimatedTargetPower, stagingAnchorsFor } from './strategy'

interface SimulationMetrics {
  participantId: string
  profileId: AiProfileId
  invalidCommands: number
  recoveredReplans: number
  commandRejections: Record<string, number>
  plans: number
  plannedCommands: number
  successfulCommands: number
  partialPlans: number
  emptyPlans: number
  maximumEmptyPlanStreak: number
  currentEmptyPlanStreak: number
  builds: number
  recruits: number
  moves: number
  attacks: number
  castlesDestroyed: number
  maximumThinkTime: number
  firstRecruitRound: number | null
  firstMoveRound: number | null
  firstAttackRound: number | null
  phaseCounts: Record<string, number>
  lastSnapshot: string
  lastTrace: string
}

interface SimulationResult {
  state: MatchState
  metrics: Record<string, SimulationMetrics>
  requestedRounds: number
  reachedRoundLimit: boolean
  finishedByConquest: boolean
  castlesDestroyed: number
}

const emptyMetrics = (participantId: string, profileId: AiProfileId): SimulationMetrics => ({
  participantId,
  profileId,
  invalidCommands: 0,
  recoveredReplans: 0,
  commandRejections: {},
  plans: 0,
  plannedCommands: 0,
  successfulCommands: 0,
  partialPlans: 0,
  emptyPlans: 0,
  maximumEmptyPlanStreak: 0,
  currentEmptyPlanStreak: 0,
  builds: 0,
  recruits: 0,
  moves: 0,
  attacks: 0,
  castlesDestroyed: 0,
  maximumThinkTime: 0,
  firstRecruitRound: null,
  firstMoveRound: null,
  firstAttackRound: null,
  phaseCounts: {},
  lastSnapshot: '',
  lastTrace: '',
})

function livingCastleCount(state: MatchState) {
  return state.scenario.participants.reduce((count, participant) => count + Number(hasLivingCastle(state, participant.id)), 0)
}

function continueTournament(state: MatchState) {
  // MatchState is player-centric and becomes `lost` as soon as its formal human
  // participant falls. Long simulations control that participant with an AI too,
  // so keep the tournament alive until only one castle remains.
  return livingCastleCount(state) > 1 && state.status !== 'playing'
    ? { ...state, status: 'playing' as const }
    : state
}

function addMetrics(target: SimulationMetrics, current: SimulationMetrics) {
  target.invalidCommands += current.invalidCommands
  target.recoveredReplans += current.recoveredReplans
  Object.entries(current.commandRejections).forEach(([reason, count]) => {
    target.commandRejections[reason] = (target.commandRejections[reason] ?? 0) + count
  })
  target.plans += current.plans
  target.plannedCommands += current.plannedCommands
  target.successfulCommands += current.successfulCommands
  target.partialPlans += current.partialPlans
  target.emptyPlans += current.emptyPlans
  target.maximumEmptyPlanStreak = Math.max(target.maximumEmptyPlanStreak, current.maximumEmptyPlanStreak)
  target.builds += current.builds
  target.recruits += current.recruits
  target.moves += current.moves
  target.attacks += current.attacks
  target.castlesDestroyed += current.castlesDestroyed
  target.maximumThinkTime = Math.max(target.maximumThinkTime, current.maximumThinkTime)
  target.firstRecruitRound = target.firstRecruitRound === null ? current.firstRecruitRound
    : current.firstRecruitRound === null ? target.firstRecruitRound : Math.min(target.firstRecruitRound, current.firstRecruitRound)
  target.firstMoveRound = target.firstMoveRound === null ? current.firstMoveRound
    : current.firstMoveRound === null ? target.firstMoveRound : Math.min(target.firstMoveRound, current.firstMoveRound)
  target.firstAttackRound = target.firstAttackRound === null ? current.firstAttackRound
    : current.firstAttackRound === null ? target.firstAttackRound : Math.min(target.firstAttackRound, current.firstAttackRound)
  target.phaseCounts = Object.fromEntries([...new Set([...Object.keys(target.phaseCounts), ...Object.keys(current.phaseCounts)])]
    .map((phase) => [phase, (target.phaseCounts[phase] ?? 0) + (current.phaseCounts[phase] ?? 0)]))
  target.lastSnapshot = current.lastSnapshot || target.lastSnapshot
  target.lastTrace = current.lastTrace || target.lastTrace
}

async function runSimulation(settings: GeneratorSettings, participantCount: number, rounds: number) {
  const map = generateMap(settings, createManualHeightGrid())
  const result = createMapScenario(map, participantCount, settings.seed, { id: `ai-sim-${settings.seed}-${participantCount}`, name: 'AI simulation' })
  if (!result.ok) throw new Error(`Scenario generation failed: ${result.reason}`)
  const humanRegion = result.scenario.regions[0]
  const opponentProfiles = aiProfileIds.slice(0, participantCount - 1)
  const humanProfile = aiProfileIds[(Math.abs(settings.seed) + participantCount) % aiProfileIds.length]
  let state = createMatch(foundMatch(result.scenario, humanRegion.id, humanRegion.validCastleCells[0], opponentProfiles))
  const profileByParticipant = Object.fromEntries(state.scenario.participants.map((participant) => [
    participant.id,
    participant.kind === 'ai' ? participant.profileId! : humanProfile,
  ])) as Record<string, AiProfileId>
  state = {
    ...state,
    aiMemory: {
      ...state.aiMemory,
      [state.playerId]: createAiMemory(),
    },
  }
  const metrics = Object.fromEntries(state.scenario.participants.map((participant) => [
    participant.id,
    emptyMetrics(participant.id, profileByParticipant[participant.id]),
  ])) as Record<string, SimulationMetrics>
  const initialCastleCount = livingCastleCount(state)
  let guard = rounds * participantCount * 3
  while (livingCastleCount(state) > 1 && state.turn <= rounds && guard > 0) {
    guard -= 1
    const participantId = state.activeParticipantId
    const profileId = profileByParticipant[participantId]
    const rulerMetrics = metrics[participantId]
    if (!profileId || !rulerMetrics) throw new Error(`Missing AI controller for ${participantId}`)
    let planCompleted = false
    let turnHadCommands = false
    for (let attempt = 0; attempt < 2 && !planCompleted; attempt += 1) {
      const plan = planAiTurn(state, state.aiMemory[participantId] ?? createAiMemory(), profileId)
      rulerMetrics.lastTrace = JSON.stringify({ phase: plan.memory.phase, commands: plan.commands, trace: plan.trace.slice(-8) })
      rulerMetrics.plans += 1
      rulerMetrics.plannedCommands += plan.commands.length
      rulerMetrics.partialPlans += Number(plan.partial)
      rulerMetrics.phaseCounts[plan.memory.phase] = (rulerMetrics.phaseCounts[plan.memory.phase] ?? 0) + 1
      rulerMetrics.maximumThinkTime = Math.max(rulerMetrics.maximumThinkTime, plan.elapsedMs)
      turnHadCommands ||= plan.commands.length > 0
      let commandFailed = false
      for (const command of plan.commands) {
        const castlesBefore = livingCastleCount(state)
        const executed = executeAiCommand(state, command)
        if (!executed.ok) {
          rulerMetrics.commandRejections[executed.reason] = (rulerMetrics.commandRejections[executed.reason] ?? 0) + 1
          state = rememberAiCommandFailure(state, participantId, command, executed.reason)
          commandFailed = true
          break
        }
        state = continueTournament(executed.state)
        rulerMetrics.successfulCommands += 1
        if (command.type === 'build') rulerMetrics.builds += 1
        if (command.type === 'recruit') {
          rulerMetrics.recruits += command.quantity
          rulerMetrics.firstRecruitRound ??= state.turn
        }
        if (state.lastEvent?.kind === 'moved' || state.lastEvent?.kind === 'merged') {
          rulerMetrics.moves += 1
          rulerMetrics.firstMoveRound ??= state.turn
        }
        if (state.lastEvent?.kind === 'attacked' || state.lastEvent?.kind === 'destroyed') {
          rulerMetrics.attacks += 1
          rulerMetrics.firstAttackRound ??= state.turn
        }
        const destroyed = Math.max(0, castlesBefore - livingCastleCount(state))
        rulerMetrics.castlesDestroyed += destroyed
        if (livingCastleCount(state) <= 1) break
      }
      if (commandFailed && attempt === 0) rulerMetrics.recoveredReplans += 1
      else if (commandFailed) rulerMetrics.invalidCommands += 1
      else {
        state = { ...state, aiMemory: { ...state.aiMemory, [participantId]: plan.memory } }
        planCompleted = true
      }
    }
    if (!turnHadCommands) {
      rulerMetrics.emptyPlans += 1
      rulerMetrics.currentEmptyPlanStreak += 1
      rulerMetrics.maximumEmptyPlanStreak = Math.max(rulerMetrics.maximumEmptyPlanStreak, rulerMetrics.currentEmptyPlanStreak)
    } else rulerMetrics.currentEmptyPlanStreak = 0
    if (livingCastleCount(state) > 1) {
      const ended = endTurn(continueTournament(state))
      if (!ended.ok) throw new Error(`AI turn failed: ${ended.reason}`)
      state = continueTournament(ended.state)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  if (guard <= 0) throw new Error('Simulation did not advance its turn cycle')
  Object.values(metrics).forEach((rulerMetrics) => {
    const participantId = rulerMetrics.participantId
    const memory = state.aiMemory[participantId]
    rulerMetrics.lastSnapshot = JSON.stringify({
      turn: state.turn,
      status: state.status,
      alive: hasLivingCastle(state, participantId),
      profileId: rulerMetrics.profileId,
      population: state.domains[participantId].population,
      resources: state.domains[participantId].resources,
      workforce: {
        employed: workforceFor(state, participantId).employed,
        free: workforceFor(state, participantId).free,
      },
      armySize: totalArmySize(state, participantId),
      troops: troopTotals(state, participantId),
      economy: economySnapshotFor({ ...state, activeParticipantId: participantId }, participantId),
      targetPower: estimatedTargetPower(state, memory.targetOwnerId, memory),
      stagingAnchors: stagingAnchorsFor(state, participantId, memory),
      buildings: Object.fromEntries(buildingKinds.map((kind) => [kind, ownedBuildingCount(state, participantId, kind)])),
      memory: {
        phase: memory.phase,
        wave: memory.wave,
        contacts: memory.contacts.length,
        squadRoles: memory.squadRoles,
      },
    })
  })
  return {
    state,
    metrics,
    requestedRounds: rounds,
    reachedRoundLimit: state.turn > rounds,
    finishedByConquest: livingCastleCount(state) <= 1,
    castlesDestroyed: initialCastleCount - livingCastleCount(state),
  } satisfies SimulationResult
}

function expectMeaningfulSimulation(result: SimulationResult) {
  const rulers = Object.values(result.metrics)
  const summary = JSON.stringify({
    requestedRounds: result.requestedRounds,
    finalTurn: result.state.turn,
    status: result.state.status,
    reachedRoundLimit: result.reachedRoundLimit,
    finishedByConquest: result.finishedByConquest,
    castlesDestroyed: result.castlesDestroyed,
    rulers,
  })
  expect(result.reachedRoundLimit || result.finishedByConquest, summary).toBe(true)
  expect(rulers.length, summary).toBe(result.state.scenario.participantCount)
  expect(rulers.every((metrics) => metrics.plans > 0), summary).toBe(true)
  expect(rulers.every((metrics) => metrics.invalidCommands === 0), summary).toBe(true)
  expect(rulers.every((metrics) => metrics.maximumThinkTime < aiPlannerConfig.hardBudgetMs), summary).toBe(true)
  expect(rulers.reduce((sum, metrics) => sum + metrics.builds, 0), summary).toBeGreaterThan(0)
  expect(rulers.reduce((sum, metrics) => sum + metrics.recruits, 0), summary).toBeGreaterThan(0)
  expect(rulers.reduce((sum, metrics) => sum + metrics.moves, 0), summary).toBeGreaterThan(0)
  expect(rulers.reduce((sum, metrics) => sum + metrics.attacks, 0), summary).toBeGreaterThan(0)
  if (result.finishedByConquest) expect(result.castlesDestroyed, summary).toBeGreaterThan(0)

  const established = rulers.filter((metrics) => metrics.plans >= 12)
  established.forEach((metrics) => {
    const rulerSummary = `${metrics.participantId}/${metrics.profileId}: ${summary}`
    expect(metrics.builds, rulerSummary).toBeGreaterThan(0)
    expect(metrics.recruits, rulerSummary).toBeGreaterThan(0)
    expect(metrics.moves, rulerSummary).toBeGreaterThan(0)
    expect(metrics.maximumEmptyPlanStreak, rulerSummary).toBeLessThan(12)
    if (hasLivingCastle(result.state, metrics.participantId)) expect(metrics.attacks, rulerSummary).toBeGreaterThan(0)
  })
}

describe.runIf(import.meta.env.VITE_RUN_LONG_AI_SIMULATIONS === '1')('long AI simulations', () => {
  it('develops and wages war on every preset with two to four participants', async () => {
    const aggregate = Object.fromEntries(aiProfileIds.map((profileId) => [profileId, emptyMetrics(`aggregate-${profileId}`, profileId)])) as Record<AiProfileId, SimulationMetrics>
    const requestedCase = import.meta.env.VITE_AI_SIM_CASE
    for (const preset of mapPresets) {
      for (const participantCount of [2, 3, 4]) {
        if (requestedCase && requestedCase !== `${preset.id}-${participantCount}`) continue
        const result = await runSimulation(preset.settings, participantCount, Number(import.meta.env.VITE_AI_SIM_ROUNDS ?? 80))
        expectMeaningfulSimulation(result)
        Object.values(result.metrics).forEach((current) => addMetrics(aggregate[current.profileId], current))
      }
    }
    const activeProfiles = aiProfileIds.filter((profileId) => aggregate[profileId].plans > 0)
    expect(activeProfiles.length, JSON.stringify(aggregate)).toBeGreaterThan(0)
    activeProfiles.forEach((profileId) => {
      const metrics = aggregate[profileId]
      const summary = `${profileId}: ${JSON.stringify(metrics)}`
      expect(metrics.invalidCommands, summary).toBe(0)
      expect(metrics.builds, summary).toBeGreaterThan(0)
      expect(metrics.recruits, summary).toBeGreaterThan(0)
      expect(metrics.moves, summary).toBeGreaterThan(0)
      expect(metrics.attacks, summary).toBeGreaterThan(0)
      expect(metrics.maximumThinkTime, summary).toBeLessThan(aiPlannerConfig.hardBudgetMs)
    })
  }, 600_000)

  it.each([
    { seed: 19_871, rounds: 100, mapSize: 100 },
    { seed: 92_113, rounds: 150, mapSize: 100 },
  ])('runs a meaningful tournament for seed $seed through $rounds rounds on a $mapSize map', async ({ seed, rounds, mapSize }) => {
    const settings = { ...mapPresets[0].settings, seed, mapSize }
    const requestedRounds = Number(import.meta.env.VITE_AI_SIM_ROUNDS ?? rounds)
    const result = await runSimulation(settings, 4, requestedRounds)
    expectMeaningfulSimulation(result)
  }, 600_000)
})
