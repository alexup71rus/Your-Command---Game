export type GamePhase = 'menu' | 'founding' | 'playing'
export type Overlay = 'settings' | 'generator' | null

export function overlayAfterEscape(_phase: GamePhase, overlay: Overlay): Overlay {
  if (overlay === 'generator') return null
  if (overlay === 'settings') return null
  return 'settings'
}
