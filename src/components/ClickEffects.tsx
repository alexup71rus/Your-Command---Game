import type { CSSProperties } from 'react'

export type ClickBurstKind = 'map' | 'interface' | 'context' | 'danger'

export interface ClickBurst {
  id: number
  x: number
  y: number
  kind: ClickBurstKind
}

interface ClickEffectsProps {
  bursts: ClickBurst[]
}

const particleAngles = [-104, -72, -38, -8, 25, 58, 92, 132, 174, 216]

export function ClickEffects({ bursts }: ClickEffectsProps) {
  return (
    <div className="click-effects" aria-hidden="true">
      {bursts.map((burst) => (
        <span
          key={burst.id}
          className={`click-burst ${burst.kind}`}
          style={{ left: burst.x, top: burst.y }}
        >
          <span className="click-sigil" />
          <span className="click-core" />
          {particleAngles.map((angle, index) => (
            <span
              key={angle}
              className={`click-spark spark-${index % 3}`}
              style={{
                '--angle': `${angle}deg`,
                '--distance': `${24 + (index % 4) * 8}px`,
                '--delay': `${index * 7}ms`,
              } as CSSProperties}
            />
          ))}
        </span>
      ))}
    </div>
  )
}
