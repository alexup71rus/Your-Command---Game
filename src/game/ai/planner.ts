import { aiBuildingZoneByKind, aiPlannerConfig, aiProfiles } from '../../config/ai'
import { gameConfig } from '../../config/game'
import { economyBuildingKinds, resourceIds } from '../../config/rules'
import { executeAiCommand } from './commands'
import {
  aiObjectEntries,
  aiWorldAnalysisKey,
  analyzeAiWorld,
  castlePositionFor,
  createSettlementPlan,
  positionDistance,
  positionKey,
  type AiWorldAnalysis,
} from './analysis'
import { createAiPerception } from './perception'
import {
  chooseTargetOwner,
  economySnapshotFor,
  immediateCriticalAssetAttackFor,
  marketCandidate,
  projectedStrategicScore,
  recruitmentCandidate,
  nextFortificationStep,
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
import { createAiMemory, type AiCommand, type AiMemory, type AiPlan, type AiPlanTraceEntry, type AiSettlementPlan } from './model'
import type { AiProfileId } from '../scenario'
import { buildingResourceCostFor, objectAt, projectOwnerEconomy, type MatchState } from '../match'

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

function strategicBranchFamily(candidate: StrategicCandidate | undefined) {
  if (!candidate) return 'wait'
  const command = candidate.command
  if (command.type === 'build') return `build:${aiBuildingZoneByKind[command.building]}`
  if (command.type === 'trade') return `trade:${command.direction}`
  if (command.type === 'recruit') return 'recruit'
  return command.type
}

function strategicOrderReserve(phase: AiMemory['phase']) {
  if (phase === 'defense') return aiPlannerConfig.defenseStrategicOrderReserve
  if (phase === 'assault') return aiPlannerConfig.assaultOrderReserve
  if (phase === 'mobilization' || phase === 'regroup') return aiPlannerConfig.ordinaryTacticalOrderReserve
  return 0
}

function openingTacticalOrderReserve(state: MatchState, memory: AiMemory) {
  const ordinary = strategicOrderReserve(memory.phase)
  if (memory.phase === 'defense'
    && immediateCriticalAssetAttackFor(state, state.activeParticipantId).threatened) return 0
  if (memory.phase !== 'defense' || nextFortificationStep(state, memory, true) !== 'tower') return ordinary
  const resources = state.domains[state.activeParticipantId]?.resources
  const cost = buildingResourceCostFor(state, state.activeParticipantId, 'tower')
  const towerAffordable = resources && resourceIds.every((resource) => resources[resource] >= (cost[resource] ?? 0))
  return towerAffordable ? aiPlannerConfig.defenseTowerOrderReserve : ordinary
}

function searchStrategicSequence(
  state: MatchState,
  profile: (typeof aiProfiles)[AiProfileId],
  analysis: AiWorldAnalysis,
  memory: AiMemory,
  countNode: () => boolean,
  options: StrategicSearchOptions = {},
) {
  const branchesForTurn = (
    turnState: MatchState,
    branchOptions: StrategicSearchOptions,
  ) => {
    const branchReserve = branchOptions.orderReserve ?? strategicOrderReserve(memory.phase)
    const branchMode = branchOptions.mode ?? 'full'
    const rootScore = projectedStrategicScore(turnState, profile, memory.phase)
    const root: SearchNode = { state: turnState, candidates: [], bonus: 0, utility: rootScore }
    let beam: SearchNode[] = [root]
    const explored: SearchNode[] = [root]
    for (let depth = 0; depth < aiPlannerConfig.strategicSearchDepth; depth += 1) {
      const expanded: SearchNode[] = []
      for (const node of beam) {
        const candidates = strategicCandidates(node.state, profile, analysis, memory, memory.phase, countNode,
          depth === 0 && node === beam[0] ? branchOptions.diagnostics : undefined)
          .filter((candidate) => commandAllowed(node.state, candidate.command, branchMode))
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
            if (node.candidates.some((selected) => selected.command.type === 'build')) continue
          }
          if (candidate.command.type === 'build') {
            const position = candidate.command.position
            if (node.candidates.some((selected) => selected.command.type === 'demolish'
              && selected.command.position.column === position.column
              && selected.command.position.row === position.row)) continue
            if (node.candidates.some((selected) => selected.command.type === 'demolish')) continue
          }
          const result = executeAiCommand(node.state, candidate.command)
          if (!result.ok) continue
          const spentOrders = node.state.ordersRemaining - result.state.ordersRemaining
          if (spentOrders > 0 && result.state.ordersRemaining < branchReserve) continue
          const projected = projectedStrategicScore(result.state, profile, memory.phase)
          const prior = Math.max(-aiPlannerConfig.candidatePriorLimit,
            Math.min(aiPlannerConfig.candidatePriorLimit, candidate.utility * aiPlannerConfig.candidatePriorScale))
          const bonus = node.bonus + prior
          expanded.push({
            state: result.state,
            candidates: [...node.candidates, candidate],
            bonus,
            utility: projected + bonus,
          })
        }
      }
      if (expanded.length === 0) break
      expanded.sort((first, second) => second.utility - first.utility || JSON.stringify(first.candidates.map(({ command }) => command)).localeCompare(JSON.stringify(second.candidates.map(({ command }) => command))))
      explored.push(...expanded)
      beam = expanded.slice(0, aiPlannerConfig.strategicBeamWidth)
    }
    const ordered = explored.slice(1).sort((first, second) => second.utility - first.utility
      || JSON.stringify(first.candidates.map(({ command }) => command)).localeCompare(JSON.stringify(second.candidates.map(({ command }) => command))))
    // A pure top-N cut keeps several near-identical cheap economy branches and
    // drops an enabling action such as a barracks or market before lookahead
    // can observe the commands it unlocks next turn. Preserve the best branch
    // from each broad strategic intent, then fill remaining slots by value.
    const familyBest = new Map<string, SearchNode>()
    ordered.forEach((branch) => {
      const family = strategicBranchFamily(branch.candidates[0])
      if (!familyBest.has(family)) familyBest.set(family, branch)
    })
    const representatives = [...familyBest.values()].sort((first, second) => (
      (second.candidates[0]?.utility ?? 0) - (first.candidates[0]?.utility ?? 0)
      || second.utility - first.utility
    ))
    const selected: SearchNode[] = []
    ;[...representatives, ...ordered].forEach((branch) => {
      if (selected.length >= aiPlannerConfig.strategicBeamWidth) return
      if (!selected.includes(branch)) selected.push(branch)
    })
    return [root, ...selected]
  }

  const reserve = options.orderReserve ?? strategicOrderReserve(memory.phase)
  const mode = options.mode ?? 'full'
  const currentBranches = branchesForTurn(state, { ...options, orderReserve: reserve, mode })
    .slice(0, aiPlannerConfig.strategicCurrentForecastWidth)
  const futureBranchesForTurn = (futureState: MatchState) => {
    const root: SearchNode = {
      state: futureState,
      candidates: [],
      bonus: 0,
      utility: projectedStrategicScore(futureState, profile, memory.phase),
    }
    const candidates = strategicCandidates(
      futureState,
      profile,
      analysis,
      memory,
      memory.phase,
      countNode,
    ).filter((candidate) => commandAllowed(futureState, candidate.command, mode))
      .slice(0, aiPlannerConfig.strategicFutureCandidateWidth)
    const branches = candidates.flatMap((candidate): SearchNode[] => {
      if (!countNode()) return []
      const result = executeAiCommand(futureState, candidate.command)
      if (!result.ok) return []
      const spentOrders = futureState.ordersRemaining - result.state.ordersRemaining
      if (spentOrders > 0 && result.state.ordersRemaining < reserve) return []
      const prior = Math.max(-aiPlannerConfig.candidatePriorLimit,
        Math.min(aiPlannerConfig.candidatePriorLimit, candidate.utility * aiPlannerConfig.candidatePriorScale))
      return [{
        state: result.state,
        candidates: [candidate],
        bonus: prior,
        utility: projectedStrategicScore(result.state, profile, memory.phase) + prior,
      }]
    }).sort((first, second) => second.utility - first.utility
      || JSON.stringify(first.candidates.map(({ command }) => command)).localeCompare(JSON.stringify(second.candidates.map(({ command }) => command))))
    return [root, ...branches]
  }
  const forecast = (forecastState: MatchState, turnsRemaining: number): number => {
    if (turnsRemaining <= 0 || !countNode()) {
      return projectedStrategicScore(forecastState, profile, memory.phase)
    }
    const advanced = projectOwnerEconomy(
      forecastState,
      forecastState.activeParticipantId,
      1,
    ).state
    const futureBranches = futureBranchesForTurn(advanced)
    return Math.max(...futureBranches.map((branch) => (
      branch.bonus + aiPlannerConfig.strategicFutureDiscount
        * forecast(branch.state, turnsRemaining - 1)
    )))
  }
  const evaluated = currentBranches.map((branch) => ({
    branch,
    value: branch.bonus + aiPlannerConfig.strategicFutureDiscount
      * forecast(branch.state, aiPlannerConfig.strategicLookaheadTurns - 1),
  })).sort((first, second) => second.value - first.value
    || JSON.stringify(first.branch.candidates.map(({ command }) => command)).localeCompare(JSON.stringify(second.branch.candidates.map(({ command }) => command))))
  const selected = evaluated[0]
  if (!selected) return currentBranches[0]
  const wait = evaluated.find((entry) => entry.branch.candidates.length === 0)
  if (selected.branch.candidates.length === 0 || !wait) return selected.branch
  const [first, ...rest] = selected.branch.candidates
  const forecastDelta = selected.value - wait.value
  return {
    ...selected.branch,
    candidates: [{
      ...first,
      factors: [
        ...first.factors,
        `lookahead:${aiPlannerConfig.strategicLookaheadTurns}`,
        `forecast-delta:${forecastDelta.toFixed(1)}`,
      ],
    }, ...rest],
  }
}

