import { aiPlannerConfig, aiTacticalConfig } from '../../../config/ai'
import { troopKinds } from '../../../config/rules'
import type { SquadObject, TroopComposition } from '../../map'
import { squadSize, totalArmySize, type MatchState } from '../../match'
import { aiObjectEntries, castlePositionFor, positionDistance, positionKey } from '../analysis'
import type {
  AiMemory,
  AiProfileRules,
  AiSquadRole,
  AiStrategicPhase,
  AiWaveKind,
} from '../model'
import {
  armyPowerFor,
  estimatedTargetPower,
  fortificationReadyFor,
  troopCompositionPower,
} from '../strategy'
import { forceTargetFor } from '../strategy/shared'

const squadEntries = (state: MatchState, ownerId: string) => aiObjectEntries(state.scenario, ownerId)
  .flatMap((entry) => entry.object.type === 'squad'
    ? [{ position: entry.position, object: entry.object as SquadObject }]
    : [])

function frontLineUnitCount(squad: SquadObject) {
  return aiTacticalConfig.formation.frontLineTroops.reduce((sum, troop) => sum + squad.units[troop], 0)
}

/** Splits a mixed formation while keeping useful combat roles in both halves. */
export function formationSplit(squad: SquadObject, profile: AiProfileRules) {
  const desiredSize = Math.floor(squadSize(squad) / 2)
  const result: TroopComposition = { militia: 0, spearmen: 0, archers: 0, knights: 0 }
  troopKinds.forEach((troop) => {
    result[troop] = Math.floor((squad.units[troop] ?? 0) / 2)
  })

  const resultSize = () => troopKinds.reduce((sum, troop) => sum + result[troop], 0)
  const resultFrontLine = () => aiTacticalConfig.formation.frontLineTroops
    .reduce((sum, troop) => sum + result[troop], 0)
  const availableOddTroops = () => troopKinds.filter((troop) => (
    (squad.units[troop] ?? 0) - result[troop] > result[troop]
  ))
  while (resultSize() < desiredSize) {
    const candidates = availableOddTroops()
      .map((troop) => {
        const needsRanged = result.archers === 0 && troop === 'archers'
        const needsFrontLine = resultFrontLine() === 0
          && aiTacticalConfig.formation.frontLineTroops.includes(troop)
        const desiredShare = (profile.doctrine.targetComposition[troop] ?? 0) * desiredSize
        const compositionDeficit = desiredShare - result[troop]
        return {
          troop,
          score: Number(needsRanged) * aiTacticalConfig.formation.splitRolePriority
            + Number(needsFrontLine) * aiTacticalConfig.formation.splitRolePriority
            + compositionDeficit * aiTacticalConfig.formation.splitCompositionWeight
            - profile.doctrine.preferredTroops.indexOf(troop)
              * aiTacticalConfig.formation.splitPreferenceTieBreak,
        }
      })
      .sort((first, second) => second.score - first.score
        || troopKinds.indexOf(first.troop) - troopKinds.indexOf(second.troop))
    const next = candidates[0]?.troop
    if (!next) break
    result[next] += 1
  }
  return result
}

