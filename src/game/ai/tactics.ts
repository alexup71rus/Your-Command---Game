import { gameConfig } from '../../config/game'
import { aiPlannerConfig, aiTacticalConfig } from '../../config/ai'
import { buildingRules, combatRules, troopKinds, troopRules } from '../../config/rules'
import type { BuildingKind, BuildingObject, GameMap, MapObject, SquadObject, TroopComposition, TroopKind } from '../map'
import {
  buildingFootprintPositions,
  isRangedAttack,
  moveOrAttackFailure,
  objectAt,
  squadHealth,
  squadSize,
  splitFailure,
  towerAttackFailure,
  totalArmySize,
  ungarrisonFailure,
  type MatchState,
} from '../match'
import { findMovementPath } from '../pathfinding'
import { squadMovementOrderCost } from '../movement'
import { clockwiseCardinalDirections } from '../geometry'
import { areOwnersHostile, type CellPosition } from '../scenario'
import { aiObjectEntries, castlePositionFor, positionDistance, positionKey, samePosition } from './analysis'
import { executeAiCommand } from './commands'
import { armyPowerFor, estimatedTargetPower, fortificationReadyFor, homeThreatFor, stagingAnchorsFor, troopCompositionPower } from './strategy'
import { raidObjectivesFor, type RaidObjective } from './strategy/raids'
import { forceTargetFor, isPlannedFortification } from './strategy/shared'
import type { AiCommand, AiMemory, AiProfileRules, AiSquadRole, AiStrategicPhase, AiWaveKind } from './model'

export interface TacticalCandidate {
  command: AiCommand
  score: number
  factors: string[]
}

export interface TacticalSelectionOptions {
  phase: AiStrategicPhase
  idleTurns: number
  previousCommands: readonly AiCommand[]
  traversedEdges: ReadonlySet<string>
  commandAllowed?: (command: AiCommand) => boolean
}

export const tacticalMovementEdgeKey = (from: CellPosition, to: CellPosition) => (
  `${from.column}:${from.row}>${to.column}:${to.row}`
)

/** Keeps tactical execution and focused scenario tests on the same selection policy. */
export function selectTacticalCandidate(
  candidates: readonly TacticalCandidate[],
  options: TacticalSelectionOptions,
) {
  const eligible = candidates.filter((candidate) => {
    if (options.commandAllowed && !options.commandAllowed(candidate.command)) return false
    const repeatsCommand = options.previousCommands.some((command) => JSON.stringify(command) === JSON.stringify(candidate.command))
    // A repeated move is usually an oscillation, but a repeated attack is how a
    // formation actually completes a breach or finishes a surviving squad.
    // Candidate factors come from authoritative speculative execution, so a
    // fresh positive damage result is safe to repeat while the target changes.
    if (repeatsCommand && !candidate.factors.some((factor) => factor.startsWith('damage:'))) return false
    if (candidate.command.type !== 'move-or-attack') return true
    return !options.traversedEdges.has(tacticalMovementEdgeKey(candidate.command.to, candidate.command.from))
  })
  return eligible.find((candidate) => candidate.score > 0)
    ?? (options.phase === 'assault' && options.idleTurns >= aiPlannerConfig.forcedAdvanceAfterIdleTurns
      ? eligible.find((candidate) => (
          candidate.command.type === 'move-or-attack'
          && candidate.score > aiPlannerConfig.forcedAdvanceMinimumScore
        ))
      : undefined)
}

const isTemporarilyBlocked = (memory: AiMemory, position: CellPosition, turn: number) => memory.blockedCells.some((entry) => (
  entry.expiresTurn >= turn && positionKey(entry.position) === positionKey(position)
))

const squadEntries = (state: MatchState, ownerId: string) => aiObjectEntries(state.scenario, ownerId)
  .flatMap((entry) => entry.object.type === 'squad' ? [{ ...entry, object: entry.object }] : [])

function maximumHealth(squad: SquadObject) {
  return (Object.keys(squad.units) as TroopKind[])
    .reduce((sum, troop) => sum + squad.units[troop] * troopRules[troop].durability, 0)
}

function healthShare(squad: SquadObject) {
  const maximum = maximumHealth(squad)
  return maximum > 0 ? squadHealth(squad) / maximum : 0
}

function enemyPriority(object: MapObject) {
  const priority = aiTacticalConfig.targetPriority
  if (object.type === 'squad') return priority.squadBase + squadSize(object) * priority.squadPerUnit
  if (object.type === 'castle') return priority.castleBase + (object.maxHitPoints - object.hitPoints) * priority.damagedCastle
  if (object.kind === 'tower') return priority.towerBase + (object.garrison?.archers ?? 0) * priority.towerPerGarrisonArcher
  if (object.kind === 'barbican') return priority.barbican
  if (object.kind === 'wall') return priority.wall
  if (object.kind === 'barracks') return priority.barracks
  if (object.kind === 'market' || object.kind === 'smelter' || object.kind === 'mine') return priority.strategicIndustry
  return priority.otherBuilding
}

const objectHealth = (object: MapObject) => object.type === 'squad' ? squadHealth(object) : object.hitPoints

function commandTarget(command: AiCommand) {
  if (command.type === 'move-or-attack') return command.to
  if (command.type === 'tower-attack') return command.to
  if (command.type === 'garrison') return command.tower
  if (command.type === 'ungarrison') return command.to
  if (command.type === 'split') return command.to
  return null
}

