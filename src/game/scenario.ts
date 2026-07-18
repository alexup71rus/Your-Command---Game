import { gameConfig } from '../config/game'
import type { GameMap } from './map'

export interface CellPosition {
  column: number
  row: number
}

export type ParticipantKind = 'human' | 'npc'

export interface MatchParticipant {
  id: string
  kind: ParticipantKind
  regionId: string
  color: string
}

export interface RegionScore {
  cells: number
  forest: number
  hills: number
  quality: number
}

export interface RegionBalance {
  qualityRatio: number
  areaRatio: number
  forestCoverageSpread: number
  hillCoverageSpread: number
  centerOffset: number
  perimeterRatio: number
  score: number
}

export type RegionResourceBalance = Omit<RegionBalance, 'centerOffset' | 'perimeterRatio'>

export interface StartRegion {
  id: string
  index: number
  color: string
  center: CellPosition
  validCastleCells: CellPosition[]
  score: RegionScore
}

export type TerritoryMap = Array<Array<string | null>>

export interface MapScenario {
  id: string
  name: string
  seed: number
  participantCount: number
  cells: GameMap
  territories: TerritoryMap
  regions: StartRegion[]
  participants: MatchParticipant[]
}

export interface MatchSetup {
  scenarioId: string
  participantCount: number
  humanRegionId: string
}

export type ScenarioResult =
  | { ok: true; scenario: MapScenario }
  | { ok: false; reason: 'not-enough-land' | 'no-castle-sites'; balance?: undefined }
  | { ok: false; reason: 'unbalanced-regions'; balance: RegionBalance }

export const REGION_COLORS = ['#d2b45f', '#6f9c83', '#a26f61', '#718cac'] as const

const keyOf = (column: number, row: number, columns: number) => row * columns + column

function isPassable(map: GameMap, column: number, row: number) {
  return map[row]?.[column]?.landform !== 'peak'
}

function largestPassableComponent(map: GameMap) {
  const rows = map.length
  const columns = map[0]?.length ?? 0
  const visited = new Uint8Array(rows * columns)
  let largest: CellPosition[] = []
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const startKey = keyOf(column, row, columns)
      if (visited[startKey] || !isPassable(map, column, row)) continue
      const component: CellPosition[] = []
      const queue: CellPosition[] = [{ column, row }]
      visited[startKey] = 1
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = queue[cursor]
        component.push(current)
        for (const [dx, dy] of directions) {
          const nextColumn = current.column + dx
          const nextRow = current.row + dy
          if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue
          const nextKey = keyOf(nextColumn, nextRow, columns)
          if (visited[nextKey] || !isPassable(map, nextColumn, nextRow)) continue
          visited[nextKey] = 1
          queue.push({ column: nextColumn, row: nextRow })
        }
      }
      if (component.length > largest.length) largest = component
    }
  }
  return largest
}

function hashCell(column: number, row: number, seed: number) {
  let value = Math.imul(column ^ seed, 374761393) + Math.imul(row, 668265263)
  value = Math.imul(value ^ (value >>> 13), 1274126177)
  return (value ^ (value >>> 16)) >>> 0
}

function cellRegionValue(map: GameMap, position: CellPosition) {
  const cell = map[position.row][position.column]
  return 1
    + (cell.vegetation ? gameConfig.match.forestRegionValue : 0)
    + (cell.landform === 'hill' ? gameConfig.match.hillRegionValue : 0)
}

function chooseCenters(map: GameMap, component: CellPosition[], count: number, seed: number, attempt: number) {
  const rows = map.length
  const columns = map[0].length
  const margin = Math.max(3, Math.floor(Math.min(rows, columns) * 0.06))
  const candidates = component.filter(({ column, row }) => (
    column >= margin && column < columns - margin && row >= margin && row < rows - margin
    && !map[row][column].vegetation
  ))
  if (candidates.length < count) return []
  const centers: CellPosition[] = []
  const radiusSteps = count === 2 ? [0.25, 0.3, 0.35] : [0.23, 0.29, 0.35]
  const radius = Math.min(rows, columns) * radiusSteps[attempt % radiusSteps.length]
  const baseRotation = (hashCell(count, seed % 997, seed) / 4294967295) * Math.PI * 2
  const rotation = baseRotation + attempt * Math.PI * (3 - Math.sqrt(5))
  for (let index = 0; index < count; index += 1) {
    const angleJitter = (hashCell(index, attempt + 101, seed) / 4294967295 - 0.5) * (Math.PI * 2 / count) * 0.24
    const radiusJitter = (hashCell(attempt + 211, index, seed) / 4294967295 - 0.5) * Math.min(rows, columns) * 0.07
    const angle = rotation + index / count * Math.PI * 2 + angleJitter
    const target = {
      column: (columns - 1) / 2 + Math.cos(angle) * (radius + radiusJitter),
      row: (rows - 1) / 2 + Math.sin(angle) * (radius + radiusJitter),
    }
    const available = candidates.filter((candidate) => !centers.some((center) => center.column === candidate.column && center.row === candidate.row))
    const center = available.reduce((best, cell) => {
      const distance = (cell.column - target.column) ** 2 + (cell.row - target.row) ** 2
      const bestDistance = (best.column - target.column) ** 2 + (best.row - target.row) ** 2
      if (distance !== bestDistance) return distance < bestDistance ? cell : best
      return hashCell(cell.column, cell.row, seed) > hashCell(best.column, best.row, seed) ? cell : best
    })
    centers.push(center)
  }
  return centers
}

