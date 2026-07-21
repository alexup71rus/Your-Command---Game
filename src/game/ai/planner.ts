import { aiPlannerConfig, aiProfiles } from '../../config/ai'
import { gameConfig } from '../../config/game'
import { economyBuildingKinds } from '../../config/rules'
import { executeAiCommand } from './commands'
import { aiWorldAnalysisKey, analyzeAiWorld, createSettlementPlan, type AiWorldAnalysis } from './analysis'
import { createAiPerception } from './perception'
import {
  chooseTargetOwner,
  economySnapshotFor,
  marketCandidate,
  projectedStrategicScore,
  recruitmentCandidate,
  strategicCandidates,
  strategicPhaseFor,
  type StrategicCandidate,
} from './strategy'
import {
  assignSquadRoles,
  selectTacticalCandidate,
  tacticalCandidates,
  tacticalMovementEdgeKey,
  waveFor,
} from './tactics'
import { createAiMemory, type AiCommand, type AiMemory, type AiPlan, type AiPlanTraceEntry } from './model'
import type { AiProfileId } from '../scenario'
import { objectAt, type MatchState } from '../match'

interface SearchNode {
  state: MatchState
  candidates: StrategicCandidate[]
  bonus: number
  utility: number
}

export type AiPlanningMode = 'full' | 'development-only' | 'economy-only' | 'combat-only'

export interface AiPlanningOptions {
  cachedAnalysis?: AiWorldAnalysis | null
  mode?: AiPlanningMode
  /** Tests can rely exclusively on the deterministic node budget. */
  enforceTimeBudget?: boolean
  nodeBudget?: number
}

interface StrategicSearchOptions {
  diagnostics?: AiPlanTraceEntry[]
  orderReserve?: number
  mode?: AiPlanningMode
}

const engagementCommandTypes = new Set<AiCommand['type']>([
  'move-or-attack',
  'split',
  'garrison',
  'ungarrison',
  'tower-attack',
])

function commandAllowed(state: MatchState, command: AiCommand, mode: AiPlanningMode) {
  if (mode === 'full') return true
  const engagement = engagementCommandTypes.has(command.type)
  if (mode === 'combat-only') return engagement
  if (engagement) return false
  if (mode === 'development-only') return true
  if (command.type === 'build') {
    return command.building !== 'barracks' && economyBuildingKinds.includes(command.building)
  }
  if (command.type === 'demolish') {
    const object = objectAt(state, command.position)
    return object?.type === 'building'
      && object.kind !== 'barracks'
      && economyBuildingKinds.includes(object.kind)
  }
  return command.type === 'tax' || command.type === 'trade' || command.type === 'dismiss'
}

const commandKey = (command: AiCommand) => JSON.stringify(command)

function strategicOrderReserve(phase: AiMemory['phase']) {
  if (phase === 'assault' || phase === 'defense') return aiPlannerConfig.assaultOrderReserve
  if (phase === 'mobilization' || phase === 'regroup') return aiPlannerConfig.ordinaryTacticalOrderReserve
  return 0
}

