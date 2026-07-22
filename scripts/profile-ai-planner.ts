import { aiProfiles } from '../src/config/ai'
import { analyzeAiWorld, createSettlementPlan, withAiObjectIndexCache } from '../src/game/ai/analysis'
import { createAiMemory, aiProfileIds } from '../src/game/ai/model'
import { planAiTurn } from '../src/game/ai/planner'
import { findStrategicBuildPosition, withStrategicPlacementCache } from '../src/game/ai/strategy'
import { createManualHeightGrid, generateMap } from '../src/game/generator'
import { createMatch, withMatchObjectIndexCache } from '../src/game/match'
import { withMovementPathCache } from '../src/game/pathfinding'
import { mapPresets } from '../src/game/presets'
import { createMapScenario, foundAutomatedMatch } from '../src/game/scenario'

const preset = mapPresets.find((candidate) => candidate.id === 'greenMarches')
if (!preset) throw new Error('Missing greenMarches map preset')
const requestedPhase = process.argv[2] ?? 'plan'
const requestedProfile = process.argv[3]

const mapSize = Number(process.argv[4] ?? 100)
const settings = { ...preset.settings, mapSize }
console.info(`Generating ${mapSize}x${mapSize} profiling map`)
const generated = generateMap(settings, createManualHeightGrid())
console.info('Generated terrain; assigning regions')
const scenarioResult = createMapScenario(generated, 2, settings.seed, {
  id: 'ai-planner-profile',
  name: 'AI planner profile',
})
if (!scenarioResult.ok) throw new Error(scenarioResult.reason)
console.info('Created profiling scenario')

for (const profileId of aiProfileIds) {
  if (requestedProfile && profileId !== requestedProfile) continue
  const scenario = foundAutomatedMatch(scenarioResult.scenario, [profileId, profileId])
  const state = createMatch(scenario)
  const ownerId = state.activeParticipantId
  const analysisStartedAt = performance.now()
  const analysis = analyzeAiWorld(scenario, ownerId)
  const worldAnalysisMs = performance.now() - analysisStartedAt
  console.info(`${profileId}: world analysis ${worldAnalysisMs.toFixed(1)}ms`)
  if (!analysis) throw new Error(`Missing analysis for ${profileId}`)
  if (requestedPhase === 'analysis') continue
  const settlementStartedAt = performance.now()
  const settlementPlan = createSettlementPlan(analysis, scenario, aiProfiles[profileId])
  const settlementPlanMs = performance.now() - settlementStartedAt
  console.info(`${profileId}: settlement plan ${settlementPlanMs.toFixed(1)}ms`)
  if (requestedPhase === 'settlement') continue
  if (requestedPhase === 'placements') {
    const memory = { ...createAiMemory(), settlementPlan }
    const domain = state.domains[ownerId]
    const fundedState = {
      ...state,
      domains: {
        ...state.domains,
        [ownerId]: {
          ...domain,
          resources: Object.fromEntries(Object.keys(domain.resources).map((resource) => [resource, 10_000])) as typeof domain.resources,
        },
      },
    }
    withMatchObjectIndexCache(() => withAiObjectIndexCache(() => withMovementPathCache(() => (
      withStrategicPlacementCache(() => aiProfiles[profileId].allowedBuildings.forEach((kind) => {
        const startedAt = performance.now()
        const position = findStrategicBuildPosition(fundedState, analysis, memory, kind, () => true)
        console.info(`${profileId}: ${kind} ${(performance.now() - startedAt).toFixed(1)}ms ${position ? `${position.column}:${position.row}` : 'none'}`)
      }))
    ))))
    continue
  }
  const mode = requestedPhase === 'combat' ? 'combat-only'
    : requestedPhase === 'development' ? 'development-only'
      : 'full'
  const plan = planAiTurn(state, { ...createAiMemory(), settlementPlan }, profileId, { cachedAnalysis: analysis, mode })
  console.info(JSON.stringify({
    profile: aiProfiles[profileId].name,
    mapSize,
    worldAnalysisMs,
    settlementPlanMs,
    exploredNodes: plan.exploredNodes,
    commands: plan.commands.length,
    timings: plan.timings,
  }, null, 2))
}
