import { buildingRules } from '../../config/rules'
import { aiBuildingKindsByZone, aiSpatialConfig } from '../../config/ai'
import type { BuildingKind, GameMap, MapObject } from '../map'
import { buildingFootprintPositions } from '../match'
import { clockwiseCardinalDirections } from '../geometry'
import { findMovementPath } from '../pathfinding'
import { terrainMovementOrderMultiplier } from '../movement'
import type { CellPosition, MapScenario } from '../scenario'
import type { AiLayoutKind, AiOpeningKind, AiProfileRules, AiSettlementPlan, AiSettlementZoneKind } from './model'

export interface AiObjectEntry {
  object: MapObject
  position: CellPosition
}

export interface AiCellAnalysis {
  inRegion: boolean
  passable: boolean
  distanceToCastle: number
  distanceToBorder: number
  distanceToForest: number
  distanceToHill: number
  distanceToPeak: number
  adjacentForest: number
  passableNeighbors: number
  chokeScore: number
  lineOfFireScore: number
  plainOpportunity: number
  hillOpportunity: number
}

export interface AiWorldAnalysis {
  key: string
  ownerId: string
  regionId: string
  castle: CellPosition
  front: CellPosition
  cells: AiCellAnalysis[][]
  hillScarcity: number
  forestCoverage: number
  plainCoverage: number
  layoutScores: Record<AiLayoutKind, number>
  openingScores: Record<AiOpeningKind, number>
}

export const positionKey = (position: CellPosition) => `${position.column}:${position.row}`
export const positionDistance = (first: CellPosition, second: CellPosition) => Math.abs(first.column - second.column) + Math.abs(first.row - second.row)
export const samePosition = (first: CellPosition, second: CellPosition) => first.column === second.column && first.row === second.row

function hashText(hash: number, value: string) {
  let result = hash
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619) >>> 0
  return result
}

export function aiWorldAnalysisKey(scenario: MapScenario, ownerId: string) {
  let hash = hashText(2166136261, `${scenario.id}:${scenario.seed}:${ownerId}`)
  scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    hash = Math.imul(hash ^ Math.round((cell.elevation ?? 0) * 1_000), 16777619) >>> 0
    hash = Math.imul(hash ^ (cell.landform === 'peak' ? 3 : cell.landform === 'hill' ? 2 : 1), 16777619) >>> 0
    hash = Math.imul(hash ^ Number(Boolean(cell.vegetation)), 16777619) >>> 0
    hash = hashText(hash, scenario.territories[rowIndex]?.[column] ?? '')
    if (cell.object?.type === 'castle') hash = hashText(hash, `${cell.object.ownerId}:${column}:${rowIndex}`)
  }))
  return `${scenario.id}:${scenario.cells.length}:${scenario.cells[0]?.length ?? 0}:${ownerId}:${hash.toString(16)}`
}

export function isPrimaryObject(object: MapObject, position: CellPosition) {
  return object.type !== 'building' || !object.footprint
    || (object.footprint.originColumn === position.column && object.footprint.originRow === position.row)
}

export function aiObjectEntries(scenario: Pick<MapScenario, 'cells'>, ownerId?: string): AiObjectEntry[] {
  return scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
    const object = cell.object
    const position = { column, row: rowIndex }
    return object && (!ownerId || object.ownerId === ownerId) && isPrimaryObject(object, position) ? [{ object, position }] : []
  }))
}

export function castlePositionFor(scenario: Pick<MapScenario, 'cells'>, ownerId: string) {
  return aiObjectEntries(scenario, ownerId).find((entry) => entry.object.type === 'castle')?.position ?? null
}

