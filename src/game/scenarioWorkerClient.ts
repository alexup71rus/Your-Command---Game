import type { GameMap } from './map'
import type { MapScenario, ScenarioResult } from './scenario'
import type { ScenarioWorkerRequest, ScenarioWorkerResponse, ScenarioWorkerResult } from './scenarioWorkerProtocol'

export const SCENARIO_WORKER_DEBOUNCE_MS = 120
export const SCENARIO_WORKER_TIMEOUT_MS = 15_000
const SCENARIO_WORKER_RETRIES = 1

export type ScenarioWorkerErrorCode = 'unsupported' | 'startup' | 'runtime' | 'protocol' | 'timeout'

export class ScenarioWorkerError extends Error {
  readonly code: ScenarioWorkerErrorCode

  constructor(code: ScenarioWorkerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ScenarioWorkerError'
    this.code = code
  }
}

let requestSequence = 0

const failureReasons = new Set(['not-enough-land', 'no-castle-sites', 'unviable-starts', 'unbalanced-regions'])

function isWorkerResult(value: unknown): value is ScenarioWorkerResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<ScenarioWorkerResult>
  if (result.ok === true) return Boolean(result.scenario && typeof result.scenario === 'object')
  if (result.ok !== false || !('reason' in result) || typeof result.reason !== 'string') return false
  return failureReasons.has(result.reason)
}

function isWorkerResponse(value: unknown): value is ScenarioWorkerResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<ScenarioWorkerResponse>
  return typeof response.key === 'string' && isWorkerResult(response.result)
}

export function calculateScenarioInWorker(
  map: GameMap,
  participantCount: number,
  seed: number,
  signal?: AbortSignal,
  metadata: Pick<Partial<MapScenario>, 'id' | 'name'> = {},
): Promise<ScenarioResult> {
  const key = `scenario-${++requestSequence}`

  return new Promise((resolve, reject) => {
    let activeWorker: Worker | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    let settled = false

    const stopWorker = () => {
      if (!activeWorker) return
      activeWorker.onmessage = null
      activeWorker.onerror = null
      activeWorker.onmessageerror = null
      activeWorker.terminate()
      activeWorker = null
    }
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      stopWorker()
      signal?.removeEventListener('abort', abort)
    }
    const finishResolve = (result: ScenarioResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const finishReject = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = () => finishReject(new DOMException('Scenario calculation aborted', 'AbortError'))
    const retryOrReject = (error: ScenarioWorkerError, retryable: boolean) => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      stopWorker()
      if (retryable && attempts <= SCENARIO_WORKER_RETRIES && !signal?.aborted) {
        timer = setTimeout(startWorker, 0)
        return
      }
      finishReject(error)
    }
    const startWorker = () => {
      timer = null
      if (settled || signal?.aborted) {
        abort()
        return
      }
      if (typeof Worker === 'undefined') {
        finishReject(new ScenarioWorkerError('unsupported', 'This browser does not support background map calculation'))
        return
      }
      attempts += 1
      try {
        activeWorker = new Worker(new URL('../workers/scenarioWorker.ts', import.meta.url), { type: 'module' })
      } catch (cause) {
        retryOrReject(new ScenarioWorkerError('startup', 'Could not start map calculation', { cause }), true)
        return
      }

      activeWorker.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (!isWorkerResponse(data) || data.key !== key) {
          retryOrReject(new ScenarioWorkerError('protocol', 'Map calculation returned invalid data'), false)
          return
        }
        finishResolve(data.result.ok
          ? { ok: true, scenario: { ...data.result.scenario, ...metadata, cells: map } }
          : data.result)
      }
      activeWorker.onerror = () => {
        retryOrReject(new ScenarioWorkerError('runtime', 'Map calculation failed'), true)
      }
      activeWorker.onmessageerror = () => {
        retryOrReject(new ScenarioWorkerError('protocol', 'Map calculation result could not be read'), true)
      }

      const request: ScenarioWorkerRequest = { key, map, participantCount, seed }
      try {
        activeWorker.postMessage(request)
        timer = setTimeout(() => {
          retryOrReject(new ScenarioWorkerError('timeout', 'Map calculation took too long'), true)
        }, SCENARIO_WORKER_TIMEOUT_MS)
      } catch (cause) {
        retryOrReject(new ScenarioWorkerError('startup', 'Could not send the map for calculation', { cause }), true)
      }
    }

    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(startWorker, SCENARIO_WORKER_DEBOUNCE_MS)
  })
}
