import { gameConfig, maximumParticipantsForMapSize } from '../config/game'
import { cardinalDirections, clockwiseCardinalDirections } from './geometry'
import type { GameMap } from './map'

export interface CellPosition {
  column: number
  row: number
}

export type ParticipantKind = 'human' | 'ai'
export type AiProfileId = 'radomir' | 'velislava' | 'svyatobor'

export interface MatchParticipant {
  id: string
  kind: ParticipantKind
  regionId: string
  color: string
  profileId?: AiProfileId
  teamId?: number
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
  reservedBuildSites: {
    plain: CellPosition
    hill: CellPosition
    extra: CellPosition
    house: CellPosition
  }
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
  opponentProfileIds: AiProfileId[]
}

export interface OpponentRegionAssignment {
  profileId: AiProfileId
  region: StartRegion
}

export type ScenarioResult =
  | { ok: true; scenario: MapScenario }
  | { ok: false; reason: 'not-enough-land' | 'no-castle-sites' | 'unviable-starts'; balance?: undefined }
  | { ok: false; reason: 'unbalanced-regions'; balance: RegionBalance }

export const REGION_COLORS = ['#d2b45f', '#6f9c83', '#a26f61', '#718cac'] as const

export function participantTeamId(participant: MatchParticipant) {
  return participant.teamId ?? participant.id
}

export function areOwnersAllied(participants: readonly MatchParticipant[], firstOwnerId: string, secondOwnerId: string) {
  const first = participants.find((participant) => participant.id === firstOwnerId)
  const second = participants.find((participant) => participant.id === secondOwnerId)
  return Boolean(first && second && participantTeamId(first) === participantTeamId(second))
}

export function areOwnersHostile(participants: readonly MatchParticipant[], firstOwnerId: string, secondOwnerId: string) {
  return firstOwnerId !== secondOwnerId && !areOwnersAllied(participants, firstOwnerId, secondOwnerId)
}

const keyOf = (column: number, row: number, columns: number) => row * columns + column

function isPassable(map: GameMap, column: number, row: number) {
  return map[row]?.[column]?.landform !== 'peak'
}

