import { describe, expect, it } from 'vitest'
import { aiProfiles } from '../../config/ai'
import { buildingRules } from '../../config/rules'
import { objectAt } from '../match'
import type { AiProfileId, MapScenario } from '../scenario'
import { analyzeAiWorld, createSettlementPlan, positionDistance, positionKey } from './analysis'
import { createAiMemory } from './model'
import { assaultPathFor } from './tactics'
import {
  createAiScenario,
  placeTestBuilding,
  placeTestSquad,
  startAiTurn,
} from './testing/scenarioFixtures'
import { runFrozenTactics } from './testing/scenarioHarness'

const profiles: AiProfileId[] = ['radomir', 'velislava', 'svyatobor']
const spearmen = (amount: number) => ({ militia: 0, spearmen: amount, archers: 0, knights: 0 })

function prepareTwoLaneAssault(profileId: AiProfileId, obstacle: 'wall' | 'barbican') {
  const state = startAiTurn(profileId)
  const ownerId = state.activeParticipantId
  state.scenario.cells[12][3].object = undefined
  state.scenario.cells[11][3].object = {
    type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100,
  }
  for (let row = 9; row <= 12; row += 1) {
    for (let column = 2; column <= 13; column += 1) {
      const existing = state.scenario.cells[row][column].object
      state.scenario.cells[row][column] = {
        ...state.scenario.cells[row][column],
        landform: row === 9 || row === 12 ? 'peak' : 'plain',
        vegetation: row === 10 && column >= 9 && column <= 11,
        object: existing?.type === 'castle' ? existing : undefined,
      }
    }
  }
  const squad = { column: 12, row: 11 }
  const blocker = { column: 10, row: 11 }
  placeTestSquad(state, ownerId, squad, spearmen(3), { health: 4.05 })
  placeTestBuilding(state, 'player', obstacle, blocker, obstacle === 'barbican' ? { hitPoints: 1 } : {})
  state.turn = 20
  return { state, ownerId, squad, blocker }
}

function assaultMemory(targetOwnerId: string) {
  return {
    ...createAiMemory(),
    targetOwnerId,
    phase: 'assault' as const,
    wave: 'main' as const,
    stableTurns: 10,
    idleTurns: 10,
  }
}

function mirroredHorizontally(scenario: MapScenario): MapScenario {
  const width = scenario.cells[0].length
  const mirror = ({ column, row }: { column: number; row: number }) => ({ column: width - 1 - column, row })
  return {
    ...scenario,
    id: `${scenario.id}-mirrored`,
    cells: scenario.cells.map((row) => [...row].reverse()),
    territories: scenario.territories.map((row) => [...row].reverse()),
    regions: scenario.regions.map((region) => ({
      ...region,
      center: mirror(region.center),
      validCastleCells: region.validCastleCells.map(mirror),
      reservedBuildSites: {
        plain: mirror(region.reservedBuildSites.plain),
        hill: mirror(region.reservedBuildSites.hill),
        extra: mirror(region.reservedBuildSites.extra),
        house: mirror(region.reservedBuildSites.house),
      },
    })),
  }
}

