import type { BuildingKind, ResourceId, TroopComposition, TroopKind } from '../map'
import type { AiProfileId, CellPosition } from '../scenario'
import type { TaxRate, TradeResource } from '../../config/rules'

export const aiProfileIds: AiProfileId[] = ['radomir', 'velislava', 'svyatobor']

export type AiArsenalTier = 'basic' | 'tactical' | 'complete'
export type AiLayoutKind = 'courtyard' | 'frontier' | 'strongpoint'
export type AiFortificationKind = 'curtain' | 'terrain-gate' | 'bastion'
export type AiOpeningKind = 'forest' | 'plains' | 'highland'
export type AiStrategicPhase = 'recovery' | 'survival' | 'expansion' | 'mobilization' | 'assault' | 'regroup' | 'defense'
export type AiWaveKind = 'none' | 'probe' | 'main' | 'support' | 'regroup' | 'siege'
export type AiSquadRole = 'defender' | 'assault' | 'screen' | 'ranged' | 'scout' | 'reserve'
export type AiContactKind = 'squad' | 'barracks'
export type AiSettlementZoneKind = 'housing' | 'food' | 'industry' | 'military' | 'defense'
export type AiReservedSiteKind = 'housing' | 'food' | 'military' | 'industry' | 'gate' | 'leftTower' | 'rightTower' | 'outpostTower'

export const aiLayoutKinds: readonly AiLayoutKind[] = ['courtyard', 'frontier', 'strongpoint']
export const aiFortificationKinds: readonly AiFortificationKind[] = ['curtain', 'terrain-gate', 'bastion']
export const aiOpeningKinds: readonly AiOpeningKind[] = ['forest', 'plains', 'highland']
export const aiStrategicPhases: readonly AiStrategicPhase[] = ['recovery', 'survival', 'expansion', 'mobilization', 'assault', 'regroup', 'defense']
export const aiWaveKinds: readonly AiWaveKind[] = ['none', 'probe', 'main', 'support', 'regroup', 'siege']
export const aiSquadRoleKinds: readonly AiSquadRole[] = ['defender', 'assault', 'screen', 'ranged', 'scout', 'reserve']
export const aiSettlementZoneKinds: readonly AiSettlementZoneKind[] = ['housing', 'food', 'industry', 'military', 'defense']
export const aiReservedSiteKinds: readonly AiReservedSiteKind[] = ['housing', 'food', 'military', 'industry', 'gate', 'leftTower', 'rightTower', 'outpostTower']

export interface AiContact {
  ownerId: string
  kind: AiContactKind
  position: CellPosition
  lastSeenTurn: number
  units?: TroopComposition
  health?: number
}

export interface AiBlockedCell {
  position: CellPosition
  expiresTurn: number
}

export interface AiSettlementPlan {
  layout: AiLayoutKind
  opening: AiOpeningKind
  front: CellPosition
  reservedCorridors: CellPosition[]
  reservedSites: Partial<Record<AiReservedSiteKind, CellPosition>>
  fortification: {
    lines: Array<{
      kind: AiFortificationKind
      approach: CellPosition
      gate: CellPosition
      walls: CellPosition[]
      towers: CellPosition[]
    }>
  } | null
  zones: Record<AiSettlementZoneKind, {
    centers: CellPosition[]
    cells: CellPosition[]
    maxOrigins: number
    maxBuildings: Partial<Record<BuildingKind, number>>
    overflowRadius: number
  }>
}

export interface AiMemory {
  contacts: AiContact[]
  blockedCells: AiBlockedCell[]
  targetOwnerId: string | null
  phase: AiStrategicPhase
  settlementPlan: AiSettlementPlan | null
  squadRoles: Record<string, AiSquadRole>
  wave: AiWaveKind
  lastTargetChangeTurn: number
  lastTaxChangeTurn: number
  lastArmyReorganizationTurn: number
  lastOffensiveEndTurn: number
  // Turn of the most recent "main" assault wave. Used by `waveFor` to space
  // successive main waves by `aiPlannerConfig.mainWaveCooldownTurns` so the AI
  // pauses to reassemble between strikes instead of streaming troops every turn.
  lastMainWaveTurn: number
  stableTurns: number
  idleTurns: number
  stalledTurns: number
  lastCancellationReason: string | null
}

