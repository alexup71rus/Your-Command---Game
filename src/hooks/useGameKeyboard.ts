import { useEffect } from 'react'
import { escapeTarget, overlayAfterEscape, type GamePhase, type Overlay } from '../game/flow'

interface GameKeyboardOptions {
  phase: GamePhase
  atWelcomeScreen: boolean
  overlay: Overlay
  contextMenuOpen: boolean
  outcomeOpen: boolean
  pendingActionOpen: boolean
  onTerritoriesHeldChange: (held: boolean) => void
  onCancelAutoMove: () => void
  onCloseContextMenu: () => void
  onCloseSavedGames: () => void
  onOverlayChange: (overlay: Overlay) => void
  onDismissOutcome: () => void
  onClearPendingAction: () => void
}

export function useGameKeyboard({
  phase,
  atWelcomeScreen,
  overlay,
  contextMenuOpen,
  outcomeOpen,
  pendingActionOpen,
  onTerritoriesHeldChange,
  onCancelAutoMove,
  onCloseContextMenu,
  onCloseSavedGames,
  onOverlayChange,
  onDismissOutcome,
  onClearPendingAction,
}: GameKeyboardOptions) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift' && phase !== 'menu' && overlay === null) onTerritoriesHeldChange(true)
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (event.repeat) return
      onTerritoriesHeldChange(false)
      onCancelAutoMove()
      if (atWelcomeScreen && overlay === null) return
      const target = escapeTarget({ contextMenuOpen, overlay, outcomeOpen, pendingAction: pendingActionOpen })
      if (target === 'context-menu') onCloseContextMenu()
      else if (target === 'overlay') {
        if (overlay === 'saved-games') onCloseSavedGames()
        else onOverlayChange(overlayAfterEscape(phase, overlay))
      } else if (target === 'outcome') onDismissOutcome()
      else if (target === 'pending-action') onClearPendingAction()
      else onOverlayChange(overlayAfterEscape(phase, overlay))
    }
    const releaseShift = (event: KeyboardEvent) => {
      if (event.key === 'Shift') onTerritoriesHeldChange(false)
    }
    const releaseShiftOnBlur = () => onTerritoriesHeldChange(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', releaseShift)
    window.addEventListener('blur', releaseShiftOnBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', releaseShift)
      window.removeEventListener('blur', releaseShiftOnBlur)
    }
  }, [
    atWelcomeScreen,
    contextMenuOpen,
    onCancelAutoMove,
    onClearPendingAction,
    onCloseContextMenu,
    onCloseSavedGames,
    onDismissOutcome,
    onOverlayChange,
    onTerritoriesHeldChange,
    outcomeOpen,
    overlay,
    pendingActionOpen,
    phase,
  ])
}
