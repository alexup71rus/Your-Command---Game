import { aiPlannerConfig, aiProfiles } from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import { buildingKinds, resourceIds } from '../../../config/rules'
import type { BuildingKind, MapObject, ResourceId } from '../../map'
import {
  endTurn,
  objectAt,
  ownedBuildingCount,
  type CommandFailure,
  type MatchState,
  type TurnReport,
} from '../../match'
import type { AiProfileId } from '../../scenario'
import { aiObjectEntries, analyzeAiWorld, type AiWorldAnalysis } from '../analysis'
import { executeAiCommand, rememberAiCommandFailure } from '../commands'
import {
  createAiMemory,
  type AiCommand,
  type AiMemory,
  type AiPlanTimings,
  type AiPlanTraceEntry,
  type AiStrategicPhase,
  type AiWaveKind,
} from '../model'
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
  /** Stale fog-limited suffixes which were discarded before a successful replan. */
  cancellations: ScenarioCommandFailure[]
  /** The final command rejection after the runtime replan allowance was exhausted. */
  failures: ScenarioCommandFailure[]
  trace: AiPlanTraceEntry[]
  exploredNodes: number
  timings: AiPlanTimings
  report: TurnReport
  buildingCounts: Record<BuildingKind, number>
  armySize: number
}

export interface ScenarioRun {
  mode: DevelopmentScenarioMode
  state: MatchState
  turns: ScenarioTurn[]
}

export interface SkirmishTurn {
  round: number
  ownerId: string
  profileId: AiProfileId
  phase: AiStrategicPhase
  wave: AiWaveKind
  planned: AiCommand[]
  executed: AiCommand[]
  events: Array<MatchState['lastEvent']>
  /** Stale fog-limited suffixes which were discarded before a successful replan. */
  cancellations: ScenarioCommandFailure[]
  /** The final command rejection after the runtime replan allowance was exhausted. */
  failures: ScenarioCommandFailure[]
  trace: AiPlanTraceEntry[]
  exploredNodes: number
  timings: AiPlanTimings
  report: TurnReport | null
  snapshot: SkirmishSnapshot
}

export interface SkirmishRun {
  state: MatchState
  turns: SkirmishTurn[]
  initialSnapshot: SkirmishSnapshot
}

export interface SkirmishSnapshot {
  round: number
  activeParticipantId: string
  status: MatchState['status']
  objects: Array<{
    position: { column: number; row: number }
    object: MapObject
  }>
  domains: Record<string, {
    population: number
    resources: Record<ResourceId, number>
  }>
}

export interface SkirmishCheckpoint {
  targetRound: number
  reachedRound: number
  status: MatchState['status']
  winnerIds: string[]
  eliminations: Array<{ ownerId: string; defeatedBy: string; round: number }>
  participants: Array<{
    ownerId: string
    profileId: AiProfileId
    alive: boolean
    phase: AiStrategicPhase | null
    wave: AiWaveKind | null
    population: number
    resources: Record<ResourceId, number>
    castle: { column: number; row: number; hitPoints: number; maxHitPoints: number } | null
    buildings: Partial<Record<BuildingKind, number>>
    squads: Array<{
      column: number
      row: number
      units: Record<'militia' | 'spearmen' | 'archers' | 'knights', number>
      health: number | null
    }>
    activity: {
      builds: Partial<Record<BuildingKind, number>>
      recruits: number
      moves: number
      attacks: number
      destructions: number
      demolitions: number
      demolitionReasons: string[]
    }
  }>
}

export interface SkirmishOptions {
  rounds: number
}

export interface DevelopmentScenarioOptions {
  turns: number
  mode?: DevelopmentScenarioMode
  cachedAnalysis?: AiWorldAnalysis | null
}

export interface FrozenTacticalStep {
  round: number
  command: AiCommand
  score: number
  factors: string[]
  event: MatchState['lastEvent']
  ordersRemaining: number
}

export interface FrozenTacticalRun {
  state: MatchState
  memory: AiMemory
  steps: FrozenTacticalStep[]
  failures: ScenarioCommandFailure[]
  exploredNodes: number
}

