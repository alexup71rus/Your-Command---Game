import type { TroopKind } from '../game/map'

export function TroopIcon({ kind, className = '' }: { kind: TroopKind; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      {kind === 'militia' && <>
        <path d="M14 13.5 24 9l10 4.5v10.2c0 7.2-4.1 12.1-10 15.3-5.9-3.2-10-8.1-10-15.3Z" />
        <circle cx="24" cy="23" r="6.2" />
        <path d="M24 16.8v12.4" />
      </>}
      {kind === 'spearmen' && <>
        <path d="m12 36 21-21" />
        <path className="troop-icon-fill" d="m31 11 7-2-2 7-5 1Z" />
        <path d="m14.5 30.5 3 3M11 37l4-1 1-4" />
      </>}
      {kind === 'archers' && <>
        <path d="M17 9c12 7 12 23 0 30M17 9c5 8 5 22 0 30" />
        <path d="M12 24h25M31 20l6 4-6 4" />
      </>}
      {kind === 'knights' && <>
        <path d="M14 23c0-8 4.2-13 10-13s10 5 10 13v12H14Z" />
        <path d="M14 24h20M24 10v25M18 29h12" />
        <path className="troop-icon-fill" d="m24 8 3 5h-6Z" />
      </>}
    </svg>
  )
}
