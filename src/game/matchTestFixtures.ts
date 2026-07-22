import { buildingRules } from '../config/rules'
import type { BuildingKind, GameMap } from './map'
import { buildingFootprintPositions, createMatch, endTurn } from './match'
import type { MapScenario } from './scenario'

export function createScenario(size = 8): MapScenario {
  const cells: GameMap = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({
      elevation: 0.2,
      landform: 'plain' as const,
      vegetation: false,
    })),
  )
  cells[1][1] = { ...cells[1][1], object: { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 } }
  const npcCastleColumn = size - 2
  cells[1][npcCastleColumn] = {
    ...cells[1][npcCastleColumn],
    object: { type: 'castle', ownerId: 'npc-2', hitPoints: 100, maxHitPoints: 100 },
  }
  return {
    id: 'test',
    name: 'Test',
    seed: 1,
    participantCount: 2,
    cells,
    territories: Array.from({ length: size }, () =>
      Array.from({ length: size }, (_, column) => (column < size / 2 ? 'region-0' : 'region-1')),
    ),
    regions: [
      {
        id: 'region-0',
        index: 0,
        color: '#d2b45f',
        center: { column: 1, row: 1 },
        validCastleCells: [],
        reservedBuildSites: {
          plain: { column: 1, row: 1 },
          hill: { column: 1, row: 1 },
          extra: { column: 1, row: 1 },
          house: { column: 1, row: 1 },
        },
        score: { cells: (size * size) / 2, forest: 0, hills: 0, quality: (size * size) / 2 },
      },
      {
        id: 'region-1',
        index: 1,
        color: '#6f9c83',
        center: { column: npcCastleColumn, row: 1 },
        validCastleCells: [],
        reservedBuildSites: {
          plain: { column: npcCastleColumn, row: 1 },
          hill: { column: npcCastleColumn, row: 1 },
          extra: { column: npcCastleColumn, row: 1 },
          house: { column: npcCastleColumn, row: 1 },
        },
        score: { cells: (size * size) / 2, forest: 0, hills: 0, quality: (size * size) / 2 },
      },
    ],
    participants: [
      { id: 'player', kind: 'human', regionId: 'region-0', color: '#d2b45f' },
      { id: 'npc-2', kind: 'ai', profileId: 'radomir', regionId: 'region-1', color: '#6f9c83' },
    ],
  }
}

export function placeBuilding(scenario: MapScenario, kind: BuildingKind, column: number, row: number, ownerId = 'player') {
  const rule = buildingRules[kind]
  const footprint = rule.footprint
  const object = {
    type: 'building' as const,
    kind,
    ownerId,
    hitPoints: rule.hitPoints,
    maxHitPoints: rule.hitPoints,
    footprint: footprint ? { originColumn: column, originRow: row, ...footprint } : undefined,
  }
  buildingFootprintPositions(kind, { column, row }).forEach((position) => {
    scenario.cells[position.row][position.column] = { ...scenario.cells[position.row][position.column], object }
  })
}

export function removePlayerCastle(scenario: MapScenario) {
  scenario.cells[1][1] = { ...scenario.cells[1][1], object: undefined }
}

export function advanceRound(state: ReturnType<typeof createMatch>) {
  let current = state
  let steps = 0
  do {
    const advanced = endTurn(current)
    if (!advanced.ok) return advanced
    current = advanced.state
    steps += 1
  } while (current.status === 'playing' && current.activeParticipantId !== current.playerId && steps <= state.scenario.participants.length)
  if (current.status === 'playing' && current.activeParticipantId !== current.playerId)
    throw new Error('round did not return to the human participant')
  return { ok: true as const, state: current }
}
