import { aiPlannerConfig, aiTacticalConfig } from '../../config/ai'
import { buildingRules } from '../../config/rules'
import type { TroopComposition, TroopKind } from '../map'
import {
  moveOrAttackFailure,
  squadHealth,
  squadSize,
  splitFailure,
  totalArmySize,
  type MatchState,
} from '../match'
import { findMovementPath } from '../pathfinding'
import { clockwiseCardinalDirections } from '../geometry'
import { areOwnersHostile, type CellPosition } from '../scenario'
import { aiObjectEntries, castlePositionFor, positionDistance, positionKey } from './analysis'
import { armyPowerFor, estimatedTargetPower, fortificationLineActivated, homeThreatFor, stagingAnchorsFor, troopCompositionPower } from './strategy'
import { raidObjectivesFor } from './strategy/raids'
import type { AiCommand, AiMemory, AiProfileRules, AiStrategicPhase } from './model'
import {
  attackCandidates,
  healthShare,
} from './tactics/combat'
import { formationSplit } from './tactics/formation'
import { movementCandidates } from './tactics/movement'
import { approachDestinations, mapWithRememberedThreats } from './tactics/navigation'
import type { TacticalCandidate } from './tactics/selection'
import {
  isTemporarilyBlocked,
  squadEntries,
} from './tactics/state'
import { towerCandidates } from './tactics/towers'

export { assaultPathFor } from './tactics/combat'
export { assignSquadRoles, formationSplit, waveFor } from './tactics/formation'
export { selectTacticalCandidate, tacticalMovementEdgeKey } from './tactics/selection'
export type { TacticalCandidate, TacticalSelectionOptions } from './tactics/selection'

function mergeCandidates(state: MatchState, profile: AiProfileRules, memory: AiMemory, phase: AiStrategicPhase) {
  if (phase !== 'defense' && memory.lastArmyReorganizationTurn > 0
    && state.turn - memory.lastArmyReorganizationTurn < aiPlannerConfig.armyReorganizationCooldownTurns) return []
  const squads = squadEntries(state, state.activeParticipantId)
  const defensiveThreatPower = phase === 'defense'
    ? homeThreatFor(state, state.activeParticipantId, memory).power
    : 0
  const needsTowerGarrison = aiObjectEntries(state.scenario, state.activeParticipantId).some((entry) => (
    entry.object.type === 'building' && entry.object.kind === 'tower'
      && (entry.object.garrison?.archers ?? 0) < aiTacticalConfig.tower.minimumPeacetimeArchers
  ))
  const candidates: TacticalCandidate[] = []
  for (let firstIndex = 0; firstIndex < squads.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < squads.length; secondIndex += 1) {
      const first = squads[firstIndex]
      const second = squads[secondIndex]
      if (positionDistance(first.position, second.position) !== 1) continue
      const command: AiCommand = { type: 'move-or-attack', from: first.position, to: second.position }
      if (moveOrAttackFailure(state, first.position, second.position) !== null) continue
      const combined = squadSize(first.object) + squadSize(second.object)
      const formation = aiTacticalConfig.formation
      const fragility = Number(healthShare(first.object) < formation.fragileHealthShare)
        + Number(healthShare(second.object) < formation.fragileHealthShare)
      const firstRole = memory.squadRoles[positionKey(first.position)]
      const secondRole = memory.squadRoles[positionKey(second.position)]
      if (needsTowerGarrison && (firstRole === 'ranged' || secondRole === 'ranged')) continue
      const rolesDiffer = firstRole !== secondRole
      const separatesHomeReserve = (firstRole === 'reserve') !== (secondRole === 'reserve')
      if (separatesHomeReserve && phase !== 'defense' && phase !== 'regroup') continue
      if (phase === 'assault' && fragility === 0 && rolesDiffer
        && profile.doctrine.maneuverBias >= formation.maneuverRoleThreshold) continue
      const regroupValue = phase === 'regroup' || phase === 'defense' ? formation.regroupUtility : 0
      const marchingGroupValue = phase === 'mobilization'
        ? formation.mobilizationBaseUtility + profile.doctrine.marchingGroupBias * formation.mobilizationBiasUtility
        : 0
      const firstPower = troopCompositionPower(first.object.units, squadHealth(first.object))
      const secondPower = troopCompositionPower(second.object.units, squadHealth(second.object))
      const combinedPower = firstPower + secondPower
      // Concentration is valued by the amount of the known defensive power
      // gap it closes. There is no fixed "wait for N soldiers" rule: two tiny
      // groups merge eagerly against a strong incursion, while already useful
      // formations remain separate when that gives the defense more coverage.
      const independentFormationTarget = Math.min(
        defensiveThreatPower,
        profile.doctrine.forceTargets.defense.minimum,
      )
      const concentrationGain = phase === 'defense'
        ? Math.max(0,
            Math.min(independentFormationTarget, combinedPower)
              - Math.min(independentFormationTarget, Math.max(firstPower, secondPower)))
          * aiTacticalConfig.defense.concentrationPowerUtility
        : 0
      candidates.push({
        command,
        score: formation.mergeBaseUtility + regroupValue + marchingGroupValue + fragility * formation.fragileMergeUtility
          + Math.max(0, formation.smallGroupSize - combined) * formation.smallGroupUtility + concentrationGain,
        factors: [
          'consolidate-force',
          ...(concentrationGain > 0 ? [`defense-concentration:${concentrationGain.toFixed(1)}`] : []),
          ...(marchingGroupValue > 0 ? ['form-marching-group'] : []),
        ],
      })
    }
  }
  return candidates
}

