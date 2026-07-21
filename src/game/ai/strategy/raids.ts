import { aiTacticalConfig } from '../../../config/ai'
import { buildingRules, troopKinds, troopRules } from '../../../config/rules'
import type {
  BuildingKind,
  GameMap,
  SquadObject,
} from '../../map'
import {
  buildingFootprintPositions,
  squadHealth,
  squadSize,
  type MatchState,
} from '../../match'
import { clockwiseCardinalDirections } from '../../geometry'
import {
  squadMovementOrderCost,
} from '../../movement'
import { findMovementPath } from '../../pathfinding'
import { areOwnersHostile, type CellPosition } from '../../scenario'
import {
  aiObjectEntries,
  castlePositionFor,
  positionDistance,
  positionKey,
} from '../analysis'
import type {
  AiMemory,
  AiProfileRules,
  AiSquadRole,
  AiStrategicPhase,
} from '../model'
import { estimatedTargetPower, troopCompositionPower } from './assessment'
import { forceTargetFor } from './shared'

export interface RaidObjective {
  origin: CellPosition
  targetCells: CellPosition[]
  approach: CellPosition
  score: number
  factors: string[]
}

interface SquadEntry {
  position: CellPosition
  object: SquadObject
}

function meleeDamageFor(squad: SquadObject) {
  return troopKinds.reduce((sum, troop) => (
    sum + squad.units[troop] * troopRules[troop].damage
  ), 0)
}

function pathOrderCost(map: GameMap, squad: SquadObject, path: CellPosition[]) {
  return path.slice(1).reduce((sum, position) => {
    const cell = map[position.row]?.[position.column]
    return sum + (cell ? squadMovementOrderCost(squad, cell) : 0)
  }, 0)
}

function borderDistanceFor(state: MatchState, position: CellPosition, regionId: string) {
  const maximum = aiTacticalConfig.raid.borderScanRadius
  for (let radius = 1; radius <= maximum; radius += 1) {
    for (let rowOffset = -radius; rowOffset <= radius; rowOffset += 1) {
      const columnOffset = radius - Math.abs(rowOffset)
      const columns = columnOffset === 0
        ? [position.column]
        : [position.column - columnOffset, position.column + columnOffset]
      if (columns.some((column) => {
        const row = position.row + rowOffset
        const territory = state.scenario.territories[row]?.[column]
        return territory !== undefined && territory !== regionId
      })) return radius
    }
  }
  return maximum + 1
}

function targetApproaches(
  state: MatchState,
  kind: BuildingKind,
  origin: CellPosition,
  squadPosition: CellPosition,
) {
  const footprint = buildingFootprintPositions(kind, origin)
  const seen = new Set<string>()
  return footprint.flatMap((position) => clockwiseCardinalDirections.map((direction) => ({
    column: position.column + direction.column,
    row: position.row + direction.row,
  }))).filter((position) => {
    const key = positionKey(position)
    if (seen.has(key)) return false
    seen.add(key)
    const cell = state.scenario.cells[position.row]?.[position.column]
    return Boolean(cell && cell.landform !== 'peak'
      && (!cell.object || positionKey(position) === positionKey(squadPosition)))
  }).sort((first, second) => first.row - second.row || first.column - second.column)
}

function localThreatFor(
  state: MatchState,
  ownerId: string,
  target: CellPosition,
) {
  const radius = aiTacticalConfig.raid.localThreatRadius
  return aiObjectEntries(state.scenario).reduce((sum, entry) => {
    if (!areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId)) return sum
    const distance = positionDistance(entry.position, target)
    if (distance > radius) return sum
    const proximity = Math.max(0, 1 - distance / (radius + 1))
    if (entry.object.type === 'squad') {
      return sum + troopCompositionPower(entry.object.units, squadHealth(entry.object)) * proximity
    }
    if (entry.object.type === 'building' && entry.object.kind === 'tower') {
      const knownGarrisonPower = entry.object.garrison
        ? troopCompositionPower({
            militia: 0,
            spearmen: 0,
            archers: entry.object.garrison.archers,
            knights: 0,
          }, entry.object.garrison.health)
        : aiTacticalConfig.raid.towerThreatPower
      return sum + knownGarrisonPower * proximity
    }
    return sum
  }, 0)
}