function evaluateCommand(before: MatchState, command: AiCommand, phase: AiStrategicPhase, targetOwnerId: string | null) {
  const result = executeAiCommand(before, command)
  if (!result.ok) return null
  const ownerId = before.activeParticipantId
  const target = commandTarget(command)
  const targetBefore = target ? objectAt(before, target) : null
  const targetAfter = target ? objectAt(result.state, target) : null
  const ownPowerChange = armyPowerFor(result.state, ownerId) - armyPowerFor(before, ownerId)
  const scoring = aiTacticalConfig.evaluation
  let score = ownPowerChange * scoring.ownPowerChange
  const factors: string[] = []
  if (targetBefore && targetBefore.ownerId !== ownerId) {
    const damage = Math.max(0, objectHealth(targetBefore) - (targetAfter?.ownerId === targetBefore.ownerId ? objectHealth(targetAfter) : 0))
    score += damage * scoring.damage + enemyPriority(targetBefore)
    factors.push(`damage:${damage.toFixed(2)}`)
    if (!targetAfter || targetAfter.ownerId !== targetBefore.ownerId) {
      score += enemyPriority(targetBefore) * scoring.destructionPriority
      factors.push('destroy')
    }
  }
  if (command.type === 'move-or-attack') {
    const squad = objectAt(before, command.from)
    const destination = result.state.scenario.cells[command.to.row]?.[command.to.column]
    if (squad?.type === 'squad' && destination) {
      if (destination.landform === 'hill') { score += scoring.hill; factors.push('height') }
      if (destination.vegetation && squad.units.knights === 0) { score += scoring.forestCover; factors.push('forest-cover') }
      if (destination.vegetation && squad.units.knights > 0) score += scoring.knightForest
      const targetCastle = targetOwnerId ? castlePositionFor(result.state.scenario, targetOwnerId) : null
      if (targetCastle) {
        const progress = positionDistance(command.from, targetCastle) - positionDistance(command.to, targetCastle)
        score += progress * (phase === 'assault' ? scoring.assaultProgress : scoring.ordinaryProgress)
        if (progress > 0) factors.push('advance')
      }
    }
  }
  if (phase === 'defense' && target) {
    const castle = castlePositionFor(before.scenario, ownerId)
    if (castle) score += Math.max(0, scoring.defenseRadius - positionDistance(target, castle)) * scoring.defenseProximity
  }
  if (command.type === 'tower-attack') score += scoring.towerAttack
  if (command.type === 'garrison') score += phase === 'defense' ? scoring.defenseGarrison : scoring.ordinaryGarrison
  return { state: result.state, score, factors }
}

type MoveCommand = Extract<AiCommand, { type: 'move-or-attack' }>

function possibleEnemyReplies(state: MatchState, ownerId: string, countNode: () => boolean) {
  const replies: MoveCommand[] = []
  const ownObjects = aiObjectEntries(state.scenario, ownerId)
  const enemies = aiObjectEntries(state.scenario)
    .flatMap((entry) => entry.object.type === 'squad'
      && areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId)
      ? [{ ...entry, object: entry.object }] : [])
  for (const enemy of enemies) {
    const responseState = { ...state, activeParticipantId: enemy.object.ownerId, ordersRemaining: gameConfig.turn.maxOrders }
    for (const target of ownObjects) {
      if (!countNode()) return replies
      // A hostile squad can reply either by closing into melee or by shooting
      // from range. Both are modelled as `move-or-attack`; ranged fire is only
      // chosen when the target sits on a clear orthogonal line within archer
      // range, which `isRangedAttack` checks against the enemy's perspective.
      if (moveOrAttackFailure(responseState, enemy.position, target.position) === null
        || isRangedAttack(responseState, enemy.position, target.position)) {
        replies.push({ type: 'move-or-attack', from: enemy.position, to: target.position })
      }
    }
  }
  return replies
}

function worstReplyPenalty(state: MatchState, ownerId: string, countNode: () => boolean) {
  let penalty = 0
  const beforePower = armyPowerFor(state, ownerId)
  for (const reply of possibleEnemyReplies(state, ownerId, countNode)) {
    const result = executeAiCommand({
      ...state,
      activeParticipantId: objectAt(state, reply.from)?.ownerId ?? state.activeParticipantId,
      ordersRemaining: gameConfig.turn.maxOrders,
    }, reply)
    if (!result.ok) continue
    penalty = Math.max(penalty, Math.max(0, beforePower - armyPowerFor(result.state, ownerId)) * aiTacticalConfig.evaluation.replyPowerLoss)
  }
  return penalty
}

function baseMeleeDamage(squad: SquadObject) {
  return troopKinds.reduce((sum, troop) => sum + squad.units[troop] * troopRules[troop].damage, 0)
}

function towerHasLineOfFire(map: GameMap, tower: CellPosition, target: CellPosition) {
  const columnDistance = Math.abs(target.column - tower.column)
  const rowDistance = Math.abs(target.row - tower.row)
  const distance = columnDistance + rowDistance
  const range = buildingRules.tower.garrison?.attackRange ?? 0
  if ((columnDistance !== 0 && rowDistance !== 0) || distance < 1 || distance > range) return false
  const columnStep = Math.sign(target.column - tower.column)
  const rowStep = Math.sign(target.row - tower.row)
  for (let step = 1; step < distance; step += 1) {
    const cell = map[tower.row + rowStep * step]?.[tower.column + columnStep * step]
    if (!cell || cell.landform === 'peak' || cell.vegetation || cell.object) return false
  }
  return true
}