function pathOverlap(first: CellPosition[], second: CellPosition[]) {
  const firstKeys = new Set(first.slice(1, aiTacticalConfig.route.overlapLookahead + 1).map(positionKey))
  const secondKeys = second.slice(1, aiTacticalConfig.route.overlapLookahead + 1).map(positionKey)
  if (firstKeys.size === 0 || secondKeys.length === 0) return 1
  return secondKeys.reduce((sum, key) => sum + Number(firstKeys.has(key)), 0) / Math.min(firstKeys.size, secondKeys.length)
}

function splitCandidate(state: MatchState, profile: AiProfileRules, memory: AiMemory, countNode: () => boolean) {
  if (memory.phase !== 'assault' && memory.phase !== 'mobilization') return null
  if (memory.lastArmyReorganizationTurn > 0
    && state.turn - memory.lastArmyReorganizationTurn < aiPlannerConfig.armyReorganizationCooldownTurns) return null
  const target = memory.targetOwnerId ? castlePositionFor(state.scenario, memory.targetOwnerId) : null
  if (!target) return null
  const squads = squadEntries(state, state.activeParticipantId)
  const armySize = totalArmySize(state, state.activeParticipantId)
  const ownPower = armyPowerFor(state, state.activeParticipantId)
  const targetPower = estimatedTargetPower(state, memory.targetOwnerId, memory)
  if (ownPower < targetPower * profile.riskThreshold * aiTacticalConfig.formation.splitReadinessMultiplier) return null
  const maximumUsefulGroups = Math.max(1, Math.floor(armySize / aiTacticalConfig.formation.usefulGroupSize))
  if (squads.length >= maximumUsefulGroups) return null
  const source = [...squads].sort((first, second) => squadSize(second.object) - squadSize(first.object))[0]
  if (!source || squadSize(source.object) < aiTacticalConfig.formation.splitMinimumSquadSize) return null
  if (memory.phase === 'mobilization') {
    const stagingAnchors = stagingAnchorsFor(state, state.activeParticipantId, memory)
    if (stagingAnchors.length > 0 && !stagingAnchors.some((anchor) => (
      positionDistance(source.position, anchor) <= aiTacticalConfig.formation.stagingSplitRadius
    ))) return null
  }
  const splitUnits = formationSplit(source.object, profile)
  const remainingUnits = (Object.keys(source.object.units) as TroopKind[]).reduce((result, troop) => ({
    ...result,
    [troop]: source.object.units[troop] - splitUnits[troop],
  }), { militia: 0, spearmen: 0, archers: 0, knights: 0 } as TroopComposition)
  if (troopCompositionPower(splitUnits) < aiTacticalConfig.formation.splitMinimumGroupPower
    || troopCompositionPower(remainingUnits) < aiTacticalConfig.formation.splitMinimumGroupPower) return null
  const navigationMap = mapWithRememberedThreats(state, memory, state.activeParticipantId)
    .map((row) => [...row])
  const approaches = approachDestinations(state, target, 'assault', navigationMap)
  let best: TacticalCandidate | null = null
  for (const direction of clockwiseCardinalDirections) {
    if (!countNode()) return best
    const to = { column: source.position.column + direction.column, row: source.position.row + direction.row }
    if (isTemporarilyBlocked(memory, to, state.turn)) continue
    const cell = navigationMap[to.row]?.[to.column]
    if (!cell || cell.landform === 'peak' || cell.object) continue
    if (splitFailure(state, source.position, to, splitUnits) !== null) continue
    for (const firstDestination of approaches) {
      if (!countNode()) return best
      const firstPath = findMovementPath(navigationMap, source.position, firstDestination, { ownerId: state.activeParticipantId })
      if (!firstPath || firstPath.length < aiTacticalConfig.formation.splitMinimumRouteLength) continue
      for (const secondDestination of approaches) {
        if (!countNode()) return best
        if (positionDistance(firstDestination, secondDestination)
          < aiTacticalConfig.formation.splitMinimumDestinationSeparation) continue
        const secondPath = findMovementPath(navigationMap, to, secondDestination, { ownerId: state.activeParticipantId })
        if (!secondPath || secondPath.length < aiTacticalConfig.formation.splitMinimumRouteLength) continue
        const overlap = pathOverlap(firstPath, secondPath)
        if (overlap > aiTacticalConfig.formation.splitMaximumPathOverlap) continue
        const diversity = (1 - overlap) * aiTacticalConfig.formation.splitDiversityUtility * profile.doctrine.maneuverBias
        const concentrationLoss = aiTacticalConfig.formation.splitConcentrationCost * profile.doctrine.concentrationBias
        const targetRisk = targetPower > ownPower
          ? aiTacticalConfig.formation.splitTargetRiskCost * profile.doctrine.concentrationBias
          : 0
        const score = diversity - concentrationLoss - targetRisk
          - squads.length * aiTacticalConfig.formation.splitExistingGroupCost
        if (score <= 0) continue
        const candidate: TacticalCandidate = {
          command: { type: 'split', from: source.position, to, units: splitUnits },
          score,
          factors: [`route-diversity:${(1 - overlap).toFixed(2)}`, `concentration-cost:${(concentrationLoss + targetRisk).toFixed(1)}`],
        }
        if (!best || candidate.score > best.score) best = candidate
      }
    }
  }
  return best
}