const emptyPlanTimings = (): AiPlanTimings => ({
  perceptionMs: 0,
  worldAnalysisMs: 0,
  settlementPlanMs: 0,
  tacticalCandidatesMs: 0,
  strategicSearchMs: 0,
  strategicCandidatesMs: 0,
  strategicEvaluationMs: 0,
  strategicEconomyProjectionMs: 0,
  strategicSimulationMs: 0,
  strategicOtherCandidatesMs: 0,
  strategicBuildingGoalsMs: 0,
  strategicBuildingPlacementMs: 0,
  totalMs: 0,
})

const addPlanTimings = (total: AiPlanTimings, addition: AiPlanTimings) => {
  for (const key of Object.keys(total) as Array<keyof AiPlanTimings>) total[key] += addition[key]
}

export function buildingCountsFor(state: MatchState, ownerId: string) {
  return Object.fromEntries(buildingKinds.map((kind) => [
    kind,
    ownedBuildingCount(state, ownerId, kind),
  ])) as Record<BuildingKind, number>
}

function skirmishSnapshotFor(state: MatchState): SkirmishSnapshot {
  return {
    round: state.turn,
    activeParticipantId: state.activeParticipantId,
    status: state.status,
    objects: aiObjectEntries(state.scenario).map(({ position, object }) => ({
      position: { ...position },
      object: structuredClone(object),
    })),
    domains: Object.fromEntries(Object.entries(state.domains).map(([ownerId, domain]) => [ownerId, {
      population: domain.population,
      resources: { ...domain.resources },
    }])),
  }
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
  options: DevelopmentScenarioOptions,
): ScenarioRun {
  assertScenarioState(initialState)
  const participantId = `ai-${profileId}`
  const mode = options.mode ?? 'full'
  let state = advanceToParticipant(initialState, participantId)
  const analysis = options.cachedAnalysis === undefined
    ? analyzeAiWorld(state.scenario, participantId)
    : options.cachedAnalysis
  const turns: ScenarioTurn[] = []

  for (let index = 0; index < options.turns && state.status === 'playing'; index += 1) {
    let planned = planAiTurn(state, state.aiMemory[participantId] ?? createAiMemory(), profileId, {
      cachedAnalysis: analysis,
      mode,
    })
    const plannedCommands: AiCommand[] = []
    const executed: AiCommand[] = []
    const cancellations: ScenarioCommandFailure[] = []
    const failures: ScenarioCommandFailure[] = []
    const trace: AiPlanTraceEntry[] = []
    let exploredNodes = 0
    const timings = emptyPlanTimings()
    for (let attempt = 0; attempt < aiPlannerConfig.maximumPlanAttempts && state.status === 'playing'; attempt += 1) {
      if (attempt > 0) {
        planned = planAiTurn(state, state.aiMemory[participantId] ?? createAiMemory(), profileId, {
          cachedAnalysis: analysis,
          mode,
        })
      }
      plannedCommands.push(...planned.commands)
      trace.push(...planned.trace)
      exploredNodes += planned.exploredNodes
      addPlanTimings(timings, planned.timings)
      let commandFailed = false
      for (const command of planned.commands) {
        const result = executeAiCommand(state, command)
        if (!result.ok) {
          const failure = { command, reason: result.reason }
          if (attempt + 1 < aiPlannerConfig.maximumPlanAttempts) cancellations.push(failure)
          else failures.push(failure)
          state = rememberAiCommandFailure(state, participantId, command, result.reason)
          commandFailed = true
          break
        }
        state = result.state
        executed.push(command)
      }
      if (commandFailed) continue
      state = {
        ...state,
        aiMemory: { ...state.aiMemory, [participantId]: planned.memory },
      }
      break
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
      planned: plannedCommands,
      executed,
      cancellations,
      failures,
      trace,
      exploredNodes,
      timings,
      report,
      buildingCounts: buildingCountsFor(state, participantId),
      armySize: aiObjectEntries(state.scenario, participantId).reduce((sum, entry) => (
        entry.object.type === 'squad'
          ? sum + Object.values(entry.object.units).reduce((unitSum, count) => unitSum + count, 0)
          : entry.object.type === 'building' && entry.object.kind === 'tower'
            ? sum + (entry.object.garrison?.archers ?? 0)
            : sum
      ), 0),
    })
    if (state.status === 'playing') state = advanceToParticipant(state, participantId)
  }

  return { mode, state, turns }
}

