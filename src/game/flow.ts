export type GamePhase = 'menu' | 'founding' | 'playing'
export type Overlay = 'settings' | 'generator' | 'saved-games' | 'opponents' | null
export type EscapeTarget = 'context-menu' | 'overlay' | 'outcome' | 'pending-action' | 'settings'

export function overlayAfterEscape(_phase: GamePhase, overlay: Overlay): Overlay {
  if (overlay === 'generator') return null
  if (overlay === 'settings' || overlay === 'saved-games') return null
  return 'settings'
}

export function escapeTarget({ contextMenuOpen, overlay, outcomeOpen, pendingAction }: {
  contextMenuOpen: boolean
  overlay: Overlay
  outcomeOpen: boolean
  pendingAction: boolean
}): EscapeTarget {
  if (contextMenuOpen) return 'context-menu'
  if (overlay) return 'overlay'
  if (outcomeOpen) return 'outcome'
  if (pendingAction) return 'pending-action'
  return 'settings'
}

export function savedGameLoadNeedsConfirmation(phase: GamePhase, hasMatch: boolean) {
  return phase === 'playing' && hasMatch
}
