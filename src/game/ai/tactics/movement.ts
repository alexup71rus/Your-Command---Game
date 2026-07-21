import { aiPlannerConfig, aiStrategicConfig, aiTacticalConfig } from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import type { BuildingKind, BuildingObject, GameMap, SquadObject } from '../../map'
import {
  moveOrAttackFailure,
  objectAt,
  squadHealth,
  type MatchState,
} from '../../match'
import { findMovementPath } from '../../pathfinding'
import { squadMovementOrderCost } from '../../movement'
import { clockwiseCardinalDirections } from '../../geometry'
import { areOwnersHostile, type CellPosition } from '../../scenario'
import { aiObjectEntries, castlePositionFor, positionDistance, positionKey, samePosition } from '../analysis'
import { executeAiCommand } from '../commands'
import { estimatedTargetPower, homeThreatFor, stagingAnchorsFor, troopCompositionPower } from '../strategy'
import type { RaidObjective } from '../strategy/raids'
import {
  forceTargetFor,
  isPlannedFortification,
  isPlannedFortificationGate,
} from '../strategy/shared'
import type { AiCommand, AiMemory, AiProfileRules, AiSquadRole, AiStrategicPhase } from '../model'
import {
  assaultPathWithThreats,
  evaluateCommand,
  healthShare,
  hostileArcherExposureAt,
  immediateReplyPowerLossForSquad,
  nearestHostileAsset,
  projectedDefensiveContact,
  towerExposureAlong,
  towerThreatsFor,
  type TowerThreat,
} from './combat'
import {
  adjacentDestinations,
  approachDestinations,
  musterDestinations,
  retreatDestination,
} from './navigation'
import type { TacticalCandidate } from './selection'
import { isTemporarilyBlocked, revisitsRecentFormationTrail, squadEntries } from './state'

function frontLineUnitCount(squad: SquadObject) {
  return aiTacticalConfig.formation.frontLineTroops.reduce((sum, troop) => sum + squad.units[troop], 0)
}

function hostileFrontLineSquads(state: MatchState, ownerId: string) {
  return aiObjectEntries(state.scenario).flatMap((entry) => (
    entry.object.type === 'squad'
      && areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId)
      && frontLineUnitCount(entry.object) > 0
      ? [{ ...entry, object: entry.object }]
      : []
  ))
}

function rangedSquadCanClearImmediateThreats(
  state: MatchState,
  rangedPosition: CellPosition,
  threats: ReturnType<typeof hostileFrontLineSquads>,
) {
  const immediateThreats = threats
    .filter((entry) => positionDistance(rangedPosition, entry.position)
      <= aiTacticalConfig.formation.rangedWithdrawalThreatDistance)
    .sort((first, second) => positionDistance(first.position, rangedPosition) - positionDistance(second.position, rangedPosition)
      || first.position.row - second.position.row || first.position.column - second.position.column)
  if (immediateThreats.length === 0) return true
  let projected = state
  for (const threat of immediateThreats) {
    for (;;) {
      const target = objectAt(projected, threat.position)
      if (target?.type !== 'squad'
        || !areOwnersHostile(projected.scenario.participants, projected.activeParticipantId, target.ownerId)
        || frontLineUnitCount(target) <= 0) break
      // This short authoritative rollout spends only the current turn's
      // remaining orders. It answers the tactical question directly: can the
      // archers remove every nearby melee threat before the enemy acts?
      const result = executeAiCommand(projected, {
        type: 'move-or-attack', from: rangedPosition, to: threat.position,
      })
      if (!result.ok) return false
      projected = result.state
    }
  }
  return true
}

function rangedSquadHasScreen(
  friendlySquads: ReturnType<typeof squadEntries>,
  ranged: ReturnType<typeof squadEntries>[number],
  threatPosition: CellPosition,
) {
  const rangedThreatDistance = positionDistance(ranged.position, threatPosition)
  return friendlySquads.some((candidate) => candidate !== ranged
    && frontLineUnitCount(candidate.object) > 0
    && positionDistance(candidate.position, ranged.position) === 1
    && positionDistance(candidate.position, threatPosition) < rangedThreatDistance)
}

