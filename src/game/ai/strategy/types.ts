import type { BuildingKind, ResourceId } from '../../map'
import type { AiCommand, AiStrategicPhase } from '../model'

export interface StrategicCandidate {
  command: AiCommand
  utility: number
  goal: AiStrategicPhase | 'trade' | 'tax'
  factors: string[]
}

export interface BuildingGoal {
  kind: BuildingKind
  utility: number
  factors: string[]
}

export interface StrategicCandidateMetrics {
  otherCandidatesMs: number
  buildingGoalsMs: number
  buildingPlacementMs: number
}

export interface AiEconomySnapshot {
  foodStock: number
  foodDemand: number
  foodRunway: number
  goldRunway: number
  workforceFree: number
  housingCapacity: number
  residentialCapacity: number
  foodServiceCapacity: number
  armySize: number
  armyPower: number
  forecastFed: boolean
  upkeepPaid: boolean
  resourceFlow: Record<ResourceId, number>
}