export function assignSquadRoles(
  state: MatchState,
  profile: AiProfileRules,
  previous: AiMemory['squadRoles'],
  phase: AiStrategicPhase,
) {
  const ownerId = state.activeParticipantId
  const castle = castlePositionFor(state.scenario, ownerId)
  const squads = squadEntries(state, ownerId)
    .sort((first, second) => first.position.row - second.position.row
      || first.position.column - second.position.column)
  const totalPower = squads.reduce((sum, squad) => sum + troopCompositionPower(squad.object.units), 0)
  const defenseBand = profile.doctrine.forceTargets.defense
  const reserveShare = phase === 'defense'
    ? profile.doctrine.defenseForceShare
    : profile.doctrine.propertyGuardShare
  const reserveTarget = Math.min(
    defenseBand.maximum,
    totalPower,
    reserveShare > 0
      ? Math.max(phase === 'defense' ? defenseBand.minimum : 0, totalPower * reserveShare)
      : 0,
  )
  let reservedPower = 0
  const roles: Record<string, AiSquadRole> = {}
  const sortedByHome = [...squads].sort((first, second) => castle
    ? positionDistance(first.position, castle) - positionDistance(second.position, castle)
    : 0)
  const threatened = phase === 'defense'
  const rangedRoleKeys = new Set(squads.flatMap((squad) => {
    const key = positionKey(squad.position)
    const archerShare = squad.object.units.archers / Math.max(1, squadSize(squad.object))
    return archerShare >= aiTacticalConfig.formation.rangedRoleShare
      || (previous[key] === 'ranged'
        && archerShare >= aiTacticalConfig.formation.retainedRangedRoleShare)
      ? [key]
      : []
  }))
  const screenSquadKeys = new Set<string>()
  for (const ranged of squads.filter((squad) => rangedRoleKeys.has(positionKey(squad.position)))) {
    const screen = squads
      .filter((candidate) => !rangedRoleKeys.has(positionKey(candidate.position))
        && !screenSquadKeys.has(positionKey(candidate.position))
        && frontLineUnitCount(candidate.object) > 0
        && positionDistance(candidate.position, ranged.position) <= aiTacticalConfig.formation.screenRadius)
      .sort((first, second) => positionDistance(first.position, ranged.position)
        - positionDistance(second.position, ranged.position)
        || frontLineUnitCount(second.object) - frontLineUnitCount(first.object)
        || first.position.row - second.position.row
        || first.position.column - second.position.column)[0]
    if (screen) screenSquadKeys.add(positionKey(screen.position))
  }
  for (const squad of squads) {
    const key = positionKey(squad.position)
    const size = Math.max(1, squadSize(squad.object))
    const archerShare = squad.object.units.archers / size
    const squadPower = troopCompositionPower(squad.object.units)
    let role: AiSquadRole
    if (rangedRoleKeys.has(key)) role = 'ranged'
    else if (screenSquadKeys.has(key)) role = 'screen'
    else if (threatened && sortedByHome.indexOf(squad) < Math.ceil(squads.length / 2)) role = 'defender'
    else if (squads.length > 1 && reservedPower < reserveTarget
      && squadPower <= totalPower * Math.max(
        aiTacticalConfig.formation.minimumReserveSquadShare,
        reserveShare * aiTacticalConfig.formation.reserveSquadShareMultiplier,
      )) {
      role = 'reserve'
      reservedPower += squadPower
    } else if (size <= aiTacticalConfig.formation.scoutMaximumSize
      && profile.doctrine.maneuverBias > aiTacticalConfig.formation.scoutManeuverThreshold
      && (phase === 'assault' || squads.length >= aiTacticalConfig.formation.scoutMinimumGroups)) role = 'scout'
    else role = 'assault'
    const oldRole = previous[key]
    roles[key] = oldRole === 'ranged'
      && archerShare >= aiTacticalConfig.formation.retainedRangedRoleShare ? oldRole : role
  }
  return roles
}

export function waveFor(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  phase: AiStrategicPhase,
): AiWaveKind {
  if (phase === 'defense') return 'none'
  if (phase === 'regroup') return 'regroup'
  if (phase !== 'assault') return memory.wave === 'regroup' ? 'none' : memory.wave
  const targetPower = estimatedTargetPower(state, memory.targetOwnerId, memory)
  const power = armyPowerFor(state, state.activeParticipantId)
  if (!fortificationReadyFor(state, memory)
    || power < forceTargetFor(profile, 'assault', targetPower, profile.riskThreshold)) return 'probe'
  const targetCastle = memory.targetOwnerId
    ? castlePositionFor(state.scenario, memory.targetOwnerId)
    : null
  if (targetCastle) {
    const nearTarget = squadEntries(state, state.activeParticipantId)
      .some((entry) => positionDistance(entry.position, targetCastle) <= aiTacticalConfig.tower.siegeRange)
    if (nearTarget) return 'siege'
  }
  if (memory.wave === 'main' && totalArmySize(state, state.activeParticipantId) > 0) return 'support'
  if (memory.lastMainWaveTurn > 0
    && state.turn - memory.lastMainWaveTurn <= aiPlannerConfig.mainWaveCooldownTurns) return 'support'
  return 'main'
}