function normalizeMemory(previous: AiMemory) {
  return {
    ...createAiMemory(),
    ...previous,
    squadRoles: previous.squadRoles ?? {},
    contacts: previous.contacts ?? [],
    blockedCells: previous.blockedCells ?? [],
    recentMovements: previous.recentMovements ?? [],
  }
}

function fortificationCommitted(state: MatchState, plan: AiSettlementPlan) {
  return plan.fortification?.lines.some((line) => (
    [line.gate, ...line.walls, ...line.towers].some((position) => {
      const object = objectAt(state, position)
      return object?.type === 'building' && object.ownerId === state.activeParticipantId
        && (object.kind === 'barbican' || object.kind === 'wall' || object.kind === 'tower')
    })
  )) ?? false
}

function preserveCommittedFortification(
  state: MatchState,
  previous: AiSettlementPlan,
  refreshed: AiSettlementPlan,
) {
  if (!fortificationCommitted(state, previous)) return refreshed
  const primary = previous.fortification?.lines[0]
  return {
    ...refreshed,
    // A started castle is a commitment, not a suggestion. Replanning the
    // economy around it must not redraw half-built walls into another shape.
    fortification: previous.fortification,
    reservedCorridors: previous.reservedCorridors,
    reservedSites: {
      ...refreshed.reservedSites,
      gate: primary?.gate,
      leftTower: primary?.towers[0],
      rightTower: primary?.towers[1],
      outpostTower: previous.reservedSites.outpostTower,
    },
    zones: {
      ...refreshed.zones,
      defense: previous.zones.defense,
    },
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
  const countNode = () => {
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
  if (!analysis) return { commands: [], memory, exploredNodes, elapsedMs: performance.now() - startedAt, trace: [] }

  let settlementPlan = memory.settlementPlan
  let planReviewReason: 'initial' | 'terrain-change' | 'stalled' | 'periodic' | null = null
  if (!settlementPlan) {
    settlementPlan = createSettlementPlan(analysis, state.scenario, profile)
    planReviewReason = 'initial'
  } else {
    const terrainChanged = memory.settlementPlanAnalysisKey !== null
      && memory.settlementPlanAnalysisKey !== analysis.key
    const stalledReview = memory.stalledTurns >= aiPlannerConfig.relaxBlueprintAfterStalledTurns
      && state.turn - memory.lastSettlementPlanReviewTurn >= aiPlannerConfig.relaxBlueprintAfterStalledTurns
    const periodicReview = state.turn - memory.lastSettlementPlanReviewTurn
      >= aiPlannerConfig.settlementPlanReviewInterval
    if (terrainChanged || stalledReview || periodicReview) {
      const refreshed = createSettlementPlan(analysis, state.scenario, profile)
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
      const generatedCandidates = tacticalCandidates(state, profile, memory, phase, tacticalCountNode)
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
    const recovery = searchStrategicSequence(state, profile, analysis, memory, countNode, {
      diagnostics: trace,
      orderReserve: strategicOrderReserve(memory.phase),
      mode,
    })
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
    const strategic = searchStrategicSequence(
      state,
      profile,
      analysis,
      memory,
      countNode,
      {
        diagnostics: trace,
        // These phases already spent their tactical slice before this search.
        // Keeping a second "tactical reserve" here made six-order towers
        // impossible whenever even one combat command had been issued.
        orderReserve: phase === 'defense' || phase === 'assault' || phase === 'regroup'
          ? 0
          : strategicOrderReserve(phase),
        mode,
      },
    )
    for (const candidate of strategic.candidates) {
      if (commands.length >= aiPlannerConfig.maximumCommands) break
      if (!apply(candidate.command, candidate.factors, candidate.utility, candidate.goal)) break
    }
  }

  if (phase !== 'defense' && phase !== 'assault' && phase !== 'regroup') runTactics()

  const elapsedMs = performance.now() - startedAt
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
    trace,
  }
}
