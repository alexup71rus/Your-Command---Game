import { useEffect, useLayoutEffect, useRef } from 'react'
import { aiAvatarPaths } from '../config/ai'
import { gameConfig } from '../config/game'
import { buildingRules, combatRules, troopKinds } from '../config/rules'
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
import type { BuildingKind, GameMap, TroopComposition, TroopKind } from '../game/map'
import { maxSquadHealth, positionKey, squadHealth, workerSeverity, type WorkerAssignment, type WorkforceSummary } from '../game/match'
import { squadMovementOrderCost, squadMovementOrderCostBetween } from '../game/movement'
import { areOwnersHostile, isCastleSiteValid, type AiProfileId, type CellPosition, type MatchParticipant, type StartRegion, type TerritoryMap } from '../game/scenario'
import { isCellVisible, isObjectVisible, visibleObjectAt, type VisibilityMap } from '../game/visibility'
import { drawBuilding } from './mapRendering/buildings'
import { drawCastle } from './mapRendering/castle'

const CELL_SIZE = gameConfig.map.cellSize

interface GridCanvasProps {
  map: GameMap
  territories?: TerritoryMap
  regions?: StartRegion[]
  participants?: MatchParticipant[]
  workforceByOwner?: Map<string, WorkforceSummary>
  foundingOpponents?: Array<{ profileId: AiProfileId; region: StartRegion }>
  showTerritories?: boolean
  showGrid?: boolean
  territoryInspecting?: boolean
  mode?: 'playing' | 'founding'
  selectedRegionId?: string | null
  castleDraft?: CellPosition | null
  selectedCell?: CellPosition | null
  movementSource?: CellPosition | null
  movementPath?: CellPosition[] | null
  movementOrdersRemaining?: number
  unitAnimation?: { key: number; from: CellPosition; to: CellPosition } | null
  visibility?: VisibilityMap | null
  viewerId?: string
  actionPreview?: { kind: 'building'; building: BuildingKind } | { kind: 'squad'; units: TroopComposition } | { kind: 'target' } | null
  isActionCellValid?: (position: CellPosition) => boolean
  cameraCommand?: CameraCommand | null
  combatEffect?: ({ key: number } & CellPosition) | null
  onCombatEffect?: (request: Pick<MapClickRequest, 'clientX' | 'clientY'>) => void
  onObjectHover?: (request: MapObjectHoverRequest | null) => void
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

export interface MapObjectHoverRequest extends MapClickRequest {
  ownerId: string
  object: { type: 'castle' } | { type: 'building'; kind: BuildingKind } | { type: 'squad' }
}

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
  const cellClientPointRef = useRef<(position: CellPosition) => Point | null>(() => null)
  const lastCombatEffectKeyRef = useRef(0)
  const opponentImagesRef = useRef(new Map<AiProfileId, HTMLImageElement>())
  const cameraCommand = props.cameraCommand
  const combatEffect = props.combatEffect
  const onCombatEffect = props.onCombatEffect
  const initialCameraCommandRef = useRef(cameraCommand)
  const mapRows = props.map.length
  const mapColumns = props.map[0]?.length ?? 0
  const hasDecorativeBorder = props.mode !== undefined

  useLayoutEffect(() => { propsRef.current = props })
  useEffect(() => requestDrawRef.current(), [props.map, props.showTerritories, props.showGrid, props.selectedRegionId, props.castleDraft, props.regions, props.territories, props.participants, props.foundingOpponents, props.selectedCell, props.movementSource, props.movementPath, props.movementOrdersRemaining, props.unitAnimation, props.visibility, props.viewerId, props.actionPreview, props.workforceByOwner])
  useEffect(() => {
    props.foundingOpponents?.forEach(({ profileId }) => {
      if (opponentImagesRef.current.has(profileId)) return
      const image = new Image()
      image.onload = () => requestDrawRef.current()
      image.src = `${import.meta.env.BASE_URL}${aiAvatarPaths[profileId]}`
      opponentImagesRef.current.set(profileId, image)
    })
  }, [props.foundingOpponents])
  useLayoutEffect(() => {
    if (cameraCommand) focusRef.current(cameraCommand)
  }, [cameraCommand])

  useLayoutEffect(() => {
    if (!combatEffect || combatEffect.key === lastCombatEffectKeyRef.current) return
    const point = cellClientPointRef.current(combatEffect)
    if (!point) return
    lastCombatEffectKeyRef.current = combatEffect.key
    onCombatEffect?.({ clientX: point.x, clientY: point.y })
  }, [combatEffect, onCombatEffect])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const rows = mapRows
    const columns = mapColumns
    const decorativeBorderCells = hasDecorativeBorder ? gameConfig.camera.decorativeBorderCells : 0
    const mapOffset = decorativeBorderCells * CELL_SIZE
    const visualRows = rows + decorativeBorderCells * 2
    const visualColumns = columns + decorativeBorderCells * 2
    const world: Size = { width: visualColumns * CELL_SIZE, height: visualRows * CELL_SIZE }
    const cameraEdgePadding = decorativeBorderCells > 0 ? 0 : gameConfig.camera.edgePanPadding
    const initialCameraCommand = initialCameraCommandRef.current
    let viewport: Size = { width: 1, height: 1 }
    let camera: Camera = initialCameraCommand?.kind === 'cell'
      ? { x: mapOffset + (initialCameraCommand.column + 0.5) * CELL_SIZE, y: mapOffset + (initialCameraCommand.row + 0.5) * CELL_SIZE, zoom: initialCameraCommand.zoom ?? 1 }
      : { x: world.width / 2, y: world.height / 2, zoom: initialCameraCommand?.kind === 'overview' ? gameConfig.camera.minZoom : 1 }
    let hoveredCell: HoveredCell | null = null
    let overviewActive = initialCameraCommand?.kind === 'overview'
    let sessionMinimumZoom = overviewActive ? camera.zoom : undefined
    let activePointerId: number | null = null
    let lastPointer: Point | null = null
    let pointerStart: Point | null = null
    let dragged = false
    let ctrlClickContextUntil = 0
    let reportedObjectKey: string | null = null
    let reportedObjectHandler: GridCanvasProps['onObjectHover']
    let animationFrame: number | null = null
    let lastUnitAnimationKey = 0
    let activeUnitAnimation: { key: number; from: CellPosition; to: CellPosition; startedAt: number } | null = null
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

