import { aiBuildingKindsByZone, aiProfiles } from '../../../config/ai'
import { buildingRules } from '../../../config/rules'
import type {
  BuildingKind,
  BuildingObject,
  GameMap,
  SquadObject,
  TroopComposition,
} from '../../map'
import {
  buildingFootprintPositions,
  createMatch,
  endTurn,
  ownedBuildingCount,
  type MatchState,
} from '../../match'
import type { AiProfileId, CellPosition, MapScenario } from '../../scenario'
import { analyzeAiWorld, createSettlementPlan } from '../analysis'
import { createAiMemory } from '../model'

export type EconomicTerrain = 'open' | 'woodland' | 'highland'

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

/**
 * Authored economic maps with explicit constraints. These are deliberately not
 * generated presets: every clearing, forest edge, hill site, and blocked cell
 * is stable test data and therefore produces an explainable regression.
 */
export function createEconomicScenario(
  profileId: AiProfileId,
  terrain: EconomicTerrain,
): MapScenario {
  const scenario = createAiScenario(profileId)
  scenario.id = `ai-economy-${terrain}-${profileId}`
  scenario.name = `Authored ${terrain} economy`
  if (terrain === 'open') return scenario

  scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    if (scenario.territories[rowIndex][column] !== 'region-1') return
    const object = cell.object
    if (terrain === 'woodland') {
      const settlementClearing = column >= 18 && rowIndex >= 8 && rowIndex <= 17
      const productionClearing = column >= 14 && column <= 17 && rowIndex >= 3 && rowIndex <= 7
      const road = rowIndex === 12
      scenario.cells[rowIndex][column] = {
        ...cell,
        landform: 'plain',
        elevation: 0.2,
        vegetation: !(settlementClearing || productionClearing || road),
        object,
      }
      return
    }

    const settlementBasin = column >= 18 && rowIndex >= 8 && rowIndex <= 17
    const foodShelf = column >= 15 && column <= 18 && rowIndex >= 8 && rowIndex <= 10
    const highlandIndustry = column >= 14 && column <= 17 && rowIndex >= 3 && rowIndex <= 7
    const road = rowIndex === 12 || (column === 17 && rowIndex >= 7 && rowIndex <= 12)
    const passable = settlementBasin || foodShelf || highlandIndustry || road
    const hill = highlandIndustry
    scenario.cells[rowIndex][column] = {
      ...cell,
      landform: passable ? hill ? 'hill' : 'plain' : 'peak',
      elevation: passable ? hill ? 0.58 : 0.22 : 0.92,
      vegetation: false,
      object,
    }
  }))
  return scenario
}

/**
 * An authored mountain pass. The AI settlement sits between two ridges, so a
 * useful curtain must close the pass instead of drawing a decorative line in
 * open ground. Highland cells beyond the ridge remain reachable for a remote
 * tower and extraction buildings.
 */
export function createDefensiveTerrainScenario(profileId: AiProfileId): MapScenario {
  const scenario = createAiScenario(profileId)
  scenario.id = `ai-defense-pass-${profileId}`
  scenario.name = 'Authored mountain-pass defense'
  for (const row of [8, 16]) {
    for (let column = 12; column <= 19; column += 1) {
      scenario.cells[row][column] = {
        ...scenario.cells[row][column],
        elevation: 0.94,
        landform: 'peak',
        vegetation: false,
        object: undefined,
      }
    }
  }
  return scenario
}

/**
 * A mature settlement with a functioning production chain and field troops,
 * with an authored construction budget. Velislava still has to save for her
 * curtain; Svyatobor starts with the committed budget for a complete enclosure
 * so the test observes the full build order instead of replaying the opening.
 */