function largestPassableComponent(map: GameMap) {
  const rows = map.length
  const columns = map[0]?.length ?? 0
  const visited = new Uint8Array(rows * columns)
  let largest: CellPosition[] = []
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
        for (const direction of cardinalDirections) {
          const nextColumn = current.column + direction.column
          const nextRow = current.row + direction.row
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
  const generation = gameConfig.match.regionGeneration
  const margin = Math.max(generation.centerMarginMinimum, Math.floor(Math.min(rows, columns) * generation.centerMarginShare))
  const candidates = component.filter(({ column, row }) => (
    column >= margin && column < columns - margin && row >= margin && row < rows - margin
    && !map[row][column].vegetation
  ))
  if (candidates.length < count) return []
  const centers: CellPosition[] = []
  const radiusSteps = count === 2 ? generation.twoParticipantRadiusSteps : generation.multiParticipantRadiusSteps
  const radius = Math.min(rows, columns) * radiusSteps[attempt % radiusSteps.length]
  const baseRotation = (hashCell(count, seed % 997, seed) / 4294967295) * Math.PI * 2
  const rotation = baseRotation + attempt * Math.PI * (3 - Math.sqrt(5))
  for (let index = 0; index < count; index += 1) {
    const angleJitter = (hashCell(index, attempt + 101, seed) / 4294967295 - 0.5)
      * (Math.PI * 2 / count) * generation.centerAngleJitterShare
    const radiusJitter = (hashCell(attempt + 211, index, seed) / 4294967295 - 0.5)
      * Math.min(rows, columns) * generation.centerRadiusJitterShare
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
    score: Math.max(...normalizedPenalties) * gameConfig.match.regionGeneration.maximumPenaltyWeight
      + normalizedPenalties.reduce((sum, penalty) => sum + penalty, 0),
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
    score: balance.score + Math.max(...shapePenalties) * gameConfig.match.regionGeneration.maximumPenaltyWeight
      + shapePenalties.reduce((sum, penalty) => sum + penalty, 0),
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
  const frontiers: CellPosition[][] = centers.map(() => [])
  const cursors = centers.map(() => 0)
  const sizes = centers.map(() => 1)
  const values = centers.map((center) => cellRegionValue(map, center))
  const targetCells = component.length / centers.length
  const targetValue = component.reduce((sum, position) => sum + cellRegionValue(map, position), 0) / centers.length
  let assigned = centers.length

  const enqueueNeighbours = (regionIndex: number, position: CellPosition) => {
    for (const direction of cardinalDirections) {
      const column = position.column + direction.column
      const row = position.row + direction.row
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
      const load = sizes[index] / targetCells * gameConfig.match.regionGeneration.territoryAreaWeight
        + values[index] / targetValue * gameConfig.match.regionGeneration.territoryQualityWeight
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

function footprintCells(origin: CellPosition) {
  return [
    origin,
    { column: origin.column + 1, row: origin.row },
    { column: origin.column, row: origin.row + 1 },
    { column: origin.column + 1, row: origin.row + 1 },
  ]
}

function reservedSiteCells(sites: StartRegion['reservedBuildSites']) {
  return [
    ...footprintCells(sites.plain),
    ...footprintCells(sites.hill),
    ...footprintCells(sites.extra),
    sites.house,
  ]
}

function isBaseCastleSiteValid(scenario: Pick<MapScenario, 'cells' | 'territories'>, regionId: string, position: CellPosition) {
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

export function isCastleSiteValid(
  scenario: Pick<MapScenario, 'cells' | 'territories'> & Partial<Pick<MapScenario, 'regions'>>,
  regionId: string,
  position: CellPosition,
) {
  if (!isBaseCastleSiteValid(scenario, regionId, position)) return false
  const region = scenario.regions?.find((candidate) => candidate.id === regionId)
  if (!region) return true
  return !reservedSiteCells(region.reservedBuildSites)
    .some((reserved) => reserved.column === position.column && reserved.row === position.row)
}

function reservedBuildSitesFor(
  map: GameMap,
  territories: TerritoryMap,
  regionId: string,
  castleCells: CellPosition[],
) {
  const clearCell = ({ column, row }: CellPosition) => {
    const cell = map[row]?.[column]
    return territories[row]?.[column] === regionId
      && Boolean(cell)
      && (cell.landform === 'plain' || cell.landform === 'hill')
      && !cell.vegetation
      && !cell.object
  }
  const clearCells = (origin: CellPosition) => footprintCells(origin).every(({ column, row }) => {
    return clearCell({ column, row })
  })
  const clearCellCount = territories.reduce((total, row, rowIndex) => total + row.reduce((rowTotal, id, column) => {
    const cell = map[rowIndex]?.[column]
    return rowTotal + Number(id === regionId && (cell?.landform === 'plain' || cell?.landform === 'hill') && !cell.vegetation && !cell.object)
  }, 0), 0)
  // Founding consumes one otherwise clear cell. Preserve the configured
  // development space after the castle has been placed.
  if (clearCellCount <= gameConfig.match.minimumClearStartCells) return null

  const origins = territories.flatMap((row, rowIndex) => row.flatMap((id, column) => (
    id === regionId && clearCells({ column, row: rowIndex }) ? [{ column, row: rowIndex }] : []
  )))
  const plains = origins.filter((origin) => footprintCells(origin).every(({ column, row }) => map[row][column].landform === 'plain'))
  const hills = origins.filter((origin) => footprintCells(origin).every(({ column, row }) => map[row][column].landform === 'hill'))
  const overlaps = (first: CellPosition, second: CellPosition) => {
    const secondKeys = new Set(footprintCells(second).map(({ column, row }) => `${column}:${row}`))
    return footprintCells(first).some(({ column, row }) => secondKeys.has(`${column}:${row}`))
  }

  for (const plain of plains) {
    for (const hill of hills) {
      for (const extra of origins) {
        if (overlaps(plain, extra) || overlaps(hill, extra)) continue
        const developmentCells = new Set([plain, hill, extra].flatMap(footprintCells).map(({ column, row }) => `${column}:${row}`))
        for (const castle of castleCells) {
          if (developmentCells.has(`${castle.column}:${castle.row}`)) continue
          for (let distance = 1; distance <= gameConfig.economy.foodServiceRadius; distance += 1) {
            for (let rowOffset = -distance; rowOffset <= distance; rowOffset += 1) {
              const columnOffset = distance - Math.abs(rowOffset)
              const candidates = columnOffset === 0
                ? [{ column: castle.column, row: castle.row + rowOffset }]
                : [
                    { column: castle.column - columnOffset, row: castle.row + rowOffset },
                    { column: castle.column + columnOffset, row: castle.row + rowOffset },
                  ]
              const house = candidates.find((candidate) => clearCell(candidate) && !developmentCells.has(`${candidate.column}:${candidate.row}`))
              if (!house) continue
              const reserved = { plain, hill, extra, house }
              const reservedCells = new Set(reservedSiteCells(reserved).map(({ column, row }) => `${column}:${row}`))
              const validCastleCells = castleCells.filter(({ column, row }) => (
                !reservedCells.has(`${column}:${row}`)
                && Math.abs(column - house.column) + Math.abs(row - house.row) <= gameConfig.economy.foodServiceRadius
              ))
              if (validCastleCells.length > 0) return { sites: reserved, validCastleCells }
            }
          }
        }
      }
    }
  }
  return null
}

type RegionBuildResult =
  | { ok: true; regions: StartRegion[] }
  | { ok: false; reason: 'no-castle-sites' | 'unviable-starts' }

function buildRegions(map: GameMap, territories: TerritoryMap, centers: CellPosition[], count: number): RegionBuildResult {
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
    const baseCastleCells = cells
      .filter((position) => isBaseCastleSiteValid(partialScenario, id, position))
      .sort((a, b) => {
        const score = (position: CellPosition) => {
          const distance = Math.hypot(position.column - centers[index].column, position.row - centers[index].row)
          const hillBonus = map[position.row][position.column].landform === 'hill'
            ? gameConfig.match.regionGeneration.castleCandidateHillBonus
            : 0
          return hillBonus - distance * gameConfig.match.regionGeneration.castleCandidateDistancePenalty
        }
        return score(b) - score(a)
      })
    if (baseCastleCells.length === 0) return { ok: false, reason: 'no-castle-sites' }
    const startDevelopment = reservedBuildSitesFor(map, territories, id, baseCastleCells)
    if (!startDevelopment) return { ok: false, reason: 'unviable-starts' }
    const { sites: reservedBuildSites, validCastleCells } = startDevelopment
    if (validCastleCells.length === 0) return { ok: false, reason: 'no-castle-sites' }
    const quality = cells.length
      + forest * gameConfig.match.forestRegionValue
      + hills * gameConfig.match.hillRegionValue
    regions.push({
      id,
      index,
      color: REGION_COLORS[index],
      center: validCastleCells[0] ?? centers[index],
      validCastleCells,
      reservedBuildSites,
      score: { cells: cells.length, forest, hills, quality },
    })
  }
  return { ok: true, regions }
}

export function createMapScenario(
  map: GameMap,
  participantCount: number,
  seed: number,
  metadata: { id?: string; name?: string } = {},
): ScenarioResult {
  const requestedCount = Number.isFinite(participantCount) ? Math.round(participantCount) : gameConfig.match.defaultParticipants
  const count = Math.max(gameConfig.match.minParticipants, Math.min(gameConfig.match.maxParticipants, requestedCount))
  if (count > maximumParticipantsForMapSize(map.length)) return { ok: false, reason: 'not-enough-land' }
  const component = largestPassableComponent(map)
  if (component.length < count * gameConfig.match.regionGeneration.minimumPassableCellsPerParticipant) {
    return { ok: false, reason: 'not-enough-land' }
  }
  let sawCandidate = false
  let sawCastleSites = false
  let firstViableBalance: RegionBalance | null = null
  for (let attempt = 0; attempt < gameConfig.match.regionSearchAttempts; attempt += 1) {
    const centers = chooseCenters(map, component, count, seed, attempt)
    if (centers.length !== count) continue
    sawCandidate = true
    const territories = assignTerritories(map, component, centers)
    const balance = addTerritoryShape(evaluateRegionResourceBalance(regionScoresForTerritories(map, territories, count)), territories, centers)
    const built = buildRegions(map, territories, centers, count)
    if (!built.ok) {
      if (built.reason === 'unviable-starts') sawCastleSites = true
      continue
    }
    sawCastleSites = true
    firstViableBalance ??= balance
    if (!isRegionBalanceAcceptable(balance)) continue
    return {
      ok: true,
      scenario: {
        id: metadata.id ?? `custom-${seed}`,
        name: metadata.name ?? 'Custom world',
        seed,
        participantCount: count,
        cells: map,
        territories,
        regions: built.regions,
        participants: [],
      },
    }
  }
  if (!sawCandidate) return { ok: false, reason: 'not-enough-land' }
  if (!sawCastleSites) return { ok: false, reason: 'no-castle-sites' }
  if (!firstViableBalance) return { ok: false, reason: 'unviable-starts' }
  return { ok: false, reason: 'unbalanced-regions', balance: firstViableBalance }
}

export function assignOpponentRegions(
  scenario: MapScenario,
  humanRegionId: string,
  opponentProfileIds: AiProfileId[],
): OpponentRegionAssignment[] {
  const humanRegionIndex = scenario.regions.findIndex((region) => region.id === humanRegionId)
  if (humanRegionIndex < 0) return []
  return scenario.regions
    .filter((region) => region.id !== humanRegionId)
    .sort((first, second) => {
      const firstOffset = (first.index - humanRegionIndex + scenario.regions.length) % scenario.regions.length
      const secondOffset = (second.index - humanRegionIndex + scenario.regions.length) % scenario.regions.length
      return firstOffset - secondOffset
    })
    .flatMap((region, index) => opponentProfileIds[index] ? [{ region, profileId: opponentProfileIds[index] }] : [])
}

function castleSiteScore(scenario: MapScenario, region: StartRegion, position: CellPosition) {
  const within = (radius: number) => {
    let passable = 0
    let plain = 0
    let hill = 0
    let forestEdge = 0
    let squares = 0
    for (let row = Math.max(0, position.row - radius); row <= Math.min(scenario.cells.length - 1, position.row + radius); row += 1) {
      for (let column = Math.max(0, position.column - radius); column <= Math.min((scenario.cells[row]?.length ?? 1) - 1, position.column + radius); column += 1) {
        if (Math.abs(column - position.column) + Math.abs(row - position.row) > radius || scenario.territories[row]?.[column] !== region.id) continue
        const cell = scenario.cells[row][column]
        if (cell.landform === 'peak') continue
        passable += 1
        if (!cell.vegetation && cell.landform === 'plain') plain += 1
        if (!cell.vegetation && cell.landform === 'hill') hill += 1
        if (!cell.vegetation && clockwiseCardinalDirections.some((direction) => scenario.cells[row + direction.row]?.[column + direction.column]?.vegetation)) forestEdge += 1
        const square = [
          scenario.cells[row]?.[column], scenario.cells[row]?.[column + 1],
          scenario.cells[row + 1]?.[column], scenario.cells[row + 1]?.[column + 1],
        ]
        if (square.every((candidate) => candidate && candidate.landform !== 'peak' && !candidate.vegetation)
          && [
            scenario.territories[row]?.[column], scenario.territories[row]?.[column + 1],
            scenario.territories[row + 1]?.[column], scenario.territories[row + 1]?.[column + 1],
          ].every((candidate) => candidate === region.id)) squares += 1
      }
    }
    return { passable, plain, hill, forestEdge, squares }
  }
  const generation = gameConfig.match.regionGeneration
  const near = within(generation.castleSiteRadii.near)
  const medium = within(generation.castleSiteRadii.medium)
  const far = within(generation.castleSiteRadii.far)
  const exits = clockwiseCardinalDirections.filter((direction) => {
    const cell = scenario.cells[position.row + direction.row]?.[position.column + direction.column]
    return cell && cell.landform !== 'peak' && scenario.territories[position.row + direction.row]?.[position.column + direction.column] === region.id
  }).length
  const boundaryDistance = Math.min(position.column, position.row, scenario.cells.length - 1 - position.row, (scenario.cells[0]?.length ?? 1) - 1 - position.column)
  const weights = generation.castleSiteWeights
  return near.passable * weights.nearPassable
    + medium.passable * weights.mediumPassable
    + far.passable * weights.farPassable
    + near.plain * weights.nearPlain
    + medium.hill * weights.mediumHill
    + medium.forestEdge * weights.mediumForestEdge
    + medium.squares * weights.mediumSquares
    + exits * weights.exit
    + Math.min(generation.maximumBoundaryDistanceBonus, boundaryDistance) * weights.boundary
    - (exits < generation.minimumCastleExits ? generation.invalidCastleExitPenalty : 0)
}

export function chooseCastleSiteForRegion(scenario: MapScenario, region: StartRegion) {
  return [...region.validCastleCells]
    .map((position) => ({ position, score: castleSiteScore(scenario, region, position) }))
    .sort((first, second) => second.score - first.score
      || hashCell(first.position.column, first.position.row, scenario.seed) - hashCell(second.position.column, second.position.row, scenario.seed)
      || first.position.row - second.position.row || first.position.column - second.position.column)[0]?.position
    ?? region.validCastleCells[0]
}

function placeFoundingCastles(
  scenario: MapScenario,
  participants: MatchParticipant[],
  castleForRegion: (region: StartRegion) => CellPosition,
) {
  const changedRows = new Map<number, GameMap[number]>()
  const cells = [...scenario.cells]
  scenario.regions.forEach((region) => {
    const participant = participants.find((candidate) => candidate.regionId === region.id)
    if (!participant) return
    const position = castleForRegion(region)
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

function aiParticipantIds(profileIds: AiProfileId[]) {
  const totals = new Map<AiProfileId, number>()
  profileIds.forEach((profileId) => totals.set(profileId, (totals.get(profileId) ?? 0) + 1))
  const occurrences = new Map<AiProfileId, number>()
  return profileIds.map((profileId) => {
    const occurrence = (occurrences.get(profileId) ?? 0) + 1
    occurrences.set(profileId, occurrence)
    return totals.get(profileId) === 1 ? `ai-${profileId}` : `ai-${profileId}-${occurrence}`
  })
}

export function foundMatch(
  scenario: MapScenario,
  humanRegionId: string,
  humanCastle: CellPosition,
  opponentProfileIds: AiProfileId[] = ['radomir', 'velislava', 'svyatobor'],
  participantTeamIds: number[] = [],
): MapScenario {
  if (!isCastleSiteValid(scenario, humanRegionId, humanCastle)) return scenario
  const humanRegionIndex = scenario.regions.findIndex((region) => region.id === humanRegionId)
  const opponentAssignments = assignOpponentRegions(scenario, humanRegionId, opponentProfileIds)
  if (opponentAssignments.length !== scenario.regions.length - 1) return scenario
  const participantIds = aiParticipantIds(opponentAssignments.map(({ profileId }) => profileId))
  const participants: MatchParticipant[] = [
    {
      id: 'player',
      kind: 'human',
      regionId: humanRegionId,
      color: scenario.regions[humanRegionIndex].color,
      ...(participantTeamIds[0] ? { teamId: participantTeamIds[0] } : {}),
    },
    ...opponentAssignments.map(({ region, profileId }, index) => {
      const teamId = participantTeamIds[index + 1]
      return { id: participantIds[index], kind: 'ai' as const, regionId: region.id, color: region.color, profileId, ...(teamId ? { teamId } : {}) }
    }),
  ]
  return placeFoundingCastles(
    scenario,
    participants,
    (region) => region.id === humanRegionId ? humanCastle : chooseCastleSiteForRegion(scenario, region),
  )
}

export function foundAutomatedMatch(
  scenario: MapScenario,
  profileIds: AiProfileId[],
  participantTeamIds: number[] = [],
): MapScenario {
  if (profileIds.length !== scenario.regions.length) return scenario
  const participantIds = aiParticipantIds(profileIds)
  const participants: MatchParticipant[] = scenario.regions.map((region, index) => ({
    id: participantIds[index],
    kind: 'ai',
    regionId: region.id,
    color: region.color,
    profileId: profileIds[index],
    ...(participantTeamIds[index] ? { teamId: participantTeamIds[index] } : {}),
  }))
  return placeFoundingCastles(scenario, participants, (region) => chooseCastleSiteForRegion(scenario, region))
}

export function isSpectatorScenario(scenario: MapScenario) {
  return scenario.participants.length > 0 && scenario.participants.every((participant) => participant.kind === 'ai')
}
