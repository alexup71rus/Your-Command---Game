import { describe, expect, it } from 'vitest'
import { escapeTarget, overlayAfterEscape, savedGameLoadNeedsConfirmation } from './flow'

describe('game flow', () => {
  it('closes a generator opened from the main menu with Escape', () => {
    expect(overlayAfterEscape('menu', 'generator')).toBeNull()
  })

  it('closes settings with Escape', () => {
    expect(overlayAfterEscape('playing', 'settings')).toBeNull()
  })

  it('opens settings from the main menu', () => {
    expect(overlayAfterEscape('menu', null)).toBe('settings')
  })

  it('opens settings from a running game', () => {
    expect(overlayAfterEscape('playing', null)).toBe('settings')
  })

  it('dismisses a victory outcome before opening settings', () => {
    expect(escapeTarget({ contextMenuOpen: false, overlay: null, outcomeOpen: true, pendingAction: false })).toBe('outcome')
    expect(escapeTarget({ contextMenuOpen: false, overlay: null, outcomeOpen: false, pendingAction: false })).toBe('settings')
  })

  it('cancels a pending action before opening settings', () => {
    expect(escapeTarget({ contextMenuOpen: false, overlay: null, outcomeOpen: false, pendingAction: true })).toBe('pending-action')
  })

  it('requires confirmation only when loading over a running match', () => {
    expect(savedGameLoadNeedsConfirmation('playing', true)).toBe(true)
    expect(savedGameLoadNeedsConfirmation('menu', true)).toBe(false)
    expect(savedGameLoadNeedsConfirmation('playing', false)).toBe(false)
  })
})
