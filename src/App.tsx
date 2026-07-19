import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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
import { ConfirmDialog } from './components/ui/ConfirmDialog'
import { gameConfig } from './config/game'
import type { LocaleDictionary, TabId } from './config/localization'
import { buildingRules, resourceIds, troopRules, type TaxRate } from './config/rules'
import { escapeTarget, overlayAfterEscape, savedGameLoadNeedsConfirmation, type GamePhase, type Overlay } from './game/flow'
import type { PendingGameAction } from './game/interaction'
import type { BuildingKind, ResourceId, TroopComposition, TroopKind } from './game/map'
import {
  build,
  buildingPlacementFailure,
  createMatch,
  defaultSplit,
  demolitionRefundFor,
  demolish,
  dismissFailure,
  dismissSquad,
  endTurn,
  garrisonFailure,
  garrisonTower,
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
  towerAttack,
  towerAttackFailure,
  trade,
  ungarrisonFailure,
  ungarrisonTower,
  type CommandResult,
  type MatchState,
  type TurnReport,
} from './game/match'
import { squadMovementOrderCostBetween } from './game/movement'
import { findMovementPath } from './game/pathfinding'
import { createSavedMap, defaultMapSelection, loadSavedMapsResult, persistSavedMaps, savedSelection, type MapSelection, type SavedMapDraft } from './game/savedMaps'
import { deleteSavedGame, listSavedGames, loadSavedGame, saveGame, type SavedGameSummary } from './game/savedGames'
import { foundMatch, isCastleSiteValid, type CellPosition, type MapScenario } from './game/scenario'
import { createVisibilitySelector, hasVisibleEnemyThreat, visibleObjectAt } from './game/visibility'
import { useLocalization } from './hooks/useLocalization'
import { useMapGrid } from './hooks/useMapGrid'
import { useMusic, type MusicScene } from './hooks/useMusic'
import { useNavigationHint } from './hooks/useNavigationHint'
import { useSoundEffects, type SoundEffect } from './hooks/useSoundEffects'

interface ContextMenuState extends MapContextRequest {
  left: number
  top: number
}

function turnReportMessage(report: TurnReport | undefined, text: LocaleDictionary) {
  if (!report) return null
  const messages: string[] = []
  if (report.desertion) messages.push(text.game.turnDesertion.replace('{unit}', text.game.troopNames[report.desertion.kind]))
  if (report.populationReason === 'starvation') messages.push(text.game.turnStarvation)
  else if (report.populationReason === 'capacity') messages.push(text.game.turnCapacityLoss)
  if (report.starvation && report.starvation !== 'civilian') messages.push(text.game.turnStarvationTroop.replace('{unit}', text.game.troopNames[report.starvation.kind]))
  return messages.join(' ') || null
}

function demolitionRefundText(refund: ReturnType<typeof demolitionRefundFor>, text: LocaleDictionary, locale: string) {
  const parts = resourceIds.flatMap((resource) => {
    const amount = refund[resource] ?? 0
    return amount > 0 ? [`${amount} ${text.game.resourceNames[resource].toLocaleLowerCase(locale)}`] : []
  })
  return parts.length > 0 ? `${text.contextMenu.refund}: ${parts.join(' · ')}` : text.contextMenu.refundNone
}

