import { aiPlannerConfig, aiProfiles } from '../../config/ai'
import { gameConfig } from '../../config/game'
import { executeAiCommand } from './commands'
import {
  aiObjectEntries,
  aiWorldAnalysisKey,
  analyzeAiWorld,
  castlePositionFor,
  createSettlementPlan,
  positionDistance,
  positionKey,
  withAiObjectIndexCache,
  type AiWorldAnalysis,
} from './analysis'
import { createAiPerception } from './perception'
import {
  chooseTargetOwner,
  economySnapshotFor,
  immediateCriticalAssetAttackFor,
  marketCandidate,
  recruitmentCandidate,
  strategicPhaseFor,
  withStrategicPlacementCache,
} from './strategy'
import {
  assignSquadRoles,
  selectTacticalCandidate,
  tacticalCandidates,
  tacticalMovementEdgeKey,
  waveFor,
} from './tactics'
import type { AiCommand, AiMemory, AiPlan, AiPlanTimings, AiPlanTraceEntry } from './model'
import { normalizeAiMemory, preserveCommittedFortification } from './planning/memory'
import {
  commandAllowed,
  openingTacticalOrderReserve,
  strategicOrderReserve,
  type AiPlanningMode,
} from './planning/policy'
import { searchStrategicSequence } from './planning/strategicSearch'
import type { AiProfileId } from '../scenario'
import { objectAt, withMatchObjectIndexCache, type MatchState } from '../match'
import { withMovementPathCache } from '../pathfinding'

export type { AiPlanningMode } from './planning/policy'

export interface AiPlanningOptions {
  cachedAnalysis?: AiWorldAnalysis | null
  mode?: AiPlanningMode
}

