import { useCallback, useRef, useState } from 'react'
import type { ClickBurst, ClickBurstKind, ClickBurstVariant } from '../components/ClickEffects'
import { gameConfig } from '../config/game'

const burstVariants: ClickBurstVariant[] = [0, 1, 2, 3, 4]

export function useClickBursts() {
  const [bursts, setBursts] = useState<ClickBurst[]>([])
  const nextId = useRef(0)
  const lastVariant = useRef<ClickBurstVariant | null>(null)

  const createBurst = useCallback((x: number, y: number, kind: ClickBurstKind) => {
    const id = ++nextId.current
    const effect = gameConfig.display.clickBurst
    const availableVariants = burstVariants.filter((variant) => variant !== lastVariant.current)
    const variant = availableVariants[Math.floor(Math.random() * availableVariants.length)]
    lastVariant.current = variant
    setBursts((current) => [
      ...current.slice(1 - effect.maximumVisible),
      {
        id,
        x,
        y,
        kind,
        variant,
        rotation: Math.random() * effect.rotationRange - effect.rotationRange / 2,
        scale: effect.minimumScale + Math.random() * effect.scaleRange,
        spread: effect.minimumSpread + Math.random() * effect.spreadRange,
      },
    ])
    window.setTimeout(() => setBursts((current) => current.filter((burst) => burst.id !== id)), effect.lifetimeMs)
  }, [])

  return { bursts, createBurst }
}
