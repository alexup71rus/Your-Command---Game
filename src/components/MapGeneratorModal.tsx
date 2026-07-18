import { useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { gameConfig } from '../config/game'
import type { Locale, LocaleDictionary } from '../config/localization'
import {
  createManualHeightGrid,
  defaultGeneratorSettings,
  generateMap,
  type GeneratorSettings,
  type ManualHeight,
  type ManualHeightGrid,
} from '../game/generator'
import { clearMapObjects } from '../game/map'
import type { MapScenario, ScenarioResult } from '../game/scenario'
import type { SavedMapDraft } from '../game/savedMaps'
import { calculateScenarioInWorker } from '../game/scenarioWorkerClient'
import { CloseIcon } from './InterfaceIcons'
import { SelectField } from './ui/SelectField'

interface MapGeneratorModalProps {
  onApply: (scenario: MapScenario) => void
  onClose: () => void
  text: LocaleDictionary['generator']
  locale: Locale
  participantCount: number
  savedMapCount: number
  onParticipantChange: (count: number) => void
  onSave: (draft: SavedMapDraft) => void
}

const colorForCell = (elevation: number, vegetation: boolean) => {
  if (elevation >= 0.9) return '#a39e8e'
  if (vegetation) return elevation >= 0.58 ? '#405d3d' : '#294c34'
  if (elevation >= 0.58) return '#727158'
  return elevation >= 0.4 ? '#59694d' : '#435944'
}

function RangeControl({
  label,
  value,
  min = 0,
  max = 100,
  suffix = '%',
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  suffix?: string
  onChange: (value: number) => void
}) {
  return (
    <label className="generator-range">
      <span>{label}<strong>{value}{suffix}</strong></span>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  )
}

export function MapGeneratorModal({ onApply, onClose, onSave, text, locale, participantCount, savedMapCount, onParticipantChange }: MapGeneratorModalProps) {
  const [settings, setSettings] = useState<GeneratorSettings>(defaultGeneratorSettings)
  const [manualGrid, setManualGrid] = useState<ManualHeightGrid>(createManualHeightGrid)
  const [mapName, setMapName] = useState(`${text.defaultMapName} ${savedMapCount + 1}`)
  const [brush, setBrush] = useState<ManualHeight>(1)
  const deferredSettings = useDeferredValue(settings)
  const deferredManualGrid = useDeferredValue(manualGrid)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [resolvedScenarioKey, setResolvedScenarioKey] = useState('')
  const [scenarioResult, setScenarioResult] = useState<ScenarioResult | null>(null)
  const previewMap = useMemo(
    () => generateMap(deferredSettings, deferredManualGrid),
    [deferredManualGrid, deferredSettings],
  )
  const scenarioMap = useMemo(() => clearMapObjects(previewMap), [previewMap])
  const scenarioKey = useMemo(
    () => JSON.stringify([deferredSettings, deferredManualGrid, participantCount]),
    [deferredManualGrid, deferredSettings, participantCount],
  )
  const scenarioReady = resolvedScenarioKey === scenarioKey ? scenarioResult : null
  const previewPending = deferredSettings !== settings || deferredManualGrid !== manualGrid
  const generationPending = previewPending || !scenarioReady

  useEffect(() => {
    const controller = new AbortController()
    calculateScenarioInWorker(scenarioMap, participantCount, deferredSettings.seed, controller.signal)
      .then((result) => {
        setScenarioResult(result)
        setResolvedScenarioKey(scenarioKey)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setScenarioResult({ ok: false, reason: 'not-enough-land' })
        setResolvedScenarioKey(scenarioKey)
      })
    return () => controller.abort()
  }, [deferredSettings.seed, participantCount, scenarioKey, scenarioMap])

  useEffect(() => {
    const canvas = canvasRef.current
    const preview = previewRef.current
    if (!canvas || !preview) return
    const context = canvas.getContext('2d')
    if (!context) return
    const rows = previewMap.length
    const columns = previewMap[0]?.length ?? 0
    if (!rows || !columns) return

    const drawPreview = () => {
      const bounds = preview.getBoundingClientRect()
      const mapRatio = columns / rows
      const boxRatio = bounds.width / bounds.height
      const width = Math.max(1, boxRatio > mapRatio ? bounds.height * mapRatio : bounds.width)
      const height = Math.max(1, boxRatio > mapRatio ? bounds.height : bounds.width / mapRatio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cellWidth = width / columns
      const cellHeight = height / rows
      previewMap.forEach((row, y) => row.forEach((cell, x) => {
        context.fillStyle = colorForCell(cell.elevation ?? 0, Boolean(cell.vegetation))
        context.fillRect(x * cellWidth, y * cellHeight, Math.ceil(cellWidth), Math.ceil(cellHeight))
      }))
      if (scenarioReady?.ok) {
        const { territories, regions } = scenarioReady.scenario
        context.lineWidth = 1.2
        for (let row = 0; row < rows; row += 1) {
          for (let column = 0; column < columns; column += 1) {
            const regionId = territories[row][column]
            if (!regionId) continue
            const region = regions.find((candidate) => candidate.id === regionId)
            if (!region) continue
            const x = column * cellWidth
            const y = row * cellHeight
            context.fillStyle = `${region.color}18`
            context.fillRect(x, y, Math.ceil(cellWidth), Math.ceil(cellHeight))
            context.strokeStyle = `${region.color}b8`
            if (territories[row - 1]?.[column] !== regionId) { context.beginPath(); context.moveTo(x, y); context.lineTo(x + cellWidth, y); context.stroke() }
            if (territories[row + 1]?.[column] !== regionId) { context.beginPath(); context.moveTo(x, y + cellHeight); context.lineTo(x + cellWidth, y + cellHeight); context.stroke() }
            if (territories[row]?.[column - 1] !== regionId) { context.beginPath(); context.moveTo(x, y); context.lineTo(x, y + cellHeight); context.stroke() }
            if (territories[row]?.[column + 1] !== regionId) { context.beginPath(); context.moveTo(x + cellWidth, y); context.lineTo(x + cellWidth, y + cellHeight); context.stroke() }
          }
        }
        regions.forEach((region) => {
          const x = (region.center.column + 0.5) * cellWidth
          const y = (region.center.row + 0.5) * cellHeight
          context.fillStyle = region.color
          context.beginPath()
          context.arc(x, y, 7, 0, Math.PI * 2)
          context.fill()
          context.fillStyle = '#101510'
          context.font = '700 8px system-ui'
          context.textAlign = 'center'
          context.textBaseline = 'middle'
          context.fillText(String(region.index + 1), x, y + 0.5)
        })
      }
      context.strokeStyle = 'rgba(225, 198, 119, .2)'
      context.lineWidth = 1
      for (let x = 1; x < deferredManualGrid[0].length; x += 1) {
        context.beginPath()
        context.moveTo(Math.round(x * width / deferredManualGrid[0].length) + 0.5, 0)
        context.lineTo(Math.round(x * width / deferredManualGrid[0].length) + 0.5, height)
        context.stroke()
      }
      for (let y = 1; y < deferredManualGrid.length; y += 1) {
        context.beginPath()
        context.moveTo(0, Math.round(y * height / deferredManualGrid.length) + 0.5)
        context.lineTo(width, Math.round(y * height / deferredManualGrid.length) + 0.5)
        context.stroke()
      }
      deferredManualGrid.forEach((row, y) => row.forEach((heightValue, x) => {
        if (!heightValue) return
        const centerX = (x + 0.5) * width / row.length
        const centerY = (y + 0.5) * height / deferredManualGrid.length
        context.fillStyle = heightValue === 2 ? '#f0d98c' : '#c2ab6c'
        context.beginPath()
        context.arc(centerX, centerY, heightValue === 2 ? 5 : 3.5, 0, Math.PI * 2)
        context.fill()
      }))
    }

    const resizeObserver = new ResizeObserver(drawPreview)
    resizeObserver.observe(preview)
    drawPreview()
    return () => resizeObserver.disconnect()
  }, [deferredManualGrid, previewMap, scenarioReady])

  const updateSetting = <Key extends keyof GeneratorSettings>(key: Key, value: GeneratorSettings[Key]) => {
    setSettings((current) => ({ ...current, [key]: value }))
  }

  const paint = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.buttons !== 1) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const column = Math.min(manualGrid[0].length - 1, Math.floor((event.clientX - bounds.left) / bounds.width * manualGrid[0].length))
    const row = Math.min(manualGrid.length - 1, Math.floor((event.clientY - bounds.top) / bounds.height * manualGrid.length))
    setManualGrid((current) => current.map((currentRow, y) =>
      currentRow.map((value, x) => (x === column && y === row ? brush : value)),
    ))
  }

  const regenerate = () => {
    setSettings((current) => ({ ...current, seed: Math.floor(Math.random() * 999_999) }))
  }

  const stats = useMemo(() => {
    const cells = previewMap.flat()
    return {
      hills: cells.filter((cell) => cell.landform === 'hill').length,
      peaks: cells.filter((cell) => cell.landform === 'peak').length,
      forests: cells.filter((cell) => cell.vegetation).length,
      total: cells.length,
    }
  }, [previewMap])

  const formatCoverage = (cells: number) =>
    `${(cells / stats.total * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%`

  return (
    <div className="generator-backdrop" onPointerDown={onClose}>
      <section className="generator-modal" role="dialog" aria-modal="true" aria-labelledby="generator-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="generator-header">
          <div><span className="dev-label">{text.devLabel}</span><h2 id="generator-title">{text.title}</h2></div>
          <button className="generator-close" type="button" onClick={onClose} aria-label={text.close}><CloseIcon /></button>
        </header>

        <div className="generator-body">
          <aside className="generator-controls">
            <section>
              <h3>{text.relief}</h3>
              <RangeControl label={text.participants} value={participantCount} min={gameConfig.match.minParticipants} max={gameConfig.match.maxParticipants} suffix="" onChange={onParticipantChange} />
              <RangeControl label={text.mapSize} value={settings.mapSize} min={gameConfig.generator.minMapSize} max={gameConfig.generator.maxMapSize} suffix={` × ${settings.mapSize}`} onChange={(value) => updateSetting('mapSize', value)} />
              <SelectField label={text.source} value={settings.reliefMode} options={[{ value: 'automatic', label: text.automatic }, { value: 'hybrid', label: text.hybrid }, { value: 'manual', label: text.manual }]} onChange={(value) => updateSetting('reliefMode', value)} />
              <RangeControl label={text.hills} value={settings.hillCoverage} min={5} max={75} onChange={(value) => updateSetting('hillCoverage', Math.max(value, settings.peakCoverage))} />
              <RangeControl label={text.peaks} value={settings.peakCoverage} max={25} onChange={(value) => updateSetting('peakCoverage', Math.min(value, settings.hillCoverage))} />
              <RangeControl label={text.formScale} value={settings.reliefScale} min={18} max={90} suffix="" onChange={(value) => updateSetting('reliefScale', value)} />
              <RangeControl label={text.reliefDistribution} value={settings.heightDistribution} min={-100} max={100} suffix="" onChange={(value) => updateSetting('heightDistribution', value)} />
            </section>
            <section>
              <h3>{text.vegetation}</h3>
              <RangeControl label={text.coverage} value={settings.vegetationDensity} max={80} onChange={(value) => updateSetting('vegetationDensity', value)} />
              <RangeControl label={text.vegetationDistribution} value={settings.vegetationDistribution} min={-100} max={100} suffix="" onChange={(value) => updateSetting('vegetationDistribution', value)} />
              <SelectField label={text.heightPreference} value={settings.vegetationHeight} options={[{ value: 'lowlands', label: text.lowlands }, { value: 'balanced', label: text.balanced }, { value: 'highlands', label: text.highlands }]} onChange={(value) => updateSetting('vegetationHeight', value)} />
              <RangeControl label={text.reliefInfluence} value={settings.heightInfluence} onChange={(value) => updateSetting('heightInfluence', value)} />
            </section>
          </aside>

          <div className="generator-preview-column">
            <div className="preview-toolbar">
              <div className="brushes" aria-label={text.brushAria}>
                {([0, 1, 2] as ManualHeight[]).map((height) => (
                  <button type="button" key={height} className={brush === height ? 'active' : ''} onClick={() => setBrush(height)}>
                    {height === 0 ? text.erase : height === 1 ? text.hill : text.mountain}
                  </button>
                ))}
              </div>
              <button className="clear-height-map" type="button" onClick={() => setManualGrid(createManualHeightGrid())}>{text.clearNodes}</button>
            </div>
            <div className="map-preview" ref={previewRef}>
              <canvas ref={canvasRef} onPointerDown={paint} onPointerMove={paint} aria-label={text.previewAria} />
              {!scenarioReady && <div className="map-preview-loader" aria-live="polite"><span aria-hidden="true" />{text.regionsCalculating}</div>}
              <div className="preview-legend"><span className="forest">{text.forest}</span><span className="plain">{text.plain}</span><span className="hill">{text.elevation}</span><span className="peak">{text.peak}</span></div>
            </div>
            <div className="generator-stats">
              <span><em>{text.traversableHeights}</em><strong>{formatCoverage(stats.hills)}</strong><small>{stats.hills.toLocaleString(locale)} {text.cells}</small></span>
              <span><em>{text.impassablePeaks}</em><strong>{formatCoverage(stats.peaks)}</strong><small>{stats.peaks.toLocaleString(locale)} {text.cells}</small></span>
              <span><em>{text.forestCoverage}</em><strong>{formatCoverage(stats.forests)}</strong><small>{stats.forests.toLocaleString(locale)} {text.cells}</small></span>
              <span className="seed-stat"><em>{text.seed}</em><strong>{deferredSettings.seed}</strong></span>
            </div>
            {scenarioReady && !scenarioReady.ok && <div className="region-validation invalid"><span>!</span>{scenarioReady.reason === 'unbalanced-regions' ? text.regionsUnbalanced : text.regionsError}</div>}
            <p className="generator-note">{text.note}</p>
          </div>
        </div>

        <footer className="generator-footer">
          <label className="generator-map-name"><span>{text.mapName}</span><input value={mapName} maxLength={48} onChange={(event) => setMapName(event.target.value)} /></label>
          <button type="button" className="secondary save-map-button" disabled={generationPending || !scenarioReady?.ok} onClick={() => { if (!generationPending && scenarioReady?.ok) onSave({ name: mapName.trim() || `${text.defaultMapName} ${savedMapCount + 1}`, settings, manualGrid }) }}><span>{text.saveMap}</span></button>
          <button type="button" className="secondary" onClick={regenerate}>{text.newVariant}</button>
          <button type="button" className="primary" disabled={generationPending || !scenarioReady?.ok} onClick={() => { if (!generationPending && scenarioReady?.ok) onApply(scenarioReady.scenario) }}>{text.apply}</button>
        </footer>
      </section>
    </div>
  )
}
