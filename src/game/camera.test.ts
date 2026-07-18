import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config/game'
import {
  clampCamera,
  screenToWorld,
  zoomAtPoint,
  type Camera,
  type Point,
  type Size,
} from './camera'

const viewport: Size = { width: 1200, height: 800 }
const world: Size = {
  width: gameConfig.map.columns * gameConfig.map.cellSize,
  height: gameConfig.map.rows * gameConfig.map.cellSize,
}

describe('camera', () => {
  it('keeps the visible area inside the world', () => {
    const result = clampCamera({ x: -500, y: 10_000, zoom: 1 }, viewport, world)

    expect(result.x).toBe(viewport.width / 2)
    expect(result.y).toBe(world.height - viewport.height / 2)
  })

  it('keeps the world point under the cursor while zooming', () => {
    const camera: Camera = { x: 3200, y: 3200, zoom: 1 }
    const cursor: Point = { x: 900, y: 240 }
    const before = screenToWorld(cursor, camera, viewport)
    const zoomed = zoomAtPoint(camera, cursor, 1.4, viewport, world)
    const after = screenToWorld(cursor, zoomed, viewport)

    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })
})