export function tacticalCandidates(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  phase: AiStrategicPhase,
  countNode: () => boolean,
) {
  const navigationMap = mapWithRememberedThreats(state, memory, state.activeParticipantId)
    .map((row) => [...row])
  const ownCastle = castlePositionFor(state.scenario, state.activeParticipantId)
  const coreBreach = Boolean(ownCastle && aiObjectEntries(state.scenario).some((entry) => (
    entry.object.type === 'squad'
      && areOwnersHostile(state.scenario.participants, state.activeParticipantId, entry.object.ownerId)
      && positionDistance(entry.position, ownCastle) <= aiTacticalConfig.defense.coreBreachRadius
  )))
  // Route through the planned barbican instead of repeatedly choosing an
  // empty future wall cell as the first step and rejecting the whole path.
  // Empty walls/towers are navigation obstacles; the gate deliberately stays
  // open so troops inside an enclosure are never trapped by the blueprint.
  if (!coreBreach) memory.settlementPlan?.fortification?.lines.filter((line) => (
    fortificationLineActivated(state, line)
  )).forEach((line) => {
    for (const position of [...line.walls, ...line.towers]) {
      const cell = navigationMap[position.row]?.[position.column]
      if (!cell || cell.object) continue
      navigationMap[position.row][position.column] = {
        ...cell,
        object: {
          type: 'building', kind: 'wall', ownerId: state.activeParticipantId,
          hitPoints: buildingRules.wall.hitPoints, maxHitPoints: buildingRules.wall.hitPoints,
        },
      }
    }
  })
  const raidObjectives = raidObjectivesFor(
    state,
    navigationMap,
    profile,
    memory,
    phase,
    countNode,
  )
  const candidates = [
    ...towerCandidates(state, profile, memory, phase, countNode),
    ...attackCandidates(state, profile, phase, memory.targetOwnerId, raidObjectives, countNode),
    ...mergeCandidates(state, profile, memory, phase),
    ...movementCandidates(
      state,
      profile,
      memory,
      phase,
      memory.targetOwnerId,
      navigationMap,
      raidObjectives,
      countNode,
    ),
  ]
  const split = splitCandidate(state, profile, memory, countNode)
  if (split) candidates.push(split)
  return candidates.sort((first, second) => second.score - first.score || JSON.stringify(first.command).localeCompare(JSON.stringify(second.command)))
}
