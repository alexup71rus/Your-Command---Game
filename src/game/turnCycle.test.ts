import { describe, expect, it } from 'vitest'
import { aiProfiles } from '../config/ai'
import { buildingRules } from '../config/rules'
import type { GameMap, TroopComposition } from './map'
import { build, createMatch, endTurn, moveOrAttack, objectAt } from './match'
import type { AiProfileId, MapScenario, MatchParticipant } from './scenario'
import { createAiMemory } from './ai/model'
import { chooseTargetOwner } from './ai/strategy'

const emptyUnits = (militia: number): TroopComposition => ({ militia, spearmen: 0, archers: 0, knights: 0 })

function scenarioWithOpponents(profileIds: AiProfileId[] = ['radomir', 'velislava']): MapScenario {
  const size = 12
  const participants: MatchParticipant[] = [
    { id: 'player', kind: 'human', regionId: 'region-0', color: '#d2b45f' },
    ...profileIds.map((profileId, index) => ({ id: `ai-${profileId}`, kind: 'ai' as const, profileId, regionId: `region-${index + 1}`, color: index === 0 ? '#6f9c83' : '#a26f61' })),
  ]
  const regionWidth = size / participants.length
  const cells: GameMap = Array.from({ length: size }, () => Array.from({ length: size }, () => ({ elevation: 0.2, landform: 'plain' as const, vegetation: false })))
  const castleColumns = participants.map((_, index) => Math.min(size - 2, Math.floor(index * regionWidth + 1)))
  participants.forEach((participant, index) => {
    cells[1][castleColumns[index]].object = { type: 'castle', ownerId: participant.id, hitPoints: 100, maxHitPoints: 100 }
  })
  return {
    id: 'turn-cycle', name: 'Turn cycle', seed: 5, participantCount: participants.length, cells,
    territories: Array.from({ length: size }, () => Array.from({ length: size }, (_, column) => `region-${Math.min(participants.length - 1, Math.floor(column / regionWidth))}`)),
    regions: participants.map((participant, index) => ({
      id: participant.regionId, index, color: participant.color, center: { column: castleColumns[index], row: 1 }, validCastleCells: [{ column: castleColumns[index], row: 1 }],
      reservedBuildSites: { plain: { column: castleColumns[index], row: 4 }, hill: { column: castleColumns[index], row: 6 }, extra: { column: castleColumns[index], row: 8 }, house: { column: castleColumns[index], row: 3 } },
      score: { cells: size * regionWidth, forest: 0, hills: 0, quality: size * regionWidth },
    })),
    participants,
  }
}

function placeBuilding(scenario: MapScenario, ownerId: string, column: number, row: number) {
  const rule = buildingRules.house
  scenario.cells[row][column].object = { type: 'building', kind: 'house', ownerId, hitPoints: rule.hitPoints, maxHitPoints: rule.hitPoints, constructionCost: { ...rule.resourceCost } }
}

function automatedDuel(): MapScenario {
  const scenario = scenarioWithOpponents(['velislava'])
  const firstBot = { ...scenario.participants[0], id: 'ai-radomir', kind: 'ai' as const, profileId: 'radomir' as const }
  return {
    ...scenario,
    cells: scenario.cells.map((row) => row.map((cell) => cell.object?.ownerId === 'player'
      ? { ...cell, object: { ...cell.object, ownerId: firstBot.id } }
      : cell)),
    participants: [firstBot, scenario.participants[1]],
  }
}

