import { useEffect, useRef, useState } from 'react'
import { aiPlannerConfig } from '../config/ai'
import { gameConfig } from '../config/game'
import type { LocaleDictionary } from '../config/localization'
import { aiCommandTargetPosition, executeAiCommand, rememberAiCommandFailure } from '../game/ai/commands'
import { createAiMemory } from '../game/ai/model'
import { calculateAiPlan, resetAiPlanner } from '../game/ai/workerClient'
import { endTurn, objectAt, type MatchState } from '../game/match'
import { areOwnersHostile, isSpectatorScenario, type CellPosition } from '../game/scenario'
import { calculateVisibility, isCellVisible } from '../game/visibility'
import type { SoundEffect } from './useSoundEffects'

interface AiTurnOptions {
  match: MatchState | null
  autoCameraEnabled: boolean
  text?: LocaleDictionary | null
  onMatchChange: (match: MatchState) => void
  onUnitMove: (from: CellPosition, to: CellPosition) => void
  onCameraFocus: (position: CellPosition) => void
  onCombat: (position: CellPosition | null) => void
  onPlayerTurn: (message: string) => void
  playSound: (effect: SoundEffect) => void
}

const pause = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

export function useAiTurn({
  match,
  autoCameraEnabled,
  text,
  onMatchChange,
  onUnitMove,
  onCameraFocus,
  onCombat,
  onPlayerTurn,
  playSound,
}: AiTurnOptions) {
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const matchRef = useRef<MatchState | null>(null)

  useEffect(() => {
    matchRef.current = match
  }, [match])

  useEffect(() => {
    const initial = matchRef.current
    if (!initial || initial.status !== 'playing') {
      setBusy(false)
      setSlow(false)
      return
    }
    const spectator = isSpectatorScenario(initial.scenario)
    const participant = initial.scenario.participants.find((candidate) => candidate.id === initial.activeParticipantId)
    if (!spectator && initial.activeParticipantId === initial.playerId) {
      setBusy(false)
      setSlow(false)
      return
    }
    if (participant?.kind !== 'ai' || !participant.profileId) {
      const completed = endTurn(initial)
      if (completed.ok) onMatchChange(completed.state)
      setBusy(false)
      return
    }
    const profileId = participant.profileId

    const controller = new AbortController()
    let cancelled = false
    const run = async () => {
      setBusy(true)
      setSlow(false)
      let working = initial
      for (let attempt = 0; attempt < aiPlannerConfig.maximumPlanAttempts && working.status === 'playing'; attempt += 1) {
        const memory = working.aiMemory[participant.id] ?? createAiMemory()
        let commandFailed = false
        let plan
        const slowTimer = window.setTimeout(() => setSlow(true), aiPlannerConfig.softBudgetMs)
        try {
          plan = await calculateAiPlan(working, memory, profileId, controller.signal)
        } catch (error) {
          window.clearTimeout(slowTimer)
          if (error instanceof DOMException && error.name === 'AbortError') return
          resetAiPlanner()
          if (attempt === 0) continue
          break
        }
        window.clearTimeout(slowTimer)
        setSlow(false)

        for (const command of plan.commands) {
          if (cancelled || working.status !== 'playing') return
          const before = working
          const result = executeAiCommand(working, command)
          if (!result.ok) {
            working = rememberAiCommandFailure(working, participant.id, command, result.reason)
            commandFailed = true
            break
          }
          working = result.state
          const targetPosition = aiCommandTargetPosition(command)
          const playerVisibilityBefore =
            !spectator && gameConfig.visibility.enabled ? calculateVisibility(before.scenario.cells, before.playerId, true) : null
          const playerVisibilityAfter =
            !spectator && gameConfig.visibility.enabled ? calculateVisibility(working.scenario.cells, working.playerId, true) : null
          const visibleAction = Boolean(
            targetPosition &&
            (spectator ||
              !gameConfig.visibility.enabled ||
              isCellVisible(playerVisibilityBefore, targetPosition) ||
              isCellVisible(playerVisibilityAfter, targetPosition)),
          )
          const targetBefore = targetPosition ? objectAt(before, targetPosition) : null
          const combatEvent = working.lastEvent?.kind === 'attacked' || working.lastEvent?.kind === 'destroyed'
          const threatensPlayer = Boolean(
            !spectator &&
            targetBefore?.ownerId === before.playerId &&
            areOwnersHostile(before.scenario.participants, before.activeParticipantId, before.playerId) &&
            combatEvent,
          )
          const enteredSight =
            !spectator &&
            gameConfig.visibility.enabled &&
            command.type === 'move-or-attack' &&
            !isCellVisible(playerVisibilityBefore, command.from) &&
            isCellVisible(playerVisibilityAfter, command.to)

          if (visibleAction) {
            onMatchChange(working)
            if (command.type === 'move-or-attack' && working.lastEvent?.kind === 'moved') onUnitMove(command.from, command.to)
            if (autoCameraEnabled && targetPosition && (enteredSight || threatensPlayer || (spectator && combatEvent))) {
              onCameraFocus(targetPosition)
            }
            if (combatEvent) {
              onCombat(targetPosition)
              playSound('attack')
            } else {
              playSound('action')
            }
            await pause(gameConfig.turn.autoMoveStepDelayMs)
          } else {
            await pause(gameConfig.ai.hiddenActionDelayMs)
          }
        }
        if (!commandFailed) {
          working = { ...working, aiMemory: { ...working.aiMemory, [participant.id]: plan.memory } }
          break
        }
      }
      if (cancelled) return
      if (working.status === 'playing') {
        const completed = endTurn(working)
        if (completed.ok) working = completed.state
      }
      onMatchChange(working)
      setBusy(false)
      setSlow(false)
      if (!spectator && working.activeParticipantId === working.playerId && text) onPlayerTurn(text.hud.yourTurn)
    }

    void run()
    return () => {
      cancelled = true
      controller.abort()
      setSlow(false)
    }
  }, [
    autoCameraEnabled,
    match?.activeParticipantId,
    match?.turn,
    onCameraFocus,
    onCombat,
    onMatchChange,
    onPlayerTurn,
    onUnitMove,
    playSound,
    text,
  ])

  return { busy, slow }
}