function screenAnchorFor(
  state: MatchState,
  screen: ReturnType<typeof squadEntries>[number],
  rangedSquads: ReturnType<typeof squadEntries>,
  threats: ReturnType<typeof hostileFrontLineSquads>,
  navigationMap: GameMap,
) {
  const protectedRanged = rangedSquads
    .filter((candidate) => positionDistance(candidate.position, screen.position) <= aiTacticalConfig.formation.screenRadius)
    .sort((first, second) => positionDistance(first.position, screen.position) - positionDistance(second.position, screen.position)
      || first.position.row - second.position.row || first.position.column - second.position.column)[0]
  if (!protectedRanged) return null
  const threat = [...threats].sort((first, second) => (
    positionDistance(first.position, protectedRanged.position) - positionDistance(second.position, protectedRanged.position)
      || first.position.row - second.position.row || first.position.column - second.position.column
  ))[0]
  if (!threat) return null
  const rangedThreatDistance = positionDistance(protectedRanged.position, threat.position)
  const anchor = adjacentDestinations(protectedRanged.position)
    .flatMap((position) => {
      const cell = state.scenario.cells[position.row]?.[position.column]
      if (!cell || cell.landform === 'peak'
        || (cell.object && !samePosition(position, screen.position))
        || positionDistance(position, threat.position) >= rangedThreatDistance) return []
      const path = findMovementPath(navigationMap, screen.position, position, { ownerId: screen.object.ownerId })
      return path ? [{ position, pathLength: path.length }] : []
    })
    .sort((first, second) => first.pathLength - second.pathLength
      || positionDistance(first.position, threat.position) - positionDistance(second.position, threat.position)
      || first.position.row - second.position.row || first.position.column - second.position.column)[0]?.position
  return anchor ? { position: anchor, rangedPosition: protectedRanged.position } : null
}

function nearbyFriendlyCount(squads: ReturnType<typeof squadEntries>, position: CellPosition, ignored: CellPosition) {
  return squads.reduce((sum, squad) => sum + Number(
    positionKey(squad.position) !== positionKey(ignored)
      && positionDistance(squad.position, position) <= aiTacticalConfig.route.nearbySquadRadius,
  ), 0)
}

interface DefensiveAsset {
  position: CellPosition
  value: number
  kind: BuildingKind | 'castle'
}

function defensiveAssetsFor(state: MatchState, ownerId: string): DefensiveAsset[] {
  const values = aiTacticalConfig.defense.assetValues
  return aiObjectEntries(state.scenario, ownerId).flatMap((entry) => {
    const kind = entry.object.type === 'castle'
      ? 'castle' as const
      : entry.object.type === 'building' ? entry.object.kind : null
    const value = kind ? values[kind] : undefined
    return kind && value ? [{ position: entry.position, value, kind }] : []
  })
}

function propertyGuardAnchorsFor(state: MatchState, profile: AiProfileRules, memory: AiMemory, ownerId: string) {
  if (profile.doctrine.propertyGuardShare <= 0) return []
  const castle = castlePositionFor(state.scenario, ownerId)
  if (!castle) return []
  return defensiveAssetsFor(state, ownerId)
    .filter((asset) => {
      if (asset.kind === 'castle' || asset.kind === 'wall' || asset.kind === 'barbican') return false
      // Inline castle towers are covered by the fortress-anchor garrison
      // logic, so they are excluded like walls. A *remote outpost* tower is a
      // different matter: it sits far from the castle, is expensive, and has
      // no garrison rotation of its own — it must be a property-guard anchor.
      if (asset.kind === 'tower' && !isPlannedFortification(memory, asset.position)) return false
      return positionDistance(asset.position, castle) >= aiTacticalConfig.defense.remoteGuardMinimumCastleDistance
    })
    .map((asset) => ({
      ...asset,
      score: asset.value
        + positionDistance(asset.position, castle) * aiTacticalConfig.defense.propertyExposureWeight,
    }))
    .sort((first, second) => second.score - first.score
      || first.position.row - second.position.row || first.position.column - second.position.column)
    .slice(0, aiTacticalConfig.defense.maximumPropertyAnchors)
    .map((asset) => asset.position)
}

function threatPriority(position: CellPosition, assets: DefensiveAsset[]) {
  return Math.max(...assets.map((asset) => (
    asset.value - positionDistance(position, asset.position) * aiTacticalConfig.defense.threatDistancePenalty
  )), 0)
}