/**
 * Runs the real participant cycle for an all-AI match. Unlike the isolated
 * development and frozen-tactics harnesses, both economies, memories, armies,
 * destruction and victory conditions remain authoritative throughout.
 */
export function runAiSkirmish(initialState: MatchState, options: SkirmishOptions): SkirmishRun {
  assertScenarioState(initialState)
  if (initialState.scenario.participants.some((participant) => participant.kind !== 'ai' || !participant.profileId)) {
    throw new Error('AI skirmish requires only profiled AI participants')
  }
  const finalRound = initialState.turn + Math.max(0, Math.floor(options.rounds))
  const analyses = new Map(initialState.scenario.participants.map((participant) => [
    participant.id,
    analyzeAiWorld(initialState.scenario, participant.id),
  ]))
  const turns: SkirmishTurn[] = []
  const initialSnapshot = skirmishSnapshotFor(initialState)
  let state = initialState
  while (state.status === 'playing' && state.turn < finalRound) {
    const participant = state.scenario.participants.find((candidate) => candidate.id === state.activeParticipantId)
    if (!participant?.profileId) throw new Error(`Missing AI profile for ${state.activeParticipantId}`)
    const ownerId = participant.id
    let planned = planAiTurn(state, state.aiMemory[ownerId] ?? createAiMemory(), participant.profileId, {
      cachedAnalysis: analyses.get(ownerId),
    })
    const plannedCommands: AiCommand[] = []
    const executed: AiCommand[] = []
    const events: Array<MatchState['lastEvent']> = []
    const cancellations: ScenarioCommandFailure[] = []
    const failures: ScenarioCommandFailure[] = []
    const trace: AiPlanTraceEntry[] = []
    let exploredNodes = 0
    const timings = emptyPlanTimings()
    for (let attempt = 0; attempt < aiPlannerConfig.maximumPlanAttempts && state.status === 'playing'; attempt += 1) {
      if (attempt > 0) {
        planned = planAiTurn(state, state.aiMemory[ownerId] ?? createAiMemory(), participant.profileId, {
          cachedAnalysis: analyses.get(ownerId),
        })
      }
      plannedCommands.push(...planned.commands)
      trace.push(...planned.trace)
      exploredNodes += planned.exploredNodes
      addPlanTimings(timings, planned.timings)
      let commandFailed = false
      for (const command of planned.commands) {
        const previousEvent = state.lastEvent
        const result = executeAiCommand(state, command)
        if (!result.ok) {
          const failure = { command, reason: result.reason }
          if (attempt + 1 < aiPlannerConfig.maximumPlanAttempts) cancellations.push(failure)
          else failures.push(failure)
          state = rememberAiCommandFailure(state, ownerId, command, result.reason)
          commandFailed = true
          break
        }
        state = result.state
        executed.push(command)
        events.push(state.lastEvent === previousEvent ? null : state.lastEvent)
        if (state.status !== 'playing') break
      }
      if (commandFailed) continue
      state = { ...state, aiMemory: { ...state.aiMemory, [ownerId]: planned.memory } }
      break
    }
    if (state.status !== 'playing') {
      turns.push({
        round: state.turn, ownerId, profileId: participant.profileId,
        phase: planned.memory.phase, wave: planned.memory.wave,
        planned: plannedCommands, executed, events, cancellations, failures, trace,
        exploredNodes,
        timings,
        report: null,
        snapshot: skirmishSnapshotFor(state),
      })
      break
    }
    const round = state.turn
    const ended = endTurn(state)
    if (!ended.ok) throw new Error(`Could not finish ${ownerId}'s skirmish turn: ${ended.reason}`)
    state = ended.state
    const report = state.lastTurnReports[ownerId]
    if (!report) throw new Error(`Missing economy report for ${ownerId} on round ${round}`)
    turns.push({
      round, ownerId, profileId: participant.profileId,
      phase: planned.memory.phase, wave: planned.memory.wave,
      planned: plannedCommands, executed, events, cancellations, failures, trace,
      exploredNodes, timings, report,
      snapshot: skirmishSnapshotFor(state),
    })
  }
  return { state, turns, initialSnapshot }
}

