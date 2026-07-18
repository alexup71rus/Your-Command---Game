import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { Locale, LocaleDictionary } from '../config/localization'
import {
  createManualHeightGrid,
  defaultGeneratorSettings,
  generateMap,
  type GeneratorSettings,
  type ManualHeight,
  type ManualHeightGrid,
} from '../game/generator'
import type { GameMap } from '../game/map'

interface MapGeneratorModalProps {
  currentMap: GameMap
  onApply: (map: GameMap) => void
  onClose: () => void
  text: LocaleDictionary['generator']
  locale: Locale
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

export function MapGeneratorModal({ currentMap, onApply, onClose, text, locale }: MapGeneratorModalProps) {
  const [settings, setSettings] = useState<GeneratorSettings>(defaultGeneratorSettings)
  const [manualGrid, setManualGrid] = useState<ManualHeightGrid>(createManualHeightGrid)
  const [brush, setBrush] = useState<ManualHeight>(1)
  const [vegetationOnly, setVegetationOnly] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewMap = useMemo(
    () => generateMap(settings, manualGrid, vegetationOnly ? currentMap : undefined, vegetationOnly),
    [currentMap, manualGrid, settings, vegetationOnly],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    const rows = previewMap.length
    const columns = previewMap[0]?.length ?? 0
    const cellWidth = width / columns
    const cellHeight = height / rows
    previewMap.forEach((row, y) => row.forEach((cell, x) => {
      context.fillStyle = colorForCell(cell.elevation ?? 0, Boolean(cell.vegetation))
      context.fillRect(x * cellWidth, y * cellHeight, Math.ceil(cellWidth), Math.ceil(cellHeight))
    }))
    context.strokeStyle = 'rgba(225, 198, 119, .2)'
    context.lineWidth = 1
    for (let x = 1; x < manualGrid[0].length; x += 1) {
      context.beginPath()
      context.moveTo(Math.round(x * width / manualGrid[0].length) + 0.5, 0)
      context.lineTo(Math.round(x * width / manualGrid[0].length) + 0.5, height)
      context.stroke()
    }
    for (let y = 1; y < manualGrid.length; y += 1) {
      context.beginPath()
      context.moveTo(0, Math.round(y * height / manualGrid.length) + 0.5)
      context.lineTo(width, Math.round(y * height / manualGrid.length) + 0.5)
      context.stroke()
    }
    manualGrid.forEach((row, y) => row.forEach((heightValue, x) => {
      if (!heightValue) return
      const centerX = (x + 0.5) * width / row.length
      const centerY = (y + 0.5) * height / manualGrid.length
      context.fillStyle = heightValue === 2 ? '#f0d98c' : '#c2ab6c'
      context.beginPath()
      context.arc(centerX, centerY, heightValue === 2 ? 5 : 3.5, 0, Math.PI * 2)
      context.fill()
    }))
  }, [manualGrid, previewMap])

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
    setVegetationOnly(false)
    setSettings((current) => ({ ...current, seed: Math.floor(Math.random() * 999_999) }))
  }

  const regenerateVegetation = () => {
    setVegetationOnly(true)
    setSettings((current) => ({ ...current, seed: Math.floor(Math.random() * 999_999) }))
  }

  const stats = useMemo(() => {
    const cells = previewMap.flat()
    return {
      hills: cells.filter((cell) => cell.landform === 'hill').length,
      peaks: cells.filter((cell) => cell.landform === 'peak').length,
      forests: cells.filter((cell) => cell.vegetation).length,
    }
  }, [previewMap])

  return (
    <div className="generator-backdrop" onPointerDown={onClose}>
      <section className="generator-modal" role="dialog" aria-modal="true" aria-labelledby="generator-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="generator-header">
          <div><span className="dev-label">{text.devLabel}</span><h2 id="generator-title">{text.title}</h2></div>
          <button className="generator-close" type="button" onClick={onClose} aria-label={text.close}>×</button>
        </header>

        <div className="generator-body">
          <aside className="generator-controls">
            <section>
              <h3>{text.relief}</h3>
              <label className="generator-field">{text.source}
                <select value={settings.reliefMode} onChange={(event) => updateSetting('reliefMode', event.target.value as GeneratorSettings['reliefMode'])}>
                  <option value="automatic">{text.automatic}</option>
                  <option value="hybrid">{text.hybrid}</option>
                  <option value="manual">{text.manual}</option>
                </select>
              </label>
              <RangeControl label={text.hills} value={settings.hillCoverage} min={5} max={75} onChange={(value) => updateSetting('hillCoverage', Math.max(value, settings.peakCoverage))} />
              <RangeControl label={text.peaks} value={settings.peakCoverage} max={25} onChange={(value) => updateSetting('peakCoverage', Math.min(value, settings.hillCoverage))} />
              <RangeControl label={text.formScale} value={settings.reliefScale} min={18} max={90} suffix="" onChange={(value) => updateSetting('reliefScale', value)} />
              <RangeControl label={text.reliefDistribution} value={settings.heightDistribution} min={-100} max={100} suffix="" onChange={(value) => updateSetting('heightDistribution', value)} />
            </section>
            <section>
              <h3>{text.vegetation}</h3>
              <RangeControl label={text.coverage} value={settings.vegetationDensity} max={80} onChange={(value) => updateSetting('vegetationDensity', value)} />
              <RangeControl label={text.vegetationDistribution} value={settings.vegetationDistribution} min={-100} max={100} suffix="" onChange={(value) => updateSetting('vegetationDistribution', value)} />
              <label className="generator-field">{text.heightPreference}
                <select value={settings.vegetationHeight} onChange={(event) => updateSetting('vegetationHeight', event.target.value as GeneratorSettings['vegetationHeight'])}>
                  <option value="lowlands">{text.lowlands}</option>
                  <option value="balanced">{text.balanced}</option>
                  <option value="highlands">{text.highlands}</option>
                </select>
              </label>
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
            <div className="map-preview">
              <canvas ref={canvasRef} onPointerDown={paint} onPointerMove={paint} aria-label={text.previewAria} />
              <div className="preview-legend"><span className="plain">{text.plain}</span><span className="hill">{text.elevation}</span><span className="forest">{text.forest}</span><span className="peak">{text.peak}</span></div>
            </div>
            <div className="generator-stats">
              <span>{text.elevation} <strong>{stats.hills.toLocaleString(locale)}</strong></span>
              <span>{text.peak} <strong>{stats.peaks.toLocaleString(locale)}</strong></span>
              <span>{text.forest} <strong>{stats.forests.toLocaleString(locale)}</strong></span>
              <span>{text.seed} <strong>{settings.seed}</strong></span>
            </div>
            <p className="generator-note">{text.note}</p>
          </div>
        </div>

        <footer className="generator-footer">
          <button type="button" className="secondary" onClick={regenerateVegetation}>{text.vegetationOnly}</button>
          <button type="button" className="secondary" onClick={regenerate}>{text.newVariant}</button>
          <button type="button" className="primary" onClick={() => onApply(previewMap)}>{text.apply}</button>
        </footer>
      </section>
    </div>
  )
}
