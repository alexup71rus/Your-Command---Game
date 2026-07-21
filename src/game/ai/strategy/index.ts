export type {
  AiEconomySnapshot,
  BuildingGoal,
  StrategicCandidate,
} from './types'

export {
  armyPowerFor,
  chooseTargetOwner,
  economicEmergencyFor,
  economySnapshotFor,
  estimatedTargetPower,
  fortificationReadyFor,
  hasHuntingTerrainPotential,
  homeThreatFor,
  immediateCriticalAssetAttackFor,
  populationGrowthSupplyFor,
  stagingAnchorsFor,
  strategicPhaseFor,
  troopCompositionPower,
} from './assessment'

export {
  adaptiveBuildingLimitFor,
  desiredBuildingGoals,
  findStrategicBuildPosition,
  fortificationLineActivated,
  fortificationLineStarted,
  fundedStoneGoalFor,
  minimumFortificationCostFor,
  nextFortificationStep,
} from './development'

export {
  marketCandidate,
  recruitmentCandidate,
  strategicCandidates,
} from './operations'

export {
  canAffordStrategicGoal,
  projectedStrategicScore,
  traceForCandidate,
} from './scoring'

export { forceTargetFor } from './shared'
