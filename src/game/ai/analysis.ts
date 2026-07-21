export type { AiCellAnalysis, AiObjectEntry, AiWorldAnalysis } from './analysis/world'

export {
  aiObjectEntries,
  aiWorldAnalysisKey,
  analyzeAiWorld,
  castlePositionFor,
  isPrimaryObject,
  positionDistance,
  positionKey,
  samePosition,
  withAiObjectIndexCache,
} from './analysis/world'

export {
  createSettlementPlan,
  footprintOpportunityCost,
} from './analysis/settlement'
