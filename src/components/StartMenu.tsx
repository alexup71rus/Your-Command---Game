import { useEffect, useRef } from 'react'
import type { LocaleDictionary } from '../config/localization'
import { gameConfig } from '../config/game'
import { createManualHeightGrid, generateMap } from '../game/generator'
import type { GameMap } from '../game/map'
import { mapPresets, type MapPreset, type PresetId } from '../game/presets'

const previewCache = new Map<PresetId, GameMap>()

function previewMapFor(preset: MapPreset) {
  const cached = previewCache.get(preset.id)
  if (cached) return cached
  const map = generateMap(preset.settings, createManualHeightGrid())
  previewCache.set(preset.id, map)
  return map
}

function PresetMapPreview({ preset }: { preset: MapPreset }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const map = previewMapFor(preset)
    const rows = map.length
    const columns = map[0]?.length ?? 0
    const size = 320
    canvas.width = size
    canvas.height = size
    const cellWidth = size / columns
    const cellHeight = size / rows
    map.forEach((row, y) => row.forEach((cell, x) => {
      if (cell.landform === 'peak') context.fillStyle = '#8a887c'
      else if (cell.vegetation) context.fillStyle = cell.landform === 'hill' ? '#3c5539' : '#24452f'
      else if (cell.landform === 'hill') context.fillStyle = '#66664f'
      else context.fillStyle = (cell.elevation ?? 0) > 0.4 ? '#536348' : '#3d5541'
      context.fillRect(x * cellWidth, y * cellHeight, Math.ceil(cellWidth), Math.ceil(cellHeight))
    }))
  }, [preset])

  return <span className="preset-map-preview" aria-hidden="true"><canvas ref={canvasRef} /></span>
}

interface StartMenuProps {
  text: LocaleDictionary['startMenu']
  selectedPreset: PresetId
  participantCount: number
  onPresetChange: (preset: PresetId) => void
  onParticipantChange: (count: number) => void
  onOpenGenerator: () => void
  onStart: () => void
  hasError: boolean
  isStarting: boolean
}

export function StartMenu({ text, selectedPreset, participantCount, onPresetChange, onParticipantChange, onOpenGenerator, onStart, hasError, isStarting }: StartMenuProps) {
  return (
    <main className="start-screen">
      <img
        className="start-hero-art"
        src="/assets/start-menu-hero.webp"
        alt=""
        aria-hidden="true"
        fetchPriority="high"
      />
      <div className="start-atmosphere" aria-hidden="true" />
      <section className="start-menu" aria-labelledby="start-title">
        <header className="start-header">
          <span>{text.eyebrow}</span>
          <h1 id="start-title">{text.title}</h1>
          <p>{text.description}</p>
        </header>

        <div className="start-section-heading"><span>01</span><h2>{text.chooseMap}</h2></div>
        <div className="preset-grid">
          {mapPresets.map((preset) => {
            const copy = text.presets[preset.id]
            return (
              <button key={preset.id} type="button" className={`preset-card preset-${preset.id}${selectedPreset === preset.id ? ' selected' : ''}`} onClick={() => onPresetChange(preset.id)}>
                <PresetMapPreview preset={preset} />
                <strong>{copy.name}</strong>
                <small>{copy.description}</small>
              </button>
            )
          })}
          <button type="button" className="preset-card custom-preset" onClick={onOpenGenerator}>
            <span className="custom-map-preview" aria-hidden="true"><i>+</i></span>
            <strong>{text.customMap}</strong>
            <small>{text.customMapDescription}</small>
            <em>{text.openGenerator}</em>
          </button>
        </div>

        <div className="start-options">
          <div>
            <div className="start-section-heading"><span>02</span><h2>{text.participants}</h2></div>
            <p>{text.participantDescription}</p>
          </div>
          <div className="participant-picker" role="group" aria-label={text.participants}>
            {Array.from({ length: gameConfig.match.maxParticipants - gameConfig.match.minParticipants + 1 }, (_, index) => gameConfig.match.minParticipants + index).map((count) => (
              <button type="button" key={count} className={participantCount === count ? 'active' : ''} onClick={() => onParticipantChange(count)}>
                <strong>{count}</strong><span>{text.humanAndNpc}</span>
              </button>
            ))}
          </div>
        </div>

        {hasError && <p className="start-map-error" role="alert">{text.mapError}</p>}
        <button type="button" className="start-match-button" disabled={isStarting} onClick={onStart}>{isStarting ? text.starting : text.start}<span aria-hidden="true">{isStarting ? '…' : '→'}</span></button>
      </section>
    </main>
  )
}
