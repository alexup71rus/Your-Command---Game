import { aiStrategicConfig } from '../../../config/ai'
import { buildingRules, resourceIds } from '../../../config/rules'
import type { BuildingKind } from '../../map'
import { ownedBuildingCount, tradeQuoteFor, type MatchState } from '../../match'
import type { CellPosition } from '../../scenario'
import type { AiMemory, AiSettlementPlan } from '../model'

export function ownedBuildingAt(state: MatchState, position: CellPosition, kind?: BuildingKind) {
  const object = state.scenario.cells[position.row]?.[position.column]?.object
  return object?.type === 'building' && object.ownerId === state.activeParticipantId && (!kind || object.kind === kind)
}

type FortificationLine = NonNullable<AiSettlementPlan['fortification']>['lines'][number]

export function fortificationLineStarted(state: MatchState, line: FortificationLine) {
  return (
    ownedBuildingAt(state, line.gate, 'barbican') ||
    line.walls.some((position) => ownedBuildingAt(state, position, 'wall')) ||
    line.towers.some((position) => ownedBuildingAt(state, position, 'tower'))
  )
}

export function fortificationLineActivated(state: MatchState, line: FortificationLine) {
  if (line.purpose !== 'surplus' || fortificationLineStarted(state, line)) return true
  const remainingStone =
    Number(!ownedBuildingAt(state, line.gate, 'barbican')) * (buildingRules.barbican.resourceCost.stone ?? 0) +
    line.walls.filter((position) => !ownedBuildingAt(state, position, 'wall')).length * (buildingRules.wall.resourceCost.stone ?? 0) +
    line.towers.filter((position) => !ownedBuildingAt(state, position, 'tower')).length * (buildingRules.tower.resourceCost.stone ?? 0)
  const stone = state.domains[state.activeParticipantId]?.resources.stone ?? 0
  return stone >= remainingStone + (line.activationStoneReserve ?? 0)
}

export function nextFortificationStep(state: MatchState, memory: AiMemory, allowStandaloneOutpost = false): BuildingKind | null {
  const plan = memory.settlementPlan?.fortification
  if (plan) {
    for (const line of plan.lines) {
      if (!fortificationLineActivated(state, line)) continue
      const ownedWalls = line.walls.filter((position) => ownedBuildingAt(state, position, 'wall')).length
      const missingWall = ownedWalls < line.walls.length
      const ownsTower = line.towers.some((position) => ownedBuildingAt(state, position, 'tower'))
      const missingTower = line.towers.some((position) => !ownedBuildingAt(state, position, 'tower'))
      const minimumWallsBeforeTower =
        line.towers.length > 0
          ? Math.min(line.walls.length, aiStrategicConfig.buildingGoals.minimumViableFortificationWalls)
          : line.walls.length
      if (!ownedBuildingAt(state, line.gate, 'barbican')) {
        const gateOccupant = state.scenario.cells[line.gate.row]?.[line.gate.column]?.object
        const enemyHoldsBreach = Boolean(gateOccupant && gateOccupant.ownerId !== state.activeParticipantId)
        // A destroyed gate must not deadlock the whole defense plan while an
        // invader stands on its blueprint cell. Under active attack, finish a
        // usable tower behind the surviving curtain; rebuilding the gate
        // becomes the next priority as soon as the breach is clear.
        if (allowStandaloneOutpost && enemyHoldsBreach && ownedWalls >= minimumWallsBeforeTower && !ownsTower && missingTower)
          return 'tower'
        return 'barbican'
      }
      if (ownedWalls < minimumWallsBeforeTower) return 'wall'
      // A fighting tower makes a partial curtain useful immediately. Build the
      // first one before spending the entire stone reserve on enclosure walls.
      if (!ownsTower && missingTower) return 'tower'
      if (missingWall) return 'wall'
      if (missingTower) return 'tower'
    }
  }
  const outpost = memory.settlementPlan?.reservedSites.outpostTower
  if (outpost && (plan || allowStandaloneOutpost) && !ownedBuildingAt(state, outpost, 'tower')) return 'tower'
  return null
}

export function minimumFortificationCostFor(memory: AiMemory) {
  const firstLine = memory.settlementPlan?.fortification?.lines[0]
  if (!firstLine) return null
  const minimumWalls =
    firstLine.kind === 'enclosure'
      ? firstLine.walls.length
      : Math.min(firstLine.walls.length, aiStrategicConfig.buildingGoals.minimumViableFortificationWalls)
  const committedTowers = firstLine.kind === 'enclosure' ? firstLine.towers.length : 0
  return [
    buildingRules.barbican.resourceCost,
    ...Array.from({ length: minimumWalls }, () => buildingRules.wall.resourceCost),
    ...Array.from({ length: committedTowers }, () => buildingRules.tower.resourceCost),
  ].reduce(
    (total, current) => {
      resourceIds.forEach((resource) => {
        total[resource] = (total[resource] ?? 0) + (current[resource] ?? 0)
      })
      return total
    },
    {} as Partial<Record<(typeof resourceIds)[number], number>>,
  )
}

export function fortificationStarted(state: MatchState, memory: AiMemory) {
  const plan = memory.settlementPlan?.fortification
  return (
    Boolean(
      plan &&
      plan.lines.some(
        (line) =>
          ownedBuildingAt(state, line.gate, 'barbican') ||
          line.walls.some((position) => ownedBuildingAt(state, position, 'wall')) ||
          line.towers.some((position) => ownedBuildingAt(state, position, 'tower')),
      ),
    ) ||
    Boolean(
      memory.settlementPlan?.reservedSites.outpostTower &&
      ownedBuildingAt(state, memory.settlementPlan.reservedSites.outpostTower, 'tower'),
    )
  )
}

export function canFundMinimumFortification(state: MatchState, memory: AiMemory) {
  const plan = memory.settlementPlan?.fortification
  if (!plan) return false
  const cost = minimumFortificationCostFor(memory)
  if (!cost) return false
  const resources = state.domains[state.activeParticipantId].resources
  if (resourceIds.every((resource) => resources[resource] >= (cost[resource] ?? 0))) return true
  const hasMarket = ownedBuildingCount(state, state.activeParticipantId, 'market') > 0
  if (!hasMarket) return false
  const domain = state.domains[state.activeParticipantId]
  const purchaseGold = resourceIds.reduce((total, resource) => {
    if (resource === 'gold') return total
    const shortfall = Math.max(0, (cost[resource] ?? 0) - resources[resource])
    return total + (shortfall > 0 ? tradeQuoteFor(domain, resource, 'buy', shortfall).total : 0)
  }, cost.gold ?? 0)
  return resources.gold >= purchaseGold
}
