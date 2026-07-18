import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LocaleDictionary } from '../config/localization'
import { gameConfig } from '../config/game'
import { createManualHeightGrid, generateMap, type GeneratorSettings, type ManualHeightGrid } from '../game/generator'
import type { GameMap } from '../game/map'
import { mapPresets } from '../game/presets'
import { presetSelection, savedSelection, type MapSelection, type SavedMapDefinition } from '../game/savedMaps'
import { clearMapObjects } from '../game/map'
import type { MapScenario, ScenarioResult } from '../game/scenario'
import { calculateScenarioInWorker } from '../game/scenarioWorkerClient'

const previewCache = new Map<string, GameMap>()
const defaultPreviewGrid = createManualHeightGrid()

function previewMapFor(cacheKey: string, settings: GeneratorSettings, manualGrid: ManualHeightGrid) {
  const cached = previewCache.get(cacheKey)
  if (cached) return cached
  const map = generateMap(settings, manualGrid)
  previewCache.set(cacheKey, map)
  return map
}

function MapPreview({ cacheKey, settings, manualGrid, large = false, scenario }: { cacheKey: string; settings: GeneratorSettings; manualGrid: ManualHeightGrid; large?: boolean; scenario?: MapScenario | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const map = previewMapFor(cacheKey, settings, manualGrid)
    const rows = map.length
    const columns = map[0]?.length ?? 0
    const size = large ? 640 : 180
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
    if (scenario) {
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
          if (scenario.territories[row - 1]?.[column] !== regionId) { context.beginPath(); context.moveTo(x, y); context.lineTo(x + cellWidth, y); context.stroke() }
          if (scenario.territories[row + 1]?.[column] !== regionId) { context.beginPath(); context.moveTo(x, y + cellHeight); context.lineTo(x + cellWidth, y + cellHeight); context.stroke() }
          if (scenario.territories[row]?.[column - 1] !== regionId) { context.beginPath(); context.moveTo(x, y); context.lineTo(x, y + cellHeight); context.stroke() }
          if (scenario.territories[row]?.[column + 1] !== regionId) { context.beginPath(); context.moveTo(x + cellWidth, y); context.lineTo(x + cellWidth, y + cellHeight); context.stroke() }
        }
      }
      scenario.regions.forEach((region) => {
        const x = (region.center.column + 0.5) * cellWidth
        const y = (region.center.row + 0.5) * cellHeight
        context.fillStyle = region.color
        context.beginPath(); context.arc(x, y, 9, 0, Math.PI * 2); context.fill()
        context.fillStyle = '#121712'; context.font = '700 9px system-ui'; context.textAlign = 'center'; context.textBaseline = 'middle'
        context.fillText(String(region.index + 1), x, y + 0.5)
      })
    }
  }, [cacheKey, large, manualGrid, scenario, settings])

  return <span className={`preset-map-preview${large ? ' large' : ''}`} aria-hidden="true"><canvas ref={canvasRef} /></span>
}

function MapChoice({ name, description, selected, preview, onSelect, onDelete, deleteLabel }: { name: string; description: string; selected: boolean; preview: React.ReactNode; onSelect: () => void; onDelete?: () => void; deleteLabel?: string }) {
  return (
    <article className={`map-choice${selected ? ' selected' : ''}`}>
      <button type="button" className="map-choice-main" onClick={onSelect} aria-pressed={selected}>{preview}<span><strong>{name}</strong><small>{description}</small></span></button>
      {onDelete && <button type="button" className="saved-map-delete danger" onClick={onDelete} aria-label={`${deleteLabel}: ${name}`} title={`${deleteLabel}: ${name}`}>×</button>}
    </article>
  )
}

interface StartMenuProps {
  text: LocaleDictionary['startMenu']
  selectedMap: MapSelection
  savedMaps: SavedMapDefinition[]
  participantCount: number
  onMapChange: (selection: MapSelection) => void
  onDeleteSavedMap: (id: string) => void
  onParticipantChange: (count: number) => void
  onOpenGenerator: () => void
  onStart: (scenario: MapScenario) => void
  utilityControls: ReactNode
}

