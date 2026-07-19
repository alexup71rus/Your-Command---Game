import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createManualHeightGrid, generateMap } from './generator'
import { createMatch } from './match'
import { mapPresets } from './presets'
import { createMapScenario, foundMatch } from './scenario'
import { isSavedGameRecord, SAVE_VERSION, transactionCompletion, type SavedGameRecord } from './savedGames'

let validRecord: SavedGameRecord

beforeAll(() => {
  const preset = mapPresets[0]
  const map = generateMap(preset.settings, createManualHeightGrid())
  const result = createMapScenario(map, 2, preset.settings.seed, { id: preset.id, name: preset.id })
  if (!result.ok) throw new Error(`Expected a valid scenario, got ${result.reason}`)
  const region = result.scenario.regions[0]
  const match = createMatch(foundMatch(result.scenario, region.id, region.validCastleCells[0]))
  validRecord = {
    version: SAVE_VERSION,
    id: 'save-1',
    name: `${result.scenario.name} · 1`,
    mapName: result.scenario.name,
    turn: 1,
    updatedAt: 1_000,
    match,
  }
})

describe('saved game schema', () => {
  it('accepts a complete current match', () => {
    expect(isSavedGameRecord(validRecord)).toBe(true)
  })

  it('rejects an older incompatible version', () => {
    expect(isSavedGameRecord({ ...validRecord, version: SAVE_VERSION - 1 })).toBe(false)
  })

  it('rejects invalid numeric values and inconsistent summaries', () => {
    const invalidResource = structuredClone(validRecord)
    invalidResource.match.domains[invalidResource.match.playerId].resources.gold = Number.NaN
    expect(isSavedGameRecord(invalidResource)).toBe(false)
    expect(isSavedGameRecord({ ...validRecord, turn: validRecord.turn + 1 })).toBe(false)
  })

  it('rejects armies over the domain limit and altered maximum durability', () => {
    const oversizedArmy = structuredClone(validRecord)
    const freeCells = oversizedArmy.match.scenario.cells.flatMap((row, rowIndex) => row.map((cell, column) => ({ cell, column, row: rowIndex })))
      .filter(({ cell }) => !cell.object && cell.landform !== 'peak')
      .slice(0, 11)
    expect(freeCells).toHaveLength(11)
    freeCells.forEach(({ column, row }) => {
      oversizedArmy.match.scenario.cells[row][column].object = {
        type: 'squad', ownerId: oversizedArmy.match.playerId, units: { militia: 10, spearmen: 0, archers: 0, knights: 0 }, health: 10,
      }
    })
    expect(isSavedGameRecord(oversizedArmy)).toBe(false)

    const immortalCastle = structuredClone(validRecord)
    const playerCastle = immortalCastle.match.scenario.cells.flat().find((cell) => cell.object?.type === 'castle' && cell.object.ownerId === immortalCastle.match.playerId)?.object
    if (!playerCastle || playerCastle.type !== 'castle') throw new Error('Expected the player castle')
    playerCastle.maxHitPoints += 1
    expect(isSavedGameRecord(immortalCastle)).toBe(false)
  })

  it('accepts signed processing deltas in a turn report', () => {
    const processed = structuredClone(validRecord)
    const ownerId = processed.match.playerId
    const resources = processed.match.domains[ownerId].resources
    processed.match.lastTurnReports[ownerId] = {
      ownerId,
      resourcesBefore: { ...resources },
      production: { wood: 0, stone: 0, ore: 0, iron: 0, grain: 0, meat: 0, gold: 0 },
      taxIncome: 0,
      upkeep: { wood: 0, stone: 0, ore: 0, iron: 0, grain: 0, meat: 0, gold: 0 },
      upkeepPaid: true,
      processing: { wood: 0, stone: 0, ore: -5, iron: 5, grain: 0, meat: 0, gold: 0 },
      food: { grain: 0, meat: 0, fed: true, diverseDiet: false },
      resourcesAfter: { ...resources },
      populationBefore: 12,
      populationAfter: 12,
      populationReason: null,
      desertion: null,
      starvation: null,
    }
    expect(isSavedGameRecord(processed)).toBe(true)
  })

  it('rejects malformed terrain, territories and start guarantees', () => {
    const invalidTerrain = structuredClone(validRecord)
    invalidTerrain.match.scenario.cells[0].pop()
    expect(isSavedGameRecord(invalidTerrain)).toBe(false)

    const invalidTerritory = structuredClone(validRecord)
    invalidTerritory.match.scenario.territories[0][0] = 'missing-region'
    expect(isSavedGameRecord(invalidTerritory)).toBe(false)

    const invalidRegion = structuredClone(validRecord) as unknown as { match: { scenario: { regions: Array<{ reservedBuildSites?: unknown }> } } }
    delete invalidRegion.match.scenario.regions[0].reservedBuildSites
    expect(isSavedGameRecord(invalidRegion)).toBe(false)
  })
})

describe('IndexedDB transaction completion', () => {
  function fakeTransaction() {
    return {
      error: null,
      oncomplete: null,
      onabort: null,
      onerror: null,
    } as unknown as Pick<IDBTransaction, 'error' | 'oncomplete' | 'onabort' | 'onerror'>
  }

  it('does not resolve when only the request has completed', async () => {
    const transaction = fakeTransaction()
    const completed = vi.fn()
    const promise = transactionCompletion(transaction).then(completed)
    await Promise.resolve()
    expect(completed).not.toHaveBeenCalled()
    transaction.oncomplete?.call(transaction as IDBTransaction, new Event('complete'))
    await promise
    expect(completed).toHaveBeenCalledOnce()
  })

  it('rejects aborted transactions', async () => {
    const transaction = fakeTransaction()
    const rejection = expect(transactionCompletion(transaction)).rejects.toThrow('Saved game transaction failed')
    transaction.onabort?.call(transaction as IDBTransaction, new Event('abort'))
    await rejection
  })
})
