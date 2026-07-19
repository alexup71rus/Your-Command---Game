import type { CSSProperties } from 'react'

export type ClickBurstKind = 'map' | 'interface' | 'context' | 'danger' | 'combat'
export type ClickBurstVariant = 0 | 1 | 2 | 3 | 4

export interface ClickBurst {
  id: number
  x: number
  y: number
  kind: ClickBurstKind
  variant: ClickBurstVariant
  rotation: number
  scale: number
  spread: number
}

interface ClickEffectsProps {
  bursts: ClickBurst[]
}

const burstVariants = [
  {
    angles: [-104, -72, -38, -8, 25, 58, 92, 132, 174, 216],
    distances: [36, 49, 32, 54],
    startRotation: 20,
    endRotation: 72,
  },
  {
    angles: [-122, -88, -51, -14, 23, 62, 101, 143, 181, 218],
    distances: [49, 35, 55, 40],
    startRotation: 118,
    endRotation: 34,
  },
  {
    angles: [-90, -60, -30, 0, 30, 60, 90, 120, 150, 180, 210, 240],
    distances: [34, 54, 39, 50],
    startRotation: -18,
    endRotation: 128,
  },
  {
    angles: [-112, -76, -43, -9, 24, 61, 96, 134, 169, 207],
    distances: [52, 37, 57, 42],
    startRotation: 48,
    endRotation: 168,
  },
  {
    angles: [-101, -84, -48, -31, 4, 22, 59, 77, 112, 131, 166, 184],
    distances: [38, 55, 44, 58],
    startRotation: -86,
    endRotation: 22,
  },
] as const

export function ClickEffects({ bursts }: ClickEffectsProps) {
  return (
    <div className="click-effects" aria-hidden="true">
      {bursts.map((burst) => {
        const variant = burstVariants[burst.variant]
        return (
          <span
            key={burst.id}
            className={`click-burst ${burst.kind} variant-${burst.variant}`}
            style={{
              left: burst.x,
              top: burst.y,
              '--sigil-start': `${variant.startRotation + burst.rotation}deg`,
              '--sigil-end': `${variant.endRotation + burst.rotation}deg`,
              '--sigil-scale': burst.scale,
            } as CSSProperties}
          >
            <span className="click-sigil" />
            <span className="click-core" />
            {variant.angles.map((angle, index) => (
              <span
                key={`${angle}-${index}`}
                className={`click-spark spark-${index % 3}`}
                style={{
                  '--angle': `${angle + burst.rotation + ((burst.id * 13 + index * 7) % 9 - 4)}deg`,
                  '--distance': `${variant.distances[index % variant.distances.length] * burst.spread}px`,
                  '--delay': `${index * (burst.variant === 1 ? 11 : 7)}ms`,
                } as CSSProperties}
              />
            ))}
          </span>
        )
      })}
    </div>
  )
}
