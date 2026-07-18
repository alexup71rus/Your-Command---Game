import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ClickEffects, type ClickBurst, type ClickBurstKind, type ClickBurstVariant } from './components/ClickEffects'
import { FoundingPanel } from './components/FoundingPanel'
import { GridCanvas, type CameraCommand, type MapClickRequest, type MapContextRequest } from './components/GridCanvas'
import { SoundIcon } from './components/InterfaceIcons'
import { MapGeneratorModal } from './components/MapGeneratorModal'
import { SettingsModal } from './components/SettingsModal'
import { StartMenu } from './components/StartMenu'
import { gameConfig } from './config/game'
import type { TabId } from './config/localization'
import { overlayAfterEscape, type GamePhase, type Overlay } from './game/flow'
import { createManualHeightGrid, generateMap } from './game/generator'
import { mapPresets, type PresetId } from './game/presets'
import { foundMatch, isCastleSiteValid, type CellPosition, type MapScenario } from './game/scenario'
import { calculateScenarioInWorker } from './game/scenarioWorkerClient'
import { useLocalization } from './hooks/useLocalization'
import { useNavigationHint } from './hooks/useNavigationHint'
import { useSoundEffects, type SoundEffect } from './hooks/useSoundEffects'

interface ContextMenuState extends MapContextRequest {
  left: number
  top: number
}

