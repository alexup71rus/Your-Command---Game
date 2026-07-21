import { describe, expect, it } from 'vitest'
import { aiProfiles, aiSpatialConfig, aiStrategicConfig, aiTacticalConfig } from '../../config/ai'
import { buildingRules } from '../../config/rules'
import type { SquadObject, TroopComposition } from '../map'
import { createMatch, endTurn, objectAt, recruit, squadHealth, workforceFor } from '../match'
import type { AiProfileId, CellPosition } from '../scenario'
import { aiObjectEntries, analyzeAiWorld, createSettlementPlan, positionDistance, positionKey } from './analysis'
import { createAiMemory } from './model'
import { fortificationLineActivated, immediateCriticalAssetAttackFor, nextFortificationStep, recruitmentCandidate } from './strategy'
import {
  createAiScenario,
  createDefensiveTerrainScenario,
  createFortressConstructionState,
  placeTestBuilding,
  placeTestSquad,
  startAiTurn,
} from './testing/scenarioFixtures'
import { runAiScenario, runFrozenTacticalRounds, runFrozenTactics, type ScenarioRun } from './testing/scenarioHarness'

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
    phases: run.turns.map((turn) => `${turn.turn}:${turn.phase}`),
    finalBuildings: run.turns.at(-1)?.buildingCounts,
    fortificationTrace: run.turns.flatMap((turn) => turn.trace.filter((entry) => (
      entry.factors.includes('fortification-plan') || entry.factors.some((factor) => factor.startsWith('building:wall'))
    )).map((entry) => ({ turn: turn.turn, ...entry }))),
  })
}

function expectLegalConstruction(profileId: AiProfileId, run: ScenarioRun) {
  const summary = constructionSummary(profileId, run)
  expect(run.turns.flatMap((turn) => turn.failures), summary).toEqual([])
  expect(run.turns.every((turn) => turn.planned.length === turn.executed.length), summary).toBe(true)
  expect(run.turns.every((turn) => turn.executed.every((command) => ![
    'move-or-attack', 'split', 'garrison', 'ungarrison', 'tower-attack',
  ].includes(command.type))), summary).toBe(true)
}