interface TowerThreat {
  position: CellPosition
  archers: number
}

function towerThreatsFor(state: MatchState, ownerId: string): TowerThreat[] {
  return aiObjectEntries(state.scenario).flatMap((entry) => (
    areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId) && entry.object.type === 'building'
      && entry.object.kind === 'tower' && entry.object.garrison?.archers
      ? [{ position: entry.position, archers: entry.object.garrison.archers }]
      : []
  ))
}

function towerExposureAt(state: MatchState, position: CellPosition, threats: TowerThreat[]) {
  const cover = state.scenario.cells[position.row]?.[position.column]?.vegetation
    ? combatRules.ranged.forestCoverMultiplier
    : 1
  return threats.reduce((sum, tower) => {
    if (samePosition(tower.position, position)
      || !towerHasLineOfFire(state.scenario.cells, tower.position, position)) return sum
    return sum + tower.archers
      * aiTacticalConfig.siege.towerExposureOrderCostPerArcher * cover
  }, 0)
}

function towerExposureAlong(state: MatchState, path: CellPosition[], threats: TowerThreat[]) {
  return path.slice(1, aiTacticalConfig.siege.towerExposureLookahead + 1)
    .reduce((sum, position) => sum + towerExposureAt(state, position, threats), 0)
}

function assaultCellCost(
  state: MatchState,
  squad: SquadObject,
  targetOwnerId: string | null,
  towerThreats: TowerThreat[],
) {
  return (position: CellPosition) => {
    const cell = state.scenario.cells[position.row]?.[position.column]
    if (!cell) return Number.POSITIVE_INFINITY
    const terrainCost = squadMovementOrderCost(squad, cell)
    const object = cell.object
    const exposureCost = towerExposureAt(state, position, towerThreats)
    if (!targetOwnerId || !object || object.ownerId !== targetOwnerId
      || (object.type !== 'building' && object.type !== 'castle')) return terrainCost + exposureCost
    const incomingDamageMultiplier = object.type === 'building'
      ? buildingRules[object.kind].incomingDamageMultiplier ?? 1
      : 1
    const effectiveDamage = Math.max(1, baseMeleeDamage(squad) * incomingDamageMultiplier)
    const breachOrders = Math.ceil(object.hitPoints / effectiveDamage)
    return terrainCost + exposureCost + breachOrders * aiTacticalConfig.siege.breachOrderWeight
  }
}

/**
 * Finds one route that can either go around enemy fortifications or breach
 * them. The same weighted search compares forest movement with the estimated
 * number of attacks needed to open a structure, so the AI does not blindly
 * prefer either a long detour or the nearest wall.
 */
function assaultPathWithThreats(
  state: MatchState,
  navigationMap: GameMap,
  squad: SquadObject,
  from: CellPosition,
  to: CellPosition,
  targetOwnerId: string | null,
  towerThreats: TowerThreat[],
) {
  const cellCost = assaultCellCost(state, squad, targetOwnerId, towerThreats)
  return findMovementPath(navigationMap, from, to, {
    ownerId: squad.ownerId,
    canEnterOccupiedCell: (position) => {
      const object = navigationMap[position.row]?.[position.column]?.object
      return Boolean(targetOwnerId && object?.ownerId === targetOwnerId
        && (object.type === 'building' || (object.type === 'castle' && samePosition(position, to))))
    },
    cellCost: (position) => cellCost(position),
  })
}

export function assaultPathFor(
  state: MatchState,
  navigationMap: GameMap,
  squad: SquadObject,
  from: CellPosition,
  to: CellPosition,
  targetOwnerId: string | null,
) {
  return assaultPathWithThreats(
    state,
    navigationMap,
    squad,
    from,
    to,
    targetOwnerId,
    towerThreatsFor(state, squad.ownerId),
  )
}

function assaultPathCost(
  state: MatchState,
  squad: SquadObject,
  path: CellPosition[],
  targetOwnerId: string | null,
  towerThreats: TowerThreat[],
) {
  const cellCost = assaultCellCost(state, squad, targetOwnerId, towerThreats)
  return path.slice(1).reduce((sum, position) => sum + cellCost(position), 0)
}

interface AssaultRouteIntent {
  path: CellPosition[]
  blocker: CellPosition | null
}

function assaultRouteIntentFor(state: MatchState, squad: { position: CellPosition; object: SquadObject }, targetOwnerId: string | null): AssaultRouteIntent | null {
  const target = targetOwnerId ? castlePositionFor(state.scenario, targetOwnerId) : null
  if (!target) return null
  const towerThreats = towerThreatsFor(state, squad.object.ownerId)
  const paths = [...approachDestinations(state, target, 'assault'), target]
    .flatMap((destination) => {
      const path = assaultPathWithThreats(state, state.scenario.cells, squad.object, squad.position, destination, targetOwnerId, towerThreats)
      return path ? [{ path, cost: assaultPathCost(state, squad.object, path, targetOwnerId, towerThreats) }] : []
    })
    .sort((first, second) => first.cost - second.cost || first.path.length - second.path.length)
  const path = paths[0]?.path
  if (!path) return null
  const blocker = path.slice(1).find((position) => {
    const object = objectAt(state, position)
    return object?.type === 'building' && object.ownerId === targetOwnerId
  }) ?? null
  return { path, blocker }
}

