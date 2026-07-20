import { describe, expect, it } from 'vitest'
import { aiBuildingZoneByKind, aiPlannerConfig, aiProfiles } from '../../config/ai'
import { gameConfig } from '../../config/game'
import { buildingKinds } from '../../config/rules'
import type { GameMap, TroopComposition } from '../map'
import { createMatch, endTurn, ownedBuildingCount, workforceFor } from '../match'
import type { AiProfileId, MapScenario } from '../scenario'
import { executeAiCommand, rememberAiCommandFailure } from './commands'
import { analyzeAiWorld, createSettlementPlan, positionDistance, positionKey } from './analysis'
import { createAiPerception, updateAiMemory } from './perception'
import { planAiTurn } from './planner'
import { createAiMemory } from './model'
import { findStrategicBuildPosition, homeThreatFor, marketCandidate, stagingAnchorsFor, strategicPhaseFor } from './strategy'
import { assaultPathFor, assignSquadRoles, formationSplit, tacticalCandidates } from './tactics'
import { findMovementPath } from '../pathfinding'

const units = (militia = 1): TroopComposition => ({ militia, spearmen: 0, archers: 0, knights: 0 })

function createAiScenario(profileId: AiProfileId = 'radomir'): MapScenario {
  const size = 24
  const cells: GameMap = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => ({
    elevation: column >= 14 && column <= 17 && row >= 3 && row <= 6 ? 0.55 : 0.2,
    landform: column >= 14 && column <= 17 && row >= 3 && row <= 6 ? 'hill' as const : 'plain' as const,
    vegetation: column >= 20 && column <= 22 && row >= 2 && row <= 5,
  })))
  cells[12][3] = { ...cells[12][3], object: { type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100 } }
  cells[12][20] = { ...cells[12][20], vegetation: false, object: { type: 'castle', ownerId: `ai-${profileId}`, hitPoints: 100, maxHitPoints: 100 } }
  return {
    id: 'ai-test', name: 'AI test', seed: 91, participantCount: 2, cells,
    territories: Array.from({ length: size }, () => Array.from({ length: size }, (_, column) => column < size / 2 ? 'region-0' : 'region-1')),
    regions: [
      { id: 'region-0', index: 0, color: '#d2b45f', center: { column: 3, row: 12 }, validCastleCells: [{ column: 3, row: 12 }], reservedBuildSites: { plain: { column: 3, row: 3 }, hill: { column: 3, row: 5 }, extra: { column: 5, row: 3 }, house: { column: 4, row: 12 } }, score: { cells: 288, forest: 0, hills: 0, quality: 288 } },
      { id: 'region-1', index: 1, color: '#6f9c83', center: { column: 20, row: 12 }, validCastleCells: [{ column: 20, row: 12 }], reservedBuildSites: { plain: { column: 18, row: 8 }, hill: { column: 14, row: 3 }, extra: { column: 18, row: 14 }, house: { column: 19, row: 12 } }, score: { cells: 288, forest: 12, hills: 16, quality: 304 } },
    ],
    participants: [
      { id: 'player', kind: 'human', regionId: 'region-0', color: '#d2b45f' },
      { id: `ai-${profileId}`, kind: 'ai', profileId, regionId: 'region-1', color: '#6f9c83' },
    ],
  }
}

function startAiTurn(profileId: AiProfileId) {
  const ended = endTurn(createMatch(createAiScenario(profileId)))
  if (!ended.ok) throw new Error('Could not start AI turn')
  return ended.state
}