/**
 * Compresses a long authoritative match into fixed windows. A match that ends
 * early still produces every requested checkpoint: later windows retain the
 * final position and make the victory round explicit instead of silently
 * shortening the report.
 */
export function skirmishCheckpointsFor(
  run: SkirmishRun,
  interval = 50,
  checkpointCount = 10,
): SkirmishCheckpoint[] {
  const participants = run.state.scenario.participants.flatMap((participant) => (
    participant.profileId ? [{ ownerId: participant.id, profileId: participant.profileId }] : []
  ))
  const eliminations: SkirmishCheckpoint['eliminations'] = []
  let alive = new Set(run.initialSnapshot.objects.flatMap(({ object }) => (
    object.type === 'castle' ? [object.ownerId] : []
  )))
  run.turns.forEach((turn) => {
    const nextAlive = new Set(turn.snapshot.objects.flatMap(({ object }) => (
      object.type === 'castle' ? [object.ownerId] : []
    )))
    alive.forEach((ownerId) => {
      if (!nextAlive.has(ownerId)) eliminations.push({ ownerId, defeatedBy: turn.ownerId, round: turn.round })
    })
    alive = nextAlive
  })

  return Array.from({ length: checkpointCount }, (_, index) => {
    const targetRound = (index + 1) * interval
    const reachedTurns = run.turns.filter((turn) => turn.round <= targetRound)
    const latestTurn = reachedTurns.at(-1) ?? run.turns.at(-1)
    const snapshot = latestTurn?.snapshot ?? run.initialSnapshot
    const windowStart = targetRound - interval + 1
    const windowTurns = run.turns.filter((turn) => turn.round >= windowStart && turn.round <= targetRound)
    const aliveIds = new Set(snapshot.objects.flatMap(({ object }) => object.type === 'castle' ? [object.ownerId] : []))
    const ended = snapshot.status !== 'playing'

    return {
      targetRound,
      reachedRound: snapshot.round,
      status: snapshot.status,
      winnerIds: ended ? [...aliveIds].sort() : [],
      eliminations: eliminations.filter((event) => event.round >= windowStart && event.round <= targetRound),
      participants: participants.map(({ ownerId, profileId }) => {
        const ownerObjects = snapshot.objects.filter(({ object }) => object.ownerId === ownerId)
        const latestOwnerTurn = reachedTurns.filter((turn) => turn.ownerId === ownerId).at(-1)
        const ownerWindowTurns = windowTurns.filter((turn) => turn.ownerId === ownerId)
        const builds: Partial<Record<BuildingKind, number>> = {}
        const buildings: Partial<Record<BuildingKind, number>> = {}
        ownerObjects.forEach(({ object }) => {
          if (object.type === 'building') buildings[object.kind] = (buildings[object.kind] ?? 0) + 1
        })
        ownerWindowTurns.forEach((turn) => turn.executed.forEach((command) => {
          if (command.type === 'build') builds[command.building] = (builds[command.building] ?? 0) + 1
        }))
        const castleEntry = ownerObjects.find(({ object }) => object.type === 'castle')
        const castle = castleEntry?.object.type === 'castle' ? {
          ...castleEntry.position,
          hitPoints: castleEntry.object.hitPoints,
          maxHitPoints: castleEntry.object.maxHitPoints,
        } : null
        const domain = snapshot.domains[ownerId]
        return {
          ownerId,
          profileId,
          alive: aliveIds.has(ownerId),
          phase: latestOwnerTurn?.phase ?? null,
          wave: latestOwnerTurn?.wave ?? null,
          population: domain?.population ?? 0,
          resources: domain?.resources ?? Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as Record<ResourceId, number>,
          castle,
          buildings,
          squads: ownerObjects.flatMap(({ position, object }) => object.type === 'squad' ? [{
            ...position,
            units: { ...object.units },
            health: object.health ?? null,
          }] : []).sort((first, second) => first.row - second.row || first.column - second.column),
          activity: {
            builds,
            recruits: ownerWindowTurns.reduce((sum, turn) => sum + turn.executed.reduce((turnSum, command) => (
              turnSum + (command.type === 'recruit' ? command.quantity : 0)
            ), 0), 0),
            moves: ownerWindowTurns.reduce((sum, turn) => sum + turn.events.filter((event) => event?.kind === 'moved').length, 0),
            attacks: ownerWindowTurns.reduce((sum, turn) => sum + turn.events.filter((event) => event?.kind === 'attacked').length, 0),
            destructions: ownerWindowTurns.reduce((sum, turn) => sum + turn.events.filter((event) => event?.kind === 'destroyed').length, 0),
            demolitions: ownerWindowTurns.reduce((sum, turn) => sum + turn.events.filter((event) => event?.kind === 'demolished').length, 0),
            demolitionReasons: ownerWindowTurns.flatMap((turn) => turn.trace.flatMap((entry) => (
              entry.command?.type === 'demolish' && !entry.rejectedReason
                ? [`@${entry.command.position.column},${entry.command.position.row}:${entry.factors.join('+')}`]
                : []
            ))),
          },
        }
      }),
    }
  })
}

