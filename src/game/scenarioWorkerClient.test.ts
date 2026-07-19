import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameMap } from './map'
import { calculateScenarioInWorker, SCENARIO_WORKER_DEBOUNCE_MS, SCENARIO_WORKER_TIMEOUT_MS, ScenarioWorkerError } from './scenarioWorkerClient'

const map: GameMap = [[{ elevation: 0.2, landform: 'plain', vegetation: false }]]

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  request: { key: string } | null = null
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(request: { key: string }) {
    this.request = request
  }

  terminate() {
    this.terminated = true
  }
}

describe('scenario worker client', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not start obsolete work aborted during the debounce window', async () => {
    const controller = new AbortController()
    const promise = calculateScenarioInWorker(map, 2, 1, controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(SCENARIO_WORKER_DEBOUNCE_MS)
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('restores local cells and direct-map metadata in a successful response', async () => {
    const promise = calculateScenarioInWorker(map, 2, 1, undefined, { id: 'saved-map', name: 'My map' })
    await vi.advanceTimersByTimeAsync(SCENARIO_WORKER_DEBOUNCE_MS)
    const worker = FakeWorker.instances[0]
    worker.onmessage?.({ data: {
      key: worker.request?.key,
      result: {
        ok: true,
        scenario: { id: 'custom-1', name: 'Custom world', seed: 1, participantCount: 2, territories: [[null]], regions: [], participants: [] },
      },
    } } as MessageEvent)
    await expect(promise).resolves.toMatchObject({ ok: true, scenario: { id: 'saved-map', name: 'My map', cells: map } })
    expect(worker.terminated).toBe(true)
  })

  it('retries a runtime failure once with a fresh worker', async () => {
    const promise = calculateScenarioInWorker(map, 2, 1)
    await vi.advanceTimersByTimeAsync(SCENARIO_WORKER_DEBOUNCE_MS)
    const first = FakeWorker.instances[0]
    first.onerror?.({} as ErrorEvent)
    await vi.advanceTimersByTimeAsync(1)
    const second = FakeWorker.instances[1]
    second.onmessage?.({ data: { key: second.request?.key, result: { ok: false, reason: 'unviable-starts' } } } as MessageEvent)
    await expect(promise).resolves.toEqual({ ok: false, reason: 'unviable-starts' })
    expect(first.terminated).toBe(true)
    expect(second.terminated).toBe(true)
  })

  it('rejects a malformed matching response without retrying', async () => {
    const promise = calculateScenarioInWorker(map, 2, 1)
    await vi.advanceTimersByTimeAsync(SCENARIO_WORKER_DEBOUNCE_MS)
    const worker = FakeWorker.instances[0]
    worker.onmessage?.({ data: { key: worker.request?.key, result: { surprising: true } } } as MessageEvent)
    await expect(promise).rejects.toMatchObject({ name: 'ScenarioWorkerError', code: 'protocol' })
    expect(FakeWorker.instances).toHaveLength(1)
  })

  it('retries once and reports a worker that never responds', async () => {
    const promise = calculateScenarioInWorker(map, 2, 1)
    const outcome = promise.then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(SCENARIO_WORKER_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(SCENARIO_WORKER_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWorker.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(SCENARIO_WORKER_TIMEOUT_MS)
    await expect(outcome).resolves.toMatchObject({ name: 'ScenarioWorkerError', code: 'timeout' })
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true)
  })

  it('reports unsupported environments explicitly', async () => {
    vi.stubGlobal('Worker', undefined)
    const promise = calculateScenarioInWorker(map, 2, 1)
    const rejection = expect(promise).rejects.toMatchObject({ name: 'ScenarioWorkerError', code: 'unsupported' })
    await vi.advanceTimersByTimeAsync(SCENARIO_WORKER_DEBOUNCE_MS)
    await rejection
    expect(ScenarioWorkerError).toBeDefined()
  })
})
