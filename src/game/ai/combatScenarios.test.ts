import { describe, expect, it } from 'vitest'
import { buildingRules } from '../../config/rules'
import { objectAt, squadSize } from '../match'
import type { AiProfileId } from '../scenario'
import { aiObjectEntries, positionKey } from './analysis'
import { createAiMemory } from './model'
import {
  militia,
  placeTestBuilding,
  placeTestSquad,
  startAiTurn,
} from './testing/scenarioFixtures'
import { runFrozenTacticalRounds, runFrozenTactics } from './testing/scenarioHarness'

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

function relocatePlayerCastle(state: ReturnType<typeof startAiTurn>, position: { column: number; row: number }) {
  state.scenario.cells.forEach((row) => row.forEach((cell) => {
    if (cell.object?.type === 'castle' && cell.object.ownerId === 'player') cell.object = undefined
  }))
  state.scenario.cells[position.row][position.column] = {
    ...state.scenario.cells[position.row][position.column],
    landform: 'plain',
    vegetation: false,
    object: { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 },
  }
}

function runSummary(run: ReturnType<typeof runFrozenTactics>) {
  return JSON.stringify({ steps: run.steps, failures: run.failures, exploredNodes: run.exploredNodes })
}

describe('authored AI combat scenarios', () => {
  it.each(profiles)('%s takes the forest detour without chipping the healthy wall', (profileId) => {
    const { state, blocker } = prepareTwoLaneAssault(profileId, 'wall')
    const initialWall = objectAt(state, blocker)
    const run = runFrozenTactics(state, profileId, assaultMemory('player'), 'assault', 8)
    const destinations = run.steps.flatMap(({ command }) => command.type === 'move-or-attack' ? [command.to] : [])
    const summary = runSummary(run)

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
    const summary = runSummary(run)

    expect(run.failures, summary).toEqual([])
    expect(attacksGate, summary).toBe(true)
    expect(objectAt(run.state, blocker), summary).not.toMatchObject({ type: 'building', kind: 'barbican', ownerId: 'player' })
  })

  it.each([
    { side: 'east', attackerColumn: 18, frontGateColumn: 14, rearGateColumn: 10 },
    { side: 'west', attackerColumn: 6, frontGateColumn: 10, rearGateColumn: 14 },
  ])('breaches the $side-facing barbican, crosses the curtain, and leaves the rear gate intact', ({
    attackerColumn, frontGateColumn, rearGateColumn,
  }) => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    state.turn = 20
    relocatePlayerCastle(state, { column: 12, row: 12 })
    const frontGate = { column: frontGateColumn, row: 12 }
    const rearGate = { column: rearGateColumn, row: 12 }
    for (const column of [10, 14]) {
      for (let row = 10; row <= 14; row += 1) {
        placeTestBuilding(state, 'player', row === 12 ? 'barbican' : row === 10 || row === 14 ? 'tower' : 'wall', { column, row })
      }
    }
    for (let column = 11; column <= 13; column += 1) {
      placeTestBuilding(state, 'player', 'wall', { column, row: 10 })
      placeTestBuilding(state, 'player', 'wall', { column, row: 14 })
    }
    placeTestSquad(state, ownerId, { column: attackerColumn, row: 12 }, spearmen(8), { health: 10.8 })
    const run = runFrozenTactics(state, 'svyatobor', assaultMemory('player'), 'assault', 8)
    const summary = runSummary(run)
    const firstStructureStrike = run.steps.find((step) => step.event?.kind === 'attacked'
      || step.event?.kind === 'destroyed')

    expect(run.failures, summary).toEqual([])
    expect(firstStructureStrike?.command, summary).toMatchObject({ type: 'move-or-attack', to: frontGate })
    expect(objectAt(run.state, frontGate), summary).not.toMatchObject({ type: 'building', ownerId: 'player' })
    expect(objectAt(run.state, rearGate), summary).toMatchObject({
      type: 'building', kind: 'barbican', ownerId: 'player', hitPoints: buildingRules.barbican.hitPoints,
    })
    expect(run.steps.some((step) => step.command.type === 'move-or-attack'
      && step.command.from.column === frontGate.column && step.command.from.row === frontGate.row), summary).toBe(true)
  })

  it('uses a covered detour instead of marching through a garrisoned tower kill-zone', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    state.turn = 20
    relocatePlayerCastle(state, { column: 3, row: 10 })
    for (let column = 1; column <= 13; column += 1) {
      state.scenario.cells[9][column] = { ...state.scenario.cells[9][column], landform: 'peak', vegetation: false, object: undefined }
      state.scenario.cells[12][column] = { ...state.scenario.cells[12][column], landform: 'peak', vegetation: false, object: undefined }
    }
    for (let row = 0; row < state.scenario.cells.length; row += 1) {
      state.scenario.cells[row][13] = { ...state.scenario.cells[row][13], landform: 'peak', vegetation: false, object: undefined }
    }
    state.scenario.territories.forEach((row) => {
      for (let column = 0; column <= 12; column += 1) row[column] = 'region-0'
    })
    for (let column = 7; column <= 9; column += 1) state.scenario.cells[10][column].vegetation = true
    const tower = { column: 2, row: 11 }
    placeTestBuilding(state, 'player', 'tower', tower, { garrison: { archers: 5, health: 5 } })
    placeTestSquad(state, ownerId, { column: 12, row: 11 }, spearmen(5), { health: 6.75 })

    const run = runFrozenTactics(state, 'svyatobor', assaultMemory('player'), 'assault', 7)
    const summary = runSummary(run)
    const destinations = run.steps.flatMap((step) => step.command.type === 'move-or-attack' ? [step.command.to] : [])

    expect(run.failures, summary).toEqual([])
    expect(destinations.some((position) => position.row === 10), summary).toBe(true)
    expect(destinations.some((position) => state.scenario.cells[position.row][position.column].vegetation), summary).toBe(true)
    expect(objectAt(run.state, tower), summary).toMatchObject({
      type: 'building', kind: 'tower', hitPoints: buildingRules.tower.hitPoints,
    })
  })

  it('destroys a garrisoned tower when it is the only viable breach, then advances through its cell', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    state.turn = 20
    relocatePlayerCastle(state, { column: 3, row: 11 })
    for (let column = 1; column <= 13; column += 1) {
      state.scenario.cells[10][column] = { ...state.scenario.cells[10][column], landform: 'peak', vegetation: false, object: undefined }
      state.scenario.cells[12][column] = { ...state.scenario.cells[12][column], landform: 'peak', vegetation: false, object: undefined }
    }
    for (let row = 0; row < state.scenario.cells.length; row += 1) {
      state.scenario.cells[row][13] = { ...state.scenario.cells[row][13], landform: 'peak', vegetation: false, object: undefined }
    }
    state.scenario.territories.forEach((row) => {
      for (let column = 0; column <= 12; column += 1) row[column] = 'region-0'
    })
    const tower = { column: 7, row: 11 }
    placeTestBuilding(state, 'player', 'tower', tower, { garrison: { archers: 5, health: 5 } })
    placeTestSquad(state, ownerId, { column: 12, row: 11 }, spearmen(8), { health: 10.8 })

    const run = runFrozenTacticalRounds(state, 'svyatobor', assaultMemory('player'), 'assault', 2, 8)
    const summary = runSummary(run)
    const attackedPositions = run.steps.flatMap((step) => (
      step.event?.kind === 'attacked' || step.event?.kind === 'destroyed' ? [step.event.position] : []
    ))

    expect(run.failures, summary).toEqual([])
    expect(attackedPositions[0], summary).toEqual(tower)
    expect(objectAt(run.state, tower), summary).not.toMatchObject({ type: 'building', ownerId: 'player' })
    expect(run.steps.some((step) => step.command.type === 'move-or-attack'
      && step.command.from.column === tower.column && step.command.from.row === tower.row), summary).toBe(true)
    expect(objectAt(run.state, { column: 3, row: 11 }), summary).toMatchObject({ type: 'castle', ownerId: 'player' })
  })

  it('sends a cheap probe to destroy exposed food production but refuses the raid under a strong response', () => {
    const prepareRaid = (protectedTarget: boolean) => {
      const state = startAiTurn('velislava')
      const ownerId = state.activeParticipantId
      state.turn = 20
      const raiders = { column: 13, row: 16 }
      const orchard = { column: 9, row: 16 }
      for (let column = 0; column <= raiders.column; column += 1) state.scenario.territories[raiders.row][column] = 'region-0'
      placeTestSquad(state, ownerId, raiders, spearmen(3), { health: 4.05 })
      placeTestBuilding(state, 'player', 'orchard', orchard)
      if (protectedTarget) {
        placeTestSquad(state, 'player', { column: 9, row: 15 }, {
          militia: 8, spearmen: 4, archers: 2, knights: 0,
        }, { health: 15.4 })
      }
      return { state, orchard }
    }
    const exposed = prepareRaid(false)
    const exposedRun = runFrozenTactics(exposed.state, 'velislava', {
      ...assaultMemory('player'), wave: 'probe',
    }, 'assault', 8)
    const protectedRaid = prepareRaid(true)
    const protectedRun = runFrozenTactics(protectedRaid.state, 'velislava', {
      ...assaultMemory('player'), wave: 'probe',
    }, 'assault', 8)
    const summary = JSON.stringify({ exposed: exposedRun.steps, protected: protectedRun.steps })

    expect(exposedRun.failures, summary).toEqual([])
    expect(protectedRun.failures, summary).toEqual([])
    expect(exposedRun.steps.some((step) => step.factors.includes('raid-target')), summary).toBe(true)
    expect(objectAt(exposedRun.state, exposed.orchard), summary).not.toMatchObject({ type: 'building', kind: 'orchard' })
    expect(protectedRun.steps.some((step) => step.factors.some((factor) => factor.startsWith('raid:'))), summary).toBe(false)
    expect(objectAt(protectedRun.state, protectedRaid.orchard), summary).toMatchObject({
      type: 'building', kind: 'orchard', hitPoints: buildingRules.orchard.hitPoints,
    })
  })

  it('finishes a vulnerable field squad before resuming the march on the castle', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const attacker = { column: 13, row: 12 }
    const weak = { column: 12, row: 12 }
    placeTestSquad(state, ownerId, attacker, spearmen(3), { health: 4.05 })
    placeTestSquad(state, 'player', weak, militia(2), { health: 0.6 })

    const run = runFrozenTactics(state, 'svyatobor', assaultMemory('player'), 'assault', 1)
    const summary = runSummary(run)

    expect(run.steps[0]?.command, summary).toEqual({ type: 'move-or-attack', from: attacker, to: weak })
    expect(run.steps[0]?.factors.some((factor) => factor.startsWith('finisher:')), summary).toBe(true)
    expect(objectAt(run.state, attacker), summary).toMatchObject({ type: 'squad', ownerId })
    expect(objectAt(run.state, weak), summary).toBeUndefined()
  })

  it('uses seeded tactical variety for a cheap building on the march instead of replaying one fixed choice', () => {
    const runs = Array.from({ length: 16 }, (_, index) => {
      const state = startAiTurn('velislava')
      state.scenario.seed = 200 + index
      state.turn = 20
      state.scenario.territories[10][12] = 'region-0'
      state.scenario.territories[11][12] = 'region-0'
      const ownerId = state.activeParticipantId
      const attacker = { column: 12, row: 11 }
      const house = { column: 12, row: 10 }
      placeTestSquad(state, ownerId, attacker, spearmen(5), { health: 6.75 })
      placeTestBuilding(state, 'player', 'house', house, { hitPoints: 1 })
      return runFrozenTactics(state, 'velislava', assaultMemory('player'), 'assault', 1)
    })
    const firstCommands = runs.map((run) => run.steps[0]?.command)
    const strikes = firstCommands.filter((command) => command?.type === 'move-or-attack'
      && command.to.column === 12 && command.to.row === 10)

    runs.forEach((run) => {
      expect(run.failures, runSummary(run)).toEqual([])
      expect(run.steps, runSummary(run)).toHaveLength(1)
    })
    expect(strikes.length).toBeGreaterThan(0)
    expect(strikes.length).toBeLessThan(firstCommands.length)

    const replay = Array.from({ length: 2 }, () => {
      const state = startAiTurn('velislava')
      state.scenario.seed = 203
      state.turn = 20
      state.scenario.territories[10][12] = 'region-0'
      state.scenario.territories[11][12] = 'region-0'
      placeTestSquad(state, state.activeParticipantId, { column: 12, row: 11 }, spearmen(5), { health: 6.75 })
      placeTestBuilding(state, 'player', 'house', { column: 12, row: 10 }, { hitPoints: 1 })
      return runFrozenTactics(state, 'velislava', assaultMemory('player'), 'assault', 1).steps[0]?.command
    })
    expect(replay[1]).toEqual(replay[0])
  })

  it('splits a balanced formation only when two genuinely different assault routes are available', () => {
    const prepare = (dividedMap: boolean, strongDefender: boolean) => {
      const state = startAiTurn('velislava')
      const ownerId = state.activeParticipantId
      const source = { column: 18, row: 12 }
      placeTestSquad(state, ownerId, source, {
        militia: 2, spearmen: 4, archers: 4, knights: 0,
      }, { health: 11.4 })
      if (dividedMap) {
        for (let row = 4; row <= 19; row += 1) {
          state.scenario.cells[row][10] = {
            ...state.scenario.cells[row][10], landform: 'peak', vegetation: false, object: undefined,
          }
        }
      }
      if (strongDefender) placeTestSquad(state, 'player', { column: 7, row: 10 }, militia(12), { health: 12 })
      return { state, source }
    }
    const divided = prepare(true, false)
    const splitRun = runFrozenTactics(divided.state, 'velislava', assaultMemory('player'), 'assault', 1)
    const concentrated = prepare(false, true)
    const concentratedRun = runFrozenTactics(concentrated.state, 'velislava', assaultMemory('player'), 'assault', 1)
    const summary = JSON.stringify({ split: splitRun.steps, concentrated: concentratedRun.steps })
    const split = splitRun.steps[0]?.command

    expect(splitRun.failures, summary).toEqual([])
    expect(concentratedRun.failures, summary).toEqual([])
    expect(split?.type, summary).toBe('split')
    expect(aiObjectEntries(splitRun.state.scenario, splitRun.state.activeParticipantId)
      .filter((entry) => entry.object.type === 'squad'), summary).toHaveLength(2)
    if (split?.type === 'split') {
      const detached = objectAt(splitRun.state, split.to)
      const remaining = objectAt(splitRun.state, split.from)
      expect(detached?.type === 'squad' ? squadSize(detached) : 0).toBeGreaterThan(0)
      expect(remaining?.type === 'squad' ? squadSize(remaining) : 0).toBeGreaterThan(0)
      expect(detached?.type === 'squad' ? detached.units.archers : 0).toBeGreaterThan(0)
      expect(remaining?.type === 'squad' ? remaining.units.archers : 0).toBeGreaterThan(0)
    }
    expect(concentratedRun.steps, summary).toHaveLength(1)
    expect(concentratedRun.steps[0].command.type, summary).not.toBe('split')
  })

  it('weighs enemy archer fire when choosing which squad to attack', () => {
    // Two weak enemy squads are both adjacent to our strong attacker. One sits
    // on a clear line from a covering enemy archer detachment (so the worst-
    // case reply includes incoming ranged fire); the other is shielded by a
    // peak. The attacker must prefer the shielded target now that ranged
    // replies are counted in worstReplyPenalty.
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    state.turn = 20
    relocatePlayerCastle(state, { column: 3, row: 12 })
    const attacker = { column: 12, row: 12 }
    const exposedTarget = { column: 12, row: 11 }
    const shieldedTarget = { column: 12, row: 13 }
    const archerCover = { column: 12, row: 7 }
    // Clear the column between the archer cover and the exposed target so the
    // ranged line is unobstructed; place a peak between cover and shielded.
    for (let row = 8; row <= 10; row += 1) {
      state.scenario.cells[row][12] = { ...state.scenario.cells[row][12], landform: 'plain', vegetation: false, object: undefined }
    }
    placeTestSquad(state, ownerId, attacker, spearmen(8), { health: 10.8 })
    placeTestSquad(state, 'player', exposedTarget, militia(2), { health: 2 })
    placeTestSquad(state, 'player', shieldedTarget, militia(2), { health: 2 })
    placeTestSquad(state, 'player', archerCover, { militia: 0, spearmen: 0, archers: 4, knights: 0 }, { health: 4 })
    const run = runFrozenTactics(state, 'svyatobor', assaultMemory('player'), 'assault', 1)
    const summary = JSON.stringify({ attacker, exposedTarget, shieldedTarget, archerCover, steps: run.steps, failures: run.failures })

    const firstStrike = run.steps.find((step) => step.event?.kind === 'attacked' || step.event?.kind === 'destroyed')
    expect(run.failures, summary).toEqual([])
    expect(firstStrike, summary).toBeDefined()
    expect(firstStrike?.command, summary).toMatchObject({ type: 'move-or-attack', to: shieldedTarget })
  })

  it('a scout in siege range still raids undefended economy near the enemy castle', () => {
    // A scout detachment is within siege range of the enemy castle, so the
    // main wave is 'siege'. An undefended enemy farm sits just off the route.
    // The scout should still strike it (overrun multiplier > 0) rather than
    // stand idle at the gates.
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    state.turn = 20
    relocatePlayerCastle(state, { column: 3, row: 12 })
    const scout = { column: 8, row: 12 }
    const farm = { column: 6, row: 12 }
    placeTestSquad(state, ownerId, scout, spearmen(4), { health: 5.4 })
    placeTestBuilding(state, 'player', 'farm', farm)
    const memory = {
      ...createAiMemory(),
      targetOwnerId: 'player',
      phase: 'assault' as const,
      wave: 'siege' as const,
      stableTurns: 10,
    }
    const run = runFrozenTactics(state, 'svyatobor', memory, 'assault', 8)
    const summary = JSON.stringify({ scout, farm, steps: run.steps, failures: run.failures })

    expect(run.failures, summary).toEqual([])
    expect(run.steps.some((step) => step.command.type === 'move-or-attack'
      && step.command.to.column === farm.column && step.command.to.row === farm.row), summary).toBe(true)
    expect(objectAt(run.state, farm), summary).not.toMatchObject({ type: 'building', ownerId: 'player' })
  })
})
