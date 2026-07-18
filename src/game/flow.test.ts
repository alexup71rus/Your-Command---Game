import { describe, expect, it } from 'vitest'
import { overlayAfterEscape } from './flow'

describe('game flow', () => {
  it('closes a generator opened from the main menu with Escape', () => {
    expect(overlayAfterEscape('menu', 'generator')).toBeNull()
  })

  it('closes settings with Escape', () => {
    expect(overlayAfterEscape('playing', 'settings')).toBeNull()
  })

  it('opens settings from a running game', () => {
    expect(overlayAfterEscape('playing', null)).toBe('settings')
  })
})
