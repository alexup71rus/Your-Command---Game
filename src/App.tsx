import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppOverlays } from './components/AppOverlays'
import { AppUtilityControls, LocalizationFallback } from './components/ApplicationChrome'
import { GameScene } from './components/GameScene'
import type { GameContextMenuState } from './components/GameContextMenu'
import type { CameraCommand, MapClickRequest, MapContextRequest } from './components/GridCanvas'
import { MenuScene, type MenuPage } from './components/MenuScene'
import { gameConfig } from './config/game'
import { aiParticipantDisplayName, type TabId } from './config/localization'
import type { TaxRate } from './config/rules'
import { savedGameLoadNeedsConfirmation, type GamePhase, type Overlay } from './game/flow'
import { actionPreviewFor, orderCostFor, type PendingGameAction } from './game/interaction'
import type { BuildingKind, ResourceId, TroopComposition, TroopKind } from './game/map'
import {
  buildingPlacementFailure,
  createMatch,
  defaultSplit,
  demolitionRefundFor,
  demolish,
  dismissFailure,
  dismissSquad,
  endTurn,
  garrisonFailure,
  isSamePosition,
  objectAt,
  recruitmentFailure,
  setTaxRate,
  splitFailure,
  squadSize,
  towerAttackFailure,
  trade,
  ungarrisonFailure,
  workforceFor,
  type CommandResult,
  type MatchState,
  type WorkforceSummary,
} from './game/match'
import { findMovementPath } from './game/pathfinding'
import { demolitionRefundText, mapObjectDisplayName, spectatorWinnerName, turnReportMessage } from './game/presentation'
import {
  assignOpponentRegions,
  foundAutomatedMatch,
  foundMatch,
  isCastleSiteValid,
  isSpectatorScenario,
  type CellPosition,
  type MapScenario,
} from './game/scenario'
import { createVisibilitySelector, hasNearbyEnemyThreat, visibleObjectAt } from './game/visibility'
import { resetAiPlanner } from './game/ai/workerClient'
import { useLocalization } from './hooks/useLocalization'
import { useAutoCamera } from './hooks/useAutoCamera'
import { useMapGrid } from './hooks/useMapGrid'
import { useMusic, type MusicScene } from './hooks/useMusic'
import { useNavigationHint } from './hooks/useNavigationHint'
import { useSoundEffects, type SoundEffect } from './hooks/useSoundEffects'
import { useBattleSetup } from './hooks/useBattleSetup'
import { useClickBursts } from './hooks/useClickBursts'
import { useMapObjectHint } from './hooks/useMapObjectHint'
import { useRecentCombat } from './hooks/useRecentCombat'
import { useSavedGamesController } from './hooks/useSavedGamesController'
import { useGameKeyboard } from './hooks/useGameKeyboard'
import { useInterfaceFeedback } from './hooks/useInterfaceFeedback'
import { useAiTurn } from './hooks/useAiTurn'
import { useMapClickInteraction } from './hooks/useMapClickInteraction'
import { useAutoMovement } from './hooks/useAutoMovement'