function deterministicOpportunityRoll(state: MatchState, profile: AiProfileRules, from: CellPosition, target: CellPosition) {
  let hash = (state.scenario.seed ^ state.turn) >>> 0
  for (const character of profile.id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  for (const value of [from.column, from.row, target.column, target.row]) {
    hash ^= value + 0x9e3779b9 + (hash << 6) + (hash >>> 2)
    hash >>>= 0
  }
  return hash / 0xffffffff
}

function localOpportunityThreat(state: MatchState, ownerId: string, target: CellPosition) {
  return aiObjectEntries(state.scenario).reduce((sum, entry) => {
    if (!areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId)
      || positionDistance(entry.position, target) > aiTacticalConfig.raid.opportunityThreatRadius) return sum
    if (entry.object.type === 'squad') {
      return sum + troopCompositionPower(entry.object.units, squadHealth(entry.object))
    }
    if (entry.object.type === 'building' && entry.object.kind === 'tower' && entry.object.garrison?.archers) {
      return sum + troopCompositionPower({
        militia: 0,
        spearmen: 0,
        archers: entry.object.garrison.archers,
        knights: 0,
      }, entry.object.garrison.health)
    }
    return sum
  }, 0)
}

function isOpportunisticStructureAttack(
  state: MatchState,
  profile: AiProfileRules,
  squad: { position: CellPosition; object: SquadObject },
  target: { position: CellPosition; object: MapObject },
  intent: AssaultRouteIntent | null,
  damage: number,
) {
  if (target.object.type !== 'building' || !aiTacticalConfig.raid.targetValues[target.object.kind]
    || !intent || damage <= 0) return false
  const nearRoute = intent.path.some((position) => (
    positionDistance(position, target.position) <= aiTacticalConfig.raid.opportunityPathRadius
  ))
  if (!nearRoute) return false
  const attackOrders = Math.ceil(target.object.hitPoints / damage)
  if (attackOrders > aiTacticalConfig.raid.opportunityMaximumOrders) return false
  const ownPower = troopCompositionPower(squad.object.units, squadHealth(squad.object))
  if (localOpportunityThreat(state, squad.object.ownerId, target.position)
    > ownPower * aiTacticalConfig.raid.opportunityMaximumThreatRatio) return false
  const chance = Math.min(
    aiTacticalConfig.raid.opportunityMaximumChance,
    aiTacticalConfig.raid.opportunityChance * profile.doctrine.raidBias,
  )
  return deterministicOpportunityRoll(state, profile, squad.position, target.position) < chance
}

function attackTargetsFor(state: MatchState, ownerId: string) {
  return aiObjectEntries(state.scenario)
    .filter((entry) => areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId))
    .flatMap((entry) => entry.object.type === 'building'
      ? buildingFootprintPositions(entry.object.kind, entry.position)
          .map((position) => ({ position, object: entry.object }))
      : [entry])
}

/**
 * When the selected target's castle has fallen (or no target is selected), an
 * assault force still needs somewhere to go. Pick the nearest hostile building
 * or squad so the army advances on something instead of skipping every turn.
 */
function nearestHostileAsset(state: MatchState, from: CellPosition, ownerId: string): CellPosition | null {
  let best: CellPosition | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const entry of aiObjectEntries(state.scenario)) {
    if (!areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId)) continue
    const positions = entry.object.type === 'building'
      ? buildingFootprintPositions(entry.object.kind, entry.position)
      : [entry.position]
    for (const position of positions) {
      const distance = positionDistance(from, position)
      if (distance < bestDistance
        || (distance === bestDistance && best && (position.row < best.row
          || (position.row === best.row && position.column < best.column)))) {
        bestDistance = distance
        best = position
      }
    }
  }
  return best
}

