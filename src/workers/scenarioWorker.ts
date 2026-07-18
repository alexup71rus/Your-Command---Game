import { createMapScenario } from '../game/scenario'
import type { ScenarioWorkerRequest, ScenarioWorkerResponse } from '../game/scenarioWorkerProtocol'

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ScenarioWorkerRequest>) => void) | null
  postMessage: (message: ScenarioWorkerResponse) => void
}

workerScope.onmessage = ({ data }) => {
  const result = createMapScenario(data.map, data.participantCount, data.seed)
  if (!result.ok) {
    workerScope.postMessage({ key: data.key, result })
    return
  }

  const { cells: _cells, ...scenario } = result.scenario
  workerScope.postMessage({ key: data.key, result: { ok: true, scenario } })
}
