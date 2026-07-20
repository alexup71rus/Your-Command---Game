import { aiPlannerConfig, aiProfiles } from '../../../config/ai'
import { buildingKinds } from '../../../config/rules'
import type { BuildingKind } from '../../map'
import {
  endTurn,
  ownedBuildingCount,
  type CommandFailure,
  type MatchState,
  type TurnReport,
} from '../../match'
import type { AiProfileId } from '../../scenario'
import { analyzeAiWorld, type AiWorldAnalysis } from '../analysis'
import { executeAiCommand, rememberAiCommandFailure } from '../commands'
import { createAiMemory, type AiCommand, type AiMemory, type AiStrategicPhase, type AiWaveKind } from '../model'
import { planAiTurn, type AiPlanningMode } from '../planner'
import {
  assignSquadRoles,
  selectTacticalCandidate,
  tacticalCandidates,
  tacticalMovementEdgeKey,
} from '../tactics'

export type DevelopmentScenarioMode = Exclude<AiPlanningMode, 'combat-only'>

export interface ScenarioCommandFailure {
  command: AiCommand
  reason: CommandFailure
}

export interface ScenarioTurn {
  turn: number
  phase: AiStrategicPhase
  wave: AiWaveKind
  planned: AiCommand[]
  executed: AiCommand[]
  failures: ScenarioCommandFailure[]
  report: TurnReport
  buildingCounts: Record<BuildingKind, number>
}

export interface ScenarioRun {
  mode: DevelopmentScenarioMode
  state: MatchState
  turns: ScenarioTurn[]
}

export interface FrozenTacticalStep {
  command: AiCommand
  event: MatchState['lastEvent']
  ordersRemaining: number
}

export interface FrozenTacticalRun {
  state: MatchState
  memory: AiMemory
  steps: FrozenTacticalStep[]
  failures: ScenarioCommandFailure[]
}

export function buildingCountsFor(state: MatchState, ownerId: string) {
  return Object.fromEntries(buildingKinds.map((kind) => [
    kind,
    ownedBuildingCount(state, ownerId, kind),
  ])) as Record<BuildingKind, number>
}

function advanceToParticipant(state: MatchState, participantId: string) {
  let current = state
  for (let guard = 0; current.activeParticipantId !== participantId && guard < current.scenario.participants.length; guard += 1) {
    const ended = endTurn(current)
    if (!ended.ok) throw new Error(`Could not advance to ${participantId}: ${ended.reason}`)
    current = ended.state
  }
  if (current.activeParticipantId !== participantId) throw new Error(`Turn cycle never reached ${participantId}`)
  return current
}

function assertScenarioState(state: MatchState) {
  if (state.scenario.participantCount !== state.scenario.participants.length) {
    throw new Error('Scenario participantCount does not match its participant list')
  }
  state.scenario.participants.forEach((participant) => {
    if (!state.domains[participant.id]) throw new Error(`Missing domain for ${participant.id}`)
    const castles = state.scenario.cells.flat().filter((cell) => (
      cell.object?.type === 'castle' && cell.object.ownerId === participant.id
    ))
    if (castles.length !== 1) throw new Error(`Expected exactly one castle for ${participant.id}, found ${castles.length}`)
  })
}

/**
 * Runs one AI in a deterministic development experiment. The planner applies
 * the requested command mode before speculative execution, so its memory and
 * the authoritative state cannot diverge merely because a test suppressed a
 * combat wave. Every planned, executed, and rejected command is visible.
 */
