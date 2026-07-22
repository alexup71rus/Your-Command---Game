import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { ClickBurstKind } from '../components/ClickEffects'
import { gameConfig } from '../config/game'
import type { SoundEffect } from './useSoundEffects'

interface InterfaceFeedbackOptions {
  createBurst: (x: number, y: number, kind: ClickBurstKind) => void
  playSound: (effect: SoundEffect) => void
}

export function useInterfaceFeedback({ createBurst, playSound }: InterfaceFeedbackOptions) {
  const lastHoverSoundAt = useRef(0)

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      if (target.closest('.grid-canvas') || target.closest('button:disabled')) return
      let kind: ClickBurstKind = 'interface'
      let effect: SoundEffect = 'action'
      if (target.closest('.tab')) effect = 'tab'
      else if (target.closest('.context-menu button') && target.closest('.danger')) kind = 'danger'
      else if (target.closest('.context-backdrop') && !target.closest('.context-menu')) effect = 'dismiss'
      else if (!target.closest('button')) return
      createBurst(event.clientX, event.clientY, kind)
      playSound(effect)
    },
    [createBurst, playSound],
  )

  const handleMenuPointerOver = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const target = event.target as HTMLElement
      const interactive = target.closest<HTMLElement>(
        '.welcome-entry, .mode-option, .menu-back-button, .map-choice-main, .create-map-choice, .load-game-button, .start-match-button:not(:disabled), .generator-footer .primary:not(:disabled)',
      )
      if (!interactive) return
      const relatedTarget = event.relatedTarget
      if (relatedTarget instanceof Node && interactive.contains(relatedTarget)) return
      const now = performance.now()
      if (now - lastHoverSoundAt.current < gameConfig.audio.hoverSoundThrottleMs) return
      lastHoverSoundAt.current = now
      const primary = interactive.matches(
        '.welcome-entry, .mode-option.available, .start-match-button:not(:disabled), .generator-footer .primary:not(:disabled)',
      )
      playSound(primary ? 'primary-hover' : 'hover')
    },
    [playSound],
  )

  return { handlePointerDown, handleMenuPointerOver }
}
