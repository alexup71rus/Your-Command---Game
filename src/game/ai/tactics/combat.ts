import { aiTacticalConfig } from '../../../config/ai'
import { gameConfig } from '../../../config/game'
import { buildingRules, combatRules, troopKinds, troopRules } from '../../../config/rules'
import type { GameMap, MapObject, SquadObject, TroopKind } from '../../map'
import {
  buildingFootprintPositions,
  isRangedAttack,
  moveOrAttackFailure,
  objectAt,
  rangedDamageTakenMultiplierFor,
  squadHealth,
  squadSize,
  type MatchState,
} from '../../match'
import { findMovementPath } from '../../pathfinding'
import { squadMovementOrderCost } from '../../movement'
import { areOwnersHostile, type CellPosition } from '../../scenario'
import { aiObjectEntries, castlePositionFor, positionDistance, positionKey, samePosition } from '../analysis'
import { executeAiCommand } from '../commands'
import { armyPowerFor, troopCompositionPower } from '../strategy'
import type { RaidObjective } from '../strategy/raids'
import type { AiCommand, AiProfileRules, AiStrategicPhase } from '../model'
import { approachDestinations } from './navigation'
import { squadEntries } from './state'
import type { TacticalCandidate } from './selection'

function maximumHealth(squad: SquadObject) {
  return (Object.keys(squad.units) as TroopKind[])
    .reduce((sum, troop) => sum + squad.units[troop] * troopRules[troop].durability, 0)
}