export function createFortressConstructionState(
  profileId: Extract<AiProfileId, 'velislava' | 'svyatobor'> = 'svyatobor',
  terrain: 'open' | 'mountain-pass' = 'open',
) {
  const ownerId = `ai-${profileId}`
  const state = createMatch(terrain === 'mountain-pass'
    ? createDefensiveTerrainScenario(profileId)
    : createEconomicScenario(profileId, 'open'))
  // The live planner creates its settlement blueprint before development.
  // Preserve that ordering in the fixture so mature preset buildings cannot
  // occupy cells that were meant to close the citadel perimeter later.
  const analysis = analyzeAiWorld(state.scenario, ownerId)
  if (!analysis) throw new Error('Could not analyze the fortress construction fixture')
  const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles[profileId])
  const reservedDefense = new Set([
    ...(settlementPlan.fortification?.lines.flatMap((line) => [line.gate, ...line.walls, ...line.towers]) ?? []),
    ...(settlementPlan.reservedSites.outpostTower ? [settlementPlan.reservedSites.outpostTower] : []),
  ].map((position) => `${position.column}:${position.row}`))
  const buildings: Array<[BuildingKind, number, number]> = [
    ['orchard', 20, 6], ['orchard', 22, 6], ['mill', 20, 17],
    ['farm', 18, 18], ['farm', 21, 18],
    ['lumberMill', 19, 3], ['lumberMill', 23, 4],
    ['quarry', 14, 3], ['quarry', 16, 3],
    ['mine', 14, 7], ['mine', 17, 5], ['smelter', 18, 8],
    ['kitchen', 22, 9], ['kitchen', 22, 10],
    ['house', 23, 8], ['house', 23, 9], ['house', 23, 10],
    ['house', 23, 11], ['house', 23, 12],
    ['barracks', 18, 14], ['barracks', 21, 14], ['market', 23, 13],
  ]
  buildings.forEach(([kind, column, row]) => {
    const positions = buildingFootprintPositions(kind, { column, row })
    if (aiProfiles[profileId].allowedBuildings.includes(kind)
      && positions.every((position) => {
        const cell = state.scenario.cells[position.row]?.[position.column]
        return cell && cell.landform !== 'peak' && !cell.object
          && !reservedDefense.has(`${position.column}:${position.row}`)
      })) {
      placeTestBuilding(state, ownerId, kind, { column, row })
    }
  })
  const muster = profileId === 'svyatobor' ? { column: 19, row: 12 } : { column: 20, row: 13 }
  placeTestSquad(state, ownerId, muster, {
    militia: 2, spearmen: 2, archers: profileId === 'svyatobor' ? 2 : 0, knights: 0,
  })
  state.domains[ownerId] = {
    ...state.domains[ownerId],
    population: 18,
    taxRate: 'none',
    resources: profileId === 'svyatobor' ? {
      wood: 220, stone: 360, ore: 20, iron: 20,
      flour: 80, meat: 20, fruit: 60, gold: 240,
    } : {
      wood: 25, stone: 0, ore: 10, iron: 2,
      flour: 40, meat: 0, fruit: 30, gold: 100,
    },
  }
  const nonDefensiveZones = ['housing', 'food', 'industry', 'military'] as const
  nonDefensiveZones.forEach((zoneKind) => {
    const zone = settlementPlan.zones[zoneKind]
    const kinds = aiBuildingKindsByZone[zoneKind]
    const ownedOrigins = kinds.reduce((sum, kind) => sum + ownedBuildingCount(state, ownerId, kind), 0)
    zone.maxOrigins = Math.max(zone.maxOrigins, ownedOrigins)
    zone.maxBuildings = Object.fromEntries(kinds.map((kind) => [
      kind,
      ownedBuildingCount(state, ownerId, kind),
    ]))
  })
  state.aiMemory[ownerId] = {
    ...createAiMemory(),
    settlementPlan,
    targetOwnerId: 'player',
    phase: 'mobilization',
    stableTurns: 10,
  }
  const line = settlementPlan.fortification?.lines[0]
  if (!line) throw new Error('Fixture requires a planned gate and wall line')
  if (profileId === 'svyatobor' && line.towers.length !== 2) {
    throw new Error('Svyatobor fixture requires two castle-line towers')
  }
  return {
    state,
    analysis,
    line,
    outpost: settlementPlan.reservedSites.outpostTower,
    ownerId,
    profileId,
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