export function StartMenu({ text, selectedMap, savedMaps, participantCount, onMapChange, onDeleteSavedMap, onParticipantChange, onOpenGenerator, onStart, utilityControls }: StartMenuProps) {
  const [prepared, setPrepared] = useState<{ key: string; result: ScenarioResult } | null>(null)
  const selectedDefinition = useMemo(() => {
    if (selectedMap.startsWith('saved:')) {
      const saved = savedMaps.find((map) => savedSelection(map.id) === selectedMap)
      if (saved) return { id: saved.id, name: saved.name, description: `${saved.settings.mapSize} × ${saved.settings.mapSize} · ${text.seedShort} ${saved.settings.seed}`, settings: saved.settings, manualGrid: saved.manualGrid }
    }
    const preset = mapPresets.find((candidate) => presetSelection(candidate.id) === selectedMap) ?? mapPresets[0]
    const copy = text.presets[preset.id]
    return { id: preset.id, name: copy.name, description: copy.description, settings: preset.settings, manualGrid: defaultPreviewGrid }
  }, [savedMaps, selectedMap, text])
  const preparationKey = `${selectedMap}:${participantCount}:${selectedDefinition.settings.seed}:${selectedDefinition.settings.mapSize}`
  const preparedResult = prepared?.key === preparationKey ? prepared.result : null
  const isPreparing = !preparedResult

  useEffect(() => {
    const controller = new AbortController()
    const map = clearMapObjects(previewMapFor(selectedMap, selectedDefinition.settings, selectedDefinition.manualGrid))
    calculateScenarioInWorker(map, participantCount, selectedDefinition.settings.seed, controller.signal)
      .then((result) => {
        if (result.ok) setPrepared({ key: preparationKey, result: { ok: true, scenario: { ...result.scenario, id: selectedDefinition.id, name: selectedDefinition.name } } })
        else setPrepared({ key: preparationKey, result })
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setPrepared({ key: preparationKey, result: { ok: false, reason: 'not-enough-land' } })
      })
    return () => controller.abort()
  }, [participantCount, preparationKey, selectedDefinition, selectedMap])

  return (
    <main className="start-screen">
      <img className="start-hero-art" src="/assets/start-menu-hero.webp" alt="" aria-hidden="true" fetchPriority="high" />
      <div className="start-atmosphere" aria-hidden="true" />
      <section className="start-menu" aria-labelledby="start-title">
        <header className="start-header"><span>{text.eyebrow}</span><h1 id="start-title">{text.title}</h1><p>{text.description}</p></header>

        <div className="start-setup-workspace">
          <section className="selected-map-showcase" aria-labelledby="selected-map-title">
            <div className="showcase-map-art"><MapPreview cacheKey={selectedMap} settings={selectedDefinition.settings} manualGrid={selectedDefinition.manualGrid} large scenario={preparedResult?.ok ? preparedResult.scenario : null} /></div>
            <div className="showcase-map-copy"><h2 id="selected-map-title">{selectedDefinition.name}</h2><p>{selectedDefinition.description}</p></div>
            {isPreparing && <div className="showcase-region-loader" role="status"><span aria-hidden="true" />{text.starting}</div>}
            {preparedResult && !preparedResult.ok && <p className="showcase-region-error" role="alert">{text.mapError}</p>}
          </section>

          <section className="map-library" aria-label={text.chooseMap}>
            <div className="map-library-heading"><h2>{text.chooseMap}</h2></div>
            <div className="map-library-scroll">
              <div className="map-library-group"><h3>{text.builtInMaps}</h3><div className="map-choice-list">
                {mapPresets.map((preset) => {
                  const selection = presetSelection(preset.id)
                  const copy = text.presets[preset.id]
                  return <MapChoice key={selection} name={copy.name} description={copy.description} selected={selectedMap === selection} preview={<MapPreview cacheKey={selection} settings={preset.settings} manualGrid={defaultPreviewGrid} />} onSelect={() => onMapChange(selection)} />
                })}
              </div></div>
              <div className="map-library-group"><h3>{text.myMaps}</h3><div className="map-choice-list">
                {savedMaps.map((map) => {
                  const selection = savedSelection(map.id)
                  const description = `${map.settings.mapSize} × ${map.settings.mapSize} · ${text.seedShort} ${map.settings.seed}`
                  return <MapChoice key={selection} name={map.name} description={description} selected={selectedMap === selection} preview={<MapPreview cacheKey={selection} settings={map.settings} manualGrid={map.manualGrid} />} onSelect={() => onMapChange(selection)} onDelete={() => onDeleteSavedMap(map.id)} deleteLabel={text.deleteSavedMap} />
                })}
                <button type="button" className="create-map-choice" aria-label={`${text.customMap}. ${text.customMapDescription} ${text.openGenerator}`} onClick={onOpenGenerator}><i aria-hidden="true">+</i><span><strong>{text.customMap}</strong><small>{text.openGenerator}</small></span></button>
              </div></div>
            </div>
          </section>
        </div>

        <footer className="match-action-bar">
          <div className="participant-control"><span><strong>{text.participants}</strong><small>{text.participantDescription}</small></span><div className="participant-picker" role="group" aria-label={text.participants}>
            {Array.from({ length: gameConfig.match.maxParticipants - gameConfig.match.minParticipants + 1 }, (_, index) => gameConfig.match.minParticipants + index).map((count) => (
              <button type="button" key={count} className={participantCount === count ? 'active' : ''} aria-label={`${count} · ${text.humanAndNpc}`} aria-pressed={participantCount === count} onClick={() => onParticipantChange(count)}><strong>{count}</strong></button>
            ))}
          </div></div>
          <button type="button" className="start-match-button" disabled={!preparedResult?.ok} onClick={() => { if (preparedResult?.ok) onStart(preparedResult.scenario) }}>{isPreparing ? text.starting : text.start}<span aria-hidden="true">{isPreparing ? '…' : '→'}</span></button>
          <div className="start-utility-slot">{utilityControls}</div>
        </footer>
      </section>
    </main>
  )
}
