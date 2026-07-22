import { useEffect } from 'react'
import { gameConfig } from '../config/game'
import type { LocaleDictionary } from '../config/localization'
import type { GamePhase, Overlay } from '../game/flow'
import type { PendingGameAction } from '../game/interaction'
import { isSamePosition, moveOrAttack, objectAt, type MatchState } from '../game/match'
import { squadMovementOrderCostBetween } from '../game/movement'
import { findMovementPath } from '../game/pathfinding'
import { areOwnersHostile, type CellPosition } from '../game/scenario'
import type { VisibilityMap } from '../game/visibility'
import { visibleObjectAt } from '../game/visibility'
import type { SoundEffect } from './useSoundEffects'

interface AutoMovementOptions {
  target: CellPosition | null
  phase: GamePhase
  opponentTurn: boolean
  overlay: Overlay
  pendingAction: PendingGameAction | null
  match: MatchState | null
  selectedCell: CellPosition | null
  visibility: VisibilityMap | null
  text: LocaleDictionary | null
  onCancel: () => void
  onPathChange: (path: CellPosition[]) => void
  onMatchChange: (match: MatchState) => void
  onSelectionChange: (position: CellPosition | null) => void
  onFeedback: (message: string | null) => void
  onUnitMove: (from: CellPosition, to: CellPosition) => void
  onClearUnitAnimation: () => void
  onCombat: () => void
  playSound: (effect: SoundEffect) => void
}

export function useAutoMovement({
  target,
  phase,
  opponentTurn,
  overlay,
  pendingAction,
  match,
  selectedCell,
  visibility,
  text,
  onCancel,
  onPathChange,
  onMatchChange,
  onSelectionChange,
  onFeedback,
  onUnitMove,
  onClearUnitAnimation,
  onCombat,
  playSound,
}: AutoMovementOptions) {
  useEffect(() => {
    if (!target) return
    const timeout = window.setTimeout(() => {
      if (phase !== 'playing' || opponentTurn || overlay !== null || pendingAction || !match || !selectedCell) {
        onCancel()
        return
      }
      const squad = objectAt(match, selectedCell)
      if (squad?.type !== 'squad' || squad.ownerId !== match.playerId || isSamePosition(selectedCell, target)) {
        onCancel()
        return
      }
      const path = findMovementPath(match.scenario.cells, selectedCell, target, {
        ownerId: match.playerId,
        canEnterOccupiedCell: (position) =>
          Boolean(objectAt(match, position) && !visibleObjectAt(match.scenario.cells, visibility, match.playerId, position)),
      })
      if (!path || path.length < 2) {
        onFeedback(text?.game.routeUnavailable ?? null)
        onCancel()
        return
      }
      onPathChange(path)
      const next = path[1]
      const destination = match.scenario.cells[next.row]?.[next.column]
      const stepOrderCost = destination?.object
        ? gameConfig.turn.movementOrderCost
        : (squadMovementOrderCostBetween(match.scenario.cells, squad, selectedCell, next) ?? Number.POSITIVE_INFINITY)
      if (!destination || match.ordersRemaining < stepOrderCost) {
        onFeedback(text?.game.routeOrdersFinished ?? null)
        onCancel()
        return
      }
      const result = moveOrAttack(match, selectedCell, next)
      if (!result.ok) {
        onFeedback(
          result.reason === 'not-enough-orders' ? (text?.game.routeOrdersFinished ?? null) : (text?.game.failures[result.reason] ?? null),
        )
        onCancel()
        playSound('dismiss')
        return
      }
      const sourceAfter = objectAt(result.state, selectedCell)
      const destinationAfter = objectAt(result.state, next)
      const attackedSquad =
        destination.object?.type === 'squad' && areOwnersHostile(match.scenario.participants, match.playerId, destination.object.ownerId)
      const movementEvent =
        result.state.lastEvent?.kind === 'moved' ||
        result.state.lastEvent?.kind === 'merged' ||
        (!attackedSquad && result.state.lastEvent?.kind === 'destroyed')
      const moved = movementEvent && !sourceAfter && destinationAfter?.type === 'squad' && destinationAfter.ownerId === match.playerId
      if (attackedSquad) onClearUnitAnimation()
      else if (moved) onUnitMove(selectedCell, next)
      onMatchChange(result.state)
      onSelectionChange(sourceAfter?.type === 'squad' && sourceAfter.ownerId === match.playerId ? selectedCell : moved ? next : null)
      onFeedback(null)
      const combatEvent = result.state.lastEvent?.kind === 'attacked' || result.state.lastEvent?.kind === 'destroyed'
      if (combatEvent) {
        onCombat()
        onCancel()
      }
      playSound(combatEvent ? 'attack' : 'action')
    }, gameConfig.turn.autoMoveStepDelayMs)
    return () => window.clearTimeout(timeout)
  }, [
    match,
    onCancel,
    onClearUnitAnimation,
    onCombat,
    onFeedback,
    onMatchChange,
    onPathChange,
    onSelectionChange,
    onUnitMove,
    opponentTurn,
    overlay,
    pendingAction,
    phase,
    playSound,
    selectedCell,
    target,
    text,
    visibility,
  ])
}
