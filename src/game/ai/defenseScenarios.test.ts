import { describe, expect, it } from 'vitest'
import { aiProfiles, aiSpatialConfig, aiTacticalConfig } from '../../config/ai'
import type { SquadObject, TroopComposition } from '../map'
import { createMatch, objectAt, squadHealth } from '../match'
import type { AiProfileId, CellPosition } from '../scenario'
import { aiObjectEntries, analyzeAiWorld, createSettlementPlan, positionDistance, positionKey } from './analysis'
import { createAiMemory } from './model'
import {
  createDefensiveTerrainScenario,
  createFortressConstructionState,
  placeTestBuilding,
  placeTestSquad,
  startAiTurn,
} from './testing/scenarioFixtures'
import { runAiScenario, runFrozenTactics, type ScenarioRun } from './testing/scenarioHarness'

const spearmen = (amount: number): TroopComposition => ({
  militia: 0, spearmen: amount, archers: 0, knights: 0,
})
const archers = (amount: number): TroopComposition => ({
  militia: 0, spearmen: 0, archers: amount, knights: 0,
})

function buildEvents(run: ScenarioRun) {
  return run.turns.flatMap((turn) => turn.executed.flatMap((command) => (
    command.type === 'build'
      ? [{ turn: turn.turn, kind: command.building, position: command.position }]
      : []
  )))
}

function constructionSummary(profileId: AiProfileId, run: ScenarioRun) {
  return JSON.stringify({
    profileId,
    builds: buildEvents(run),
    failures: run.turns.flatMap((turn) => turn.failures.map((failure) => ({ turn: turn.turn, ...failure }))),
    partialTurns: run.turns.filter((turn) => turn.partial).map((turn) => turn.turn),
    phases: run.turns.map((turn) => `${turn.turn}:${turn.phase}`),
  })
}

function expectLegalConstruction(profileId: AiProfileId, run: ScenarioRun) {
  const summary = constructionSummary(profileId, run)
  expect(run.turns.flatMap((turn) => turn.failures), summary).toEqual([])
  expect(run.turns.every((turn) => turn.planned.length === turn.executed.length), summary).toBe(true)
  expect(run.turns.every((turn) => !turn.partial), summary).toBe(true)
  expect(run.turns.every((turn) => turn.executed.every((command) => ![
    'move-or-attack', 'split', 'garrison', 'ungarrison', 'tower-attack',
  ].includes(command.type))), summary).toBe(true)
}

function openPositionAtDistance(state: ReturnType<typeof startAiTurn>, target: CellPosition, distance: number) {
  return state.scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
    const position = { column, row: rowIndex }
    return !cell.object && cell.landform !== 'peak' && !cell.vegetation
      && positionDistance(position, target) === distance
      ? [position]
      : []
  })).sort((first, second) => first.row - second.row || first.column - second.column)[0]
}

function ownedSquads(state: ReturnType<typeof startAiTurn>, ownerId: string) {
  return aiObjectEntries(state.scenario, ownerId)
    .flatMap((entry) => entry.object.type === 'squad'
      ? [{ position: entry.position, object: entry.object as SquadObject }]
      : [])
}

