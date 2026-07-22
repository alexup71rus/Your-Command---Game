import {
  build,
  demolish,
  dismissSquad,
  garrisonTower,
  moveOrAttack,
  recruit,
  setTaxRate,
  splitSquad,
  towerAttack,
  trade,
  ungarrisonTower,
  type CommandResult,
  type CommandFailure,
  type MatchState,
} from '../match'
import { aiPlannerConfig } from '../../config/ai'
import type { CellPosition } from '../scenario'
import type { AiCommand } from './model'

export function executeAiCommand(state: MatchState, command: AiCommand): CommandResult {
  switch (command.type) {
    case 'build': return build(state, command.building, command.position)
    case 'recruit': return recruit(state, command.troop, command.quantity, command.position)
    case 'move-or-attack': return moveOrAttack(state, command.from, command.to)
    case 'split': return splitSquad(state, command.from, command.to, command.units)
    case 'dismiss': return dismissSquad(state, command.from, command.units)
    case 'garrison': return garrisonTower(state, command.from, command.tower, command.quantity)
    case 'ungarrison': return ungarrisonTower(state, command.tower, command.to)
    case 'tower-attack': return towerAttack(state, command.tower, command.to)
    case 'demolish': return demolish(state, command.position)
    case 'tax': return setTaxRate(state, command.rate)
    case 'trade': return trade(state, command.market, command.resource, command.direction, command.quantity)
  }
}

export function aiCommandTargetPosition(command: AiCommand): CellPosition | null {
  switch (command.type) {
    case 'build':
    case 'demolish':
    case 'recruit':
      return command.position
    case 'move-or-attack':
    case 'split':
    case 'ungarrison':
    case 'tower-attack':
      return command.to
    case 'garrison':
      return command.tower
    case 'dismiss':
      return command.from
    case 'tax':
    case 'trade':
      return null
  }
}

/**
 * Records an authoritative rejection without committing the speculative plan
 * memory. Occupied cells are short-lived facts: the blocker may have been hidden
 * by fog and can move before the participant's next turn.
 */
export function rememberAiCommandFailure(
  state: MatchState,
  participantId: string,
  command: AiCommand,
  reason: CommandFailure,
) {
  const currentMemory = state.aiMemory[participantId]
  if (!currentMemory) return state
  const blockedPosition = reason === 'occupied' ? aiCommandTargetPosition(command) : null
  const blockedCells = blockedPosition
    ? [
        ...currentMemory.blockedCells.filter((entry) => (
          entry.position.column !== blockedPosition.column || entry.position.row !== blockedPosition.row
        )),
        { position: blockedPosition, expiresTurn: state.turn + aiPlannerConfig.blockedCellMemoryTurns },
      ].slice(-aiPlannerConfig.maximumBlockedCells)
    : currentMemory.blockedCells
  return {
    ...state,
    aiMemory: {
      ...state.aiMemory,
      [participantId]: { ...currentMemory, blockedCells, lastCancellationReason: reason },
    },
  }
}