describe('participant turn cycle', () => {
  it('advances rounds in a single-seat sandbox', () => {
    const initial = createMatch(scenarioWithOpponents([]))
    const advanced = endTurn(initial)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.activeParticipantId).toBe('player')
    expect(advanced.state.turn).toBe(2)
  })

  it('authorizes commands for the active participant and advances one domain at a time', () => {
    const initial = createMatch(scenarioWithOpponents())
    const humanGold = initial.domains.player.resources.gold
    const radomirGold = initial.domains['ai-radomir'].resources.gold
    const first = endTurn(initial)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.state.activeParticipantId).toBe('ai-radomir')
    expect(first.state.turn).toBe(1)
    expect(first.state.domains.player.resources.gold).toBeGreaterThan(humanGold)
    expect(first.state.domains['ai-radomir'].resources.gold).toBe(radomirGold)
    expect(build(first.state, 'house', { column: 1, row: 4 })).toMatchObject({ ok: false, reason: 'outside-domain' })
    expect(build(first.state, 'house', { column: 5, row: 4 }).ok).toBe(true)

    const second = endTurn(first.state)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.state.activeParticipantId).toBe('ai-velislava')
    expect(second.state.domains['ai-radomir'].resources.gold).toBeGreaterThan(radomirGold)
    const third = endTurn(second.state)
    expect(third.ok).toBe(true)
    if (!third.ok) return
    expect(third.state.activeParticipantId).toBe('player')
    expect(third.state.turn).toBe(2)
  })

  it('skips a defeated ruler and removes every object belonging to that AI', () => {
    const scenario = scenarioWithOpponents()
    scenario.cells[1][5].object = { type: 'castle', ownerId: 'ai-radomir', hitPoints: 1, maxHitPoints: 100 }
    scenario.cells[1][4].object = { type: 'squad', ownerId: 'player', units: emptyUnits(3) }
    scenario.cells[5][5].object = { type: 'squad', ownerId: 'ai-radomir', units: emptyUnits(2) }
    placeBuilding(scenario, 'ai-radomir', 6, 5)
    const attacked = moveOrAttack(createMatch(scenario), { column: 4, row: 1 }, { column: 5, row: 1 })
    expect(attacked.ok).toBe(true)
    if (!attacked.ok) return
    expect(attacked.state.status).toBe('playing')
    expect(attacked.state.scenario.cells.flat().some((cell) => cell.object?.ownerId === 'ai-radomir')).toBe(false)
    expect(objectAt(attacked.state, { column: 5, row: 1 })).toMatchObject({ type: 'squad', ownerId: 'player' })
    const advanced = endTurn(attacked.state)
    expect(advanced.ok).toBe(true)
    if (advanced.ok) expect(advanced.state.activeParticipantId).toBe('ai-velislava')
  })

  it('sets victory after the last AI castle and defeat after the human castle falls', () => {
    const victoryScenario = scenarioWithOpponents(['radomir'])
    victoryScenario.cells[1][7].object = undefined
    victoryScenario.cells[1][5].object = { type: 'castle', ownerId: 'ai-radomir', hitPoints: 1, maxHitPoints: 100 }
    victoryScenario.cells[1][4].object = { type: 'squad', ownerId: 'player', units: emptyUnits(3) }
    const victory = moveOrAttack(createMatch(victoryScenario), { column: 4, row: 1 }, { column: 5, row: 1 })
    expect(victory.ok).toBe(true)
    if (victory.ok) expect(victory.state.status).toBe('won')

    const defeatScenario = scenarioWithOpponents(['radomir'])
    defeatScenario.cells[1][1].object = { type: 'castle', ownerId: 'player', hitPoints: 1, maxHitPoints: 100 }
    defeatScenario.cells[1][2].object = { type: 'squad', ownerId: 'ai-radomir', units: emptyUnits(3) }
    const defeatState = { ...createMatch(defeatScenario), activeParticipantId: 'ai-radomir' }
    const defeat = moveOrAttack(defeatState, { column: 2, row: 1 }, { column: 1, row: 1 })
    expect(defeat.ok).toBe(true)
    if (defeat.ok) expect(defeat.state.status).toBe('lost')
  })

  it('runs every seat as an AI and ends an automated duel when one ruler remains', () => {
    const scenario = automatedDuel()
    const initial = createMatch(scenario)
    expect(initial.playerId).toBe('ai-radomir')
    expect(initial.activeParticipantId).toBe('ai-radomir')
    const advanced = endTurn(initial)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.state.activeParticipantId).toBe('ai-velislava')

    const radomirCastle = scenario.regions[0].center
    const attackFrom = { column: radomirCastle.column + 1, row: radomirCastle.row }
    const cells = advanced.state.scenario.cells.map((row) => [...row])
    cells[radomirCastle.row] = [...cells[radomirCastle.row]]
    cells[radomirCastle.row][radomirCastle.column] = { ...cells[radomirCastle.row][radomirCastle.column], object: { type: 'castle', ownerId: 'ai-radomir', hitPoints: 1, maxHitPoints: 100 } }
    cells[attackFrom.row][attackFrom.column] = { ...cells[attackFrom.row][attackFrom.column], object: { type: 'squad', ownerId: 'ai-velislava', units: emptyUnits(3) } }
    const attacked = moveOrAttack({ ...advanced.state, scenario: { ...advanced.state.scenario, cells } }, attackFrom, radomirCastle)
    expect(attacked.ok).toBe(true)
    if (!attacked.ok) return
    expect(attacked.state.status).toBe('won')
    expect(attacked.state.scenario.cells.flat().some((cell) => cell.object?.ownerId === 'ai-radomir')).toBe(false)
  })

  it('protects allies, targets only hostile rulers and wins when the last hostile castle falls', () => {
    const scenario = scenarioWithOpponents()
    scenario.participants[0].teamId = 1
    scenario.participants[1].teamId = 1
    scenario.participants[2].teamId = 2
    const alliedCastle = scenario.regions[1].center
    const hostileCastle = scenario.regions[2].center
    const alliedAttackFrom = { column: alliedCastle.column - 1, row: alliedCastle.row }
    const hostileAttackFrom = { column: hostileCastle.column - 1, row: hostileCastle.row }
    scenario.cells[alliedAttackFrom.row][alliedAttackFrom.column].object = { type: 'squad', ownerId: 'player', units: emptyUnits(3) }
    scenario.cells[hostileAttackFrom.row][hostileAttackFrom.column].object = { type: 'squad', ownerId: 'player', units: emptyUnits(3) }
    scenario.cells[hostileCastle.row][hostileCastle.column].object = { type: 'castle', ownerId: 'ai-velislava', hitPoints: 1, maxHitPoints: 100 }
    const initial = createMatch(scenario)

    expect(moveOrAttack(initial, alliedAttackFrom, alliedCastle)).toMatchObject({ ok: false, reason: 'occupied' })
    expect(chooseTargetOwner({ ...initial, activeParticipantId: 'ai-radomir' }, aiProfiles.radomir, createAiMemory())).toBe('ai-velislava')

    const victory = moveOrAttack(initial, hostileAttackFrom, hostileCastle)
    expect(victory.ok).toBe(true)
    if (!victory.ok) return
    expect(victory.state.status).toBe('won')
    expect(victory.state.scenario.cells.flat().some((cell) => cell.object?.type === 'castle' && cell.object.ownerId === 'ai-radomir')).toBe(true)
  })
})