function regionScoresForTerritories(map: GameMap, territories: TerritoryMap, count: number) {
  const scores = Array.from({ length: count }, (): RegionScore => ({ cells: 0, forest: 0, hills: 0, quality: 0 }))
  for (let row = 0; row < territories.length; row += 1) {
    for (let column = 0; column < territories[row].length; column += 1) {
      const regionId = territories[row][column]
      if (!regionId) continue
      const index = Number(regionId.slice('region-'.length))
      const score = scores[index]
      if (!score) continue
      score.cells += 1
      if (map[row][column].vegetation) score.forest += 1
      if (map[row][column].landform === 'hill') score.hills += 1
    }
  }
  scores.forEach((score) => {
    score.quality = score.cells
      + score.forest * gameConfig.match.forestRegionValue
      + score.hills * gameConfig.match.hillRegionValue
  })
  return scores
}

export function evaluateRegionResourceBalance(scores: RegionScore[]): RegionResourceBalance {
  const nonEmpty = scores.filter((score) => score.cells > 0)
  if (nonEmpty.length !== scores.length || nonEmpty.length === 0) {
    return { qualityRatio: Number.POSITIVE_INFINITY, areaRatio: Number.POSITIVE_INFINITY, forestCoverageSpread: 1, hillCoverageSpread: 1, score: Number.POSITIVE_INFINITY }
  }
  const ratio = (values: number[]) => Math.max(...values) / Math.max(0.0001, Math.min(...values))
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values)
  const qualityRatio = ratio(nonEmpty.map((region) => region.quality))
  const areaRatio = ratio(nonEmpty.map((region) => region.cells))
  const forestCoverageSpread = spread(nonEmpty.map((region) => region.forest / region.cells))
  const hillCoverageSpread = spread(nonEmpty.map((region) => region.hills / region.cells))
  const normalizedPenalties = [
    qualityRatio / gameConfig.match.maxRegionQualityRatio,
    areaRatio / gameConfig.match.maxRegionAreaRatio,
    forestCoverageSpread / gameConfig.match.maxForestCoverageSpread,
    hillCoverageSpread / gameConfig.match.maxHillCoverageSpread,
  ]
  return {
    qualityRatio,
    areaRatio,
    forestCoverageSpread,
    hillCoverageSpread,
    score: Math.max(...normalizedPenalties) * 10 + normalizedPenalties.reduce((sum, penalty) => sum + penalty, 0),
  }
}

function addTerritoryShape(balance: RegionResourceBalance, territories: TerritoryMap, centers: CellPosition[]): RegionBalance {
  const stats = centers.map(() => ({ cells: 0, columnSum: 0, rowSum: 0, perimeter: 0 }))
  for (let row = 0; row < territories.length; row += 1) {
    for (let column = 0; column < territories[row].length; column += 1) {
      const regionId = territories[row][column]
      if (!regionId) continue
      const index = Number(regionId.slice('region-'.length))
      const stat = stats[index]
      stat.cells += 1
      stat.columnSum += column
      stat.rowSum += row
      if (territories[row - 1]?.[column] !== regionId) stat.perimeter += 1
      if (territories[row + 1]?.[column] !== regionId) stat.perimeter += 1
      if (territories[row]?.[column - 1] !== regionId) stat.perimeter += 1
      if (territories[row]?.[column + 1] !== regionId) stat.perimeter += 1
    }
  }
  const centerOffset = Math.max(...stats.map((stat, index) => {
    if (!stat.cells) return Number.POSITIVE_INFINITY
    const centroidColumn = stat.columnSum / stat.cells
    const centroidRow = stat.rowSum / stat.cells
    return Math.hypot(centroidColumn - centers[index].column, centroidRow - centers[index].row) / Math.sqrt(stat.cells)
  }))
  const perimeterRatio = Math.max(...stats.map((stat) => stat.perimeter / Math.sqrt(Math.max(1, stat.cells))))
  const shapePenalties = [
    centerOffset / gameConfig.match.maxRegionCenterOffset,
    perimeterRatio / gameConfig.match.maxRegionPerimeterRatio,
  ]
  return {
    ...balance,
    centerOffset,
    perimeterRatio,
    score: balance.score + Math.max(...shapePenalties) * 10 + shapePenalties.reduce((sum, penalty) => sum + penalty, 0),
  }
}