export function App() {
  const [phase, setPhase] = useState<GamePhase>('menu')
  const [selectedMap, setSelectedMap] = useState<MapSelection>(defaultMapSelection)
  const [initialSavedMaps] = useState(loadSavedMapsResult)
  const [savedMaps, setSavedMaps] = useState(initialSavedMaps.maps)
  const [savedMapsFeedback, setSavedMapsFeedback] = useState<string | null>(null)
  const [savedGames, setSavedGames] = useState<SavedGameSummary[]>([])
  const [savedGamesBusy, setSavedGamesBusy] = useState(false)
  const [savedGamesFeedback, setSavedGamesFeedback] = useState<string | null>(null)
  const [savedGamesReadFailed, setSavedGamesReadFailed] = useState(false)
  const [pendingLoadId, setPendingLoadId] = useState<string | null>(null)
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
  const [autoMoveTarget, setAutoMoveTarget] = useState<CellPosition | null>(null)
  const [autoMovePath, setAutoMovePath] = useState<CellPosition[] | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingGameAction | null>(null)
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null)
  const [hoveredOrderCost, setHoveredOrderCost] = useState(0)
  const [outcomeDismissed, setOutcomeDismissed] = useState(false)
  const [opponentTurn, setOpponentTurn] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [bursts, setBursts] = useState<ClickBurst[]>([])
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [savedGamesReturnToSettings, setSavedGamesReturnToSettings] = useState(false)
  const [recentCombat, setRecentCombat] = useState(false)
  const burstId = useRef(0)
  const focusId = useRef(0)
  const unitAnimationId = useRef(0)
  const lastBurstVariant = useRef<ClickBurstVariant | null>(null)
  const combatMusicTimer = useRef<number | null>(null)
  const visibilitySelector = useMemo(() => createVisibilitySelector(), [])
  const { locale, setLocale, text, status: localizationStatus, retry: retryLocalization } = useLocalization()
  const { visible: showGrid, setVisible: setShowGrid } = useMapGrid()
  const { visible: navigationHintVisible, markLearned } = useNavigationHint()
  const { enabled: soundEnabled, volume, play: playSound, setVolume, toggle: toggleSound } = useSoundEffects()
  const matchCells = match?.scenario.cells
  const matchPlayerId = match?.playerId
  const visibility = useMemo(
    () => matchCells && matchPlayerId ? visibilitySelector(matchCells, matchPlayerId) : null,
    [matchCells, matchPlayerId, visibilitySelector],
  )
  const visibleEnemyNearby = useMemo(() => {
    if (phase !== 'playing' || !matchCells || !matchPlayerId || !visibility) return false
    return hasVisibleEnemyThreat(matchCells, visibility, matchPlayerId)
  }, [matchCells, matchPlayerId, phase, visibility])
  const musicScene: MusicScene = phase !== 'playing' || overlay !== null
    ? 'menu'
    : visibleEnemyNearby || recentCombat
      ? 'battle'
      : 'settlement'
  const { volume: musicVolume, setVolume: setMusicVolume } = useMusic(musicScene, soundEnabled)

  const currentVisibleObjectAt = useCallback((position: CellPosition) => {
    if (!matchCells || !matchPlayerId) return undefined
    return visibleObjectAt(matchCells, visibility, matchPlayerId, position)
  }, [matchCells, matchPlayerId, visibility])

  const cancelAutoMove = useCallback(() => {
    setAutoMoveTarget(null)
    setAutoMovePath(null)
  }, [])

  const markRecentCombat = useCallback(() => {
    if (combatMusicTimer.current !== null) window.clearTimeout(combatMusicTimer.current)
    setRecentCombat(true)
    combatMusicTimer.current = window.setTimeout(() => {
      setRecentCombat(false)
      combatMusicTimer.current = null
    }, gameConfig.audio.combatMusicHoldMs)
  }, [])

  useEffect(() => () => {
    if (combatMusicTimer.current !== null) window.clearTimeout(combatMusicTimer.current)
  }, [])

  useEffect(() => {
    listSavedGames()
      .then((saves) => {
        setSavedGames(saves)
        setSavedGamesReadFailed(false)
      })
      .catch(() => {
        setSavedGames([])
        setSavedGamesReadFailed(true)
      })
  }, [])

  const openSavedGames = useCallback((returnToSettings = false) => {
    setSavedGamesFeedback(savedGamesReadFailed ? text?.savedGames.readFailed ?? text?.savedGames.loadFailed ?? null : null)
    setSavedGamesReturnToSettings(returnToSettings)
    setOverlay('saved-games')
  }, [savedGamesReadFailed, text])

  const closeSavedGames = useCallback(() => {
    setOverlay(savedGamesReturnToSettings ? 'settings' : null)
    setSavedGamesReturnToSettings(false)
  }, [savedGamesReturnToSettings])

  const saveCurrentGame = useCallback(async () => {
    if (!match || savedGamesBusy || opponentTurn) return
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
  }, [match, opponentTurn, playSound, savedGamesBusy, text])

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
      cancelAutoMove()
      setPendingAction(null)
      setCommandFeedback(null)
      setHoveredOrderCost(0)
      setTerritoriesHeld(false)
      setOutcomeDismissed(false)
      setOpponentTurn(false)
      setContextMenu(null)
      setPendingLoadId(null)
      setSavedGamesReturnToSettings(false)
      setOverlay(null)
      setPhase('playing')
      setRecentCombat(false)
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
  }, [cancelAutoMove, playSound, savedGamesBusy, text])

  const requestLoadGame = useCallback((id: string) => {
    if (savedGameLoadNeedsConfirmation(phase, Boolean(match))) {
      setPendingLoadId(id)
      return
    }
    void loadGame(id)
  }, [loadGame, match, phase])

  const removeSavedGame = useCallback(async (id: string) => {
    if (savedGamesBusy) return
    setSavedGamesBusy(true)
    setSavedGamesFeedback(null)
    try {
      await deleteSavedGame(id)
      setSavedGames((current) => current.filter((save) => save.id !== id))
    } catch {
      setSavedGamesFeedback(text?.savedGames.deleteFailed ?? text?.savedGames.loadFailed ?? null)
      playSound('dismiss')
    } finally {
      setSavedGamesBusy(false)
    }
  }, [playSound, savedGamesBusy, text])

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
    cancelAutoMove()
    setPendingAction(null)
    setCommandFeedback(null)
    setHoveredOrderCost(0)
    setOpponentTurn(false)
    setPendingLoadId(null)
    setSavedGamesReturnToSettings(false)
    setOverlay(null)
    setCameraCommand({ kind: 'overview', key: ++focusId.current })
    setUnitAnimation(null)
    setPhase('founding')
  }, [cancelAutoMove])

  const openGenerator = useCallback(() => setOverlay('generator'), [])
  const closeGenerator = useCallback(() => setOverlay(null), [])

  const applyGeneratedScenario = useCallback((generatedScenario: MapScenario) => {
    beginFounding(generatedScenario)
  }, [beginFounding])

  const saveGeneratedMap = useCallback((draft: SavedMapDraft) => {
    const savedMap = createSavedMap(draft.name, draft.settings, draft.manualGrid)
    const next = [...savedMaps, savedMap]
    const persisted = persistSavedMaps(next)
    if (!persisted.ok) {
      setSavedMapsFeedback(text?.startMenu.mapSaveFailed ?? null)
      return false
    }
    setSavedMaps(next)
    setSavedMapsFeedback(null)
    setSelectedMap(savedSelection(savedMap.id))
    setOverlay(null)
    return true
  }, [savedMaps, text])

  const deleteSavedMap = useCallback((id: string) => {
    const next = savedMaps.filter((map) => map.id !== id)
    const persisted = persistSavedMaps(next)
    if (!persisted.ok) {
      setSavedMapsFeedback(text?.startMenu.mapDeleteFailed ?? null)
      return
    }
    setSavedMaps(next)
    setSavedMapsFeedback(null)
    setSelectedMap((current) => current === savedSelection(id) ? defaultMapSelection : current)
  }, [savedMaps, text])

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
    cancelAutoMove()
    setPendingAction(null)
    setCommandFeedback(null)
    setHoveredOrderCost(0)
    setOutcomeDismissed(false)
    setOpponentTurn(false)
    setPendingLoadId(null)
    setSavedGamesReturnToSettings(false)
    setOverlay(null)
    setPhase('menu')
    setRecentCombat(false)
  }, [cancelAutoMove])

  const selectRegion = useCallback((regionId: string | null) => {
    setSelectedRegionId(regionId)
    setCastleDraft(null)
    if (regionId) focusRegion(regionId)
    else setCameraCommand({ kind: 'overview', key: ++focusId.current })
  }, [focusRegion])

  const applyCommand = useCallback((result: CommandResult, nextSelection?: CellPosition, sound: SoundEffect = 'action') => {
    if (!result.ok) {
      if (text) setCommandFeedback(text.game.failures[result.reason] || result.reason)
      playSound('dismiss')
      return false
    }
    setMatch(result.state)
    setScenario(result.state.scenario)
    if (nextSelection) setSelectedCell(nextSelection)
    setPendingAction(null)
    setCommandFeedback(null)
    setHoveredOrderCost(0)
    if (result.state.lastEvent?.kind === 'attacked' || result.state.lastEvent?.kind === 'destroyed') markRecentCombat()
    playSound(sound)
    return true
  }, [markRecentCombat, playSound, text])

  const handleMapClick = useCallback((request: MapClickRequest) => {
    if (phase === 'playing' && opponentTurn) return
    cancelAutoMove()
    const position = { column: request.column, row: request.row }
    const selectedForGesture = phase === 'playing' && selectedCell ? currentVisibleObjectAt(selectedCell) : null
    const targetForGesture = phase === 'playing' ? currentVisibleObjectAt(position) : null
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
      if (match.status !== 'playing') {
        setSelectedCell(position)
        setPendingAction(null)
        setCommandFeedback(null)
        return
      }
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
      if (pendingAction?.kind === 'dismiss') return
      if (pendingAction?.kind === 'garrison-enter') {
        applyCommand(garrisonTower(match, position, pendingAction.tower), pendingAction.tower)
        return
      }
      if (pendingAction?.kind === 'garrison-exit') {
        applyCommand(ungarrisonTower(match, pendingAction.tower, position), position)
        return
      }
      if (pendingAction?.kind === 'tower-attack') {
        if (!currentVisibleObjectAt(position)) {
          setCommandFeedback(text?.game.failures['requires-target'] ?? null)
          playSound('dismiss')
          return
        }
        const result = towerAttack(match, pendingAction.tower, position)
        if (result.ok) createBurst(request.clientX, request.clientY, 'combat')
        applyCommand(result, pendingAction.tower, result.ok ? 'attack' : 'dismiss')
        return
      }
      const selectedObject = selectedCell ? currentVisibleObjectAt(selectedCell) : null
      if (selectedCell && selectedObject?.type === 'squad' && selectedObject.ownerId === match.playerId) {
        if (isSamePosition(selectedCell, position)) {
          setSelectedCell(null)
          setCommandFeedback(null)
          return
        }
        const target = objectAt(match, position)
        const visibleTarget = currentVisibleObjectAt(position)
        const targetDistance = Math.abs(selectedCell.column - position.column) + Math.abs(selectedCell.row - position.row)
        if (target && target.ownerId !== match.playerId && !visibleTarget && targetDistance > 1) {
          setSelectedCell(null)
          setCommandFeedback(null)
          return
        }
        if (target?.type === 'building' && target.kind === 'tower' && target.ownerId === match.playerId) {
          applyCommand(garrisonTower(match, selectedCell, position), position)
          return
        }
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
        const clickedObject = currentVisibleObjectAt(position)
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
      setSelectedCell(objectAt(match, position) && !currentVisibleObjectAt(position) ? null : position)
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
  }, [applyCommand, cancelAutoMove, createBurst, currentVisibleObjectAt, match, opponentTurn, pendingAction, phase, playSound, scenario, selectRegion, selectedCell, selectedRegionId, text])

  const confirmFounding = useCallback(() => {
    if (!scenario || !selectedRegionId || !castleDraft || !isCastleSiteValid(scenario, selectedRegionId, castleDraft)) return
    const foundedScenario = foundMatch(scenario, selectedRegionId, castleDraft)
    setScenario(foundedScenario)
    setMatch(createMatch(foundedScenario))
    cancelAutoMove()
    setCameraCommand({ kind: 'cell', ...castleDraft, zoom: gameConfig.camera.gameStartZoom, key: ++focusId.current })
    setPhase('playing')
    setTerritoriesHeld(false)
    setOutcomeDismissed(false)
    setOpponentTurn(false)
    playSound('action')
  }, [cancelAutoMove, castleDraft, playSound, scenario, selectedRegionId])

  const startBuilding = useCallback((building: BuildingKind) => {
    if (opponentTurn) return
    cancelAutoMove()
    setPendingAction({ kind: 'build', building })
    setCommandFeedback(null)
    setHoveredOrderCost(0)
  }, [cancelAutoMove, opponentTurn])

  const startRecruitment = useCallback((troop: TroopKind, quantity: number) => {
    if (opponentTurn) return
    cancelAutoMove()
    setPendingAction({ kind: 'recruit', troop, quantity })
    setCommandFeedback(null)
    setHoveredOrderCost(0)
  }, [cancelAutoMove, opponentTurn])

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
    cancelAutoMove()
    setSelectedCell(source)
    setPendingAction({ kind: 'split', source, units: defaultSplit(object) })
    setContextMenu(null)
    setCommandFeedback(null)
    setHoveredOrderCost(0)
  }, [cancelAutoMove, match, opponentTurn])

  const startDismiss = useCallback((source: CellPosition) => {
    if (!match || opponentTurn) return
    const object = objectAt(match, source)
    if (object?.type !== 'squad' || object.ownerId !== match.playerId || squadSize(object) < 2) return
    cancelAutoMove()
    setSelectedCell(source)
    setPendingAction({ kind: 'dismiss', source, units: defaultSplit(object) })
    setContextMenu(null)
    setCommandFeedback(null)
    setHoveredOrderCost(0)
  }, [cancelAutoMove, match, opponentTurn])

  const changeComposition = useCallback((units: TroopComposition) => {
    setPendingAction((current) => current?.kind === 'split' || current?.kind === 'dismiss' ? { ...current, units } : current)
  }, [])

  const confirmDismiss = useCallback(() => {
    if (!match || pendingAction?.kind !== 'dismiss' || opponentTurn) return
    applyCommand(dismissSquad(match, pendingAction.source, pendingAction.units), pendingAction.source)
  }, [applyCommand, match, opponentTurn, pendingAction])

  const startTowerAction = useCallback((kind: 'garrison-enter' | 'garrison-exit' | 'tower-attack', tower: CellPosition) => {
    if (!match || opponentTurn) return
    const object = objectAt(match, tower)
    if (object?.type !== 'building' || object.kind !== 'tower' || object.ownerId !== match.playerId) return
    cancelAutoMove()
    setSelectedCell(tower)
    setPendingAction({ kind, tower })
    setCommandFeedback(null)
    setHoveredOrderCost(0)
  }, [cancelAutoMove, match, opponentTurn])

  const finishTurn = useCallback(() => {
    if (!match || opponentTurn) return
    cancelAutoMove()
    setOpponentTurn(true)
    setPendingAction(null)
    setContextMenu(null)
    setCommandFeedback(null)
    setHoveredOrderCost(0)
    setSelectedCell(null)
    playSound('action')
  }, [cancelAutoMove, match, opponentTurn, playSound])

  const actionCellValid = useCallback((position: CellPosition) => {
    if (!match || !pendingAction || opponentTurn) return false
    if (pendingAction.kind === 'build') return buildingPlacementFailure(match, pendingAction.building, position) === null
    if (pendingAction.kind === 'recruit') return recruitmentFailure(match, pendingAction.troop, pendingAction.quantity, position) === null
    if (pendingAction.kind === 'split') return splitFailure(match, pendingAction.source, position, pendingAction.units) === null
    if (pendingAction.kind === 'dismiss') return dismissFailure(match, pendingAction.source, pendingAction.units) === null
    if (pendingAction.kind === 'garrison-enter') return garrisonFailure(match, position, pendingAction.tower) === null
    if (pendingAction.kind === 'garrison-exit') return ungarrisonFailure(match, pendingAction.tower, position) === null
    return towerAttackFailure(match, pendingAction.tower, position) === null && Boolean(currentVisibleObjectAt(position))
  }, [currentVisibleObjectAt, match, opponentTurn, pendingAction])

  const openContextMenu = useCallback((request: MapContextRequest) => {
    if (phase !== 'playing' || opponentTurn || match?.status !== 'playing') return
    cancelAutoMove()
    const menuWidth = 270
    const menuHeight = 220
    const viewportPadding = 16
    setContextMenu({ ...request, left: Math.max(viewportPadding, Math.min(request.clientX + 8, window.innerWidth - menuWidth - viewportPadding)), top: Math.max(viewportPadding, Math.min(request.clientY + 8, window.innerHeight - menuHeight - viewportPadding)) })
    createBurst(request.clientX, request.clientY, 'context')
    playSound('context')
  }, [cancelAutoMove, createBurst, match?.status, opponentTurn, phase, playSound])

  const startAutoMovement = useCallback(() => {
    if (!match || !contextMenu || !selectedCell || opponentTurn) return
    const squad = objectAt(match, selectedCell)
    if (squad?.type !== 'squad' || squad.ownerId !== match.playerId) return
    const target = { column: contextMenu.column, row: contextMenu.row }
    const path = findMovementPath(match.scenario.cells, selectedCell, target, {
      ownerId: match.playerId,
      canEnterOccupiedCell: (position) => Boolean(objectAt(match, position) && !visibleObjectAt(match.scenario.cells, visibility, match.playerId, position)),
    })
    setContextMenu(null)
    setPendingAction(null)
    if (!path || path.length < 2) {
      setCommandFeedback(text?.game.routeUnavailable ?? null)
      cancelAutoMove()
      return
    }
    setCommandFeedback(null)
    setAutoMoveTarget(target)
    setAutoMovePath(path)
  }, [cancelAutoMove, contextMenu, match, opponentTurn, selectedCell, text, visibility])

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
    if (!autoMoveTarget) return
    const timeout = window.setTimeout(() => {
      if (phase !== 'playing' || opponentTurn || overlay !== null || pendingAction || !match || !selectedCell) {
        cancelAutoMove()
        return
      }
      const squad = objectAt(match, selectedCell)
      if (squad?.type !== 'squad' || squad.ownerId !== match.playerId || isSamePosition(selectedCell, autoMoveTarget)) {
        cancelAutoMove()
        return
      }
      const path = findMovementPath(match.scenario.cells, selectedCell, autoMoveTarget, {
        ownerId: match.playerId,
        canEnterOccupiedCell: (position) => Boolean(objectAt(match, position) && !visibleObjectAt(match.scenario.cells, visibility, match.playerId, position)),
      })
      if (!path || path.length < 2) {
        setCommandFeedback(text?.game.routeUnavailable ?? null)
        cancelAutoMove()
        return
      }
      setAutoMovePath(path)
      const next = path[1]
      const destination = match.scenario.cells[next.row]?.[next.column]
      const stepOrderCost = destination?.object
        ? gameConfig.turn.movementOrderCost
        : squadMovementOrderCostBetween(match.scenario.cells, squad, selectedCell, next) ?? Number.POSITIVE_INFINITY
      if (!destination || match.ordersRemaining < stepOrderCost) {
        setCommandFeedback(text?.game.routeOrdersFinished ?? null)
        cancelAutoMove()
        return
      }
      const result = moveOrAttack(match, selectedCell, next)
      if (!result.ok) {
        setCommandFeedback(result.reason === 'not-enough-orders' ? text?.game.routeOrdersFinished ?? null : text?.game.failures[result.reason] ?? null)
        cancelAutoMove()
        playSound('dismiss')
        return
      }
      const sourceAfter = objectAt(result.state, selectedCell)
      const destinationAfter = objectAt(result.state, next)
      const moved = !sourceAfter && destinationAfter?.type === 'squad' && destinationAfter.ownerId === match.playerId
      if (moved) setUnitAnimation({ key: ++unitAnimationId.current, from: selectedCell, to: next })
      setMatch(result.state)
      setScenario(result.state.scenario)
      setSelectedCell(sourceAfter?.type === 'squad' && sourceAfter.ownerId === match.playerId ? selectedCell : moved ? next : null)
      setCommandFeedback(null)
      if (result.state.lastEvent?.kind === 'attacked' || result.state.lastEvent?.kind === 'destroyed') markRecentCombat()
      playSound(result.state.lastEvent?.kind === 'attacked' || result.state.lastEvent?.kind === 'destroyed' ? 'attack' : 'action')
    }, gameConfig.turn.autoMoveStepDelayMs)
    return () => window.clearTimeout(timeout)
  }, [autoMoveTarget, cancelAutoMove, markRecentCombat, match, opponentTurn, overlay, pendingAction, phase, playSound, selectedCell, text, visibility])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift' && phase !== 'menu' && overlay === null) setTerritoriesHeld(true)
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (event.repeat) return
      setTerritoriesHeld(false)
      cancelAutoMove()
      const target = escapeTarget({
        contextMenuOpen: Boolean(contextMenu),
        overlay,
        outcomeOpen: match?.status === 'won' && !outcomeDismissed,
        pendingAction: Boolean(pendingAction),
      })
      if (target === 'context-menu') setContextMenu(null)
      else if (target === 'overlay') {
        if (overlay === 'saved-games') closeSavedGames()
        else setOverlay(overlayAfterEscape(phase, overlay))
      }
      else if (target === 'outcome') setOutcomeDismissed(true)
      else if (target === 'pending-action') {
        setPendingAction(null)
        setCommandFeedback(null)
        setHoveredOrderCost(0)
      } else setOverlay(overlayAfterEscape(phase, overlay))
    }
    const releaseShift = (event: KeyboardEvent) => { if (event.key === 'Shift') setTerritoriesHeld(false) }
    const releaseShiftOnBlur = () => setTerritoriesHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', releaseShift)
    window.addEventListener('blur', releaseShiftOnBlur)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', releaseShift); window.removeEventListener('blur', releaseShiftOnBlur) }
  }, [cancelAutoMove, closeSavedGames, contextMenu, match?.status, outcomeDismissed, overlay, pendingAction, phase])

  useEffect(() => {
    if (!opponentTurn || !match) return
    const timeout = window.setTimeout(() => {
      const result = endTurn(match)
      if (result.ok) {
        setMatch(result.state)
        setScenario(result.state.scenario)
        if (text) setCommandFeedback(turnReportMessage(result.state.lastTurnReports[result.state.playerId], text))
      }
      setOpponentTurn(false)
    }, gameConfig.turn.opponentDelayMs)
    return () => window.clearTimeout(timeout)
  }, [match, opponentTurn, text])

  useEffect(() => {
    if (!commandFeedback) return
    const timeout = window.setTimeout(() => setCommandFeedback(null), 3200)
    return () => window.clearTimeout(timeout)
  }, [commandFeedback])

  if (!text) {
    if (localizationStatus === 'error') {
      return <main className="game-shell localization-error" role="alert"><section><h1>Не удалось загрузить интерфейс</h1><p>Проверьте файлы приложения и попробуйте ещё раз.</p><button type="button" onClick={retryLocalization}>Повторить</button></section></main>
    }
    return <main className="game-shell loading-shell" aria-busy="true" />
  }
  const utilityControls = <UtilityControls settingsLabel={text.settings.title} settingsHint={text.interface.settingsHint} soundEnabled={soundEnabled} soundEnableLabel={text.sound.enable} soundDisableLabel={text.sound.disable} onOpenSettings={() => { setTerritoriesHeld(false); cancelAutoMove(); setOverlay('settings') }} onToggleSound={toggleSound} />
  if (phase === 'menu') {
    return (
      <div className="start-shell" onPointerDownCapture={handleInterfacePointerDown}>
        <StartMenu text={text.startMenu} confirmationText={text.confirmation} selectedMap={selectedMap} savedMaps={savedMaps} participantCount={participantCount} utilityControls={utilityControls} onMapChange={setSelectedMap} onDeleteSavedMap={deleteSavedMap} onParticipantChange={setParticipantCount} onOpenGenerator={openGenerator} onStart={beginFounding} hasSavedGames={savedGames.length > 0 || savedGamesReadFailed} onOpenSavedGames={() => openSavedGames(false)} storageFeedback={savedMapsFeedback ?? (!initialSavedMaps.ok ? text.startMenu.mapReadFailed : null)} />
        <ClickEffects bursts={bursts} />
        {overlay === 'generator' && (
          <MapGeneratorModal text={text.generator} locale={locale} participantCount={participantCount} savedMapCount={savedMaps.length} onParticipantChange={setParticipantCount} onClose={closeGenerator} onSave={saveGeneratedMap} onApply={applyGeneratedScenario} />
        )}
        {overlay === 'settings' && <SettingsModal locale={locale} text={text} soundEnabled={soundEnabled} volume={volume} musicVolume={musicVolume} showGrid={showGrid} onClose={() => setOverlay(null)} onLocaleChange={setLocale} onSoundToggle={toggleSound} onVolumeChange={setVolume} onMusicVolumeChange={setMusicVolume} onShowGridChange={setShowGrid} />}
        {overlay === 'saved-games' && <SavedGamesModal locale={locale} text={text} saves={savedGames} showSaveAction={false} canSave={false} busy={savedGamesBusy} feedback={savedGamesFeedback} onClose={closeSavedGames} onSave={saveCurrentGame} onLoad={requestLoadGame} onDelete={removeSavedGame} />}
        {pendingLoadId && <ConfirmDialog title={text.savedGames.loadTitle} description={text.savedGames.loadDescription} cancelLabel={text.confirmation.cancel} confirmLabel={text.savedGames.loadConfirm} onCancel={() => setPendingLoadId(null)} onConfirm={() => { const id = pendingLoadId; setPendingLoadId(null); void loadGame(id) }} />}
      </div>
    )
  }

  const activeScenario = match?.scenario ?? scenario
  if (!activeScenario) return null
  const draftValid = Boolean(selectedRegionId && castleDraft && isCastleSiteValid(activeScenario, selectedRegionId, castleDraft))
  const actionPreview = pendingAction?.kind === 'build'
    ? { kind: 'building' as const, building: pendingAction.building }
    : pendingAction?.kind === 'recruit'
      ? { kind: 'squad' as const, units: { militia: 0, spearmen: 0, archers: 0, knights: 0, [pendingAction.troop]: pendingAction.quantity } }
      : pendingAction?.kind === 'split'
        ? { kind: 'squad' as const, units: pendingAction.units }
        : pendingAction?.kind === 'garrison-enter' || pendingAction?.kind === 'garrison-exit' || pendingAction?.kind === 'tower-attack'
          ? { kind: 'target' as const }
          : null
  const pendingOrderCost = pendingAction?.kind === 'build'
    ? buildingRules[pendingAction.building].actionCost
    : pendingAction?.kind === 'recruit'
      ? troopRules[pendingAction.troop].actionCost
      : pendingAction?.kind === 'split' || pendingAction?.kind === 'dismiss'
        ? gameConfig.turn.squadReorganizationOrderCost
        : pendingAction?.kind === 'tower-attack'
          ? buildingRules.tower.garrison?.attackOrderCost ?? 0
          : pendingAction?.kind === 'garrison-enter' || pendingAction?.kind === 'garrison-exit'
            ? buildingRules.tower.garrison?.transferOrderCost ?? 0
            : 0
  const contextObject = match && contextMenu ? visibleObjectAt(match.scenario.cells, visibility, match.playerId, contextMenu) : null
  const contextOwned = contextObject?.ownerId === match?.playerId
  const contextRefundText = contextObject?.type === 'building'
    ? demolitionRefundText(demolitionRefundFor(contextObject), text, locale)
    : null
  const selectedMapObject = match && selectedCell ? visibleObjectAt(match.scenario.cells, visibility, match.playerId, selectedCell) : null
  const selectedObjectConcealed = Boolean(match && selectedCell && objectAt(match, selectedCell) && !selectedMapObject)
  const interfaceSelectedCell = selectedObjectConcealed ? null : selectedCell
  const contextCell = contextMenu ? activeScenario.cells[contextMenu.row]?.[contextMenu.column] : null
  const canOfferAutoMove = Boolean(
    contextMenu
    && selectedCell
    && selectedMapObject?.type === 'squad'
    && selectedMapObject.ownerId === match?.playerId
    && !isSamePosition(selectedCell, contextMenu)
    && contextCell
    && contextCell.landform !== 'peak'
    && !contextObject,
  )
  const contextHasObjectAction = Boolean(
    contextObject
    && contextOwned
    && (contextObject.type === 'squad' || contextObject.type !== 'castle'),
  )
  const movementSource = phase === 'playing'
    && !opponentTurn
    && !pendingAction
    && match?.status === 'playing'
    && selectedMapObject?.type === 'squad'
    && selectedMapObject.ownerId === match?.playerId
    ? selectedCell
    : null

  return (
    <main className={`game-shell phase-${phase}`} onPointerDownCapture={handleInterfacePointerDown}>
      <GridCanvas map={activeScenario.cells} territories={activeScenario.territories} regions={activeScenario.regions} participants={activeScenario.participants} showTerritories={phase === 'founding' || territoriesHeld} showGrid={showGrid} territoryInspecting={territoriesHeld} mode={phase} selectedRegionId={selectedRegionId} castleDraft={castleDraft} selectedCell={phase === 'playing' ? interfaceSelectedCell : null} movementSource={movementSource} movementPath={autoMovePath} movementOrdersRemaining={match?.ordersRemaining} unitAnimation={unitAnimation} visibility={phase === 'playing' ? visibility : null} viewerId={phase === 'playing' ? match?.playerId : undefined} actionPreview={actionPreview} isActionCellValid={actionCellValid} cameraCommand={cameraCommand} ariaLabel={text.interface.mapAria} onContextRequest={openContextMenu} onMapClick={handleMapClick} onNavigate={markLearned} />
      <ClickEffects bursts={bursts} />

      {phase === 'playing' && match && <>
        <GameHud match={match} text={text} opponentTurn={opponentTurn} previewOrderCost={pendingOrderCost || hoveredOrderCost} onEndTurn={finishTurn} />
        <GameCommandDock match={match} selectedCell={interfaceSelectedCell} activeTab={activeTab} pendingAction={pendingAction} locked={opponentTurn} text={text} feedback={commandFeedback} onOrderPreview={setHoveredOrderCost} onTabChange={(tab) => { cancelAutoMove(); setActiveTab(tab); setSelectedCell(null); setPendingAction(null); setCommandFeedback(null); setHoveredOrderCost(0) }} onChooseBuild={startBuilding} onChooseRecruit={startRecruitment} onSplit={startSplit} onDismiss={startDismiss} onCompositionChange={changeComposition} onConfirmDismiss={confirmDismiss} onTowerAction={startTowerAction} onCancelAction={() => { setPendingAction(null); setHoveredOrderCost(0) }} onSetTaxRate={changeTaxRate} onTrade={tradeAtMarket} />
        {navigationHintVisible && <div className="map-hint" aria-live="polite"><span className="mouse-symbol" />{text.interface.mapHint}</div>}
      </>}

      {phase === 'founding' && <FoundingPanel scenario={activeScenario} selectedRegionId={selectedRegionId} castleDraft={castleDraft} draftValid={draftValid} locale={locale} text={text.founding} onSelectRegion={selectRegion} onConfirm={confirmFounding} />}

      {utilityControls}

      {contextMenu && <div className="context-backdrop" onPointerDown={() => setContextMenu(null)} role="presentation">
        <section className="context-menu" style={{ left: contextMenu.left, top: contextMenu.top }} role="menu" aria-label={text.contextMenu.title} onPointerDown={(event) => event.stopPropagation()}>
          <div className="context-menu-heading"><span>{text.contextMenu.title}</span><small>{text.contextMenu.cell} {contextMenu.column + 1}:{contextMenu.row + 1}</small></div>
          {canOfferAutoMove && <button type="button" role="menuitem" onClick={startAutoMovement}>{text.contextMenu.goHere}</button>}
          {contextObject?.type === 'squad' && contextOwned && squadSize(contextObject) > 1 && <button type="button" role="menuitem" onClick={() => startSplit(contextMenu)}>{text.contextMenu.splitSquad}</button>}
          {contextObject?.type === 'squad' && contextOwned && <button type="button" role="menuitem" onClick={() => { setSelectedCell(contextMenu); setPendingAction(null); setCommandFeedback(text.game.moveHint); setContextMenu(null) }}>{text.contextMenu.mergeSquads}</button>}
          {contextObject?.type === 'squad' && contextOwned && <button type="button" role="menuitem" className="danger" onClick={removeContextObject}>{text.contextMenu.dismissSquad}</button>}
          {contextObject?.type === 'building' && contextOwned && <div className="context-demolition"><button type="button" role="menuitem" className="danger" onClick={removeContextObject}>{text.contextMenu.removeObject}</button><small>{contextRefundText}</small></div>}
          {!canOfferAutoMove && !contextHasObjectAction && <p className="context-menu-empty">{text.game.selectCell}</p>}
        </section>
      </div>}

      {match?.status === 'won' && !outcomeDismissed && <GameOutcomeModal text={text.game} onContinue={() => setOutcomeDismissed(true)} />}

      {overlay === 'settings' && <SettingsModal locale={locale} text={text} soundEnabled={soundEnabled} volume={volume} musicVolume={musicVolume} showGrid={showGrid} onClose={() => setOverlay(null)} onLocaleChange={setLocale} onSoundToggle={toggleSound} onVolumeChange={setVolume} onMusicVolumeChange={setMusicVolume} onShowGridChange={setShowGrid} onReturnToMenu={returnToMainMenu} onOpenSavedGames={() => openSavedGames(true)} />}
      {overlay === 'saved-games' && <SavedGamesModal locale={locale} text={text} saves={savedGames} showSaveAction canSave={!opponentTurn} busy={savedGamesBusy} feedback={savedGamesFeedback} onClose={closeSavedGames} onSave={saveCurrentGame} onLoad={requestLoadGame} onDelete={removeSavedGame} />}
      {pendingLoadId && <ConfirmDialog title={text.savedGames.loadTitle} description={text.savedGames.loadDescription} cancelLabel={text.confirmation.cancel} confirmLabel={text.savedGames.loadConfirm} onCancel={() => setPendingLoadId(null)} onConfirm={() => { const id = pendingLoadId; setPendingLoadId(null); void loadGame(id) }} />}
    </main>
  )
}