describe('AI perception and planning', () => {
  it('keeps every building kind in exactly one configured settlement zone', () => {
    expect(Object.keys(aiBuildingZoneByKind).sort()).toEqual([...buildingKinds].sort())
  })

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

  it('breaches a weak gate but takes a forest detour around a costly wall', () => {
    const state = startAiTurn('velislava')
    const ownerId = state.activeParticipantId
    const from = { column: 18, row: 12 }
    const to = { column: 10, row: 12 }
    const obstacle = { column: 14, row: 12 }
    const squad = {
      type: 'squad' as const,
      ownerId,
      units: { militia: 0, spearmen: 3, archers: 0, knights: 0 },
      health: 3,
    }
    for (let row = 10; row <= 13; row += 1) {
      for (let column = 9; column <= 19; column += 1) {
        state.scenario.cells[row][column] = {
          ...state.scenario.cells[row][column],
          landform: row === 10 || row === 13 ? 'peak' : 'plain',
          vegetation: row === 11 && column >= 13 && column <= 15,
          object: undefined,
        }
      }
    }
    state.scenario.cells[obstacle.row][obstacle.column].object = {
      type: 'building', kind: 'barbican', ownerId: 'player', hitPoints: 1, maxHitPoints: 20,
    }

    const weakGatePath = assaultPathFor(state, state.scenario.cells, squad, from, to, 'player')
    expect(weakGatePath).toContainEqual(obstacle)

    state.scenario.cells[obstacle.row][obstacle.column].object = {
      type: 'building', kind: 'wall', ownerId: 'player', hitPoints: 50, maxHitPoints: 50,
    }
    const wallDetour = assaultPathFor(state, state.scenario.cells, squad, from, to, 'player')
    expect(wallDetour).not.toContainEqual(obstacle)
    expect(wallDetour?.some((position) => state.scenario.cells[position.row][position.column].vegetation)).toBe(true)
  })

  it('keeps a siege route when every free approach to the castle is sealed', () => {
    const state = startAiTurn('radomir')
    const ownerId = state.activeParticipantId
    const from = { column: 18, row: 12 }
    const castle = { column: 10, row: 12 }
    const gate = { column: 14, row: 12 }
    for (let row = 10; row <= 14; row += 1) {
      for (let column = 9; column <= 19; column += 1) {
        state.scenario.cells[row][column] = {
          ...state.scenario.cells[row][column],
          landform: row === 12 ? 'plain' : 'peak',
          vegetation: false,
          object: undefined,
        }
      }
    }
    state.scenario.cells[castle.row][castle.column].object = {
      type: 'castle', ownerId: 'player', hitPoints: 100, maxHitPoints: 100,
    }
    state.scenario.cells[gate.row][gate.column].object = {
      type: 'building', kind: 'barbican', ownerId: 'player', hitPoints: 20, maxHitPoints: 20,
    }
    const squad = {
      type: 'squad' as const,
      ownerId,
      units: units(8),
      health: 8,
    }

    const path = assaultPathFor(state, state.scenario.cells, squad, from, castle, 'player')
    expect(path).toContainEqual(gate)
    expect(path?.at(-1)).toEqual(castle)
  })

  it('hides concealed enemy objects and every foreign economic value', () => {
    const state = startAiTurn('radomir')
    state.scenario.cells[2][2].object = { type: 'squad', ownerId: 'player', units: units(2) }
    state.scenario.cells[3][2].object = { type: 'building', kind: 'barracks', ownerId: 'player', hitPoints: 25, maxHitPoints: 25 }
    const perception = createAiPerception(state, state.activeParticipantId, createAiMemory())
    expect(perception.state.scenario.cells[2][2].object).toBeUndefined()
    expect(perception.state.scenario.cells[3][2].object).toBeUndefined()
    expect(Object.values(perception.state.domains.player.resources).every((value) => value === 0)).toBe(true)
    expect(perception.state.domains.player.population).toBe(0)
    expect(perception.state.domains[state.activeParticipantId]).toEqual(state.domains[state.activeParticipantId])
  })

  it('keeps a last-seen contact until its cell is observed empty', () => {
    const state = startAiTurn('radomir')
    state.scenario.cells[12][13].object = { type: 'squad', ownerId: 'player', units: units(2) }
    const remembered = updateAiMemory(state, state.activeParticipantId, createAiMemory())
    expect(remembered.contacts).toMatchObject([{ ownerId: 'player', kind: 'squad', position: { column: 13, row: 12 } }])
    expect(remembered.contacts[0]).toMatchObject({ units: units(2), health: 2 })
    const hiddenAgain = structuredClone(state)
    hiddenAgain.scenario.cells[12][13].object = undefined
    hiddenAgain.scenario.cells[12][20].object = undefined
    hiddenAgain.scenario.cells[20][20].object = { type: 'castle', ownerId: state.activeParticipantId, hitPoints: 100, maxHitPoints: 100 }
    expect(updateAiMemory(hiddenAgain, hiddenAgain.activeParticipantId, remembered).contacts).toHaveLength(1)
    hiddenAgain.scenario.cells[12][20].object = { type: 'castle', ownerId: state.activeParticipantId, hitPoints: 100, maxHitPoints: 100 }
    expect(updateAiMemory(hiddenAgain, hiddenAgain.activeParticipantId, remembered).contacts).toHaveLength(0)
  })

  it('uses a fresh last-seen squad to defend without revealing it on the perceived map', () => {
    const state = startAiTurn('velislava')
    state.scenario.cells[12][13].object = { type: 'squad', ownerId: 'player', units: units(3), health: 3 }
    const seen = updateAiMemory(state, state.activeParticipantId, createAiMemory())
    const hidden = structuredClone(state)
    hidden.scenario.cells[12][13].object = undefined
    hidden.scenario.cells[12][20].object = undefined
    hidden.scenario.cells[12][22].object = { type: 'castle', ownerId: hidden.activeParticipantId, hitPoints: 100, maxHitPoints: 100 }
    const perception = createAiPerception(hidden, hidden.activeParticipantId, seen)
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

  it('distinguishes opponents through their arsenal and doctrine rather than weaker search budgets', () => {
    expect(aiProfiles.radomir.arsenalTier).toBe('basic')
    expect(aiProfiles.velislava.arsenalTier).toBe('tactical')
    expect(aiProfiles.svyatobor.arsenalTier).toBe('complete')
    expect(aiProfiles.radomir.allowedBuildings).not.toContain('wall')
    expect(aiProfiles.velislava.allowedBuildings).toContain('wall')
    expect(aiProfiles.svyatobor.allowedBuildings).toContain('smelter')
    expect(aiProfiles.svyatobor.allowedBuildings).toContain('tower')
    expect(aiProfiles.velislava.doctrine.maneuverBias).toBeGreaterThan(aiProfiles.radomir.doctrine.maneuverBias)
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

  it('keeps the anti-stall counter when an idle FFA army retargets', () => {
    const state = startAiTurn('velislava')
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
    state.turn = aiProfiles.velislava.earliestOffensiveRound

    const thirdId = 'third-ruler'
    const thirdCastle = { column: 3, row: 3 }
    state.scenario.cells[thirdCastle.row][thirdCastle.column].object = {
      type: 'castle', ownerId: thirdId, hitPoints: 100, maxHitPoints: 100,
    }
    state.scenario.participants.push({ id: thirdId, kind: 'ai', profileId: 'radomir', regionId: 'region-0', color: '#ffffff' })
    const plan = planAiTurn(state, {
      ...createAiMemory(),
      phase: 'mobilization',
      stableTurns: aiPlannerConfig.stableRecoveryTurns,
      idleTurns: aiPlannerConfig.retargetAfterIdleTurns,
      targetOwnerId: 'player',
    }, 'velislava')

    expect(plan.memory.targetOwnerId).toBe(thirdId)
    expect(plan.memory.phase).toBe('assault')
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

  it.each(['radomir', 'velislava', 'svyatobor'] as AiProfileId[])('develops an economy, recruits and advances within 80 deterministic rounds as %s', (profileId) => {
    let state = createMatch(createAiScenario(profileId))
    const commandTypes = new Set<string>()
    const buildings = new Set<string>()
    const troops = new Set<string>()
    let invalidCommands = 0
    let maximumThinkTime = 0
    let attacks = 0
    for (let round = 0; round < 80 && state.status === 'playing'; round += 1) {
      if (state.activeParticipantId === state.playerId) {
        const ended = endTurn(state)
        if (!ended.ok) throw new Error('Could not finish human turn')
        state = ended.state
      }
      const participant = state.scenario.participants.find((candidate) => candidate.id === state.activeParticipantId)
      if (participant?.kind !== 'ai' || !participant.profileId) continue
      const startedAt = performance.now()
      const plan = planAiTurn(state, state.aiMemory[participant.id], participant.profileId)
      maximumThinkTime = Math.max(maximumThinkTime, performance.now() - startedAt)
      state = { ...state, aiMemory: { ...state.aiMemory, [participant.id]: plan.memory } }
      plan.commands.forEach((command) => {
        commandTypes.add(command.type)
        if (command.type === 'build') buildings.add(command.building)
        if (command.type === 'recruit') troops.add(command.troop)
        const result = executeAiCommand(state, command)
        if (!result.ok) invalidCommands += 1
        else {
          state = result.state
          if (state.lastEvent?.kind === 'attacked' || state.lastEvent?.kind === 'destroyed') attacks += 1
        }
      })
      if (state.status === 'playing') {
        const ended = endTurn(state)
        if (!ended.ok) throw new Error('Could not finish AI turn')
        state = ended.state
      }
    }
    const aiId = `ai-${profileId}`
    const summary = JSON.stringify({ commandTypes: [...commandTypes], buildings: [...buildings], troops: [...troops], attacks, maximumThinkTime, status: state.status, domain: state.domains[aiId], workforce: workforceFor(state, aiId), memory: state.aiMemory[aiId], counts: Object.fromEntries(aiProfiles[profileId].allowedBuildings.map((kind) => [kind, ownedBuildingCount(state, aiId, kind)])) })
    expect(invalidCommands, summary).toBe(0)
    expect(commandTypes.has('build'), summary).toBe(true)
    expect(commandTypes.has('recruit'), summary).toBe(true)
    expect(commandTypes.has('move-or-attack'), summary).toBe(true)
    expect(attacks, summary).toBeGreaterThan(0)
    expect(maximumThinkTime, summary).toBeLessThan(aiPlannerConfig.hardBudgetMs + 50)
    if (profileId === 'radomir') {
      expect([...buildings].every((kind) => aiProfiles.radomir.allowedBuildings.includes(kind as never)), summary).toBe(true)
      expect([...troops].every((kind) => aiProfiles.radomir.allowedTroops.includes(kind as never)), summary).toBe(true)
      if (state.domains[aiId].population > gameConfig.economy.castleFoodServiceCapacity) {
        expect(ownedBuildingCount(state, aiId, 'kitchen'), summary).toBeGreaterThanOrEqual(1)
      }
      expect(ownedBuildingCount(state, aiId, 'house'), summary).toBeLessThanOrEqual(3)
    }
    const settlementPlan = state.aiMemory[aiId].settlementPlan
    expect(settlementPlan, summary).not.toBeNull()
    if (settlementPlan) {
      Object.entries(settlementPlan.zones).forEach(([zoneKind, zone]) => {
        const originsInQuarter = state.scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
          const object = cell.object
          if (object?.type !== 'building' || object.ownerId !== aiId) return []
          if (object.footprint && (object.footprint.originColumn !== column || object.footprint.originRow !== rowIndex)) return []
          const kind = object.kind
          const actualZone = aiBuildingZoneByKind[kind]
          return actualZone === zoneKind ? [object] : []
        })).length
        // One emergency overflow origin is allowed so a blocked blueprint cannot
        // turn into an economic soft lock. Stable planning trims the excess.
        expect(originsInQuarter, `${summary}\nquarter:${zoneKind}`).toBeLessThanOrEqual(zone.maxOrigins + 1)
      })
    }
    if (profileId !== 'radomir') expect(troops.has('archers') || troops.has('spearmen') || troops.has('knights'), summary).toBe(true)
  }, 30_000)
})