function multiSourceDistances(
  scenario: Pick<MapScenario, 'cells' | 'territories'>,
  regionId: string,
  sources: CellPosition[],
  restrictToRegion = true,
) {
  const rows = scenario.cells.length
  const columns = scenario.cells[0]?.length ?? 0
  const distances = Array.from({ length: rows }, () => Array<number>(columns).fill(Number.POSITIVE_INFINITY))
  const queue: CellPosition[] = []
  sources.forEach((source) => {
    if (!scenario.cells[source.row]?.[source.column]) return
    distances[source.row][source.column] = 0
    queue.push(source)
  })
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    for (const direction of clockwiseCardinalDirections) {
      const next = { column: current.column + direction.column, row: current.row + direction.row }
      const cell = scenario.cells[next.row]?.[next.column]
      if (!cell || cell.landform === 'peak') continue
      if (restrictToRegion && scenario.territories[next.row]?.[next.column] !== regionId) continue
      const nextDistance = distances[current.row][current.column] + 1
      if (nextDistance >= distances[next.row][next.column]) continue
      distances[next.row][next.column] = nextDistance
      queue.push(next)
    }
  }
  return distances
}

function borderCells(scenario: Pick<MapScenario, 'cells' | 'territories'>, regionId: string) {
  const result: CellPosition[] = []
  scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    if (cell.landform === 'peak' || scenario.territories[rowIndex]?.[column] !== regionId) return
    if (clockwiseCardinalDirections.some((direction) => scenario.territories[rowIndex + direction.row]?.[column + direction.column] !== regionId)) {
      result.push({ column, row: rowIndex })
    }
  }))
  return result
}

function nearestEnemyCastle(scenario: MapScenario, ownerId: string, castle: CellPosition) {
  return scenario.participants
    .filter((participant) => participant.id !== ownerId)
    .flatMap((participant) => {
      const position = castlePositionFor(scenario, participant.id)
      return position ? [{ position, distance: positionDistance(castle, position) }] : []
    })
    .sort((first, second) => first.distance - second.distance || first.position.row - second.position.row || first.position.column - second.position.column)[0]?.position
    ?? castle
}

function coverageCells(scenario: MapScenario, regionId: string) {
  return scenario.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => scenario.territories[rowIndex]?.[column] === regionId
    ? [{ cell, position: { column, row: rowIndex } }]
    : []))
}