export function healthShare(squad: SquadObject) {
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

export function evaluateCommand(before: MatchState, command: AiCommand, phase: AiStrategicPhase, targetOwnerId: string | null) {
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

export function immediateReplyPowerLossForSquad(
  state: MatchState,
  ownerId: string,
  position: CellPosition,
  enemies: ReturnType<typeof squadEntries>,
  countNode: () => boolean,
) {
  const squad = objectAt(state, position)
  if (squad?.type !== 'squad' || squad.ownerId !== ownerId) return 0
  const before = troopCompositionPower(squad.units, squadHealth(squad))
  let worstLoss = 0
  for (const enemy of enemies) {
    if (!countNode()) break
    const replyState = {
      ...state,
      activeParticipantId: enemy.object.ownerId,
      ordersRemaining: gameConfig.turn.maxOrders,
    }
    if (moveOrAttackFailure(replyState, enemy.position, position) !== null) continue
    const reply = executeAiCommand(replyState, {
      type: 'move-or-attack', from: enemy.position, to: position,
    })
    if (!reply.ok) continue
    const after = objectAt(reply.state, position)
    const afterPower = after?.type === 'squad' && after.ownerId === ownerId
      ? troopCompositionPower(after.units, squadHealth(after))
      : 0
    worstLoss = Math.max(worstLoss, before - afterPower)
  }
  return worstLoss
}

export function projectedDefensiveContact(
  state: MatchState,
  profile: AiProfileRules,
  squad: ReturnType<typeof squadEntries>[number],
  path: CellPosition[],
  target: CellPosition,
  countNode: () => boolean,
) {
  const targetBefore = objectAt(state, target)
  if (targetBefore?.type !== 'squad'
    || !areOwnersHostile(state.scenario.participants, squad.object.ownerId, targetBefore.ownerId)) return null
  let projected = state
  let cursor = squad.position
  for (const destination of path.slice(1)) {
    if (!countNode()) return null
    const movement = executeAiCommand(projected, {
      type: 'move-or-attack', from: cursor, to: destination,
    })
    if (!movement.ok) return null
    projected = movement.state
    cursor = destination
  }
  if (!countNode()) return null
  const contact = executeAiCommand(projected, {
    type: 'move-or-attack', from: cursor, to: target,
  })
  if (!contact.ok) return null
  const attackerAfter = objectAt(contact.state, cursor)
  const targetAfter = objectAt(contact.state, target)
  const attackerPowerBefore = troopCompositionPower(squad.object.units, squadHealth(squad.object))
  const targetPowerBefore = troopCompositionPower(targetBefore.units, squadHealth(targetBefore))
  const attackerPowerAfter = attackerAfter?.type === 'squad' && attackerAfter.ownerId === squad.object.ownerId
    ? troopCompositionPower(attackerAfter.units, squadHealth(attackerAfter))
    : 0
  const targetPowerAfter = targetAfter?.type === 'squad' && targetAfter.ownerId === targetBefore.ownerId
    ? troopCompositionPower(targetAfter.units, squadHealth(targetAfter))
    : 0
  const targetDestroyed = targetPowerAfter <= 0
  const survivesExchange = attackerPowerAfter > 0
  const viable = targetDestroyed || (survivesExchange
    && attackerPowerAfter >= targetPowerAfter * profile.riskThreshold)
  return {
    viable,
    survivesExchange,
    attackerPowerBefore,
    targetPowerBefore,
    exchange: (targetPowerBefore - targetPowerAfter) - (attackerPowerBefore - attackerPowerAfter),
  }
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

export interface TowerThreat {
  position: CellPosition
  archers: number
}

export function towerThreatsFor(state: MatchState, ownerId: string): TowerThreat[] {
  return aiObjectEntries(state.scenario).flatMap((entry) => (
    areOwnersHostile(state.scenario.participants, ownerId, entry.object.ownerId) && entry.object.type === 'building'
      && entry.object.kind === 'tower' && entry.object.garrison?.archers
      ? [{ position: entry.position, archers: entry.object.garrison.archers }]
      : []
  ))
}

function towerExposureAt(state: MatchState, position: CellPosition, threats: TowerThreat[], squad: SquadObject) {
  const cover = state.scenario.cells[position.row]?.[position.column]?.vegetation
    ? combatRules.ranged.forestCoverMultiplier
    : 1
  const protection = rangedDamageTakenMultiplierFor(squad)
  return threats.reduce((sum, tower) => {
    if (samePosition(tower.position, position)
      || !towerHasLineOfFire(state.scenario.cells, tower.position, position)) return sum
    return sum + tower.archers
      * aiTacticalConfig.siege.towerExposureOrderCostPerArcher * cover * protection
  }, 0)
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
    const exposureCost = towerExposureAt(state, position, towerThreats, squad)
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
export function assaultPathWithThreats(
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
export function nearestHostileAsset(state: MatchState, from: CellPosition, ownerId: string): CellPosition | null {
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

export function attackCandidates(
  state: MatchState,
  profile: AiProfileRules,
  phase: AiStrategicPhase,
  targetOwnerId: string | null,
  raidObjectives: Record<string, RaidObjective>,
  countNode: () => boolean,
) {
  const ownerId = state.activeParticipantId
  const ownCastle = castlePositionFor(state.scenario, ownerId)
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
      const defensiveIncursion = phase === 'defense' && enemy.object.type === 'squad'
        && state.scenario.territories[enemy.position.row]?.[enemy.position.column]
          === state.scenario.participants.find((participant) => participant.id === ownerId)?.regionId
      const coreBreach = phase === 'defense' && enemy.object.type === 'squad' && Boolean(
        ownCastle && positionDistance(enemy.position, ownCastle) <= aiTacticalConfig.defense.coreBreachRadius,
      )
      const sourceAfter = objectAt(evaluation.state, squad.position)
      const targetSurvives = targetAfter?.type === 'squad' && targetAfter.ownerId === enemy.object.ownerId
      const certainDestruction = phase === 'defense' && enemy.object.type === 'squad' && targetSurvives
        && !(sourceAfter?.type === 'squad' && sourceAfter.ownerId === ownerId)
      if (phase === 'assault' && isStructure && enemy.object.type !== 'castle'
        && !blocksRoute && !isRaidTarget && !threatensRoute && !opportunityAttack) continue
      const routeAdjustment = blocksRoute ? aiTacticalConfig.siege.routeBlockerPriorityBonus
        : isRaidTarget ? aiTacticalConfig.raid.targetAttackBonus
          : threatensRoute ? aiTacticalConfig.siege.routeThreatPriorityBonus
            : opportunityAttack ? aiTacticalConfig.raid.opportunityAttackBonus
              : 0
      candidates.push({
        command,
        score: evaluation.score - penalty + routeAdjustment + finisherAdjustment
          + (defensiveIncursion ? aiTacticalConfig.movement.defenseEngagementUtility : 0)
          + (coreBreach ? aiTacticalConfig.defense.coreBreachEngagementUtility : 0)
          - (certainDestruction ? aiTacticalConfig.defense.certainDestructionPenalty : 0),
        factors: [...evaluation.factors, `reply:${penalty.toFixed(1)}`,
          ...(finishableSquad ? [`finisher:${finisherAdjustment.toFixed(1)}`] : []),
          ...(defensiveIncursion ? ['defend-domain'] : []),
          ...(coreBreach ? ['core-breach-response'] : []),
          ...(certainDestruction ? ['certain-destruction'] : []),
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

export function towerExposureAlong(state: MatchState, path: CellPosition[], threats: TowerThreat[], squad: SquadObject) {
  return path.slice(1, aiTacticalConfig.siege.towerExposureLookahead + 1)
    .reduce((sum, position) => sum + towerExposureAt(state, position, threats, squad), 0)
}

export function hostileArcherExposureAt(
  state: MatchState,
  position: CellPosition,
  movingFrom: CellPosition,
  squad: SquadObject,
  threats: ReturnType<typeof squadEntries>,
) {
  const targetCell = state.scenario.cells[position.row]?.[position.column]
  if (!targetCell) return 0
  return threats.reduce((sum, enemy) => {
    if (enemy.object.units.archers <= 0) return sum
    const columnDistance = Math.abs(position.column - enemy.position.column)
    const rowDistance = Math.abs(position.row - enemy.position.row)
    const distance = columnDistance + rowDistance
    if ((columnDistance !== 0 && rowDistance !== 0)
      || distance < gameConfig.turn.archerMinimumRange
      || distance > gameConfig.turn.archerRange) return sum
    const columnStep = Math.sign(position.column - enemy.position.column)
    const rowStep = Math.sign(position.row - enemy.position.row)
    for (let step = 1; step < distance; step += 1) {
      const ray = {
        column: enemy.position.column + columnStep * step,
        row: enemy.position.row + rowStep * step,
      }
      const cell = state.scenario.cells[ray.row]?.[ray.column]
      if (!cell || cell.landform === 'peak' || cell.vegetation
        || (cell.object && !samePosition(ray, movingFrom))) return sum
    }
    const cover = targetCell.vegetation ? combatRules.ranged.forestCoverMultiplier : 1
    return sum + enemy.object.units.archers * cover * rangedDamageTakenMultiplierFor(squad)
  }, 0)
}
