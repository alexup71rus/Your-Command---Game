import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ClickEffects, type ClickBurst, type ClickBurstKind } from './components/ClickEffects'
import { GridCanvas, type MapClickRequest, type MapContextRequest } from './components/GridCanvas'
import { MapGeneratorModal } from './components/MapGeneratorModal'
import { SettingsModal } from './components/SettingsModal'
import { gameConfig } from './config/game'
import type { TabId } from './config/localization'
import { createEmptyMap } from './game/map'
import { useLocalization } from './hooks/useLocalization'
import { useNavigationHint } from './hooks/useNavigationHint'
import { useSoundEffects, type SoundEffect } from './hooks/useSoundEffects'

type Overlay = 'settings' | 'generator' | null

interface ContextMenuState extends MapContextRequest {
  left: number
  top: number
}

export function App() {
  const initialMap = useMemo(() => createEmptyMap(), [])
  const [map, setMap] = useState(initialMap)
  const [activeTab, setActiveTab] = useState<TabId>('buildings')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [bursts, setBursts] = useState<ClickBurst[]>([])
  const [overlay, setOverlay] = useState<Overlay>(null)
  const burstId = useRef(0)
  const { locale, setLocale, text } = useLocalization()
  const { visible: navigationHintVisible, markLearned } = useNavigationHint()
  const {
    enabled: soundEnabled,
    volume,
    play: playSound,
    setVolume,
    toggle: toggleSound,
  } = useSoundEffects()

  const createBurst = useCallback((x: number, y: number, kind: ClickBurstKind) => {
    const id = ++burstId.current
    setBursts((current) => [...current.slice(-7), { id, x, y, kind }])
    window.setTimeout(() => {
      setBursts((current) => current.filter((burst) => burst.id !== id))
    }, 720)
  }, [])

  const handleMapClick = useCallback((request: MapClickRequest) => {
    createBurst(request.clientX, request.clientY, 'map')
    playSound('map')
  }, [createBurst, playSound])

  const openContextMenu = useCallback((request: MapContextRequest) => {
    const menuWidth = 270
    const menuHeight = 220
    const viewportPadding = 16
    setContextMenu({
      ...request,
      left: Math.max(viewportPadding, Math.min(request.clientX + 8, window.innerWidth - menuWidth - viewportPadding)),
      top: Math.max(viewportPadding, Math.min(request.clientY + 8, window.innerHeight - menuHeight - viewportPadding)),
    })
    createBurst(request.clientX, request.clientY, 'context')
    playSound('context')
  }, [createBurst, playSound])

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
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (contextMenu) setContextMenu(null)
      else if (overlay === 'generator') setOverlay('settings')
      else if (overlay === 'settings') setOverlay(null)
      else setOverlay('settings')
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [contextMenu, overlay])

  if (!text) return <main className="game-shell loading-shell" aria-busy="true" />
  const activeTabLabel = text.tabs.find((tab) => tab.id === activeTab)?.label ?? text.tabs[0].label

  return (
    <main className="game-shell" onPointerDownCapture={handleInterfacePointerDown}>
      <GridCanvas
        map={map}
        ariaLabel={text.interface.mapAria}
        onContextRequest={openContextMenu}
        onMapClick={handleMapClick}
        onNavigate={markLearned}
      />
      <ClickEffects bursts={bursts} />

      <header className="hud" aria-label={text.hud.state}>
        <section className="hud-panel resource-panel" aria-label={text.hud.resources}>
          <h2>{text.hud.resources}</h2>
          <div className="resource-panel-content">
            <dl className="compact-status-list">
              {text.resources.map((resource) => <div key={resource}><dt>{resource}</dt><dd>—</dd></div>)}
            </dl>
            <div className="population-summary"><span>{text.hud.people}</span><strong>—</strong></div>
          </div>
        </section>
        <section className="hud-panel army-panel" aria-label={text.hud.army}>
          <h2>{text.hud.army}</h2>
          <dl className="compact-status-list troop-list">
            {text.troops.map((troop) => <div key={troop}><dt>{troop}</dt><dd>—</dd></div>)}
          </dl>
        </section>
      </header>

      <section className="hud-panel turn-panel" aria-label={text.hud.turn}>
        <div className="current-turn"><span>{text.hud.turn}</span><strong>—</strong></div>
        <div className="order-status">
          <div className="order-markers" aria-label={`${text.hud.ordersAvailable}: ${gameConfig.turn.maxOrders}`}>
            {Array.from({ length: gameConfig.turn.maxOrders }, (_, index) => <span key={index} className="order-marker" aria-hidden="true" />)}
          </div>
        </div>
      </section>

      <section className="command-dock" aria-label={text.interface.controlPanel}>
        <div className="empty-panel" role="tabpanel" aria-label={activeTabLabel} />
        <nav className="tabs" aria-label={text.interface.controlSections}>
          {text.tabs.map((tab) => (
            <button key={tab.id} type="button" className={tab.id === activeTab ? 'tab active' : 'tab'} aria-selected={tab.id === activeTab} role="tab" onClick={() => setActiveTab(tab.id)}>
              <span className="tab-glyph" aria-hidden="true" />{tab.label}
            </button>
          ))}
        </nav>
      </section>

      <div className="map-tools">
        {navigationHintVisible && <div className="map-hint" aria-live="polite"><span className="mouse-symbol" />{text.interface.mapHint}</div>}
        <button type="button" className="menu-toggle" onClick={() => setOverlay('settings')} aria-label={text.settings.title}>
          <kbd>Esc</kbd><span>{text.interface.settingsHint}</span>
        </button>
        <button type="button" className="sound-toggle" aria-label={soundEnabled ? text.sound.disable : text.sound.enable} title={soundEnabled ? text.sound.disable : text.sound.enable} aria-pressed={soundEnabled} onClick={toggleSound}>
          <span className={soundEnabled ? 'sound-icon' : 'sound-icon muted'} aria-hidden="true" />
        </button>
      </div>

      {contextMenu && (
        <div className="context-backdrop" onPointerDown={() => setContextMenu(null)} role="presentation">
          <section className="context-menu" style={{ left: contextMenu.left, top: contextMenu.top }} role="menu" aria-label={text.contextMenu.title} onPointerDown={(event) => event.stopPropagation()}>
            <div className="context-menu-heading"><span>{text.contextMenu.title}</span><small>{text.contextMenu.cell} {contextMenu.column + 1}:{contextMenu.row + 1}</small></div>
            <button type="button" role="menuitem">{text.contextMenu.splitSquad}</button>
            <button type="button" role="menuitem">{text.contextMenu.mergeSquads}</button>
            <button type="button" role="menuitem" className="danger">{text.contextMenu.removeObject}</button>
          </section>
        </div>
      )}

      {overlay === 'settings' && (
        <SettingsModal
          locale={locale}
          text={text}
          soundEnabled={soundEnabled}
          volume={volume}
          onClose={() => setOverlay(null)}
          onLocaleChange={setLocale}
          onOpenGenerator={() => setOverlay('generator')}
          onSoundToggle={toggleSound}
          onVolumeChange={setVolume}
        />
      )}

      {overlay === 'generator' && (
        <MapGeneratorModal
          currentMap={map}
          text={text.generator}
          locale={locale}
          onClose={() => setOverlay('settings')}
          onApply={(generatedMap) => { setMap(generatedMap); setOverlay(null) }}
        />
      )}
    </main>
  )
}