export function analyzeAiWorld(scenario: MapScenario, ownerId: string): AiWorldAnalysis | null {
  const participant = scenario.participants.find((candidate) => candidate.id === ownerId)
  const castle = castlePositionFor(scenario, ownerId)
  if (!participant || !castle) return null
  const regionId = participant.regionId
  const regionCells = coverageCells(scenario, regionId)
  const passable = regionCells.filter(({ cell }) => cell.landform !== 'peak')
  const forests = passable.filter(({ cell }) => cell.vegetation).map(({ position }) => position)
  const hills = passable.filter(({ cell }) => cell.landform === 'hill' && !cell.vegetation).map(({ position }) => position)
  const peaks = regionCells.filter(({ cell }) => cell.landform === 'peak').map(({ position }) => position)
  const borders = borderCells(scenario, regionId)
  const castleDistances = multiSourceDistances(scenario, regionId, [castle])
  const forestDistances = multiSourceDistances(scenario, regionId, forests.length ? forests : borders)
  const hillDistances = multiSourceDistances(scenario, regionId, hills.length ? hills : borders)
  const peakDistances = multiSourceDistances(scenario, regionId, peaks.length ? peaks : borders, false)
  const borderDistances = multiSourceDistances(scenario, regionId, borders)
  const front = nearestEnemyCastle(scenario, ownerId, castle)
  const cells = scenario.cells.map((row, rowIndex) => row.map((cell, column): AiCellAnalysis => {
    const inRegion = scenario.territories[rowIndex]?.[column] === regionId
    const neighbors = clockwiseCardinalDirections.filter((direction) => {
      const candidate = scenario.cells[rowIndex + direction.row]?.[column + direction.column]
      return candidate && candidate.landform !== 'peak' && scenario.territories[rowIndex + direction.row]?.[column + direction.column] === regionId
    }).length
    const adjacentForest = clockwiseCardinalDirections.reduce((total, direction) => total + Number(scenario.cells[rowIndex + direction.row]?.[column + direction.column]?.vegetation), 0)
    const distanceToFrontLine = Math.abs((front.column - castle.column) * (rowIndex - castle.row) - (front.row - castle.row) * (column - castle.column))
    const lineOfFireScore = inRegion && cell.landform !== 'peak'
      ? clockwiseCardinalDirections.reduce((total, direction) => {
        let length = 0
        for (let step = 1; step <= aiSpatialConfig.lineOfFireRayLength; step += 1) {
          const target = scenario.cells[rowIndex + direction.row * step]?.[column + direction.column * step]
          if (!target || target.landform === 'peak' || target.vegetation) break
          length += 1
        }
        return total + length
      }, 0)
      : 0
    return {
      inRegion,
      passable: inRegion && cell.landform !== 'peak',
      distanceToCastle: castleDistances[rowIndex]?.[column] ?? Number.POSITIVE_INFINITY,
      distanceToBorder: borderDistances[rowIndex]?.[column] ?? Number.POSITIVE_INFINITY,
      distanceToForest: forestDistances[rowIndex]?.[column] ?? Number.POSITIVE_INFINITY,
      distanceToHill: hillDistances[rowIndex]?.[column] ?? Number.POSITIVE_INFINITY,
      distanceToPeak: peakDistances[rowIndex]?.[column] ?? Number.POSITIVE_INFINITY,
      adjacentForest,
      passableNeighbors: neighbors,
      chokeScore: inRegion && cell.landform !== 'peak'
        ? Math.max(0, aiSpatialConfig.choke.blockedNeighborBase - neighbors) * aiSpatialConfig.choke.blockedNeighborWeight
          + Math.max(0, aiSpatialConfig.choke.frontLineBase - distanceToFrontLine * aiSpatialConfig.choke.frontLineDistanceWeight)
        : 0,
      lineOfFireScore,
      plainOpportunity: inRegion && cell.landform === 'plain' && !cell.vegetation ? 1 : 0,
      hillOpportunity: inRegion && cell.landform === 'hill' && !cell.vegetation ? 1 : 0,
    }
  }))
  const passableCount = Math.max(1, passable.length)
  const forestCoverage = forests.length / passableCount
  const hillCoverage = hills.length / passableCount
  const plainCoverage = passable.filter(({ cell }) => cell.landform === 'plain' && !cell.vegetation).length / passableCount
  const averageChoke = passable.reduce((sum, { position }) => sum + cells[position.row][position.column].chokeScore, 0) / passableCount
  const layoutScore = aiSpatialConfig.layoutScore
  const layoutScores: Record<AiLayoutKind, number> = {
    courtyard: plainCoverage * layoutScore.courtyard.plain
      + Math.min(layoutScore.courtyard.passableCap, passableCount / layoutScore.courtyard.passableDivisor)
      + averageChoke * layoutScore.courtyard.choke,
    frontier: (forestCoverage + hillCoverage) * layoutScore.frontier.mixedTerrain
      + Math.min(layoutScore.frontier.distanceCap, positionDistance(castle, front) * layoutScore.frontier.distance),
    strongpoint: averageChoke * layoutScore.strongpoint.choke + hillCoverage * layoutScore.strongpoint.hill
      + (1 - plainCoverage) * layoutScore.strongpoint.nonPlain,
  }
  const openingScore = aiSpatialConfig.openingScore
  const openingScores: Record<AiOpeningKind, number> = {
    forest: forestCoverage * openingScore.forest.coverage
      + Math.max(0, openingScore.forest.nearbyDistance - (forestDistances[castle.row]?.[castle.column] ?? openingScore.forest.nearbyDistance)) * openingScore.forest.proximity,
    plains: plainCoverage * openingScore.plains.coverage,
    highland: hillCoverage * openingScore.highland.coverage
      + Math.max(0, openingScore.highland.nearbyDistance - (hillDistances[castle.row]?.[castle.column] ?? openingScore.highland.nearbyDistance)) * openingScore.highland.proximity,
  }
  return {
    key: aiWorldAnalysisKey(scenario, ownerId),
    ownerId,
    regionId,
    castle,
    front,
    cells,
    hillScarcity: 1 - hillCoverage,
    forestCoverage,
    plainCoverage,
    layoutScores,
    openingScores,
  }
}

