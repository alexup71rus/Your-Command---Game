import type { MatchState } from '../match'
import type { AiProfileId } from '../scenario'
import type { AiMemory, AiPlan } from './model'

export type AiWorkerRequest =
  | { type: 'plan'; requestId: number; state: MatchState; memory: AiMemory; profileId: AiProfileId }
  | { type: 'reset'; requestId: number }

export interface AiWorkerResponse {
  requestId: number
  type: 'plan' | 'reset' | 'error'
  plan?: AiPlan
  error?: string
}
