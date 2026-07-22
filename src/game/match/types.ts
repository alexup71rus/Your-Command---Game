import type { TaxRate, TradeResource } from '../../config/rules'
import type { BuildingKind, ResourceId, TroopKind } from '../map'
import type { CellPosition, MapScenario } from '../scenario'
import type { AiMemory } from '../ai/model'

export interface DomainEconomy {
  resources: Record<ResourceId, number>
  population: number
  taxRate?: TaxRate
  diverseDiet: boolean
  marketActivity: MarketActivity
}

export interface MarketActivity {
  bought: Record<TradeResource, number>
  sold: Record<TradeResource, number>
}

export interface WorkerAssignment {
  kind: BuildingKind
  position: CellPosition
  required: number
  assigned: number
  blockedReason?: 'missing-support' | 'idle-support' | 'no-workers'
}

export interface WorkforceSummary {
  population: number
  employed: number
  free: number
  assignments: WorkerAssignment[]
}

export interface FoodDemand {
  civilians: number
  soldiers: number
  taxFood: number
  staple: number
  total: number
  servedCivilians: number
  unservedCivilians: number
}

export interface FoodConsumption {
  flour: number
  meat: number
  fruit: number
  fed: boolean
  diverseDiet: boolean
}

export interface TroopLoss {
  kind: TroopKind
  position: CellPosition
  source: 'squad' | 'garrison'
}

export interface TurnReport {
  ownerId: string
  resourcesBefore: Record<ResourceId, number>
  production: Record<ResourceId, number>
  taxIncome: number
  upkeep: Record<ResourceId, number>
  upkeepPaid: boolean
  processing: Record<ResourceId, number>
  food: FoodConsumption
  resourcesAfter: Record<ResourceId, number>
  populationBefore: number
  populationAfter: number
  populationReason: 'growth' | 'starvation' | 'capacity' | null
  desertion: TroopLoss | null
  starvation: 'civilian' | TroopLoss | null
}

export type MatchStatus = 'playing' | 'won' | 'lost'

export interface MatchEvent {
  kind:
    | 'built'
    | 'recruited'
    | 'moved'
    | 'merged'
    | 'split'
    | 'dismissed'
    | 'garrisoned'
    | 'ungarrisoned'
    | 'attacked'
    | 'destroyed'
    | 'demolished'
    | 'traded'
    | 'tax-changed'
    | 'turn-ended'
  position?: CellPosition
  amount?: number
}

export interface MatchState {
  scenario: MapScenario
  playerId: string
  activeParticipantId: string
  turn: number
  ordersRemaining: number
  domains: Record<string, DomainEconomy>
  status: MatchStatus
  lastEvent: MatchEvent | null
  lastTurnReports: Record<string, TurnReport>
  aiMemory: Record<string, AiMemory>
}

export type CommandFailure =
  | 'game-over'
  | 'not-owned'
  | 'occupied'
  | 'invalid-terrain'
  | 'outside-domain'
  | 'outside-food-service'
  | 'requires-support'
  | 'requires-farm-site'
  | 'building-limit'
  | 'not-adjacent'
  | 'not-enough-orders'
  | 'not-enough-resources'
  | 'not-enough-population'
  | 'requires-barracks'
  | 'squad-full'
  | 'army-full'
  | 'invalid-squad'
  | 'invalid-garrison'
  | 'requires-garrison'
  | 'requires-target'
  | 'cannot-demolish'
  | 'requires-market'
  | 'invalid-trade'
  | 'market-exhausted'
  | 'ranged-shot-blocked'
  | 'out-of-range'

export type CommandResult = { ok: true; state: MatchState } | { ok: false; state: MatchState; reason: CommandFailure }