export function createAiMemory(): AiMemory {
  return {
    contacts: [],
    blockedCells: [],
    targetOwnerId: null,
    phase: 'survival',
    settlementPlan: null,
    squadRoles: {},
    wave: 'none',
    lastTargetChangeTurn: 0,
    lastTaxChangeTurn: 0,
    lastArmyReorganizationTurn: 0,
    lastOffensiveEndTurn: 0,
    lastMainWaveTurn: 0,
    stableTurns: 0,
    idleTurns: 0,
    stalledTurns: 0,
    lastCancellationReason: null,
  }
}

export type AiCommand =
  | { type: 'build'; building: BuildingKind; position: CellPosition }
  | { type: 'recruit'; troop: TroopKind; quantity: number; position: CellPosition }
  | { type: 'move-or-attack'; from: CellPosition; to: CellPosition }
  | { type: 'split'; from: CellPosition; to: CellPosition; units: TroopComposition }
  | { type: 'dismiss'; from: CellPosition; units: TroopComposition }
  | { type: 'garrison'; from: CellPosition; tower: CellPosition; quantity?: number }
  | { type: 'ungarrison'; tower: CellPosition; to: CellPosition }
  | { type: 'tower-attack'; tower: CellPosition; to: CellPosition }
  | { type: 'demolish'; position: CellPosition }
  | { type: 'tax'; rate: TaxRate }
  | { type: 'trade'; market: CellPosition; resource: TradeResource; direction: 'buy' | 'sell'; quantity: number }

export interface AiPlanTraceEntry {
  goal: AiStrategicPhase | 'target' | 'layout' | 'tactics' | 'trade' | 'tax'
  command?: AiCommand
  score: number
  factors: string[]
  rejectedReason?: string
}

export interface AiPlan {
  commands: AiCommand[]
  memory: AiMemory
  exploredNodes: number
  partial: boolean
  elapsedMs: number
  trace: AiPlanTraceEntry[]
}

export interface AiCapabilities {
  trade: boolean
  demolition: boolean
}

export interface AiDoctrine {
  preferredTroops: TroopKind[]
  defensiveTroops: TroopKind[]
  targetComposition: Partial<Record<TroopKind, number>>
  defenseForceShare: number
  propertyGuardShare: number
  raidForceShare: number
  retreatHealthShare: number
  targetStickiness: number
  maneuverBias: number
  concentrationBias: number
  raidBias: number
  finisherBias: number
  musterBias: number
  marchingGroupBias: number
  probeRiskThreshold: number
  forceTargets: Record<'probe' | 'raid' | 'assault' | 'defense', {
    minimum: number
    preferred: number
    maximum: number
  }>
  offensivePauseTurns: number
}

export interface AiSettlementDoctrine {
  areaScale: number
  remoteTowerLimit: number
  zoneOriginTargets: Record<AiSettlementZoneKind, number>
  buildingLimits: Partial<Record<BuildingKind, number>>
  overflowRadius: Record<AiSettlementZoneKind, number>
}

export interface AiProfileRules {
  id: AiProfileId
  arsenalTier: AiArsenalTier
  allowedBuildings: BuildingKind[]
  allowedTroops: TroopKind[]
  capabilities: AiCapabilities
  allowedLayouts: AiLayoutKind[]
  preferredOpenings: AiOpeningKind[]
  doctrine: AiDoctrine
  settlement: AiSettlementDoctrine
  riskThreshold: number
  earliestOffensiveRound: number
  strategicReserve: Partial<Record<ResourceId, number>>
}