function deterministicRank(seed: number, value: string) {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0
  return hash / 0xffffffff
}

function chooseAllowed<T extends string>(scores: Record<T, number>, allowed: readonly T[], preference: readonly T[], seed: number) {
  return [...allowed].sort((first, second) => {
    const preferenceBonus = (value: T) => Math.max(0, preference.length - preference.indexOf(value)) * aiSpatialConfig.preferenceBonus
    const difference = scores[second] + preferenceBonus(second) - scores[first] - preferenceBonus(first)
    if (Math.abs(difference) > aiSpatialConfig.settlementPlan.scoreTieEpsilon) return difference
    return deterministicRank(seed, first) - deterministicRank(seed, second)
  })[0]
}

function strippedMap(map: GameMap): GameMap {
  return map.map((row) => row.map((cell) => ({ ...cell, object: undefined })))
}

function corridorToTarget(analysis: AiWorldAnalysis, scenario: MapScenario, target: CellPosition) {
  const regionTargets = borderCells(scenario, analysis.regionId)
    .sort((first, second) => positionDistance(first, target) - positionDistance(second, target)
      || first.row - second.row || first.column - second.column)
  const map = strippedMap(scenario.cells)
  for (const target of regionTargets) {
    const path = findMovementPath(map, analysis.castle, target)
    if (path) return path.slice(1)
  }
  return []
}

function bestSiteNear(analysis: AiWorldAnalysis, predicate: (position: CellPosition, cell: AiCellAnalysis) => boolean, targetDistance: number) {
  const candidates = analysis.cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => {
    const position = { column, row: rowIndex }
    return predicate(position, cell) ? [{
      position,
      score: -Math.abs(cell.distanceToCastle - targetDistance) - cell.chokeScore * aiSpatialConfig.settlementPlan.siteChokeWeight,
    }] : []
  }))
  candidates.sort((first, second) => second.score - first.score || first.position.row - second.position.row || first.position.column - second.position.column)
  return candidates[0]?.position
}

