import { useEffect, useRef } from 'react'
import { gameConfig } from '../config/game'
import {
  cameraForOverview,
  clampCamera,
  screenToWorld,
  worldToScreen,
  zoomAtPoint,
  type Camera,
  type Point,
  type Size,
} from '../game/camera'
import type { GameMap } from '../game/map'
import { isCastleSiteValid, type CellPosition, type StartRegion, type TerritoryMap } from '../game/scenario'

const CELL_SIZE = gameConfig.map.cellSize

interface GridCanvasProps {
  map: GameMap
  territories?: TerritoryMap
  regions?: StartRegion[]
  showTerritories?: boolean
  mode?: 'playing' | 'founding'
  selectedRegionId?: string | null
  castleDraft?: CellPosition | null
  cameraCommand?: CameraCommand | null
  onContextRequest: (request: MapContextRequest) => void
  onMapClick: (request: MapClickRequest) => void
  onNavigate: (skill: 'move' | 'zoom') => void
  ariaLabel: string
}

export type CameraCommand =
  | ({ kind: 'cell'; key: number; zoom?: number } & CellPosition)
  | { kind: 'overview'; key: number }

export interface MapContextRequest {
  clientX: number
  clientY: number
  column: number
  row: number
}

export type MapClickRequest = MapContextRequest

type HoveredCell = CellPosition

const BACKGROUND_COLOR = '#0c100d'
const MAP_COLOR = '#202820'
const GRID_COLOR = 'rgba(164, 180, 150, 0.16)'
const MAJOR_GRID_COLOR = 'rgba(194, 174, 120, 0.22)'
const BORDER_COLOR = 'rgba(211, 185, 112, 0.58)'
const HOVER_COLOR = 'rgba(218, 189, 105, 0.16)'