export function App() {
  const [phase, setPhase] = useState<GamePhase>('menu')
  const [menuPage, setMenuPage] = useState<MenuPage>('welcome')
  const { locale, setLocale, text, status: localizationStatus, retry: retryLocalization } = useLocalization()
  const {
    selectedMap,
    savedMaps,
    feedback: savedMapsFeedback,
    savedMapsReadFailed,
    hasHumanPlayer,
    opponentProfileIds,
    participantTeamIds,
    participantCount,
    normalizedHumanRegionIndex,
    participantMaximum: setupParticipantMaximum,
    selectedMapParticipantLimit,
    constrainParticipants,
    selectMap,
    saveGeneratedMap: persistGeneratedMap,
    deleteSavedMap,
    changeParticipantCount,
    changeRoster: changeBattleRoster,
    changeArrangement: changeBattleArrangement,
    restoreHumanRoster,
  } = useBattleSetup(text?.startMenu)
  const [pendingLoadId, setPendingLoadId] = useState<string | null>(null)
  const [scenario, setScenario] = useState<MapScenario | null>(null)
  const [match, setMatch] = useState<MatchState | null>(null)
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)
  const [castleDraft, setCastleDraft] = useState<CellPosition | null>(null)
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null)
  const [combatEffect, setCombatEffect] = useState<({ key: number } & CellPosition) | null>(null)
  const [spectatorParticipantId, setSpectatorParticipantId] = useState<string | null>(null)
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
  const [contextMenu, setContextMenu] = useState<GameContextMenuState | null>(null)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [savedGamesReturnToSettings, setSavedGamesReturnToSettings] = useState(false)
  const { bursts, createBurst } = useClickBursts()
  const { recentCombat, markRecentCombat, clearRecentCombat } = useRecentCombat()
  const { hoveredMapObject, showObjectOwner } = useMapObjectHint(phase === 'playing')
  const focusId = useRef(0)
  const combatEffectId = useRef(0)
  const unitAnimationId = useRef(0)
  const visibilitySelector = useMemo(() => createVisibilitySelector(), [])
  const spectatorMatch = Boolean(match && isSpectatorScenario(match.scenario))
  const opponentTurn = Boolean(match && (spectatorMatch || match.activeParticipantId !== match.playerId))
  const { visible: showGrid, setVisible: setShowGrid } = useMapGrid()
  const { enabled: autoCameraEnabled, setEnabled: setAutoCameraEnabled } = useAutoCamera()
  const { visible: navigationHintVisible, markLearned } = useNavigationHint()
  const { enabled: soundEnabled, volume, play: playSound, setVolume, toggle: toggleSound } = useSoundEffects()
  const { handlePointerDown: handleInterfacePointerDown, handleMenuPointerOver } = useInterfaceFeedback({ createBurst, playSound })
  const matchCells = match?.scenario.cells
  const matchParticipants = match?.scenario.participants
  const matchPlayerId = match?.playerId
  const visibility = useMemo(
    () =>
      !spectatorMatch && gameConfig.visibility.enabled && matchCells && matchPlayerId
        ? visibilitySelector(matchCells, matchPlayerId)
        : null,
    [matchCells, matchPlayerId, spectatorMatch, visibilitySelector],
  )
  const visibleEnemyNearby = useMemo(() => {
    if (phase !== 'playing' || spectatorMatch || !matchCells || !matchPlayerId) return false
    return hasNearbyEnemyThreat(matchCells, matchPlayerId, gameConfig.audio.combatThreatRadius, matchParticipants)
  }, [matchCells, matchParticipants, matchPlayerId, phase, spectatorMatch])
  const workforceByOwner = useMemo(() => {
    if (phase !== 'playing' || !match || !matchParticipants) return undefined
    const map = new Map<string, WorkforceSummary>()
    matchParticipants.forEach((participant) => {
      map.set(participant.id, workforceFor(match, participant.id))
    })
    return map
  }, [match, matchParticipants, phase])
  const musicScene: MusicScene =
    phase === 'menu' ? 'menu' : phase === 'playing' && (visibleEnemyNearby || recentCombat) ? 'battle' : 'settlement'
  const { volume: musicVolume, setVolume: setMusicVolume } = useMusic(musicScene, soundEnabled)
  const currentVisibleObjectAt = useCallback(
    (position: CellPosition) => {
      if (!matchCells || !matchPlayerId) return undefined
      return visibleObjectAt(matchCells, visibility, matchPlayerId, position)
    },
    [matchCells, matchPlayerId, visibility],
  )

  const cancelAutoMove = useCallback(() => {
    setAutoMoveTarget(null)
    setAutoMovePath(null)
  }, [])

  const restoreSavedMatch = useCallback(
    (savedMatch: MatchState) => {
      resetAiPlanner()
      setMatch(savedMatch)
      setScenario(savedMatch.scenario)
      restoreHumanRoster(
        savedMatch.scenario.participants.flatMap((participant) =>
          participant.kind === 'ai' && participant.profileId ? [participant.profileId] : [],
        ),
        savedMatch.scenario.participants.map((participant, index) => participant.teamId ?? index + 1),
      )
      setSelectedRegionId(null)
      setCastleDraft(null)
      setSelectedCell(null)
      setSpectatorParticipantId(null)
      cancelAutoMove()
      setPendingAction(null)
      setCommandFeedback(null)
      setHoveredOrderCost(0)
      setTerritoriesHeld(false)
      setOutcomeDismissed(false)
      setContextMenu(null)
      setPendingLoadId(null)
      setSavedGamesReturnToSettings(false)
      setOverlay(null)
      setPhase('playing')
      clearRecentCombat()
      const focus = savedMatch.scenario.cells
        .flatMap((row, rowIndex) => row.map((cell, column) => ({ cell, column, row: rowIndex })))
        .find(({ cell }) => cell.object?.type === 'castle' && cell.object.ownerId === savedMatch.playerId)
      setCameraCommand(
        focus
          ? { kind: 'cell', column: focus.column, row: focus.row, zoom: gameConfig.camera.gameStartZoom, key: ++focusId.current }
          : { kind: 'overview', key: ++focusId.current },
      )
      setUnitAnimation(null)
    },
    [cancelAutoMove, clearRecentCombat, restoreHumanRoster],
  )

  const {
    saves: savedGames,
    busy: savedGamesBusy,
    feedback: savedGamesFeedback,
    readFailed: savedGamesReadFailed,
    setFeedback: setSavedGamesFeedback,
    saveCurrentGame,
    loadGame,
    removeSavedGame,
  } = useSavedGamesController({
    match,
    canSave: !opponentTurn,
    messages: text?.savedGames,
    onLoadMatch: restoreSavedMatch,
    playSound,
  })

  const openSavedGames = useCallback(
    (returnToSettings = false) => {
      setSavedGamesFeedback(savedGamesReadFailed ? (text?.savedGames.readFailed ?? text?.savedGames.loadFailed ?? null) : null)
      setSavedGamesReturnToSettings(returnToSettings)
      setOverlay('saved-games')
    },
    [savedGamesReadFailed, setSavedGamesFeedback, text],
  )

  const closeSavedGames = useCallback(() => {
    setOverlay(savedGamesReturnToSettings ? 'settings' : null)
    setSavedGamesReturnToSettings(false)
  }, [savedGamesReturnToSettings])

  const requestLoadGame = useCallback(
    (id: string) => {
      if (savedGameLoadNeedsConfirmation(phase, Boolean(match))) {
        setPendingLoadId(id)
        return
      }
      void loadGame(id)
    },
    [loadGame, match, phase],
  )

  const createCombatEffect = useCallback((position: CellPosition) => {
    setCombatEffect({ key: ++combatEffectId.current, ...position })
  }, [])

  const updateAiMatch = useCallback((nextMatch: MatchState) => {
    setMatch(nextMatch)
    setScenario(nextMatch.scenario)
  }, [])
  const animateAiUnit = useCallback((from: CellPosition, to: CellPosition) => {
    setUnitAnimation({ key: ++unitAnimationId.current, from, to })
  }, [])
  const clearUnitAnimation = useCallback(() => setUnitAnimation(null), [])
  const focusAiCamera = useCallback((position: CellPosition) => {
    setCameraCommand({ kind: 'cell', ...position, key: ++focusId.current })
  }, [])
  const recordAiCombat = useCallback(
    (position: CellPosition | null) => {
      markRecentCombat()
      if (position) createCombatEffect(position)
    },
    [createCombatEffect, markRecentCombat],
  )
  const showPlayerTurn = useCallback((message: string) => setCommandFeedback(message), [])
  const { busy: aiBusy, slow: aiSlow } = useAiTurn({
    match,
    autoCameraEnabled,
    text,
    onMatchChange: updateAiMatch,
    onUnitMove: animateAiUnit,
    onCameraFocus: focusAiCamera,
    onCombat: recordAiCombat,
    onPlayerTurn: showPlayerTurn,
    playSound,
  })

  const renderCombatEffect = useCallback(
    ({ clientX, clientY }: Pick<MapClickRequest, 'clientX' | 'clientY'>) => {
      createBurst(clientX, clientY, 'combat')
    },
    [createBurst],
  )

  const focusRegion = useCallback(
    (regionId: string) => {
      const region = scenario?.regions.find((candidate) => candidate.id === regionId)
      if (region) setCameraCommand({ kind: 'cell', ...region.center, zoom: gameConfig.camera.foundingZoom, key: ++focusId.current })
    },
    [scenario],
  )

  const beginMatchSetup = useCallback(
    (nextScenario: MapScenario) => {
      const automatedCandidate = !hasHumanPlayer ? foundAutomatedMatch(nextScenario, opponentProfileIds, participantTeamIds) : null
      const automatedScenario = automatedCandidate && isSpectatorScenario(automatedCandidate) ? automatedCandidate : null
      const assignedHumanRegion = hasHumanPlayer ? (nextScenario.regions[normalizedHumanRegionIndex] ?? nextScenario.regions[0]) : undefined
      if (automatedScenario) resetAiPlanner()
      setScenario(automatedScenario ?? nextScenario)
      setMatch(automatedScenario ? createMatch(automatedScenario) : null)
      setSelectedRegionId(assignedHumanRegion?.id ?? null)
      setCastleDraft(null)
      setContextMenu(null)
      setSelectedCell(null)
      setSpectatorParticipantId(null)
      cancelAutoMove()
      setPendingAction(null)
      setCommandFeedback(null)
      setHoveredOrderCost(0)
      setPendingLoadId(null)
      setSavedGamesReturnToSettings(false)
      setOverlay(null)
      setCameraCommand(
        assignedHumanRegion
          ? { kind: 'cell', ...assignedHumanRegion.center, zoom: gameConfig.camera.foundingZoom, key: ++focusId.current }
          : { kind: 'overview', key: ++focusId.current },
      )
      setUnitAnimation(null)
      setTerritoriesHeld(false)
      setOutcomeDismissed(false)
      clearRecentCombat()
      setPhase(automatedScenario ? 'playing' : 'founding')
      if (automatedScenario) playSound('action')
    },
    [cancelAutoMove, clearRecentCombat, hasHumanPlayer, normalizedHumanRegionIndex, opponentProfileIds, participantTeamIds, playSound],
  )

  const openGenerator = useCallback(() => setOverlay('generator'), [])
  const closeGenerator = useCallback(() => {
    setOverlay(null)
    constrainParticipants(selectedMapParticipantLimit)
  }, [constrainParticipants, selectedMapParticipantLimit])

  const applyGeneratedScenario = useCallback(
    (generatedScenario: MapScenario) => {
      beginMatchSetup(generatedScenario)
    },
    [beginMatchSetup],
  )

  const saveGeneratedMap = useCallback(
    (draft: Parameters<typeof persistGeneratedMap>[0]) => {
      const saved = persistGeneratedMap(draft)
      if (saved) setOverlay(null)
      return saved
    },
    [persistGeneratedMap],
  )

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
    setSpectatorParticipantId(null)
    cancelAutoMove()
    setPendingAction(null)
    setCommandFeedback(null)
    setHoveredOrderCost(0)
    setOutcomeDismissed(false)
    setPendingLoadId(null)
    setSavedGamesReturnToSettings(false)
    setOverlay(null)
    setPhase('menu')
    setMenuPage('modes')
    clearRecentCombat()
  }, [cancelAutoMove, clearRecentCombat])

  const selectRegion = useCallback(
    (regionId: string | null) => {
      setSelectedRegionId(regionId)
      setCastleDraft(null)
      if (regionId) focusRegion(regionId)
      else setCameraCommand({ kind: 'overview', key: ++focusId.current })
    },
    [focusRegion],
  )

  const applyCommand = useCallback(
    (result: CommandResult, nextSelection?: CellPosition | null, sound: SoundEffect = 'action') => {
      if (!result.ok) {
        if (text) setCommandFeedback(text.game.failures[result.reason] || result.reason)
        playSound('dismiss')
        return false
      }
      setMatch(result.state)
      setScenario(result.state.scenario)
      if (nextSelection !== undefined) setSelectedCell(nextSelection)
      setPendingAction(null)
      setCommandFeedback(null)
      setHoveredOrderCost(0)
      if (result.state.lastEvent?.kind === 'attacked' || result.state.lastEvent?.kind === 'destroyed') markRecentCombat()
      playSound(sound)
      return true
    },
    [markRecentCombat, playSound, text],
  )

  const handleMapClick = useMapClickInteraction({
    phase,
    match,
    scenario,
    selectedRegionId,
    selectedCell,
    pendingAction,
    opponentTurn,
    spectatorMatch,
    text,
    visibleObjectAt: currentVisibleObjectAt,
    applyCommand,
    cancelAutoMove,
    createBurst,
    playSound,
    selectRegion,
    onSelectCell: setSelectedCell,
    onSelectSpectator: setSpectatorParticipantId,
    onCastleDraft: setCastleDraft,
    onFeedback: setCommandFeedback,
    onClearPendingAction: () => setPendingAction(null),
    onAnimateUnit: animateAiUnit,
    onClearUnitAnimation: clearUnitAnimation,
  })

  const confirmFounding = useCallback(() => {
    if (!scenario || !selectedRegionId || !castleDraft || !isCastleSiteValid(scenario, selectedRegionId, castleDraft)) return
    const foundedScenario = foundMatch(scenario, selectedRegionId, castleDraft, opponentProfileIds, participantTeamIds)
    resetAiPlanner()
    setScenario(foundedScenario)
    setMatch(createMatch(foundedScenario))
    cancelAutoMove()
    setCameraCommand({ kind: 'cell', ...castleDraft, zoom: gameConfig.camera.gameStartZoom, key: ++focusId.current })
    setPhase('playing')
    setTerritoriesHeld(false)
    setOutcomeDismissed(false)
    playSound('action')
  }, [cancelAutoMove, castleDraft, opponentProfileIds, participantTeamIds, playSound, scenario, selectedRegionId])

  const startBuilding = useCallback(
    (building: BuildingKind) => {
      if (opponentTurn) return
      cancelAutoMove()
      setPendingAction({ kind: 'build', building })
      setCommandFeedback(null)
      setHoveredOrderCost(0)
    },
    [cancelAutoMove, opponentTurn],
  )

  const startRecruitment = useCallback(
    (troop: TroopKind, quantity: number) => {
      if (opponentTurn) return
      cancelAutoMove()
      setPendingAction({ kind: 'recruit', troop, quantity })
      setCommandFeedback(null)
      setHoveredOrderCost(0)
    },
    [cancelAutoMove, opponentTurn],
  )

  const changeTaxRate = useCallback(
    (rate: TaxRate) => {
      if (!match || opponentTurn) return
      applyCommand(setTaxRate(match, rate), selectedCell ?? undefined)
    },
    [applyCommand, match, opponentTurn, selectedCell],
  )

  const tradeAtMarket = useCallback(
    (position: CellPosition, resource: Exclude<ResourceId, 'gold'>, direction: 'buy' | 'sell', quantity: number) => {
      if (!match || opponentTurn) return
      applyCommand(trade(match, position, resource, direction, quantity), position)
    },
    [applyCommand, match, opponentTurn],
  )

  const startSplit = useCallback(
    (source: CellPosition) => {
      if (!match || opponentTurn) return
      const object = objectAt(match, source)
      if (object?.type !== 'squad' || object.ownerId !== match.playerId || squadSize(object) < 2) return
      cancelAutoMove()
      setSelectedCell(source)
      setPendingAction({ kind: 'split', source, units: defaultSplit(object) })
      setContextMenu(null)
      setCommandFeedback(null)
      setHoveredOrderCost(0)
    },
    [cancelAutoMove, match, opponentTurn],
  )

  const startDismiss = useCallback(
    (source: CellPosition) => {
      if (!match || opponentTurn) return
      const object = objectAt(match, source)
      if (object?.type !== 'squad' || object.ownerId !== match.playerId || squadSize(object) < 2) return
      cancelAutoMove()
      setSelectedCell(source)
      setPendingAction({ kind: 'dismiss', source, units: defaultSplit(object) })
      setContextMenu(null)
      setCommandFeedback(null)
      setHoveredOrderCost(0)
    },
    [cancelAutoMove, match, opponentTurn],
  )

  const changeComposition = useCallback((units: TroopComposition) => {
    setPendingAction((current) => (current?.kind === 'split' || current?.kind === 'dismiss' ? { ...current, units } : current))
  }, [])

  const confirmDismiss = useCallback(() => {
    if (!match || pendingAction?.kind !== 'dismiss' || opponentTurn) return
    applyCommand(dismissSquad(match, pendingAction.source, pendingAction.units), pendingAction.source)
  }, [applyCommand, match, opponentTurn, pendingAction])

  const startTowerAction = useCallback(
    (kind: 'garrison-enter' | 'garrison-exit' | 'tower-attack', tower: CellPosition) => {
      if (!match || opponentTurn) return
      const object = objectAt(match, tower)
      if (object?.type !== 'building' || object.kind !== 'tower' || object.ownerId !== match.playerId) return
      cancelAutoMove()
      setSelectedCell(tower)
      setPendingAction({ kind, tower })
      setCommandFeedback(null)
      setHoveredOrderCost(0)
    },
    [cancelAutoMove, match, opponentTurn],
  )

  const finishTurn = useCallback(() => {
    if (!match || opponentTurn) return
    cancelAutoMove()
    setPendingAction(null)
    setContextMenu(null)
    setCommandFeedback(null)
    setHoveredOrderCost(0)
    setSelectedCell(null)
    const result = endTurn(match)
    if (result.ok) {
      setMatch(result.state)
      setScenario(result.state.scenario)
      if (text) setCommandFeedback(turnReportMessage(result.state.lastTurnReports[match.playerId], text))
    }
    playSound('action')
  }, [cancelAutoMove, match, opponentTurn, playSound, text])

  const actionCellValid = useCallback(
    (position: CellPosition) => {
      if (!match || !pendingAction || opponentTurn) return false
      if (pendingAction.kind === 'build') return buildingPlacementFailure(match, pendingAction.building, position) === null
      if (pendingAction.kind === 'recruit') return recruitmentFailure(match, pendingAction.troop, pendingAction.quantity, position) === null
      if (pendingAction.kind === 'split') return splitFailure(match, pendingAction.source, position, pendingAction.units) === null
      if (pendingAction.kind === 'dismiss') return dismissFailure(match, pendingAction.source, pendingAction.units) === null
      if (pendingAction.kind === 'garrison-enter') return garrisonFailure(match, position, pendingAction.tower) === null
      if (pendingAction.kind === 'garrison-exit') return ungarrisonFailure(match, pendingAction.tower, position) === null
      return towerAttackFailure(match, pendingAction.tower, position) === null && Boolean(currentVisibleObjectAt(position))
    },
    [currentVisibleObjectAt, match, opponentTurn, pendingAction],
  )

  const openContextMenu = useCallback(
    (request: MapContextRequest) => {
      if (phase !== 'playing' || opponentTurn || match?.status !== 'playing') return
      cancelAutoMove()
      const menu = gameConfig.display.contextMenu
      setContextMenu({
        ...request,
        left: Math.max(
          menu.viewportPadding,
          Math.min(request.clientX + menu.pointerOffset, window.innerWidth - menu.width - menu.viewportPadding),
        ),
        top: Math.max(
          menu.viewportPadding,
          Math.min(request.clientY + menu.pointerOffset, window.innerHeight - menu.height - menu.viewportPadding),
        ),
      })
      createBurst(request.clientX, request.clientY, 'context')
      playSound('context')
    },
    [cancelAutoMove, createBurst, match?.status, opponentTurn, phase, playSound],
  )

  const startAutoMovement = useCallback(() => {
    if (!match || !contextMenu || !selectedCell || opponentTurn) return
    const squad = objectAt(match, selectedCell)
    if (squad?.type !== 'squad' || squad.ownerId !== match.playerId) return
    const target = { column: contextMenu.column, row: contextMenu.row }
    const path = findMovementPath(match.scenario.cells, selectedCell, target, {
      ownerId: match.playerId,
      canEnterOccupiedCell: (position) =>
        Boolean(objectAt(match, position) && !visibleObjectAt(match.scenario.cells, visibility, match.playerId, position)),
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

  useAutoMovement({
    target: autoMoveTarget,
    phase,
    opponentTurn,
    overlay,
    pendingAction,
    match,
    selectedCell,
    visibility,
    text,
    onCancel: cancelAutoMove,
    onPathChange: setAutoMovePath,
    onMatchChange: updateAiMatch,
    onSelectionChange: setSelectedCell,
    onFeedback: setCommandFeedback,
    onUnitMove: animateAiUnit,
    onClearUnitAnimation: clearUnitAnimation,
    onCombat: markRecentCombat,
    playSound,
  })

  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  const dismissOutcome = useCallback(() => setOutcomeDismissed(true), [])
  const clearPendingAction = useCallback(() => {
    setPendingAction(null)
    setCommandFeedback(null)
    setHoveredOrderCost(0)
  }, [])
  useGameKeyboard({
    phase,
    atWelcomeScreen: phase === 'menu' && menuPage === 'welcome',
    overlay,
    contextMenuOpen: Boolean(contextMenu),
    outcomeOpen: match?.status !== 'playing' && !outcomeDismissed,
    pendingActionOpen: Boolean(pendingAction),
    onTerritoriesHeldChange: setTerritoriesHeld,
    onCancelAutoMove: cancelAutoMove,
    onCloseContextMenu: closeContextMenu,
    onCloseSavedGames: closeSavedGames,
    onOverlayChange: setOverlay,
    onDismissOutcome: dismissOutcome,
    onClearPendingAction: clearPendingAction,
  })

  useEffect(() => {
    if (!commandFeedback) return
    const timeout = window.setTimeout(() => setCommandFeedback(null), gameConfig.display.commandFeedbackDurationMs)
    return () => window.clearTimeout(timeout)
  }, [commandFeedback])

  if (!text) return <LocalizationFallback failed={localizationStatus === 'error'} onRetry={retryLocalization} />
  const utilityControls = (
    <AppUtilityControls
      text={text}
      soundEnabled={soundEnabled}
      onOpenSettings={() => {
        setTerritoriesHeld(false)
        cancelAutoMove()
        setOverlay('settings')
      }}
      onToggleSound={toggleSound}
    />
  )
  const overlays = (
    <AppOverlays
      generator={
        phase === 'menu' && overlay === 'generator'
          ? {
              text: text.generator,
              locale,
              participantCount,
              participantMaximum: setupParticipantMaximum,
              savedMapCount: savedMaps.length,
              onParticipantChange: changeParticipantCount,
              onClose: closeGenerator,
              onSave: saveGeneratedMap,
              onApply: applyGeneratedScenario,
            }
          : undefined
      }
      settings={
        overlay === 'settings'
          ? {
              locale,
              text,
              soundEnabled,
              volume,
              musicVolume,
              showGrid,
              autoCamera: autoCameraEnabled,
              onClose: () => setOverlay(null),
              onLocaleChange: setLocale,
              onSoundToggle: toggleSound,
              onVolumeChange: setVolume,
              onEffectsPreview: () => playSound('tab'),
              onMusicVolumeChange: setMusicVolume,
              onShowGridChange: setShowGrid,
              onAutoCameraChange: setAutoCameraEnabled,
              onReturnToMenu: phase === 'menu' ? undefined : returnToMainMenu,
              onOpenSavedGames: phase === 'menu' ? undefined : () => openSavedGames(true),
            }
          : undefined
      }
      savedGames={
        overlay === 'saved-games'
          ? {
              locale,
              text,
              saves: savedGames,
              showSaveAction: phase === 'menu' ? false : !spectatorMatch,
              canSave: phase === 'menu' ? false : !opponentTurn,
              busy: savedGamesBusy,
              feedback: savedGamesFeedback,
              onClose: closeSavedGames,
              onSave: saveCurrentGame,
              onLoad: requestLoadGame,
              onDelete: removeSavedGame,
            }
          : undefined
      }
      loadConfirmation={
        pendingLoadId
          ? {
              title: text.savedGames.loadTitle,
              description: text.savedGames.loadDescription,
              cancelLabel: text.confirmation.cancel,
              confirmLabel: text.savedGames.loadConfirm,
              onCancel: () => setPendingLoadId(null),
              onConfirm: () => {
                const id = pendingLoadId
                setPendingLoadId(null)
                void loadGame(id)
              },
            }
          : undefined
      }
    />
  )
  if (phase === 'menu') {
    return (
      <MenuScene
        page={menuPage}
        text={text.mainMenu}
        utilityControls={utilityControls}
        battleSetup={{
          text: text.startMenu,
          opponentsText: text.opponents,
          confirmationText: text.confirmation,
          selectedMap,
          savedMaps,
          participantCount,
          opponentProfileIds,
          participantTeamIds,
          hasHumanPlayer,
          humanRegionIndex: normalizedHumanRegionIndex,
          participantMaximum: selectedMapParticipantLimit,
          utilityControls,
          onMapChange: selectMap,
          onDeleteSavedMap: deleteSavedMap,
          onRosterChange: changeBattleRoster,
          onArrangementChange: changeBattleArrangement,
          onOpenGenerator: openGenerator,
          onStart: beginMatchSetup,
          hasSavedGames: savedGames.length > 0 || savedGamesReadFailed,
          onOpenSavedGames: () => openSavedGames(false),
          onBack: () => setMenuPage('modes'),
          storageFeedback: savedMapsFeedback ?? (savedMapsReadFailed ? text.startMenu.mapReadFailed : null),
        }}
        bursts={bursts}
        overlays={overlays}
        onContinue={() => setMenuPage('modes')}
        onBack={() => setMenuPage('welcome')}
        onSelectBattle={() => setMenuPage('battle-setup')}
        onPointerDown={handleInterfacePointerDown}
        onPointerOver={handleMenuPointerOver}
      />
    )
  }

  const activeScenario = match?.scenario ?? scenario
  if (!activeScenario) return null
  const foundingOpponents =
    phase === 'founding' && selectedRegionId ? assignOpponentRegions(activeScenario, selectedRegionId, opponentProfileIds) : []
  const draftValid = Boolean(selectedRegionId && castleDraft && isCastleSiteValid(activeScenario, selectedRegionId, castleDraft))
  const actionPreview = actionPreviewFor(pendingAction)
  const pendingOrderCost = orderCostFor(pendingAction)
  const contextObject = match && contextMenu ? visibleObjectAt(match.scenario.cells, visibility, match.playerId, contextMenu) : null
  const contextOwned = contextObject?.ownerId === match?.playerId
  const contextRefundText =
    contextObject?.type === 'building' ? demolitionRefundText(demolitionRefundFor(contextObject), text, locale) : null
  const selectedMapObject = match && selectedCell ? visibleObjectAt(match.scenario.cells, visibility, match.playerId, selectedCell) : null
  const selectedObjectConcealed = Boolean(match && selectedCell && objectAt(match, selectedCell) && !selectedMapObject)
  const visibleSpectatorParticipantId =
    spectatorMatch && selectedMapObject?.ownerId === spectatorParticipantId ? spectatorParticipantId : null
  const interfaceSelectedCell = selectedObjectConcealed || (spectatorMatch && !visibleSpectatorParticipantId) ? null : selectedCell
  const contextCell = contextMenu ? activeScenario.cells[contextMenu.row]?.[contextMenu.column] : null
  const canOfferAutoMove = Boolean(
    contextMenu &&
    selectedCell &&
    selectedMapObject?.type === 'squad' &&
    selectedMapObject.ownerId === match?.playerId &&
    !isSamePosition(selectedCell, contextMenu) &&
    contextCell &&
    contextCell.landform !== 'peak' &&
    !contextObject,
  )
  const contextHasObjectAction = Boolean(contextObject && contextOwned && contextObject.type !== 'castle')
  const movementSource =
    phase === 'playing' &&
    !opponentTurn &&
    !pendingAction &&
    match?.status === 'playing' &&
    selectedMapObject?.type === 'squad' &&
    selectedMapObject.ownerId === match?.playerId
      ? selectedCell
      : null
  const spectatorWinner = match && spectatorMatch && match.status !== 'playing' ? spectatorWinnerName(match, text) : undefined
  const mapObjectOwner =
    match && hoveredMapObject ? match.scenario.participants.find((participant) => participant.id === hoveredMapObject.ownerId) : undefined
  const mapObjectOwnerName =
    match && hoveredMapObject ? aiParticipantDisplayName(text.opponents, match.scenario.participants, hoveredMapObject.ownerId) : undefined
  const hoveredMapObjectName = hoveredMapObject ? mapObjectDisplayName(hoveredMapObject.object, text) : ''

  return (
    <GameScene
      className={`game-shell phase-${phase}${spectatorMatch ? ' spectator-match' : ''}`}
      map={{
        map: activeScenario.cells,
        territories: activeScenario.territories,
        regions: activeScenario.regions,
        participants: activeScenario.participants,
        workforceByOwner,
        foundingOpponents,
        showTerritories: phase === 'founding' || territoriesHeld,
        showGrid,
        territoryInspecting: territoriesHeld,
        mode: phase,
        selectedRegionId,
        castleDraft,
        selectedCell: phase === 'playing' ? interfaceSelectedCell : null,
        movementSource,
        movementPath: autoMovePath,
        movementOrdersRemaining: match?.ordersRemaining,
        unitAnimation,
        visibility: phase === 'playing' ? visibility : null,
        viewerId: phase === 'playing' && !spectatorMatch ? match?.playerId : undefined,
        actionPreview,
        isActionCellValid: actionCellValid,
        cameraCommand,
        combatEffect,
        ariaLabel: text.interface.mapAria,
        onCombatEffect: renderCombatEffect,
        onObjectHover: phase === 'playing' ? showObjectOwner : undefined,
        onContextRequest: openContextMenu,
        onMapClick: handleMapClick,
        onNavigate: markLearned,
      }}
      bursts={bursts}
      hud={
        phase === 'playing' && match
          ? {
              match,
              text,
              opponentTurn,
              aiBusy,
              aiSlow,
              spectator: spectatorMatch,
              spectatorParticipantId: visibleSpectatorParticipantId,
              previewOrderCost: pendingOrderCost || hoveredOrderCost,
              onEndTurn: finishTurn,
            }
          : undefined
      }
      commandDock={
        phase === 'playing' && match && !spectatorMatch
          ? {
              match,
              selectedCell: interfaceSelectedCell,
              activeTab,
              pendingAction,
              locked: opponentTurn,
              text,
              feedback: commandFeedback,
              onOrderPreview: setHoveredOrderCost,
              onTabChange: (tab) => {
                cancelAutoMove()
                setActiveTab(tab)
                setSelectedCell(null)
                setPendingAction(null)
                setCommandFeedback(null)
                setHoveredOrderCost(0)
              },
              onChooseBuild: startBuilding,
              onChooseRecruit: startRecruitment,
              onSplit: startSplit,
              onDismiss: startDismiss,
              onCompositionChange: changeComposition,
              onConfirmDismiss: confirmDismiss,
              onTowerAction: startTowerAction,
              onCancelAction: () => {
                setPendingAction(null)
                setHoveredOrderCost(0)
              },
              onSetTaxRate: changeTaxRate,
              onTrade: tradeAtMarket,
            }
          : undefined
      }
      ownerHint={
        hoveredMapObject && mapObjectOwner && mapObjectOwnerName
          ? {
              participant: mapObjectOwner,
              ownerName: mapObjectOwnerName,
              objectName: hoveredMapObjectName,
              playerMark: text.opponents.playerMark,
            }
          : undefined
      }
      navigationHint={navigationHintVisible ? text.interface.mapHint : undefined}
      founding={
        phase === 'founding'
          ? {
              scenario: activeScenario,
              selectedRegionId,
              castleDraft,
              draftValid,
              locale,
              text: text.founding,
              regionLocked: true,
              onSelectRegion: selectRegion,
              onConfirm: confirmFounding,
            }
          : undefined
      }
      contextMenu={
        contextMenu
          ? {
              state: contextMenu,
              object: contextObject ?? null,
              owned: contextOwned,
              canOfferAutoMove,
              hasObjectAction: contextHasObjectAction,
              refundText: contextRefundText,
              text,
              onClose: closeContextMenu,
              onStartAutoMove: startAutoMovement,
              onStartSplit: startSplit,
              onStartMerge: (position) => {
                setSelectedCell(position)
                setPendingAction(null)
                setCommandFeedback(text.game.moveHint)
                setContextMenu(null)
              },
              onRemoveObject: removeContextObject,
            }
          : undefined
      }
      outcome={
        match && match.status !== 'playing' && !outcomeDismissed
          ? {
              text: text.game,
              outcome: match.status,
              spectatorWinner,
              onContinue: () => setOutcomeDismissed(true),
            }
          : undefined
      }
      utilityControls={utilityControls}
      overlays={overlays}
      onPointerDown={handleInterfacePointerDown}
      onPointerOver={handleMenuPointerOver}
    />
  )
}
