import type { MatchState } from '../match'
import type { AiProfileId } from '../scenario'
import type { AiMemory, AiPlan } from './model'
import type { AiWorkerRequest, AiWorkerResponse } from './workerProtocol'

interface PendingRequest {
  resolve: (plan: AiPlan) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort?: () => void
}

let requestSequence = 0
let worker: Worker | null = null
const pending = new Map<number, PendingRequest>()

function rejectPending(error: Error) {
  pending.forEach((request) => {
    if (request.signal && request.abort) request.signal.removeEventListener('abort', request.abort)
    request.reject(error)
  })
  pending.clear()
}

function disposeWorker(reason?: Error) {
  worker?.terminate()
  worker = null
  if (reason) rejectPending(reason)
}

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('../../workers/aiWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<AiWorkerResponse>) => {
    const request = pending.get(event.data.requestId)
    if (!request) return
    pending.delete(event.data.requestId)
    if (request.signal && request.abort) request.signal.removeEventListener('abort', request.abort)
    if (event.data.type === 'plan' && event.data.plan) request.resolve(event.data.plan)
    else request.reject(new Error(event.data.error ?? 'AI planning failed'))
  }
  worker.onerror = () => disposeWorker(new Error('AI worker failed'))
  return worker
}

export function resetAiPlanner() {
  if (!worker) return
  if (pending.size > 0) {
    disposeWorker(new DOMException('AI planner reset', 'AbortError'))
    return
  }
  const request: AiWorkerRequest = { type: 'reset', requestId: ++requestSequence }
  worker.postMessage(request)
}

export function calculateAiPlan(state: MatchState, memory: AiMemory, profileId: AiProfileId, signal?: AbortSignal): Promise<AiPlan> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('AI planning aborted', 'AbortError'))
      return
    }
    const activeWorker = ensureWorker()
    const requestId = ++requestSequence
    const abort = () => {
      if (!pending.has(requestId)) return
      disposeWorker(new DOMException('AI planning aborted', 'AbortError'))
    }
    pending.set(requestId, { resolve, reject, signal, abort })
    signal?.addEventListener('abort', abort, { once: true })
    const request: AiWorkerRequest = { type: 'plan', requestId, state, memory, profileId }
    activeWorker.postMessage(request)
  })
}