function searchStrategicSequence(
  state: MatchState,
  profile: (typeof aiProfiles)[AiProfileId],
  analysis: AiWorldAnalysis,
  memory: AiMemory,
  countNode: () => boolean,
  options: StrategicSearchOptions = {},
) {
  const reserve = options.orderReserve ?? strategicOrderReserve(memory.phase)
  const mode = options.mode ?? 'full'
  const rootScore = projectedStrategicScore(state, profile, memory.phase)
  let beam: SearchNode[] = [{ state, candidates: [], bonus: 0, utility: rootScore }]
  let best = beam[0]
  let bestLegalProgress: SearchNode | null = null
  for (let depth = 0; depth < aiPlannerConfig.strategicSearchDepth; depth += 1) {
    const expanded: SearchNode[] = []
    for (const node of beam) {
      const candidates = strategicCandidates(node.state, profile, analysis, memory, memory.phase, countNode,
        depth === 0 && node === beam[0] ? options.diagnostics : undefined)
        .filter((candidate) => commandAllowed(node.state, candidate.command, mode))
      for (const candidate of candidates) {
        if (!countNode()) break
        if (node.candidates.some((selected) => commandKey(selected.command) === commandKey(candidate.command))) continue
        if (candidate.command.type === 'tax' && node.candidates.some((selected) => selected.command.type === 'tax')) continue
        if (candidate.command.type === 'trade') {
          const tradeCommand = candidate.command
          if (node.candidates.some((selected) => (
            selected.command.type === 'trade'
            && selected.command.resource === tradeCommand.resource
            && selected.command.direction !== tradeCommand.direction
          ))) continue
        }
        if (candidate.command.type === 'demolish') {
          const position = candidate.command.position
          if (node.candidates.some((selected) => selected.command.type === 'build'
            && selected.command.position.column === position.column
            && selected.command.position.row === position.row)) continue
        }
        if (candidate.command.type === 'build') {
          const position = candidate.command.position
          if (node.candidates.some((selected) => selected.command.type === 'demolish'
            && selected.command.position.column === position.column
            && selected.command.position.row === position.row)) continue
        }
        const result = executeAiCommand(node.state, candidate.command)
        if (!result.ok) continue
        const spentOrders = node.state.ordersRemaining - result.state.ordersRemaining
        if (spentOrders > 0 && result.state.ordersRemaining < reserve) continue
        const projected = projectedStrategicScore(result.state, profile, memory.phase)
        const prior = Math.max(-aiPlannerConfig.candidatePriorLimit,
          Math.min(aiPlannerConfig.candidatePriorLimit, candidate.utility * aiPlannerConfig.candidatePriorScale))
        const bonus = node.bonus + prior
        expanded.push({
          state: result.state,
          candidates: [...node.candidates, candidate],
          bonus,
          utility: projected + bonus + node.candidates.length * aiPlannerConfig.sequenceLengthBonus,
        })
      }
    }
    if (expanded.length === 0) break
    expanded.sort((first, second) => second.utility - first.utility || JSON.stringify(first.candidates.map(({ command }) => command)).localeCompare(JSON.stringify(second.candidates.map(({ command }) => command))))
    if (!bestLegalProgress || expanded[0].utility > bestLegalProgress.utility) bestLegalProgress = expanded[0]
    beam = expanded.slice(0, aiPlannerConfig.strategicBeamWidth)
    if (beam[0].utility > best.utility) best = beam[0]
  }
  // Construction and recruitment pay their cost immediately while their
  // strategic return appears on later turns. On large maps a bounded search can
  // therefore prefer the unchanged root forever even though it found a legal,
  // high-priority recovery or development action. Empty is valid only when no
  // useful legal command was found at all.
  return best.candidates.length > 0 ? best : bestLegalProgress ?? best
}

function normalizeMemory(previous: AiMemory) {
  return {
    ...createAiMemory(),
    ...previous,
    squadRoles: previous.squadRoles ?? {},
    contacts: previous.contacts ?? [],
    blockedCells: previous.blockedCells ?? [],
  }
}