export function runAiScenario(
  initialState: MatchState,
  profileId: AiProfileId,
  requestedTurns: number,
  mode: DevelopmentScenarioMode = 'full',
  cachedAnalysis?: AiWorldAnalysis | null,
): ScenarioRun {
  assertScenarioState(initialState)
  const participantId = `ai-${profileId}`
  let state = advanceToParticipant(initialState, participantId)
  const analysis = cachedAnalysis === undefined
    ? analyzeAiWorld(state.scenario, participantId)
    : cachedAnalysis
  const turns: ScenarioTurn[] = []

  for (let index = 0; index < requestedTurns && state.status === 'playing'; index += 1) {
    const planned = planAiTurn(
      state,
      state.aiMemory[participantId] ?? createAiMemory(),
      profileId,
      { cachedAnalysis: analysis, mode, enforceTimeBudget: false, nodeBudget: 4_000 },
    )
    const executed: AiCommand[] = []
    const failures: ScenarioCommandFailure[] = []
    for (const command of planned.commands) {
      const result = executeAiCommand(state, command)
      if (!result.ok) {
        failures.push({ command, reason: result.reason })
        state = rememberAiCommandFailure(state, participantId, command, result.reason)
        break
      }
      else {
        state = result.state
        executed.push(command)
      }
    }
    if (failures.length === 0) {
      state = {
        ...state,
        aiMemory: { ...state.aiMemory, [participantId]: planned.memory },
      }
    }
    const turn = state.turn
    const ended = endTurn(state)
    if (!ended.ok) throw new Error(`Could not finish ${participantId}'s turn: ${ended.reason}`)
    state = ended.state
    const report = state.lastTurnReports[participantId]
    if (!report) throw new Error(`Missing economy report for ${participantId} on turn ${turn}`)
    turns.push({
      turn,
      phase: planned.memory.phase,
      wave: planned.memory.wave,
      planned: planned.commands,
      executed,
      failures,
      report,
      buildingCounts: buildingCountsFor(state, participantId),
    })
    if (state.status === 'playing') state = advanceToParticipant(state, participantId)
  }

  return { mode, state, turns }
}

/** Runs only the tactical selector in a fixed phase, without an economy tick. */
export function runFrozenTactics(
  initialState: MatchState,
  profileId: AiProfileId,
  memory: AiMemory,
  phase: AiStrategicPhase,
  maximumCommands: number = aiPlannerConfig.maximumCommands,
): FrozenTacticalRun {
  assertScenarioState(initialState)
  let state = advanceToParticipant(initialState, `ai-${profileId}`)
  let currentMemory = {
    ...memory,
    phase,
    squadRoles: assignSquadRoles(state, aiProfiles[profileId], memory.squadRoles, phase),
  }
  const steps: FrozenTacticalStep[] = []
  const failures: ScenarioCommandFailure[] = []
  const traversedEdges = new Set<string>()
  let exploredNodes = 0
  const countNode = () => {
    if (exploredNodes >= aiPlannerConfig.nodeBudget) return false
    exploredNodes += 1
    return true
  }

  while (state.ordersRemaining > 0 && steps.length < maximumCommands && countNode()) {
    currentMemory = {
      ...currentMemory,
      squadRoles: assignSquadRoles(state, aiProfiles[profileId], currentMemory.squadRoles, phase),
    }
    const candidate = selectTacticalCandidate(
      tacticalCandidates(state, aiProfiles[profileId], currentMemory, phase, countNode),
      {
        phase,
        idleTurns: currentMemory.idleTurns,
        previousCommands: steps.map((step) => step.command),
        traversedEdges,
      },
    )
    if (!candidate) break
    const result = executeAiCommand(state, candidate.command)
    if (!result.ok) {
      failures.push({ command: candidate.command, reason: result.reason })
      break
    }
    state = result.state
    if (candidate.command.type === 'move-or-attack') {
      traversedEdges.add(tacticalMovementEdgeKey(candidate.command.from, candidate.command.to))
    }
    steps.push({
      command: candidate.command,
      event: state.lastEvent,
      ordersRemaining: state.ordersRemaining,
    })
  }
  return { state, memory: currentMemory, steps, failures }
}

export function scenarioTranscript(run: ScenarioRun) {
  return run.turns.map((turn) => ({
    turn: turn.turn,
    phase: turn.phase,
    wave: turn.wave,
    planned: turn.planned,
    executed: turn.executed,
    failures: turn.failures,
    report: {
      production: turn.report.production,
      food: turn.report.food,
      upkeepPaid: turn.report.upkeepPaid,
      populationAfter: turn.report.populationAfter,
      resourcesAfter: turn.report.resourcesAfter,
    },
    buildingCounts: turn.buildingCounts,
  }))
}
