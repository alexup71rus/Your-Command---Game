import type { BuildingKind, TroopComposition, TroopKind } from './map'
import type { CellPosition } from './scenario'

export type PendingGameAction =
  | { kind: 'build'; building: BuildingKind }
  | { kind: 'recruit'; troop: TroopKind; quantity: number }
  | { kind: 'split'; source: CellPosition; units: TroopComposition }
  | { kind: 'dismiss'; source: CellPosition; units: TroopComposition }
  | { kind: 'garrison-enter'; tower: CellPosition }
  | { kind: 'garrison-exit'; tower: CellPosition }
  | { kind: 'tower-attack'; tower: CellPosition }
