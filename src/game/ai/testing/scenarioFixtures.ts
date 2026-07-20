import { buildingRules } from '../../../config/rules'
import type {
  BuildingKind,
  BuildingObject,
  GameMap,
  SquadObject,
  TroopComposition,
} from '../../map'
import { buildingFootprintPositions, createMatch, endTurn, type MatchState } from '../../match'
import type { AiProfileId, CellPosition, MapScenario } from '../../scenario'

export const militia = (amount = 1): TroopComposition => ({
  militia: amount,
  spearmen: 0,
  archers: 0,
  knights: 0,
})

/**
 * A small authored map used by focused AI tests. It deliberately contains one
 * forest/highland pocket, while keeping the central battlefield fully under
 * the test's control. Unlike generated maps, every relevant coordinate is a
 * stable part of the fixture contract.
 */
export function createAiScenario(profileId: AiProfileId = 'radomir'): MapScenario {
  const size = 24
  const cells: GameMap = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => ({
    elevation: column >= 14 && column <= 17 && row >= 3 && row <= 6 ? 0.55 : 0.2,
    landform: column >= 14 && column <= 17 && row >= 3 && row <= 6 ? 'hill' as const : 'plain' as const,
    vegetation: column >= 20 && column <= 22 && row >= 2 && row <= 5,
  })))
  cells[12][3] = {
    ...cells[12][3],
    object: { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 },
  }
  cells[12][20] = {
    ...cells[12][20],
    vegetation: false,
    object: { type: 'castle', ownerId: `ai-${profileId}`, hitPoints: 100, maxHitPoints: 100 },
  }
  return {
    id: `ai-test-${profileId}`,
    name: 'Authored AI test',
    seed: 91,
    participantCount: 2,
    cells,
    territories: Array.from({ length: size }, () => Array.from(
      { length: size },
      (_, column) => column < size / 2 ? 'region-0' : 'region-1',
    )),
    regions: [
      {
        id: 'region-0', index: 0, color: '#d2b45f', center: { column: 3, row: 12 },
        validCastleCells: [{ column: 3, row: 12 }],
        reservedBuildSites: {
          plain: { column: 3, row: 3 }, hill: { column: 3, row: 5 },
          extra: { column: 5, row: 3 }, house: { column: 4, row: 12 },
        },
        score: { cells: 288, forest: 0, hills: 0, quality: 288 },
      },
      {
        id: 'region-1', index: 1, color: '#6f9c83', center: { column: 20, row: 12 },
        validCastleCells: [{ column: 20, row: 12 }],
        reservedBuildSites: {
          plain: { column: 18, row: 8 }, hill: { column: 14, row: 3 },
          extra: { column: 18, row: 14 }, house: { column: 19, row: 12 },
        },
        score: { cells: 288, forest: 12, hills: 16, quality: 304 },
      },
    ],
    participants: [
      { id: 'player', kind: 'human', regionId: 'region-0', color: '#d2b45f' },
      { id: `ai-${profileId}`, kind: 'ai', profileId, regionId: 'region-1', color: '#6f9c83' },
    ],
  }
}

export function startAiTurn(profileId: AiProfileId = 'radomir') {
  const ended = endTurn(createMatch(createAiScenario(profileId)))
  if (!ended.ok) throw new Error(`Could not start ${profileId}'s turn: ${ended.reason}`)
  return ended.state
}

export function placeTestBuilding(
  state: MatchState,
  ownerId: string,
  kind: BuildingKind,
  origin: CellPosition,
  overrides: Partial<BuildingObject> = {},
) {
  const rule = buildingRules[kind]
  const object: BuildingObject = {
    type: 'building',
    kind,
    ownerId,
    hitPoints: rule.hitPoints,
    maxHitPoints: rule.hitPoints,
    ...(rule.footprint ? {
      footprint: {
        originColumn: origin.column,
        originRow: origin.row,
        ...rule.footprint,
      },
    } : {}),
    ...overrides,
  }
  buildingFootprintPositions(kind, origin).forEach((position) => {
    state.scenario.cells[position.row][position.column] = {
      ...state.scenario.cells[position.row][position.column],
      vegetation: false,
      object,
    }
  })
}

export function placeTestSquad(
  state: MatchState,
  ownerId: string,
  position: CellPosition,
  units: TroopComposition,
  overrides: Partial<SquadObject> = {},
) {
  state.scenario.cells[position.row][position.column] = {
    ...state.scenario.cells[position.row][position.column],
    vegetation: false,
    object: { type: 'squad', ownerId, units, ...overrides },
  }
}