function routeScore(
  state: MatchState,
  profile: AiProfileRules,
  squads: ReturnType<typeof squadEntries>,
  squad: ReturnType<typeof squadEntries>[number],
  path: CellPosition[],
  role: AiSquadRole,
  memory: AiMemory,
  phase: AiStrategicPhase,
  towerThreats: TowerThreat[],
  archerThreats: ReturnType<typeof squadEntries>,
) {
  const next = path[1]
  const nearby = nearbyFriendlyCount(squads, next, squad.position)
  const route = aiTacticalConfig.route
  const forests = path.slice(1, route.forestLookahead + 1)
    .reduce((sum, position) => sum + Number(state.scenario.cells[position.row]?.[position.column]?.vegetation), 0)
  const spreadBias = role === 'scout'
    ? profile.doctrine.maneuverBias
    : role === 'assault'
      ? profile.doctrine.maneuverBias * (1 - profile.doctrine.concentrationBias)
      : 0
  const cohesionBias = role === 'assault'
    ? profile.doctrine.concentrationBias
    : role === 'screen' || role === 'ranged' || role === 'reserve'
      ? profile.doctrine.concentrationBias
      : 0
  const spreadValue = spreadBias
    * (route.spreadNeighborCap - Math.min(route.spreadNeighborCap, nearby)) * route.spreadUtility
  const cohesionValue = cohesionBias
    * Math.min(route.spreadNeighborCap, nearby) * route.cohesionUtility
  const knightForestPenalty = squad.object.units.knights > 0 ? forests * route.knightForestPenalty : 0
  const rememberedDanger = phase === 'defense' ? 0 : memory.contacts.reduce((sum, contact) => {
    if (contact.kind !== 'squad'
      || !areOwnersHostile(state.scenario.participants, state.activeParticipantId, contact.ownerId)) return sum
    const nearest = Math.min(
      ...path.slice(1, route.routeLookahead + 1).map((position) => positionDistance(position, contact.position)),
      route.distantContactFallback,
    )
    const age = Math.max(0, state.turn - contact.lastSeenTurn)
    return sum + Math.max(0, route.rememberedDangerRadius - nearest)
      * Math.max(0, gameConfig.ai.memoryRouteAvoidanceTurns - age) * route.rememberedDangerUtility
  }, 0)
  const towerExposure = phase === 'assault'
    ? towerExposureAlong(state, path, towerThreats, squad.object)
    : 0
  const rangedExposure = phase === 'defense'
    ? path.slice(1, aiTacticalConfig.defense.rangedExposureLookahead + 1)
      .reduce((sum, position) => sum + hostileArcherExposureAt(
        state, position, squad.position, squad.object, archerThreats,
      ), 0)
    : 0
  return -path.length * route.pathLengthPenalty + spreadValue + cohesionValue - knightForestPenalty
    - rememberedDanger - towerExposure * aiTacticalConfig.siege.towerExposureRoutePenalty
    - rangedExposure * aiTacticalConfig.defense.rangedExposureRoutePenalty
}
export function movementCandidates(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  phase: AiStrategicPhase,
  targetOwnerId: string | null,
  navigationMap: GameMap,
  raidObjectives: Record<string, RaidObjective>,
  countNode: () => boolean,
) {
  const ownerId = state.activeParticipantId
  const participant = state.scenario.participants.find((candidate) => candidate.id === ownerId)
  const targetCastle = targetOwnerId ? castlePositionFor(state.scenario, targetOwnerId) : null
  const ownCastle = castlePositionFor(state.scenario, ownerId)
  const threat = homeThreatFor(state, ownerId, memory)
  const defensiveAssets = defensiveAssetsFor(state, ownerId)
  const threatensHome = (position: CellPosition) => {
    const inside = participant
      && state.scenario.territories[position.row]?.[position.column] === participant.regionId
    const assetDistance = Math.min(
      ...defensiveAssets.map((asset) => positionDistance(position, asset.position)),
      Number.POSITIVE_INFINITY,
    )
    const coreDistance = ownCastle ? positionDistance(position, ownCastle) : Number.POSITIVE_INFINITY
    return Boolean(inside)
      || assetDistance <= aiStrategicConfig.threat.immediateRadius
      || Math.ceil(coreDistance / aiStrategicConfig.threat.assumedOrdersPerTurn)
        <= aiStrategicConfig.threat.maximumArrivalTurns
  }
  const threateningSquads = aiObjectEntries(state.scenario)
    .flatMap((entry) => entry.object.type === 'squad'
      && areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId)
      && threatensHome(entry.position)
      ? [{ ...entry, object: entry.object }] : [])
    .sort((first, second) => threatPriority(second.position, defensiveAssets) - threatPriority(first.position, defensiveAssets)
      || first.position.row - second.position.row || first.position.column - second.position.column)
  const rememberedThreats = memory.contacts
    .filter((contact) => contact.kind === 'squad'
      && state.turn - contact.lastSeenTurn <= aiPlannerConfig.targetMemoryTurns
      && areOwnersHostile(state.scenario.participants, ownerId, contact.ownerId)
      && threatensHome(contact.position)
      && !threateningSquads.some((entry) => samePosition(entry.position, contact.position)))
    .sort((first, second) => threatPriority(second.position, defensiveAssets) - threatPriority(first.position, defensiveAssets)
      || first.position.row - second.position.row || first.position.column - second.position.column)
  const squads = squadEntries(state, ownerId)
    .sort((first, second) => first.position.row - second.position.row || first.position.column - second.position.column)
  const hostileSquads = aiObjectEntries(state.scenario)
    .flatMap((entry) => entry.object.type === 'squad'
      && areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId)
      ? [{ ...entry, object: entry.object }]
      : [])
  const archerThreats = hostileSquads.filter((entry) => entry.object.units.archers > 0)
  const frontLineThreats = hostileFrontLineSquads(state, ownerId)
  const rangedSquads = squads.filter((entry) => memory.squadRoles[positionKey(entry.position)] === 'ranged')
  const candidates: TacticalCandidate[] = []
  const stagingAnchors = stagingAnchorsFor(state, ownerId, memory)
  const homeAnchor = memory.settlementPlan?.reservedSites.military ?? ownCastle
  const fortressAnchors = [
    ...aiObjectEntries(state.scenario, ownerId).flatMap((entry) => (
      entry.object.type === 'building' && ['tower', 'barbican', 'barracks'].includes(entry.object.kind)
        ? [entry.position] : []
    )),
    ...(ownCastle ? [ownCastle] : []),
  ].filter((position, index, all) => all.findIndex((candidate) => samePosition(candidate, position)) === index)
  const propertyAnchors = propertyGuardAnchorsFor(state, profile, memory, ownerId)
  const defensiveAnchors = [...propertyAnchors, ...fortressAnchors]
    .filter((position, index, all) => all.findIndex((candidate) => samePosition(candidate, position)) === index)
  const ownedTowers = aiObjectEntries(state.scenario, ownerId)
    .flatMap((entry) => entry.object.type === 'building' && entry.object.kind === 'tower'
      ? [{ ...entry, object: entry.object as BuildingObject }]
      : [])
  const towersNeedingGarrison = ownedTowers.filter((entry) => (
    (entry.object.garrison?.archers ?? 0) < aiTacticalConfig.tower.minimumPeacetimeArchers
  ))
  const threatTargets = [...threateningSquads.map((entry) => entry.position), ...rememberedThreats.map((entry) => entry.position)]
    .filter((position, index, all) => all.findIndex((candidate) => positionKey(candidate) === positionKey(position)) === index)
  const coreBreachTargets = ownCastle ? threateningSquads
    .filter((entry) => positionDistance(entry.position, ownCastle) <= aiTacticalConfig.defense.coreBreachRadius)
    .map((entry) => entry.position) : []
  const coreBreach = coreBreachTargets.length > 0
  if (coreBreach) threatTargets.sort((first, second) => (
    Number(!coreBreachTargets.some((position) => samePosition(position, first)))
      - Number(!coreBreachTargets.some((position) => samePosition(position, second)))
      || threatPriority(second, defensiveAssets) - threatPriority(first, defensiveAssets)
      || first.row - second.row || first.column - second.column
  ))
  // High-concentration doctrines must mass on the most dangerous incursion.
  // Round-robin assignment sent each squad after a different contact, so an
  // enemy already hitting the gate could be ignored while defenders chased a
  // weaker group near a peripheral asset.
  const activeDefenseTargets = Math.max(1, Math.round(
    threatTargets.length * (1 - profile.doctrine.concentrationBias),
  ))
  const responsePowerTarget = Math.min(
    squads.reduce((sum, squad) => sum + troopCompositionPower(squad.object.units, squadHealth(squad.object)), 0),
    Math.max(profile.doctrine.forceTargets.defense.minimum, threat.power * profile.riskThreshold),
  )
  const respondingSquadKeys = new Set<string>()
  let respondingPower = 0
  if (threat.threatened && threatTargets.length > 0) {
    const responders = [...squads].sort((first, second) => {
      const distance = (position: CellPosition) => Math.min(
        ...threatTargets.map((target) => positionDistance(position, target)),
      )
      return distance(first.position) - distance(second.position)
        || second.object.units.archers - first.object.units.archers
        || first.position.row - second.position.row || first.position.column - second.position.column
    })
    for (const responder of responders) {
      respondingSquadKeys.add(positionKey(responder.position))
      respondingPower += troopCompositionPower(responder.object.units, squadHealth(responder.object))
      // A proportional response is useful against probes at the frontier. An
      // enemy adjacent to the castle is already attacking the defeat
      // condition, so every field formation must break its previous mission
      // and join the relief instead of treating one large archer group as a
      // sufficient mathematical answer.
      if (!coreBreach && respondingPower >= responsePowerTarget) break
    }
  }
  const reachableStagingAnchor = (from: CellPosition) => stagingAnchors
    .flatMap((anchor) => {
      const path = findMovementPath(navigationMap, from, anchor, { ownerId })
      return path ? [{ anchor, length: path.length }] : []
    })
    .sort((first, second) => first.length - second.length
      || first.anchor.row - second.anchor.row || first.anchor.column - second.anchor.column)[0]?.anchor
  const targetDistanceFromFront = targetCastle && stagingAnchors.length > 0
    ? Math.min(...stagingAnchors.map((anchor) => positionDistance(anchor, targetCastle)))
    : Number.POSITIVE_INFINITY
  const isFielded = (position: CellPosition) => Boolean(
    participant && state.scenario.territories[position.row]?.[position.column] !== participant.regionId,
  ) || Boolean(
    targetCastle && Number.isFinite(targetDistanceFromFront)
      && positionDistance(position, targetCastle) < targetDistanceFromFront,
  )
  const assembledSupportPower = stagingAnchors.length > 0
    ? squads.reduce((sum, entry) => {
        const role = memory.squadRoles[positionKey(entry.position)] ?? 'assault'
        return role !== 'reserve' && stagingAnchors.some((anchor) => (
          positionDistance(entry.position, anchor) <= aiTacticalConfig.staging.assembledRadius
        ))
          ? sum + troopCompositionPower(entry.object.units, squadHealth(entry.object))
          : sum
      }, 0)
    : 0
  const preferredSupportAssemblyPower = memory.wave === 'probe'
    ? forceTargetFor(profile, 'probe', estimatedTargetPower(state, targetOwnerId, memory), profile.doctrine.probeRiskThreshold)
    : forceTargetFor(
        profile,
        'raid',
        estimatedTargetPower(state, targetOwnerId, memory),
        aiTacticalConfig.formation.supportAssemblyTargetRatioMinimum
          + (aiTacticalConfig.formation.supportAssemblyTargetRatioMaximum
            - aiTacticalConfig.formation.supportAssemblyTargetRatioMinimum) * profile.doctrine.musterBias,
      )
  const supportBand = memory.wave === 'probe'
    ? profile.doctrine.forceTargets.probe
    : profile.doctrine.forceTargets.raid
  const supportAssemblyPower = memory.idleTurns >= aiPlannerConfig.stalledMobilizationProbeTurns
    ? supportBand.minimum
    : preferredSupportAssemblyPower
  const supportReady = phase === 'assault' && assembledSupportPower >= supportAssemblyPower
  const assaultTowerThreats = phase === 'assault' ? towerThreatsFor(state, ownerId) : []
  for (const [squadIndex, squad] of squads.entries()) {
    if (!countNode()) break
    const role = memory.squadRoles[positionKey(squad.position)] ?? 'assault'
    const respondsToThreat = respondingSquadKeys.has(positionKey(squad.position))
    const rangedIndex = squads.slice(0, squadIndex).filter((entry) => (
      memory.squadRoles[positionKey(entry.position)] === 'ranged'
    )).length
    const guardIndex = squads.slice(0, squadIndex).filter((entry) => {
      const entryRole = memory.squadRoles[positionKey(entry.position)]
      return entryRole === 'reserve' || entryRole === 'ranged'
    }).length
    const towerNeedingGarrison = role === 'ranged' && towersNeedingGarrison.length > 0
      ? towersNeedingGarrison[rangedIndex % towersNeedingGarrison.length]?.position
      : undefined
    const guardAnchor = defensiveAnchors[guardIndex % Math.max(1, defensiveAnchors.length)] ?? homeAnchor
    const fielded = isFielded(squad.position)
    const waitingForSupport = phase === 'assault'
      && role !== 'reserve'
      && !fielded
      && !supportReady
      && memory.idleTurns < aiPlannerConfig.forcedAdvanceAfterIdleTurns
    const raidObjective = fielded || supportReady
      ? role === 'screen' ? undefined : raidObjectives[positionKey(squad.position)]
      : undefined
    if (healthShare(squad.object) <= profile.doctrine.retreatHealthShare && phase !== 'defense') {
      const retreat = retreatDestination(state, squad.position, ownerId, navigationMap)
      if (retreat && !isTemporarilyBlocked(memory, retreat, state.turn) && moveOrAttackFailure(state, squad.position, retreat) === null) {
        const command: AiCommand = { type: 'move-or-attack', from: squad.position, to: retreat }
        const evaluation = evaluateCommand(state, command, phase, targetOwnerId)
        if (evaluation) candidates.push({
          command,
          score: evaluation.score + aiTacticalConfig.movement.retreatUtility,
          factors: [...evaluation.factors, 'retreat'],
        })
      }
      continue
    }
    const nearestFrontLineThreat = [...frontLineThreats].sort((first, second) => (
      positionDistance(first.position, squad.position) - positionDistance(second.position, squad.position)
        || first.position.row - second.position.row || first.position.column - second.position.column
    ))[0]
    const alreadyRepositionedThisTurn = memory.recentMovements.some((entry) => (
      entry.turn === state.turn && samePosition(entry.to, squad.position)
    ))
    if (role === 'ranged' && nearestFrontLineThreat
      && positionDistance(squad.position, nearestFrontLineThreat.position)
        <= aiTacticalConfig.formation.rangedWithdrawalThreatDistance
      && !alreadyRepositionedThisTurn
      && !rangedSquadCanClearImmediateThreats(state, squad.position, frontLineThreats)
      && !rangedSquadHasScreen(squads, squad, nearestFrontLineThreat.position)) {
      const currentThreatDistance = Math.min(...frontLineThreats.map((entry) => (
        positionDistance(squad.position, entry.position)
      )))
      for (const destination of adjacentDestinations(squad.position)) {
        if (!countNode()) break
        const cell = state.scenario.cells[destination.row]?.[destination.column]
        if (!cell || cell.landform === 'peak' || cell.object
          || isTemporarilyBlocked(memory, destination, state.turn)) continue
        if (isPlannedFortification(memory, destination) && !isPlannedFortificationGate(memory, destination)) continue
        const sourceInsideDomain = participant
          && state.scenario.territories[squad.position.row]?.[squad.position.column] === participant.regionId
        const destinationInsideDomain = participant
          && state.scenario.territories[destination.row]?.[destination.column] === participant.regionId
        if (sourceInsideDomain && !destinationInsideDomain) continue
        const nextThreatDistance = Math.min(...frontLineThreats.map((entry) => (
          positionDistance(destination, entry.position)
        )))
        const distanceGain = nextThreatDistance - currentThreatDistance
        if (distanceGain <= 0 || moveOrAttackFailure(state, squad.position, destination) !== null) continue
        // Kiting remains valid in field combat, but never at the price of
        // walking away from the castle while an enemy is adjacent to it.
        if (coreBreach && ownCastle
          && positionDistance(destination, ownCastle) > positionDistance(squad.position, ownCastle)) continue
        const command: AiCommand = { type: 'move-or-attack', from: squad.position, to: destination }
        const evaluation = evaluateCommand(state, command, phase, targetOwnerId)
        if (!evaluation) continue
        candidates.push({
          command,
          score: evaluation.score + aiTacticalConfig.movement.rangedWithdrawalUtility
            + distanceGain * aiTacticalConfig.movement.rangedWithdrawalDistanceUtility,
          factors: [...evaluation.factors, 'ranged-withdrawal', `threat-distance:+${distanceGain}`],
        })
      }
    }
    const screenAnchor = role === 'screen'
      ? screenAnchorFor(state, squad, rangedSquads, frontLineThreats, navigationMap)
      : null
    let strategicTarget: CellPosition | null | undefined
    if (screenAnchor) strategicTarget = screenAnchor.position
    else if (phase === 'defense' && respondsToThreat) {
      strategicTarget = threatTargets[squadIndex % activeDefenseTargets] ?? homeAnchor
    } else if (role === 'ranged' && towerNeedingGarrison) strategicTarget = towerNeedingGarrison
    else if (phase === 'defense') strategicTarget = guardAnchor
    else if (phase === 'mobilization') {
      strategicTarget = role === 'reserve' ? guardAnchor : reachableStagingAnchor(squad.position) ?? homeAnchor
    } else if (phase === 'regroup') {
      strategicTarget = role === 'reserve' || role === 'ranged' ? guardAnchor : homeAnchor
    } else if (phase === 'assault') {
      // If the chosen target's castle is gone (or no target is selected), avoid
      // tactical paralysis: fall back to the nearest hostile asset so an idle
      // assault force still advances on something instead of skipping its turn.
      const assaultFallback = targetCastle ?? nearestHostileAsset(state, squad.position, ownerId)
      strategicTarget = role === 'reserve'
        ? guardAnchor
        : waitingForSupport ? reachableStagingAnchor(squad.position) ?? homeAnchor : raidObjective?.origin ?? assaultFallback
    } else strategicTarget = role === 'reserve' ? guardAnchor : homeAnchor
    if (!strategicTarget) continue
    if (!towerNeedingGarrison
      && (phase === 'survival' || phase === 'expansion' || phase === 'recovery' || phase === 'regroup')
      && positionDistance(squad.position, strategicTarget) <= aiTacticalConfig.route.peacefulHoldRadius) continue
    if (!towerNeedingGarrison && phase === 'mobilization'
      && positionDistance(squad.position, strategicTarget) <= aiTacticalConfig.route.mobilizationHoldRadius) continue
    if (phase === 'assault' && role === 'reserve'
      && positionDistance(squad.position, strategicTarget) <= aiTacticalConfig.route.reserveHoldRadius) continue
    if (waitingForSupport
      && positionDistance(squad.position, strategicTarget) <= aiTacticalConfig.route.mobilizationHoldRadius) continue
    const addDestinations = (destinations: CellPosition[], movementTarget: CellPosition) => {
      for (const destination of destinations) {
        if (!countNode()) break
        let path: CellPosition[] | null
        if (screenAnchor) {
          path = findMovementPath(navigationMap, squad.position, destination, {
            ownerId,
            cellCost: (position, cell) => squadMovementOrderCost(squad.object, cell)
              + Math.max(0, positionDistance(position, screenAnchor.rangedPosition)
                - aiTacticalConfig.formation.screenRadius) * aiTacticalConfig.movement.screenUtility,
          })
        } else if (raidObjective) {
          path = findMovementPath(navigationMap, squad.position, destination, {
            ownerId,
            cellCost: (_position, cell) => squadMovementOrderCost(squad.object, cell),
          })
        } else if (phase === 'assault' && targetOwnerId && !waitingForSupport) {
          path = assaultPathWithThreats(
            state, navigationMap, squad.object, squad.position, destination, targetOwnerId, assaultTowerThreats,
          )
        } else if (phase === 'defense' && respondsToThreat) {
          const directPath = findMovementPath(navigationMap, squad.position, destination, { ownerId })
          const directContact = directPath
            ? projectedDefensiveContact(state, profile, squad, directPath, movementTarget, countNode)
            : null
          const emergencyContact = Boolean(coreBreach && directContact?.survivesExchange
            && directContact.attackerPowerBefore >= directContact.targetPowerBefore
              * aiTacticalConfig.defense.coreBreachMinimumContactPowerRatio)
          path = directContact?.viable || emergencyContact
            ? directPath
            : findMovementPath(navigationMap, squad.position, destination, {
                ownerId,
                cellCost: (position, cell) => squadMovementOrderCost(squad.object, cell)
                  + hostileArcherExposureAt(state, position, squad.position, squad.object, archerThreats)
                    * aiTacticalConfig.defense.rangedExposureRoutePenalty,
              })
        } else path = findMovementPath(navigationMap, squad.position, destination, { ownerId })
        if (!path || path.length < 2) continue
        const to = path[1]
        if (isTemporarilyBlocked(memory, to, state.turn)) continue
        if (!coreBreach && !objectAt(state, to)
          && revisitsRecentFormationTrail(memory, squad.position, to, state.turn)) continue
        // Do not park a squad on the next wall/tower/outpost cell. Occupying a
        // reserved site made an otherwise funded castle step fail placement on
        // every threatened turn; a squad already standing there may still move
        // away because this restriction applies only to its destination.
        if (!coreBreach && isPlannedFortification(memory, to) && !isPlannedFortificationGate(memory, to)
          && !state.scenario.cells[to.row]?.[to.column]?.object) continue
        const outsideDomain = participant && state.scenario.territories[to.row]?.[to.column] !== participant.regionId
        const sourceOutsideDomain = participant
          && state.scenario.territories[squad.position.row]?.[squad.position.column] !== participant.regionId
        const exteriorBorderCell = participant && outsideDomain && clockwiseCardinalDirections.some((direction) => (
          state.scenario.territories[to.row + direction.row]?.[to.column + direction.column] === participant.regionId
        ))
        const returningHome = phase === 'defense' && sourceOutsideDomain && ownCastle
          && positionDistance(to, ownCastle) < positionDistance(squad.position, ownCastle)
        const borderInterception = phase === 'defense' && exteriorBorderCell
          && positionDistance(to, strategicTarget) < positionDistance(squad.position, strategicTarget)
        const allowedCrossing = (phase === 'assault' && state.turn >= profile.earliestOffensiveRound)
          || (phase === 'defense' && Boolean(returningHome || borderInterception))
        if (outsideDomain && !allowedCrossing) continue
        if (moveOrAttackFailure(state, squad.position, to) !== null) continue
        const command: AiCommand = { type: 'move-or-attack', from: squad.position, to }
        const evaluation = evaluateCommand(state, command, phase, targetOwnerId)
        if (!evaluation) continue
        const projectedContact = phase === 'defense' && respondsToThreat
          ? projectedDefensiveContact(state, profile, squad, path, movementTarget, countNode)
          : null
        const emergencyContact = Boolean(coreBreach && projectedContact?.survivesExchange
          && projectedContact.attackerPowerBefore >= projectedContact.targetPowerBefore
            * aiTacticalConfig.defense.coreBreachMinimumContactPowerRatio)
        const commitsToContact = Boolean(projectedContact?.viable || emergencyContact)
        const replyPowerLoss = phase === 'defense' && respondsToThreat && !commitsToContact && !coreBreach
          ? immediateReplyPowerLossForSquad(evaluation.state, ownerId, to, hostileSquads, countNode)
          : 0
        const movedSquad = objectAt(evaluation.state, to)
        const movedPower = movedSquad?.type === 'squad' && movedSquad.ownerId === ownerId
          ? troopCompositionPower(movedSquad.units, squadHealth(movedSquad))
          : 0
        const certainDestruction = replyPowerLoss > 0 && replyPowerLoss >= movedPower - 0.0001
        const exposurePenalty = replyPowerLoss * aiTacticalConfig.evaluation.replyPowerLoss
          + (certainDestruction ? aiTacticalConfig.defense.certainDestructionPenalty : 0)
        const contactBonus = commitsToContact
          ? aiTacticalConfig.defense.contactCommitmentUtility
            + Math.max(0, projectedContact?.exchange ?? 0) * aiTacticalConfig.defense.contactExchangeUtility
          : 0
        const situational = routeScore(
          state, profile, squads, squad, path, role, memory, phase, assaultTowerThreats, archerThreats,
        )
        const defenseBonus = role === 'defender' && phase === 'defense'
          ? aiTacticalConfig.movement.defenderUtility
          : 0
        const objectiveProgress = positionDistance(squad.position, movementTarget) - positionDistance(to, movementTarget)
        const interceptionBonus = phase === 'defense'
          ? objectiveProgress * aiTacticalConfig.movement.defenseProgressUtility
          : phase === 'mobilization'
            ? objectiveProgress * aiTacticalConfig.movement.mobilizationProgressUtility
            : phase === 'regroup'
              ? objectiveProgress * aiTacticalConfig.movement.regroupProgressUtility
              : phase === 'survival' || phase === 'expansion'
                ? objectiveProgress * aiTacticalConfig.movement.peacefulProgressUtility
                : 0
        const raidBonus = raidObjective
          ? aiTacticalConfig.raid.objectiveBaseUtility
            + objectiveProgress * aiTacticalConfig.raid.objectiveProgressUtility
            + Math.min(
              aiTacticalConfig.raid.objectiveScoreUtilityCap,
              raidObjective.score * aiTacticalConfig.raid.objectiveScoreUtilityScale,
            )
          : 0
        const screenProgress = screenAnchor
          ? Math.max(0, objectiveProgress)
          : 0
        const screenBonus = screenAnchor && screenProgress > 0
          ? aiTacticalConfig.movement.screenUtility
            + screenProgress * aiTacticalConfig.movement.screenProgressUtility
          : 0
        candidates.push({
          command,
          score: evaluation.score + situational + defenseBonus + interceptionBonus + raidBonus + screenBonus
            + contactBonus - exposurePenalty,
          factors: [
            ...evaluation.factors,
            `role:${role}`,
            `route:${situational.toFixed(1)}`,
            `intercept:${interceptionBonus.toFixed(1)}`,
            ...(respondsToThreat ? ['defense-response'] : []),
            ...(respondsToThreat && coreBreach ? ['core-breach-response'] : []),
            ...(commitsToContact ? ['committed-defense-contact'] : []),
            ...(replyPowerLoss > 0 ? [`projected-reply-loss:${replyPowerLoss.toFixed(1)}`] : []),
            ...(certainDestruction ? ['certain-destruction'] : []),
            ...(waitingForSupport ? ['support-muster'] : []),
            ...(screenBonus > 0 ? ['screen-ranged', `screen-progress:${screenProgress}`] : []),
            ...(raidObjective ? [...raidObjective.factors, `raid-pursuit:${raidBonus.toFixed(1)}`] : []),
          ],
        })
      }
    }
    addDestinations(screenAnchor
      ? [screenAnchor.position]
      : raidObjective
      ? [raidObjective.approach]
      : phase === 'defense' && threatTargets.length > 0
      ? adjacentDestinations(strategicTarget)
      : phase === 'assault' && role !== 'reserve' && !waitingForSupport
        ? [...approachDestinations(state, strategicTarget, role, navigationMap), strategicTarget]
        : musterDestinations(state, strategicTarget), strategicTarget)
  }
  return candidates
}