describe('deterministic AI defense scenarios with offensive waves disabled', () => {
  it('lets Radomir develop a mountain pass without pretending he can build fortifications', () => {
    const run = runAiScenario(createMatch(createDefensiveTerrainScenario('radomir')), 'radomir', {
      turns: 20,
      mode: 'development-only',
    })
    const summary = constructionSummary('radomir', run)

    expectLegalConstruction('radomir', run)
    expect(buildEvents(run).some((event) => ['barbican', 'wall', 'tower'].includes(event.kind)), summary)
      .toBe(false)
  })

  it.each(['velislava', 'svyatobor'] as const)('%s constructs one coherent castle before optional outworks', (profileId) => {
    const fixture = createFortressConstructionState(profileId, 'mountain-pass')
    const run = runAiScenario(fixture.state, profileId, {
      turns: profileId === 'svyatobor' ? 32 : 24,
      mode: 'development-only',
      cachedAnalysis: fixture.analysis,
    })
    const summary = constructionSummary(profileId, run)
    const events = buildEvents(run)
    const gateIndex = events.findIndex((event) => event.kind === 'barbican')
    const wallIndexes = events.flatMap((event, index) => event.kind === 'wall' ? [index] : [])
    const towerEvents = events.filter((event) => event.kind === 'tower')

    expectLegalConstruction(profileId, run)
    expect(gateIndex, summary).toBeGreaterThanOrEqual(0)
    expect(fixture.line.kind, summary).toBe('terrain-gate')
    expect(wallIndexes, summary).toHaveLength(fixture.line.walls.length)
    expect(Math.min(...wallIndexes), summary).toBeGreaterThan(gateIndex)
    expect(objectAt(run.state, fixture.line.gate), summary).toMatchObject({
      type: 'building', kind: 'barbican', ownerId: fixture.ownerId,
    })
    fixture.line.walls.forEach((position) => {
      expect(objectAt(run.state, position), summary).toMatchObject({
        type: 'building', kind: 'wall', ownerId: fixture.ownerId,
      })
    })
    const lineCells = [fixture.line.gate, ...fixture.line.walls, ...fixture.line.towers]
    const mountainContacts = lineCells.filter((position) => [
      { column: position.column - 1, row: position.row },
      { column: position.column + 1, row: position.row },
      { column: position.column, row: position.row - 1 },
      { column: position.column, row: position.row + 1 },
    ].some((neighbor) => run.state.scenario.cells[neighbor.row]?.[neighbor.column]?.landform === 'peak'))
    expect(mountainContacts.length, summary).toBeGreaterThanOrEqual(2)

    if (profileId === 'velislava') {
      expect(towerEvents, summary).toEqual([])
      return
    }
    expect(towerEvents, summary).toHaveLength(fixture.line.towers.length + 1)
    expect(events.findIndex((event) => event.kind === 'tower'), summary).toBeGreaterThan(Math.max(...wallIndexes))
    fixture.line.towers.forEach((position) => {
      expect(objectAt(run.state, position), summary).toMatchObject({
        type: 'building', kind: 'tower', ownerId: fixture.ownerId,
      })
    })
    expect(fixture.outpost, summary).toBeDefined()
    if (fixture.outpost) {
      expect(towerEvents.at(-1)?.position, summary).toEqual(fixture.outpost)
      expect(objectAt(run.state, fixture.outpost), summary).toMatchObject({
        type: 'building', kind: 'tower', ownerId: fixture.ownerId,
      })
      expect(positionDistance(fixture.outpost, fixture.analysis.castle), summary)
        .toBeGreaterThanOrEqual(aiSpatialConfig.settlementPlan.fortification.outpostMinimumCastleDistance)
      expect(run.state.scenario.cells[fixture.outpost.row][fixture.outpost.column].landform, summary).toBe('hill')
    }
  }, 60_000)

  it('moves separate archer detachments into both the castle tower and remote outpost', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing defense analysis')
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor)
    const castleTower = settlementPlan.fortification?.lines[0]?.towers[0]
    const outpostTower = settlementPlan.reservedSites.outpostTower
    if (!castleTower || !outpostTower) throw new Error('Fixture requires castle and outpost towers')
    placeTestBuilding(state, ownerId, 'tower', castleTower)
    placeTestBuilding(state, ownerId, 'tower', outpostTower)
    const firstStart = openPositionAtDistance(state, castleTower, 2)
    const secondStart = openPositionAtDistance(state, outpostTower, 2)
    if (!firstStart || !secondStart || positionKey(firstStart) === positionKey(secondStart)) {
      throw new Error('Could not place distinct archer detachments')
    }
    placeTestSquad(state, ownerId, firstStart, archers(3), { health: 3 })
    placeTestSquad(state, ownerId, secondStart, archers(3), { health: 3 })
    const memory = {
      ...createAiMemory(), settlementPlan, targetOwnerId: 'player', phase: 'mobilization' as const,
    }
    const run = runFrozenTactics(state, 'svyatobor', memory, 'mobilization', 12)
    const summary = JSON.stringify({ starts: [firstStart, secondStart], steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(run.steps.some((step) => step.command.type === 'move-or-attack'), summary).toBe(true)
    expect(run.steps.filter((step) => step.command.type === 'garrison'), summary).toHaveLength(2)
    for (const tower of [castleTower, outpostTower]) {
      expect(objectAt(run.state, tower), summary).toMatchObject({
        type: 'building', kind: 'tower',
        garrison: { archers: aiTacticalConfig.tower.minimumPeacetimeArchers },
      })
    }
    expect(ownedSquads(run.state, ownerId).reduce((sum, squad) => sum + squad.object.units.archers, 0), summary)
      .toBe(2)
  })

  it('keeps a peacetime guard at a remote mine instead of emptying the whole domain', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing defense analysis')
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor)
    const mine = { column: 18, row: 6 }
    placeTestBuilding(state, ownerId, 'mine', mine)
    const starts = [{ column: 19, row: 10 }, { column: 21, row: 10 }, { column: 22, row: 12 }]
    starts.forEach((position) => placeTestSquad(state, ownerId, position, spearmen(2), { health: 2.7 }))
    const memory = {
      ...createAiMemory(), settlementPlan, targetOwnerId: 'player', phase: 'mobilization' as const,
    }
    const run = runFrozenTactics(state, 'svyatobor', memory, 'mobilization', 12)
    const squads = ownedSquads(run.state, ownerId)
    const summary = JSON.stringify({ mine, steps: run.steps, squads: squads.map((squad) => squad.position) })

    expect(run.failures, summary).toEqual([])
    expect(squads.some((squad) => positionDistance(squad.position, mine) <= 2), summary).toBe(true)
    expect(squads.some((squad) => positionDistance(squad.position, mine) > 2), summary).toBe(true)
  })

  it('recognizes a remote raid as a home threat and sends a field squad to intercept it', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing defense analysis')
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor)
    const mine = { column: 18, row: 6 }
    const raider = { column: 14, row: 6 }
    const defender = { column: 19, row: 11 }
    placeTestBuilding(state, ownerId, 'mine', mine)
    placeTestSquad(state, 'player', raider, { militia: 4, spearmen: 0, archers: 0, knights: 0 }, { health: 4 })
    placeTestSquad(state, ownerId, defender, spearmen(4), { health: 5.4 })
    const memory = {
      ...createAiMemory(), settlementPlan, targetOwnerId: 'player', phase: 'defense' as const,
    }
    const initialDistance = positionDistance(defender, raider)
    const run = runFrozenTactics(state, 'svyatobor', memory, 'defense', 6)
    const finalDefenders = ownedSquads(run.state, ownerId)
    const finalDistance = Math.min(...finalDefenders.map((squad) => positionDistance(squad.position, raider)))
    const summary = JSON.stringify({ steps: run.steps, failures: run.failures, finalDistance })

    expect(run.failures, summary).toEqual([])
    expect(finalDistance, summary).toBeLessThan(initialDistance)
    expect(run.steps.some((step) => step.command.type === 'move-or-attack'), summary).toBe(true)
  })

  it('uses a remote tower garrison to stop a raid before it reaches the protected building', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing defense analysis')
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor)
    const tower = settlementPlan.reservedSites.outpostTower
    if (!tower) throw new Error('Fixture requires an outpost tower')
    placeTestBuilding(state, ownerId, 'tower', tower, {
      garrison: { archers: 2, health: 2 },
    })
    const targetCandidates = [
      { column: tower.column - 4, row: tower.row },
      { column: tower.column + 4, row: tower.row },
      { column: tower.column, row: tower.row - 4 },
      { column: tower.column, row: tower.row + 4 },
    ]
    const raider = targetCandidates.find((position) => {
      const cell = state.scenario.cells[position.row]?.[position.column]
      return cell && cell.landform !== 'peak' && !cell.object
    })
    if (!raider) throw new Error('Could not place an in-range raider')
    placeTestSquad(state, 'player', raider, { militia: 6, spearmen: 0, archers: 0, knights: 0 }, { health: 6 })
    const before = objectAt(state, raider)
    const run = runFrozenTactics(state, 'svyatobor', {
      ...createAiMemory(), settlementPlan, targetOwnerId: 'player', phase: 'defense' as const,
    }, 'defense', 1)
    const after = objectAt(run.state, raider)
    const summary = JSON.stringify({ tower, raider, steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(run.steps[0]?.command, summary).toEqual({ type: 'tower-attack', tower, to: raider })
    expect(after?.type === 'squad' ? squadHealth(after) : 0, summary)
      .toBeLessThan(before?.type === 'squad' ? squadHealth(before) : 0)
    expect(objectAt(run.state, tower), summary).toMatchObject({
      type: 'building', kind: 'tower', garrison: { archers: 2 },
    })
  })
})
