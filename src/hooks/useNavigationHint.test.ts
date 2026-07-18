import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config/game'
import { navigationHintDelay } from './useNavigationHint'

describe('navigation hint timing', () => {
  it('waits one minute after learning only one gesture', () => {
    expect(navigationHintDelay({ move: true, zoom: false })).toBe(
      gameConfig.navigationHint.partialDelayMs,
    )
  })

  it('waits ten seconds after both gestures are learned', () => {
    expect(navigationHintDelay({ move: true, zoom: true })).toBe(
      gameConfig.navigationHint.masteredDelayMs,
    )
  })
})
