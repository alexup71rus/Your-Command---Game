import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  GridCanvas,
  type MapClickRequest,
  type MapContextRequest,
} from './components/GridCanvas'
import { ClickEffects, type ClickBurst, type ClickBurstKind } from './components/ClickEffects'
import { gameConfig } from './config/game'
import { text } from './config/localization'
import { createEmptyMap } from './game/map'
import { useSoundEffects, type SoundEffect } from './hooks/useSoundEffects'

type Tab = (typeof text.tabs)[number]

interface ContextMenuState extends MapContextRequest {
  left: number
  top: number
}

export function App() {
  const map = useMemo(() => createEmptyMap(), [])
  const [activeTab, setActiveTab] = useState<Tab>(text.tabs[0])
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [bursts, setBursts] = useState<ClickBurst[]>([])
  const burstId = useRef(0)
  const { enabled: soundEnabled, play: playSound, toggle: toggleSound } = useSoundEffects()

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
      left: Math.max(
        viewportPadding,
        Math.min(request.clientX + 8, window.innerWidth - menuWidth - viewportPadding),
      ),
      top: Math.max(
        viewportPadding,
        Math.min(request.clientY + 8, window.innerHeight - menuHeight - viewportPadding),
      ),
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
    if (target.closest('.tab')) {
      effect = 'tab'
    } else if (target.closest('.context-menu button')) {
      if (target.closest('.danger')) kind = 'danger'
    } else if (target.closest('.context-backdrop') && !target.closest('.context-menu')) {
      effect = 'dismiss'
    } else {
      return
    }
    createBurst(event.clientX, event.clientY, kind)
    playSound(effect)
  }

  useEffect(() => {
    if (!contextMenu) return

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null)
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [contextMenu])

  return (
    <main className="game-shell" onPointerDownCapture={handleInterfacePointerDown}>
      <GridCanvas map={map} onContextRequest={openContextMenu} onMapClick={handleMapClick} />
      <ClickEffects bursts={bursts} />

      <header className="hud" aria-label="Состояние владения">
        <section className="hud-panel resource-panel" aria-label={text.hud.resources}>
          <h2>{text.hud.resources}</h2>
          <div className="resource-panel-content">
            <dl className="compact-status-list">
              {text.resources.map((resource) => (
                <div key={resource}>
                  <dt>{resource}</dt>
                  <dd>—</dd>
                </div>
              ))}
            </dl>
            <div className="population-summary">
              <span>{text.hud.people}</span>
              <strong>—</strong>
            </div>
          </div>
        </section>

        <section className="hud-panel army-panel" aria-label={text.hud.army}>
          <h2>{text.hud.army}</h2>
          <dl className="compact-status-list troop-list">
            {text.troops.map((troop) => (
              <div key={troop}>
                <dt>{troop}</dt>
                <dd>—</dd>
              </div>
            ))}
          </dl>
        </section>

      </header>

      <section className="hud-panel turn-panel" aria-label={text.hud.turn}>
        <div className="current-turn">
          <span>{text.hud.turn}</span>
          <strong>—</strong>
        </div>
        <div className="order-status">
          <div className="order-copy">
            <span>{text.hud.orders}</span>
            <strong>
              {gameConfig.turn.maxOrders} {text.hud.outOf} {gameConfig.turn.maxOrders}
            </strong>
          </div>
          <div
            className="order-markers"
            aria-label={`${text.hud.ordersAvailable}: ${gameConfig.turn.maxOrders}`}
          >
            {Array.from({ length: gameConfig.turn.maxOrders }, (_, index) => (
              <span key={index} className="order-marker" aria-hidden="true" />
            ))}
          </div>
        </div>
      </section>

      <section className="command-dock" aria-label="Панель управления">
        <div className="empty-panel" role="tabpanel" aria-label={activeTab} />
        <nav className="tabs" aria-label="Разделы управления">
          {text.tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className={tab === activeTab ? 'tab active' : 'tab'}
              aria-selected={tab === activeTab}
              role="tab"
              onClick={() => setActiveTab(tab)}
            >
              <span className="tab-glyph" aria-hidden="true" />
              {tab}
            </button>
          ))}
        </nav>
      </section>

      <div className="map-tools">
        <button
          type="button"
          className="sound-toggle"
          aria-label={soundEnabled ? text.sound.disable : text.sound.enable}
          title={soundEnabled ? text.sound.disable : text.sound.enable}
          aria-pressed={soundEnabled}
          onClick={toggleSound}
        >
          <span className={soundEnabled ? 'sound-icon' : 'sound-icon muted'} aria-hidden="true" />
        </button>
        <div className="map-hint" aria-hidden="true">
          <span className="mouse-symbol" />
          {text.mapHint}
        </div>
      </div>

      {contextMenu && (
        <div
          className="context-backdrop"
          onPointerDown={() => setContextMenu(null)}
          role="presentation"
        >
          <section
            className="context-menu"
            style={{ left: contextMenu.left, top: contextMenu.top }}
            role="menu"
            aria-label={text.contextMenu.title}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="context-menu-heading">
              <span>{text.contextMenu.title}</span>
              <small>
                {text.contextMenu.cell} {contextMenu.column + 1}:{contextMenu.row + 1}
              </small>
            </div>
            <button type="button" role="menuitem">{text.contextMenu.splitSquad}</button>
            <button type="button" role="menuitem">{text.contextMenu.mergeSquads}</button>
            <button type="button" role="menuitem" className="danger">
              {text.contextMenu.removeObject}
            </button>
          </section>
        </div>
      )}
    </main>
  )
}