export function planAiTurn(
  authoritativeState: MatchState,
  previousMemory: AiMemory,
  profileId: AiProfileId,
  options: AiPlanningOptions = {},
): AiPlan {
  const profile = aiProfiles[profileId]
  const mode = options.mode ?? 'full'
  const startedAt = performance.now()
  let exploredNodes = 0
  let hitBudget = false
  const countNode = () => {
    const exhausted = exploredNodes >= (options.nodeBudget ?? aiPlannerConfig.nodeBudget)
      || (options.enforceTimeBudget !== false
        && performance.now() - startedAt >= aiPlannerConfig.hardBudgetMs - aiPlannerConfig.deadlineSafetyMarginMs)
    if (exhausted) {
      hitBudget = true
      return false
    }
    exploredNodes += 1
    return true
  }

  const perception = createAiPerception(authoritativeState, authoritativeState.activeParticipantId, normalizeMemory(previousMemory))
  let state = perception.state
  let memory = perception.memory
  const analysis = options.cachedAnalysis?.ownerId === state.activeParticipantId
    && options.cachedAnalysis.key === aiWorldAnalysisKey(state.scenario, state.activeParticipantId)
    ? options.cachedAnalysis
    : analyzeAiWorld(state.scenario, state.activeParticipantId)
  if (!analysis) return { commands: [], memory, exploredNodes, partial: false, elapsedMs: performance.now() - startedAt, trace: [] }

  const settlementPlan = memory.settlementPlan ?? createSettlementPlan(analysis, state.scenario, profile)
  memory = { ...memory, settlementPlan }
  const targetOwnerId = chooseTargetOwner(state, profile, memory)
  const targetChanged = targetOwnerId !== memory.targetOwnerId
  const retargetedAfterStall = targetChanged && memory.idleTurns >= aiPlannerConfig.retargetAfterIdleTurns
  memory = {
    ...memory,
    targetOwnerId,
    lastTargetChangeTurn: targetChanged ? state.turn : memory.lastTargetChangeTurn,
    lastOffensiveEndTurn: targetChanged && memory.phase === 'assault'
      ? state.turn
      : memory.lastOffensiveEndTurn,
    wave: targetChanged && memory.phase === 'assault' ? 'regroup' : memory.wave,
    // A deliberate retarget is part of the anti-stall recovery. Preserve the
    // accumulated inactivity so the new objective can be probed immediately;
    // otherwise every retarget reset prevented the mobilization fallback from
    // ever activating in an FFA with several living opponents.
    idleTurns: targetChanged && !retargetedAfterStall ? 0 : memory.idleTurns,
  }
  const previousPhase = memory.phase
  const phase = strategicPhaseFor(state, profile, memory)
  const stable = phase !== 'recovery' && phase !== 'defense'
  memory = {
    ...memory,
    phase,
    lastOffensiveEndTurn: previousPhase === 'assault' && phase !== 'assault'
      ? state.turn
      : memory.lastOffensiveEndTurn,
    stableTurns: stable ? memory.stableTurns + 1 : 0,
  }
  const nextWave = waveFor(state, profile, memory, phase)
  memory = {
    ...memory,
    squadRoles: assignSquadRoles(state, profile, memory.squadRoles, phase),
    wave: nextWave,
    // Record the turn a main wave is issued so `waveFor` can enforce the
    // main-wave cooldown on subsequent turns.
    lastMainWaveTurn: nextWave === 'main' ? state.turn : memory.lastMainWaveTurn,
  }

  const commands: AiCommand[] = []
  const traversedEdges = new Set<string>()
  const trace: AiPlanTraceEntry[] = [
    { goal: 'layout', score: analysis.layoutScores[settlementPlan.layout], factors: [`layout:${settlementPlan.layout}`, `opening:${settlementPlan.opening}`] },
    { goal: 'target', score: targetOwnerId ? 1 : 0, factors: [`target:${targetOwnerId ?? 'none'}`, `phase:${phase}`, `wave:${memory.wave}`] },
  ]
  const apply = (command: AiCommand, factors: string[], score: number, goal: AiPlanTraceEntry['goal']) => {
    if (!commandAllowed(state, command, mode)) return false
    const mergesFriendlySquads = command.type === 'move-or-attack'
      && objectAt(state, command.from)?.type === 'squad'
      && objectAt(state, command.to)?.type === 'squad'
      && objectAt(state, command.to)?.ownerId === state.activeParticipantId
    const result = executeAiCommand(state, command)
    if (!result.ok) {
      trace.push({ goal, command, score, factors, rejectedReason: result.reason })
      memory = { ...memory, lastCancellationReason: result.reason }
      return false
    }
    state = result.state
    commands.push(command)
    trace.push({ goal, command, score, factors })
    memory = {
      ...memory,
      lastCancellationReason: null,
      lastTaxChangeTurn: command.type === 'tax' ? state.turn : memory.lastTaxChangeTurn,
      lastArmyReorganizationTurn: command.type === 'split' || mergesFriendlySquads ? state.turn : memory.lastArmyReorganizationTurn,
    }
    return true
  }

  const runTactics = () => {
    const initialCommandCount = commands.length
    let guard = 0
    while (state.ordersRemaining > 0 && commands.length < aiPlannerConfig.maximumCommands && countNode()
      && guard < gameConfig.turn.maxOrders * aiPlannerConfig.tacticalGuardMultiplier) {
      guard += 1
      memory = { ...memory, squadRoles: assignSquadRoles(state, profile, memory.squadRoles, phase) }
      const candidate = selectTacticalCandidate(tacticalCandidates(state, profile, memory, phase, countNode), {
        phase,
        idleTurns: memory.idleTurns,
        previousCommands: commands,
        traversedEdges,
        commandAllowed: (command) => commandAllowed(state, command, mode),
      })
      if (!candidate || !apply(candidate.command, candidate.factors, candidate.score, 'tactics')) break
      if (candidate.command.type === 'move-or-attack') {
        traversedEdges.add(tacticalMovementEdgeKey(candidate.command.from, candidate.command.to))
      }
    }
    return commands.length - initialCommandCount
  }

  const openingEconomy = economySnapshotFor(state, state.activeParticipantId)
  const economyEmergency = !openingEconomy.forecastFed || !openingEconomy.upkeepPaid
    || openingEconomy.foodRunway < aiPlannerConfig.emergencyRunwayTurns
    || openingEconomy.goldRunway < aiPlannerConfig.emergencyRunwayTurns
  if (phase === 'defense' && economyEmergency && commands.length < aiPlannerConfig.maximumCommands && countNode()) {
    // A threatened settlement must still execute a viable recovery prefix.
    // The strategic search keeps the combat order reserve intact, so tactics
    // cannot consume every order while the economy collapses underneath it.
    const recovery = searchStrategicSequence(state, profile, analysis, memory, countNode, {
      diagnostics: trace,
      orderReserve: strategicOrderReserve(memory.phase),
      mode,
    })
    for (const candidate of recovery.candidates) {
      if (commands.length >= aiPlannerConfig.maximumCommands || !countNode()) break
      if (!apply(candidate.command, [...candidate.factors, 'defense-economy'], candidate.utility, candidate.goal)) break
    }
  }

  if (phase === 'defense' && commands.length < aiPlannerConfig.maximumCommands && countNode()) {
    let reinforcement = recruitmentCandidate(state, profile, phase, countNode, memory)
    if (!reinforcement) {
      const supply = marketCandidate(state, profile, phase, memory, analysis, countNode)
      if (supply?.command.type === 'trade' && supply.command.resource === 'flour') {
        apply(supply.command, [...supply.factors, 'emergency-supply'], supply.utility + aiPlannerConfig.defenseSupplyUtilityBonus, 'defense')
        reinforcement = recruitmentCandidate(state, profile, phase, countNode, memory)
      }
    }
    if (reinforcement && commandAllowed(state, reinforcement.command, mode)) apply(reinforcement.command, [...reinforcement.factors, 'emergency-reinforcement'],
      reinforcement.utility + aiPlannerConfig.defenseRecruitUtilityBonus, 'defense')
  }

  let openingTacticalCommands = 0
  if (phase === 'defense' || phase === 'assault' || phase === 'regroup') {
    openingTacticalCommands = runTactics()
  }

  if (commands.length < aiPlannerConfig.maximumCommands && countNode()) {
    const strategic = searchStrategicSequence(
      state,
      profile,
      analysis,
      memory,
      countNode,
      {
        diagnostics: trace,
        orderReserve: phase === 'assault' && openingTacticalCommands === 0
          ? 0
          : strategicOrderReserve(phase),
        mode,
      },
    )
    for (const candidate of strategic.candidates) {
      if (commands.length >= aiPlannerConfig.maximumCommands || !countNode()) break
      if (!apply(candidate.command, candidate.factors, candidate.utility, candidate.goal)) break
    }
  }

  if (phase !== 'defense' && phase !== 'assault' && phase !== 'regroup') runTactics()

  const elapsedMs = performance.now() - startedAt
  const closingEconomy = economySnapshotFor(state, state.activeParticipantId)
  const campaignProgress = commands.some((command) => command.type === 'move-or-attack'
    || command.type === 'tower-attack'
    || command.type === 'split'
    || command.type === 'garrison'
    || command.type === 'ungarrison'
    || command.type === 'recruit')
  const productiveTrade = commands.some((command) => command.type === 'trade') && (
    (!openingEconomy.forecastFed && closingEconomy.forecastFed)
    || (!openingEconomy.upkeepPaid && closingEconomy.upkeepPaid)
    || closingEconomy.foodRunway > openingEconomy.foodRunway + aiPlannerConfig.productiveTradeRunwayDelta
    || closingEconomy.goldRunway > openingEconomy.goldRunway + aiPlannerConfig.productiveTradeRunwayDelta
  )
  // Military movement must not hide a blocked settlement blueprint. The
  // economic stall counter deliberately tracks development progress only;
  // campaign inactivity has its own `idleTurns` counter. Mobilization is part
  // of that campaign: a force waiting at assembly points must eventually
  // reconsider its target instead of remaining idle forever. A trade resets the
  // counter only when it measurably improves the live runway, so repeatedly
  // buying a resource for an unreachable goal eventually relaxes the layout.
  const strategicProgress = commands.some((command) => command.type === 'build'
    || command.type === 'demolish'
    || command.type === 'dismiss'
    || command.type === 'recruit') || productiveTrade
  memory = {
    ...memory,
    idleTurns: (phase === 'assault' || phase === 'mobilization') && !campaignProgress
      ? Math.min(state.turn + 1, memory.idleTurns + 1)
      : 0,
    stalledTurns: strategicProgress ? 0 : Math.min(state.turn + 1, memory.stalledTurns + 1),
  }
  return {
    commands,
    memory,
    exploredNodes,
    partial: hitBudget || elapsedMs >= aiPlannerConfig.softBudgetMs,
    elapsedMs,
    trace,
  }
}
