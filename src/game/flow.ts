export type GamePhase = 'menu' | 'founding' | 'playing'
export type Overlay = 'settings' | 'generator' | null

export function overlayAfterEscape(phase: GamePhase, overlay: Overlay): Overlay {
  if (overlay === 'generator') return null
  if (overlay === 'settings') return null
  if (phase === 'menu') return null
  return 'settings'
}