function openPositionAtDistance(
  state: ReturnType<typeof startAiTurn>,
  target: CellPosition,
  distance: number,
  excluded = new Set<string>(),
) {
  return state.scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
    const position = { column, row: rowIndex }
    return !cell.object && cell.landform !== 'peak' && !cell.vegetation && !excluded.has(positionKey(position))
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
  it('does not draft an already staffed economy for an ordinary defensive buildup', () => {
    const fixture = createFortressConstructionState('svyatobor', 'open')
    const started = endTurn(fixture.state)
    if (!started.ok) throw new Error(started.reason)
    const state = started.state
    const before = workforceFor(state, fixture.ownerId)
    state.domains[fixture.ownerId] = {
      ...state.domains[fixture.ownerId],
      population: before.employed,
    }

    const candidate = recruitmentCandidate(
      state, aiProfiles.svyatobor, 'defense', () => true, state.aiMemory[fixture.ownerId],
    )

    expect(workforceFor(state, fixture.ownerId).free).toBe(0)
    expect(candidate).toBeNull()
  })

  it('may emergency-draft industry workers while keeping food and kitchen workers assigned', () => {
    const fixture = createFortressConstructionState('svyatobor', 'open')
    const started = endTurn(fixture.state)
    if (!started.ok) throw new Error(started.reason)
    const state = started.state
    const ownerId = fixture.ownerId
    const before = workforceFor(state, ownerId)
    state.domains[ownerId] = { ...state.domains[ownerId], population: before.employed }
    const attacker = openPositionAtDistance(state, fixture.analysis.castle, 2)
    if (!attacker) throw new Error('Could not place an emergency attacker')
    placeTestSquad(state, 'player', attacker, {
      militia: 30, spearmen: 0, archers: 0, knights: 0,
    }, { health: 30 })
    const staffedCriticalWorkers = (testState: typeof state) => workforceFor(testState, ownerId).assignments
      .filter((assignment) => aiStrategicConfig.recruitment.criticalWorkerBuildings.includes(assignment.kind))
      .reduce((sum, assignment) => sum + assignment.assigned, 0)
    const criticalBefore = staffedCriticalWorkers(state)

    const candidate = recruitmentCandidate(
      state, aiProfiles.svyatobor, 'defense', () => true, state.aiMemory[ownerId],
    )
    expect(candidate?.command.type).toBe('recruit')
    if (!candidate || candidate.command.type !== 'recruit') throw new Error('Expected emergency recruitment')
    const recruited = recruit(state, candidate.command.troop, candidate.command.quantity, candidate.command.position)
    if (!recruited.ok) throw new Error(recruited.reason)

    expect(candidate.factors).toContain('emergency-draft')
    expect(workforceFor(recruited.state, ownerId).employed).toBeLessThan(workforceFor(state, ownerId).employed)
    expect(staffedCriticalWorkers(recruited.state)).toBe(criticalBefore)
  })

  it('stops ordinary defensive recruitment once the known threat is covered', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing covered-threat analysis')
    const attacker = openPositionAtDistance(state, analysis.castle, 3)
    if (!attacker) throw new Error('Could not place covered threat')
    placeTestSquad(state, 'player', attacker, spearmen(2))
    placeTestSquad(state, ownerId, { column: 19, row: 12 }, {
      militia: 0, spearmen: 5, archers: 3, knights: 2,
    })
    placeTestSquad(state, ownerId, { column: 19, row: 13 }, {
      militia: 0, spearmen: 5, archers: 3, knights: 2,
    })
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      population: 20,
      resources: {
        ...state.domains[ownerId].resources,
        flour: 100, iron: 100, gold: 200,
      },
    }

    const candidate = recruitmentCandidate(
      state, aiProfiles.svyatobor, 'defense', () => true, createAiMemory(),
    )
    expect(candidate).toBeNull()
  })

  it('spends consecutive orders to finish a reachable castle interception this turn', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing castle-assault analysis')
    const attacker = openPositionAtDistance(state, analysis.castle, 1)
    if (!attacker) throw new Error('Could not place a castle attacker')
    placeTestSquad(state, 'player', attacker, {
      militia: 15, spearmen: 0, archers: 0, knights: 0,
    }, { health: 15 })
    const starts = state.scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
      const position = { column, row: rowIndex }
      const distance = positionDistance(position, attacker)
      return !cell.object && cell.landform !== 'peak' && !cell.vegetation
        && state.scenario.territories[rowIndex]?.[column] === 'region-1'
        && distance >= 4 && distance <= 7
        ? [position] : []
    })).sort((first, second) => first.row - second.row || first.column - second.column).slice(0, 3)
    if (starts.length < 3) throw new Error('Could not place three castle defenders')
    starts.forEach((position) => placeTestSquad(state, ownerId, position, spearmen(5), { health: 6.75 }))
    const run = runFrozenTactics(state, 'svyatobor', {
      ...createAiMemory(), targetOwnerId: 'player', phase: 'defense',
    }, 'defense', 8)
    const summary = JSON.stringify({ attacker, starts, steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(run.steps.some((step) => step.command.type === 'move-or-attack'
      && positionKey(step.command.to) === positionKey(attacker)), summary).toBe(true)
    const beforeContact = run.steps.slice(0, run.steps.findIndex((step) => (
      step.command.type === 'move-or-attack' && positionKey(step.command.to) === positionKey(attacker)
    )))
    expect(beforeContact.length, summary).toBeGreaterThan(1)
    expect(beforeContact.every((step) => step.factors.includes('committed-defense-contact')), summary).toBe(true)
  })

  it('mobilizes several formations when no defender can reach the castle breach this turn', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing distant castle-assault analysis')
    const attacker = openPositionAtDistance(state, analysis.castle, 1)
    if (!attacker) throw new Error('Could not place a distant castle attacker')
    placeTestSquad(state, 'player', attacker, {
      militia: 15, spearmen: 0, archers: 0, knights: 0,
    }, { health: 15 })
    const starts = [
      { column: 12, row: 5 },
      { column: 14, row: 4 },
      { column: 16, row: 3 },
    ]
    starts.forEach((position) => placeTestSquad(state, ownerId, position, spearmen(5), { health: 6.75 }))
    const run = runFrozenTactics(state, 'svyatobor', {
      ...createAiMemory(), targetOwnerId: 'player', phase: 'defense',
    }, 'defense', 3)
    const movedFormations = starts.filter((position) => objectAt(run.state, position)?.ownerId !== ownerId)
    const summary = JSON.stringify({ attacker, starts, steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(run.steps, summary).toHaveLength(3)
    expect(run.steps.every((step) => step.factors.includes('defense-response')), summary).toBe(true)
    expect(run.steps.every((step) => !step.factors.includes('committed-defense-contact')), summary).toBe(true)
    expect(movedFormations.length, summary).toBeGreaterThanOrEqual(2)
  })

  it('keeps every seeded Svyatobor castle complete while varying its legal layout', () => {
    const perimeters: number[] = []
    const signatures = [91, 137, 223, 307, 419, 617, 773].map((seed) => {
      const scenario = createDefensiveTerrainScenario('svyatobor')
      scenario.id = `${scenario.id}-seed-${seed}`
      scenario.seed = seed
      const ownerId = 'ai-svyatobor'
      const analysis = analyzeAiWorld(scenario, ownerId)
      expect(analysis).not.toBeNull()
      if (!analysis) throw new Error('Could not analyze seeded castle fixture')
      const plan = createSettlementPlan(analysis, scenario, aiProfiles.svyatobor)
      const line = plan.fortification?.lines[0]
      expect(line?.kind).toBe('enclosure')
      if (!line) throw new Error('Svyatobor did not plan an enclosure')
      const cells = [line.gate, ...line.walls, ...line.towers]
      const columns = cells.map((position) => position.column)
      const rows = cells.map((position) => position.row)
      const left = Math.min(...columns)
      const right = Math.max(...columns)
      const top = Math.min(...rows)
      const bottom = Math.max(...rows)
      const expectedPerimeterSize = (right - left + 1) * 2 + (bottom - top - 1) * 2
      const uniqueCells = new Set(cells.map(positionKey))
      perimeters.push(expectedPerimeterSize)

      expect(uniqueCells.size).toBe(expectedPerimeterSize)
      expect(left).toBeLessThan(analysis.castle.column)
      expect(right).toBeGreaterThan(analysis.castle.column)
      expect(top).toBeLessThan(analysis.castle.row)
      expect(bottom).toBeGreaterThan(analysis.castle.row)
      expect(line.towers).toHaveLength(aiSpatialConfig.settlementPlan.fortification.enclosureTowerCount)
      expect(line.walls).toHaveLength(expectedPerimeterSize - line.towers.length - 1)

      const relative = (position: CellPosition) => (
        `${position.column - analysis.castle.column}:${position.row - analysis.castle.row}`
      )
      return `${right - left}x${bottom - top}|g${relative(line.gate)}|t${line.towers.map(relative).sort().join(',')}`
    })

    expect(new Set(signatures).size, JSON.stringify(signatures)).toBeGreaterThan(1)
    expect(new Set(perimeters).size, JSON.stringify({ signatures, perimeters })).toBeGreaterThan(1)
    expect(Math.max(...perimeters), JSON.stringify({ signatures, perimeters })).toBeGreaterThan(12)
  })

  it('varies Velislava delay walls between long straight and winged plans', () => {
    const plans = [91, 137, 223, 307, 419, 617, 773, 958].map((seed) => {
      const scenario = createAiScenario('velislava')
      scenario.id = `${scenario.id}-wall-seed-${seed}`
      scenario.seed = seed
      const analysis = analyzeAiWorld(scenario, 'ai-velislava')
      if (!analysis) throw new Error('Could not analyze Velislava wall fixture')
      const line = createSettlementPlan(analysis, scenario, aiProfiles.velislava).fortification?.lines[0]
      if (!line) throw new Error('Velislava did not plan a delay wall')
      const columns = new Set(line.walls.map((position) => position.column))
      const rows = new Set(line.walls.map((position) => position.row))
      if (line.shape === 'straight') expect(columns.size === 1 || rows.size === 1).toBe(true)
      if (line.shape === 'winged') {
        expect(columns.size).toBeGreaterThan(1)
        expect(rows.size).toBeGreaterThan(1)
      }
      expect(line.purpose).toBe('delay')
      expect(line.walls.length).toBeGreaterThanOrEqual(8)
      return line.shape
    })

    expect(new Set(plans), JSON.stringify(plans)).toEqual(new Set(['straight', 'winged']))
  })

  it('weights castle variants by terrain while preserving seeded variation', () => {
    const seeds = [91, 137, 223, 307, 419, 617, 773, 958]
    const svyatoborPerimeters = (terrain: 'open' | 'pass') => seeds.map((seed) => {
      const scenario = terrain === 'open'
        ? createAiScenario('svyatobor')
        : createDefensiveTerrainScenario('svyatobor')
      if (terrain === 'pass') {
        for (const row of [9, 15]) for (let column = 12; column <= 19; column += 1) {
          scenario.cells[row][column] = {
            ...scenario.cells[row][column], landform: 'peak', elevation: 0.94,
            vegetation: false, object: undefined,
          }
        }
      }
      scenario.seed = seed
      scenario.id = `${scenario.id}-${seed}`
      const analysis = analyzeAiWorld(scenario, 'ai-svyatobor')
      if (!analysis) throw new Error('Could not analyze terrain-weighted enclosure')
      const line = createSettlementPlan(analysis, scenario, aiProfiles.svyatobor).fortification?.lines[0]
      if (!line) throw new Error('Missing terrain-weighted enclosure')
      return 1 + line.walls.length + line.towers.length
    })
    const velislavaShapes = (terrain: 'open' | 'pass') => seeds.map((seed) => {
      const scenario = terrain === 'open'
        ? createAiScenario('velislava')
        : createDefensiveTerrainScenario('velislava')
      if (terrain === 'pass') {
        for (const row of [9, 15]) for (let column = 12; column <= 19; column += 1) {
          scenario.cells[row][column] = {
            ...scenario.cells[row][column], landform: 'peak', elevation: 0.94,
            vegetation: false, object: undefined,
          }
        }
      }
      scenario.seed = seed
      scenario.id = `${scenario.id}-${seed}`
      const analysis = analyzeAiWorld(scenario, 'ai-velislava')
      if (!analysis) throw new Error('Could not analyze terrain-weighted curtain')
      const line = createSettlementPlan(analysis, scenario, aiProfiles.velislava).fortification?.lines[0]
      if (!line) throw new Error('Missing terrain-weighted curtain')
      return line.shape
    })
    const openPerimeters = svyatoborPerimeters('open')
    const passPerimeters = svyatoborPerimeters('pass')
    const openShapes = velislavaShapes('open')
    const passShapes = velislavaShapes('pass')
    const summary = JSON.stringify({ openPerimeters, passPerimeters, openShapes, passShapes })

    expect(openPerimeters.reduce((sum, size) => sum + size, 0), summary)
      .toBeGreaterThan(passPerimeters.reduce((sum, size) => sum + size, 0))
    expect(openShapes.filter((shape) => shape === 'winged').length, summary)
      .toBeGreaterThan(passShapes.filter((shape) => shape === 'winged').length)
    expect(new Set(openPerimeters).size, summary).toBeGreaterThan(1)
    expect(new Set(openShapes).size, summary).toBeGreaterThan(1)
  })

  it('commits Svyatobor surplus outworks only from a complete stone budget', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Could not analyze surplus-wall fixture')
    const plan = createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor)
    const outwork = plan.fortification?.lines.find((line) => line.purpose === 'surplus')
    if (!outwork) throw new Error('Svyatobor did not reserve a surplus outwork')
    const stoneNeed = (buildingRules.barbican.resourceCost.stone ?? 0)
      + outwork.walls.length * (buildingRules.wall.resourceCost.stone ?? 0)
      + outwork.towers.length * (buildingRules.tower.resourceCost.stone ?? 0)
      + (outwork.activationStoneReserve ?? 0)
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      resources: { ...state.domains[ownerId].resources, stone: stoneNeed - 1 },
    }
    expect(fortificationLineActivated(state, outwork)).toBe(false)
    state.domains[ownerId].resources.stone = stoneNeed
    expect(fortificationLineActivated(state, outwork)).toBe(true)

    placeTestBuilding(state, ownerId, 'wall', outwork.walls[0])
    state.domains[ownerId].resources.stone = 0
    expect(fortificationLineActivated(state, outwork)).toBe(true)
  })

  it('counterattacks an intruder inside its domain instead of only shadowing it', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const defender = { column: 13, row: 12 }
    const intruder = { column: 12, row: 12 }
    placeTestSquad(state, ownerId, defender, spearmen(4), { health: 5.4 })
    placeTestSquad(state, 'player', intruder, spearmen(2), { health: 2.7 })
    const run = runFrozenTactics(state, 'svyatobor', {
      ...createAiMemory(), targetOwnerId: 'player', phase: 'defense',
    }, 'defense', 1)
    const summary = JSON.stringify({ steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(run.steps[0]?.command, summary).toEqual({ type: 'move-or-attack', from: defender, to: intruder })
    expect(run.steps[0]?.factors, summary).toContain('defend-domain')
  })

  it('commits the whole relief force when two spearmen breach the castle core', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const castle = { column: 20, row: 12 }
    const intruder = { column: 19, row: 12 }
    const ranged = { column: 20, row: 13 }
    const relief = { column: 20, row: 17 }
    placeTestSquad(state, 'player', intruder, spearmen(2))
    placeTestSquad(state, ownerId, ranged, archers(10))
    placeTestSquad(state, ownerId, relief, {
      militia: 0, spearmen: 0, archers: 0, knights: 8,
    })

    const run = runFrozenTacticalRounds(state, 'svyatobor', {
      ...createAiMemory(), targetOwnerId: 'player', phase: 'defense',
    }, 'defense', 3, 4)
    const reliefMoved = run.steps.some((step) => (
      step.command.type === 'move-or-attack' && positionKey(step.command.from) === positionKey(relief)
    ))
    const rangedAbandonedCore = run.steps.some((step) => (
      step.command.type === 'move-or-attack'
        && positionKey(step.command.from) === positionKey(ranged)
        && positionDistance(step.command.to, castle) > positionDistance(ranged, castle)
        && step.factors.includes('ranged-withdrawal')
    ))
    const summary = JSON.stringify({ castle, intruder, ranged, relief, steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(rangedAbandonedCore, summary).toBe(false)
    expect(reliefMoved, summary).toBe(true)
    expect(run.steps.some((step) => step.factors.includes('core-breach-response')), summary).toBe(true)
    expect(objectAt(run.state, intruder)?.ownerId, summary).not.toBe('player')
  })

  it('starts the core response one cell before the first castle attack', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const castle = { column: 20, row: 12 }
    const intruder = { column: 18, row: 12 }
    const relief = { column: 20, row: 17 }
    placeTestSquad(state, 'player', intruder, spearmen(2))
    placeTestSquad(state, ownerId, relief, {
      militia: 5, spearmen: 3, archers: 0, knights: 0,
    })
    const run = runFrozenTactics(state, 'svyatobor', {
      ...createAiMemory(), targetOwnerId: 'player', phase: 'defense',
    }, 'defense', 1)
    const summary = JSON.stringify({ castle, intruder, relief, steps: run.steps })

    expect(positionDistance(intruder, castle)).toBe(aiTacticalConfig.defense.coreBreachRadius)
    expect(run.steps[0]?.factors, summary).toContain('core-breach-response')
    expect(run.steps[0]?.command.type, summary).toBe('move-or-attack')
  })

  it('allows a forced backtrack when it is the only route to a castle breach', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const intruder = { column: 19, row: 12 }
    const defender = { column: 20, row: 7 }
    const forcedStep = { column: 19, row: 7 }
    placeTestSquad(state, 'player', intruder, spearmen(2))
    placeTestSquad(state, ownerId, defender, {
      militia: 5, spearmen: 2, archers: 0, knights: 0,
    })
    for (const position of [
      { column: 20, row: 6 },
      { column: 21, row: 7 },
      { column: 20, row: 8 },
    ]) placeTestBuilding(state, ownerId, 'wall', position)
    const run = runFrozenTactics(state, 'svyatobor', {
      ...createAiMemory(),
      targetOwnerId: 'player',
      phase: 'defense',
      recentMovements: [{ from: forcedStep, to: defender, turn: state.turn - 1 }],
    }, 'defense', 1)
    const summary = JSON.stringify({ steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(run.steps[0]?.command, summary).toEqual({
      type: 'move-or-attack', from: defender, to: forcedStep,
    })
    expect(run.steps[0]?.factors, summary).toContain('core-breach-response')
  })

  it('lets a lone militia approach through safety but not enter guaranteed archer destruction', () => {
    const state = startAiTurn('radomir')
    const ownerId = state.activeParticipantId
    const militiaPosition = { column: 18, row: 14 }
    const archersPosition = { column: 18, row: 12 }
    placeTestSquad(state, ownerId, militiaPosition, {
      militia: 1, spearmen: 0, archers: 0, knights: 0,
    })
    placeTestSquad(state, 'player', archersPosition, archers(6))
    const run = runFrozenTactics(state, 'radomir', {
      ...createAiMemory(), targetOwnerId: 'player', phase: 'defense',
    }, 'defense', 4)
    const summary = JSON.stringify({ militiaPosition, archersPosition, steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(run.steps.some((step) => step.command.type === 'move-or-attack'
      && positionKey(step.command.to) === positionKey(archersPosition)), summary).toBe(false)
    expect(aiObjectEntries(run.state.scenario, ownerId).some((entry) => (
      entry.object.type === 'squad' && entry.object.units.militia === 1
    )), summary).toBe(true)
  })

  it('reinforces an existing militia group instead of opening another one-unit stream', () => {
    const state = startAiTurn('radomir')
    const ownerId = state.activeParticipantId
    const barracks = { column: 18, row: 15 }
    const formation = { column: 20, row: 15 }
    placeTestBuilding(state, ownerId, 'barracks', barracks)
    placeTestSquad(state, ownerId, formation, {
      militia: 1, spearmen: 0, archers: 0, knights: 0,
    })
    placeTestSquad(state, 'player', { column: 18, row: 12 }, archers(6))
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      population: 3,
      resources: { ...state.domains[ownerId].resources, iron: 0 },
    }

    const candidate = recruitmentCandidate(
      state, aiProfiles.radomir, 'defense', () => true, createAiMemory(),
    )
    const summary = JSON.stringify({ candidate })

    expect(candidate?.command, summary).toEqual({
      type: 'recruit', troop: 'militia', quantity: 1, position: formation,
    })
  })

  it('concentrates adjacent weak defenders when that closes the known power gap', () => {
    const state = startAiTurn('radomir')
    const ownerId = state.activeParticipantId
    const first = { column: 18, row: 14 }
    const second = { column: 19, row: 14 }
    placeTestSquad(state, ownerId, first, { militia: 1, spearmen: 0, archers: 0, knights: 0 })
    placeTestSquad(state, ownerId, second, { militia: 1, spearmen: 0, archers: 0, knights: 0 })
    placeTestSquad(state, 'player', { column: 18, row: 12 }, archers(6))
    const run = runFrozenTactics(state, 'radomir', {
      ...createAiMemory(), targetOwnerId: 'player', phase: 'defense',
    }, 'defense', 1)
    const summary = JSON.stringify({ steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(run.steps[0]?.command, summary).toEqual({ type: 'move-or-attack', from: first, to: second })
    expect(run.steps[0]?.factors.some((factor) => factor.startsWith('defense-concentration:')), summary).toBe(true)
  })

  it('leaves an archer firing lane through forest cover when contact is not possible this turn', () => {
    const state = startAiTurn('radomir')
    const ownerId = state.activeParticipantId
    const defender = { column: 22, row: 10 }
    const archerLine = { column: 12, row: 10 }
    for (let column = 13; column <= 22; column += 1) {
      state.scenario.cells[9][column] = {
        ...state.scenario.cells[9][column],
        vegetation: true,
      }
      state.scenario.cells[11][column] = {
        ...state.scenario.cells[11][column],
        landform: 'peak',
        elevation: 0.9,
        vegetation: false,
      }
    }
    placeTestSquad(state, ownerId, defender, {
      militia: 5, spearmen: 0, archers: 0, knights: 0,
    })
    placeTestSquad(state, 'player', archerLine, archers(8))
    const run = runFrozenTactics(state, 'radomir', {
      ...createAiMemory(), targetOwnerId: 'player', phase: 'defense',
    }, 'defense', 2)
    const second = run.steps[1]
    const summary = JSON.stringify({ steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(second?.command, summary).toEqual({
      type: 'move-or-attack', from: { column: 21, row: 10 }, to: { column: 21, row: 9 },
    })
    expect(state.scenario.cells[9][21].vegetation, summary).toBe(true)
  })

  it('rushes directly through an archer lane when it can win contact before the reply turn', () => {
    const state = startAiTurn('radomir')
    const ownerId = state.activeParticipantId
    const defender = { column: 21, row: 10 }
    const archerLine = { column: 13, row: 10 }
    for (let column = 13; column <= 21; column += 1) {
      state.scenario.cells[9][column] = {
        ...state.scenario.cells[9][column], vegetation: true,
      }
    }
    placeTestSquad(state, ownerId, defender, {
      militia: 10, spearmen: 0, archers: 0, knights: 0,
    })
    placeTestSquad(state, 'player', archerLine, archers(4))
    const run = runFrozenTactics(state, 'radomir', {
      ...createAiMemory(), targetOwnerId: 'player', phase: 'defense',
    }, 'defense', 8)
    const summary = JSON.stringify({ steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(run.steps[0]?.command, summary).toEqual({
      type: 'move-or-attack', from: defender, to: { column: 20, row: 10 },
    })
    expect(run.steps.some((step) => step.command.type === 'move-or-attack'
      && positionKey(step.command.to) === positionKey(archerLine)), summary).toBe(true)
    expect(run.steps.slice(0, -1).every((step) => (
      step.factors.includes('committed-defense-contact')
    )), summary).toBe(true)
  })

  it('spends the combat turn finishing a viable interception at an attacked barracks', () => {
    const state = startAiTurn('radomir')
    const ownerId = state.activeParticipantId
    const barracks = { column: 18, row: 15 }
    const formation = { column: 18, row: 14 }
    const archersPosition = { column: 18, row: 12 }
    placeTestBuilding(state, ownerId, 'barracks', barracks)
    placeTestSquad(state, ownerId, formation, {
      militia: 5, spearmen: 0, archers: 0, knights: 0,
    })
    placeTestSquad(state, 'player', archersPosition, archers(5))
    expect(immediateCriticalAssetAttackFor(state, ownerId).threatened).toBe(true)

    const run = runAiScenario(state, 'radomir', { turns: 1, mode: 'full' })
    const turn = run.turns[0]
    const movements = turn?.executed.filter((command) => command.type === 'move-or-attack') ?? []
    const summary = JSON.stringify({ turn, movements })

    expect(turn?.phase, summary).toBe('defense')
    expect(movements.some((command) => command.type === 'move-or-attack'
      && positionKey(command.from) === positionKey(formation)
      && positionKey(command.to) === positionKey({ column: 18, row: 13 })), summary).toBe(true)
    expect(movements.some((command) => command.type === 'move-or-attack'
      && positionKey(command.to) === positionKey(archersPosition)), summary).toBe(true)
    expect(turn?.trace.some((entry) => entry.factors.includes('committed-defense-contact')), summary).toBe(true)
  })

  it('defends a castle under immediate attack before searching an emergency economy', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const intruder = { column: 19, row: 12 }
    const nearRelief = { column: 20, row: 14 }
    const fieldRelief = { column: 20, row: 17 }
    placeTestSquad(state, 'player', intruder, spearmen(2))
    placeTestSquad(state, ownerId, nearRelief, archers(4))
    placeTestSquad(state, ownerId, fieldRelief, {
      militia: 4, spearmen: 4, archers: 0, knights: 0,
    })
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      resources: {
        ...state.domains[ownerId].resources,
        flour: 0, meat: 0, fruit: 0, gold: 0,
      },
    }
    expect(immediateCriticalAssetAttackFor(state, ownerId).threatened).toBe(true)

    const run = runAiScenario(state, 'svyatobor', { turns: 1, mode: 'full' })
    const turn = run.turns[0]
    const summary = JSON.stringify({ turn })

    expect(turn?.phase, summary).toBe('defense')
    expect(turn?.executed[0]?.type, summary).toBe('move-or-attack')
    expect(turn?.trace.find((entry) => entry.command === turn?.executed[0])?.factors, summary)
      .toContain('core-breach-response')
    expect(turn?.executed.some((command) => command.type === 'move-or-attack'), summary).toBe(true)
  })

  it('intercepts at the border but does not turn a defensive response into a deep invasion', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    placeTestSquad(state, ownerId, { column: 12, row: 10 }, spearmen(4), { health: 5.4 })
    placeTestSquad(state, 'player', { column: 8, row: 10 }, spearmen(2), { health: 2.7 })
    const run = runFrozenTacticalRounds(state, 'svyatobor', {
      ...createAiMemory(), targetOwnerId: 'player', phase: 'defense',
    }, 'defense', 3, 8)
    const defenders = ownedSquads(run.state, ownerId)
    const summary = JSON.stringify({ steps: run.steps, defenders: defenders.map((entry) => entry.position) })

    expect(run.failures, summary).toEqual([])
    expect(run.steps.some((step) => step.command.type === 'move-or-attack'
      && step.command.to.column === 11), summary).toBe(true)
    expect(defenders.every((entry) => entry.position.column >= 11), summary).toBe(true)
  })

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

  it.each(['velislava', 'svyatobor'] as const)('%s constructs its profile-specific fortification before optional outworks', (profileId) => {
    const fixture = createFortressConstructionState(profileId, 'mountain-pass')
    const run = runAiScenario(fixture.state, profileId, {
      turns: profileId === 'svyatobor' ? 52 : 24,
      mode: 'development-only',
      cachedAnalysis: fixture.analysis,
    })
    const summary = constructionSummary(profileId, run)
    const events = buildEvents(run)
    const gateIndex = events.findIndex((event) => event.kind === 'barbican')
    const wallIndexes = events.flatMap((event, index) => event.kind === 'wall' ? [index] : [])
    const coreKeys = new Set([fixture.line.gate, ...fixture.line.walls, ...fixture.line.towers].map(positionKey))
    const coreEventIndexes = events.flatMap((event, index) => coreKeys.has(positionKey(event.position)) ? [index] : [])
    const coreWallIndexes = events.flatMap((event, index) => (
      event.kind === 'wall' && coreKeys.has(positionKey(event.position)) ? [index] : []
    ))
    const towerEvents = events.filter((event) => event.kind === 'tower')

    expectLegalConstruction(profileId, run)
    expect(gateIndex, summary).toBeGreaterThanOrEqual(0)
    expect(fixture.line.kind, summary).toBe(profileId === 'svyatobor' ? 'enclosure' : 'terrain-gate')
    expect(coreWallIndexes, summary).toHaveLength(fixture.line.walls.length)
    expect(Math.min(...coreWallIndexes), summary).toBeGreaterThan(gateIndex)
    expect(objectAt(run.state, fixture.line.gate), summary).toMatchObject({
      type: 'building', kind: 'barbican', ownerId: fixture.ownerId,
    })
    fixture.line.walls.forEach((position) => {
      expect(objectAt(run.state, position), summary).toMatchObject({
        type: 'building', kind: 'wall', ownerId: fixture.ownerId,
      })
    })
    const lineCells = [fixture.line.gate, ...fixture.line.walls, ...fixture.line.towers]
    if (profileId === 'velislava') {
      const mountainContacts = lineCells.filter((position) => [
        { column: position.column - 1, row: position.row },
        { column: position.column + 1, row: position.row },
        { column: position.column, row: position.row - 1 },
        { column: position.column, row: position.row + 1 },
      ].some((neighbor) => run.state.scenario.cells[neighbor.row]?.[neighbor.column]?.landform === 'peak'))
      expect(mountainContacts.length, summary).toBeGreaterThanOrEqual(2)
      expect(wallIndexes, summary).toHaveLength(fixture.line.walls.length)
      expect(towerEvents, summary).toEqual([])
      return
    }
    const columns = lineCells.map((position) => position.column)
    const rows = lineCells.map((position) => position.row)
    const left = Math.min(...columns)
    const right = Math.max(...columns)
    const top = Math.min(...rows)
    const bottom = Math.max(...rows)
    const perimeter = new Set(lineCells.map(positionKey))
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        if (row !== top && row !== bottom && column !== left && column !== right) continue
        expect(perimeter.has(positionKey({ column, row })), summary).toBe(true)
      }
    }
    expect(left, summary).toBeLessThan(fixture.analysis.castle.column)
    expect(right, summary).toBeGreaterThan(fixture.analysis.castle.column)
    expect(top, summary).toBeLessThan(fixture.analysis.castle.row)
    expect(bottom, summary).toBeGreaterThan(fixture.analysis.castle.row)
    expect(fixture.line.walls.some((position) => position.row === fixture.analysis.castle.row), summary).toBe(true)
    expect(fixture.line.walls.some((position) => position.column === fixture.analysis.castle.column), summary).toBe(true)
    const allLines = fixture.state.aiMemory[fixture.ownerId].settlementPlan?.fortification?.lines ?? []
    expect(towerEvents, summary).toHaveLength(
      allLines.reduce((sum, line) => sum + line.towers.length, 0) + Number(Boolean(fixture.outpost)),
    )
    const firstTowerIndex = events.findIndex((event) => event.kind === 'tower')
    expect(firstTowerIndex, summary).toBeGreaterThan(gateIndex)
    expect(coreWallIndexes.filter((index) => index < firstTowerIndex), summary)
      .toHaveLength(aiStrategicConfig.buildingGoals.minimumViableFortificationWalls)
    expect(firstTowerIndex, summary).toBeLessThan(Math.max(...coreWallIndexes))
    fixture.line.towers.forEach((position) => {
      expect(objectAt(run.state, position), summary).toMatchObject({
        type: 'building', kind: 'tower', ownerId: fixture.ownerId,
      })
    })
    expect(fixture.outpost, summary).toBeDefined()
    if (fixture.outpost) {
      expect(towerEvents.some((event) => positionKey(event.position) === positionKey(fixture.outpost!)), summary).toBe(true)
      expect(objectAt(run.state, fixture.outpost), summary).toMatchObject({
        type: 'building', kind: 'tower', ownerId: fixture.ownerId,
      })
      expect(positionDistance(fixture.outpost, fixture.analysis.castle), summary)
        .toBeGreaterThanOrEqual(aiSpatialConfig.settlementPlan.fortification.outpostMinimumCastleDistance)
      expect(run.state.scenario.cells[fixture.outpost.row][fixture.outpost.column].landform, summary).toBe('hill')
    }
    const surplusLine = allLines.find((line) => line.purpose === 'surplus')
    expect(surplusLine, summary).toBeDefined()
    if (surplusLine) {
      const surplusGateIndex = events.findIndex((event) => event.kind === 'barbican'
        && positionKey(event.position) === positionKey(surplusLine.gate))
      expect(surplusGateIndex, summary).toBeGreaterThan(Math.max(...coreEventIndexes))
      for (const position of [surplusLine.gate, ...surplusLine.walls, ...surplusLine.towers]) {
        expect(objectAt(run.state, position), summary).toMatchObject({
          type: 'building', ownerId: fixture.ownerId,
        })
      }
    }
  }, 60_000)

  it('finishes a combat tower when an invader holds the breached gate blueprint', () => {
    const fixture = createFortressConstructionState('svyatobor', 'mountain-pass')
    const { state, ownerId, line } = fixture
    state.activeParticipantId = ownerId
    line.walls.slice(0, aiStrategicConfig.buildingGoals.minimumViableFortificationWalls)
      .forEach((position) => placeTestBuilding(state, ownerId, 'wall', position))
    placeTestSquad(state, 'player', line.gate, spearmen(3), { health: 4.05 })
    const memory = state.aiMemory[ownerId]

    expect(nextFortificationStep(state, memory, false)).toBe('barbican')
    expect(nextFortificationStep(state, memory, true)).toBe('tower')
  })

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
    const reservedDefense = new Set(settlementPlan.fortification?.lines
      .flatMap((line) => [line.gate, ...line.walls, ...line.towers])
      .map(positionKey) ?? [])
    const firstStart = openPositionAtDistance(state, castleTower, 2, reservedDefense)
    const secondStart = openPositionAtDistance(state, outpostTower, 2, reservedDefense)
    if (!firstStart || !secondStart || positionKey(firstStart) === positionKey(secondStart)) {
      throw new Error('Could not place distinct archer detachments')
    }
    placeTestSquad(state, ownerId, firstStart, archers(3), { health: 3 })
    placeTestSquad(state, ownerId, secondStart, archers(3), { health: 3 })
    const memory = {
      ...createAiMemory(), settlementPlan, targetOwnerId: 'player', phase: 'mobilization' as const,
    }
    const run = runFrozenTacticalRounds(state, 'svyatobor', memory, 'mobilization', 3, 12)
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

  it('keeps a peacetime guard anchored on the remote outpost tower', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing defense analysis')
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor)
    const outpost = settlementPlan.reservedSites.outpostTower
    if (!outpost) throw new Error('Svyatobor fixture must reserve a remote outpost tower')
    placeTestBuilding(state, ownerId, 'tower', outpost)
    // Place one squad already near the outpost and two farther back, so the
    // test checks the anchoring decision rather than long-distance pathing.
    const near = { column: outpost.column, row: outpost.row + 2 }
    const starts = [near, { column: 21, row: 10 }, { column: 22, row: 12 }]
    starts.forEach((position) => placeTestSquad(state, ownerId, position, spearmen(2), { health: 2.7 }))
    const memory = {
      ...createAiMemory(), settlementPlan, targetOwnerId: 'player', phase: 'mobilization' as const,
    }
    const run = runFrozenTactics(state, 'svyatobor', memory, 'mobilization', 8)
    const squads = ownedSquads(run.state, ownerId)
    const summary = JSON.stringify({ outpost, near, steps: run.steps, squads: squads.map((squad) => squad.position) })

    expect(run.failures, summary).toEqual([])
    // The outpost tower is remote and valuable; a squad must stay anchored on
    // it instead of every unit drifting back toward the castle.
    expect(squads.some((squad) => positionDistance(squad.position, outpost) <= 2), summary).toBe(true)
  })

  it('never liquidates a planned fortification wall/tower/barbican during an economic recovery', () => {
    const fixture = createFortressConstructionState('svyatobor', 'mountain-pass')
    const { state, ownerId, line, outpost } = fixture
    // Build the complete planned fortification line so every planned cell exists
    // and is therefore a candidate for liquidation if the guard is missing.
    placeTestBuilding(state, ownerId, 'barbican', line.gate)
    line.walls.forEach((position) => placeTestBuilding(state, ownerId, 'wall', position))
    line.towers.forEach((position) => placeTestBuilding(state, ownerId, 'tower', position))
    if (outpost) placeTestBuilding(state, ownerId, 'tower', outpost)
    // Push the domain into a recovery state: gold below upkeep so
    // economicEmergencyFor is true and demolitionCandidate enters liquidation.
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      resources: {
        ...state.domains[ownerId].resources,
        wood: 40, stone: 30, ore: 0, iron: 0,
        flour: 2, meat: 0, fruit: 2, gold: 0,
      },
    }
    const run = runAiScenario(state, 'svyatobor', { turns: 6, mode: 'development-only', cachedAnalysis: fixture.analysis })
    const summary = JSON.stringify({
      line, outpost,
      builds: buildEvents(run),
      demolishes: run.turns.flatMap((turn) => turn.executed.filter((command) => command.type === 'demolish')),
      failures: run.turns.flatMap((turn) => turn.failures.map((failure) => ({ turn: turn.turn, ...failure }))),
    })
    const plannedCells = [line.gate, ...line.walls, ...line.towers, ...(outpost ? [outpost] : [])]
    const demolished = run.turns.flatMap((turn) => turn.executed.flatMap((command) => (
      command.type === 'demolish' ? [command.position] : []
    )))
    // No planned fortification cell may be demolished even under economic stress.
    expect(demolished.some((position) => plannedCells.some((planned) => (
      position.column === planned.column && position.row === planned.row
    ))), summary).toBe(false)
    // The planned line itself must still stand intact at the end.
    expect(objectAt(run.state, line.gate), summary).toMatchObject({ type: 'building', kind: 'barbican' })
    line.walls.forEach((position) => {
      expect(objectAt(run.state, position), summary).toMatchObject({ type: 'building', kind: 'wall' })
    })
  })

  it('recognizes a remote raid as a home threat and sends a field squad to intercept it', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    if (!analysis) throw new Error('Missing defense analysis')
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor)
    const mine = { column: 18, row: 6 }
    const raider = { column: 14, row: 6 }
    const defender = { column: 19, row: 12 }
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
