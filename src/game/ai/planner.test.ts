import { describe, expect, it } from 'vitest'
import { aiPlannerConfig, aiProfiles } from '../../config/ai'
import type { AiProfileId } from '../scenario'
import { executeAiCommand, rememberAiCommandFailure } from './commands'
import { analyzeAiWorld, createSettlementPlan, positionDistance, positionKey } from './analysis'
import { createAiPerception, updateAiMemory } from './perception'
import { planAiTurn } from './planner'
import { createAiMemory } from './model'
import { findStrategicBuildPosition, homeThreatFor, marketCandidate } from './strategy'
import { militia as units, startAiTurn } from './testing/scenarioFixtures'

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

})
