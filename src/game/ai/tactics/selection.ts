import { aiPlannerConfig } from '../../../config/ai'
import type { CellPosition } from '../../scenario'
import { positionKey, samePosition } from '../analysis'
import type { AiCommand, AiStrategicPhase } from '../model'

export interface TacticalCandidate {
  command: AiCommand
  score: number
  factors: string[]
}

export interface TacticalSelectionOptions {
  phase: AiStrategicPhase
  idleTurns: number
  previousCommands: readonly AiCommand[]
  traversedEdges: ReadonlySet<string>
  commandAllowed?: (command: AiCommand) => boolean
}

export const tacticalMovementEdgeKey = (from: CellPosition, to: CellPosition) => (
  `${from.column}:${from.row}>${to.column}:${to.row}`
)

function priorMovementCountFor(position: CellPosition, commands: readonly AiCommand[]) {
  let cursor = position
  let count = 0
  const visited = new Set<string>()
  for (;;) {
    const cursorKey = positionKey(cursor)
    if (visited.has(cursorKey)) break
    visited.add(cursorKey)
    const previous = [...commands].reverse().find((command) => (
      command.type === 'move-or-attack' && samePosition(command.to, cursor)
    ))
    if (!previous || previous.type !== 'move-or-attack') break
    count += 1
    cursor = previous.from
  }
  return count
}

/** Keeps tactical execution and focused scenario tests on the same selection policy. */
export function selectTacticalCandidate(
  candidates: readonly TacticalCandidate[],
  options: TacticalSelectionOptions,
) {
  const eligible = candidates.filter((candidate) => {
    if (options.commandAllowed && !options.commandAllowed(candidate.command)) return false
    const repeatsCommand = options.previousCommands.some((command) => JSON.stringify(command) === JSON.stringify(candidate.command))
    // A repeated move is usually an oscillation, but a repeated attack is how a
    // formation actually completes a breach or finishes a surviving squad.
    if (repeatsCommand && !candidate.factors.some((factor) => factor.startsWith('damage:'))) return false
    if (candidate.command.type !== 'move-or-attack') return true
    const dealsDamage = candidate.factors.some((factor) => factor.startsWith('damage:'))
    const revisitsThisTurn = options.previousCommands.some((command) => command.type === 'move-or-attack'
      && (samePosition(command.from, candidate.command.type === 'move-or-attack' ? candidate.command.to : command.from)
        || samePosition(command.to, candidate.command.type === 'move-or-attack' ? candidate.command.to : command.to)))
    if (!dealsDamage && revisitsThisTurn) return false
    return !options.traversedEdges.has(tacticalMovementEdgeKey(candidate.command.to, candidate.command.from))
  })
  // Coordinate undamaging defensive movement so one squad does not consume
  // the entire turn while the rest of the response line remains idle.
  const defensiveResponseMoves = options.phase === 'defense'
    ? eligible.filter((candidate) => candidate.command.type === 'move-or-attack'
      && candidate.factors.includes('defense-response')
      && !candidate.factors.includes('committed-defense-contact')
      && !candidate.factors.includes('ranged-withdrawal')
      && !candidate.factors.includes('screen-ranged')
      && !candidate.factors.some((factor) => factor.startsWith('damage:')))
    : []
  const minimumResponseMoves = Math.min(...defensiveResponseMoves.map((candidate) => (
    candidate.command.type === 'move-or-attack'
      ? priorMovementCountFor(candidate.command.from, options.previousCommands)
      : Number.POSITIVE_INFINITY
  )), Number.POSITIVE_INFINITY)
  const coordinated = Number.isFinite(minimumResponseMoves)
    ? eligible.filter((candidate) => candidate.command.type !== 'move-or-attack'
      || candidate.factors.some((factor) => factor.startsWith('damage:'))
      || candidate.factors.includes('committed-defense-contact')
      || candidate.factors.includes('consolidate-force')
      || candidate.factors.includes('ranged-withdrawal')
      || candidate.factors.includes('screen-ranged')
      || (candidate.factors.includes('defense-response')
        && priorMovementCountFor(candidate.command.from, options.previousCommands) === minimumResponseMoves))
    : eligible
  return coordinated.find((candidate) => candidate.score > 0)
    ?? (options.phase === 'assault' && options.idleTurns >= aiPlannerConfig.forcedAdvanceAfterIdleTurns
      ? coordinated.find((candidate) => (
          candidate.command.type === 'move-or-attack'
          && candidate.score > aiPlannerConfig.forcedAdvanceMinimumScore
        ))
      : undefined)
}