function responseDistanceFor(
  state: MatchState,
  targetOwnerId: string,
  target: CellPosition,
) {
  const castle = castlePositionFor(state.scenario, targetOwnerId)
  const distances = aiObjectEntries(state.scenario, targetOwnerId).flatMap((entry) => (
    entry.object.type === 'squad' ? [positionDistance(entry.position, target)] : []
  ))
  if (castle) distances.push(positionDistance(castle, target))
  return distances.length > 0 ? Math.min(...distances) : Number.POSITIVE_INFINITY
}

function waveMultiplierFor(memory: AiMemory) {
  if (memory.wave === 'probe') return aiTacticalConfig.raid.probeMultiplier
  if (memory.wave === 'support') return aiTacticalConfig.raid.supportMultiplier
  if (memory.wave === 'main') return aiTacticalConfig.raid.mainMultiplier
  return 0
}

function bestRaidObjectiveFor(
  state: MatchState,
  navigationMap: GameMap,
  profile: AiProfileRules,
  memory: AiMemory,
  squad: SquadEntry,
  role: AiSquadRole,
  targetOwnerId: string,
  countNode: () => boolean,
) {
  const participant = state.scenario.participants.find(({ id }) => id === targetOwnerId)
  const targetCastle = castlePositionFor(state.scenario, targetOwnerId)
  if (!participant || !targetCastle) return null
  const ownPower = troopCompositionPower(squad.object.units, squadHealth(squad.object))
  if (ownPower < aiTacticalConfig.raid.minimumGroupPower) return null

  const targetCandidates = aiObjectEntries(state.scenario, targetOwnerId)
    .flatMap((entry) => {
      if (entry.object.type !== 'building') return []
      const value = aiTacticalConfig.raid.targetValues[entry.object.kind]
      if (!value) return []
      const distance = positionDistance(squad.position, entry.position)
      const isolation = positionDistance(entry.position, targetCastle)
      return [{ ...entry, object: entry.object, value, preliminary: value + isolation - distance }]
    })
    .sort((first, second) => second.preliminary - first.preliminary
      || first.position.row - second.position.row
      || first.position.column - second.position.column)
    .slice(0, aiTacticalConfig.raid.maximumTargets)

  let best: RaidObjective | null = null
  for (const target of targetCandidates) {
    if (!countNode()) break
    const approaches = targetApproaches(
      state,
      target.object.kind,
      target.position,
      squad.position,
    )
    const routes = approaches.flatMap((approach) => {
      if (!countNode()) return []
      const path = findMovementPath(navigationMap, squad.position, approach, {
        ownerId: squad.object.ownerId,
        cellCost: (_position, cell) => squadMovementOrderCost(squad.object, cell),
      })
      return path ? [{ approach, path, orders: pathOrderCost(navigationMap, squad.object, path) }] : []
    }).sort((first, second) => first.orders - second.orders
      || first.path.length - second.path.length
      || first.approach.row - second.approach.row
      || first.approach.column - second.approach.column)
    const route = routes[0]
    if (!route) continue

    const damageMultiplier = buildingRules[target.object.kind].incomingDamageMultiplier ?? 1
    const effectiveDamage = Math.max(1, meleeDamageFor(squad.object) * damageMultiplier)
    const attackOrders = Math.ceil(target.object.hitPoints / effectiveDamage)
    const borderDistance = borderDistanceFor(state, target.position, participant.regionId)
    const borderExposure = Math.max(0, aiTacticalConfig.raid.borderScanRadius - borderDistance)
    const isolation = positionDistance(target.position, targetCastle)
    const localThreat = localThreatFor(state, squad.object.ownerId, target.position)
    const responseDistance = responseDistanceFor(state, targetOwnerId, target.position)
    const exposureOrders = route.orders + attackOrders
    const responsePressure = Number.isFinite(responseDistance)
      ? Math.max(0, exposureOrders + aiTacticalConfig.raid.responseMargin - responseDistance)
      : 0
    const strategicValue = (
      target.value
      + isolation * aiTacticalConfig.raid.castleIsolationBonus
      + borderExposure * aiTacticalConfig.raid.borderExposureBonus
    ) * profile.doctrine.raidBias
      * (role === 'scout' ? aiTacticalConfig.raid.scoutMultiplier : 1)
      * waveMultiplierFor(memory)
    const score = strategicValue
      - route.orders * aiTacticalConfig.raid.pathOrderPenalty
      - attackOrders * aiTacticalConfig.raid.breachOrderPenalty
      - (localThreat / Math.max(1, ownPower)) * aiTacticalConfig.raid.localThreatPenalty
      - responsePressure * aiTacticalConfig.raid.responsePenalty
    if (score < aiTacticalConfig.raid.minimumObjectiveScore) continue
    const objective: RaidObjective = {
      origin: target.position,
      targetCells: buildingFootprintPositions(target.object.kind, target.position),
      approach: route.approach,
      score,
      factors: [
        `raid:${target.object.kind}`,
        `raid-value:${strategicValue.toFixed(1)}`,
        `raid-exposure:${exposureOrders.toFixed(1)}`,
        `raid-response:${responsePressure.toFixed(1)}`,
      ],
    }
    if (!best || objective.score > best.score
      || (objective.score === best.score
        && (objective.origin.row < best.origin.row
          || (objective.origin.row === best.origin.row && objective.origin.column < best.origin.column)))) {
      best = objective
    }
  }
  return best
}

