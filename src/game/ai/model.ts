import type { BuildingKind, ResourceId, TroopComposition, TroopKind } from '../map'
import type { AiProfileId, CellPosition } from '../scenario'
import type { TaxRate, TradeResource } from '../../config/rules'

export const aiProfileIds: AiProfileId[] = ['radomir', 'velislava', 'svyatobor']

export type AiArsenalTier = 'basic' | 'tactical' | 'complete'
export type AiLayoutKind = 'courtyard' | 'frontier' | 'strongpoint'
export type AiFortificationKind = 'curtain' | 'terrain-gate' | 'bastion' | 'enclosure'
export type AiFortificationPattern = 'none' | 'curtain' | 'citadel-enclosure'
export type AiFortificationShape = 'straight' | 'winged' | 'enclosure'
export type AiFortificationPurpose = 'core' | 'delay' | 'surplus'
export type AiOpeningKind = 'forest' | 'plains' | 'highland'
export type AiStrategicPhase = 'recovery' | 'survival' | 'expansion' | 'mobilization' | 'assault' | 'regroup' | 'defense'
export type AiWaveKind = 'none' | 'probe' | 'main' | 'support' | 'regroup' | 'siege'
export type AiSquadRole = 'defender' | 'assault' | 'screen' | 'ranged' | 'scout' | 'reserve'
export type AiContactKind = 'squad' | 'barracks'
export type AiSettlementZoneKind = 'housing' | 'food' | 'industry' | 'military' | 'defense'
export type AiReservedSiteKind = 'housing' | 'food' | 'military' | 'industry' | 'gate' | 'leftTower' | 'rightTower' | 'outpostTower'

export const aiLayoutKinds: readonly AiLayoutKind[] = ['courtyard', 'frontier', 'strongpoint']
export const aiFortificationKinds: readonly AiFortificationKind[] = ['curtain', 'terrain-gate', 'bastion', 'enclosure']
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

export interface AiRecentMovement {
  from: CellPosition
  to: CellPosition
  turn: number
}

export interface AiSettlementPlan {
  layout: AiLayoutKind
  opening: AiOpeningKind
  front: CellPosition
  reservedCorridors: CellPosition[]
  /** Internal service paths to constrained production pockets (for example a
   * one-cell mountain road). Kept separate from the military approach so
   * staging logic does not mistake an industry route for the battle front. */
  reservedAccessRoutes?: CellPosition[]
  /** Deep resource cells that must remain reachable after each placement. */
  reservedAccessTargets?: CellPosition[]
  reservedSites: Partial<Record<AiReservedSiteKind, CellPosition>>
  /** Footprint origins kept open until a missing critical capability exists. */
  reservedBuildingSites?: Partial<Record<BuildingKind, CellPosition>>
  fortification: {
    lines: Array<{
      kind: AiFortificationKind
      /** Visual/route doctrine. Optional so older saved AI memories remain valid. */
      shape?: AiFortificationShape
      /** Core defenses are mandatory; surplus outworks wait for a funded stockpile. */
      purpose?: AiFortificationPurpose
      /** Stone left untouched when committing an optional surplus outwork. */
      activationStoneReserve?: number
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
  recentMovements: AiRecentMovement[]
  targetOwnerId: string | null
  phase: AiStrategicPhase
  settlementPlan: AiSettlementPlan | null
  settlementPlanAnalysisKey: string | null
  lastSettlementPlanReviewTurn: number
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
  /** Best front-line distance reached against the current target. */
  campaignBestDistance: number | null
  stalledTurns: number
  lastCancellationReason: string | null
}

export function createAiMemory(): AiMemory {
  return {
    contacts: [],
    blockedCells: [],
    recentMovements: [],
    targetOwnerId: null,
    phase: 'survival',
    settlementPlan: null,
    settlementPlanAnalysisKey: null,
    lastSettlementPlanReviewTurn: 0,
    squadRoles: {},
    wave: 'none',
    lastTargetChangeTurn: 0,
    lastTaxChangeTurn: 0,
    lastArmyReorganizationTurn: 0,
    lastOffensiveEndTurn: 0,
    lastMainWaveTurn: 0,
    stableTurns: 0,
    idleTurns: 0,
    campaignBestDistance: null,
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
  elapsedMs: number
  timings: AiPlanTimings
  trace: AiPlanTraceEntry[]
}

export interface AiPlanTimings {
  perceptionMs: number
  worldAnalysisMs: number
  settlementPlanMs: number
  tacticalCandidatesMs: number
  strategicSearchMs: number
  strategicCandidatesMs: number
  strategicEvaluationMs: number
  strategicEconomyProjectionMs: number
  strategicSimulationMs: number
  strategicOtherCandidatesMs: number
  strategicBuildingGoalsMs: number
  strategicBuildingPlacementMs: number
  totalMs: number
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
  fortificationPattern: AiFortificationPattern
  maximumCurtainWingDepth: number
  surplusFortificationStoneReserve: number
  remoteTowerLimit: number
  zoneOriginTargets: Record<AiSettlementZoneKind, number>
  buildingLimits: Partial<Record<BuildingKind, number>>
  overflowRadius: Record<AiSettlementZoneKind, number>
}

export interface AiDevelopmentMilestone {
  round: number
  economyBonusSlots: number
  housingBonusSlots: number
  armyCeiling: number
}

export interface AiTaxDoctrine {
  maximumRate: TaxRate
  /** Minimum projected food runway required before using maximum taxation. */
  maximumRateFoodRunway: number
  /** Gold runway below which a food-secure domain should raise more revenue. */
  desiredGoldRunway: number
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
  developmentMilestones: AiDevelopmentMilestone[]
  taxation: AiTaxDoctrine
  riskThreshold: number
  earliestOffensiveRound: number
  strategicReserve: Partial<Record<ResourceId, number>>
}
