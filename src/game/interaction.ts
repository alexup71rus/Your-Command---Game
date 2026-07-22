import { gameConfig } from '../config/game'
import { buildingRules, troopRules } from '../config/rules'
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

export function actionPreviewFor(action: PendingGameAction | null) {
  if (!action) return null
  if (action.kind === 'build') return { kind: 'building' as const, building: action.building }
  if (action.kind === 'recruit')
    return { kind: 'squad' as const, units: { militia: 0, spearmen: 0, archers: 0, knights: 0, [action.troop]: action.quantity } }
  if (action.kind === 'split') return { kind: 'squad' as const, units: action.units }
  if (action.kind === 'garrison-enter' || action.kind === 'garrison-exit' || action.kind === 'tower-attack')
    return { kind: 'target' as const }
  return null
}

export function orderCostFor(action: PendingGameAction | null) {
  if (!action) return 0
  if (action.kind === 'build') return buildingRules[action.building].actionCost
  if (action.kind === 'recruit') return troopRules[action.troop].actionCost
  if (action.kind === 'split' || action.kind === 'dismiss') return gameConfig.turn.squadReorganizationOrderCost
  if (action.kind === 'tower-attack') return buildingRules.tower.garrison?.attackOrderCost ?? 0
  return buildingRules.tower.garrison?.transferOrderCost ?? 0
}
