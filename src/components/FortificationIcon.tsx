import type { BuildingKind } from '../game/map'

export function FortificationIcon({ kind, className = '' }: { kind: BuildingKind; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      {kind === 'wall' && <>
        <path d="M8 19h32v20H8Z" />
        <path d="M8 19v-7h7v7M20.5 19v-7h7v7M33 19v-7h7v7" />
        <path d="M8 28h32M18 19v9M30 19v9M14 28v11M25 28v11M36 28v11" />
      </>}
      {kind === 'tower' && <>
        <path d="M13 17h22v22H13Z" />
        <path d="M11 17v-7h7v7M20.5 17v-7h7v7M30 17v-7h7v7" />
        <path d="M20 39V29a4 4 0 0 1 8 0v10M19 22h3M26 22h3" />
      </>}
      {kind === 'barbican' && <>
        <path d="M7 18h12v21H7ZM29 18h12v21H29Z" />
        <path d="M5 18v-7h6v7M15 18v-7h6v7M27 18v-7h6v7M37 18v-7h6v7" />
        <path d="M19 23h10v16H19Z" />
        <path d="M21 39V30a3 3 0 0 1 6 0v9M11 24h4M33 24h4" />
      </>}
    </svg>
  )
}
