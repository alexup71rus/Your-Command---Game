import { useCallback } from 'react'
import type { ClickBurstKind } from '../components/ClickEffects'
import type { MapClickRequest } from '../components/GridCanvas'
import type { LocaleDictionary } from '../config/localization'
import type { GamePhase } from '../game/flow'
import type { PendingGameAction } from '../game/interaction'
import type { MapObject } from '../game/map'
import {
  build,
  garrisonTower,
  isRangedAttack,
  isSamePosition,
  moveOrAttack,
  objectAt,
  recruit,
  splitSquad,
  towerAttack,
  ungarrisonTower,
  type CommandResult,
  type MatchState,
} from '../game/match'
import { areOwnersHostile, type CellPosition, type MapScenario } from '../game/scenario'
import type { SoundEffect } from './useSoundEffects'

interface MapClickInteractionOptions {
  phase: GamePhase
  match: MatchState | null
  scenario: MapScenario | null
  selectedRegionId: string | null
  selectedCell: CellPosition | null
  pendingAction: PendingGameAction | null
  opponentTurn: boolean
  spectatorMatch: boolean
  text: LocaleDictionary | null
  visibleObjectAt: (position: CellPosition) => MapObject | undefined
  applyCommand: (result: CommandResult, nextSelection?: CellPosition | null, sound?: SoundEffect) => boolean
  cancelAutoMove: () => void
  createBurst: (x: number, y: number, kind: ClickBurstKind) => void
  playSound: (effect: SoundEffect) => void
  selectRegion: (regionId: string | null) => void
  onSelectCell: (position: CellPosition | null) => void
  onSelectSpectator: (participantId: string | null) => void
  onCastleDraft: (position: CellPosition) => void
  onFeedback: (message: string | null) => void
  onClearPendingAction: () => void
  onAnimateUnit: (from: CellPosition, to: CellPosition) => void
  onClearUnitAnimation: () => void
}