export function formatSkirmishCheckpointReport(title: string, checkpoints: readonly SkirmishCheckpoint[]) {
  const resourceLabel = (resources: Record<ResourceId, number>) => resourceIds
    .map((resource) => `${resource}=${Math.round(resources[resource] * 10) / 10}`).join(' ')
  const buildingLabel = (buildings: Partial<Record<BuildingKind, number>>) => Object.entries(buildings)
    .filter(([, count]) => count && count > 0).map(([kind, count]) => `${kind}:${count}`).join(' ') || 'none'
  const squadLabel = (checkpoint: SkirmishCheckpoint['participants'][number]) => checkpoint.squads.map((squad) => (
    `(${squad.column},${squad.row})[m${squad.units.militia}/s${squad.units.spearmen}/a${squad.units.archers}/k${squad.units.knights}]`
  )).join(' ') || 'none'
  const lines = [title]
  checkpoints.forEach((checkpoint, index) => {
    const previous = checkpoints[index - 1]
    lines.push(`\n=== checkpoint ${checkpoint.targetRound} (state round ${checkpoint.reachedRound}, ${checkpoint.status}) ===`)
    if (previous && checkpoint.status !== 'playing' && previous.status !== 'playing'
      && checkpoint.reachedRound === previous.reachedRound) {
      lines.push(`final state unchanged; winner: ${checkpoint.winnerIds.join(', ')}`)
      return
    }
    lines.push(checkpoint.winnerIds.length ? `winner: ${checkpoint.winnerIds.join(', ')}` : 'winner: pending')
    lines.push(checkpoint.eliminations.length
      ? `eliminations: ${checkpoint.eliminations.map((event) => `${event.defeatedBy} > ${event.ownerId} @${event.round}`).join(', ')}`
      : 'eliminations: none')
    checkpoint.participants.forEach((participant) => lines.push(
      `- ${participant.ownerId} (${participant.profileId}) ${participant.alive ? 'alive' : 'defeated'} phase=${participant.phase ?? '-'} wave=${participant.wave ?? '-'} population=${participant.population}`,
      `  castle=${participant.castle ? `${participant.castle.column},${participant.castle.row} hp=${participant.castle.hitPoints}/${participant.castle.maxHitPoints}` : 'destroyed'}`,
      `  storage: ${resourceLabel(participant.resources)}`,
      `  buildings: ${buildingLabel(participant.buildings)}`,
      `  squads: ${squadLabel(participant)}`,
      `  window activity: builds=${buildingLabel(participant.activity.builds)} recruits=${participant.activity.recruits} moves=${participant.activity.moves} attacks=${participant.activity.attacks} destroys=${participant.activity.destructions} demolitions=${participant.activity.demolitions}`,
      ...(participant.activity.demolitionReasons.length
        ? [`  demolition reasons: ${participant.activity.demolitionReasons.join(' | ')}`]
        : []),
    ))
  })
  return lines.join('\n')
}

