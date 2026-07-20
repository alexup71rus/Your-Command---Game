import { describe, expect, it } from 'vitest'
import { aiPlannerConfig, aiProfiles } from '../../config/ai'
import {
  totalArmySize,
} from '../match'
import type { AiProfileId } from '../scenario'
import { executeAiCommand, rememberAiCommandFailure } from './commands'
import { analyzeAiWorld, createSettlementPlan, positionDistance, positionKey } from './analysis'
import { createAiPerception, updateAiMemory } from './perception'
import { planAiTurn } from './planner'
import { createAiMemory } from './model'
import { desiredBuildingGoals, economicEmergencyFor, findStrategicBuildPosition, homeThreatFor, marketCandidate, nextFortificationStep, stagingAnchorsFor, strategicPhaseFor } from './strategy'
import { raidObjectivesFor } from './strategy/raids'
import { assignSquadRoles, formationSplit, tacticalCandidates } from './tactics'
import { findMovementPath } from '../pathfinding'
import { militia as units, placeTestBuilding, startAiTurn } from './testing/scenarioFixtures'

describe('AI perception and planning', () => {
  it('remembers a hidden occupied target briefly without committing speculative plan memory', () => {
    const state = startAiTurn('radomir')
    const participantId = state.activeParticipantId
    const command = {
      type: 'move-or-attack' as const,
      from: { column: 20, row: 12 },
      to: { column: 19, row: 12 },
    }
    const remembered = rememberAiCommandFailure(state, participantId, command, 'occupied')
    expect(remembered.aiMemory[participantId].blockedCells).toEqual([{
      position: command.to,
      expiresTurn: state.turn + aiPlannerConfig.blockedCellMemoryTurns,
    }])
    expect(remembered.aiMemory[participantId].lastCancellationReason).toBe('occupied')
    expect(state.aiMemory[participantId].blockedCells).toEqual([])

    const unrelated = rememberAiCommandFailure(state, participantId, command, 'not-enough-orders')
    expect(unrelated.aiMemory[participantId].blockedCells).toEqual([])
  })

  it('assigns a viable probe to an exposed economic target instead of the closest protected one', () => {
    const state = startAiTurn('velislava')
    const ownerId = state.activeParticipantId
    const squadPosition = { column: 13, row: 16 }
    state.scenario.cells[squadPosition.row][squadPosition.column].object = {
      type: 'squad',
      ownerId,
      units: { militia: 0, spearmen: 4, archers: 0, knights: 0 },
      health: 5.4,
    }
    const exposedOrchard = { column: 9, row: 16 }
    const protectedFarm = { column: 4, row: 14 }
    placeTestBuilding(state, 'player', 'orchard', exposedOrchard)
    placeTestBuilding(state, 'player', 'farm', protectedFarm)
    const memory = {
      ...createAiMemory(),
      targetOwnerId: 'player',
      phase: 'assault' as const,
      wave: 'probe' as const,
      squadRoles: { [positionKey(squadPosition)]: 'scout' as const },
    }

    const objectives = raidObjectivesFor(
      state,
      state.scenario.cells,
      aiProfiles.velislava,
      memory,
      'assault',
      () => true,
    )

    expect(objectives[positionKey(squadPosition)]?.origin).toEqual(exposedOrchard)
    expect(objectives[positionKey(squadPosition)]?.factors).toContain('raid:orchard')
    const raidMove = tacticalCandidates(
      state,
      aiProfiles.velislava,
      memory,
      'assault',
      () => true,
    ).find((candidate) => candidate.factors.includes('raid:orchard'))
    expect(raidMove?.command.type).toBe('move-or-attack')
    if (raidMove?.command.type === 'move-or-attack') {
      expect(positionDistance(raidMove.command.to, exposedOrchard))
        .toBeLessThan(positionDistance(squadPosition, exposedOrchard))
    }

    const adjacentPosition = { column: 11, row: 16 }
    const raiders = state.scenario.cells[squadPosition.row][squadPosition.column].object
    state.scenario.cells[squadPosition.row][squadPosition.column].object = undefined
    state.scenario.cells[adjacentPosition.row][adjacentPosition.column].object = raiders
    const adjacentMemory = {
      ...memory,
      squadRoles: { [positionKey(adjacentPosition)]: 'scout' as const },
    }
    const raidStrike = tacticalCandidates(
      state,
      aiProfiles.velislava,
      adjacentMemory,
      'assault',
      () => true,
    ).find((candidate) => candidate.factors.includes('raid-target'))
    expect(raidStrike?.command).toEqual({
      type: 'move-or-attack',
      from: adjacentPosition,
      to: { column: 10, row: 16 },
    })
  })

  it('rejects an economic raid whose reaction window is covered by a stronger defender', () => {
    const state = startAiTurn('velislava')
    const ownerId = state.activeParticipantId
    const squadPosition = { column: 13, row: 16 }
    state.scenario.cells[squadPosition.row][squadPosition.column].object = {
      type: 'squad',
      ownerId,
      units: { militia: 0, spearmen: 3, archers: 0, knights: 0 },
      health: 4.05,
    }
    const exposedOrchard = { column: 9, row: 16 }
    placeTestBuilding(state, 'player', 'orchard', exposedOrchard)
    state.scenario.cells[15][9].object = {
      type: 'squad',
      ownerId: 'player',
      units: { militia: 8, spearmen: 4, archers: 2, knights: 0 },
      health: 15.4,
    }
    const memory = {
      ...createAiMemory(),
      targetOwnerId: 'player',
      phase: 'assault' as const,
      wave: 'probe' as const,
      squadRoles: { [positionKey(squadPosition)]: 'scout' as const },
    }

    const objectives = raidObjectivesFor(
      state,
      state.scenario.cells,
      aiProfiles.velislava,
      memory,
      'assault',
      () => true,
    )

    expect(objectives[positionKey(squadPosition)]).toBeUndefined()
  })

  it('shares the open battlefield but redacts every foreign economic value', () => {
    const state = startAiTurn('radomir')
    state.scenario.cells[2][2].object = { type: 'squad', ownerId: 'player', units: units(2) }
    state.scenario.cells[3][2].object = { type: 'building', kind: 'barracks', ownerId: 'player', hitPoints: 25, maxHitPoints: 25 }
    const perception = createAiPerception(state, state.activeParticipantId, createAiMemory())
    expect(perception.state.scenario.cells[2][2].object).toMatchObject({ type: 'squad', ownerId: 'player' })
    expect(perception.state.scenario.cells[3][2].object).toMatchObject({ type: 'building', kind: 'barracks' })
    expect(Object.values(perception.state.domains.player.resources).every((value) => value === 0)).toBe(true)
    expect(perception.state.domains.player.population).toBe(0)
    expect(perception.state.domains[state.activeParticipantId]).toEqual(state.domains[state.activeParticipantId])
    expect(perception.memory.contacts).toEqual([])
  })

  it('keeps a last-seen contact until its cell is observed empty', () => {
    const state = startAiTurn('radomir')
    state.scenario.cells[12][13].object = { type: 'squad', ownerId: 'player', units: units(2) }
    const remembered = updateAiMemory(state, state.activeParticipantId, createAiMemory(), true)
    expect(remembered.contacts).toMatchObject([{ ownerId: 'player', kind: 'squad', position: { column: 13, row: 12 } }])
    expect(remembered.contacts[0]).toMatchObject({ units: units(2), health: 2 })
    const hiddenAgain = structuredClone(state)
    hiddenAgain.scenario.cells[12][13].object = undefined
    hiddenAgain.scenario.cells[12][20].object = undefined
    hiddenAgain.scenario.cells[20][20].object = { type: 'castle', ownerId: state.activeParticipantId, hitPoints: 100, maxHitPoints: 100 }
    expect(updateAiMemory(hiddenAgain, hiddenAgain.activeParticipantId, remembered, true).contacts).toHaveLength(1)
    hiddenAgain.scenario.cells[12][20].object = { type: 'castle', ownerId: state.activeParticipantId, hitPoints: 100, maxHitPoints: 100 }
    expect(updateAiMemory(hiddenAgain, hiddenAgain.activeParticipantId, remembered, true).contacts).toHaveLength(0)
  })

  it('uses a fresh last-seen squad to defend without revealing it on the perceived map', () => {
    const state = startAiTurn('velislava')
    state.scenario.cells[12][13].object = { type: 'squad', ownerId: 'player', units: units(3), health: 3 }
    const seen = updateAiMemory(state, state.activeParticipantId, createAiMemory(), true)
    const hidden = structuredClone(state)
    hidden.scenario.cells[12][13].object = undefined
    hidden.scenario.cells[12][20].object = undefined
    hidden.scenario.cells[12][22].object = { type: 'castle', ownerId: hidden.activeParticipantId, hitPoints: 100, maxHitPoints: 100 }
    const perception = createAiPerception(hidden, hidden.activeParticipantId, seen, true)
    expect(perception.state.scenario.cells[12][13].object).toBeUndefined()
    expect(perception.memory.contacts).toHaveLength(1)
    expect(homeThreatFor(perception.state, hidden.activeParticipantId, perception.memory).threatened).toBe(true)
  })

  it.each(['radomir', 'velislava', 'svyatobor'] as AiProfileId[])('produces a deterministic, legal and profile-limited plan for %s', (profileId) => {
    const state = startAiTurn(profileId)
    const memory = createAiMemory()
    const first = planAiTurn(state, memory, profileId)
    const second = planAiTurn(state, memory, profileId)
    expect(second.commands).toEqual(first.commands)
    expect(first.exploredNodes).toBeLessThanOrEqual(aiPlannerConfig.nodeBudget + 1)
    let authoritative = state
    first.commands.forEach((command) => {
      if (command.type === 'build') expect(aiProfiles[profileId].allowedBuildings).toContain(command.building)
      if (command.type === 'recruit') expect(aiProfiles[profileId].allowedTroops).toContain(command.troop)
      const executed = executeAiCommand(authoritative, command)
      expect(executed.ok).toBe(true)
      if (executed.ok) authoritative = executed.state
    })
  })

  it('uses the settlement heat map as an adaptive blueprint with profile-scaled capacity', () => {
    const state = startAiTurn('radomir')
    const analysis = analyzeAiWorld(state.scenario, state.activeParticipantId)
    expect(analysis).not.toBeNull()
    if (!analysis) return
    const basic = createSettlementPlan(analysis, state.scenario, aiProfiles.radomir)
    const complete = createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor)
    expect(complete.zones.food.maxOrigins).toBeGreaterThan(basic.zones.food.maxOrigins)
    expect(complete.zones.industry.maxOrigins).toBeGreaterThan(basic.zones.industry.maxOrigins)
    expect(basic.zones.housing.maxBuildings.kitchen).toBe(1)

    const blocked = structuredClone(state)
    const foodKeys = new Set(basic.zones.food.cells.map(positionKey))
    basic.zones.food.cells.forEach((position) => {
      blocked.scenario.cells[position.row][position.column].vegetation = true
    })
    const position = findStrategicBuildPosition(
      blocked,
      analysis,
      { ...createAiMemory(), settlementPlan: basic },
      'orchard',
      () => true,
    )
    expect(position).not.toBeNull()
    if (!position) return
    expect(foodKeys.has(positionKey(position))).toBe(false)
    const distance = Math.min(...basic.zones.food.cells.map((candidate) => positionDistance(position, candidate)))
    const adaptiveRadius = basic.zones.food.overflowRadius + Math.max(2, Math.ceil(Math.sqrt(basic.zones.food.cells.length) / 2))
    expect(distance).toBeLessThanOrEqual(adaptiveRadius)
  })

  it('plans a connected fortification and refuses to place decorative walls before its gate', () => {
    const state = startAiTurn('velislava')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    expect(analysis).not.toBeNull()
    if (!analysis) return
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.velislava)
    const line = settlementPlan.fortification?.lines[0]
    expect(line).toBeDefined()
    if (!line) return
    expect(line.walls.length).toBeGreaterThanOrEqual(2)
    const connected = new Set([positionKey(line.gate)])
    line.walls.forEach((wall) => {
      expect([...connected].some((key) => {
        const [column, row] = key.split(':').map(Number)
        return positionDistance(wall, { column, row }) === 1
      })).toBe(true)
      connected.add(positionKey(wall))
    })
    const memory = { ...createAiMemory(), phase: 'mobilization' as const, settlementPlan }
    expect(findStrategicBuildPosition(state, analysis, memory, 'wall', () => true)).toBeNull()
    const gate = findStrategicBuildPosition(state, analysis, memory, 'barbican', () => true)
    expect(gate).toEqual(line.gate)
    if (!gate) return
    const builtGate = executeAiCommand(state, { type: 'build', building: 'barbican', position: gate })
    expect(builtGate.ok).toBe(true)
    if (!builtGate.ok) return
    expect(findStrategicBuildPosition(builtGate.state, analysis, memory, 'wall', () => true)).toEqual(line.walls[0])
  })

  it('moves archers into a completed tower garrison before a battle reaches the castle', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const tower = { column: 17, row: 12 }
    const archers = { column: 18, row: 12 }
    placeTestBuilding(state, ownerId, 'tower', tower)
    state.scenario.cells[archers.row][archers.column].object = {
      type: 'squad', ownerId, units: { militia: 0, spearmen: 0, archers: 2, knights: 0 }, health: 2,
    }
    const candidate = tacticalCandidates(state, aiProfiles.svyatobor, createAiMemory(), 'mobilization', () => true)
      .find((entry) => entry.command.type === 'garrison')
    expect(candidate?.command).toEqual({ type: 'garrison', from: archers, tower })
    expect(candidate?.factors).toContain('standing-garrison')
  })

  it('finishes a strong fortification with towers after the gate and curtain are complete', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    expect(analysis).not.toBeNull()
    if (!analysis) return
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor)
    const line = settlementPlan.fortification?.lines[0]
    expect(line?.towers.length).toBeGreaterThan(0)
    if (!line?.towers.length) return
    placeTestBuilding(state, ownerId, 'barbican', line.gate)
    line.walls.forEach((position) => placeTestBuilding(state, ownerId, 'wall', position))
    const defenseKeys = new Set([line.gate, ...line.walls, ...line.towers].map(positionKey))
    const armyPosition = analysis.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => (
      cell.inRegion && !state.scenario.cells[rowIndex][column].object
        && !defenseKeys.has(positionKey({ column, row: rowIndex }))
        ? [{ column, row: rowIndex }]
        : []
    )))[0]
    expect(armyPosition).toBeDefined()
    if (!armyPosition) return
    state.scenario.cells[armyPosition.row][armyPosition.column].object = {
      type: 'squad', ownerId, units: { militia: 2, spearmen: 2, archers: 2, knights: 0 }, health: 6,
    }
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      resources: {
        ...state.domains[ownerId].resources,
        wood: 500,
        stone: 500,
        flour: 500,
        meat: 500,
        fruit: 500,
        gold: 500,
      },
    }
    const memory = { ...createAiMemory(), phase: 'mobilization' as const, settlementPlan }
    expect(nextFortificationStep(state, memory)).toBe('tower')
    expect(economicEmergencyFor(state, ownerId)).toBe(false)
    expect(totalArmySize(state, ownerId)).toBe(6)
    const goals = desiredBuildingGoals(state, aiProfiles.svyatobor, analysis, memory, 'mobilization')
    expect(goals.some((goal) => goal.kind === 'tower')).toBe(true)
    expect(findStrategicBuildPosition(state, analysis, memory, 'tower', () => true)).toEqual(line.towers[0])
  })

  it('buys exactly the stone shortfall for a reachable strategic building', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const marketPosition = { column: 18, row: 10 }
    state.scenario.cells[marketPosition.row][marketPosition.column].object = {
      type: 'building', kind: 'market', ownerId, hitPoints: 18, maxHitPoints: 18, constructionCost: { gold: 28 },
    }
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      resources: { ...state.domains[ownerId].resources, wood: 180, stone: 29, flour: 80, fruit: 40, gold: 220 },
    }
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    expect(analysis).not.toBeNull()
    if (!analysis) return
    const memory = { ...createAiMemory(), settlementPlan: createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor) }
    const candidate = marketCandidate(state, aiProfiles.svyatobor, 'expansion', memory, analysis, () => true)
    expect(candidate?.command).toEqual({ type: 'trade', market: marketPosition, resource: 'stone', direction: 'buy', quantity: 1 })
    expect(candidate?.factors).toContain('building:barracks')
  })

  it('does not buy stone for a strategic building with no legal placement', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const marketPosition = { column: 18, row: 10 }
    state.scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
      if (state.scenario.territories[rowIndex][column] === 'region-1' && !cell.object) {
        state.scenario.cells[rowIndex][column] = { ...cell, vegetation: false, landform: 'peak' }
      }
    }))
    state.scenario.cells[marketPosition.row][marketPosition.column] = {
      ...state.scenario.cells[marketPosition.row][marketPosition.column],
      landform: 'plain',
      object: { type: 'building', kind: 'market', ownerId, hitPoints: 18, maxHitPoints: 18, constructionCost: { gold: 28 } },
    }
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      resources: { ...state.domains[ownerId].resources, wood: 180, stone: 0, flour: 80, fruit: 40, gold: 220 },
    }
    const analysis = analyzeAiWorld(state.scenario, ownerId)
    expect(analysis).not.toBeNull()
    if (!analysis) return
    const memory = { ...createAiMemory(), settlementPlan: createSettlementPlan(analysis, state.scenario, aiProfiles.svyatobor) }
    const candidate = marketCandidate(state, aiProfiles.svyatobor, 'expansion', memory, analysis, () => true)
    expect(candidate?.command.type === 'trade' && candidate.command.resource === 'stone').toBe(false)
  })

  it('builds several reachable staging anchors and replaces a blocked front route', () => {
    const state = startAiTurn('velislava')
    const analysis = analyzeAiWorld(state.scenario, state.activeParticipantId)
    expect(analysis).not.toBeNull()
    if (!analysis) return
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.velislava)
    const blocked = settlementPlan.reservedCorridors.at(-1)
    expect(blocked).toBeDefined()
    if (!blocked) return
    state.scenario.cells[blocked.row][blocked.column] = {
      ...state.scenario.cells[blocked.row][blocked.column],
      landform: 'peak',
    }
    const memory = { ...createAiMemory(), settlementPlan }
    const anchors = stagingAnchorsFor(state, state.activeParticipantId, memory)
    expect(anchors.length).toBeGreaterThanOrEqual(2)
    expect(anchors.some((anchor) => positionKey(anchor) === positionKey(blocked))).toBe(false)
    anchors.forEach((anchor) => {
      expect(state.scenario.cells[anchor.row][anchor.column].landform).not.toBe('peak')
      expect(findMovementPath(state.scenario.cells, analysis.castle, anchor, { ownerId: state.activeParticipantId })).not.toBeNull()
    })
  })

  it('keeps a home reserve while the rest of the army assembles', () => {
    const state = startAiTurn('svyatobor')
    const nearHome = { column: 19, row: 12 }
    const field = { column: 18, row: 12 }
    state.scenario.cells[nearHome.row][nearHome.column].object = {
      type: 'squad', ownerId: state.activeParticipantId, units: units(2), health: 2,
    }
    state.scenario.cells[field.row][field.column].object = {
      type: 'squad', ownerId: state.activeParticipantId, units: units(6), health: 6,
    }
    const roles = assignSquadRoles(state, aiProfiles.svyatobor, {}, 'assault')
    expect(roles[positionKey(nearHome)]).toBe('reserve')
    expect(roles[positionKey(field)]).not.toBe('reserve')
  })

  it('forms marching groups during mobilization without absorbing the home reserve', () => {
    const state = startAiTurn('velislava')
    const first = { column: 18, row: 11 }
    const second = { column: 18, row: 12 }
    state.scenario.cells[first.row][first.column].object = {
      type: 'squad', ownerId: state.activeParticipantId, units: units(3), health: 3,
    }
    state.scenario.cells[second.row][second.column].object = {
      type: 'squad', ownerId: state.activeParticipantId,
      units: { militia: 0, spearmen: 3, archers: 0, knights: 0 }, health: 3,
    }
    const memory = {
      ...createAiMemory(),
      phase: 'mobilization' as const,
      targetOwnerId: 'player',
      squadRoles: { [positionKey(first)]: 'assault' as const, [positionKey(second)]: 'screen' as const },
    }
    const candidates = tacticalCandidates(state, aiProfiles.velislava, memory, 'mobilization', () => true)
    expect(candidates.some((candidate) => candidate.command.type === 'move-or-attack'
      && candidate.command.to.column === second.column && candidate.command.to.row === second.row
      && candidate.factors.includes('form-marching-group'))).toBe(true)

    const withReserve = { ...memory, squadRoles: { ...memory.squadRoles, [positionKey(second)]: 'reserve' as const } }
    expect(tacticalCandidates(state, aiProfiles.velislava, withReserve, 'mobilization', () => true)
      .some((candidate) => candidate.factors.includes('form-marching-group'))).toBe(false)
  })

  it('launches a cautious probe after healthy mobilization stops making progress', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const orchard = { column: 18, row: 8 }
    const lumberMill = { column: 21, row: 5 }
    const squad = { column: 18, row: 12 }
    state.scenario.cells[orchard.row][orchard.column].object = {
      type: 'building', kind: 'orchard', ownerId, hitPoints: 12, maxHitPoints: 12,
    }
    state.scenario.cells[lumberMill.row][lumberMill.column].object = {
      type: 'building', kind: 'lumberMill', ownerId, hitPoints: 15, maxHitPoints: 15,
    }
    state.scenario.cells[squad.row][squad.column].object = {
      type: 'squad', ownerId, units: { militia: 0, spearmen: 3, archers: 0, knights: 0 }, health: 4,
    }
    state.domains[ownerId] = {
      ...state.domains[ownerId],
      resources: { ...state.domains[ownerId].resources, flour: 80, fruit: 80, gold: 160 },
    }
    state.turn = aiProfiles.svyatobor.earliestOffensiveRound
    const memory = {
      ...createAiMemory(),
      phase: 'mobilization' as const,
      stableTurns: aiPlannerConfig.stableRecoveryTurns,
      idleTurns: aiPlannerConfig.stalledMobilizationProbeTurns,
      targetOwnerId: 'player',
    }
    expect(strategicPhaseFor(state, aiProfiles.svyatobor, memory)).toBe('assault')
  })

  it('keeps ranged troops and a front line in both Velislava groups when splitting', () => {
    const squad = {
      type: 'squad' as const,
      ownerId: 'ai-velislava',
      units: { militia: 1, spearmen: 3, archers: 4, knights: 0 },
      health: 8,
    }
    const detached = formationSplit(squad, aiProfiles.velislava)
    const remaining = {
      militia: squad.units.militia - detached.militia,
      spearmen: squad.units.spearmen - detached.spearmen,
      archers: squad.units.archers - detached.archers,
      knights: squad.units.knights - detached.knights,
    }
    expect(detached.archers).toBeGreaterThan(0)
    expect(remaining.archers).toBeGreaterThan(0)
    expect(detached.militia + detached.spearmen + detached.knights).toBeGreaterThan(0)
    expect(remaining.militia + remaining.spearmen + remaining.knights).toBeGreaterThan(0)
  })

  it('splits only when a real route advantage justifies losing concentration', () => {
    const state = startAiTurn('velislava')
    const squadPosition = { column: 18, row: 12 }
    state.scenario.cells[squadPosition.row][squadPosition.column].object = {
      type: 'squad', ownerId: state.activeParticipantId, units: units(6), health: 6,
    }
    const memory = {
      ...createAiMemory(),
      phase: 'assault' as const,
      targetOwnerId: 'player',
      squadRoles: { [positionKey(squadPosition)]: 'assault' as const },
    }
    expect(tacticalCandidates(state, aiProfiles.velislava, memory, 'assault', () => true)
      .some((candidate) => candidate.command.type === 'split')).toBe(true)

    state.scenario.cells[10][7].object = { type: 'squad', ownerId: 'player', units: units(12), health: 12 }
    expect(tacticalCandidates(state, aiProfiles.velislava, memory, 'assault', () => true)
      .some((candidate) => candidate.command.type === 'split')).toBe(false)
  })

  it('delays a mobilization split until the marching group reaches its staging zone', () => {
    const state = startAiTurn('velislava')
    const analysis = analyzeAiWorld(state.scenario, state.activeParticipantId)
    expect(analysis).not.toBeNull()
    if (!analysis) return
    const settlementPlan = createSettlementPlan(analysis, state.scenario, aiProfiles.velislava)
    const baseMemory = { ...createAiMemory(), phase: 'mobilization' as const, targetOwnerId: 'player', settlementPlan }
    const anchors = stagingAnchorsFor(state, state.activeParticipantId, baseMemory)
    const staging = anchors[0]
    expect(staging).toBeDefined()
    if (!staging) return
    state.scenario.cells[staging.row][staging.column].object = {
      type: 'squad', ownerId: state.activeParticipantId, units: units(10), health: 10,
    }
    expect(tacticalCandidates(state, aiProfiles.velislava, baseMemory, 'mobilization', () => true)
      .some((candidate) => candidate.command.type === 'split')).toBe(true)

    state.scenario.cells[staging.row][staging.column].object = undefined
    const far = analysis.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
      const position = { column, row: rowIndex }
      const mapCell = state.scenario.cells[rowIndex][column]
      return cell.inRegion && mapCell.landform !== 'peak' && !mapCell.object
        ? [{ position, distance: Math.min(...anchors.map((anchor) => positionDistance(position, anchor))) }]
        : []
    })).sort((first, second) => second.distance - first.distance)[0]?.position
    expect(far).toBeDefined()
    if (!far) return
    state.scenario.cells[far.row][far.column].object = {
      type: 'squad', ownerId: state.activeParticipantId, units: units(10), health: 10,
    }
    expect(tacticalCandidates(state, aiProfiles.velislava, baseMemory, 'mobilization', () => true)
      .some((candidate) => candidate.command.type === 'split')).toBe(false)
  })

  it('uses the profile finisher preference against a vulnerable adjacent squad', () => {
    const state = startAiTurn('svyatobor')
    const ownerId = state.activeParticipantId
    const from = { column: 13, row: 12 }
    const weak = { column: 12, row: 12 }
    state.scenario.cells[from.row][from.column].object = {
      type: 'squad', ownerId,
      units: { militia: 0, spearmen: 3, archers: 0, knights: 0 },
      health: 4.05,
    }
    state.scenario.cells[weak.row][weak.column].object = {
      type: 'squad', ownerId: 'player', units: units(2), health: 0.6,
    }
    const memory = {
      ...createAiMemory(),
      phase: 'assault' as const,
      targetOwnerId: 'player',
      squadRoles: { [positionKey(from)]: 'assault' as const },
    }

    const finishingAttack = tacticalCandidates(state, aiProfiles.svyatobor, memory, 'assault', () => true)
      .find((candidate) => candidate.command.type === 'move-or-attack'
        && candidate.command.to.column === weak.column && candidate.command.to.row === weak.row)
    expect(finishingAttack?.factors.some((factor) => factor.startsWith('finisher:'))).toBe(true)
  })

})
