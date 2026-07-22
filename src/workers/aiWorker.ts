/// <reference lib="webworker" />

import { aiWorldAnalysisKey, analyzeAiWorld, type AiWorldAnalysis } from '../game/ai/analysis'
import { planAiTurn } from '../game/ai/planner'
import type { AiWorkerRequest, AiWorkerResponse } from '../game/ai/workerProtocol'
import { typescriptDistanceFieldKernel, type DistanceFieldKernel } from '../game/grid/distanceField'
import { loadWasmDistanceFieldKernel } from '../game/grid/distanceFieldWasm'

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope
const analysisCache = new Map<string, AiWorldAnalysis>()
let distanceFieldKernel: DistanceFieldKernel = typescriptDistanceFieldKernel
const distanceFieldKernelReady = loadWasmDistanceFieldKernel()
  .then((kernel) => { distanceFieldKernel = kernel })
  // Loading failure is non-fatal: the deterministic TypeScript kernel remains active.
  .catch(() => undefined)

function cacheKey(request: Extract<AiWorkerRequest, { type: 'plan' }>) {
  return aiWorldAnalysisKey(request.state.scenario, request.state.activeParticipantId)
}

scope.onmessage = async (event: MessageEvent<AiWorkerRequest>) => {
  const request = event.data
  await distanceFieldKernelReady
  if (request.type === 'reset') {
    analysisCache.clear()
    const response: AiWorkerResponse = { requestId: request.requestId, type: 'reset' }
    scope.postMessage(response)
    return
  }
  try {
    const key = cacheKey(request)
    let analysis = analysisCache.get(key)
    let worldAnalysisMs = 0
    if (!analysis) {
      const analysisStartedAt = performance.now()
      analysis = analyzeAiWorld(
        request.state.scenario,
        request.state.activeParticipantId,
        distanceFieldKernel,
      ) ?? undefined
      worldAnalysisMs = performance.now() - analysisStartedAt
      if (analysis) analysisCache.set(key, analysis)
    }
    const plan = planAiTurn(
      request.state,
      request.memory,
      request.profileId,
      { cachedAnalysis: analysis },
    )
    plan.timings.worldAnalysisMs += worldAnalysisMs
    plan.timings.totalMs += worldAnalysisMs
    const response: AiWorkerResponse = {
      requestId: request.requestId,
      type: 'plan',
      plan,
    }
    scope.postMessage(response)
  } catch (error) {
    const response: AiWorkerResponse = {
      requestId: request.requestId,
      type: 'error',
      error: error instanceof Error ? error.message : 'AI planning failed',
    }
    scope.postMessage(response)
  }
}

export {}
