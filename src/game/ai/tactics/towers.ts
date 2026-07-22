import { aiTacticalConfig } from '../../../config/ai'
import { buildingRules } from '../../../config/rules'
import type { BuildingObject } from '../../map'
import {
  garrisonFailure,
  objectAt,
  squadHealth,
  towerAttackFailure,
  ungarrisonFailure,
  type MatchState,
} from '../../match'
import { clockwiseCardinalDirections } from '../../geometry'
import { areOwnersHostile } from '../../scenario'
import { aiObjectEntries, castlePositionFor, positionDistance } from '../analysis'
import type { AiCommand, AiMemory, AiProfileRules, AiStrategicPhase } from '../model'
import { troopCompositionPower } from '../strategy'
import { evaluateCommand } from './combat'
import { adjacentDestinations } from './navigation'
import type { TacticalCandidate } from './selection'
import { isTemporarilyBlocked, squadEntries } from './state'

export function towerCandidates(
  state: MatchState,
  profile: AiProfileRules,
  memory: AiMemory,
  phase: AiStrategicPhase,
  countNode: () => boolean,
) {
  if (!profile.allowedBuildings.includes('tower')) return []
  const ownerId = state.activeParticipantId
  const enemies = aiObjectEntries(state.scenario)
    .filter((entry) => areOwnersHostile(
      state.scenario.participants,
      ownerId,
      entry.object.ownerId,
    ))
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
        const command: AiCommand = {
          type: 'tower-attack',
          tower: tower.position,
          to: enemy.position,
        }
        const evaluation = evaluateCommand(state, command, phase, null)
        if (evaluation) {
          hasShot = true
          candidates.push({
            command,
            score: evaluation.score + aiTacticalConfig.tower.fireUtility,
            factors: [...evaluation.factors, 'tower-fire'],
          })
        }
      }
      if (!hasShot && phase === 'assault'
        && fieldPower < profile.doctrine.forceTargets.assault.minimum) {
        const target = state.scenario.participants
          .filter((participant) => areOwnersHostile(
            state.scenario.participants,
            ownerId,
            participant.id,
          ))
          .flatMap((participant) => {
            const castle = castlePositionFor(state.scenario, participant.id)
            return castle
              ? [{ castle, distance: positionDistance(tower.position, castle) }]
              : []
          }).sort((first, second) => first.distance - second.distance)[0]?.castle
        const exits = adjacentDestinations(tower.position)
          .filter((position) => !isTemporarilyBlocked(memory, position, state.turn))
          .filter((position) => ungarrisonFailure(state, tower.position, position) === null)
          .sort((first, second) => (target
            ? positionDistance(first, target) - positionDistance(second, target)
            : 0) || first.row - second.row || first.column - second.column)
        if (exits[0]) candidates.push({
          command: { type: 'ungarrison', tower: tower.position, to: exits[0] },
          score: aiTacticalConfig.tower.releaseUtility,
          factors: ['release-idle-garrison'],
        })
      }
    }
    const desiredGarrison = phase === 'defense'
      ? buildingRules.tower.garrison?.capacity ?? aiTacticalConfig.tower.minimumPeacetimeArchers
      : aiTacticalConfig.tower.minimumPeacetimeArchers
    if (garrisonArchers < desiredGarrison
      && (phase === 'defense' || phase === 'expansion'
        || phase === 'mobilization' || phase === 'regroup')) {
      for (const direction of clockwiseCardinalDirections) {
        const from = {
          column: tower.position.column + direction.column,
          row: tower.position.row + direction.row,
        }
        const squad = objectAt(state, from)
        if (squad?.type !== 'squad' || squad.ownerId !== ownerId || squad.units.archers <= 0) continue
        const defensive = phase === 'defense'
        const quantity = Math.min(squad.units.archers, desiredGarrison - garrisonArchers)
        if (garrisonFailure(state, from, tower.position, quantity) !== null) continue
        candidates.push({
          command: { type: 'garrison', from, tower: tower.position, quantity },
          score: defensive
            ? aiTacticalConfig.tower.defenseGarrisonUtility
            : aiTacticalConfig.tower.peacetimeGarrisonUtility,
          factors: [defensive ? 'defensive-garrison' : 'standing-garrison'],
        })
      }
    }
  }
  return candidates
}