function attackCandidates(
  state: MatchState,
  profile: AiProfileRules,
  phase: AiStrategicPhase,
  targetOwnerId: string | null,
  raidObjectives: Record<string, RaidObjective>,
  countNode: () => boolean,
) {
  const ownerId = state.activeParticipantId
  const squads = squadEntries(state, ownerId)
  const enemies = attackTargetsFor(state, ownerId)
  const candidates: TacticalCandidate[] = []
  for (const squad of squads) {
    const routeIntent = phase === 'assault' ? assaultRouteIntentFor(state, squad, targetOwnerId) : null
    const raidObjective = raidObjectives[positionKey(squad.position)]
    for (const enemy of enemies) {
      if (!countNode()) return candidates
      const command: AiCommand = { type: 'move-or-attack', from: squad.position, to: enemy.position }
      if (moveOrAttackFailure(state, squad.position, enemy.position) !== null) continue
      const evaluation = evaluateCommand(state, command, phase, targetOwnerId)
      if (!evaluation) continue
      const targetAfter = objectAt(evaluation.state, enemy.position)
      const remainingTargetHealth = targetAfter?.ownerId === enemy.object.ownerId
        ? objectHealth(targetAfter)
        : 0
      const damage = Math.max(0, objectHealth(enemy.object) - remainingTargetHealth)
      const penalty = worstReplyPenalty(evaluation.state, ownerId, countNode)
      const isStructure = enemy.object.type === 'building' || enemy.object.type === 'castle'
      const blocksRoute = Boolean(routeIntent?.blocker && samePosition(routeIntent.blocker, enemy.position))
      const isRaidTarget = Boolean(raidObjective?.targetCells.some((position) => samePosition(position, enemy.position)))
      const dangerousTower = enemy.object.type === 'building' && enemy.object.kind === 'tower' && (enemy.object.garrison?.archers ?? 0) > 0
      const threatensRoute = dangerousTower && Boolean(routeIntent?.path.some((position) => (
        towerHasLineOfFire(state.scenario.cells, enemy.position, position)
      )))
      const finishableSquad = enemy.object.type === 'squad'
        && (healthShare(enemy.object) <= aiTacticalConfig.formation.finisherHealthShare
          || squadSize(enemy.object) <= aiTacticalConfig.formation.finisherMaximumSize)
      const finisherAdjustment = finishableSquad
        ? aiTacticalConfig.formation.finisherUtility * profile.doctrine.finisherBias
        : 0
      const opportunityAttack = phase === 'assault' && isOpportunisticStructureAttack(
        state, profile, squad, enemy, routeIntent, damage,
      )
      if (phase === 'assault' && isStructure && enemy.object.type !== 'castle'
        && !blocksRoute && !isRaidTarget && !threatensRoute && !opportunityAttack) continue
      const routeAdjustment = blocksRoute ? aiTacticalConfig.siege.routeBlockerPriorityBonus
        : isRaidTarget ? aiTacticalConfig.raid.targetAttackBonus
          : threatensRoute ? aiTacticalConfig.siege.routeThreatPriorityBonus
            : opportunityAttack ? aiTacticalConfig.raid.opportunityAttackBonus
              : 0
      candidates.push({
        command,
        score: evaluation.score - penalty + routeAdjustment + finisherAdjustment,
        factors: [...evaluation.factors, `reply:${penalty.toFixed(1)}`,
          ...(finishableSquad ? [`finisher:${finisherAdjustment.toFixed(1)}`] : []),
          ...(blocksRoute
            ? ['route-blocker']
            : isRaidTarget
              ? [...raidObjective!.factors, 'raid-target']
              : threatensRoute ? ['route-fire-threat']
                : opportunityAttack ? ['opportunity-strike'] : [])],
      })
    }
  }
  return candidates
}

function mergeCandidates(state: MatchState, profile: AiProfileRules, memory: AiMemory, phase: AiStrategicPhase) {
  if (memory.lastArmyReorganizationTurn > 0
    && state.turn - memory.lastArmyReorganizationTurn < aiPlannerConfig.armyReorganizationCooldownTurns) return []
  const squads = squadEntries(state, state.activeParticipantId)
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
      candidates.push({
        command,
        score: formation.mergeBaseUtility + regroupValue + marchingGroupValue + fragility * formation.fragileMergeUtility
          + Math.max(0, formation.smallGroupSize - combined) * formation.smallGroupUtility,
        factors: ['consolidate-force', ...(marchingGroupValue > 0 ? ['form-marching-group'] : [])],
      })
    }
  }
  return candidates
}

const adjacentDestinations = (target: CellPosition) => clockwiseCardinalDirections
  .map((direction) => ({ column: target.column + direction.column, row: target.row + direction.row }))

function musterDestinations(state: MatchState, target: CellPosition) {
  const result: CellPosition[] = []
  for (let radius = 0; radius <= aiTacticalConfig.route.musterRadius; radius += 1) {
    for (let deltaRow = -radius; deltaRow <= radius; deltaRow += 1) {
      const deltaColumn = radius - Math.abs(deltaRow)
      const columns = deltaColumn === 0 ? [target.column] : [target.column - deltaColumn, target.column + deltaColumn]
      columns.forEach((column) => {
        const position = { column, row: target.row + deltaRow }
        const cell = state.scenario.cells[position.row]?.[position.column]
        if (cell && cell.landform !== 'peak' && !cell.object) result.push(position)
      })
    }
  }
  return result
}

function mapWithRememberedThreats(state: MatchState, memory: AiMemory, ownerId: string): GameMap {
  let result = state.scenario.cells
  const changedRows = new Map<number, GameMap[number]>()
  memory.contacts.forEach((contact) => {
    if (!areOwnersHostile(state.scenario.participants, ownerId, contact.ownerId)
      || contact.kind !== 'squad' || state.turn - contact.lastSeenTurn > gameConfig.ai.memoryRouteAvoidanceTurns) return
    const cell = result[contact.position.row]?.[contact.position.column]
    if (!cell || cell.object) return
    const row = changedRows.get(contact.position.row) ?? [...result[contact.position.row]]
    if (!changedRows.has(contact.position.row)) {
      result = [...result]
      changedRows.set(contact.position.row, row)
      result[contact.position.row] = row
    }
    row[contact.position.column] = {
      ...cell,
      object: {
        type: 'squad',
        ownerId: contact.ownerId,
        units: contact.units ?? { militia: 1, spearmen: 0, archers: 0, knights: 0 },
        health: contact.health,
      },
    }
  })
  return result
}

