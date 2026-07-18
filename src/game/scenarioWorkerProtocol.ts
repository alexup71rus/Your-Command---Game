import type { GameMap } from './map'
import type { MapScenario, ScenarioResult } from './scenario'

export interface ScenarioWorkerRequest {
  key: string
  map: GameMap
  participantCount: number
  seed: number
}

type ScenarioWithoutCells = Omit<MapScenario, 'cells'>

export type ScenarioWorkerResult =
  | { ok: true; scenario: ScenarioWithoutCells }
  | Exclude<ScenarioResult, { ok: true }>

export interface ScenarioWorkerResponse {
  key: string
  result: ScenarioWorkerResult
}
