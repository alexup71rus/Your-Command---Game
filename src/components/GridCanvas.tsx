import { useEffect, useRef } from 'react'
import {
  clampCamera,
  screenToWorld,
  worldToScreen,
  zoomAtPoint,
  type Camera,
  type Point,
  type Size,
} from '../game/camera'
import { gameConfig } from '../config/game'
import { type GameMap } from '../game/map'

const CELL_SIZE = gameConfig.map.cellSize

interface GridCanvasProps {
  map: GameMap
  onContextRequest: (request: MapContextRequest) => void
  onMapClick: (request: MapClickRequest) => void
}

export interface MapContextRequest {
  clientX: number
  clientY: number
  column: number
  row: number
}

export interface MapClickRequest {
  clientX: number
  clientY: number
}

interface HoveredCell {
  column: number
  row: number
}

const BACKGROUND_COLOR = '#0c100d'
const MAP_COLOR = '#202820'
const GRID_COLOR = 'rgba(164, 180, 150, 0.16)'
const MAJOR_GRID_COLOR = 'rgba(194, 174, 120, 0.22)'
const BORDER_COLOR = 'rgba(211, 185, 112, 0.58)'
const HOVER_COLOR = 'rgba(218, 189, 105, 0.16)'

export function GridCanvas({ map, onContextRequest, onMapClick }: GridCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    const rows = map.length
    const columns = map[0]?.length ?? 0
    const world: Size = {
      width: columns * CELL_SIZE,
      height: rows * CELL_SIZE,
    }
    let viewport: Size = { width: 1, height: 1 }
    let camera: Camera = {
      x: world.width / 2,
      y: world.height / 2,
      zoom: 1,
    }
    let hoveredCell: HoveredCell | null = null
    let activePointerId: number | null = null
    let lastPointer: Point | null = null
    let pointerStart: Point | null = null
    let dragged = false
    let animationFrame: number | null = null

    const requestDraw = () => {
      if (animationFrame !== null) return
      animationFrame = requestAnimationFrame(draw)
    }

    const draw = () => {
      animationFrame = null
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, viewport.width, viewport.height)
      context.fillStyle = BACKGROUND_COLOR
      context.fillRect(0, 0, viewport.width, viewport.height)

      const mapOrigin = worldToScreen({ x: 0, y: 0 }, camera, viewport)
      const mapWidth = world.width * camera.zoom
      const mapHeight = world.height * camera.zoom
      context.fillStyle = MAP_COLOR
      context.fillRect(mapOrigin.x, mapOrigin.y, mapWidth, mapHeight)

      const topLeft = screenToWorld({ x: 0, y: 0 }, camera, viewport)
      const bottomRight = screenToWorld(
        { x: viewport.width, y: viewport.height },
        camera,
        viewport,
      )
      const firstColumn = Math.max(0, Math.floor(topLeft.x / CELL_SIZE))
      const lastColumn = Math.min(columns, Math.ceil(bottomRight.x / CELL_SIZE))
      const firstRow = Math.max(0, Math.floor(topLeft.y / CELL_SIZE))
      const lastRow = Math.min(rows, Math.ceil(bottomRight.y / CELL_SIZE))

      context.lineWidth = 1
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const x = Math.round(mapOrigin.x + column * CELL_SIZE * camera.zoom) + 0.5
        context.beginPath()
        context.strokeStyle = column % 10 === 0 ? MAJOR_GRID_COLOR : GRID_COLOR
        context.moveTo(x, Math.max(0, mapOrigin.y))
        context.lineTo(x, Math.min(viewport.height, mapOrigin.y + mapHeight))
        context.stroke()
      }

      for (let row = firstRow; row <= lastRow; row += 1) {
        const y = Math.round(mapOrigin.y + row * CELL_SIZE * camera.zoom) + 0.5
        context.beginPath()
        context.strokeStyle = row % 10 === 0 ? MAJOR_GRID_COLOR : GRID_COLOR
        context.moveTo(Math.max(0, mapOrigin.x), y)
        context.lineTo(Math.min(viewport.width, mapOrigin.x + mapWidth), y)
        context.stroke()
      }

      if (hoveredCell) {
        const cellSize = CELL_SIZE * camera.zoom
        const x = mapOrigin.x + hoveredCell.column * cellSize
        const y = mapOrigin.y + hoveredCell.row * cellSize
        context.fillStyle = HOVER_COLOR
        context.fillRect(x, y, cellSize, cellSize)
        context.strokeStyle = BORDER_COLOR
        context.lineWidth = 1.5
        context.strokeRect(x + 0.75, y + 0.75, cellSize - 1.5, cellSize - 1.5)
      }

      context.strokeStyle = BORDER_COLOR
      context.lineWidth = 1
      context.strokeRect(
        Math.round(mapOrigin.x) + 0.5,
        Math.round(mapOrigin.y) + 0.5,
        Math.round(mapWidth),
        Math.round(mapHeight),
      )
    }

    const pointFromEvent = (event: MouseEvent): Point => {
      const bounds = canvas.getBoundingClientRect()
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    }

    const updateHoveredCell = (point: Point) => {
      const worldPoint = screenToWorld(point, camera, viewport)
      const column = Math.floor(worldPoint.x / CELL_SIZE)
      const row = Math.floor(worldPoint.y / CELL_SIZE)
      hoveredCell =
        column >= 0 && column < columns && row >= 0 && row < rows
          ? { column, row }
          : null
    }

    const requestContextMenu = (event: PointerEvent | MouseEvent) => {
      const point = pointFromEvent(event)
      const worldPoint = screenToWorld(point, camera, viewport)
      const column = Math.floor(worldPoint.x / CELL_SIZE)
      const row = Math.floor(worldPoint.y / CELL_SIZE)

      if (column < 0 || column >= columns || row < 0 || row >= rows) return

      hoveredCell = { column, row }
      onContextRequest({
        clientX: event.clientX,
        clientY: event.clientY,
        column,
        row,
      })
      requestDraw()
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0 && event.shiftKey) {
        event.preventDefault()
        requestContextMenu(event)
        return
      }
      if (event.button !== 0 && event.button !== 1) return
      event.preventDefault()
      activePointerId = event.pointerId
      lastPointer = pointFromEvent(event)
      pointerStart = lastPointer
      dragged = false
      canvas.setPointerCapture(event.pointerId)
      canvas.dataset.dragging = 'true'
    }

    const onPointerMove = (event: PointerEvent) => {
      const point = pointFromEvent(event)
      if (event.pointerId === activePointerId && lastPointer) {
        if (pointerStart && Math.hypot(point.x - pointerStart.x, point.y - pointerStart.y) > 5) {
          dragged = true
        }
        camera = clampCamera(
          {
            x: camera.x - (point.x - lastPointer.x) / camera.zoom,
            y: camera.y - (point.y - lastPointer.y) / camera.zoom,
            zoom: camera.zoom,
          },
          viewport,
          world,
        )
        lastPointer = point
      }
      updateHoveredCell(point)
      requestDraw()
    }

    const stopDragging = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId) return
      const wasClick = event.type === 'pointerup' && event.button === 0 && !dragged && hoveredCell !== null
      activePointerId = null
      lastPointer = null
      pointerStart = null
      delete canvas.dataset.dragging
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId)
      }
      if (wasClick) onMapClick({ clientX: event.clientX, clientY: event.clientY })
    }

    const onPointerLeave = () => {
      if (activePointerId === null) {
        hoveredCell = null
        requestDraw()
      }
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = pointFromEvent(event)
      camera = zoomAtPoint(
        camera,
        point,
        camera.zoom * Math.exp(-event.deltaY * 0.0015),
        viewport,
        world,
      )
      updateHoveredCell(point)
      requestDraw()
    }

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      requestContextMenu(event)
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return
      const width = Math.max(1, entry.contentRect.width)
      const height = Math.max(1, entry.contentRect.height)
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      viewport = { width, height }
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      camera = clampCamera(camera, viewport, world)
      requestDraw()
    })

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', stopDragging)
    canvas.addEventListener('pointercancel', stopDragging)
    canvas.addEventListener('lostpointercapture', stopDragging)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)
    resizeObserver.observe(canvas)

    return () => {
      resizeObserver.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', stopDragging)
      canvas.removeEventListener('pointercancel', stopDragging)
      canvas.removeEventListener('lostpointercapture', stopDragging)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      if (animationFrame !== null) cancelAnimationFrame(animationFrame)
    }
  }, [map, onContextRequest, onMapClick])

  return (
    <canvas
      ref={canvasRef}
      className="grid-canvas"
      aria-label="Карта игрового мира. Перетаскивайте мышью и используйте колесо для масштаба."
    />
  )
}