export function isRegionBalanceAcceptable(balance: RegionBalance) {
  return balance.qualityRatio <= gameConfig.match.maxRegionQualityRatio
    && balance.areaRatio <= gameConfig.match.maxRegionAreaRatio
    && balance.forestCoverageSpread <= gameConfig.match.maxForestCoverageSpread
    && balance.hillCoverageSpread <= gameConfig.match.maxHillCoverageSpread
    && balance.centerOffset <= gameConfig.match.maxRegionCenterOffset
    && balance.perimeterRatio <= gameConfig.match.maxRegionPerimeterRatio
}

function assignTerritories(map: GameMap, component: CellPosition[], centers: CellPosition[]) {
  const rows = map.length
  const columns = map[0].length
  const territories: TerritoryMap = Array.from({ length: rows }, () => Array.from({ length: columns }, () => null))
  const componentSet = new Uint8Array(rows * columns)
  component.forEach(({ column, row }) => { componentSet[keyOf(column, row, columns)] = 1 })
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
  const frontiers: CellPosition[][] = centers.map(() => [])
  const cursors = centers.map(() => 0)
  const sizes = centers.map(() => 1)
  const values = centers.map((center) => cellRegionValue(map, center))
  const targetCells = component.length / centers.length
  const targetValue = component.reduce((sum, position) => sum + cellRegionValue(map, position), 0) / centers.length
  let assigned = centers.length

  const enqueueNeighbours = (regionIndex: number, position: CellPosition) => {
    for (const [dx, dy] of directions) {
      const column = position.column + dx
      const row = position.row + dy
      if (column < 0 || column >= columns || row < 0 || row >= rows) continue
      if (!componentSet[keyOf(column, row, columns)] || territories[row][column] !== null) continue
      frontiers[regionIndex].push({ column, row })
    }
  }
  centers.forEach((center, index) => { territories[center.row][center.column] = `region-${index}` })
  centers.forEach((center, index) => enqueueNeighbours(index, center))

  while (assigned < component.length) {
    let selectedRegion = -1
    let smallestLoad = Number.POSITIVE_INFINITY
    for (let index = 0; index < centers.length; index += 1) {
      while (cursors[index] < frontiers[index].length) {
        const candidate = frontiers[index][cursors[index]]
        if (territories[candidate.row][candidate.column] === null) break
        cursors[index] += 1
      }
      if (cursors[index] >= frontiers[index].length) continue
      const load = sizes[index] / targetCells * 0.4 + values[index] / targetValue * 0.6
      if (load < smallestLoad) {
        selectedRegion = index
        smallestLoad = load
      }
    }
    if (selectedRegion < 0) break
    const position = frontiers[selectedRegion][cursors[selectedRegion]]
    cursors[selectedRegion] += 1
    if (territories[position.row][position.column] !== null) continue
    territories[position.row][position.column] = `region-${selectedRegion}`
    sizes[selectedRegion] += 1
    values[selectedRegion] += cellRegionValue(map, position)
    assigned += 1
    enqueueNeighbours(selectedRegion, position)
  }
  return territories
}

export function isCastleSiteValid(scenario: Pick<MapScenario, 'cells' | 'territories'>, regionId: string, position: CellPosition) {
  const { column, row } = position
  const cell = scenario.cells[row]?.[column]
  if (!cell || scenario.territories[row]?.[column] !== regionId) return false
  if (cell.landform === 'peak' || cell.vegetation || cell.object) return false
  const buffer = gameConfig.match.castleBoundaryBuffer
  for (let dy = -buffer; dy <= buffer; dy += 1) {
    for (let dx = -buffer; dx <= buffer; dx += 1) {
      if (scenario.territories[row + dy]?.[column + dx] !== regionId) return false
    }
  }
  return true
}

