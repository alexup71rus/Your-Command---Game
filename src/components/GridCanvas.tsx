import { useEffect, useRef } from 'react'
import { gameConfig } from '../config/game'
import { buildingRules, troopKinds } from '../config/rules'
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
import { maxSquadHealth, squadHealth } from '../game/match'
import { squadMovementOrderCost, squadMovementOrderCostBetween } from '../game/movement'
import { isCastleSiteValid, type CellPosition, type MatchParticipant, type StartRegion, type TerritoryMap } from '../game/scenario'
import { isCellVisible, isObjectVisible, visibleObjectAt, type VisibilityMap } from '../game/visibility'

const CELL_SIZE = gameConfig.map.cellSize

interface GridCanvasProps {
  map: GameMap
  territories?: TerritoryMap
  regions?: StartRegion[]
  participants?: MatchParticipant[]
  showTerritories?: boolean
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
  useEffect(() => requestDrawRef.current(), [props.map, props.showTerritories, props.selectedRegionId, props.castleDraft, props.regions, props.territories, props.participants, props.selectedCell, props.movementSource, props.movementPath, props.movementOrdersRemaining, props.unitAnimation, props.visibility, props.viewerId, props.actionPreview])
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
      context.shadowColor = ghost ? 'transparent' : 'rgba(0, 0, 0, .35)'
      context.shadowBlur = size * .08
      context.shadowOffsetY = size * .05
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
      context.shadowColor = 'transparent'
      context.fillStyle = ghost ? 'rgba(12,16,13,.35)' : '#242a22'
      context.fillRect(x + size * 0.44, y + size * 0.57, size * 0.12, size * 0.23)
      if (!ghost) {
        context.fillStyle = '#e8d79e'
        context.fillRect(x + size * .27, y + size * .47, size * .055, size * .12)
        context.fillRect(x + size * .675, y + size * .47, size * .055, size * .12)
        context.strokeStyle = '#d8b75e'; context.lineWidth = Math.max(1, size * .025)
        context.beginPath(); context.moveTo(x + size * .29, y + size * .18); context.lineTo(x + size * .29, y + size * .06); context.lineTo(x + size * .42, y + size * .1); context.lineTo(x + size * .29, y + size * .13); context.stroke()
      }
      context.restore()
    }

    const drawBuilding = (x: number, y: number, size: number, kind: BuildingKind, color: string, ghost = false) => {
      const inset = size * 0.16
      const roofColors: Record<BuildingKind, string> = { farm: '#a77b47', huntingLodge: '#72543b', lumberMill: '#6e5035', quarry: '#89877b', mine: '#696b63', smelter: '#6f584a', kitchen: '#8b6043', house: '#9b6548', barracks: '#7f5544', church: '#7f684d', market: '#a06f3f', wall: '#8e8a77', tower: '#817b6b', barbican: '#777263' }
      context.save()
      context.globalAlpha = ghost ? 0.68 : 1
      context.shadowColor = ghost ? 'transparent' : 'rgba(0, 0, 0, .32)'
      context.shadowBlur = size * .065
      context.shadowOffsetY = size * .045
      context.fillStyle = ghost ? color : '#c2b083'
      context.strokeStyle = color
      context.lineWidth = Math.max(1, size * 0.045)
      if (kind === 'farm') {
        const border = size * .055
        context.shadowBlur = ghost ? 0 : size * .04
        context.fillStyle = ghost ? color : '#6f5a35'
        context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
        context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
        context.shadowColor = 'transparent'
        context.fillStyle = ghost ? 'rgba(24, 31, 24, .26)' : '#493f28'
        context.fillRect(x + size * .11, y + size * .12, size * .49, size * .7)
        context.strokeStyle = ghost ? 'rgba(24, 31, 24, .52)' : '#c4a554'
        context.lineWidth = Math.max(1, size * .014)
        for (let row = 0; row < 6; row += 1) {
          const cropY = y + size * (.17 + row * .105)
          context.beginPath(); context.moveTo(x + size * .14, cropY); context.lineTo(x + size * .57, cropY); context.stroke()
          for (let plant = 0; plant < 5; plant += 1) {
            const plantX = x + size * (.17 + plant * .085)
            context.beginPath(); context.moveTo(plantX, cropY - size * .024); context.lineTo(plantX, cropY + size * .024); context.stroke()
          }
        }
        context.fillStyle = ghost ? color : '#c1ad7d'
        context.strokeStyle = color
        context.lineWidth = Math.max(1, size * .02)
        context.fillRect(x + size * .66, y + size * .5, size * .23, size * .27)
        context.strokeRect(x + size * .66, y + size * .5, size * .23, size * .27)
        context.fillStyle = ghost ? color : '#925f3d'
        context.beginPath(); context.moveTo(x + size * .62, y + size * .51); context.lineTo(x + size * .775, y + size * .36); context.lineTo(x + size * .93, y + size * .51); context.closePath(); context.fill(); context.stroke()
        context.fillStyle = ghost ? 'rgba(24,31,24,.3)' : '#3c3528'
        context.fillRect(x + size * .745, y + size * .61, size * .06, size * .16)
        context.strokeStyle = ghost ? color : '#d1b968'
        context.lineWidth = Math.max(1, size * .012)
        context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
        for (const [postX, postY] of [[.055,.055],[.5,.055],[.945,.055],[.055,.5],[.945,.5],[.055,.945],[.5,.945],[.945,.945]]) context.fillRect(x + size * (postX - .01), y + size * (postY - .01), size * .02, size * .02)
        context.restore()
        return
      }
      if (kind === 'quarry') {
        const border = size * .055
        context.fillStyle = ghost ? color : '#53584f'
        context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
        context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
        context.shadowColor = 'transparent'
        context.fillStyle = ghost ? 'rgba(24,31,24,.28)' : '#77786e'
        context.beginPath()
        context.moveTo(x + size * .1, y + size * .24)
        context.lineTo(x + size * .53, y + size * .1)
        context.lineTo(x + size * .88, y + size * .28)
        context.lineTo(x + size * .79, y + size * .79)
        context.lineTo(x + size * .25, y + size * .88)
        context.lineTo(x + size * .1, y + size * .57)
        context.closePath(); context.fill(); context.stroke()
        context.fillStyle = ghost ? 'rgba(24,31,24,.24)' : '#5e6059'
        context.beginPath(); context.ellipse(x + size * .48, y + size * .53, size * .29, size * .21, -.16, 0, Math.PI * 2); context.fill(); context.stroke()
        context.fillStyle = ghost ? 'rgba(24,31,24,.2)' : '#454a45'
        context.beginPath(); context.ellipse(x + size * .49, y + size * .56, size * .18, size * .12, -.16, 0, Math.PI * 2); context.fill()
        context.strokeStyle = ghost ? color : '#aaa99d'
        context.lineWidth = Math.max(1, size * .014)
        for (let ledge = 0; ledge < 3; ledge += 1) {
          context.beginPath(); context.arc(x + size * .49, y + size * .55, size * (.14 + ledge * .075), .2, Math.PI * 1.63); context.stroke()
        }
        context.fillStyle = ghost ? color : '#898b80'
        for (const [stoneX, stoneY, radius] of [[.2,.35,.045],[.28,.73,.055],[.68,.33,.06],[.72,.69,.04],[.83,.49,.05]] as const) {
          context.beginPath(); context.arc(x + size * stoneX, y + size * stoneY, size * radius, 0, Math.PI * 2); context.fill(); context.stroke()
        }
        context.strokeStyle = ghost ? color : '#c7ad67'
        context.lineWidth = Math.max(1, size * .018)
        context.beginPath(); context.moveTo(x + size * .73, y + size * .2); context.lineTo(x + size * .73, y + size * .62); context.moveTo(x + size * .63, y + size * .62); context.lineTo(x + size * .73, y + size * .2); context.lineTo(x + size * .83, y + size * .62); context.moveTo(x + size * .7, y + size * .31); context.lineTo(x + size * .86, y + size * .31); context.stroke()
        context.fillStyle = ghost ? color : '#725743'
        context.fillRect(x + size * .82, y + size * .29, size * .09, size * .08)
        context.restore()
        return
      }
      if (kind === 'mine') {
        context.fillStyle = ghost ? color : '#65675f'
        context.beginPath()
        context.moveTo(x + size * .08, y + size * .76)
        context.lineTo(x + size * .14, y + size * .34)
        context.lineTo(x + size * .36, y + size * .12)
        context.lineTo(x + size * .68, y + size * .18)
        context.lineTo(x + size * .89, y + size * .48)
        context.lineTo(x + size * .92, y + size * .78)
        context.closePath(); context.fill(); context.stroke()
        context.shadowColor = 'transparent'
        context.fillStyle = ghost ? 'rgba(24,31,24,.3)' : '#242824'
        context.beginPath(); context.arc(x + size * .5, y + size * .62, size * .2, Math.PI, 0); context.lineTo(x + size * .7, y + size * .83); context.lineTo(x + size * .3, y + size * .83); context.closePath(); context.fill()
        context.strokeStyle = ghost ? color : '#ad8954'
        context.lineWidth = Math.max(1, size * .055)
        context.beginPath(); context.moveTo(x + size * .29, y + size * .84); context.lineTo(x + size * .29, y + size * .6); context.arc(x + size * .5, y + size * .6, size * .21, Math.PI, 0); context.lineTo(x + size * .71, y + size * .84); context.stroke()
        context.lineWidth = Math.max(1, size * .035)
        context.beginPath(); context.moveTo(x + size * .24, y + size * .52); context.lineTo(x + size * .76, y + size * .52); context.stroke()
        context.strokeStyle = ghost ? color : '#c1a966'
        context.lineWidth = Math.max(1, size * .025)
        context.beginPath(); context.moveTo(x + size * .39, y + size * .84); context.lineTo(x + size * .46, y + size * .6); context.moveTo(x + size * .61, y + size * .84); context.lineTo(x + size * .54, y + size * .6); context.stroke()
        for (let sleeper = 0; sleeper < 3; sleeper += 1) {
          const sleeperY = y + size * (.67 + sleeper * .075)
          const halfWidth = size * (.045 + sleeper * .027)
          context.beginPath(); context.moveTo(x + size * .5 - halfWidth, sleeperY); context.lineTo(x + size * .5 + halfWidth, sleeperY); context.stroke()
        }
        context.fillStyle = ghost ? color : '#8d8170'
        for (const [stoneX, stoneY, radius] of [[.19,.72,.055],[.79,.71,.045],[.75,.35,.04]] as const) {
          context.beginPath(); context.arc(x + size * stoneX, y + size * stoneY, size * radius, 0, Math.PI * 2); context.fill(); context.stroke()
        }
        context.restore()
        return
      }
      if (kind === 'smelter') {
        const border = size * .055
        context.fillStyle = ghost ? color : '#51483d'
        context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
        context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
        context.shadowColor = 'transparent'
        context.fillStyle = ghost ? color : '#a58e69'
        context.fillRect(x + size * .17, y + size * .43, size * .54, size * .36)
        context.strokeRect(x + size * .17, y + size * .43, size * .54, size * .36)
        context.fillStyle = ghost ? color : '#6d5542'
        context.fillRect(x + size * .58, y + size * .17, size * .15, size * .45)
        context.strokeRect(x + size * .58, y + size * .17, size * .15, size * .45)
        context.fillStyle = ghost ? 'rgba(42,31,26,.35)' : '#2d2925'
        context.beginPath(); context.arc(x + size * .39, y + size * .67, size * .13, Math.PI, 0); context.lineTo(x + size * .52, y + size * .77); context.lineTo(x + size * .26, y + size * .77); context.closePath(); context.fill()
        context.fillStyle = ghost ? color : '#d0783f'
        context.beginPath(); context.arc(x + size * .39, y + size * .7, size * .065, Math.PI, 0); context.fill()
        context.strokeStyle = ghost ? color : '#c8a65d'
        context.lineWidth = Math.max(1, size * .025)
        context.beginPath(); context.moveTo(x + size * .77, y + size * .58); context.lineTo(x + size * .9, y + size * .58); context.lineTo(x + size * .86, y + size * .78); context.lineTo(x + size * .73, y + size * .78); context.closePath(); context.stroke()
        context.fillStyle = ghost ? color : '#696c68'
        context.beginPath(); context.arc(x + size * .79, y + size * .7, size * .055, 0, Math.PI * 2); context.fill(); context.stroke()
        context.restore()
        return
      }
      if (kind === 'kitchen') {
        context.fillStyle = ghost ? color : '#b5a378'
        context.fillRect(x + size * .16, y + size * .38, size * .68, size * .46)
        context.strokeRect(x + size * .16, y + size * .38, size * .68, size * .46)
        context.fillStyle = ghost ? color : '#8b6043'
        context.beginPath(); context.moveTo(x + size * .1, y + size * .4); context.lineTo(x + size * .5, y + size * .14); context.lineTo(x + size * .9, y + size * .4); context.closePath(); context.fill(); context.stroke()
        context.fillStyle = ghost ? color : '#756352'
        context.fillRect(x + size * .66, y + size * .14, size * .12, size * .32)
        context.strokeRect(x + size * .66, y + size * .14, size * .12, size * .32)
        context.shadowColor = 'transparent'
        context.fillStyle = ghost ? 'rgba(30,35,28,.28)' : '#433a31'
        context.fillRect(x + size * .28, y + size * .57, size * .16, size * .27)
        context.fillStyle = ghost ? color : '#d8b55e'
        context.beginPath(); context.arc(x + size * .62, y + size * .64, size * .105, 0, Math.PI); context.lineTo(x + size * .515, y + size * .64); context.closePath(); context.fill(); context.stroke()
        context.strokeStyle = ghost ? color : '#d18a4f'
        context.lineWidth = Math.max(1, size * .02)
        context.beginPath(); context.moveTo(x + size * .58, y + size * .61); context.quadraticCurveTo(x + size * .55, y + size * .52, x + size * .59, y + size * .48); context.moveTo(x + size * .66, y + size * .61); context.quadraticCurveTo(x + size * .7, y + size * .52, x + size * .66, y + size * .46); context.stroke()
        context.restore()
        return
      }
      if (kind === 'barracks') {
        const border = size * .055
        context.fillStyle = ghost ? color : '#5b5542'
        context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
        context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
        context.shadowColor = 'transparent'
        context.fillStyle = ghost ? 'rgba(24,31,24,.28)' : '#35372e'
        context.fillRect(x + size * .12, y + size * .48, size * .5, size * .33)
        context.strokeRect(x + size * .12, y + size * .48, size * .5, size * .33)
        context.fillStyle = ghost ? color : '#784e3d'
        context.beginPath(); context.moveTo(x + size * .08, y + size * .49); context.lineTo(x + size * .37, y + size * .29); context.lineTo(x + size * .66, y + size * .49); context.closePath(); context.fill(); context.stroke()
        context.fillStyle = ghost ? 'rgba(24,31,24,.3)' : '#252b26'
        context.fillRect(x + size * .31, y + size * .64, size * .12, size * .17)
        context.strokeStyle = ghost ? color : '#ddc373'
        context.lineWidth = Math.max(1, size * .018)
        context.beginPath(); context.moveTo(x + size * .71, y + size * .28); context.lineTo(x + size * .86, y + size * .69); context.moveTo(x + size * .86, y + size * .28); context.lineTo(x + size * .71, y + size * .69); context.stroke()
        for (let index = 0; index < 3; index += 1) {
          const dummyX = x + size * (.7 + index * .085)
          context.fillStyle = ghost ? color : '#bda760'
          context.beginPath(); context.arc(dummyX, y + size * .73, size * .025, 0, Math.PI * 2); context.fill()
          context.fillRect(dummyX - size * .009, y + size * .75, size * .018, size * .1)
        }
        context.strokeStyle = ghost ? color : '#d9bb63'
        context.beginPath(); context.moveTo(x + size * .18, y + size * .29); context.lineTo(x + size * .18, y + size * .13); context.lineTo(x + size * .34, y + size * .18); context.lineTo(x + size * .18, y + size * .22); context.stroke()
        context.restore()
        return
      }
      if (kind === 'church') {
        const border = size * .055
        context.fillStyle = ghost ? 'rgba(24,31,24,.24)' : '#4b4c40'
        context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
        context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
        context.shadowColor = 'transparent'
        context.fillStyle = ghost ? color : '#b9aa83'
        context.fillRect(x + size * .3, y + size * .34, size * .4, size * .48)
        context.fillRect(x + size * .18, y + size * .5, size * .64, size * .22)
        context.strokeRect(x + size * .3, y + size * .34, size * .4, size * .48)
        context.strokeRect(x + size * .18, y + size * .5, size * .64, size * .22)
        context.fillStyle = ghost ? color : '#765d49'
        context.beginPath(); context.moveTo(x + size * .24, y + size * .51); context.lineTo(x + size * .5, y + size * .26); context.lineTo(x + size * .76, y + size * .51); context.closePath(); context.fill(); context.stroke()
        context.fillStyle = ghost ? color : '#c4b58d'
        context.fillRect(x + size * .4, y + size * .18, size * .2, size * .27)
        context.strokeRect(x + size * .4, y + size * .18, size * .2, size * .27)
        context.fillStyle = ghost ? color : '#6f5747'
        context.beginPath(); context.moveTo(x + size * .37, y + size * .19); context.lineTo(x + size * .5, y + size * .08); context.lineTo(x + size * .63, y + size * .19); context.closePath(); context.fill(); context.stroke()
        context.fillStyle = ghost ? 'rgba(24,31,24,.3)' : '#32342e'
        context.beginPath(); context.arc(x + size * .5, y + size * .71, size * .065, Math.PI, 0); context.lineTo(x + size * .565, y + size * .82); context.lineTo(x + size * .435, y + size * .82); context.closePath(); context.fill()
        context.strokeStyle = ghost ? color : '#e1cc82'
        context.lineWidth = Math.max(1, size * .017)
        context.beginPath(); context.moveTo(x + size * .5, y + size * .08); context.lineTo(x + size * .5, y + size * .015); context.moveTo(x + size * .46, y + size * .045); context.lineTo(x + size * .54, y + size * .045); context.stroke()
        context.restore()
        return
      }
      if (kind === 'wall') {
        context.fillRect(x + size * 0.08, y + size * 0.43, size * 0.84, size * 0.34)
        context.strokeRect(x + size * 0.08, y + size * 0.43, size * 0.84, size * 0.34)
        for (let index = 0; index < 4; index += 1) context.fillRect(x + size * (0.1 + index * 0.22), y + size * 0.29, size * 0.13, size * 0.16)
        context.restore()
        return
      }
      if (kind === 'tower') {
        context.fillRect(x + size * 0.25, y + size * 0.28, size * 0.5, size * 0.55)
        context.strokeRect(x + size * 0.25, y + size * 0.28, size * 0.5, size * 0.55)
        for (let index = 0; index < 3; index += 1) context.fillRect(x + size * (0.25 + index * 0.2), y + size * 0.16, size * 0.1, size * 0.14)
        context.fillStyle = ghost ? 'rgba(12,16,13,.32)' : '#37352d'
        context.fillRect(x + size * 0.43, y + size * 0.58, size * 0.14, size * 0.25)
        context.restore()
        return
      }
      if (kind === 'barbican') {
        context.fillRect(x + size * 0.12, y + size * 0.3, size * 0.28, size * 0.54)
        context.fillRect(x + size * 0.6, y + size * 0.3, size * 0.28, size * 0.54)
        context.fillRect(x + size * 0.32, y + size * 0.42, size * 0.36, size * 0.42)
        context.strokeRect(x + size * 0.12, y + size * 0.3, size * 0.76, size * 0.54)
        context.fillStyle = ghost ? 'rgba(12,16,13,.32)' : '#37352d'
        context.beginPath(); context.arc(x + size * 0.5, y + size * 0.72, size * 0.12, Math.PI, 0); context.lineTo(x + size * 0.62, y + size * 0.84); context.lineTo(x + size * 0.38, y + size * 0.84); context.closePath(); context.fill()
        context.restore()
        return
      }
      context.fillRect(x + inset, y + size * 0.42, size - inset * 2, size * 0.38)
      context.strokeRect(x + inset, y + size * 0.42, size - inset * 2, size * 0.38)
      context.shadowColor = 'transparent'
      if (!ghost) { context.fillStyle = 'rgba(77, 62, 43, .22)'; context.fillRect(x + inset, y + size * .7, size - inset * 2, size * .1) }
      context.fillStyle = ghost ? color : roofColors[kind]
      context.beginPath()
      context.moveTo(x + size * 0.1, y + size * 0.44)
      context.lineTo(x + size * 0.5, y + size * 0.16)
      context.lineTo(x + size * 0.9, y + size * 0.44)
      context.closePath(); context.fill(); context.stroke()
      context.fillStyle = ghost ? 'rgba(12,16,13,.32)' : '#37352d'
      if (kind === 'lumberMill') { context.fillRect(x + size * 0.42, y + size * 0.5, size * 0.16, size * 0.3); context.strokeStyle = ghost ? color : '#d4c18c'; context.beginPath(); context.arc(x + size * 0.72, y + size * 0.68, size * 0.11, 0, Math.PI * 2); context.stroke(); for (let index = 0; index < 4; index += 1) { const angle = index * Math.PI / 2; context.beginPath(); context.moveTo(x + size * .72, y + size * .68); context.lineTo(x + size * (.72 + Math.cos(angle) * .1), y + size * (.68 + Math.sin(angle) * .1)); context.stroke() } }
      else if (kind === 'huntingLodge') { context.fillRect(x + size * .42, y + size * .57, size * .16, size * .23); context.strokeStyle = ghost ? color : '#d8bd72'; context.lineWidth = Math.max(1, size * .025); context.beginPath(); context.moveTo(x + size * .31, y + size * .6); context.quadraticCurveTo(x + size * .22, y + size * .52, x + size * .25, y + size * .41); context.moveTo(x + size * .31, y + size * .6); context.quadraticCurveTo(x + size * .4, y + size * .52, x + size * .37, y + size * .41); context.moveTo(x + size * .25, y + size * .45); context.lineTo(x + size * .2, y + size * .4); context.moveTo(x + size * .37, y + size * .45); context.lineTo(x + size * .42, y + size * .4); context.stroke(); context.fillStyle = ghost ? color : '#b99655'; context.beginPath(); context.arc(x + size * .31, y + size * .61, size * .035, 0, Math.PI * 2); context.fill() }
      else if (kind === 'market') { context.fillStyle = ghost ? color : '#d2a14c'; context.fillRect(x + size * 0.23, y + size * 0.53, size * 0.54, size * 0.11); context.fillStyle = ghost ? color : '#7e4c36'; for (let index = 0; index < 3; index += 1) context.fillRect(x + size * (.23 + index * .18), y + size * .53, size * .09, size * .11); context.strokeStyle = ghost ? color : '#dbc47b'; for (let index = 0; index < 3; index += 1) { context.beginPath(); context.moveTo(x + size * (0.28 + index * 0.2), y + size * 0.48); context.lineTo(x + size * (0.28 + index * 0.2), y + size * 0.75); context.stroke() } }
      else if (kind === 'house') { context.fillRect(x + size * .43, y + size * .57, size * .14, size * .23); context.fillStyle = ghost ? color : '#e0c982'; context.fillRect(x + size * .66, y + size * .55, size * .1, size * .1); context.fillStyle = ghost ? color : '#594332'; context.fillRect(x + size * .69, y + size * .22, size * .09, size * .2) }
      else context.fillRect(x + size * 0.43, y + size * 0.57, size * 0.14, size * 0.23)
      context.restore()
    }

    const drawSquad = (x: number, y: number, size: number, units: TroopComposition, color: string, ghost = false) => {
      context.save()
      context.globalAlpha = ghost ? 0.7 : 1
      context.fillStyle = ghost ? color : '#1a211b'
      context.strokeStyle = color
      context.lineWidth = Math.max(1.3, size * 0.055)
      context.beginPath()
      context.moveTo(x + size * 0.5, y + size * 0.14)
      context.lineTo(x + size * 0.78, y + size * 0.25)
      context.lineTo(x + size * 0.72, y + size * 0.65)
      context.quadraticCurveTo(x + size * 0.5, y + size * 0.88, x + size * 0.28, y + size * 0.65)
      context.lineTo(x + size * 0.22, y + size * 0.25)
      context.closePath(); context.fill(); context.stroke()
      const activeTroops = troopKinds.filter((kind) => (units[kind] ?? 0) > 0)
      const total = activeTroops.reduce((sum, kind) => sum + (units[kind] ?? 0), 0)
      context.textAlign = 'center'; context.textBaseline = 'middle'
      if (size < 25 || activeTroops.length === 0) {
        context.fillStyle = ghost ? '#192019' : '#ead99f'
        context.font = `700 ${Math.max(10, size * 0.27)}px system-ui`
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
        const badgeRadius = Math.max(2.4, radius * .52)
        const badgeX = centerX + radius * .72
        const badgeY = centerY + radius * .68
        context.fillStyle = ghost ? color : '#c5a950'
        context.beginPath(); context.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2); context.fill()
        context.fillStyle = '#172018'
        context.font = `800 ${Math.max(5.5, badgeRadius * 1.35)}px system-ui`
        context.fillText(String(units[kind] ?? 0), badgeX, badgeY + .2)
      })
      context.restore()
    }

    const draw = () => {
      animationFrame = null
      const current = propsRef.current
      const map = current.map
      if (current.unitAnimation && current.unitAnimation.key !== lastUnitAnimationKey) {
        lastUnitAnimationKey = current.unitAnimation.key
        activeUnitAnimation = reducedMotionQuery.matches ? null : { ...current.unitAnimation, startedAt: performance.now() }
      }
      if (activeUnitAnimation && reducedMotionQuery.matches) activeUnitAnimation = null
      const animationElapsed = activeUnitAnimation ? performance.now() - activeUnitAnimation.startedAt : gameConfig.camera.unitMoveAnimationMs
      const animationProgress = Math.min(1, animationElapsed / gameConfig.camera.unitMoveAnimationMs)
      if (activeUnitAnimation && animationProgress >= 1) activeUnitAnimation = null
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
          if (object.type === 'castle') drawCastle(x, y, cellSize, color)
          else if (object.type === 'building') drawBuilding(x, y, Math.max(objectWidth, objectHeight), object.kind, color)
          else drawSquad(x, y, cellSize, object.units, color)
          if (object.type === 'building' && object.kind === 'tower' && object.garrison && cellSize >= 22) {
            const centerX = x + cellSize * .75
            const centerY = y + cellSize * .25
            const radius = Math.max(7, cellSize * .15)
            context.save()
            context.fillStyle = '#1b241d'; context.strokeStyle = color; context.lineWidth = Math.max(1, cellSize * .025)
            context.beginPath(); context.arc(centerX, centerY, radius, 0, Math.PI * 2); context.fill(); context.stroke()
            context.strokeStyle = '#ead99f'; context.lineWidth = Math.max(1, radius * .14); context.lineCap = 'round'
            context.beginPath(); context.arc(centerX - radius * .18, centerY, radius * .46, -Math.PI * .5, Math.PI * .5); context.stroke()
            context.beginPath(); context.moveTo(centerX - radius * .18, centerY - radius * .46); context.lineTo(centerX + radius * .08, centerY); context.lineTo(centerX - radius * .18, centerY + radius * .46); context.moveTo(centerX - radius * .35, centerY); context.lineTo(centerX + radius * .42, centerY); context.stroke()
            context.fillStyle = '#c7aa51'; context.beginPath(); context.arc(centerX + radius * .68, centerY + radius * .65, radius * .48, 0, Math.PI * 2); context.fill()
            context.fillStyle = '#172018'; context.font = `800 ${Math.max(7, radius * .7)}px system-ui`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(object.garrison.archers), centerX + radius * .68, centerY + radius * .67)
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
            else if (target && target.ownerId !== source.ownerId && (current.movementOrdersRemaining ?? 0) >= gameConfig.turn.movementOrderCost) kind = 'attack'
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
          if ((source.units.archers ?? 0) > 0 && (current.movementOrdersRemaining ?? 0) >= gameConfig.turn.movementOrderCost) {
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
                if (!target && distance >= 2) {
                  context.save()
                  context.fillStyle = 'rgba(210, 183, 103, .42)'
                  context.beginPath(); context.arc(x + cellSize * .5, y + cellSize * .5, Math.max(1.5, cellSize * .035), 0, Math.PI * 2); context.fill()
                  context.restore()
                }
                if (target) {
                  if (distance >= 2 && target.ownerId !== source.ownerId) {
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
        drawCastle(mapOrigin.x + ghostCell.column * cellSize, mapOrigin.y + ghostCell.row * cellSize, cellSize, valid ? '#d2b45f' : '#a65347', true)
      }

      if (hoveredCell && current.actionPreview) {
        const valid = current.isActionCellValid?.(hoveredCell) ?? false
        const x = mapOrigin.x + hoveredCell.column * cellSize
        const y = mapOrigin.y + hoveredCell.row * cellSize
        const footprint = current.actionPreview.kind === 'building' ? buildingRules[current.actionPreview.building].footprint ?? { columns: 1, rows: 1 } : { columns: 1, rows: 1 }
        const previewWidth = cellSize * footprint.columns
        const previewHeight = cellSize * footprint.rows
        context.fillStyle = valid ? 'rgba(211, 180, 89, .16)' : 'rgba(174, 72, 61, .18)'
        context.fillRect(x, y, previewWidth, previewHeight)
        if (current.actionPreview.kind === 'building') drawBuilding(x, y, Math.max(previewWidth, previewHeight), current.actionPreview.building, valid ? '#d2b45f' : '#b45f51', true)
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
      context.strokeStyle = BORDER_COLOR; context.lineWidth = 1
      context.strokeRect(Math.round(mapOrigin.x) + 0.5, Math.round(mapOrigin.y) + 0.5, Math.round(mapWidth), Math.round(mapHeight))
      if (activeUnitAnimation) requestDraw()
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

  return <canvas ref={canvasRef} className={`grid-canvas${props.territoryInspecting ? ' territory-inspecting' : ''}`} aria-label={props.ariaLabel} />
}