export function App() {
  const [phase, setPhase] = useState<GamePhase>('menu')
  const [selectedPreset, setSelectedPreset] = useState<PresetId>('greenMarches')
  const [participantCount, setParticipantCount] = useState<number>(gameConfig.match.defaultParticipants)
  const [scenario, setScenario] = useState<MapScenario | null>(null)
  const [startError, setStartError] = useState(false)
  const [presetStarting, setPresetStarting] = useState(false)
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)
  const [castleDraft, setCastleDraft] = useState<CellPosition | null>(null)
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null)
  const [territoriesHeld, setTerritoriesHeld] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('buildings')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [bursts, setBursts] = useState<ClickBurst[]>([])
  const [overlay, setOverlay] = useState<Overlay>(null)
  const burstId = useRef(0)
  const focusId = useRef(0)
  const presetStartController = useRef<AbortController | null>(null)
  const lastBurstVariant = useRef<ClickBurstVariant | null>(null)
  const { locale, setLocale, text } = useLocalization()
  const { visible: navigationHintVisible, markLearned } = useNavigationHint()
  const { enabled: soundEnabled, volume, play: playSound, setVolume, toggle: toggleSound } = useSoundEffects()

  const createBurst = useCallback((x: number, y: number, kind: ClickBurstKind) => {
    const id = ++burstId.current
    const availableVariants = ([0, 1, 2, 3, 4] as ClickBurstVariant[]).filter((variant) => variant !== lastBurstVariant.current)
    const variant = availableVariants[Math.floor(Math.random() * availableVariants.length)]
    lastBurstVariant.current = variant
    setBursts((current) => [...current.slice(-7), { id, x, y, kind, variant, rotation: Math.random() * 90 - 45, scale: 1.25 + Math.random() * 0.22, spread: 0.9 + Math.random() * 0.22 }])
    window.setTimeout(() => setBursts((current) => current.filter((burst) => burst.id !== id)), 720)
  }, [])

  const focusRegion = useCallback((regionId: string) => {
    const region = scenario?.regions.find((candidate) => candidate.id === regionId)
    if (region) setCameraCommand({ kind: 'cell', ...region.center, key: ++focusId.current })
  }, [scenario])

  const beginFounding = useCallback((nextScenario: MapScenario) => {
    setScenario(nextScenario)
    setSelectedRegionId(null)
    setCastleDraft(null)
    setContextMenu(null)
    setStartError(false)
    setOverlay(null)
    setCameraCommand({ kind: 'overview', key: ++focusId.current })
    setPhase('founding')
  }, [])

  const openGenerator = useCallback(() => setOverlay('generator'), [])
  const closeGenerator = useCallback(() => setOverlay(null), [])

  const applyGeneratedScenario = useCallback((generatedScenario: MapScenario) => {
    beginFounding(generatedScenario)
  }, [beginFounding])

  const cancelPresetStart = useCallback(() => {
    presetStartController.current?.abort()
    presetStartController.current = null
    setPresetStarting(false)
  }, [])

  const startPreset = useCallback(async () => {
    cancelPresetStart()
    const preset = mapPresets.find((candidate) => candidate.id === selectedPreset) ?? mapPresets[0]
    const map = generateMap(preset.settings, createManualHeightGrid())
    const controller = new AbortController()
    presetStartController.current = controller
    setPresetStarting(true)
    setStartError(false)
    try {
      const result = await calculateScenarioInWorker(map, participantCount, preset.settings.seed, controller.signal)
      if (controller.signal.aborted) return
      if (result.ok) beginFounding({ ...result.scenario, id: preset.id, name: preset.id })
      else setStartError(true)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setStartError(true)
    } finally {
      if (presetStartController.current === controller) {
        presetStartController.current = null
        setPresetStarting(false)
      }
    }
  }, [beginFounding, cancelPresetStart, participantCount, selectedPreset])

  useEffect(() => () => presetStartController.current?.abort(), [])

  const selectRegion = useCallback((regionId: string | null) => {
    setSelectedRegionId(regionId)
    setCastleDraft(null)
    if (regionId) focusRegion(regionId)
    else setCameraCommand({ kind: 'overview', key: ++focusId.current })
  }, [focusRegion])

  const handleMapClick = useCallback((request: MapClickRequest) => {
    createBurst(request.clientX, request.clientY, 'map')
    playSound('map')
    if (phase !== 'founding' || !scenario) return
    const regionId = scenario.territories[request.row]?.[request.column] ?? null
    if (!selectedRegionId) {
      if (regionId) selectRegion(regionId)
      return
    }
    setCastleDraft({ column: request.column, row: request.row })
  }, [createBurst, phase, playSound, scenario, selectRegion, selectedRegionId])

  const confirmFounding = useCallback(() => {
    if (!scenario || !selectedRegionId || !castleDraft || !isCastleSiteValid(scenario, selectedRegionId, castleDraft)) return
    setScenario(foundMatch(scenario, selectedRegionId, castleDraft))
    setCameraCommand({ kind: 'cell', ...castleDraft, key: ++focusId.current })
    setPhase('playing')
    setTerritoriesHeld(false)
    playSound('action')
  }, [castleDraft, playSound, scenario, selectedRegionId])

  const openContextMenu = useCallback((request: MapContextRequest) => {
    if (phase !== 'playing') return
    const menuWidth = 270
    const menuHeight = 220
    const viewportPadding = 16
    setContextMenu({ ...request, left: Math.max(viewportPadding, Math.min(request.clientX + 8, window.innerWidth - menuWidth - viewportPadding)), top: Math.max(viewportPadding, Math.min(request.clientY + 8, window.innerHeight - menuHeight - viewportPadding)) })
    createBurst(request.clientX, request.clientY, 'context')
    playSound('context')
  }, [createBurst, phase, playSound])

  const handleInterfacePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.grid-canvas') || target.closest('.sound-toggle')) return
    let kind: ClickBurstKind = 'interface'
    let effect: SoundEffect = 'action'
    if (target.closest('.tab')) effect = 'tab'
    else if (target.closest('.context-menu button') && target.closest('.danger')) kind = 'danger'
    else if (target.closest('.context-backdrop') && !target.closest('.context-menu')) effect = 'dismiss'
    else if (!target.closest('button')) return
    createBurst(event.clientX, event.clientY, kind)
    playSound(effect)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift' && phase !== 'menu' && overlay === null) setTerritoriesHeld(true)
      if (event.key !== 'Escape') return
      event.preventDefault()
      setTerritoriesHeld(false)
      if (contextMenu) setContextMenu(null)
      else setOverlay(overlayAfterEscape(phase, overlay))
    }
    const releaseShift = (event: KeyboardEvent) => { if (event.key === 'Shift') setTerritoriesHeld(false) }
    const releaseShiftOnBlur = () => setTerritoriesHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', releaseShift)
    window.addEventListener('blur', releaseShiftOnBlur)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', releaseShift); window.removeEventListener('blur', releaseShiftOnBlur) }
  }, [contextMenu, overlay, phase])

  if (!text) return <main className="game-shell loading-shell" aria-busy="true" />
  if (phase === 'menu') {
    return (
      <>
        <StartMenu text={text.startMenu} selectedPreset={selectedPreset} participantCount={participantCount} hasError={startError} isStarting={presetStarting} onPresetChange={(preset) => { cancelPresetStart(); setSelectedPreset(preset); setStartError(false) }} onParticipantChange={(count) => { cancelPresetStart(); setParticipantCount(count); setStartError(false) }} onOpenGenerator={() => { cancelPresetStart(); openGenerator() }} onStart={startPreset} />
        {overlay === 'generator' && (
          <MapGeneratorModal text={text.generator} locale={locale} participantCount={participantCount} onParticipantChange={setParticipantCount} onClose={closeGenerator} onApply={applyGeneratedScenario} />
        )}
      </>
    )
  }

  if (!scenario) return null
  const activeTabLabel = text.tabs.find((tab) => tab.id === activeTab)?.label ?? text.tabs[0].label
  const draftValid = Boolean(selectedRegionId && castleDraft && isCastleSiteValid(scenario, selectedRegionId, castleDraft))

  return (
    <main className={`game-shell phase-${phase}`} onPointerDownCapture={handleInterfacePointerDown}>
      <GridCanvas map={scenario.cells} territories={scenario.territories} regions={scenario.regions} showTerritories={phase === 'founding' || territoriesHeld} mode={phase} selectedRegionId={selectedRegionId} castleDraft={castleDraft} cameraCommand={cameraCommand} ariaLabel={text.interface.mapAria} onContextRequest={openContextMenu} onMapClick={handleMapClick} onNavigate={markLearned} />
      <ClickEffects bursts={bursts} />

      {phase === 'playing' && <>
        <header className="hud" aria-label={text.hud.state}>
          <section className="hud-panel resource-panel" aria-label={text.hud.resources}><h2>{text.hud.resources}</h2><div className="resource-panel-content"><dl className="compact-status-list">{text.resources.map((resource) => <div key={resource}><dt>{resource}</dt><dd>—</dd></div>)}</dl><div className="population-summary"><span>{text.hud.people}</span><strong>—</strong></div></div></section>
          <section className="hud-panel army-panel" aria-label={text.hud.army}><h2>{text.hud.army}</h2><dl className="compact-status-list troop-list">{text.troops.map((troop) => <div key={troop}><dt>{troop}</dt><dd>—</dd></div>)}</dl></section>
        </header>
        <section className="hud-panel turn-panel" aria-label={text.hud.turn}><div className="current-turn"><span>{text.hud.turn}</span><strong>1</strong></div><div className="order-status"><div className="order-markers" aria-label={`${text.hud.ordersAvailable}: ${gameConfig.turn.maxOrders}`}>{Array.from({ length: gameConfig.turn.maxOrders }, (_, index) => <span key={index} className="order-marker" aria-hidden="true" />)}</div></div></section>
        <section className="command-dock" aria-label={text.interface.controlPanel}><div className="empty-panel" role="tabpanel" aria-label={activeTabLabel} /><nav className="tabs" aria-label={text.interface.controlSections}>{text.tabs.map((tab) => <button key={tab.id} type="button" className={tab.id === activeTab ? 'tab active' : 'tab'} aria-selected={tab.id === activeTab} role="tab" onClick={() => setActiveTab(tab.id)}><span className="tab-glyph" aria-hidden="true" />{tab.label}</button>)}</nav></section>
        {navigationHintVisible && <div className="map-hint" aria-live="polite"><span className="mouse-symbol" />{text.interface.mapHint}</div>}
      </>}

      {phase === 'founding' && <FoundingPanel scenario={scenario} selectedRegionId={selectedRegionId} castleDraft={castleDraft} draftValid={draftValid} text={text.founding} onSelectRegion={selectRegion} onConfirm={confirmFounding} />}

      <div className="map-tools"><button type="button" className="menu-toggle" onClick={() => { setTerritoriesHeld(false); setOverlay('settings') }} aria-label={text.settings.title}><kbd>Esc</kbd><span>{text.interface.settingsHint}</span></button><button type="button" className="sound-toggle" aria-label={soundEnabled ? text.sound.disable : text.sound.enable} title={soundEnabled ? text.sound.disable : text.sound.enable} aria-pressed={soundEnabled} onClick={toggleSound}><SoundIcon muted={!soundEnabled} /></button></div>

      {contextMenu && <div className="context-backdrop" onPointerDown={() => setContextMenu(null)} role="presentation"><section className="context-menu" style={{ left: contextMenu.left, top: contextMenu.top }} role="menu" aria-label={text.contextMenu.title} onPointerDown={(event) => event.stopPropagation()}><div className="context-menu-heading"><span>{text.contextMenu.title}</span><small>{text.contextMenu.cell} {contextMenu.column + 1}:{contextMenu.row + 1}</small></div><button type="button" role="menuitem">{text.contextMenu.splitSquad}</button><button type="button" role="menuitem">{text.contextMenu.mergeSquads}</button><button type="button" role="menuitem" className="danger">{text.contextMenu.removeObject}</button></section></div>}

      {overlay === 'settings' && <SettingsModal locale={locale} text={text} soundEnabled={soundEnabled} volume={volume} onClose={() => setOverlay(null)} onLocaleChange={setLocale} onSoundToggle={toggleSound} onVolumeChange={setVolume} />}
    </main>
  )
}