function buildRegions(map: GameMap, territories: TerritoryMap, centers: CellPosition[], count: number) {
  const regions: StartRegion[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `region-${index}`
    const cells: CellPosition[] = []
    let forest = 0
    let hills = 0
    for (let row = 0; row < territories.length; row += 1) {
      for (let column = 0; column < territories[row].length; column += 1) {
        if (territories[row][column] !== id) continue
        cells.push({ column, row })
        if (map[row][column].vegetation) forest += 1
        if (map[row][column].landform === 'hill') hills += 1
      }
    }
    const partialScenario = { cells: map, territories }
    const validCastleCells = cells
      .filter((position) => isCastleSiteValid(partialScenario, id, position))
      .sort((a, b) => {
        const score = (position: CellPosition) => {
          const distance = Math.hypot(position.column - centers[index].column, position.row - centers[index].row)
          const hillBonus = map[position.row][position.column].landform === 'hill' ? 4 : 0
          return hillBonus - distance * 0.1
        }
        return score(b) - score(a)
      })
    const quality = cells.length
      + forest * gameConfig.match.forestRegionValue
      + hills * gameConfig.match.hillRegionValue
    regions.push({
      id,
      index,
      color: REGION_COLORS[index],
      center: validCastleCells[0] ?? centers[index],
      validCastleCells,
      score: { cells: cells.length, forest, hills, quality },
    })
  }
  return regions
}

export function createMapScenario(
  map: GameMap,
  participantCount: number,
  seed: number,
  metadata: { id?: string; name?: string } = {},
): ScenarioResult {
  const count = Math.max(gameConfig.match.minParticipants, Math.min(gameConfig.match.maxParticipants, participantCount))
  const component = largestPassableComponent(map)
  if (component.length < count * 64) return { ok: false, reason: 'not-enough-land' }
  const candidates = Array.from({ length: gameConfig.match.regionSearchAttempts }, (_, attempt) => {
    const centers = chooseCenters(map, component, count, seed, attempt)
    if (centers.length !== count) return null
    const territories = assignTerritories(map, component, centers)
    const balance = addTerritoryShape(evaluateRegionResourceBalance(regionScoresForTerritories(map, territories, count)), territories, centers)
    return { attempt, centers, territories, balance }
  }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => a.balance.score - b.balance.score || a.attempt - b.attempt)
  if (candidates.length === 0) return { ok: false, reason: 'not-enough-land' }

  const candidatesWithSites = candidates.map((candidate) => ({
    ...candidate,
    regions: buildRegions(map, candidate.territories, candidate.centers, count),
  })).filter((candidate) => candidate.regions.every((region) => region.validCastleCells.length > 0))
  if (candidatesWithSites.length === 0) return { ok: false, reason: 'no-castle-sites' }
  const selected = candidatesWithSites.find((candidate) => isRegionBalanceAcceptable(candidate.balance))
  if (!selected) return { ok: false, reason: 'unbalanced-regions', balance: candidatesWithSites[0].balance }
  return {
    ok: true,
    scenario: {
      id: metadata.id ?? `custom-${seed}`,
      name: metadata.name ?? 'Custom world',
      seed,
      participantCount: count,
      cells: map,
      territories: selected.territories,
      regions: selected.regions,
      participants: [],
    },
  }
}

export function foundMatch(scenario: MapScenario, humanRegionId: string, humanCastle: CellPosition): MapScenario {
  if (!isCastleSiteValid(scenario, humanRegionId, humanCastle)) return scenario
  const participants: MatchParticipant[] = scenario.regions.map((region) => ({
    id: region.id === humanRegionId ? 'player' : `npc-${region.index + 1}`,
    kind: region.id === humanRegionId ? 'human' : 'npc',
    regionId: region.id,
    color: region.color,
  }))
  const placements = scenario.regions.map((region) => ({
    region,
    position: region.id === humanRegionId ? humanCastle : region.validCastleCells[0],
    participant: participants.find((participant) => participant.regionId === region.id)!,
  }))
  const changedRows = new Map<number, GameMap[number]>()
  const cells = [...scenario.cells]
  placements.forEach(({ position, participant }) => {
    const row = changedRows.get(position.row) ?? [...cells[position.row]]
    changedRows.set(position.row, row)
    cells[position.row] = row
    row[position.column] = {
      ...row[position.column],
      object: {
        type: 'castle',
        ownerId: participant.id,
        hitPoints: gameConfig.turn.castleHitPoints,
        maxHitPoints: gameConfig.turn.castleHitPoints,
      },
    }
  })
  return { ...scenario, cells, participants }
}
