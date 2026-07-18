import { gameConfig } from '../config/game'
import type { GameMap, Landform, MapCell } from './map'

export type ReliefMode = 'automatic' | 'hybrid' | 'manual'
export type HeightPreference = 'lowlands' | 'balanced' | 'highlands'
export type ManualHeight = 0 | 1 | 2
export type ManualHeightGrid = ManualHeight[][]

export interface GeneratorSettings {
  seed: number
  reliefMode: ReliefMode
  hillCoverage: number
  peakCoverage: number
  reliefScale: number
  heightDistribution: number
  vegetationDensity: number
  vegetationDistribution: number
  vegetationHeight: HeightPreference
  heightInfluence: number
}

export const defaultGeneratorSettings: GeneratorSettings = {
  seed: gameConfig.generator.defaultSeed,
  reliefMode: 'hybrid',
  hillCoverage: 36,
  peakCoverage: 6,
  reliefScale: 48,
  heightDistribution: 18,
  vegetationDensity: 38,
  vegetationDistribution: -8,
  vegetationHeight: 'balanced',
  heightInfluence: 62,
}

export function createManualHeightGrid(): ManualHeightGrid {
  return Array.from({ length: gameConfig.generator.editorRows }, () =>
    Array.from({ length: gameConfig.generator.editorColumns }, () => 0 as ManualHeight),
  )
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
const smooth = (value: number) => value * value * (3 - 2 * value)

function hash(x: number, y: number, seed: number) {
  let value = Math.imul(x ^ seed, 374761393) + Math.imul(y, 668265263)
  value = Math.imul(value ^ (value >>> 13), 1274126177)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295
}

function valueNoise(x: number, y: number, seed: number) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = smooth(x - x0)
  const ty = smooth(y - y0)
  const top = hash(x0, y0, seed) * (1 - tx) + hash(x0 + 1, y0, seed) * tx
  const bottom = hash(x0, y0 + 1, seed) * (1 - tx) + hash(x0 + 1, y0 + 1, seed) * tx
  return top * (1 - ty) + bottom * ty
}

function fractalNoise(x: number, y: number, seed: number, scale: number) {
  let value = 0
  let amplitude = 0.58
  let frequency = 1 / Math.max(8, scale)
  let total = 0
  for (let octave = 0; octave < 4; octave += 1) {
    value += valueNoise(x * frequency, y * frequency, seed + octave * 977) * amplitude
    total += amplitude
    frequency *= 2.05
    amplitude *= 0.5
  }
  return value / total
}

function radialFactor(column: number, row: number, columns: number, rows: number) {
  const dx = (column - (columns - 1) / 2) / (columns / 2)
  const dy = (row - (rows - 1) / 2) / (rows / 2)
  return clamp01(Math.hypot(dx, dy) / Math.SQRT2)
}

function manualRelief(
  column: number,
  row: number,
  columns: number,
  rows: number,
  manualGrid: ManualHeightGrid,
) {
  let influence = 0
  const radius = Math.max(columns / manualGrid[0].length, rows / manualGrid.length) * 2.3
  manualGrid.forEach((gridRow, gridY) => {
    gridRow.forEach((height, gridX) => {
      if (!height) return
      const centerX = ((gridX + 0.5) / gridRow.length) * columns
      const centerY = ((gridY + 0.5) / manualGrid.length) * rows
      const distanceSquared = (column - centerX) ** 2 + (row - centerY) ** 2
      const strength = height === 2 ? 1.05 : 0.6
      influence = Math.max(influence, Math.exp(-distanceSquared / (2 * radius ** 2)) * strength)
    })
  })
  return influence
}

function percentile(values: number[], coverage: number) {
  if (coverage <= 0) return Number.POSITIVE_INFINITY
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - coverage))))
  return sorted[index]
}

function elevationSuitability(elevation: number, preference: HeightPreference) {
  if (preference === 'lowlands') return 1 - elevation
  if (preference === 'highlands') return elevation
  return 1 - Math.abs(elevation - 0.48) * 1.55
}

