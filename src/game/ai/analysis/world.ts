import { aiSpatialConfig } from '../../../config/ai'
import type { MapObject } from '../../map'
import { clockwiseCardinalDirections } from '../../geometry'
import { areOwnersHostile, type CellPosition, type MapScenario } from '../../scenario'
import {
  distanceAt,
  typescriptDistanceFieldKernel,
  type DistanceFieldKernel,
} from '../../grid/distanceField'
import type { AiLayoutKind, AiOpeningKind } from '../model'

export interface AiObjectEntry {
  object: MapObject
  position: CellPosition
}

interface AiObjectIndex {
  all: AiObjectEntry[]
  byOwner: Map<string, AiObjectEntry[]>
}

let activeObjectIndexes: WeakMap<MapScenario['cells'], AiObjectIndex> | null = null

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

function createObjectIndex(scenario: Pick<MapScenario, 'cells'>): AiObjectIndex {
  const all: AiObjectEntry[] = []
  const byOwner = new Map<string, AiObjectEntry[]>()
  scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const object = cell.object
    const position = { column, row: rowIndex }
    if (!object || !isPrimaryObject(object, position)) return
    const entry = { object, position }
    all.push(entry)
    const owned = byOwner.get(object.ownerId) ?? []
    owned.push(entry)
    byOwner.set(object.ownerId, owned)
  }))
  return { all, byOwner }
}

/** Shares immutable object scans only within one synchronous planning request. */
export function withAiObjectIndexCache<T>(run: () => T): T {
  const previous = activeObjectIndexes
  activeObjectIndexes = new WeakMap()
  try {
    return run()
  } finally {
    activeObjectIndexes = previous
  }
}

export function aiObjectEntries(scenario: Pick<MapScenario, 'cells'>, ownerId?: string): AiObjectEntry[] {
  let index = activeObjectIndexes?.get(scenario.cells)
  if (!index) {
    index = createObjectIndex(scenario)
    activeObjectIndexes?.set(scenario.cells, index)
  }
  return [...(ownerId ? index.byOwner.get(ownerId) ?? [] : index.all)]
}

export function castlePositionFor(scenario: Pick<MapScenario, 'cells'>, ownerId: string) {
  return aiObjectEntries(scenario, ownerId).find((entry) => entry.object.type === 'castle')?.position ?? null
}

export function borderCells(scenario: Pick<MapScenario, 'cells' | 'territories'>, regionId: string) {
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
    .filter((participant) => areOwnersHostile(scenario.participants, ownerId, participant.id))
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

export function analyzeAiWorld(
  scenario: MapScenario,
  ownerId: string,
  distanceFieldKernel: DistanceFieldKernel = typescriptDistanceFieldKernel,
): AiWorldAnalysis | null {
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
  const rows = scenario.cells.length
  const columns = scenario.cells[0]?.length ?? 0
  const regionPassability = new Uint32Array(rows * columns)
  const worldPassability = new Uint32Array(rows * columns)
  scenario.cells.forEach((row, rowIndex) => row.forEach((cell, column) => {
    const index = rowIndex * columns + column
    const passableCell = cell.landform !== 'peak'
    worldPassability[index] = Number(passableCell)
    regionPassability[index] = Number(passableCell
      && scenario.territories[rowIndex]?.[column] === regionId)
  }))
  const sourceIndices = (positions: readonly CellPosition[]) => Uint32Array.from(
    positions.filter((position) => scenario.cells[position.row]?.[position.column]),
    (position) => position.row * columns + position.column,
  )
  const distancesFrom = (positions: readonly CellPosition[], restrictToRegion = true) => distanceFieldKernel({
    rows,
    columns,
    passability: restrictToRegion ? regionPassability : worldPassability,
    sources: sourceIndices(positions),
  })
  const castleDistances = distancesFrom([castle])
  const forestDistances = distancesFrom(forests.length ? forests : borders)
  const hillDistances = distancesFrom(hills.length ? hills : borders)
  const peakDistances = distancesFrom(peaks.length ? peaks : borders, false)
  const borderDistances = distancesFrom(borders)
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
      distanceToCastle: distanceAt(castleDistances, columns, rowIndex, column),
      distanceToBorder: distanceAt(borderDistances, columns, rowIndex, column),
      distanceToForest: distanceAt(forestDistances, columns, rowIndex, column),
      distanceToHill: distanceAt(hillDistances, columns, rowIndex, column),
      distanceToPeak: distanceAt(peakDistances, columns, rowIndex, column),
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
      + Math.max(0, openingScore.forest.nearbyDistance
        - distanceAt(forestDistances, columns, castle.row, castle.column)) * openingScore.forest.proximity,
    plains: plainCoverage * openingScore.plains.coverage,
    highland: hillCoverage * openingScore.highland.coverage
      + Math.max(0, openingScore.highland.nearbyDistance
        - distanceAt(hillDistances, columns, castle.row, castle.column)) * openingScore.highland.proximity,
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
