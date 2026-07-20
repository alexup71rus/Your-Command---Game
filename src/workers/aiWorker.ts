/// <reference lib="webworker" />

import { aiWorldAnalysisKey, analyzeAiWorld, type AiWorldAnalysis } from '../game/ai/analysis'
import { planAiTurn } from '../game/ai/planner'
import type { AiWorkerRequest, AiWorkerResponse } from '../game/ai/workerProtocol'

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope
const analysisCache = new Map<string, AiWorldAnalysis>()

function cacheKey(request: Extract<AiWorkerRequest, { type: 'plan' }>) {
  return aiWorldAnalysisKey(request.state.scenario, request.state.activeParticipantId)
}

scope.onmessage = (event: MessageEvent<AiWorkerRequest>) => {
  const request = event.data
  if (request.type === 'reset') {
    analysisCache.clear()
    const response: AiWorkerResponse = { requestId: request.requestId, type: 'reset' }
    scope.postMessage(response)
    return
  }
  try {
    const key = cacheKey(request)
    let analysis = analysisCache.get(key)
    if (!analysis) {
      analysis = analyzeAiWorld(request.state.scenario, request.state.activeParticipantId) ?? undefined
      if (analysis) analysisCache.set(key, analysis)
    }
    const response: AiWorkerResponse = {
      requestId: request.requestId,
      type: 'plan',
      plan: planAiTurn(request.state, request.memory, request.profileId, { cachedAnalysis: analysis }),
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
