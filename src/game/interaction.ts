import type { BuildingKind, TroopComposition, TroopKind } from './map'
import type { CellPosition } from './scenario'

export type PendingGameAction =
  | { kind: 'build'; building: BuildingKind }
  | { kind: 'recruit'; troop: TroopKind; quantity: number }
  | { kind: 'split'; source: CellPosition; units: TroopComposition }
