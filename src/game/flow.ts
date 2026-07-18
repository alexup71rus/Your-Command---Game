export type GamePhase = 'menu' | 'founding' | 'playing'
export type Overlay = 'settings' | 'generator' | 'saved-games' | null

export function overlayAfterEscape(_phase: GamePhase, overlay: Overlay): Overlay {
  if (overlay === 'generator') return null
  if (overlay === 'settings' || overlay === 'saved-games') return null
  return 'settings'
}