function fortificationLineFor(
  analysis: AiWorldAnalysis,
  scenario: MapScenario,
  corridor: CellPosition[],
  wallLimit: number,
  towerLimit: number,
): NonNullable<AiSettlementPlan['fortification']>['lines'][number] | null {
  if (wallLimit < aiSpatialConfig.settlementPlan.fortification.minimumWalls) return null
  const config = aiSpatialConfig.settlementPlan.fortification
  const approach = corridor.at(-1)
  if (!approach) return null
  const desiredIndex = Math.min(corridor.length - 1, Math.max(
    config.minimumCastleDistance,
    Math.floor(corridor.length * aiSpatialConfig.gateCorridorShare),
  ))
  const maximumIndex = Math.min(corridor.length - 1, Math.max(
    config.minimumCastleDistance,
    Math.floor(corridor.length * config.maximumCorridorShare),
  ))
  const startIndex = config.minimumCastleDistance
  const endIndex = maximumIndex
  const isOpen = (position: CellPosition) => {
    const cell = scenario.cells[position.row]?.[position.column]
    return Boolean(cell && cell.landform !== 'peak' && !cell.vegetation
      && scenario.territories[position.row]?.[position.column] === analysis.regionId
      && !cell.object)
  }
  const isNaturalAnchor = (position: CellPosition) => {
    const cell = scenario.cells[position.row]?.[position.column]
    return !cell || cell.landform === 'peak'
      || scenario.territories[position.row]?.[position.column] !== analysis.regionId
  }
  const routeLength = (blocked: Set<string>) => {
    const path = findMovementPath(stripped, approach, analysis.castle, {
      cellCost: (position, cell) => blocked.has(positionKey(position))
        || scenario.territories[position.row]?.[position.column] !== analysis.regionId
        ? Number.POSITIVE_INFINITY
        : terrainMovementOrderMultiplier(cell),
    })
    return path?.slice(1).reduce((sum, position) => {
      const cell = scenario.cells[position.row]?.[position.column]
      return sum + (cell ? terrainMovementOrderMultiplier(cell) : 0)
    }, 0) ?? Number.POSITIVE_INFINITY
  }
  const stripped = strippedMap(scenario.cells)
  const baselineRouteLength = routeLength(new Set())
  const candidates: Array<{
    gate: CellPosition
    walls: CellPosition[]
    towers: CellPosition[]
    naturalAnchors: number
    score: number
  }> = []
  for (let index = startIndex; index <= endIndex; index += 1) {
    const gate = corridor[index]
    if (!gate || !isOpen(gate)) continue
    const previous = corridor[Math.max(0, index - 1)] ?? analysis.castle
    const next = corridor[Math.min(corridor.length - 1, index + 1)] ?? analysis.front
    const rowDelta = next.row - previous.row
    const columnDelta = next.column - previous.column
    const perpendicular = Math.abs(columnDelta) >= Math.abs(rowDelta)
      ? { column: 0, row: 1 }
      : { column: 1, row: 0 }
    const sides = [-1, 1] as const
    const walls: CellPosition[] = []
    const sideWalls: Record<(typeof sides)[number], CellPosition[]> = { '-1': [], '1': [] }
    const sideOpen: Record<(typeof sides)[number], boolean> = { '-1': true, '1': true }
    let naturalAnchors = 0
    for (let offset = 1; walls.length < wallLimit && (sideOpen[-1] || sideOpen[1]); offset += 1) {
      for (const side of sides) {
        if (!sideOpen[side] || walls.length >= wallLimit) continue
        const position = {
          column: gate.column + perpendicular.column * offset * side,
          row: gate.row + perpendicular.row * offset * side,
        }
        if (!isOpen(position)) {
          sideOpen[side] = false
          if (isNaturalAnchor(position)) naturalAnchors += 1
          continue
        }
        walls.push(position)
        sideWalls[side].push(position)
      }
    }
    for (const side of sides) {
      const offset = sideWalls[side].length + 1
      const endpoint = {
        column: gate.column + perpendicular.column * offset * side,
        row: gate.row + perpendicular.row * offset * side,
      }
      if (sideOpen[side] && isNaturalAnchor(endpoint)) naturalAnchors += 1
    }
    if (walls.length < config.minimumWalls) continue
    const towers = sides.flatMap((side) => {
      if (towerLimit <= 0 || sideWalls[side].length === 0) return []
      const offset = sideWalls[side].length + 1
      const position = {
        column: gate.column + perpendicular.column * offset * side,
        row: gate.row + perpendicular.row * offset * side,
      }
      return isOpen(position) ? [position] : []
    }).slice(0, towerLimit)
    const friendlyRouteLength = routeLength(new Set([...walls, ...towers].map(positionKey)))
    if (!Number.isFinite(friendlyRouteLength)) continue
    const fortifiedRouteLength = routeLength(new Set([gate, ...walls, ...towers].map(positionKey)))
    const pathDelay = Number.isFinite(fortifiedRouteLength)
      ? Math.max(0, fortifiedRouteLength - baselineRouteLength)
      : Number.POSITIVE_INFINITY
    const cell = analysis.cells[gate.row]?.[gate.column]
    const weakLinePenalty = Number.isFinite(pathDelay)
      ? Math.max(0, config.minimumPathDelay - pathDelay) * config.weakLinePenalty
      : 0
    const score = (cell?.chokeScore ?? 0) * config.chokeWeight
      + naturalAnchors * config.naturalAnchorBonus
      + walls.length * config.wallCountBonus
      + (Number.isFinite(pathDelay) ? pathDelay * config.pathDelayWeight : config.sealedApproachBonus)
      - Math.abs(index - desiredIndex) * config.preferredDistanceWeight
      - weakLinePenalty
    candidates.push({ gate, walls, towers, naturalAnchors, score })
  }
  candidates.sort((first, second) => second.score - first.score
    || first.gate.row - second.gate.row || first.gate.column - second.gate.column)
  const best = candidates[0]
  if (!best) return null
  const kind = best.naturalAnchors > 0 ? 'terrain-gate' : towerLimit > 0 ? 'bastion' : 'curtain'
  return { kind, approach, gate: best.gate, walls: best.walls, towers: best.towers }
}