function slopeAt(elevations: number[][], column: number, row: number) {
  const center = elevations[row][column]
  const left = elevations[row][Math.max(0, column - 1)]
  const right = elevations[row][Math.min(elevations[row].length - 1, column + 1)]
  const up = elevations[Math.max(0, row - 1)][column]
  const down = elevations[Math.min(elevations.length - 1, row + 1)][column]
  return Math.max(Math.abs(center - left), Math.abs(center - right), Math.abs(center - up), Math.abs(center - down))
}

export function generateMap(
  settings: GeneratorSettings,
  manualGrid: ManualHeightGrid,
  existingMap?: GameMap,
  vegetationOnly = false,
): GameMap {
  const rows = existingMap?.length ?? gameConfig.map.rows
  const columns = existingMap?.[0]?.length ?? gameConfig.map.columns
  const reliefScores: number[][] = []

  for (let row = 0; row < rows; row += 1) {
    const scoreRow: number[] = []
    for (let column = 0; column < columns; column += 1) {
      const radial = radialFactor(column, row, columns, rows)
      const automatic = fractalNoise(column, row, settings.seed, settings.reliefScale)
      const distribution = (settings.heightDistribution / 100) * (1 - radial * 2) * 0.35
      const manual = manualRelief(column, row, columns, rows, manualGrid)
      const modeScore = settings.reliefMode === 'automatic'
        ? automatic
        : settings.reliefMode === 'manual'
          ? 0.22 + manual * 0.78 + automatic * 0.08
          : automatic * 0.7 + manual * 0.55
      scoreRow.push(modeScore + distribution)
    }
    reliefScores.push(scoreRow)
  }

  const flatRelief = reliefScores.flat()
  const hillThreshold = percentile(flatRelief, settings.hillCoverage / 100)
  const peakThreshold = percentile(flatRelief, Math.min(settings.peakCoverage, settings.hillCoverage) / 100)
  const elevations: number[][] = reliefScores.map((scoreRow) => scoreRow.map((score) => {
    if (score >= peakThreshold) return 0.9 + clamp01((score - peakThreshold) * 1.6) * 0.1
    if (score >= hillThreshold) {
      const range = Math.max(0.0001, peakThreshold - hillThreshold)
      return 0.58 + clamp01((score - hillThreshold) / range) * 0.3
    }
    return 0.12 + clamp01(score / Math.max(0.0001, hillThreshold)) * 0.43
  }))

  if (vegetationOnly && existingMap) {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        elevations[row][column] = existingMap[row][column].elevation ?? elevations[row][column]
      }
    }
  }

  const vegetationCandidates: Array<{ column: number; row: number; score: number }> = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const elevation = elevations[row][column]
      if (elevation >= 0.9) continue
      const radial = radialFactor(column, row, columns, rows)
      const distribution = (settings.vegetationDistribution / 100) * (1 - radial * 2) * 0.28
      const suitability = elevationSuitability(elevation, settings.vegetationHeight)
      const influence = settings.heightInfluence / 100
      const moisture = fractalNoise(column + 311, row - 197, settings.seed + 1709, settings.reliefScale * 0.72)
      const slopePenalty = slopeAt(elevations, column, row) * 1.8
      vegetationCandidates.push({
        column,
        row,
        score: moisture * (1 - influence * 0.55) + suitability * influence * 0.55 + distribution - slopePenalty,
      })
    }
  }
  vegetationCandidates.sort((a, b) => b.score - a.score)
  const forestCells = new Set(
    vegetationCandidates
      .slice(0, Math.round(vegetationCandidates.length * settings.vegetationDensity / 100))
      .map(({ column, row }) => row * columns + column),
  )

  return elevations.map((elevationRow, row) => elevationRow.map((elevation, column): MapCell => {
    const original = existingMap?.[row]?.[column]
    const landform: Landform = elevation >= 0.9 ? 'peak' : elevation >= 0.58 ? 'hill' : 'plain'
    return {
      ...original,
      elevation,
      landform,
      vegetation: forestCells.has(row * columns + column),
    }
  }))
}