function planAiTurnInternal(
  authoritativeState: MatchState,
  previousMemory: AiMemory,
  profileId: AiProfileId,
  options: AiPlanningOptions = {},
): AiPlan {
  const profile = aiProfiles[profileId]
  const mode = options.mode ?? 'full'
  const startedAt = performance.now()
  const timings: AiPlanTimings = {
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
  }
  type TimedPhase = Exclude<keyof AiPlanTimings, 'totalMs'>
  const measure = <T>(phaseName: TimedPhase, operation: () => T) => {
    const phaseStartedAt = performance.now()
    try {
      return operation()
    } finally {
      timings[phaseName] += performance.now() - phaseStartedAt
    }
  }
  const strategicMetrics = {
    candidatesMs: 0,
    evaluationMs: 0,
    economyProjectionMs: 0,
    simulationMs: 0,
    otherCandidatesMs: 0,
    buildingGoalsMs: 0,
    buildingPlacementMs: 0,
  }
  let exploredNodes = 0
  const countNode = () => {
    exploredNodes += 1
    return true
  }

  const perception = measure('perceptionMs', () => createAiPerception(
    authoritativeState,
    authoritativeState.activeParticipantId,
    normalizeAiMemory(previousMemory),
  ))
  let state = perception.state
  let memory = perception.memory
  const analysis = options.cachedAnalysis?.ownerId === state.activeParticipantId
    && options.cachedAnalysis.key === aiWorldAnalysisKey(state.scenario, state.activeParticipantId)
    ? options.cachedAnalysis
    : measure('worldAnalysisMs', () => analyzeAiWorld(state.scenario, state.activeParticipantId))
  if (!analysis) {
    const elapsedMs = performance.now() - startedAt
    timings.totalMs = elapsedMs
    return { commands: [], memory, exploredNodes, elapsedMs, timings, trace: [] }
  }

  let settlementPlan = memory.settlementPlan
  let planReviewReason: 'initial' | 'terrain-change' | 'stalled' | 'periodic' | null = null
  if (!settlementPlan) {
    settlementPlan = measure('settlementPlanMs', () => createSettlementPlan(
      analysis,
      state.scenario,
      profile,
    ))
    planReviewReason = 'initial'
  } else {
    const terrainChanged = memory.settlementPlanAnalysisKey !== null
      && memory.settlementPlanAnalysisKey !== analysis.key
    const stalledReview = memory.stalledTurns >= aiPlannerConfig.relaxBlueprintAfterStalledTurns
      && state.turn - memory.lastSettlementPlanReviewTurn >= aiPlannerConfig.relaxBlueprintAfterStalledTurns
    const periodicReview = state.turn - memory.lastSettlementPlanReviewTurn
      >= aiPlannerConfig.settlementPlanReviewInterval
    if (terrainChanged || stalledReview || periodicReview) {
      const refreshed = measure('settlementPlanMs', () => createSettlementPlan(
        analysis,
        state.scenario,
        profile,
      ))
      settlementPlan = preserveCommittedFortification(state, settlementPlan, refreshed)
      planReviewReason = terrainChanged ? 'terrain-change' : stalledReview ? 'stalled' : 'periodic'
    }
  }
  memory = {
    ...memory,
    settlementPlan,
    settlementPlanAnalysisKey: analysis.key,
    lastSettlementPlanReviewTurn: planReviewReason
      ? state.turn
      : memory.settlementPlanAnalysisKey === null ? state.turn : memory.lastSettlementPlanReviewTurn,
  }
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
    campaignBestDistance: targetChanged ? null : memory.campaignBestDistance,
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

  const campaignDistanceFor = (candidateState: MatchState) => {
    const target = memory.targetOwnerId
      ? castlePositionFor(candidateState.scenario, memory.targetOwnerId)
      : null
    if (!target) return null
    const distances = aiObjectEntries(candidateState.scenario, candidateState.activeParticipantId)
      .flatMap((entry) => entry.object.type === 'squad'
        ? [positionDistance(entry.position, target)]
        : [])
    return distances.length > 0 ? Math.min(...distances) : null
  }
  const openingCampaignDistance = campaignDistanceFor(state)
  const previousCampaignBest = memory.campaignBestDistance ?? openingCampaignDistance

  const commands: AiCommand[] = []
  const traversedEdges = new Set<string>()
  const trace: AiPlanTraceEntry[] = [
    {
      goal: 'layout',
      score: analysis.layoutScores[settlementPlan.layout],
      factors: [
        `layout:${settlementPlan.layout}`,
        `opening:${settlementPlan.opening}`,
        ...(planReviewReason ? [`plan-review:${planReviewReason}`] : []),
      ],
    },
    { goal: 'target', score: targetOwnerId ? 1 : 0, factors: [`target:${targetOwnerId ?? 'none'}`, `phase:${phase}`, `wave:${memory.wave}`] },
  ]
  const apply = (command: AiCommand, factors: string[], score: number, goal: AiPlanTraceEntry['goal']) => {
    if (!commandAllowed(state, command, mode)) return false
    const mergesFriendlySquads = command.type === 'move-or-attack'
      && objectAt(state, command.from)?.type === 'squad'
      && objectAt(state, command.to)?.type === 'squad'
      && objectAt(state, command.to)?.ownerId === state.activeParticipantId
    const movingRole = command.type === 'move-or-attack'
      ? memory.squadRoles[positionKey(command.from)]
      : undefined
    const result = executeAiCommand(state, command)
    if (!result.ok) {
      trace.push({ goal, command, score, factors, rejectedReason: result.reason })
      memory = { ...memory, lastCancellationReason: result.reason }
      return false
    }
    state = result.state
    commands.push(command)
    trace.push({ goal, command, score, factors })
    let squadRoles = memory.squadRoles
    if (command.type === 'move-or-attack' && movingRole) {
      const sourceAfter = objectAt(state, command.from)
      const destinationAfter = objectAt(state, command.to)
      if (!(sourceAfter?.type === 'squad' && sourceAfter.ownerId === state.activeParticipantId)
        && destinationAfter?.type === 'squad' && destinationAfter.ownerId === state.activeParticipantId) {
        squadRoles = { ...squadRoles }
        delete squadRoles[positionKey(command.from)]
        squadRoles[positionKey(command.to)] ??= movingRole
      }
    }
    const recentMovements = command.type === 'move-or-attack'
      ? [...memory.recentMovements.filter((entry) => (
          state.turn - entry.turn <= aiPlannerConfig.movementHistoryTurns
        )), { from: command.from, to: command.to, turn: state.turn }]
        .slice(-aiPlannerConfig.maximumRecentMovements)
      : memory.recentMovements
    memory = {
      ...memory,
      squadRoles,
      recentMovements,
      lastCancellationReason: null,
      lastTaxChangeTurn: command.type === 'tax' ? state.turn : memory.lastTaxChangeTurn,
      lastArmyReorganizationTurn: command.type === 'split' || mergesFriendlySquads ? state.turn : memory.lastArmyReorganizationTurn,
    }
    return true
  }

  const runTactics = (
    tacticalCountNode: () => boolean = countNode,
    minimumOrdersRemaining = 0,
  ) => {
    const initialCommandCount = commands.length
    let guard = 0
    while (state.ordersRemaining > minimumOrdersRemaining
      && commands.length < aiPlannerConfig.maximumCommands && tacticalCountNode()
      && guard < gameConfig.turn.maxOrders * aiPlannerConfig.tacticalGuardMultiplier) {
      guard += 1
      const generatedCandidates = measure('tacticalCandidatesMs', () => tacticalCandidates(
        state,
        profile,
        memory,
        phase,
        tacticalCountNode,
      ))
      const candidate = selectTacticalCandidate(generatedCandidates, {
        phase,
        idleTurns: memory.idleTurns,
        previousCommands: commands,
        traversedEdges,
        commandAllowed: (command) => commandAllowed(state, command, mode),
      })
      if (!candidate) {
        const best = generatedCandidates[0]
        trace.push({
          goal: 'tactics',
          score: best?.score ?? 0,
          factors: [
            'no-tactical-selection',
            `candidate-count:${generatedCandidates.length}`,
            ...(best ? [
              `best-command:${best.command.type}`,
              `best-score:${best.score.toFixed(1)}`,
              ...best.factors,
            ] : []),
          ],
        })
        break
      }
      const anticipated = executeAiCommand(state, candidate.command)
      if (!anticipated.ok || anticipated.state.ordersRemaining < minimumOrdersRemaining) break
      if (!apply(candidate.command, candidate.factors, candidate.score, 'tactics')) break
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
  const criticalAssetUnderFire = phase === 'defense'
    && immediateCriticalAssetAttackFor(state, state.activeParticipantId).threatened
  if (criticalAssetUnderFire && state.ordersRemaining > 0) {
    // A defeat-critical structure that can be hit with the enemy's next order
    // receives the first executable orders. Recovery search and recruitment
    // may still follow, but cannot make an 18-unit relief force stand idle.
    runTactics(countNode, 0)
  }
  if (phase === 'defense' && state.ordersRemaining > 0 && economyEmergency
    && commands.length < aiPlannerConfig.maximumCommands && countNode()) {
    // A threatened settlement must still execute a viable recovery prefix.
    // The strategic search keeps the combat order reserve intact, so tactics
    // cannot consume every order while the economy collapses underneath it.
    const recovery = measure('strategicSearchMs', () => searchStrategicSequence(state, profile, analysis, memory, countNode, {
      diagnostics: trace,
      metrics: strategicMetrics,
      orderReserve: strategicOrderReserve(memory.phase),
      mode,
    }))
    for (const candidate of recovery.candidates) {
      // Execute the legal prefix selected by the model without a separate
      // eligibility gate between planning and authoritative simulation.
      if (commands.length >= aiPlannerConfig.maximumCommands) break
      if (!apply(candidate.command, [...candidate.factors, 'defense-economy'], candidate.utility, candidate.goal)) break
    }
  }

  if (phase === 'defense' && state.ordersRemaining > 0
    && commands.length < aiPlannerConfig.maximumCommands && countNode()) {
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

  if (phase === 'defense' || phase === 'assault' || phase === 'regroup') {
    runTactics(
      countNode,
      phase === 'defense' ? openingTacticalOrderReserve(state, memory) : aiPlannerConfig.assaultOrderReserve,
    )
  }

  if (state.ordersRemaining > 0 && commands.length < aiPlannerConfig.maximumCommands && countNode()) {
    const strategic = measure('strategicSearchMs', () => searchStrategicSequence(
      state,
      profile,
      analysis,
      memory,
      countNode,
      {
        diagnostics: trace,
        metrics: strategicMetrics,
        // These phases already spent their tactical slice before this search.
        // Keeping a second "tactical reserve" here made six-order towers
        // impossible whenever even one combat command had been issued.
        orderReserve: phase === 'defense' || phase === 'assault' || phase === 'regroup'
          ? 0
          : strategicOrderReserve(phase),
        mode,
      },
    ))
    for (const candidate of strategic.candidates) {
      if (commands.length >= aiPlannerConfig.maximumCommands) break
      if (!apply(candidate.command, candidate.factors, candidate.utility, candidate.goal)) break
    }
  }

  if (phase !== 'defense' && phase !== 'assault' && phase !== 'regroup') runTactics()

  timings.strategicCandidatesMs = strategicMetrics.candidatesMs
  timings.strategicEvaluationMs = strategicMetrics.evaluationMs
  timings.strategicEconomyProjectionMs = strategicMetrics.economyProjectionMs
  timings.strategicSimulationMs = strategicMetrics.simulationMs
  timings.strategicOtherCandidatesMs = strategicMetrics.otherCandidatesMs
  timings.strategicBuildingGoalsMs = strategicMetrics.buildingGoalsMs
  timings.strategicBuildingPlacementMs = strategicMetrics.buildingPlacementMs
  const elapsedMs = performance.now() - startedAt
  timings.totalMs = elapsedMs
  const closingEconomy = economySnapshotFor(state, state.activeParticipantId)
  // Walking is campaign progress only when the front reaches a new best
  // distance against the current target. Local "advance" scores and muster
  // labels are intentionally insufficient: a formation can otherwise walk a
  // two- or four-cell loop forever while resetting the anti-stall timer.
  const closingCampaignDistance = campaignDistanceFor(state)
  const reachedNewCampaignFront = phase === 'assault'
    && closingCampaignDistance !== null
    && previousCampaignBest !== null
    && closingCampaignDistance < previousCampaignBest
  const campaignProgress = commands.some((command) => command.type === 'tower-attack'
    || command.type === 'split'
    || command.type === 'garrison'
    || command.type === 'ungarrison'
    || command.type === 'recruit') || reachedNewCampaignFront || trace.some((entry) => entry.goal === 'tactics'
      && !entry.rejectedReason
      && entry.factors.some((factor) => factor.startsWith('damage:')
        || factor === 'destroy'))
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
    || command.type === 'dismiss'
    || command.type === 'recruit') || productiveTrade
  memory = {
    ...memory,
    campaignBestDistance: closingCampaignDistance === null
      ? memory.campaignBestDistance
      : Math.min(previousCampaignBest ?? closingCampaignDistance, closingCampaignDistance),
    idleTurns: (phase === 'assault' || phase === 'mobilization') && !campaignProgress
      ? Math.min(state.turn + 1, memory.idleTurns + 1)
      : 0,
    stalledTurns: strategicProgress ? 0 : Math.min(state.turn + 1, memory.stalledTurns + 1),
  }
  return {
    commands,
    memory,
    exploredNodes,
    elapsedMs,
    timings,
    trace,
  }
}

export function planAiTurn(
  authoritativeState: MatchState,
  previousMemory: AiMemory,
  profileId: AiProfileId,
  options: AiPlanningOptions = {},
): AiPlan {
  return withMatchObjectIndexCache(() => withAiObjectIndexCache(() => withMovementPathCache(() => (
    withStrategicPlacementCache(() => planAiTurnInternal(authoritativeState, previousMemory, profileId, options))
  ))))
}