export function useMapClickInteraction({
  phase,
  match,
  scenario,
  selectedRegionId,
  selectedCell,
  pendingAction,
  opponentTurn,
  spectatorMatch,
  text,
  visibleObjectAt,
  applyCommand,
  cancelAutoMove,
  createBurst,
  playSound,
  selectRegion,
  onSelectCell,
  onSelectSpectator,
  onCastleDraft,
  onFeedback,
  onClearPendingAction,
  onAnimateUnit,
  onClearUnitAnimation,
}: MapClickInteractionOptions) {
  return useCallback(
    (request: MapClickRequest) => {
      const position = { column: request.column, row: request.row }
      if (phase === 'playing' && match && spectatorMatch) {
        cancelAutoMove()
        const object = objectAt(match, position)
        createBurst(request.clientX, request.clientY, 'map')
        playSound('map')
        onSelectCell(object ? position : null)
        onSelectSpectator(object?.ownerId ?? null)
        return
      }
      if (phase === 'playing' && opponentTurn) return
      cancelAutoMove()
      const selectedForGesture = phase === 'playing' && selectedCell ? visibleObjectAt(selectedCell) : null
      const targetForGesture = phase === 'playing' ? visibleObjectAt(position) : null
      const attackGesture = Boolean(
        selectedCell &&
        selectedForGesture?.type === 'squad' &&
        selectedForGesture.ownerId === match?.playerId &&
        targetForGesture &&
        match &&
        areOwnersHostile(match.scenario.participants, match.playerId, targetForGesture.ownerId) &&
        (Math.abs(selectedCell.column - position.column) + Math.abs(selectedCell.row - position.row) === 1 ||
          isRangedAttack(match, selectedCell, position)),
      )
      if (!attackGesture) {
        createBurst(request.clientX, request.clientY, 'map')
        playSound('map')
      }
      if (phase === 'playing' && match) {
        if (match.status !== 'playing') {
          onSelectCell(position)
          onClearPendingAction()
          onFeedback(null)
          return
        }
        if (pendingAction?.kind === 'build') {
          applyCommand(build(match, pendingAction.building, position), position)
          return
        }
        if (pendingAction?.kind === 'recruit') {
          applyCommand(recruit(match, pendingAction.troop, pendingAction.quantity, position), position)
          return
        }
        if (pendingAction?.kind === 'split') {
          applyCommand(splitSquad(match, pendingAction.source, position, pendingAction.units), position)
          return
        }
        if (pendingAction?.kind === 'dismiss') return
        if (pendingAction?.kind === 'garrison-enter') {
          applyCommand(garrisonTower(match, position, pendingAction.tower), pendingAction.tower)
          return
        }
        if (pendingAction?.kind === 'garrison-exit') {
          applyCommand(ungarrisonTower(match, pendingAction.tower, position), position)
          return
        }
        if (pendingAction?.kind === 'tower-attack') {
          if (!visibleObjectAt(position)) {
            onFeedback(text?.game.failures['requires-target'] ?? null)
            playSound('dismiss')
            return
          }
          const result = towerAttack(match, pendingAction.tower, position)
          if (result.ok) createBurst(request.clientX, request.clientY, 'combat')
          applyCommand(result, pendingAction.tower, result.ok ? 'attack' : 'dismiss')
          return
        }
        const selectedObject = selectedCell ? visibleObjectAt(selectedCell) : null
        if (selectedCell && selectedObject?.type === 'squad' && selectedObject.ownerId === match.playerId) {
          if (isSamePosition(selectedCell, position)) {
            onSelectCell(null)
            onFeedback(null)
            return
          }
          const target = objectAt(match, position)
          const visibleTarget = visibleObjectAt(position)
          const targetDistance = Math.abs(selectedCell.column - position.column) + Math.abs(selectedCell.row - position.row)
          if (target && target.ownerId !== match.playerId && !visibleTarget && targetDistance > 1) {
            onSelectCell(null)
            onFeedback(null)
            return
          }
          if (target?.type === 'building' && target.kind === 'tower' && target.ownerId === match.playerId) {
            applyCommand(garrisonTower(match, selectedCell, position), position)
            return
          }
          const attacking = Boolean(target && areOwnersHostile(match.scenario.participants, match.playerId, target.ownerId))
          const result = moveOrAttack(match, selectedCell, position)
          if (result.ok || result.reason !== 'not-adjacent') {
            let nextSelection: CellPosition | null = selectedCell
            if (result.ok) {
              const sourceAfter = objectAt(result.state, selectedCell)
              const destinationAfter = objectAt(result.state, position)
              const sourceSurvived = sourceAfter?.type === 'squad' && sourceAfter.ownerId === match.playerId
              const attackedSquad = attacking && target?.type === 'squad'
              const movementEvent =
                result.state.lastEvent?.kind === 'moved' ||
                result.state.lastEvent?.kind === 'merged' ||
                (attacking && target?.type !== 'squad' && result.state.lastEvent?.kind === 'destroyed')
              const moved =
                movementEvent && !sourceAfter && destinationAfter?.type === 'squad' && destinationAfter.ownerId === match.playerId
              nextSelection = sourceSurvived ? selectedCell : moved ? position : null
              if (attackedSquad) onClearUnitAnimation()
              else if (moved) onAnimateUnit(selectedCell, position)
            }
            if (result.ok && attacking) createBurst(request.clientX, request.clientY, 'combat')
            applyCommand(result, nextSelection, attacking ? 'attack' : 'action')
            return
          }
          const clickedObject = visibleObjectAt(position)
          onSelectCell(clickedObject ? position : null)
          onFeedback(null)
          return
        }
        onSelectCell(objectAt(match, position) && !visibleObjectAt(position) ? null : position)
        onFeedback(null)
        return
      }
      if (phase !== 'founding' || !scenario) return
      const regionId = scenario.territories[request.row]?.[request.column] ?? null
      if (!selectedRegionId) {
        if (regionId) selectRegion(regionId)
        return
      }
      onCastleDraft(position)
    },
    [
      applyCommand,
      cancelAutoMove,
      createBurst,
      match,
      onAnimateUnit,
      onCastleDraft,
      onClearPendingAction,
      onClearUnitAnimation,
      onFeedback,
      onSelectCell,
      onSelectSpectator,
      opponentTurn,
      pendingAction,
      phase,
      playSound,
      scenario,
      selectRegion,
      selectedCell,
      selectedRegionId,
      spectatorMatch,
      text,
      visibleObjectAt,
    ],
  )
}