function fortificationPlanFor(
  analysis: AiWorldAnalysis,
  scenario: MapScenario,
  profile: AiProfileRules,
): AiSettlementPlan['fortification'] {
  const totalWallLimit = profile.settlement.buildingLimits.wall ?? 0
  const totalTowerLimit = profile.settlement.buildingLimits.tower ?? 0
  const lineLimit = Math.min(
    profile.settlement.buildingLimits.barbican ?? 0,
    Math.floor(totalWallLimit / aiSpatialConfig.settlementPlan.fortification.minimumWalls),
  )
  if (!profile.allowedBuildings.includes('barbican') || lineLimit <= 0) return null
  const targets = scenario.participants
    .filter((participant) => participant.id !== analysis.ownerId)
    .flatMap((participant) => {
      const castle = castlePositionFor(scenario, participant.id)
      return castle ? [{ castle, distance: positionDistance(analysis.castle, castle) }] : []
    })
    .sort((first, second) => first.distance - second.distance
      || first.castle.row - second.castle.row || first.castle.column - second.castle.column)
  const effectiveLineLimit = Math.min(lineLimit, targets.length)
  const provisionalWallLimit = Math.max(
    aiSpatialConfig.settlementPlan.fortification.minimumWalls,
    Math.floor(totalWallLimit / Math.max(1, effectiveLineLimit)),
  )
  const provisionalTowerLimit = Math.floor(totalTowerLimit / Math.max(1, effectiveLineLimit))
  const acceptedCorridors: Array<{ corridor: CellPosition[]; provisional: NonNullable<AiSettlementPlan['fortification']>['lines'][number] }> = []
  for (const target of targets) {
    if (acceptedCorridors.length >= effectiveLineLimit) break
    const corridor = corridorToTarget(analysis, scenario, target.castle)
    if (corridor.length === 0) continue
    const provisional = fortificationLineFor(
      analysis,
      scenario,
      corridor,
      provisionalWallLimit,
      provisionalTowerLimit,
    )
    if (!provisional || acceptedCorridors.some((existing) => positionDistance(existing.provisional.gate, provisional.gate)
      < aiSpatialConfig.settlementPlan.fortification.minimumLineSpacing)) continue
    acceptedCorridors.push({ corridor, provisional })
  }
  const lines = acceptedCorridors.map(({ corridor, provisional }, index) => {
    const wallLimit = Math.floor(totalWallLimit / acceptedCorridors.length)
      + Number(index < totalWallLimit % acceptedCorridors.length)
    const towerLimit = Math.floor(totalTowerLimit / acceptedCorridors.length)
      + Number(index < totalTowerLimit % acceptedCorridors.length)
    return fortificationLineFor(analysis, scenario, corridor, wallLimit, towerLimit) ?? provisional
  })
  return lines.length > 0 ? { lines } : null
}