    const requestDraw = () => {
      if (animationFrame !== null) return
      animationFrame = requestAnimationFrame(draw)
    }
    requestDrawRef.current = requestDraw
    focusRef.current = (command) => {
      overviewActive = command.kind === 'overview'
      camera = command.kind === 'overview'
        ? cameraForOverview(viewport, world)
        : clampCamera({ x: mapOffset + (command.column + 0.5) * CELL_SIZE, y: mapOffset + (command.row + 0.5) * CELL_SIZE, zoom: command.zoom ?? gameConfig.camera.foundingZoom }, viewport, world, undefined, cameraEdgePadding)
      sessionMinimumZoom = command.kind === 'overview' ? camera.zoom : undefined
      requestDraw()
    }
    cellClientPointRef.current = (position) => {
      if (position.column < 0 || position.column >= columns || position.row < 0 || position.row >= rows) return null
      const point = worldToScreen({ x: mapOffset + (position.column + 0.5) * CELL_SIZE, y: mapOffset + (position.row + 0.5) * CELL_SIZE }, camera, viewport)
      const bounds = canvas.getBoundingClientRect()
      return { x: bounds.left + point.x, y: bounds.top + point.y }
    }

    const drawSquad = (x: number, y: number, size: number, units: TroopComposition, color: string, ghost = false) => {
      if (!ghost && size < 18) {
        const offset = (18 - size) / 2
        x -= offset
        y -= offset
        size = 18
      }
      context.save()
      context.globalAlpha = ghost ? 0.7 : 1
      context.fillStyle = ghost ? color : '#1a211b'
      context.strokeStyle = color
      context.lineWidth = Math.max(1.3, size * 0.055)
      if (!ghost) {
        context.shadowColor = 'rgba(0, 0, 0, .55)'
        context.shadowBlur = Math.min(8, size * .16)
        context.shadowOffsetY = Math.max(1, size * .04)
      }
      context.beginPath()
      context.moveTo(x + size * 0.5, y + size * 0.14)
      context.lineTo(x + size * 0.78, y + size * 0.25)
      context.lineTo(x + size * 0.72, y + size * 0.65)
      context.quadraticCurveTo(x + size * 0.5, y + size * 0.88, x + size * 0.28, y + size * 0.65)
      context.lineTo(x + size * 0.22, y + size * 0.25)
      context.closePath(); context.fill(); context.stroke()
      context.shadowColor = 'transparent'
      context.shadowBlur = 0
      context.shadowOffsetY = 0
      const activeTroops = troopKinds.filter((kind) => (units[kind] ?? 0) > 0)
      const total = activeTroops.reduce((sum, kind) => sum + (units[kind] ?? 0), 0)
      context.textAlign = 'center'; context.textBaseline = 'middle'
      const detailMinimumSize = 34 + activeTroops.length * 10
      if (size < detailMinimumSize || activeTroops.length === 0) {
        const fontSize = Math.max(11, Math.min(18, size * .31))
        context.lineWidth = Math.max(2.5, fontSize * .24)
        context.strokeStyle = 'rgba(7, 10, 8, .92)'
        context.font = `800 ${fontSize}px system-ui`
        context.strokeText(String(total), x + size * 0.5, y + size * 0.48)
        context.fillStyle = ghost ? '#192019' : '#ead99f'
        context.fillText(String(total), x + size * 0.5, y + size * 0.48)
        context.restore()
        return
      }

      const layouts: Record<number, Array<[number, number]>> = {
        1: [[.5, .48]],
        2: [[.37, .48], [.63, .48]],
        3: [[.36, .37], [.64, .37], [.5, .63]],
        4: [[.37, .36], [.63, .36], [.37, .63], [.63, .63]],
      }
      const positions = layouts[activeTroops.length]
      const radius = size * (activeTroops.length === 1 ? .19 : .115)
      const drawGlyph = (kind: TroopKind, centerX: number, centerY: number) => {
        const glyph = radius * 1.08
        context.strokeStyle = ghost ? '#293128' : '#ead99f'
        context.fillStyle = ghost ? '#293128' : '#ead99f'
        context.lineWidth = Math.max(1, radius * .18)
        context.lineCap = 'round'; context.lineJoin = 'round'
        if (kind === 'militia') {
          context.beginPath(); context.arc(centerX, centerY, glyph * .48, 0, Math.PI * 2); context.stroke()
          context.beginPath(); context.moveTo(centerX, centerY - glyph * .55); context.lineTo(centerX, centerY + glyph * .55); context.stroke()
        } else if (kind === 'spearmen') {
          context.beginPath(); context.moveTo(centerX - glyph * .55, centerY + glyph * .55); context.lineTo(centerX + glyph * .42, centerY - glyph * .42); context.stroke()
          context.beginPath(); context.moveTo(centerX + glyph * .18, centerY - glyph * .48); context.lineTo(centerX + glyph * .62, centerY - glyph * .62); context.lineTo(centerX + glyph * .48, centerY - glyph * .18); context.closePath(); context.fill()
        } else if (kind === 'archers') {
          context.beginPath(); context.arc(centerX - glyph * .18, centerY, glyph * .62, -Math.PI * .5, Math.PI * .5); context.stroke()
          context.beginPath(); context.moveTo(centerX - glyph * .18, centerY - glyph * .62); context.lineTo(centerX + glyph * .12, centerY); context.lineTo(centerX - glyph * .18, centerY + glyph * .62); context.moveTo(centerX - glyph * .42, centerY); context.lineTo(centerX + glyph * .58, centerY); context.stroke()
        } else {
          context.beginPath(); context.arc(centerX, centerY - glyph * .08, glyph * .54, Math.PI, 0); context.lineTo(centerX + glyph * .48, centerY + glyph * .42); context.lineTo(centerX - glyph * .48, centerY + glyph * .42); context.closePath(); context.stroke()
          context.beginPath(); context.moveTo(centerX, centerY - glyph * .62); context.lineTo(centerX, centerY + glyph * .42); context.moveTo(centerX, centerY); context.lineTo(centerX + glyph * .46, centerY); context.stroke()
        }
      }

      activeTroops.forEach((kind, index) => {
        const [offsetX, offsetY] = positions[index]
        const centerX = x + size * offsetX
        const centerY = y + size * offsetY
        context.fillStyle = ghost ? 'rgba(220,195,119,.5)' : '#202921'
        context.strokeStyle = color
        context.lineWidth = Math.max(1, size * .025)
        context.beginPath(); context.arc(centerX, centerY, radius, 0, Math.PI * 2); context.fill(); context.stroke()
        drawGlyph(kind, centerX, centerY)
        const badgeRadius = Math.max(6, Math.min(8, radius * .58))
        const badgeX = centerX + radius * .72
        const badgeY = centerY + radius * .68
        context.fillStyle = ghost ? 'rgba(25, 32, 25, .7)' : '#111711'
        context.beginPath(); context.arc(badgeX, badgeY, badgeRadius + 1.5, 0, Math.PI * 2); context.fill()
        context.fillStyle = ghost ? color : '#c5a950'
        context.beginPath(); context.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2); context.fill()
        context.fillStyle = '#172018'
        context.font = `800 ${Math.max(10, Math.min(13, badgeRadius * 1.35))}px system-ui`
        context.fillText(String(units[kind] ?? 0), badgeX, badgeY + .2)
      })
      context.restore()
    }

    const reflectedMapIndex = (index: number, length: number) => {
      if (length <= 1) return 0
      if (index < 0) return Math.min(length - 1, -index - 1)
      if (index >= length) return Math.max(0, length * 2 - index - 1)
      return index
    }

    const draw = () => {
      animationFrame = null
      const current = propsRef.current
      const map = current.map
      if (current.unitAnimation && current.unitAnimation.key !== lastUnitAnimationKey) {
        lastUnitAnimationKey = current.unitAnimation.key
        activeUnitAnimation = reducedMotionQuery.matches ? null : { ...current.unitAnimation, startedAt: performance.now() }
      }
      if (!current.unitAnimation) activeUnitAnimation = null
      if (activeUnitAnimation && reducedMotionQuery.matches) activeUnitAnimation = null
      const animationElapsed = activeUnitAnimation ? performance.now() - activeUnitAnimation.startedAt : gameConfig.camera.unitMoveAnimationMs
      const animationProgress = Math.min(1, animationElapsed / gameConfig.camera.unitMoveAnimationMs)
      if (activeUnitAnimation && animationProgress >= 1) activeUnitAnimation = null
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, viewport.width, viewport.height)
      context.fillStyle = BACKGROUND_COLOR
      context.fillRect(0, 0, viewport.width, viewport.height)

      const visualOrigin = worldToScreen({ x: 0, y: 0 }, camera, viewport)
      const mapOrigin = worldToScreen({ x: mapOffset, y: mapOffset }, camera, viewport)
      const visualWidth = world.width * camera.zoom
      const visualHeight = world.height * camera.zoom
      const mapWidth = columns * CELL_SIZE * camera.zoom
      const mapHeight = rows * CELL_SIZE * camera.zoom
      context.fillStyle = MAP_COLOR
      context.fillRect(visualOrigin.x, visualOrigin.y, visualWidth, visualHeight)

      const topLeft = screenToWorld({ x: 0, y: 0 }, camera, viewport)
      const bottomRight = screenToWorld({ x: viewport.width, y: viewport.height }, camera, viewport)
      const firstVisualColumn = Math.max(0, Math.floor(topLeft.x / CELL_SIZE))
      const lastVisualColumn = Math.min(visualColumns, Math.ceil(bottomRight.x / CELL_SIZE))
      const firstVisualRow = Math.max(0, Math.floor(topLeft.y / CELL_SIZE))
      const lastVisualRow = Math.min(visualRows, Math.ceil(bottomRight.y / CELL_SIZE))
      const firstColumn = Math.max(0, Math.floor((topLeft.x - mapOffset) / CELL_SIZE))
      const lastColumn = Math.min(columns, Math.ceil((bottomRight.x - mapOffset) / CELL_SIZE))
      const firstRow = Math.max(0, Math.floor((topLeft.y - mapOffset) / CELL_SIZE))
      const lastRow = Math.min(rows, Math.ceil((bottomRight.y - mapOffset) / CELL_SIZE))
      const cellSize = CELL_SIZE * camera.zoom

      const workforceByOwner = current.workforceByOwner
      const workerAssignmentByKey = workforceByOwner && workforceByOwner.size > 0 ? new Map<string, WorkerAssignment>() : null
      if (workforceByOwner && workerAssignmentByKey) {
        workforceByOwner.forEach((summary) => {
          summary.assignments.forEach((assignment) => {
            workerAssignmentByKey.set(positionKey(assignment.position), assignment)
          })
        })
      }

      for (let visualRow = firstVisualRow; visualRow < lastVisualRow; visualRow += 1) {
        for (let visualColumn = firstVisualColumn; visualColumn < lastVisualColumn; visualColumn += 1) {
          const row = visualRow - decorativeBorderCells
          const column = visualColumn - decorativeBorderCells
          const cell = map[reflectedMapIndex(row, rows)]?.[reflectedMapIndex(column, columns)]
          if (!cell) continue
          if (cell.elevation === undefined) continue
          if (cell.landform === 'peak') context.fillStyle = cell.vegetation ? '#778174' : '#77766a'
          else if (cell.vegetation) context.fillStyle = cell.landform === 'hill' ? '#344d36' : '#263f2c'
          else if (cell.landform === 'hill') context.fillStyle = '#4c5140'
          else context.fillStyle = (cell.elevation ?? 0) > 0.4 ? '#344634' : '#2b3d30'
          const x = visualOrigin.x + visualColumn * cellSize
          const y = visualOrigin.y + visualRow * cellSize
          context.fillRect(x, y, Math.ceil(cellSize), Math.ceil(cellSize))
          if (row < 0 || row >= rows || column < 0 || column >= columns) {
            const edgeDistance = Math.max(-row, row - rows + 1, -column, column - columns + 1)
            context.fillStyle = `rgba(6, 10, 7, ${0.035 + edgeDistance / Math.max(1, decorativeBorderCells) * 0.08})`
            context.fillRect(x, y, Math.ceil(cellSize), Math.ceil(cellSize))
          }
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
            const center = worldToScreen({ x: mapOffset + (region.center.column + 0.5) * CELL_SIZE, y: mapOffset + (region.center.row + 0.5) * CELL_SIZE }, camera, viewport)
            context.fillStyle = region.color
            context.beginPath(); context.arc(center.x, center.y, 14, 0, Math.PI * 2); context.fill()
            context.fillStyle = '#121712'; context.font = '700 11px system-ui'; context.textAlign = 'center'; context.textBaseline = 'middle'
            context.fillText(String(region.index + 1), center.x, center.y + 0.5)
          })
        }
        if (current.mode === 'founding' && current.selectedRegionId) {
          current.foundingOpponents?.forEach(({ profileId, region }) => {
            const image = opponentImagesRef.current.get(profileId)
            const center = worldToScreen({ x: mapOffset + (region.center.column + 0.5) * CELL_SIZE, y: mapOffset + (region.center.row + 0.5) * CELL_SIZE }, camera, viewport)
            const radius = Math.max(18, Math.min(27, 18 * Math.sqrt(camera.zoom)))
            context.save()
            context.shadowColor = 'rgba(0, 0, 0, .62)'
            context.shadowBlur = 12
            context.fillStyle = '#172019'
            context.beginPath(); context.arc(center.x, center.y, radius + 4, 0, Math.PI * 2); context.fill()
            context.shadowColor = 'transparent'
            context.beginPath(); context.arc(center.x, center.y, radius, 0, Math.PI * 2); context.clip()
            if (image?.complete && image.naturalWidth > 0) context.drawImage(image, center.x - radius, center.y - radius, radius * 2, radius * 2)
            else { context.fillStyle = region.color; context.fillRect(center.x - radius, center.y - radius, radius * 2, radius * 2) }
            context.restore()
            context.strokeStyle = region.color
            context.lineWidth = 3
            context.beginPath(); context.arc(center.x, center.y, radius + 2, 0, Math.PI * 2); context.stroke()
          })
        }
      }

      if (current.showGrid !== false) {
        context.lineWidth = 1
        for (let visualColumn = firstVisualColumn; visualColumn <= lastVisualColumn; visualColumn += 1) {
          const column = visualColumn - decorativeBorderCells
          const x = Math.round(visualOrigin.x + visualColumn * CELL_SIZE * camera.zoom) + 0.5
          context.beginPath(); context.strokeStyle = column % 10 === 0 ? MAJOR_GRID_COLOR : GRID_COLOR
          context.moveTo(x, Math.max(0, visualOrigin.y)); context.lineTo(x, Math.min(viewport.height, visualOrigin.y + visualHeight)); context.stroke()
        }
        for (let visualRow = firstVisualRow; visualRow <= lastVisualRow; visualRow += 1) {
          const row = visualRow - decorativeBorderCells
          const y = Math.round(visualOrigin.y + visualRow * CELL_SIZE * camera.zoom) + 0.5
          context.beginPath(); context.strokeStyle = row % 10 === 0 ? MAJOR_GRID_COLOR : GRID_COLOR
          context.moveTo(Math.max(0, visualOrigin.x), y); context.lineTo(Math.min(viewport.width, visualOrigin.x + visualWidth), y); context.stroke()
        }
      }

      if (current.movementPath && current.movementPath.length > 1) {
        context.save()
        context.strokeStyle = 'rgba(232, 202, 112, .78)'
        context.lineWidth = Math.max(1.5, Math.min(3, camera.zoom * 2.2))
        context.setLineDash([Math.max(4, cellSize * .12), Math.max(3, cellSize * .09)])
        context.beginPath()
        current.movementPath.forEach((position, index) => {
          const x = mapOrigin.x + (position.column + .5) * cellSize
          const y = mapOrigin.y + (position.row + .5) * cellSize
          if (index === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
        })
        context.stroke()
        context.setLineDash([])
        const destination = current.movementPath[current.movementPath.length - 1]
        const destinationX = mapOrigin.x + (destination.column + .5) * cellSize
        const destinationY = mapOrigin.y + (destination.row + .5) * cellSize
        context.fillStyle = 'rgba(25, 31, 24, .9)'
        context.strokeStyle = '#e3c66f'
        context.lineWidth = Math.max(1.5, Math.min(2.5, camera.zoom * 2))
        context.beginPath(); context.arc(destinationX, destinationY, Math.max(6, cellSize * .13), 0, Math.PI * 2); context.fill(); context.stroke()
        context.fillStyle = '#f0d681'
        context.beginPath(); context.arc(destinationX, destinationY, Math.max(2, cellSize * .038), 0, Math.PI * 2); context.fill()
        context.restore()
      }

      const firstObjectRow = Math.max(0, firstRow - 1)
      const firstObjectColumn = Math.max(0, firstColumn - 1)
      for (let row = firstObjectRow; row < lastRow; row += 1) {
        for (let column = firstObjectColumn; column < lastColumn; column += 1) {
          const object = current.viewerId
            ? visibleObjectAt(map, current.visibility, current.viewerId, { column, row })
            : map[row][column].object
          if (!object) continue
          if (object.type === 'building' && object.footprint && (object.footprint.originColumn !== column || object.footprint.originRow !== row)) continue
          if (activeUnitAnimation && row === activeUnitAnimation.to.row && column === activeUnitAnimation.to.column && object.type === 'squad') continue
          const participant = current.participants?.find((candidate) => candidate.id === object.ownerId)
          const fallbackRegion = current.regions?.find((region) => current.territories?.[row]?.[column] === region.id)
          const color = participant?.color ?? fallbackRegion?.color ?? '#d2b45f'
          const x = mapOrigin.x + column * cellSize
          const y = mapOrigin.y + row * cellSize
          const objectWidth = object.type === 'building' ? cellSize * (object.footprint?.columns ?? 1) : cellSize
          const objectHeight = object.type === 'building' ? cellSize * (object.footprint?.rows ?? 1) : cellSize
          if (object.type === 'castle') drawCastle(context, x, y, cellSize, color)
          else if (object.type === 'building') drawBuilding(context, x, y, Math.max(objectWidth, objectHeight), object.kind, color)
          else drawSquad(x, y, cellSize, object.units, color)
          if (object.type === 'building' && workerAssignmentByKey && cellSize >= 18) {
            const origin = object.footprint
              ? { column: object.footprint.originColumn, row: object.footprint.originRow }
              : { column, row }
            const assignment = workerAssignmentByKey.get(positionKey(origin))
            const severity = assignment ? workerSeverity(assignment) : null
            if (severity) {
              const badgeRadius = Math.max(7, cellSize * 0.14)
              const badgeCenterX = x + objectWidth * 0.82
              const badgeCenterY = y + objectHeight * 0.18
              const badgeColor = severity === 'stopped' ? '#c97060' : '#c9a23f'
              context.save()
              context.fillStyle = '#1b241d'
              context.strokeStyle = badgeColor
              context.lineWidth = Math.max(1, cellSize * 0.025)
              context.beginPath()
              context.arc(badgeCenterX, badgeCenterY, badgeRadius, 0, Math.PI * 2)
              context.fill()
              context.stroke()
              context.strokeStyle = badgeColor
              context.lineWidth = Math.max(1.5, badgeRadius * 0.22)
              context.lineCap = 'round'
              if (severity === 'stopped') {
                const span = badgeRadius * 0.55
                context.beginPath()
                context.moveTo(badgeCenterX - span, badgeCenterY - span)
                context.lineTo(badgeCenterX + span, badgeCenterY + span)
                context.moveTo(badgeCenterX + span, badgeCenterY - span)
                context.lineTo(badgeCenterX - span, badgeCenterY + span)
                context.stroke()
              } else {
                context.beginPath()
                context.moveTo(badgeCenterX, badgeCenterY - badgeRadius * 0.5)
                context.lineTo(badgeCenterX, badgeCenterY + badgeRadius * 0.18)
                context.stroke()
                context.beginPath()
                context.arc(badgeCenterX, badgeCenterY + badgeRadius * 0.5, Math.max(1, badgeRadius * 0.12), 0, Math.PI * 2)
                context.fillStyle = badgeColor
                context.fill()
              }
              context.restore()
            }
          }
          if (object.type === 'building' && object.kind === 'tower' && object.garrison && cellSize >= 22) {
            const centerX = x + cellSize * .75
            const centerY = y + cellSize * .25
            const radius = Math.max(7, cellSize * .15)
            const countRadius = Math.max(7, Math.min(9, radius * .58))
            const countX = centerX + radius * .72
            const countY = centerY + radius * .7
            context.save()
            context.fillStyle = '#1b241d'; context.strokeStyle = color; context.lineWidth = Math.max(1, cellSize * .025)
            context.beginPath(); context.arc(centerX, centerY, radius, 0, Math.PI * 2); context.fill(); context.stroke()
            context.strokeStyle = '#ead99f'; context.lineWidth = Math.max(1, radius * .14); context.lineCap = 'round'
            context.beginPath(); context.arc(centerX - radius * .18, centerY, radius * .46, -Math.PI * .5, Math.PI * .5); context.stroke()
            context.beginPath(); context.moveTo(centerX - radius * .18, centerY - radius * .46); context.lineTo(centerX + radius * .08, centerY); context.lineTo(centerX - radius * .18, centerY + radius * .46); context.moveTo(centerX - radius * .35, centerY); context.lineTo(centerX + radius * .42, centerY); context.stroke()
            context.fillStyle = '#111711'; context.beginPath(); context.arc(countX, countY, countRadius + 1.5, 0, Math.PI * 2); context.fill()
            context.fillStyle = '#c7aa51'; context.beginPath(); context.arc(countX, countY, countRadius, 0, Math.PI * 2); context.fill()
            context.fillStyle = '#172018'; context.font = `800 ${Math.max(10, Math.min(13, countRadius * 1.35))}px system-ui`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(object.garrison.archers), countX, countY + .2)
            context.restore()
          }
          if (object.type === 'squad' && squadHealth(object) < maxSquadHealth(object) && cellSize >= 18) {
            const healthRatio = squadHealth(object) / maxSquadHealth(object)
            context.fillStyle = 'rgba(7,9,7,.72)'; context.fillRect(x + cellSize * 0.16, y + cellSize * 0.87, cellSize * 0.68, Math.max(2, cellSize * 0.055))
            context.fillStyle = healthRatio > 0.4 ? '#c2a954' : '#b45f51'; context.fillRect(x + cellSize * 0.16, y + cellSize * 0.87, cellSize * 0.68 * healthRatio, Math.max(2, cellSize * 0.055))
          } else if (object.type !== 'squad' && object.hitPoints < object.maxHitPoints && cellSize >= 18) {
            context.fillStyle = 'rgba(7,9,7,.72)'; context.fillRect(x + objectWidth * 0.16, y + objectHeight * 0.87, objectWidth * 0.68, Math.max(2, cellSize * 0.055))
            context.fillStyle = object.hitPoints / object.maxHitPoints > 0.4 ? '#c2a954' : '#b45f51'; context.fillRect(x + objectWidth * 0.16, y + objectHeight * 0.87, objectWidth * 0.68 * object.hitPoints / object.maxHitPoints, Math.max(2, cellSize * 0.055))
          }
        }
      }

      if (activeUnitAnimation) {
        const movingObject = map[activeUnitAnimation.to.row]?.[activeUnitAnimation.to.column]?.object
        if (movingObject?.type === 'squad') {
          const participant = current.participants?.find((candidate) => candidate.id === movingObject.ownerId)
          const color = participant?.color ?? '#d2b45f'
          const eased = animationProgress * animationProgress * (3 - 2 * animationProgress)
          const column = activeUnitAnimation.from.column + (activeUnitAnimation.to.column - activeUnitAnimation.from.column) * eased
          const row = activeUnitAnimation.from.row + (activeUnitAnimation.to.row - activeUnitAnimation.from.row) * eased
          const x = mapOrigin.x + column * cellSize
          const y = mapOrigin.y + row * cellSize - Math.sin(Math.PI * eased) * cellSize * .08
          context.save()
          context.globalAlpha = .24 * Math.sin(Math.PI * eased)
          context.fillStyle = '#050806'
          context.beginPath(); context.ellipse(x + cellSize * .5, y + cellSize * .82, cellSize * .25, cellSize * .08, 0, 0, Math.PI * 2); context.fill()
          context.restore()
          drawSquad(x, y, cellSize, movingObject.units, color)
        }
      }

      if (current.mode === 'playing' && current.visibility) {
        context.save()
        const fogEdgeCells: CellPosition[] = []
        context.beginPath()
        for (let row = firstRow; row < lastRow; row += 1) {
          for (let column = firstColumn; column < lastColumn; column += 1) {
            if (isCellVisible(current.visibility, { column, row })) continue
            const touchesVisibleCell = isCellVisible(current.visibility, { column: column - 1, row })
              || isCellVisible(current.visibility, { column: column + 1, row })
              || isCellVisible(current.visibility, { column, row: row - 1 })
              || isCellVisible(current.visibility, { column, row: row + 1 })
            if (touchesVisibleCell) {
              fogEdgeCells.push({ column, row })
              continue
            }
            context.rect(mapOrigin.x + column * cellSize, mapOrigin.y + row * cellSize, Math.ceil(cellSize), Math.ceil(cellSize))
          }
        }
        context.fillStyle = `rgba(5, 10, 7, ${gameConfig.visibility.fogAlpha})`
        context.fill()
        context.beginPath()
        fogEdgeCells.forEach(({ column, row }) => context.rect(mapOrigin.x + column * cellSize, mapOrigin.y + row * cellSize, Math.ceil(cellSize), Math.ceil(cellSize)))
        context.fillStyle = `rgba(5, 10, 7, ${gameConfig.visibility.fogEdgeAlpha})`
        context.fill()
        context.restore()
      }

      if (current.movementSource) {
        const source = map[current.movementSource.row]?.[current.movementSource.column]?.object
        if (source?.type === 'squad') {
          const sourceSize = Object.values(source.units).reduce((sum, amount) => sum + amount, 0)
          const directions = [
            { dx: 1, dy: 0, glyph: '→' },
            { dx: -1, dy: 0, glyph: '←' },
            { dx: 0, dy: 1, glyph: '↓' },
            { dx: 0, dy: -1, glyph: '↑' },
          ]
          const drawOrderMarker = (column: number, row: number, kind: 'move' | 'merge' | 'attack', glyph: string) => {
            const color = kind === 'attack' ? '#c97060' : kind === 'merge' ? '#78aa8d' : '#d6b85e'
            const x = mapOrigin.x + column * cellSize
            const y = mapOrigin.y + row * cellSize
            context.save()
            context.fillStyle = kind === 'attack' ? 'rgba(176, 72, 58, .2)' : kind === 'merge' ? 'rgba(78, 137, 105, .18)' : 'rgba(211, 180, 89, .16)'
            context.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2)
            context.strokeStyle = color
            context.lineWidth = Math.max(1.5, Math.min(2.5, camera.zoom * 2))
            context.setLineDash([Math.max(3, cellSize * .12), Math.max(2, cellSize * .07)])
            context.strokeRect(x + 3, y + 3, Math.max(0, cellSize - 6), Math.max(0, cellSize - 6))
            context.setLineDash([])
            const badgeX = x + cellSize * .76
            const badgeY = y + cellSize * .24
            context.fillStyle = color
            context.beginPath(); context.arc(badgeX, badgeY, Math.max(7, cellSize * .13), 0, Math.PI * 2); context.fill()
            context.fillStyle = '#172019'
            context.font = `800 ${Math.max(10, cellSize * .2)}px system-ui`
            context.textAlign = 'center'; context.textBaseline = 'middle'
            context.fillText(kind === 'merge' ? '+' : kind === 'attack' ? '×' : glyph, badgeX, badgeY)
            context.restore()
          }
          directions.forEach(({ dx, dy, glyph }) => {
            const column = current.movementSource!.column + dx
            const row = current.movementSource!.row + dy
            const cell = map[row]?.[column]
            if (!cell || cell.landform === 'peak') return
            const target = current.viewerId
              ? visibleObjectAt(map, current.visibility, current.viewerId, { column, row })
              : cell.object
            let kind: 'move' | 'merge' | 'attack' | null = null
            if (!target && (current.movementOrdersRemaining ?? 0) >= squadMovementOrderCost(source, cell)) kind = 'move'
            else if (target && (!current.participants || areOwnersHostile(current.participants, source.ownerId, target.ownerId))
              && (current.movementOrdersRemaining ?? 0) >= gameConfig.turn.movementOrderCost) kind = 'attack'
            else if (target?.type === 'squad' && (current.movementOrdersRemaining ?? 0) >= gameConfig.turn.squadReorganizationOrderCost && sourceSize + Object.values(target.units).reduce((sum, amount) => sum + amount, 0) <= gameConfig.turn.squadCapacity) kind = 'merge'
            if (!kind) return
            drawOrderMarker(column, row, kind, glyph)
          })
          directions.forEach(({ dx, dy, glyph }) => {
            const landing = { column: current.movementSource!.column + dx * 2, row: current.movementSource!.row + dy * 2 }
            const cost = squadMovementOrderCostBetween(map, source, current.movementSource!, landing)
            if (cost === null || (current.movementOrdersRemaining ?? 0) < cost) return
            drawOrderMarker(landing.column, landing.row, 'move', glyph)
          })
          if ((source.units.archers ?? 0) > 0 && (current.movementOrdersRemaining ?? 0) >= combatRules.ranged.orderCost) {
            directions.forEach(({ dx, dy }) => {
              for (let distance = 1; distance <= gameConfig.turn.archerRange; distance += 1) {
                const column = current.movementSource!.column + dx * distance
                const row = current.movementSource!.row + dy * distance
                const cell = map[row]?.[column]
                if (!cell || cell.landform === 'peak') break
                const target = current.viewerId
                  ? visibleObjectAt(map, current.visibility, current.viewerId, { column, row })
                  : cell.object
                if (cell.vegetation && !target) break
                const x = mapOrigin.x + column * cellSize
                const y = mapOrigin.y + row * cellSize
                if (!target && distance >= gameConfig.turn.archerMinimumRange) {
                  context.save()
                  context.fillStyle = 'rgba(210, 183, 103, .42)'
                  context.beginPath(); context.arc(x + cellSize * .5, y + cellSize * .5, Math.max(1.5, cellSize * .035), 0, Math.PI * 2); context.fill()
                  context.restore()
                }
                if (target) {
                  if (distance >= gameConfig.turn.archerMinimumRange
                    && (!current.participants || areOwnersHostile(current.participants, source.ownerId, target.ownerId))) {
                    context.save()
                    context.fillStyle = 'rgba(176, 72, 58, .22)'; context.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2)
                    context.strokeStyle = '#d97860'; context.lineWidth = Math.max(1.5, Math.min(2.5, camera.zoom * 2)); context.setLineDash([3, 3]); context.strokeRect(x + 3, y + 3, Math.max(0, cellSize - 6), Math.max(0, cellSize - 6)); context.setLineDash([])
                    context.fillStyle = '#d97860'; context.beginPath(); context.arc(x + cellSize * .76, y + cellSize * .24, Math.max(7, cellSize * .13), 0, Math.PI * 2); context.fill()
                    context.fillStyle = '#172019'; context.font = `800 ${Math.max(10, cellSize * .17)}px system-ui`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText('◎', x + cellSize * .76, y + cellSize * .24)
                    context.restore()
                  }
                  break
                }
              }
            })
          }
        }
      }

      const ghostCell = current.castleDraft ?? (current.mode === 'founding' ? hoveredCell : null)
      if (ghostCell && current.selectedRegionId && current.territories) {
        const valid = isCastleSiteValid({ cells: map, territories: current.territories }, current.selectedRegionId, ghostCell)
        drawCastle(context, mapOrigin.x + ghostCell.column * cellSize, mapOrigin.y + ghostCell.row * cellSize, cellSize, valid ? '#d2b45f' : '#a65347', true)
      }

      if (hoveredCell && current.actionPreview) {
        const valid = current.isActionCellValid?.(hoveredCell) ?? false
        const x = mapOrigin.x + hoveredCell.column * cellSize
        const y = mapOrigin.y + hoveredCell.row * cellSize
        const footprint = current.actionPreview.kind === 'building' ? buildingRules[current.actionPreview.building].footprint ?? { columns: 1, rows: 1 } : { columns: 1, rows: 1 }
        const previewWidth = cellSize * footprint.columns
        const previewHeight = cellSize * footprint.rows
        if (current.actionPreview.kind === 'building' && current.actionPreview.building === 'mill') {
          const support = buildingRules.mill.farmSupport!
          const viewerRegionId = current.participants?.find((participant) => participant.id === current.viewerId)?.regionId
          context.save()
          for (let rowOffset = -support.radius; rowOffset <= support.radius; rowOffset += 1) {
            for (let columnOffset = -support.radius; columnOffset <= support.radius; columnOffset += 1) {
              if (Math.abs(columnOffset) + Math.abs(rowOffset) > support.radius) continue
              context.fillStyle = 'rgba(211, 180, 89, .07)'
              context.fillRect(x + columnOffset * cellSize, y + rowOffset * cellSize, cellSize, cellSize)
            }
          }
          const farmFootprint = buildingRules.farm.footprint!
          for (let farmRow = hoveredCell.row - support.radius - farmFootprint.rows + 1; farmRow <= hoveredCell.row + support.radius; farmRow += 1) {
            for (let farmColumn = hoveredCell.column - support.radius - farmFootprint.columns + 1; farmColumn <= hoveredCell.column + support.radius; farmColumn += 1) {
              const positions = Array.from({ length: farmFootprint.rows }, (_, rowOffset) => Array.from({ length: farmFootprint.columns }, (_, columnOffset) => ({ column: farmColumn + columnOffset, row: farmRow + rowOffset }))).flat()
              const overlapsMill = positions.some((position) => position.column === hoveredCell!.column && position.row === hoveredCell!.row)
              const suitable = !overlapsMill && positions.every((position) => {
                const cell = map[position.row]?.[position.column]
                return Boolean(cell
                  && cell.landform === 'plain'
                  && !cell.vegetation
                  && !cell.object
                  && (!viewerRegionId || current.territories?.[position.row]?.[position.column] === viewerRegionId))
              })
              const distance = Math.min(...positions.map((position) => Math.abs(position.column - hoveredCell!.column) + Math.abs(position.row - hoveredCell!.row)))
              if (!suitable || distance > support.radius) continue
              context.strokeStyle = 'rgba(151, 190, 116, .72)'; context.lineWidth = Math.max(1, camera.zoom * 1.2); context.setLineDash([4, 3])
              context.strokeRect(mapOrigin.x + farmColumn * cellSize + 2, mapOrigin.y + farmRow * cellSize + 2, cellSize * farmFootprint.columns - 4, cellSize * farmFootprint.rows - 4)
            }
          }
          context.setLineDash([]); context.restore()
        }
        context.fillStyle = valid ? 'rgba(211, 180, 89, .16)' : 'rgba(174, 72, 61, .18)'
        context.fillRect(x, y, previewWidth, previewHeight)
        if (current.actionPreview.kind === 'building') drawBuilding(context, x, y, Math.max(previewWidth, previewHeight), current.actionPreview.building, valid ? '#d2b45f' : '#b45f51', true)
        else if (current.actionPreview.kind === 'squad') drawSquad(x, y, cellSize, current.actionPreview.units, valid ? '#d2b45f' : '#b45f51', true)
      }

      if (current.selectedCell) {
        const selectedObject = map[current.selectedCell.row]?.[current.selectedCell.column]?.object
        const selectedObjectVisible = !selectedObject || !current.viewerId || isObjectVisible(map, current.visibility, current.viewerId, current.selectedCell)
        if (selectedObjectVisible) {
          const footprint = selectedObject?.type === 'building' ? selectedObject.footprint : undefined
          const selectedColumn = footprint?.originColumn ?? current.selectedCell.column
          const selectedRow = footprint?.originRow ?? current.selectedCell.row
          const selectedWidth = cellSize * (footprint?.columns ?? 1)
          const selectedHeight = cellSize * (footprint?.rows ?? 1)
          const x = mapOrigin.x + selectedColumn * cellSize
          const y = mapOrigin.y + selectedRow * cellSize
          context.strokeStyle = '#f0cf71'; context.lineWidth = Math.max(2, Math.min(3, camera.zoom * 2.2))
          context.strokeRect(x + 2, y + 2, Math.max(0, selectedWidth - 4), Math.max(0, selectedHeight - 4))
        }
      }

      if (hoveredCell) {
        const x = mapOrigin.x + hoveredCell.column * cellSize
        const y = mapOrigin.y + hoveredCell.row * cellSize
        const footprint = current.actionPreview?.kind === 'building' ? buildingRules[current.actionPreview.building].footprint ?? { columns: 1, rows: 1 } : { columns: 1, rows: 1 }
        const hoverWidth = cellSize * footprint.columns
        const hoverHeight = cellSize * footprint.rows
        context.fillStyle = HOVER_COLOR; context.fillRect(x, y, hoverWidth, hoverHeight)
        context.strokeStyle = BORDER_COLOR; context.lineWidth = 1.5; context.strokeRect(x + 0.75, y + 0.75, hoverWidth - 1.5, hoverHeight - 1.5)
      }
      if (decorativeBorderCells === 0) {
        context.strokeStyle = BORDER_COLOR; context.lineWidth = 1
        context.strokeRect(Math.round(mapOrigin.x) + 0.5, Math.round(mapOrigin.y) + 0.5, Math.round(mapWidth), Math.round(mapHeight))
      }
      if (activeUnitAnimation) requestDraw()
    }

    const pointFromEvent = (event: MouseEvent): Point => {
      const bounds = canvas.getBoundingClientRect()
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    }
    const updateHoveredCell = (point: Point) => {
      const worldPoint = screenToWorld(point, camera, viewport)
      const column = Math.floor((worldPoint.x - mapOffset) / CELL_SIZE)
      const row = Math.floor((worldPoint.y - mapOffset) / CELL_SIZE)
      hoveredCell = column >= 0 && column < columns && row >= 0 && row < rows ? { column, row } : null
    }
    const requestForEvent = (event: PointerEvent | MouseEvent) => {
      const point = pointFromEvent(event)
      const worldPoint = screenToWorld(point, camera, viewport)
      const column = Math.floor((worldPoint.x - mapOffset) / CELL_SIZE)
      const row = Math.floor((worldPoint.y - mapOffset) / CELL_SIZE)
      if (column < 0 || column >= columns || row < 0 || row >= rows) return null
      return { clientX: event.clientX, clientY: event.clientY, column, row }
    }
    const reportHoveredObject = (event: PointerEvent | MouseEvent) => {
      const current = propsRef.current
      const request = requestForEvent(event)
      const mapObject = request
        ? current.viewerId
          ? visibleObjectAt(current.map, current.visibility, current.viewerId, request)
          : current.map[request.row]?.[request.column]?.object
        : undefined
      const object = mapObject?.type === 'castle'
        ? { type: 'castle' as const }
        : mapObject?.type === 'building'
          ? { type: 'building' as const, kind: mapObject.kind }
          : mapObject?.type === 'squad'
            ? { type: 'squad' as const }
            : null
      const ownedByViewer = Boolean(current.viewerId && mapObject?.ownerId === current.viewerId)
      const origin = mapObject?.type === 'building' ? mapObject.footprint : undefined
      const objectKey = request && mapObject && object && !ownedByViewer
        ? `${mapObject.ownerId}:${object.type}:${object.type === 'building' ? object.kind : ''}:${origin?.originColumn ?? request.column}:${origin?.originRow ?? request.row}`
        : null
      const hoverHandler = current.onObjectHover
      if (!hoverHandler) {
        reportedObjectKey = null
        reportedObjectHandler = undefined
        return
      }
      if (objectKey === reportedObjectKey && hoverHandler === reportedObjectHandler) return
      reportedObjectKey = objectKey
      reportedObjectHandler = hoverHandler
      if (objectKey && request && mapObject && object) hoverHandler({ ...request, ownerId: mapObject.ownerId, object })
      else hoverHandler(null)
    }
    const clearHoveredObject = () => {
      if (reportedObjectKey === null) return
      reportedObjectKey = null
      reportedObjectHandler = undefined
      propsRef.current.onObjectHover?.(null)
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
          dragged = true; overviewActive = false; clearHoveredObject(); propsRef.current.onNavigate('move')
        }
        if (dragged) {
          camera = clampCamera({ x: camera.x - (point.x - lastPointer.x) / camera.zoom, y: camera.y - (point.y - lastPointer.y) / camera.zoom, zoom: camera.zoom }, viewport, world, sessionMinimumZoom, cameraEdgePadding)
        }
        lastPointer = point
      }
      updateHoveredCell(point)
      if (!dragged) reportHoveredObject(event)
      requestDraw()
    }
    const onMouseMove = (event: MouseEvent) => {
      if (activePointerId !== null) return
      updateHoveredCell(pointFromEvent(event))
      reportHoveredObject(event)
      requestDraw()
    }
    const stopDragging = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId) return
      const request = event.type === 'pointerup' && event.button === 0 && !dragged ? requestForEvent(event) : null
      activePointerId = null; lastPointer = null; pointerStart = null; delete canvas.dataset.dragging
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (request) propsRef.current.onMapClick(request)
    }
    const onPointerLeave = () => { if (activePointerId === null) { hoveredCell = null; clearHoveredObject(); requestDraw() } }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = pointFromEvent(event)
      camera = zoomAtPoint(camera, point, camera.zoom * Math.exp(-event.deltaY * gameConfig.camera.wheelSensitivity), viewport, world, sessionMinimumZoom, cameraEdgePadding)
      overviewActive = false
      clearHoveredObject(); propsRef.current.onNavigate('zoom'); updateHoveredCell(point); requestDraw()
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
      } else camera = clampCamera(camera, viewport, world, sessionMinimumZoom, cameraEdgePadding)
      requestDraw()
    })

    canvas.addEventListener('pointerdown', onPointerDown); canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('pointerup', stopDragging); canvas.addEventListener('pointercancel', stopDragging); canvas.addEventListener('lostpointercapture', stopDragging)
    canvas.addEventListener('pointerleave', onPointerLeave); canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('contextmenu', onContextMenu)
    resizeObserver.observe(canvas)
    return () => {
      resizeObserver.disconnect(); clearHoveredObject(); requestDrawRef.current = () => undefined; focusRef.current = () => undefined; cellClientPointRef.current = () => null
      canvas.removeEventListener('pointerdown', onPointerDown); canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('pointerup', stopDragging); canvas.removeEventListener('pointercancel', stopDragging); canvas.removeEventListener('lostpointercapture', stopDragging)
      canvas.removeEventListener('pointerleave', onPointerLeave); canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('contextmenu', onContextMenu)
      if (animationFrame !== null) cancelAnimationFrame(animationFrame)
    }
  }, [hasDecorativeBorder, mapColumns, mapRows])

  return <canvas ref={canvasRef} className={`grid-canvas${props.territoryInspecting ? ' territory-inspecting' : ''}`} aria-label={props.ariaLabel} />
}