export function GridCanvas(props: GridCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef(props)
  const requestDrawRef = useRef<() => void>(() => undefined)
  const focusRef = useRef<(command: CameraCommand) => void>(() => undefined)
  const cameraCommand = props.cameraCommand
  const initialCameraCommandRef = useRef(cameraCommand)
  const mapRows = props.map.length
  const mapColumns = props.map[0]?.length ?? 0

  useEffect(() => { propsRef.current = props })
  useEffect(() => requestDrawRef.current(), [props.map, props.showTerritories, props.selectedRegionId, props.castleDraft, props.regions, props.territories])
  useEffect(() => {
    if (cameraCommand) focusRef.current(cameraCommand)
  }, [cameraCommand])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const rows = mapRows
    const columns = mapColumns
    const world: Size = { width: columns * CELL_SIZE, height: rows * CELL_SIZE }
    const initialCameraCommand = initialCameraCommandRef.current
    let viewport: Size = { width: 1, height: 1 }
    let camera: Camera = initialCameraCommand?.kind === 'cell'
      ? { x: (initialCameraCommand.column + 0.5) * CELL_SIZE, y: (initialCameraCommand.row + 0.5) * CELL_SIZE, zoom: initialCameraCommand.zoom ?? 1 }
      : { x: world.width / 2, y: world.height / 2, zoom: initialCameraCommand?.kind === 'overview' ? gameConfig.camera.minZoom : 1 }
    let hoveredCell: HoveredCell | null = null
    let overviewActive = initialCameraCommand?.kind === 'overview'
    let sessionMinimumZoom = overviewActive ? camera.zoom : undefined
    let activePointerId: number | null = null
    let lastPointer: Point | null = null
    let pointerStart: Point | null = null
    let dragged = false
    let ctrlClickContextUntil = 0
    let animationFrame: number | null = null

    const requestDraw = () => {
      if (animationFrame !== null) return
      animationFrame = requestAnimationFrame(draw)
    }
    requestDrawRef.current = requestDraw
    focusRef.current = (command) => {
      overviewActive = command.kind === 'overview'
      camera = command.kind === 'overview'
        ? cameraForOverview(viewport, world)
        : clampCamera({ x: (command.column + 0.5) * CELL_SIZE, y: (command.row + 0.5) * CELL_SIZE, zoom: command.zoom ?? gameConfig.camera.foundingZoom }, viewport, world)
      sessionMinimumZoom = command.kind === 'overview' ? camera.zoom : undefined
      requestDraw()
    }

    const drawCastle = (x: number, y: number, size: number, color: string, ghost = false) => {
      const inset = size * 0.18
      context.save()
      context.globalAlpha = ghost ? 0.72 : 1
      context.fillStyle = color
      context.strokeStyle = ghost ? color : '#ead99f'
      context.lineWidth = Math.max(1, size * 0.045)
      context.beginPath()
      context.rect(x + inset, y + size * 0.34, size - inset * 2, size * 0.46)
      context.moveTo(x + inset, y + size * 0.34)
      context.lineTo(x + size * 0.29, y + size * 0.18)
      context.lineTo(x + size * 0.4, y + size * 0.34)
      context.moveTo(x + size * 0.6, y + size * 0.34)
      context.lineTo(x + size * 0.71, y + size * 0.18)
      context.lineTo(x + size - inset, y + size * 0.34)
      context.fill()
      context.stroke()
      context.fillStyle = ghost ? 'rgba(12,16,13,.35)' : '#242a22'
      context.fillRect(x + size * 0.44, y + size * 0.57, size * 0.12, size * 0.23)
      context.restore()
    }

    const draw = () => {
      animationFrame = null
      const current = propsRef.current
      const map = current.map
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
      const bottomRight = screenToWorld({ x: viewport.width, y: viewport.height }, camera, viewport)
      const firstColumn = Math.max(0, Math.floor(topLeft.x / CELL_SIZE))
      const lastColumn = Math.min(columns, Math.ceil(bottomRight.x / CELL_SIZE))
      const firstRow = Math.max(0, Math.floor(topLeft.y / CELL_SIZE))
      const lastRow = Math.min(rows, Math.ceil(bottomRight.y / CELL_SIZE))
      const cellSize = CELL_SIZE * camera.zoom

      for (let row = firstRow; row < lastRow; row += 1) {
        for (let column = firstColumn; column < lastColumn; column += 1) {
          const cell = map[row][column]
          if (cell.elevation === undefined) continue
          if (cell.landform === 'peak') context.fillStyle = cell.vegetation ? '#778174' : '#77766a'
          else if (cell.vegetation) context.fillStyle = cell.landform === 'hill' ? '#344d36' : '#263f2c'
          else if (cell.landform === 'hill') context.fillStyle = '#4c5140'
          else context.fillStyle = (cell.elevation ?? 0) > 0.4 ? '#344634' : '#2b3d30'
          context.fillRect(mapOrigin.x + column * cellSize, mapOrigin.y + row * cellSize, Math.ceil(cellSize), Math.ceil(cellSize))
        }
      }

      if (current.showTerritories && current.territories && current.regions) {
        const regionById = new Map(current.regions.map((region) => [region.id, region]))
        for (let row = firstRow; row < lastRow; row += 1) {
          for (let column = firstColumn; column < lastColumn; column += 1) {
            const regionId = current.territories[row]?.[column]
            const region = regionId ? regionById.get(regionId) : undefined
            if (!region) continue
            const x = mapOrigin.x + column * cellSize
            const y = mapOrigin.y + row * cellSize
            context.fillStyle = `${region.color}${current.selectedRegionId === regionId ? '28' : '13'}`
            context.fillRect(x, y, cellSize, cellSize)
            context.strokeStyle = `${region.color}d0`
            context.lineWidth = Math.max(1, Math.min(2.2, camera.zoom * 1.6))
            if (current.territories[row - 1]?.[column] !== regionId) { context.beginPath(); context.moveTo(x, y); context.lineTo(x + cellSize, y); context.stroke() }
            if (current.territories[row + 1]?.[column] !== regionId) { context.beginPath(); context.moveTo(x, y + cellSize); context.lineTo(x + cellSize, y + cellSize); context.stroke() }
            if (current.territories[row]?.[column - 1] !== regionId) { context.beginPath(); context.moveTo(x, y); context.lineTo(x, y + cellSize); context.stroke() }
            if (current.territories[row]?.[column + 1] !== regionId) { context.beginPath(); context.moveTo(x + cellSize, y); context.lineTo(x + cellSize, y + cellSize); context.stroke() }
          }
        }
        if (current.mode === 'founding' && !current.selectedRegionId) {
          current.regions.forEach((region) => {
            const center = worldToScreen({ x: (region.center.column + 0.5) * CELL_SIZE, y: (region.center.row + 0.5) * CELL_SIZE }, camera, viewport)
            context.fillStyle = region.color
            context.beginPath(); context.arc(center.x, center.y, 14, 0, Math.PI * 2); context.fill()
            context.fillStyle = '#121712'; context.font = '700 11px system-ui'; context.textAlign = 'center'; context.textBaseline = 'middle'
            context.fillText(String(region.index + 1), center.x, center.y + 0.5)
          })
        }
      }

      context.lineWidth = 1
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const x = Math.round(mapOrigin.x + column * CELL_SIZE * camera.zoom) + 0.5
        context.beginPath(); context.strokeStyle = column % 10 === 0 ? MAJOR_GRID_COLOR : GRID_COLOR
        context.moveTo(x, Math.max(0, mapOrigin.y)); context.lineTo(x, Math.min(viewport.height, mapOrigin.y + mapHeight)); context.stroke()
      }
      for (let row = firstRow; row <= lastRow; row += 1) {
        const y = Math.round(mapOrigin.y + row * CELL_SIZE * camera.zoom) + 0.5
        context.beginPath(); context.strokeStyle = row % 10 === 0 ? MAJOR_GRID_COLOR : GRID_COLOR
        context.moveTo(Math.max(0, mapOrigin.x), y); context.lineTo(Math.min(viewport.width, mapOrigin.x + mapWidth), y); context.stroke()
      }

      for (let row = firstRow; row < lastRow; row += 1) {
        for (let column = firstColumn; column < lastColumn; column += 1) {
          const object = map[row][column].object
          if (!object || object.type !== 'castle') continue
          const participant = current.regions?.find((region) => current.territories?.[row]?.[column] === region.id)
          drawCastle(mapOrigin.x + column * cellSize, mapOrigin.y + row * cellSize, cellSize, participant?.color ?? '#d2b45f')
        }
      }

      const ghostCell = current.castleDraft ?? (current.mode === 'founding' ? hoveredCell : null)
      if (ghostCell && current.selectedRegionId && current.territories) {
        const valid = isCastleSiteValid({ cells: map, territories: current.territories }, current.selectedRegionId, ghostCell)
        drawCastle(mapOrigin.x + ghostCell.column * cellSize, mapOrigin.y + ghostCell.row * cellSize, cellSize, valid ? '#d2b45f' : '#a65347', true)
      }

      if (hoveredCell) {
        const x = mapOrigin.x + hoveredCell.column * cellSize
        const y = mapOrigin.y + hoveredCell.row * cellSize
        context.fillStyle = HOVER_COLOR; context.fillRect(x, y, cellSize, cellSize)
        context.strokeStyle = BORDER_COLOR; context.lineWidth = 1.5; context.strokeRect(x + 0.75, y + 0.75, cellSize - 1.5, cellSize - 1.5)
      }
      context.strokeStyle = BORDER_COLOR; context.lineWidth = 1
      context.strokeRect(Math.round(mapOrigin.x) + 0.5, Math.round(mapOrigin.y) + 0.5, Math.round(mapWidth), Math.round(mapHeight))
    }

    const pointFromEvent = (event: MouseEvent): Point => {
      const bounds = canvas.getBoundingClientRect()
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    }
    const updateHoveredCell = (point: Point) => {
      const worldPoint = screenToWorld(point, camera, viewport)
      const column = Math.floor(worldPoint.x / CELL_SIZE)
      const row = Math.floor(worldPoint.y / CELL_SIZE)
      hoveredCell = column >= 0 && column < columns && row >= 0 && row < rows ? { column, row } : null
    }
    const requestForEvent = (event: PointerEvent | MouseEvent) => {
      const point = pointFromEvent(event)
      const worldPoint = screenToWorld(point, camera, viewport)
      const column = Math.floor(worldPoint.x / CELL_SIZE)
      const row = Math.floor(worldPoint.y / CELL_SIZE)
      if (column < 0 || column >= columns || row < 0 || row >= rows) return null
      return { clientX: event.clientX, clientY: event.clientY, column, row }
    }
    const requestContextMenu = (event: PointerEvent | MouseEvent) => {
      const request = requestForEvent(event)
      if (!request) return
      hoveredCell = { column: request.column, row: request.row }
      propsRef.current.onContextRequest(request)
      requestDraw()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0 && event.ctrlKey) {
        event.preventDefault()
        ctrlClickContextUntil = performance.now() + 400
        if (propsRef.current.mode !== 'founding') requestContextMenu(event)
        return
      }
      if (event.button !== 0 && event.button !== 1) return
      event.preventDefault()
      activePointerId = event.pointerId; lastPointer = pointFromEvent(event); pointerStart = lastPointer; dragged = false
      canvas.setPointerCapture(event.pointerId); canvas.dataset.dragging = 'true'
    }
    const onPointerMove = (event: PointerEvent) => {
      const point = pointFromEvent(event)
      if (event.pointerId === activePointerId && lastPointer) {
        if (!dragged && pointerStart && Math.hypot(point.x - pointerStart.x, point.y - pointerStart.y) > gameConfig.camera.dragThreshold) {
          dragged = true; overviewActive = false; propsRef.current.onNavigate('move')
        }
        if (dragged) {
          camera = clampCamera({ x: camera.x - (point.x - lastPointer.x) / camera.zoom, y: camera.y - (point.y - lastPointer.y) / camera.zoom, zoom: camera.zoom }, viewport, world, sessionMinimumZoom)
        }
        lastPointer = point
      }
      updateHoveredCell(point); requestDraw()
    }
    const stopDragging = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId) return
      const request = event.type === 'pointerup' && event.button === 0 && !dragged ? requestForEvent(event) : null
      activePointerId = null; lastPointer = null; pointerStart = null; delete canvas.dataset.dragging
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (request) propsRef.current.onMapClick(request)
    }
    const onPointerLeave = () => { if (activePointerId === null) { hoveredCell = null; requestDraw() } }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = pointFromEvent(event)
      camera = zoomAtPoint(camera, point, camera.zoom * Math.exp(-event.deltaY * gameConfig.camera.wheelSensitivity), viewport, world, sessionMinimumZoom)
      overviewActive = false
      propsRef.current.onNavigate('zoom'); updateHoveredCell(point); requestDraw()
    }
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      if (event.ctrlKey && performance.now() < ctrlClickContextUntil) return
      if (propsRef.current.mode !== 'founding') requestContextMenu(event)
    }
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      viewport = { width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }
      canvas.width = Math.round(viewport.width * dpr); canvas.height = Math.round(viewport.height * dpr)
      if (overviewActive) {
        camera = cameraForOverview(viewport, world)
        sessionMinimumZoom = camera.zoom
      } else camera = clampCamera(camera, viewport, world, sessionMinimumZoom)
      requestDraw()
    })

    canvas.addEventListener('pointerdown', onPointerDown); canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', stopDragging); canvas.addEventListener('pointercancel', stopDragging); canvas.addEventListener('lostpointercapture', stopDragging)
    canvas.addEventListener('pointerleave', onPointerLeave); canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('contextmenu', onContextMenu)
    resizeObserver.observe(canvas)
    return () => {
      resizeObserver.disconnect(); requestDrawRef.current = () => undefined; focusRef.current = () => undefined
      canvas.removeEventListener('pointerdown', onPointerDown); canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', stopDragging); canvas.removeEventListener('pointercancel', stopDragging); canvas.removeEventListener('lostpointercapture', stopDragging)
      canvas.removeEventListener('pointerleave', onPointerLeave); canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('contextmenu', onContextMenu)
      if (animationFrame !== null) cancelAnimationFrame(animationFrame)
    }
  }, [mapColumns, mapRows])

  return <canvas ref={canvasRef} className="grid-canvas" aria-label={props.ariaLabel} />
}
