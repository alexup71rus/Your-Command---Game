import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ClickEffects, type ClickBurst, type ClickBurstKind, type ClickBurstVariant } from './components/ClickEffects'
import { FoundingPanel } from './components/FoundingPanel'
import { GameCommandDock } from './components/GameCommandDock'
import { GameHud } from './components/GameHud'
import { GameOutcomeModal } from './components/GameOutcomeModal'
import { GridCanvas, type CameraCommand, type MapClickRequest, type MapContextRequest } from './components/GridCanvas'
import { MapGeneratorModal } from './components/MapGeneratorModal'
import { SettingsModal } from './components/SettingsModal'
import { SavedGamesModal } from './components/SavedGamesModal'
import { StartMenu } from './components/StartMenu'
import { UtilityControls } from './components/UtilityControls'
import { gameConfig } from './config/game'
import type { TabId } from './config/localization'
import type { TaxRate } from './config/rules'
import { overlayAfterEscape, type GamePhase, type Overlay } from './game/flow'
import type { PendingGameAction } from './game/interaction'
import type { BuildingKind, ResourceId, TroopComposition, TroopKind } from './game/map'
import {
  build,
  buildingPlacementFailure,
  createMatch,
  defaultSplit,
  demolish,
  endTurn,
  isSamePosition,
  isRangedAttack,
  moveOrAttack,
  objectAt,
  recruit,
  recruitmentFailure,
  setTaxRate,
  splitFailure,
  splitSquad,
  squadSize,
  trade,
  type CommandResult,
  type MatchState,
} from './game/match'
import { createSavedMap, defaultMapSelection, loadSavedMaps, persistSavedMaps, savedSelection, type MapSelection, type SavedMapDraft } from './game/savedMaps'
import { deleteSavedGame, listSavedGames, loadSavedGame, saveGame, type SavedGameSummary } from './game/savedGames'
import { foundMatch, isCastleSiteValid, type CellPosition, type MapScenario } from './game/scenario'
import { useLocalization } from './hooks/useLocalization'
import { useNavigationHint } from './hooks/useNavigationHint'
import { useSoundEffects, type SoundEffect } from './hooks/useSoundEffects'

interface ContextMenuState extends MapContextRequest {
  left: number
  top: number
}