describe('authored AI combat scenarios', () => {
  it('prices the forest detour below breaching a healthy wall', () => {
    const { state, ownerId, squad, blocker } = prepareTwoLaneAssault('radomir', 'wall')
    const object = objectAt(state, squad)
    expect(object?.type).toBe('squad')
    if (object?.type !== 'squad') return
    const path = assaultPathFor(state, state.scenario.cells, object, squad, { column: 3, row: 11 }, 'player')
    expect(path).not.toBeNull()
    expect(path).not.toContainEqual(blocker)
    expect(path?.some((position) => state.scenario.cells[position.row][position.column].vegetation)).toBe(true)
    expect(object.ownerId).toBe(ownerId)
  })

  it.each(profiles)('%s takes the forest detour without chipping the healthy wall', (profileId) => {
    const { state, blocker } = prepareTwoLaneAssault(profileId, 'wall')
    const initialWall = objectAt(state, blocker)
    const run = runFrozenTactics(state, profileId, assaultMemory('player'), 'assault', 8)
    const destinations = run.steps.flatMap(({ command }) => command.type === 'move-or-attack' ? [command.to] : [])
    const summary = JSON.stringify({ steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(destinations.length, summary).toBeGreaterThan(0)
    expect(destinations.some((position) => run.state.scenario.cells[position.row][position.column].vegetation), summary).toBe(true)
    expect(objectAt(run.state, blocker), summary).toMatchObject({
      type: 'building',
      kind: 'wall',
      hitPoints: initialWall?.type === 'building' ? initialWall.hitPoints : buildingRules.wall.hitPoints,
    })
    const edges = run.steps.flatMap(({ command }) => command.type === 'move-or-attack'
      ? [`${positionKey(command.from)}>${positionKey(command.to)}`]
      : [])
    expect(new Set(edges).size, summary).toBe(edges.length)
  })

  it.each(profiles)('%s breaches a weak barbican instead of paying for the forest detour', (profileId) => {
    const { state, blocker } = prepareTwoLaneAssault(profileId, 'barbican')
    const run = runFrozenTactics(state, profileId, assaultMemory('player'), 'assault', 8)
    const attacksGate = run.steps.some(({ command }) => command.type === 'move-or-attack'
      && command.to.column === blocker.column && command.to.row === blocker.row)
    const summary = JSON.stringify({ steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(attacksGate, summary).toBe(true)
    expect(objectAt(run.state, blocker), summary).not.toMatchObject({ type: 'building', kind: 'barbican', ownerId: 'player' })
  })

  it('uses the attacker-facing barbican and ignores the identical rear gate', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    state.scenario.cells[12][3].object = undefined
    state.scenario.cells[12][12].object = {
      type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100,
    }
    const frontGate = { column: 14, row: 12 }
    const rearGate = { column: 10, row: 12 }
    for (const column of [10, 14]) {
      for (let row = 10; row <= 14; row += 1) {
        placeTestBuilding(state, 'player', row === 12 ? 'barbican' : row === 10 || row === 14 ? 'tower' : 'wall', { column, row })
      }
    }
    for (let column = 11; column <= 13; column += 1) {
      placeTestBuilding(state, 'player', 'wall', { column, row: 10 })
      placeTestBuilding(state, 'player', 'wall', { column, row: 14 })
    }
    const squad = {
      type: 'squad' as const,
      ownerId,
      units: spearmen(5),
      health: 6.75,
    }
    const castle = { column: 12, row: 12 }
    const eastPath = assaultPathFor(state, state.scenario.cells, squad, { column: 18, row: 12 }, castle, 'player')
    const westPath = assaultPathFor(state, state.scenario.cells, squad, { column: 6, row: 12 }, castle, 'player')

    expect(eastPath).toContainEqual(frontGate)
    expect(eastPath).not.toContainEqual(rearGate)
    expect(westPath).toContainEqual(rearGate)
    expect(westPath).not.toContainEqual(frontGate)
  })

  it.each(['velislava', 'svyatobor'] as const)('%s places its gate on the enemy-facing side, including on a mirrored map', (profileId) => {
    for (const scenario of [createAiScenario(profileId), mirroredHorizontally(createAiScenario(profileId))]) {
      const ownerId = `ai-${profileId}`
      const analysis = analyzeAiWorld(scenario, ownerId)
      expect(analysis).not.toBeNull()
      if (!analysis) continue
      const plan = createSettlementPlan(analysis, scenario, aiProfiles[profileId])
      expect(plan.fortification).not.toBeNull()
      const line = plan.fortification?.lines[0]
      expect(line).toBeDefined()
      if (!line) continue
      const enemyVector = {
        column: analysis.front.column - analysis.castle.column,
        row: analysis.front.row - analysis.castle.row,
      }
      const gateVector = {
        column: line.gate.column - analysis.castle.column,
        row: line.gate.row - analysis.castle.row,
      }
      const dot = enemyVector.column * gateVector.column + enemyVector.row * gateVector.row
      const summary = JSON.stringify({ castle: analysis.castle, enemy: analysis.front, line })
      expect(dot, summary).toBeGreaterThan(0)
      expect(positionDistance(line.gate, analysis.front), summary)
        .toBeLessThan(positionDistance(analysis.castle, analysis.front))
      expect(line.walls.length, summary).toBeGreaterThan(0)
      expect([0, 2], summary).toContain(line.towers.length)
      if (line.kind === 'bastion') expect(line.towers.length, summary).toBe(2)
    }
  })
})
