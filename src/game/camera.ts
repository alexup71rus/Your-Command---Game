import { gameConfig } from '../config/game'

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Camera extends Point {
  zoom: number
}

export const MIN_ZOOM = gameConfig.camera.minZoom
export const MAX_ZOOM = gameConfig.camera.maxZoom

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export function effectiveMinimumZoom(viewport: Size, world: Size) {
  return Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, viewport.width / world.width, viewport.height / world.height),
  )
}

export function cameraForOverview(viewport: Size, world: Size, padding = 48): Camera {
  const availableWidth = Math.max(1, viewport.width - padding * 2)
  const availableHeight = Math.max(1, viewport.height - padding * 2)
  return {
    x: world.width / 2,
    y: world.height / 2,
    zoom: Math.min(MAX_ZOOM, availableWidth / world.width, availableHeight / world.height),
  }
}

export function clampCamera(camera: Camera, viewport: Size, world: Size, minimumZoom = effectiveMinimumZoom(viewport, world)): Camera {
  const zoom = clamp(
    camera.zoom,
    minimumZoom,
    MAX_ZOOM,
  )
  const halfWorldWidth = viewport.width / (2 * zoom)
  const halfWorldHeight = viewport.height / (2 * zoom)

  return {
    x:
      halfWorldWidth * 2 >= world.width
        ? world.width / 2
        : clamp(camera.x, halfWorldWidth, world.width - halfWorldWidth),
    y:
      halfWorldHeight * 2 >= world.height
        ? world.height / 2
        : clamp(camera.y, halfWorldHeight, world.height - halfWorldHeight),
    zoom,
  }
}

export function screenToWorld(
  point: Point,
  camera: Camera,
  viewport: Size,
): Point {
  return {
    x: camera.x + (point.x - viewport.width / 2) / camera.zoom,
    y: camera.y + (point.y - viewport.height / 2) / camera.zoom,
  }
}

export function worldToScreen(
  point: Point,
  camera: Camera,
  viewport: Size,
): Point {
  return {
    x: (point.x - camera.x) * camera.zoom + viewport.width / 2,
    y: (point.y - camera.y) * camera.zoom + viewport.height / 2,
  }
}

export function zoomAtPoint(
  camera: Camera,
  screenPoint: Point,
  nextZoom: number,
  viewport: Size,
  world: Size,
  minimumZoom = effectiveMinimumZoom(viewport, world),
): Camera {
  const anchor = screenToWorld(screenPoint, camera, viewport)
  const zoom = clamp(nextZoom, minimumZoom, MAX_ZOOM)

  return clampCamera(
    {
      x: anchor.x - (screenPoint.x - viewport.width / 2) / zoom,
      y: anchor.y - (screenPoint.y - viewport.height / 2) / zoom,
      zoom,
    },
    viewport,
    world,
    minimumZoom,
  )
}
