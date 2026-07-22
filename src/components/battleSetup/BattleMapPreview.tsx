import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { aiAvatarPaths } from '../../config/ai'
import type { GeneratorSettings, ManualHeightGrid } from '../../game/generator'
import type { MapScenario } from '../../game/scenario'
import { getPreviewMap, type BattleSeatPreview } from './battleMapPreviewModel'

interface BattleMapPreviewProps {
  cacheKey: string
  settings: GeneratorSettings
  manualGrid: ManualHeightGrid
  large?: boolean
  scenario?: MapScenario | null
  participants?: BattleSeatPreview[]
  playerMark?: string
  regionLabel?: string
  allianceLabel?: string
  selectedRegionIndex?: number | null
  draggingRegionIndex?: number | null
  onParticipantSelect?: (regionIndex: number) => void
  onParticipantDragStart?: (regionIndex: number) => void
  onParticipantDragEnd?: () => void
  onParticipantDrop?: (fromRegionIndex: number, toRegionIndex: number) => void
}

export function BattleMapPreview({
  cacheKey,
  settings,
  manualGrid,
  large = false,
  scenario,
  participants = [],
  playerMark,
  regionLabel,
  allianceLabel,
  selectedRegionIndex,
  draggingRegionIndex,
  onParticipantSelect,
  onParticipantDragStart,
  onParticipantDragEnd,
  onParticipantDrop,
}: BattleMapPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const map = getPreviewMap(cacheKey, settings, manualGrid)
    const rows = map.length
    const columns = map[0]?.length ?? 0
    const size = large ? 640 : 180
    canvas.width = size
    canvas.height = size
    const cellWidth = size / columns
    const cellHeight = size / rows
    map.forEach((row, y) =>
      row.forEach((cell, x) => {
        if (cell.landform === 'peak') context.fillStyle = '#8a887c'
        else if (cell.vegetation) context.fillStyle = cell.landform === 'hill' ? '#3c5539' : '#24452f'
        else if (cell.landform === 'hill') context.fillStyle = '#66664f'
        else context.fillStyle = (cell.elevation ?? 0) > 0.4 ? '#536348' : '#3d5541'
        context.fillRect(x * cellWidth, y * cellHeight, Math.ceil(cellWidth), Math.ceil(cellHeight))
      }),
    )
    if (!scenario) return
    const regionById = new Map(scenario.regions.map((region) => [region.id, region]))
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const regionId = scenario.territories[row]?.[column]
        const region = regionId ? regionById.get(regionId) : undefined
        if (!region) continue
        const x = column * cellWidth
        const y = row * cellHeight
        context.fillStyle = `${region.color}19`
        context.fillRect(x, y, Math.ceil(cellWidth), Math.ceil(cellHeight))
        context.strokeStyle = `${region.color}d8`
        context.lineWidth = 1.4
        if (scenario.territories[row - 1]?.[column] !== regionId) {
          context.beginPath()
          context.moveTo(x, y)
          context.lineTo(x + cellWidth, y)
          context.stroke()
        }
        if (scenario.territories[row + 1]?.[column] !== regionId) {
          context.beginPath()
          context.moveTo(x, y + cellHeight)
          context.lineTo(x + cellWidth, y + cellHeight)
          context.stroke()
        }
        if (scenario.territories[row]?.[column - 1] !== regionId) {
          context.beginPath()
          context.moveTo(x, y)
          context.lineTo(x, y + cellHeight)
          context.stroke()
        }
        if (scenario.territories[row]?.[column + 1] !== regionId) {
          context.beginPath()
          context.moveTo(x + cellWidth, y)
          context.lineTo(x + cellWidth, y + cellHeight)
          context.stroke()
        }
      }
    }
    if (participants.length === 0)
      scenario.regions.forEach((region) => {
        const x = (region.center.column + 0.5) * cellWidth
        const y = (region.center.row + 0.5) * cellHeight
        context.fillStyle = region.color
        context.beginPath()
        context.arc(x, y, 9, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = '#121712'
        context.font = '700 10px system-ui'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(String(region.index + 1), x, y + 0.5)
      })
  }, [cacheKey, large, manualGrid, participants, scenario, settings])

  const columns = scenario?.cells[0]?.length ?? 1
  const rows = scenario?.cells.length ?? 1
  const interactive = Boolean(onParticipantSelect && onParticipantDrop)
  return (
    <span className={`preset-map-preview${large ? ' large' : ''}`} aria-hidden={large ? undefined : 'true'}>
      <canvas ref={canvasRef} />
      {large && scenario && participants.length > 0 && (
        <span className="battle-map-markers">
          {scenario.regions.map((region) => {
            const participant = participants.find((candidate) => candidate.regionIndex === region.index)
            if (!participant) return null
            const markerStyle = {
              '--marker-x': `${((region.center.column + 0.5) / columns) * 100}%`,
              '--marker-y': `${((region.center.row + 0.5) / rows) * 100}%`,
              '--marker-color': region.color,
            } as CSSProperties
            const markerContent = (
              <span className="battle-map-marker-portrait">
                {participant.profileId ? (
                  <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[participant.profileId]}`} alt="" />
                ) : (
                  <b>{playerMark}</b>
                )}
                <i>{region.index + 1}</i>
              </span>
            )
            if (!interactive)
              return (
                <span
                  key={region.id}
                  className="battle-map-marker"
                  style={markerStyle}
                  title={`${participant.name} · ${allianceLabel} ${participant.teamId}`}
                >
                  {markerContent}
                </span>
              )
            return (
              <button
                key={region.id}
                type="button"
                draggable
                className={`battle-map-marker${participant.kind === 'player' ? ' player' : ''}${selectedRegionIndex === region.index ? ' selected' : ''}${draggingRegionIndex === region.index ? ' dragging' : ''}`}
                style={markerStyle}
                title={`${participant.name} · ${regionLabel} ${region.index + 1} · ${allianceLabel} ${participant.teamId}`}
                aria-label={`${participant.name}. ${regionLabel} ${region.index + 1}. ${allianceLabel} ${participant.teamId}`}
                aria-pressed={selectedRegionIndex === region.index}
                onClick={() => onParticipantSelect?.(region.index)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', String(region.index))
                  onParticipantDragStart?.(region.index)
                }}
                onDragEnd={onParticipantDragEnd}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const source = Number(event.dataTransfer.getData('text/plain'))
                  if (Number.isInteger(source)) onParticipantDrop?.(source, region.index)
                }}
              >
                {markerContent}
              </button>
            )
          })}
        </span>
      )}
    </span>
  )
}

export function MapChoice({
  name,
  selected,
  preview,
  onSelect,
  onDelete,
  deleteLabel,
}: {
  name: string
  selected: boolean
  preview: ReactNode
  onSelect: () => void
  onDelete?: () => void
  deleteLabel?: string
}) {
  return (
    <article className={`map-choice${selected ? ' selected' : ''}`}>
      <button type="button" className="map-choice-main" onClick={onSelect} aria-pressed={selected}>
        {preview}
        <span className="map-choice-copy">
          <strong>{name}</strong>
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          className="saved-map-delete danger"
          onClick={onDelete}
          aria-label={`${deleteLabel}: ${name}`}
          title={`${deleteLabel}: ${name}`}
        >
          ×
        </button>
      )}
    </article>
  )
}