export function raidObjectivesFor(
  state: MatchState,
  navigationMap: GameMap,
  profile: AiProfileRules,
  memory: AiMemory,
  phase: AiStrategicPhase,
  countNode: () => boolean,
) {
  const result: Record<string, RaidObjective> = {}
  const targetOwnerId = memory.targetOwnerId
  const waveMultiplier = waveMultiplierFor(memory)
  if (phase !== 'assault' || !targetOwnerId || waveMultiplier <= 0) return result

  const squads = aiObjectEntries(state.scenario, state.activeParticipantId)
    .flatMap((entry) => entry.object.type === 'squad'
      ? [{ position: entry.position, object: entry.object }]
      : [])
    .sort((first, second) => squadSize(first.object) - squadSize(second.object)
      || first.position.row - second.position.row
      || first.position.column - second.position.column)
  const totalPower = squads.reduce((sum, squad) => (
    sum + troopCompositionPower(squad.object.units, squadHealth(squad.object))
  ), 0)
  const raidBand = profile.doctrine.forceTargets.raid
  const probeBand = profile.doctrine.forceTargets.probe
  const raidPreferredPower = forceTargetFor(
    profile,
    'raid',
    estimatedTargetPower(state, targetOwnerId, memory),
    profile.doctrine.raidForceShare,
  )
  const scouts = squads.filter((squad) => memory.squadRoles[positionKey(squad.position)] === 'scout')
  const candidates = scouts.length > 0
    ? scouts.filter((squad) => {
        const power = troopCompositionPower(squad.object.units, squadHealth(squad.object))
        return power >= probeBand.minimum && power <= probeBand.maximum
      })
    : memory.wave === 'probe'
      ? squads.filter((squad) => {
          const power = troopCompositionPower(squad.object.units, squadHealth(squad.object))
          return power >= probeBand.minimum && power <= probeBand.maximum
        }).slice(0, 1)
      : profile.doctrine.raidBias >= aiTacticalConfig.raid.mainWaveMinimumBias && squads.length > 1
        ? squads.filter((squad) => {
            const role = memory.squadRoles[positionKey(squad.position)] ?? 'assault'
            const power = troopCompositionPower(squad.object.units, squadHealth(squad.object))
            return role !== 'reserve' && role !== 'ranged'
              && power >= raidBand.minimum && power <= raidBand.maximum
              && power <= Math.max(raidPreferredPower, totalPower * profile.doctrine.raidForceShare)
          }).sort((first, second) => {
            const firstPower = troopCompositionPower(first.object.units, squadHealth(first.object))
            const secondPower = troopCompositionPower(second.object.units, squadHealth(second.object))
            return Math.abs(firstPower - raidPreferredPower) - Math.abs(secondPower - raidPreferredPower)
          }).slice(0, 1)
        : []

  for (const squad of candidates) {
    if (!countNode()) break
    const role = memory.squadRoles[positionKey(squad.position)] ?? 'assault'
    const objective = bestRaidObjectiveFor(
      state,
      navigationMap,
      profile,
      memory,
      squad,
      role,
      targetOwnerId,
      countNode,
    )
    if (objective) result[positionKey(squad.position)] = objective
  }
  return result
}