/** Runs only the tactical selector in a fixed phase, without an economy tick. */
export function runFrozenTactics(
  initialState: MatchState,
  profileId: AiProfileId,
  memory: AiMemory,
  phase: AiStrategicPhase,
  maximumCommands: number = aiPlannerConfig.maximumCommands,
): FrozenTacticalRun {
  return runFrozenTacticalRounds(initialState, profileId, memory, phase, 1, maximumCommands)
}

/**
 * Repeats authored tactical turns while freezing production, upkeep and every
 * opponent. This is intentionally not a match simulation: it lets siege tests
 * observe several legal attack/movement turns without an unrelated economy or
 * a second AI changing the fixture between decisions.
 */
export function runFrozenTacticalRounds(
  initialState: MatchState,
  profileId: AiProfileId,
  memory: AiMemory,
  phase: AiStrategicPhase,
  rounds: number,
  maximumCommandsPerRound: number = aiPlannerConfig.maximumCommands,
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
  let exploredNodes = 0
  const countNode = () => {
    exploredNodes += 1
    return true
  }

  for (let round = 1; round <= rounds && state.status === 'playing' && failures.length === 0; round += 1) {
    if (round > 1) {
      state = { ...state, turn: state.turn + 1, ordersRemaining: gameConfig.turn.maxOrders }
    }
    const roundSteps: FrozenTacticalStep[] = []
    const traversedEdges = new Set<string>()
    while (state.ordersRemaining > 0 && roundSteps.length < maximumCommandsPerRound && countNode()) {
      currentMemory = {
        ...currentMemory,
        squadRoles: assignSquadRoles(state, aiProfiles[profileId], currentMemory.squadRoles, phase),
      }
      const candidate = selectTacticalCandidate(
        tacticalCandidates(state, aiProfiles[profileId], currentMemory, phase, countNode),
        {
          phase,
          idleTurns: currentMemory.idleTurns,
          previousCommands: roundSteps.map((step) => step.command),
          traversedEdges,
        },
      )
      if (!candidate) break
      const mergesFriendlySquads = candidate.command.type === 'move-or-attack'
        && objectAt(state, candidate.command.to)?.type === 'squad'
        && objectAt(state, candidate.command.to)?.ownerId === state.activeParticipantId
      const result = executeAiCommand(state, candidate.command)
      if (!result.ok) {
        failures.push({ command: candidate.command, reason: result.reason })
        break
      }
      state = result.state
      if (candidate.command.type === 'move-or-attack') {
        currentMemory = {
          ...currentMemory,
          recentMovements: [...currentMemory.recentMovements.filter((entry) => (
            state.turn - entry.turn <= aiPlannerConfig.movementHistoryTurns
          )), { from: candidate.command.from, to: candidate.command.to, turn: state.turn }]
            .slice(-aiPlannerConfig.maximumRecentMovements),
        }
      }
      if (candidate.command.type === 'move-or-attack') {
        traversedEdges.add(tacticalMovementEdgeKey(candidate.command.from, candidate.command.to))
      }
      if (candidate.command.type === 'split' || mergesFriendlySquads) {
        currentMemory = { ...currentMemory, lastArmyReorganizationTurn: state.turn }
      }
      const step = {
        round,
        command: candidate.command,
        score: candidate.score,
        factors: candidate.factors,
        event: state.lastEvent,
        ordersRemaining: state.ordersRemaining,
      }
      steps.push(step)
      roundSteps.push(step)
    }
  }
  return { state, memory: currentMemory, steps, failures, exploredNodes }
}