function approachDestinations(state: MatchState, target: CellPosition, role: AiSquadRole, navigationMap: GameMap = state.scenario.cells) {
  if (role === 'ranged') {
    const result: CellPosition[] = []
    for (let radius = gameConfig.turn.archerMinimumRange; radius <= gameConfig.turn.archerRange; radius += 1) {
      for (const direction of clockwiseCardinalDirections) {
        const position = { column: target.column + direction.column * radius, row: target.row + direction.row * radius }
        const cell = navigationMap[position.row]?.[position.column]
        if (cell && cell.landform !== 'peak' && !cell.object) result.push(position)
      }
    }
    return result
  }
  const minimum = role === 'scout'
    ? aiTacticalConfig.route.scoutApproachMinimum
    : aiTacticalConfig.route.ordinaryApproachMinimum
  const maximum = role === 'reserve' ? aiTacticalConfig.route.reserveApproachRadius : aiTacticalConfig.route.ordinaryApproachRadius
  const result: CellPosition[] = []
  for (let radius = minimum; radius <= maximum; radius += 1) {
    for (let deltaRow = -radius; deltaRow <= radius; deltaRow += 1) {
      const deltaColumn = radius - Math.abs(deltaRow)
      const columns = deltaColumn === 0 ? [target.column] : [target.column - deltaColumn, target.column + deltaColumn]
      columns.forEach((column) => {
        const position = { column, row: target.row + deltaRow }
        const cell = navigationMap[position.row]?.[position.column]
        if (cell && cell.landform !== 'peak' && !cell.object) result.push(position)
      })
    }
  }
  return result
}

function retreatDestination(state: MatchState, from: CellPosition, ownerId: string, navigationMap: GameMap) {
  const castle = castlePositionFor(state.scenario, ownerId)
  if (!castle) return null
  const currentDistance = positionDistance(from, castle)
  for (const destination of adjacentDestinations(castle)) {
    const cell = state.scenario.cells[destination.row]?.[destination.column]
    if (!cell || cell.landform === 'peak' || cell.object) continue
    const path = findMovementPath(navigationMap, from, destination, { ownerId })
    if (path && path.length > 1 && positionDistance(path[1], castle) < currentDistance) return path[1]
  }
  return null
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
) {
  const next = path[1]
  const nearby = nearbyFriendlyCount(squads, next, squad.position)
  const route = aiTacticalConfig.route
  const forests = path.slice(1, route.forestLookahead + 1)
    .reduce((sum, position) => sum + Number(state.scenario.cells[position.row]?.[position.column]?.vegetation), 0)
  const spreadValue = role === 'scout' || role === 'assault'
    ? profile.doctrine.maneuverBias * (route.spreadNeighborCap - Math.min(route.spreadNeighborCap, nearby)) * route.spreadUtility : 0
  const cohesionValue = (role === 'screen' || role === 'ranged' || role === 'reserve')
    ? profile.doctrine.concentrationBias * Math.min(route.spreadNeighborCap, nearby) * route.cohesionUtility
    : 0
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
    ? towerExposureAlong(state, path, towerThreats)
    : 0
  return -path.length * route.pathLengthPenalty + spreadValue + cohesionValue - knightForestPenalty
    - rememberedDanger - towerExposure * aiTacticalConfig.siege.towerExposureRoutePenalty
}

function movementCandidates(
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
  const threat = homeThreatFor(state, ownerId, memory)
  const defensiveAssets = defensiveAssetsFor(state, ownerId)
  const threateningSquads = aiObjectEntries(state.scenario)
    .flatMap((entry) => entry.object.type === 'squad'
      && areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId)
      ? [{ ...entry, object: entry.object }] : [])
    .sort((first, second) => threatPriority(second.position, defensiveAssets) - threatPriority(first.position, defensiveAssets)
      || first.position.row - second.position.row || first.position.column - second.position.column)
  const rememberedThreats = memory.contacts
    .filter((contact) => contact.kind === 'squad'
      && areOwnersHostile(state.scenario.participants, ownerId, contact.ownerId))
    .sort((first, second) => threatPriority(second.position, defensiveAssets) - threatPriority(first.position, defensiveAssets)
      || first.position.row - second.position.row || first.position.column - second.position.column)
  const squads = squadEntries(state, ownerId)
    .sort((first, second) => first.position.row - second.position.row || first.position.column - second.position.column)
  const candidates: TacticalCandidate[] = []
  const ownCastle = castlePositionFor(state.scenario, ownerId)
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
    const raidObjective = fielded || supportReady
      ? raidObjectives[positionKey(squad.position)]
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
    let strategicTarget: CellPosition | null | undefined
    if (role === 'ranged' && towerNeedingGarrison) strategicTarget = towerNeedingGarrison
    else if (phase === 'defense') {
      strategicTarget = threat.threatened && role !== 'reserve'
        ? threatTargets[squadIndex % Math.max(1, threatTargets.length)] ?? homeAnchor
        : guardAnchor
    } else if (phase === 'mobilization') {
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
        const path = raidObjective
          ? findMovementPath(navigationMap, squad.position, destination, {
              ownerId,
              cellCost: (_position, cell) => squadMovementOrderCost(squad.object, cell),
            })
          : phase === 'assault' && targetOwnerId && !waitingForSupport
            ? assaultPathWithThreats(state, navigationMap, squad.object, squad.position, destination, targetOwnerId, assaultTowerThreats)
            : findMovementPath(navigationMap, squad.position, destination, { ownerId })
        if (!path || path.length < 2) continue
        const to = path[1]
        if (isTemporarilyBlocked(memory, to, state.turn)) continue
        const crossingBorder = participant && state.scenario.territories[to.row]?.[to.column] !== participant.regionId
        const allowedCrossing = phase === 'defense' || (phase === 'assault' && state.turn >= profile.earliestOffensiveRound)
        if (crossingBorder && !allowedCrossing) continue
        if (moveOrAttackFailure(state, squad.position, to) !== null) continue
        const command: AiCommand = { type: 'move-or-attack', from: squad.position, to }
        const evaluation = evaluateCommand(state, command, phase, targetOwnerId)
        if (!evaluation) continue
        const situational = routeScore(state, profile, squads, squad, path, role, memory, phase, assaultTowerThreats)
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
        candidates.push({
          command,
          score: evaluation.score + situational + defenseBonus + interceptionBonus + raidBonus,
          factors: [
            ...evaluation.factors,
            `role:${role}`,
            `route:${situational.toFixed(1)}`,
            `intercept:${interceptionBonus.toFixed(1)}`,
            ...(waitingForSupport ? ['support-muster'] : []),
            ...(raidObjective ? [...raidObjective.factors, `raid-pursuit:${raidBonus.toFixed(1)}`] : []),
          ],
        })
      }
    }
    addDestinations(raidObjective
      ? [raidObjective.approach]
      : phase === 'defense' && threatTargets.length > 0
      ? adjacentDestinations(strategicTarget)
      : phase === 'assault' && role !== 'reserve' && !waitingForSupport
        ? [...approachDestinations(state, strategicTarget, role, navigationMap), strategicTarget]
        : musterDestinations(state, strategicTarget), strategicTarget)
  }
  return candidates
}