export function App() {
  const [phase, setPhase] = useState<GamePhase>('menu')
  const [selectedMap, setSelectedMap] = useState<MapSelection>(defaultMapSelection)
  const [savedMaps, setSavedMaps] = useState(loadSavedMaps)
  const [savedGames, setSavedGames] = useState<SavedGameSummary[]>([])
  const [savedGamesBusy, setSavedGamesBusy] = useState(false)
  const [savedGamesFeedback, setSavedGamesFeedback] = useState<string | null>(null)
  const [participantCount, setParticipantCount] = useState<number>(gameConfig.match.defaultParticipants)
  const [scenario, setScenario] = useState<MapScenario | null>(null)
  const [match, setMatch] = useState<MatchState | null>(null)
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)
  const [castleDraft, setCastleDraft] = useState<CellPosition | null>(null)
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null)
  const [unitAnimation, setUnitAnimation] = useState<{ key: number; from: CellPosition; to: CellPosition } | null>(null)
  const [territoriesHeld, setTerritoriesHeld] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('buildings')
  const [selectedCell, setSelectedCell] = useState<CellPosition | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingGameAction | null>(null)
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null)
  const [outcomeDismissed, setOutcomeDismissed] = useState(false)
  const [opponentTurn, setOpponentTurn] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [bursts, setBursts] = useState<ClickBurst[]>([])
  const [overlay, setOverlay] = useState<Overlay>(null)
  const burstId = useRef(0)
  const focusId = useRef(0)
  const unitAnimationId = useRef(0)
  const lastBurstVariant = useRef<ClickBurstVariant | null>(null)
  const { locale, setLocale, text } = useLocalization()
  const { visible: navigationHintVisible, markLearned } = useNavigationHint()
  const { enabled: soundEnabled, volume, play: playSound, setVolume, toggle: toggleSound } = useSoundEffects()

  useEffect(() => {
    listSavedGames().then(setSavedGames).catch(() => setSavedGames([]))
  }, [])

  const openSavedGames = useCallback(() => {
    setSavedGamesFeedback(null)
    setOverlay('saved-games')
  }, [])

  const saveCurrentGame = useCallback(async () => {
    if (!match || savedGamesBusy) return
    setSavedGamesBusy(true)
    setSavedGamesFeedback(null)
    try {
      const saved = await saveGame(match)
      setSavedGames((current) => [saved, ...current])
      setSavedGamesFeedback(text?.savedGames.saved ?? null)
      playSound('action')
    } catch {
      setSavedGamesFeedback(text?.savedGames.saveFailed ?? null)
      playSound('dismiss')
    } finally {
      setSavedGamesBusy(false)
    }
  }, [match, playSound, savedGamesBusy, text])

  const loadGame = useCallback(async (id: string) => {
    if (savedGamesBusy) return
    setSavedGamesBusy(true)
    setSavedGamesFeedback(null)
    try {
      const saved = await loadSavedGame(id)
      setMatch(saved.match)
      setScenario(saved.match.scenario)
      setParticipantCount(saved.match.scenario.participants.length)
      setSelectedRegionId(null)
      setCastleDraft(null)
      setSelectedCell(null)
      setPendingAction(null)
      setCommandFeedback(null)
      setTerritoriesHeld(false)
      setOutcomeDismissed(false)
      setOpponentTurn(false)
      setContextMenu(null)
      setOverlay(null)
      setPhase('playing')
      const focus = saved.match.scenario.cells.flatMap((row, rowIndex) => row.map((cell, column) => ({ cell, column, row: rowIndex })))
        .find(({ cell }) => cell.object?.type === 'castle' && cell.object.ownerId === saved.match.playerId)
      setCameraCommand(focus
        ? { kind: 'cell', column: focus.column, row: focus.row, zoom: gameConfig.camera.gameStartZoom, key: ++focusId.current }
        : { kind: 'overview', key: ++focusId.current })
      setUnitAnimation(null)
      playSound('action')
    } catch {
      setSavedGamesFeedback(text?.savedGames.loadFailed ?? null)
      playSound('dismiss')
    } finally {
      setSavedGamesBusy(false)
    }
  }, [playSound, savedGamesBusy, text])

  const removeSavedGame = useCallback(async (id: string) => {
    if (savedGamesBusy) return
    setSavedGamesBusy(true)
    try {
      await deleteSavedGame(id)
      setSavedGames((current) => current.filter((save) => save.id !== id))
    } finally {
      setSavedGamesBusy(false)
    }
  }, [savedGamesBusy])

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
    if (region) setCameraCommand({ kind: 'cell', ...region.center, zoom: gameConfig.camera.foundingZoom, key: ++focusId.current })
  }, [scenario])

  const beginFounding = useCallback((nextScenario: MapScenario) => {
    setScenario(nextScenario)
    setMatch(null)
    setSelectedRegionId(null)
    setCastleDraft(null)
    setContextMenu(null)
    setSelectedCell(null)
    setPendingAction(null)
    setCommandFeedback(null)
    setOpponentTurn(false)
    setOverlay(null)
    setCameraCommand({ kind: 'overview', key: ++focusId.current })
    setUnitAnimation(null)
    setPhase('founding')
  }, [])

  const openGenerator = useCallback(() => setOverlay('generator'), [])
  const closeGenerator = useCallback(() => setOverlay(null), [])

  const applyGeneratedScenario = useCallback((generatedScenario: MapScenario) => {
    beginFounding(generatedScenario)
  }, [beginFounding])

  const saveGeneratedMap = useCallback((draft: SavedMapDraft) => {
    const savedMap = createSavedMap(draft.name, draft.settings, draft.manualGrid)
    setSavedMaps((current) => {
      const next = [...current, savedMap]
      persistSavedMaps(next)
      return next
    })
    setSelectedMap(savedSelection(savedMap.id))
    setOverlay(null)
  }, [])

  const deleteSavedMap = useCallback((id: string) => {
    setSavedMaps((current) => {
      const next = current.filter((map) => map.id !== id)
      persistSavedMaps(next)
      return next
    })
    setSelectedMap((current) => current === savedSelection(id) ? defaultMapSelection : current)
  }, [])

  const returnToMainMenu = useCallback(() => {
    setScenario(null)
    setMatch(null)
    setSelectedRegionId(null)
    setCastleDraft(null)
    setCameraCommand(null)
    setUnitAnimation(null)
    setTerritoriesHeld(false)
    setContextMenu(null)
    setActiveTab('buildings')
    setSelectedCell(null)
    setPendingAction(null)
    setCommandFeedback(null)
    setOutcomeDismissed(false)
    setOpponentTurn(false)
    setOverlay(null)
    setPhase('menu')
  }, [])

  const selectRegion = useCallback((regionId: string | null) => {
    setSelectedRegionId(regionId)
    setCastleDraft(null)
    if (regionId) focusRegion(regionId)
    else setCameraCommand({ kind: 'overview', key: ++focusId.current })
  }, [focusRegion])

  const applyCommand = useCallback((result: CommandResult, nextSelection?: CellPosition, sound: SoundEffect = 'action') => {
    if (!result.ok) {
      if (text) setCommandFeedback(text.game.failures[result.reason])
      playSound('dismiss')
      return false
    }
    setMatch(result.state)
    setScenario(result.state.scenario)
    if (nextSelection) setSelectedCell(nextSelection)
    setPendingAction(null)
    setCommandFeedback(null)
    playSound(sound)
    return true
  }, [playSound, text])

  const handleMapClick = useCallback((request: MapClickRequest) => {
    if (phase === 'playing' && opponentTurn) return
    const position = { column: request.column, row: request.row }
    const selectedForGesture = phase === 'playing' && match && selectedCell ? objectAt(match, selectedCell) : null
    const targetForGesture = phase === 'playing' && match ? objectAt(match, position) : null
    const attackGesture = Boolean(selectedCell
      && selectedForGesture?.type === 'squad'
      && selectedForGesture.ownerId === match?.playerId
      && targetForGesture
      && targetForGesture.ownerId !== match?.playerId
      && (Math.abs(selectedCell.column - position.column) + Math.abs(selectedCell.row - position.row) === 1 || (match && isRangedAttack(match, selectedCell, position))))
    if (!attackGesture) {
      createBurst(request.clientX, request.clientY, 'map')
      playSound('map')
    }
    if (phase === 'playing' && match) {
      if (pendingAction?.kind === 'build') {
        applyCommand(build(match, pendingAction.building, position), position)
        return
      }
      if (pendingAction?.kind === 'recruit') {
        applyCommand(recruit(match, pendingAction.troop, pendingAction.quantity, position), position)
        return
      }
      if (pendingAction?.kind === 'split') {
        applyCommand(splitSquad(match, pendingAction.source, position, pendingAction.units), position)
        return
      }
      const selectedObject = selectedCell ? objectAt(match, selectedCell) : null
      if (selectedCell && selectedObject?.type === 'squad' && selectedObject.ownerId === match.playerId) {
        if (isSamePosition(selectedCell, position)) {
          setSelectedCell(null)
          setCommandFeedback(null)
          return
        }
        const target = objectAt(match, position)
        const attacking = Boolean(target && target.ownerId !== match.playerId)
        const result = moveOrAttack(match, selectedCell, position)
        if (result.ok || result.reason !== 'not-adjacent') {
          const sourceAfterAttack = result.ok && attacking ? objectAt(result.state, selectedCell) : null
          const nextSelection = sourceAfterAttack?.type === 'squad' && sourceAfterAttack.ownerId === match.playerId ? selectedCell : position
          if (result.ok) {
            const movedSquad = objectAt(result.state, position)
            const sourceAfter = objectAt(result.state, selectedCell)
            if (!sourceAfter && movedSquad?.type === 'squad' && movedSquad.ownerId === match.playerId && (result.state.lastEvent?.kind === 'moved' || result.state.lastEvent?.kind === 'destroyed')) {
              setUnitAnimation({ key: ++unitAnimationId.current, from: selectedCell, to: position })
            }
          }
          if (result.ok && attacking) createBurst(request.clientX, request.clientY, 'combat')
          applyCommand(result, nextSelection, attacking ? 'attack' : 'action')
          return
        }
        const clickedObject = objectAt(match, position)
        if (clickedObject?.type === 'squad' && clickedObject.ownerId === match.playerId) {
          setSelectedCell(position)
          setCommandFeedback(null)
        } else if (clickedObject) {
          setSelectedCell(position)
          setCommandFeedback(null)
        } else {
          setSelectedCell(null)
          setCommandFeedback(null)
        }
        return
      }
      setSelectedCell(position)
      setCommandFeedback(null)
      return
    }
    if (phase !== 'founding' || !scenario) return
    const regionId = scenario.territories[request.row]?.[request.column] ?? null
    if (!selectedRegionId) {
      if (regionId) selectRegion(regionId)
      return
    }
    setCastleDraft(position)
  }, [applyCommand, createBurst, match, opponentTurn, pendingAction, phase, playSound, scenario, selectRegion, selectedCell, selectedRegionId])

  const confirmFounding = useCallback(() => {
    if (!scenario || !selectedRegionId || !castleDraft || !isCastleSiteValid(scenario, selectedRegionId, castleDraft)) return
    const foundedScenario = foundMatch(scenario, selectedRegionId, castleDraft)
    setScenario(foundedScenario)
    setMatch(createMatch(foundedScenario))
    setCameraCommand({ kind: 'cell', ...castleDraft, zoom: gameConfig.camera.gameStartZoom, key: ++focusId.current })
    setPhase('playing')
    setTerritoriesHeld(false)
    setOutcomeDismissed(false)
    setOpponentTurn(false)
    playSound('action')
  }, [castleDraft, playSound, scenario, selectedRegionId])

  const startBuilding = useCallback((building: BuildingKind) => {
    if (opponentTurn) return
    setPendingAction({ kind: 'build', building })
    setCommandFeedback(null)
  }, [opponentTurn])

  const startRecruitment = useCallback((troop: TroopKind, quantity: number) => {
    if (opponentTurn) return
    setPendingAction({ kind: 'recruit', troop, quantity })
    setCommandFeedback(null)
  }, [opponentTurn])

  const changeTaxRate = useCallback((rate: TaxRate) => {
    if (!match || opponentTurn) return
    applyCommand(setTaxRate(match, rate), selectedCell ?? undefined)
  }, [applyCommand, match, opponentTurn, selectedCell])

  const tradeAtMarket = useCallback((position: CellPosition, resource: Exclude<ResourceId, 'gold'>, direction: 'buy' | 'sell', quantity: number) => {
    if (!match || opponentTurn) return
    applyCommand(trade(match, position, resource, direction, quantity), position)
  }, [applyCommand, match, opponentTurn])

  const startSplit = useCallback((source: CellPosition) => {
    if (!match || opponentTurn) return
    const object = objectAt(match, source)
    if (object?.type !== 'squad' || object.ownerId !== match.playerId || squadSize(object) < 2) return
    setSelectedCell(source)
    setPendingAction({ kind: 'split', source, units: defaultSplit(object) })
    setContextMenu(null)
    setCommandFeedback(null)
  }, [match, opponentTurn])

  const changeSplit = useCallback((units: TroopComposition) => {
    setPendingAction((current) => current?.kind === 'split' ? { ...current, units } : current)
  }, [])

  const finishTurn = useCallback(() => {
    if (!match || opponentTurn) return
    setOpponentTurn(true)
    setPendingAction(null)
    setContextMenu(null)
    setCommandFeedback(null)
    setSelectedCell(null)
    playSound('action')
  }, [match, opponentTurn, playSound])

  const actionCellValid = useCallback((position: CellPosition) => {
    if (!match || !pendingAction || opponentTurn) return false
    if (pendingAction.kind === 'build') return buildingPlacementFailure(match, pendingAction.building, position) === null
    if (pendingAction.kind === 'recruit') return recruitmentFailure(match, pendingAction.troop, pendingAction.quantity, position) === null
    return splitFailure(match, pendingAction.source, position, pendingAction.units) === null
  }, [match, opponentTurn, pendingAction])

  const openContextMenu = useCallback((request: MapContextRequest) => {
    if (phase !== 'playing' || opponentTurn) return
    const menuWidth = 270
    const menuHeight = 220
    const viewportPadding = 16
    setContextMenu({ ...request, left: Math.max(viewportPadding, Math.min(request.clientX + 8, window.innerWidth - menuWidth - viewportPadding)), top: Math.max(viewportPadding, Math.min(request.clientY + 8, window.innerHeight - menuHeight - viewportPadding)) })
    createBurst(request.clientX, request.clientY, 'context')
    playSound('context')
  }, [createBurst, opponentTurn, phase, playSound])

  const removeContextObject = useCallback(() => {
    if (!match || !contextMenu || opponentTurn) return
    applyCommand(demolish(match, contextMenu), contextMenu)
    setContextMenu(null)
  }, [applyCommand, contextMenu, match, opponentTurn])

  const handleInterfacePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.grid-canvas')) return
    if (target.closest('button:disabled')) return
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

  useEffect(() => {
    if (!opponentTurn || !match) return
    const timeout = window.setTimeout(() => {
      const result = endTurn(match)
      if (result.ok) {
        setMatch(result.state)
        setScenario(result.state.scenario)
      }
      setOpponentTurn(false)
    }, gameConfig.turn.opponentDelayMs)
    return () => window.clearTimeout(timeout)
  }, [match, opponentTurn])

  useEffect(() => {
    if (!commandFeedback) return
    const timeout = window.setTimeout(() => setCommandFeedback(null), 3200)
    return () => window.clearTimeout(timeout)
  }, [commandFeedback])

  if (!text) return <main className="game-shell loading-shell" aria-busy="true" />
  const utilityControls = <UtilityControls settingsLabel={text.settings.title} settingsHint={text.interface.settingsHint} soundEnabled={soundEnabled} soundEnableLabel={text.sound.enable} soundDisableLabel={text.sound.disable} onOpenSettings={() => { setTerritoriesHeld(false); setOverlay('settings') }} onToggleSound={toggleSound} />
  if (phase === 'menu') {
    return (
      <div className="start-shell" onPointerDownCapture={handleInterfacePointerDown}>
        <StartMenu text={text.startMenu} confirmationText={text.confirmation} selectedMap={selectedMap} savedMaps={savedMaps} participantCount={participantCount} utilityControls={utilityControls} onMapChange={setSelectedMap} onDeleteSavedMap={deleteSavedMap} onParticipantChange={setParticipantCount} onOpenGenerator={openGenerator} onStart={beginFounding} hasSavedGames={savedGames.length > 0} onOpenSavedGames={openSavedGames} />
        <ClickEffects bursts={bursts} />
        {overlay === 'generator' && (
          <MapGeneratorModal text={text.generator} locale={locale} participantCount={participantCount} savedMapCount={savedMaps.length} onParticipantChange={setParticipantCount} onClose={closeGenerator} onSave={saveGeneratedMap} onApply={applyGeneratedScenario} />
        )}
        {overlay === 'settings' && <SettingsModal locale={locale} text={text} soundEnabled={soundEnabled} volume={volume} onClose={() => setOverlay(null)} onLocaleChange={setLocale} onSoundToggle={toggleSound} onVolumeChange={setVolume} />}
        {overlay === 'saved-games' && <SavedGamesModal locale={locale} text={text} saves={savedGames} canSave={false} busy={savedGamesBusy} feedback={savedGamesFeedback} onClose={() => setOverlay(null)} onSave={saveCurrentGame} onLoad={loadGame} onDelete={removeSavedGame} />}
      </div>
    )
  }

  const activeScenario = match?.scenario ?? scenario
  if (!activeScenario) return null
  const draftValid = Boolean(selectedRegionId && castleDraft && isCastleSiteValid(activeScenario, selectedRegionId, castleDraft))
  const actionPreview = pendingAction?.kind === 'build'
    ? { kind: 'building' as const, building: pendingAction.building }
    : pendingAction?.kind === 'recruit'
      ? { kind: 'squad' as const, count: pendingAction.quantity }
      : pendingAction?.kind === 'split'
        ? { kind: 'squad' as const, count: squadSize({ units: pendingAction.units }) }
        : null
  const contextObject = match && contextMenu ? objectAt(match, contextMenu) : null
  const contextOwned = contextObject?.ownerId === match?.playerId
  const selectedMapObject = match && selectedCell ? objectAt(match, selectedCell) : null
  const movementSource = phase === 'playing'
    && !opponentTurn
    && !pendingAction
    && selectedMapObject?.type === 'squad'
    && selectedMapObject.ownerId === match?.playerId
    ? selectedCell
    : null

  return (
    <main className={`game-shell phase-${phase}`} onPointerDownCapture={handleInterfacePointerDown}>
      <GridCanvas map={activeScenario.cells} territories={activeScenario.territories} regions={activeScenario.regions} participants={activeScenario.participants} showTerritories={phase === 'founding' || territoriesHeld} mode={phase} selectedRegionId={selectedRegionId} castleDraft={castleDraft} selectedCell={phase === 'playing' ? selectedCell : null} movementSource={movementSource} movementOrdersRemaining={match?.ordersRemaining} unitAnimation={unitAnimation} actionPreview={actionPreview} isActionCellValid={actionCellValid} cameraCommand={cameraCommand} ariaLabel={text.interface.mapAria} onContextRequest={openContextMenu} onMapClick={handleMapClick} onNavigate={markLearned} />
      <ClickEffects bursts={bursts} />

      {phase === 'playing' && match && <>
        <GameHud match={match} text={text} opponentTurn={opponentTurn} onEndTurn={finishTurn} />
        <GameCommandDock match={match} selectedCell={selectedCell} activeTab={activeTab} pendingAction={pendingAction} locked={opponentTurn} text={text} feedback={commandFeedback} onTabChange={(tab) => { setActiveTab(tab); setSelectedCell(null); setPendingAction(null); setCommandFeedback(null) }} onChooseBuild={startBuilding} onChooseRecruit={startRecruitment} onSplit={startSplit} onSplitChange={changeSplit} onCancelAction={() => setPendingAction(null)} onSetTaxRate={changeTaxRate} onTrade={tradeAtMarket} />
        {navigationHintVisible && <div className="map-hint" aria-live="polite"><span className="mouse-symbol" />{text.interface.mapHint}</div>}
      </>}

      {phase === 'founding' && <FoundingPanel scenario={activeScenario} selectedRegionId={selectedRegionId} castleDraft={castleDraft} draftValid={draftValid} locale={locale} text={text.founding} onSelectRegion={selectRegion} onConfirm={confirmFounding} />}

      {utilityControls}

      {contextMenu && <div className="context-backdrop" onPointerDown={() => setContextMenu(null)} role="presentation"><section className="context-menu" style={{ left: contextMenu.left, top: contextMenu.top }} role="menu" aria-label={text.contextMenu.title} onPointerDown={(event) => event.stopPropagation()}><div className="context-menu-heading"><span>{text.contextMenu.title}</span><small>{text.contextMenu.cell} {contextMenu.column + 1}:{contextMenu.row + 1}</small></div>{contextObject?.type === 'squad' && contextOwned && squadSize(contextObject) > 1 && <button type="button" role="menuitem" onClick={() => startSplit(contextMenu)}>{text.contextMenu.splitSquad}</button>}{contextObject?.type === 'squad' && contextOwned && <button type="button" role="menuitem" onClick={() => { setSelectedCell(contextMenu); setPendingAction(null); setCommandFeedback(text.game.moveHint); setContextMenu(null) }}>{text.contextMenu.mergeSquads}</button>}{contextObject && contextOwned && contextObject.type !== 'castle' && <button type="button" role="menuitem" className="danger" onClick={removeContextObject}>{text.contextMenu.removeObject}</button>}{(!contextObject || !contextOwned || contextObject.type === 'castle') && <p className="context-menu-empty">{text.game.selectCell}</p>}</section></div>}

      {match?.status === 'won' && !outcomeDismissed && <GameOutcomeModal text={text.game} onContinue={() => setOutcomeDismissed(true)} />}

      {overlay === 'settings' && <SettingsModal locale={locale} text={text} soundEnabled={soundEnabled} volume={volume} onClose={() => setOverlay(null)} onLocaleChange={setLocale} onSoundToggle={toggleSound} onVolumeChange={setVolume} onReturnToMenu={returnToMainMenu} onOpenSavedGames={openSavedGames} />}
      {overlay === 'saved-games' && <SavedGamesModal locale={locale} text={text} saves={savedGames} canSave busy={savedGamesBusy} feedback={savedGamesFeedback} onClose={() => setOverlay(null)} onSave={saveCurrentGame} onLoad={loadGame} onDelete={removeSavedGame} />}
    </main>
  )
}
