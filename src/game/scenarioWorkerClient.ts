import type { GameMap } from './map'
import type { ScenarioResult } from './scenario'
import type { ScenarioWorkerRequest, ScenarioWorkerResponse } from './scenarioWorkerProtocol'

let requestSequence = 0

export function calculateScenarioInWorker(
  map: GameMap,
  participantCount: number,
  seed: number,
  signal?: AbortSignal,
): Promise<ScenarioResult> {
  const key = `scenario-${++requestSequence}`
  const worker = new Worker(new URL('../workers/scenarioWorker.ts', import.meta.url), { type: 'module' })

  return new Promise((resolve, reject) => {
    const finish = () => worker.terminate()
    const abort = () => {
      finish()
      reject(new DOMException('Scenario calculation aborted', 'AbortError'))
    }

    if (signal?.aborted) {
      abort()
      return
    }

    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = ({ data }: MessageEvent<ScenarioWorkerResponse>) => {
      if (data.key !== key) return
      signal?.removeEventListener('abort', abort)
      finish()
      resolve(data.result.ok
        ? { ok: true, scenario: { ...data.result.scenario, cells: map } }
        : data.result)
    }
    worker.onerror = () => {
      signal?.removeEventListener('abort', abort)
      finish()
      reject(new Error('Scenario worker failed'))
    }

    const request: ScenarioWorkerRequest = { key, map, participantCount, seed }
    worker.postMessage(request)
  })
}
