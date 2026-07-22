import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config/game'
import { buildingRules, troopRules } from '../config/rules'
import { actionPreviewFor, orderCostFor } from './interaction'

describe('game interaction presentation', () => {
  it('builds previews only for actions with a map target', () => {
    expect(actionPreviewFor(null)).toBeNull()
    expect(actionPreviewFor({ kind: 'build', building: 'farm' })).toEqual({ kind: 'building', building: 'farm' })
    expect(actionPreviewFor({ kind: 'recruit', troop: 'archers', quantity: 3 })).toEqual({
      kind: 'squad',
      units: { militia: 0, spearmen: 0, archers: 3, knights: 0 },
    })
    expect(
      actionPreviewFor({
        kind: 'dismiss',
        source: { column: 1, row: 2 },
        units: { militia: 1, spearmen: 0, archers: 0, knights: 0 },
      }),
    ).toBeNull()
  })

  it('uses the configured order cost for each command family', () => {
    expect(orderCostFor({ kind: 'build', building: 'tower' })).toBe(buildingRules.tower.actionCost)
    expect(orderCostFor({ kind: 'recruit', troop: 'knights', quantity: 1 })).toBe(troopRules.knights.actionCost)
    expect(
      orderCostFor({
        kind: 'split',
        source: { column: 0, row: 0 },
        units: { militia: 1, spearmen: 0, archers: 0, knights: 0 },
      }),
    ).toBe(gameConfig.turn.squadReorganizationOrderCost)
    expect(orderCostFor({ kind: 'tower-attack', tower: { column: 2, row: 3 } })).toBe(buildingRules.tower.garrison?.attackOrderCost ?? 0)
  })
})
