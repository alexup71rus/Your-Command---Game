import { objectAt, type MatchState } from '../../match'
import { createAiMemory, type AiMemory, type AiSettlementPlan } from '../model'

export function normalizeAiMemory(previous: AiMemory) {
  return {
    ...createAiMemory(),
    ...previous,
    squadRoles: previous.squadRoles ?? {},
    contacts: previous.contacts ?? [],
    blockedCells: previous.blockedCells ?? [],
    recentMovements: previous.recentMovements ?? [],
  }
}

function fortificationCommitted(state: MatchState, plan: AiSettlementPlan) {
  return plan.fortification?.lines.some((line) => (
    [line.gate, ...line.walls, ...line.towers].some((position) => {
      const object = objectAt(state, position)
      return object?.type === 'building' && object.ownerId === state.activeParticipantId
        && (object.kind === 'barbican' || object.kind === 'wall' || object.kind === 'tower')
    })
  )) ?? false
}

export function preserveCommittedFortification(
  state: MatchState,
  previous: AiSettlementPlan,
  refreshed: AiSettlementPlan,
) {
  if (!fortificationCommitted(state, previous)) return refreshed
  const primary = previous.fortification?.lines[0]
  return {
    ...refreshed,
    // A started castle is a commitment, not a suggestion. Replanning the
    // economy around it must not redraw half-built walls into another shape.
    fortification: previous.fortification,
    reservedCorridors: previous.reservedCorridors,
    reservedSites: {
      ...refreshed.reservedSites,
      gate: primary?.gate,
      leftTower: primary?.towers[0],
      rightTower: primary?.towers[1],
      outpostTower: previous.reservedSites.outpostTower,
    },
    zones: {
      ...refreshed.zones,
      defense: previous.zones.defense,
    },
  }
}
