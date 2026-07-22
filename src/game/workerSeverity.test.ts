import { describe, expect, it } from 'vitest'
import type { BuildingKind } from './map'
import { workerSeverity } from './match'

describe('workerSeverity', () => {
  const assignment = (
    overrides: Partial<{
      kind: BuildingKind
      required: number
      assigned: number
      blockedReason: 'missing-support' | 'idle-support' | 'no-workers'
    }>,
  ) => ({
    kind: 'mill' as BuildingKind,
    position: { column: 0, row: 0 },
    required: 2,
    assigned: 2,
    ...overrides,
  })

  it('is null when fully staffed', () => {
    expect(workerSeverity(assignment({ assigned: 2, required: 2 }))).toBeNull()
  })

  it('is null when overstaffed', () => {
    expect(workerSeverity(assignment({ assigned: 3, required: 2 }))).toBeNull()
  })

  it('is stopped when no workers are assigned', () => {
    expect(workerSeverity(assignment({ assigned: 0, required: 2 }))).toBe('stopped')
  })

  it('is stopped when blocked by no-workers', () => {
    expect(workerSeverity(assignment({ assigned: 0, required: 2, blockedReason: 'no-workers' }))).toBe('stopped')
  })

  it('is stopped when blocked by missing support, regardless of assigned count', () => {
    expect(workerSeverity(assignment({ assigned: 0, required: 2, blockedReason: 'missing-support' }))).toBe('stopped')
    expect(workerSeverity(assignment({ assigned: 1, required: 2, blockedReason: 'missing-support' }))).toBe('stopped')
  })

  it('is stopped when blocked by idle support', () => {
    expect(workerSeverity(assignment({ assigned: 1, required: 1, blockedReason: 'idle-support' }))).toBe('stopped')
  })

  it('is reduced when understaffed but producing', () => {
    expect(workerSeverity(assignment({ assigned: 1, required: 2 }))).toBe('reduced')
  })
})