export function createSettlementPlan(analysis: AiWorldAnalysis, scenario: MapScenario, profile: AiProfileRules): AiSettlementPlan {
  const layout = chooseAllowed(analysis.layoutScores, profile.allowedLayouts, profile.allowedLayouts, scenario.seed + analysis.regionId.length)
  const opening = chooseAllowed(analysis.openingScores, profile.preferredOpenings, profile.preferredOpenings,
    scenario.seed + profile.id.length * aiSpatialConfig.settlementPlan.profileSeedMultiplier)
  const corridor = corridorToTarget(analysis, scenario, analysis.front)
  const fortification = fortificationPlanFor(analysis, scenario, profile)
  const corridorSet = new Set(corridor.map(positionKey))
  const fortificationSet = new Set(fortification
    ? fortification.lines.flatMap((line) => [line.gate, ...line.walls, ...line.towers]).map(positionKey)
    : [])
  const ordinary = (position: CellPosition, cell: AiCellAnalysis) => cell.passable
    && !corridorSet.has(positionKey(position)) && !fortificationSet.has(positionKey(position))
  const rearward = (position: CellPosition) => positionDistance(position, analysis.front) > positionDistance(analysis.castle, analysis.front)
  const clear = (position: CellPosition) => !scenario.cells[position.row]?.[position.column]?.vegetation
  const preferredDistance = aiSpatialConfig.preferredSiteDistance
  const housing = bestSiteNear(analysis, (position, cell) => ordinary(position, cell) && clear(position) && cell.plainOpportunity > 0 && rearward(position), preferredDistance.housing)
    ?? bestSiteNear(analysis, (position, cell) => ordinary(position, cell) && clear(position), preferredDistance.housing)
  const food = bestSiteNear(analysis, (position, cell) => ordinary(position, cell) && clear(position) && cell.plainOpportunity > 0, preferredDistance.food)
    ?? bestSiteNear(analysis, (position, cell) => ordinary(position, cell) && clear(position), preferredDistance.food)
  const forestFood = bestSiteNear(analysis, (position, cell) => ordinary(position, cell) && clear(position)
    && cell.adjacentForest >= (buildingRules.huntingLodge.minimumAdjacentForestCells ?? 0), preferredDistance.food)
  const industry = bestSiteNear(analysis, (position, cell) => ordinary(position, cell) && clear(position) && cell.hillOpportunity > 0, preferredDistance.industry)
    ?? bestSiteNear(analysis, (position, cell) => ordinary(position, cell) && clear(position), preferredDistance.industryFallback)
  const forestIndustry = bestSiteNear(analysis, (position, cell) => ordinary(position, cell) && clear(position)
    && cell.adjacentForest >= (buildingRules.lumberMill.minimumAdjacentForestCells ?? 0), preferredDistance.industryFallback)
  const military = bestSiteNear(analysis, (position, cell) => ordinary(position, cell) && clear(position) && !rearward(position), preferredDistance.military)
    ?? bestSiteNear(analysis, (position, cell) => ordinary(position, cell) && clear(position), preferredDistance.military)
  const primaryFortification = fortification?.lines[0]
  const gate = primaryFortification?.gate
  const passableCount = analysis.cells.flat().filter((cell) => cell.inRegion && cell.passable).length
  const regionScale = Math.max(aiSpatialConfig.regionScale.minimum,
    Math.min(aiSpatialConfig.regionScale.maximum, Math.sqrt(passableCount / aiSpatialConfig.regionScale.referenceCells)))
  const unique = (positions: Array<CellPosition | undefined>) => positions.filter((position): position is CellPosition => Boolean(position))
    .filter((position, index, all) => all.findIndex((candidate) => samePosition(candidate, position)) === index)
  const zoneCells = (centers: CellPosition[], requested: number, kind: AiSettlementZoneKind) => analysis.cells
    .flatMap((row, rowIndex) => row.flatMap((cell, column) => {
      const position = { column, row: rowIndex }
      if (!ordinary(position, cell) || !clear(position) || centers.length === 0) return []
      const distance = Math.min(...centers.map((center) => positionDistance(position, center)))
      const terrainPenalty = kind === 'industry'
        ? (cell.hillOpportunity > 0 || cell.adjacentForest > 0 ? 0 : aiSpatialConfig.settlementPlan.industryMissingTerrainPenalty)
        : cell.hillOpportunity > 0 ? aiSpatialConfig.settlementPlan.ordinaryHillPenalty : 0
      const chokeWeight = kind === 'defense'
        ? aiSpatialConfig.settlementPlan.defenseChokeWeight : aiSpatialConfig.settlementPlan.ordinaryChokeWeight
      return [{ position, score: distance + terrainPenalty + cell.chokeScore * chokeWeight }]
    }))
    .sort((first, second) => first.score - second.score || first.position.row - second.position.row || first.position.column - second.position.column)
    .slice(0, requested)
    .map(({ position }) => position)
  const centers = {
    housing: unique([housing]),
    food: unique([food, forestFood]),
    industry: unique([industry, forestIndustry]),
    military: unique([military]),
    defense: unique([gate, military]),
  }
  const zoneArea = Object.fromEntries((Object.keys(aiSpatialConfig.baseZoneArea) as AiSettlementZoneKind[]).map((kind) => [
    kind,
    Math.max(aiSpatialConfig.minimumZoneArea, Math.round(aiSpatialConfig.baseZoneArea[kind]
      * profile.settlement.areaScale * regionScale * aiSpatialConfig.layoutAreaScale[layout][kind])),
  ])) as Record<AiSettlementZoneKind, number>
  const cells = Object.fromEntries((Object.keys(centers) as AiSettlementZoneKind[])
    .map((kind) => [kind, zoneCells(centers[kind], zoneArea[kind], kind)])) as Record<AiSettlementZoneKind, CellPosition[]>
  const regionGrowth = regionScale >= aiSpatialConfig.regionScale.largeThreshold ? aiSpatialConfig.regionOriginGrowth.large
    : regionScale >= aiSpatialConfig.regionScale.mediumThreshold ? aiSpatialConfig.regionOriginGrowth.medium : 0
  const originLimit = (kind: AiSettlementZoneKind) => Math.max(1, Math.min(
    profile.settlement.zoneOriginTargets[kind] + regionGrowth,
    Math.floor(cells[kind].length / aiSpatialConfig.cellsPerOrigin[kind]),
  ))
  const limitsFor = (kinds: BuildingKind[]) => Object.fromEntries(kinds.flatMap((kind) => {
    const limit = profile.settlement.buildingLimits[kind]
    return limit === undefined ? [] : [[kind, limit]]
  })) as Partial<Record<BuildingKind, number>>
  const fortificationOrigins = fortification?.lines.reduce((sum, line) => (
    sum + 1 + line.walls.length + line.towers.length
  ), 0) ?? 0
  const zones: AiSettlementPlan['zones'] = {
    housing: { centers: centers.housing, cells: cells.housing, maxOrigins: originLimit('housing'), maxBuildings: limitsFor([...aiBuildingKindsByZone.housing]), overflowRadius: profile.settlement.overflowRadius.housing },
    food: { centers: centers.food, cells: cells.food, maxOrigins: originLimit('food'), maxBuildings: limitsFor([...aiBuildingKindsByZone.food]), overflowRadius: profile.settlement.overflowRadius.food },
    industry: { centers: centers.industry, cells: cells.industry, maxOrigins: originLimit('industry'), maxBuildings: limitsFor([...aiBuildingKindsByZone.industry]), overflowRadius: profile.settlement.overflowRadius.industry },
    military: { centers: centers.military, cells: cells.military, maxOrigins: originLimit('military'), maxBuildings: limitsFor([...aiBuildingKindsByZone.military]), overflowRadius: profile.settlement.overflowRadius.military },
    defense: { centers: centers.defense, cells: cells.defense, maxOrigins: Math.max(originLimit('defense'), fortificationOrigins), maxBuildings: limitsFor([...aiBuildingKindsByZone.defense]), overflowRadius: profile.settlement.overflowRadius.defense },
  }
  return {
    layout,
    opening,
    front: analysis.front,
    reservedCorridors: corridor,
    reservedSites: {
      housing,
      food,
      military,
      industry,
      gate,
      leftTower: primaryFortification?.towers[0],
      rightTower: primaryFortification?.towers[1],
    },
    fortification,
    zones,
  }
}

export function footprintOpportunityCost(analysis: AiWorldAnalysis, kind: BuildingKind, position: CellPosition) {
  const positions = buildingFootprintPositions(kind, position)
  const cells = positions.map((candidate) => analysis.cells[candidate.row]?.[candidate.column]).filter(Boolean)
  const usesHill = cells.filter((cell) => cell.hillOpportunity > 0).length
  const rule = buildingRules[kind]
  if (rule.placement === 'hill' || kind === 'tower' || kind === 'wall' || kind === 'barbican') return 0
  return usesHill * (aiSpatialConfig.hillOpportunityCost.base + analysis.hillScarcity * aiSpatialConfig.hillOpportunityCost.scarcity)
}
