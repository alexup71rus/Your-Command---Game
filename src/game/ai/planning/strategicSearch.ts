import { aiBuildingZoneByKind, aiPlannerConfig } from '../../../config/ai'
import { projectOwnerEconomy, type MatchState } from '../../match'
import type { AiWorldAnalysis } from '../analysis'
import { executeAiCommand } from '../commands'
import type { AiMemory, AiPlanTraceEntry, AiProfileRules } from '../model'
import { projectedStrategicScore, strategicCandidates, type StrategicCandidate } from '../strategy'
import { commandAllowed, strategicOrderReserve, type AiPlanningMode } from './policy'

interface SearchNode {
  state: MatchState
  candidates: StrategicCandidate[]
  bonus: number
  utility: number
}

export interface StrategicSearchOptions {
  diagnostics?: AiPlanTraceEntry[]
  metrics?: StrategicSearchMetrics
  orderReserve?: number
  mode?: AiPlanningMode
}

export interface StrategicSearchMetrics {
  candidatesMs: number
  evaluationMs: number
  economyProjectionMs: number
  simulationMs: number
  otherCandidatesMs: number
  buildingGoalsMs: number
  buildingPlacementMs: number
}

const commandKey = (candidate: StrategicCandidate) => JSON.stringify(candidate.command)

function strategicBranchFamily(candidate: StrategicCandidate | undefined) {
  if (!candidate) return 'wait'
  const command = candidate.command
  if (command.type === 'build') return `build:${aiBuildingZoneByKind[command.building]}`
  if (command.type === 'trade') return `trade:${command.direction}`
  if (command.type === 'recruit') return 'recruit'
  return command.type
}

function commandsConflict(selected: readonly StrategicCandidate[], candidate: StrategicCandidate) {
  if (selected.some((entry) => commandKey(entry) === commandKey(candidate))) return true
  const command = candidate.command
  if (command.type === 'tax') return selected.some((entry) => entry.command.type === 'tax')
  if (command.type === 'trade') {
    return selected.some((entry) => (
      entry.command.type === 'trade'
      && entry.command.resource === command.resource
      && entry.command.direction !== command.direction
    ))
  }
  if (command.type === 'demolish') {
    return selected.some((entry) => entry.command.type === 'build')
  }
  if (command.type === 'build') {
    return selected.some((entry) => entry.command.type === 'demolish')
  }
  return false
}

function branchCommandKey(branch: SearchNode) {
  return JSON.stringify(branch.candidates.map(({ command }) => command))
}

function candidatePrior(candidate: StrategicCandidate) {
  return Math.max(
    -aiPlannerConfig.candidatePriorLimit,
    Math.min(aiPlannerConfig.candidatePriorLimit, candidate.utility * aiPlannerConfig.candidatePriorScale),
  )
}

export function searchStrategicSequence(
  state: MatchState,
  profile: AiProfileRules,
  analysis: AiWorldAnalysis,
  memory: AiMemory,
  countNode: () => boolean,
  options: StrategicSearchOptions = {},
) {
  const measure = <T>(key: keyof StrategicSearchMetrics, operation: () => T) => {
    const startedAt = performance.now()
    try {
      return operation()
    } finally {
      if (options.metrics) options.metrics[key] += performance.now() - startedAt
    }
  }
  const branchesForTurn = (
    turnState: MatchState,
    branchOptions: StrategicSearchOptions,
  ) => {
    const branchReserve = branchOptions.orderReserve ?? strategicOrderReserve(memory.phase)
    const branchMode = branchOptions.mode ?? 'full'
    const rootScore = measure('evaluationMs', () => projectedStrategicScore(turnState, profile, memory.phase))
    const root: SearchNode = { state: turnState, candidates: [], bonus: 0, utility: rootScore }
    let beam: SearchNode[] = [root]
    const explored: SearchNode[] = [root]
    for (let depth = 0; depth < aiPlannerConfig.strategicSearchDepth; depth += 1) {
      const expanded: SearchNode[] = []
      for (const node of beam) {
        const candidates = measure('candidatesMs', () => strategicCandidates(
          node.state,
          profile,
          analysis,
          memory,
          memory.phase,
          countNode,
          depth === 0 && node === beam[0] ? branchOptions.diagnostics : undefined,
          options.metrics,
        ).filter((candidate) => commandAllowed(node.state, candidate.command, branchMode)))
        for (const candidate of candidates) {
          if (!countNode()) break
          if (commandsConflict(node.candidates, candidate)) continue
          const result = measure('simulationMs', () => executeAiCommand(node.state, candidate.command))
          if (!result.ok) continue
          const spentOrders = node.state.ordersRemaining - result.state.ordersRemaining
          if (spentOrders > 0 && result.state.ordersRemaining < branchReserve) continue
          const bonus = node.bonus + candidatePrior(candidate)
          expanded.push({
            state: result.state,
            candidates: [...node.candidates, candidate],
            bonus,
            utility: measure('evaluationMs', () => projectedStrategicScore(result.state, profile, memory.phase)) + bonus,
          })
        }
      }
      if (expanded.length === 0) break
      expanded.sort((first, second) => second.utility - first.utility
        || branchCommandKey(first).localeCompare(branchCommandKey(second)))
      explored.push(...expanded)
      beam = expanded.slice(0, aiPlannerConfig.strategicBeamWidth)
    }
    const ordered = explored.slice(1).sort((first, second) => second.utility - first.utility
      || branchCommandKey(first).localeCompare(branchCommandKey(second)))
    // Preserve the best branch from each broad strategic intent before filling
    // remaining beam slots by value. This keeps enabling actions in lookahead.
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
      utility: measure('evaluationMs', () => projectedStrategicScore(futureState, profile, memory.phase)),
    }
    const candidates = measure('candidatesMs', () => strategicCandidates(
      futureState,
      profile,
      analysis,
      memory,
      memory.phase,
      countNode,
      undefined,
      options.metrics,
    ).filter((candidate) => commandAllowed(futureState, candidate.command, mode))
      .slice(0, aiPlannerConfig.strategicFutureCandidateWidth))
    const branches = candidates.flatMap((candidate): SearchNode[] => {
      if (!countNode()) return []
      const result = measure('simulationMs', () => executeAiCommand(futureState, candidate.command))
      if (!result.ok) return []
      const spentOrders = futureState.ordersRemaining - result.state.ordersRemaining
      if (spentOrders > 0 && result.state.ordersRemaining < reserve) return []
      const prior = candidatePrior(candidate)
      return [{
        state: result.state,
        candidates: [candidate],
        bonus: prior,
        utility: measure('evaluationMs', () => projectedStrategicScore(result.state, profile, memory.phase)) + prior,
      }]
    }).sort((first, second) => second.utility - first.utility
      || branchCommandKey(first).localeCompare(branchCommandKey(second)))
    return [root, ...branches]
  }
  const forecast = (forecastState: MatchState, turnsRemaining: number): number => {
    if (turnsRemaining <= 0 || !countNode()) {
      return projectedStrategicScore(forecastState, profile, memory.phase)
    }
    const advanced = measure('economyProjectionMs', () => projectOwnerEconomy(
      forecastState,
      forecastState.activeParticipantId,
      1,
    ).state)
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
    || branchCommandKey(first.branch).localeCompare(branchCommandKey(second.branch)))
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