function pathOverlap(first: CellPosition[], second: CellPosition[]) {
  const firstKeys = new Set(first.slice(1, aiTacticalConfig.route.overlapLookahead + 1).map(positionKey))
  const secondKeys = second.slice(1, aiTacticalConfig.route.overlapLookahead + 1).map(positionKey)
  if (firstKeys.size === 0 || secondKeys.length === 0) return 1
  return secondKeys.reduce((sum, key) => sum + Number(firstKeys.has(key)), 0) / Math.min(firstKeys.size, secondKeys.length)
}

/**
 * Keeps both resulting groups useful whenever the source composition allows it.
 * The generic domain helper deliberately has no tactical opinion; AI formations
 * should not put every archer or every front-line fighter into the same half just
 * because of the global troop-kind order.
 */
export function formationSplit(squad: SquadObject, profile: AiProfileRules) {
  const desiredSize = Math.floor(squadSize(squad) / 2)
  const result: TroopComposition = { militia: 0, spearmen: 0, archers: 0, knights: 0 }
  troopKinds.forEach((troop) => {
    result[troop] = Math.floor((squad.units[troop] ?? 0) / 2)
  })

  const resultSize = () => troopKinds.reduce((sum, troop) => sum + result[troop], 0)
  const resultFrontLine = () => aiTacticalConfig.formation.frontLineTroops.reduce((sum, troop) => sum + result[troop], 0)
  const availableOddTroops = () => troopKinds.filter((troop) => (
    (squad.units[troop] ?? 0) - result[troop] > result[troop]
  ))
  while (resultSize() < desiredSize) {
    const candidates = availableOddTroops()
      .map((troop) => {
        const needsRanged = result.archers === 0 && troop === 'archers'
        const needsFrontLine = resultFrontLine() === 0 && aiTacticalConfig.formation.frontLineTroops.includes(troop)
        const desiredShare = (profile.doctrine.targetComposition[troop] ?? 0) * desiredSize
        const compositionDeficit = desiredShare - result[troop]
        return {
          troop,
          score: Number(needsRanged) * aiTacticalConfig.formation.splitRolePriority
            + Number(needsFrontLine) * aiTacticalConfig.formation.splitRolePriority
            + compositionDeficit * aiTacticalConfig.formation.splitCompositionWeight
            - profile.doctrine.preferredTroops.indexOf(troop) * aiTacticalConfig.formation.splitPreferenceTieBreak,
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

function towerCandidates(state: MatchState, profile: AiProfileRules, memory: AiMemory, phase: AiStrategicPhase, countNode: () => boolean) {
  if (!profile.allowedBuildings.includes('tower')) return []
  const ownerId = state.activeParticipantId
  const enemies = aiObjectEntries(state.scenario)
    .filter((entry) => areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId))
  const towers = aiObjectEntries(state.scenario, ownerId)
    .flatMap((entry) => entry.object.type === 'building' && entry.object.kind === 'tower'
      ? [{ ...entry, object: entry.object as BuildingObject }]
      : [])
  const fieldPower = squadEntries(state, ownerId).reduce((sum, squad) => (
    sum + troopCompositionPower(squad.object.units, squadHealth(squad.object))
  ), 0)
  const candidates: TacticalCandidate[] = []
  for (const tower of towers) {
    const garrisonArchers = tower.object.garrison?.archers ?? 0
    if (garrisonArchers > 0) {
      let hasShot = false
      for (const enemy of enemies) {
        if (!countNode()) return candidates
        if (towerAttackFailure(state, tower.position, enemy.position) !== null) continue
        const command: AiCommand = { type: 'tower-attack', tower: tower.position, to: enemy.position }
        const evaluation = evaluateCommand(state, command, phase, null)
        if (evaluation) {
          hasShot = true
          candidates.push({ command, score: evaluation.score + aiTacticalConfig.tower.fireUtility, factors: [...evaluation.factors, 'tower-fire'] })
        }
      }
      if (!hasShot && phase === 'assault'
        && fieldPower < profile.doctrine.forceTargets.assault.minimum) {
        const target = state.scenario.participants
          .filter((participant) => areOwnersHostile(state.scenario.participants, ownerId, participant.id))
          .flatMap((participant) => {
            const castle = castlePositionFor(state.scenario, participant.id)
            return castle ? [{ castle, distance: positionDistance(tower.position, castle) }] : []
          }).sort((first, second) => first.distance - second.distance)[0]?.castle
        const exits = adjacentDestinations(tower.position)
          .filter((position) => !isTemporarilyBlocked(memory, position, state.turn))
          .filter((position) => ungarrisonFailure(state, tower.position, position) === null)
          .sort((first, second) => (target ? positionDistance(first, target) - positionDistance(second, target) : 0)
            || first.row - second.row || first.column - second.column)
        if (exits[0]) candidates.push({ command: { type: 'ungarrison', tower: tower.position, to: exits[0] }, score: aiTacticalConfig.tower.releaseUtility, factors: ['release-idle-garrison'] })
      }
    }
    const desiredGarrison = phase === 'defense'
      ? buildingRules.tower.garrison?.capacity ?? aiTacticalConfig.tower.minimumPeacetimeArchers
      : aiTacticalConfig.tower.minimumPeacetimeArchers
    if (garrisonArchers < desiredGarrison
      && (phase === 'defense' || phase === 'expansion' || phase === 'mobilization' || phase === 'regroup')) {
      for (const direction of clockwiseCardinalDirections) {
        const from = { column: tower.position.column + direction.column, row: tower.position.row + direction.row }
        const squad = objectAt(state, from)
        if (squad?.type === 'squad' && squad.ownerId === ownerId && squad.units.archers > 0) {
          const defensive = phase === 'defense'
          const quantity = Math.min(squad.units.archers, desiredGarrison - garrisonArchers)
          candidates.push({
            command: { type: 'garrison', from, tower: tower.position, quantity },
            score: defensive ? aiTacticalConfig.tower.defenseGarrisonUtility : aiTacticalConfig.tower.peacetimeGarrisonUtility,
            factors: [defensive ? 'defensive-garrison' : 'standing-garrison'],
          })
        }
      }
    }
  }
  return candidates
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
    .sort((first, second) => first.position.row - second.position.row || first.position.column - second.position.column)
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
  for (const squad of squads) {
    const key = positionKey(squad.position)
    const size = Math.max(1, squadSize(squad.object))
    const archerShare = squad.object.units.archers / size
    const squadPower = troopCompositionPower(squad.object.units)
    let role: AiSquadRole
    if (archerShare >= aiTacticalConfig.formation.rangedRoleShare) role = 'ranged'
    else if (threatened && sortedByHome.indexOf(squad) < Math.ceil(squads.length / 2)) role = 'defender'
    else if (squads.length > 1 && reservedPower < reserveTarget
      && squadPower <= totalPower * Math.max(aiTacticalConfig.formation.minimumReserveSquadShare,
        reserveShare * aiTacticalConfig.formation.reserveSquadShareMultiplier)) { role = 'reserve'; reservedPower += squadPower }
    else if (size <= aiTacticalConfig.formation.scoutMaximumSize
      && profile.doctrine.maneuverBias > aiTacticalConfig.formation.scoutManeuverThreshold
      && (phase === 'assault' || squads.length >= aiTacticalConfig.formation.scoutMinimumGroups)) role = 'scout'
    else if (squads.some((other) => other !== squad && other.object.units.archers > 0
      && positionDistance(other.position, squad.position) <= aiTacticalConfig.formation.screenRadius)) role = 'screen'
    else role = 'assault'
    const oldRole = previous[key]
    roles[key] = oldRole === 'ranged' && archerShare >= aiTacticalConfig.formation.retainedRangedRoleShare ? oldRole : role
  }
  return roles
}

export function waveFor(state: MatchState, profile: AiProfileRules, memory: AiMemory, phase: AiStrategicPhase): AiWaveKind {
  if (phase === 'defense') return 'none'
  if (phase === 'regroup') return 'regroup'
  if (phase !== 'assault') return memory.wave === 'regroup' ? 'none' : memory.wave
  const targetPower = estimatedTargetPower(state, memory.targetOwnerId, memory)
  const power = armyPowerFor(state, state.activeParticipantId)
  if (!fortificationReadyFor(state, memory)
    || power < forceTargetFor(profile, 'assault', targetPower, profile.riskThreshold)) return 'probe'
  const targetCastle = memory.targetOwnerId ? castlePositionFor(state.scenario, memory.targetOwnerId) : null
  if (targetCastle) {
    const nearTarget = squadEntries(state, state.activeParticipantId)
      .some((entry) => positionDistance(entry.position, targetCastle) <= aiTacticalConfig.tower.siegeRange)
    if (nearTarget) return 'siege'
  }
  if (memory.wave === 'main' && totalArmySize(state, state.activeParticipantId) > 0) return 'support'
  // Space successive main waves so a campaign reads as prepared strikes, not a
  // non-stop stream. During the cooldown the army still advances toward the
  // target (support wave) but does not commit a fresh main push every turn.
  if (memory.lastMainWaveTurn > 0
    && state.turn - memory.lastMainWaveTurn <= aiPlannerConfig.mainWaveCooldownTurns) return 'support'
  return 'main'
}

export function tacticalCandidates(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  phase: AiStrategicPhase,
  countNode: () => boolean,
) {
  const navigationMap = mapWithRememberedThreats(state, memory, state.activeParticipantId)
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
