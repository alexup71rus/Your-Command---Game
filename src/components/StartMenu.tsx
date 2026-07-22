import { useEffect, useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { aiAvatarPaths } from '../config/ai'
import { aiProfileDisplayName, type LocaleDictionary } from '../config/localization'
import { aiProfileIds } from '../game/ai/model'
import { clearMapObjects } from '../game/map'
import { mapPresets } from '../game/presets'
import { presetSelection, savedSelection, type MapSelection, type SavedMapDefinition } from '../game/savedMaps'
import { REGION_COLORS, type AiProfileId, type MapScenario, type ScenarioResult } from '../game/scenario'
import { calculateScenarioInWorker } from '../game/scenarioWorkerClient'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { BattleMapPreview, MapChoice } from './battleSetup/BattleMapPreview'
import { BattleParticipantToken } from './battleSetup/BattleParticipantToken'
import { defaultPreviewGrid, getPreviewMap, type BattleSeatPreview } from './battleSetup/battleMapPreviewModel'

const tableSeatPositions = {
  1: [{ x: 50, y: 50 }],
  2: [
    { x: 21, y: 50 },
    { x: 79, y: 50 },
  ],
  3: [
    { x: 50, y: 19 },
    { x: 22, y: 72 },
    { x: 78, y: 72 },
  ],
  4: [
    { x: 50, y: 17 },
    { x: 84, y: 50 },
    { x: 50, y: 83 },
    { x: 16, y: 50 },
  ],
} as const

interface StartMenuProps {
  text: LocaleDictionary['startMenu']
  opponentsText: LocaleDictionary['opponents']
  confirmationText: LocaleDictionary['confirmation']
  selectedMap: MapSelection
  savedMaps: SavedMapDefinition[]
  participantCount: number
  opponentProfileIds: AiProfileId[]
  participantTeamIds: number[]
  hasHumanPlayer: boolean
  humanRegionIndex: number
  participantMaximum: number
  onMapChange: (selection: MapSelection) => void
  onDeleteSavedMap: (id: string) => void
  onRosterChange: (hasHumanPlayer: boolean, opponentProfileIds: AiProfileId[], participantTeamIds: number[]) => void
  onArrangementChange: (humanRegionIndex: number, opponentProfileIds: AiProfileId[], participantTeamIds: number[]) => void
  onOpenGenerator: () => void
  onStart: (scenario: MapScenario) => void
  hasSavedGames: boolean
  onOpenSavedGames: () => void
  onBack: () => void
  storageFeedback?: string | null
  utilityControls: ReactNode
}

export function StartMenu({
  text,
  opponentsText,
  confirmationText,
  selectedMap,
  savedMaps,
  participantCount,
  opponentProfileIds,
  participantTeamIds,
  hasHumanPlayer,
  humanRegionIndex,
  participantMaximum,
  onMapChange,
  onDeleteSavedMap,
  onRosterChange,
  onArrangementChange,
  onOpenGenerator,
  onStart,
  hasSavedGames,
  onOpenSavedGames,
  onBack,
  storageFeedback,
  utilityControls,
}: StartMenuProps) {
  const [prepared, setPrepared] = useState<{ key: string; result: ScenarioResult } | null>(null)
  const [workerErrorKey, setWorkerErrorKey] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<SavedMapDefinition | null>(null)
  const [selectedSeatRegion, setSelectedSeatRegion] = useState<number | null>(null)
  const [draggingSeatRegion, setDraggingSeatRegion] = useState<number | null>(null)
  const [dropTargetRegion, setDropTargetRegion] = useState<number | null>(null)
  const [allianceTargetRegion, setAllianceTargetRegion] = useState<number | null>(null)
  const [draggingCandidate, setDraggingCandidate] = useState<AiProfileId | 'player' | null>(null)
  const [dragIntent, setDragIntent] = useState<'invite' | 'alliance' | 'swap' | 'separate' | null>(null)
  const selectedDefinition = useMemo(() => {
    if (selectedMap.startsWith('saved:')) {
      const saved = savedMaps.find((map) => savedSelection(map.id) === selectedMap)
      if (saved) return { id: saved.id, name: saved.name, settings: saved.settings, manualGrid: saved.manualGrid }
    }
    const preset = mapPresets.find((candidate) => presetSelection(candidate.id) === selectedMap) ?? mapPresets[0]
    const copy = text.presets[preset.id]
    return { id: preset.id, name: copy.name, settings: preset.settings, manualGrid: defaultPreviewGrid }
  }, [savedMaps, selectedMap, text])
  const preparationKey = `${selectedMap}:${participantCount}:${selectedDefinition.settings.seed}:${selectedDefinition.settings.mapSize}`
  const preparedResult = prepared?.key === preparationKey ? prepared.result : null
  const workerFailed = workerErrorKey === preparationKey
  const isPreparing = !preparedResult && !workerFailed
  const battleSeats = useMemo<BattleSeatPreview[]>(() => {
    const aiOccurrences = new Map<AiProfileId, number>()
    const seats: Omit<BattleSeatPreview, 'regionIndex'>[] = [
      ...(hasHumanPlayer ? [{ kind: 'player' as const, name: opponentsText.player, teamId: participantTeamIds[0] ?? 1 }] : []),
      ...opponentProfileIds.map((profileId, index) => {
        const occurrence = aiOccurrences.get(profileId) ?? 0
        aiOccurrences.set(profileId, occurrence + 1)
        return {
          kind: 'ai' as const,
          name: aiProfileDisplayName(opponentsText, profileId, occurrence),
          profileId,
          opponentIndex: index,
          teamId: participantTeamIds[index + Number(hasHumanPlayer)] ?? index + 1,
        }
      }),
    ]
    return seats.map((seat, index) => ({ ...seat, regionIndex: hasHumanPlayer ? (humanRegionIndex + index) % participantCount : index }))
  }, [hasHumanPlayer, humanRegionIndex, opponentProfileIds, opponentsText, participantCount, participantTeamIds])
  const orderedBattleSeats = useMemo(() => [...battleSeats].sort((first, second) => first.regionIndex - second.regionIndex), [battleSeats])
  const preparedScenario = preparedResult?.ok ? preparedResult.scenario : null
  const seatPositions = tableSeatPositions[participantCount as keyof typeof tableSeatPositions] ?? tableSeatPositions[4]

  useEffect(() => {
    const controller = new AbortController()
    const map = clearMapObjects(getPreviewMap(selectedMap, selectedDefinition.settings, selectedDefinition.manualGrid))
    calculateScenarioInWorker(map, participantCount, selectedDefinition.settings.seed, controller.signal)
      .then((result) => {
        setWorkerErrorKey(null)
        if (result.ok)
          setPrepared({
            key: preparationKey,
            result: { ok: true, scenario: { ...result.scenario, id: selectedDefinition.id, name: selectedDefinition.name } },
          })
        else setPrepared({ key: preparationKey, result })
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setWorkerErrorKey(preparationKey)
      })
    return () => controller.abort()
  }, [participantCount, preparationKey, retryKey, selectedDefinition, selectedMap])

  const clearInteraction = () => {
    setSelectedSeatRegion(null)
    setDraggingSeatRegion(null)
    setDropTargetRegion(null)
    setAllianceTargetRegion(null)
    setDraggingCandidate(null)
    setDragIntent(null)
  }

  const applyArrangement = (nextSeats: BattleSeatPreview[]) => {
    const player = nextSeats.find((seat) => seat.kind === 'player')
    const nextHumanRegion = player?.regionIndex ?? 0
    const orderedAi = nextSeats
      .filter((seat): seat is BattleSeatPreview & { profileId: AiProfileId } => seat.kind === 'ai' && Boolean(seat.profileId))
      .sort((first, second) => {
        if (!hasHumanPlayer) return first.regionIndex - second.regionIndex
        const firstOffset = (first.regionIndex - nextHumanRegion + participantCount) % participantCount
        const secondOffset = (second.regionIndex - nextHumanRegion + participantCount) % participantCount
        return firstOffset - secondOffset
      })
    onArrangementChange(
      nextHumanRegion,
      orderedAi.map((seat) => seat.profileId),
      [...(player ? [player.teamId] : []), ...orderedAi.map((seat) => seat.teamId)],
    )
    clearInteraction()
  }

  const moveParticipant = (sourceRegionIndex: number, targetRegionIndex: number) => {
    if (sourceRegionIndex === targetRegionIndex) {
      clearInteraction()
      return
    }
    applyArrangement(
      battleSeats.map((seat) => {
        if (seat.regionIndex === sourceRegionIndex) return { ...seat, regionIndex: targetRegionIndex }
        if (seat.regionIndex === targetRegionIndex) return { ...seat, regionIndex: sourceRegionIndex }
        return seat
      }),
    )
  }

  const joinAlliance = (sourceRegionIndex: number, targetRegionIndex: number) => {
    const target = battleSeats.find((seat) => seat.regionIndex === targetRegionIndex)
    if (!target || sourceRegionIndex === targetRegionIndex) {
      clearInteraction()
      return
    }
    applyArrangement(battleSeats.map((seat) => (seat.regionIndex === sourceRegionIndex ? { ...seat, teamId: target.teamId } : seat)))
  }

  const leaveAlliance = (sourceRegionIndex: number) => {
    const usedByOthers = new Set(battleSeats.filter((seat) => seat.regionIndex !== sourceRegionIndex).map((seat) => seat.teamId))
    const ownTeamId = Array.from({ length: participantCount }, (_, index) => index + 1).find((teamId) => !usedByOthers.has(teamId))
    if (!ownTeamId) {
      clearInteraction()
      return
    }
    applyArrangement(battleSeats.map((seat) => (seat.regionIndex === sourceRegionIndex ? { ...seat, teamId: ownTeamId } : seat)))
  }

  const nextUnusedTeam = (teamIds: number[]) =>
    Array.from({ length: participantMaximum }, (_, index) => index + 1).find((teamId) => !teamIds.includes(teamId)) ?? 1

  const toggleHumanParticipant = () => {
    if (hasHumanPlayer) {
      if (participantCount <= 1) return
      clearInteraction()
      onRosterChange(false, opponentProfileIds, participantTeamIds.slice(1))
      return
    }
    if (participantCount >= participantMaximum) return
    clearInteraction()
    onRosterChange(true, opponentProfileIds, [nextUnusedTeam(participantTeamIds), ...participantTeamIds])
  }

  const addOpponent = (profileId: AiProfileId) => {
    if (participantCount >= participantMaximum) return
    clearInteraction()
    onRosterChange(hasHumanPlayer, [...opponentProfileIds, profileId], [...participantTeamIds, nextUnusedTeam(participantTeamIds)])
  }

  const removeParticipant = (seat: BattleSeatPreview) => {
    if (participantCount <= 1) return
    if (seat.kind === 'player') {
      toggleHumanParticipant()
      return
    }
    const profileIndex = seat.opponentIndex
    if (profileIndex === undefined) return
    const teamIndex = profileIndex + Number(hasHumanPlayer)
    clearInteraction()
    onRosterChange(
      hasHumanPlayer,
      opponentProfileIds.filter((_, index) => index !== profileIndex),
      participantTeamIds.filter((_, index) => index !== teamIndex),
    )
  }

  const selectParticipant = (regionIndex: number) => {
    setSelectedSeatRegion((current) => (current === regionIndex ? null : regionIndex))
  }

  const beginCandidateDrag = (event: DragEvent<HTMLButtonElement>, candidate: AiProfileId | 'player') => {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/x-battle-candidate', candidate)
    setDraggingCandidate(candidate)
    setDragIntent('invite')
  }

  const dropCandidate = (event: DragEvent<HTMLElement>) => {
    const candidate = event.dataTransfer.getData('application/x-battle-candidate')
    if (!candidate || participantCount >= participantMaximum) return false
    if (candidate === 'player') {
      if (!hasHumanPlayer) toggleHumanParticipant()
    } else if (aiProfileIds.includes(candidate as AiProfileId)) {
      addOpponent(candidate as AiProfileId)
    }
    clearInteraction()
    return true
  }

  const allianceConnections = orderedBattleSeats.flatMap((seat, index) =>
    orderedBattleSeats.slice(index + 1).flatMap((other) => {
      if (seat.teamId !== other.teamId) return []
      const first = seatPositions[seat.regionIndex]
      const second = seatPositions[other.regionIndex]
      if (!first || !second) return []
      return [
        { key: `${seat.regionIndex}-${other.regionIndex}`, first, second, color: REGION_COLORS[(seat.teamId - 1) % REGION_COLORS.length] },
      ]
    }),
  )
  const selectedSeat = selectedSeatRegion === null ? null : (battleSeats.find((seat) => seat.regionIndex === selectedSeatRegion) ?? null)
  const headerSeat = selectedSeat ?? battleSeats.find((seat) => seat.kind === 'player') ?? orderedBattleSeats[0]
  const headerRegionColor = headerSeat
    ? (preparedScenario?.regions[headerSeat.regionIndex]?.color ?? REGION_COLORS[headerSeat.regionIndex])
    : REGION_COLORS[0]
  const headerTeamColor = headerSeat ? REGION_COLORS[(headerSeat.teamId - 1) % REGION_COLORS.length] : REGION_COLORS[0]
  const headerSeatStyle = { '--region-color': headerRegionColor, '--team-color': headerTeamColor } as CSSProperties

  return (
    <main className="start-screen battle-setup-screen">
      <img
        className="start-hero-art"
        src={`${import.meta.env.BASE_URL}assets/start-menu-hero.webp`}
        alt=""
        aria-hidden="true"
        fetchPriority="high"
      />
      <div className="start-atmosphere" aria-hidden="true" />
      <section className="start-menu battle-setup-menu" aria-label={text.battleTitle}>
        <header className="battle-setup-toolbar">
          <button type="button" className="menu-back-button" onClick={onBack}>
            <span aria-hidden="true">←</span>
            {text.backToModes}
          </button>
          <div className="battle-setup-actions">
            {hasSavedGames && (
              <button type="button" className="load-game-button" onClick={onOpenSavedGames}>
                {text.loadGame}
              </button>
            )}
            <button
              type="button"
              className="start-match-button"
              disabled={!preparedResult?.ok}
              onClick={() => {
                if (preparedResult?.ok) onStart(preparedResult.scenario)
              }}
            >
              {isPreparing ? text.starting : hasHumanPlayer ? text.start : text.watch}
              <span aria-hidden="true">{isPreparing ? '…' : '→'}</span>
            </button>
          </div>
        </header>

        <div className="battle-setup-layout">
          <section
            className={`battle-war-table${draggingCandidate !== null ? ' is-candidate-dragging' : ''}`}
            aria-labelledby="battle-table-title"
          >
            <header className="battle-war-table-header">
              <h2 id="battle-table-title">{text.arrangementTitle}</h2>
              {headerSeat && (
                <div
                  className="battle-table-summary"
                  style={headerSeatStyle}
                  aria-label={`${headerSeat.name}: ${opponentsText.region} ${headerSeat.regionIndex + 1}, ${opponentsText.alliance} ${headerSeat.teamId}`}
                >
                  <span className="battle-table-summary-avatar" aria-hidden="true">
                    {headerSeat.profileId ? (
                      <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[headerSeat.profileId]}`} alt="" />
                    ) : (
                      <b>{opponentsText.playerMark}</b>
                    )}
                  </span>
                  <strong>{headerSeat.name}</strong>
                  <span className="battle-table-summary-region">
                    <i aria-hidden="true" />
                    {opponentsText.region} {headerSeat.regionIndex + 1}
                  </span>
                  <span className="battle-table-summary-alliance">
                    <i aria-hidden="true">{headerSeat.teamId}</i>
                    {opponentsText.alliance}
                  </span>
                </div>
              )}
            </header>
            <div className="battle-table-body">
              <section className="battle-roster-rail" aria-label={opponentsText.choose}>
                <header>
                  <strong>
                    {participantCount} / {participantMaximum}
                  </strong>
                </header>
                <div className="battle-roster-candidates">
                  <article className={`battle-roster-candidate human${hasHumanPlayer ? ' selected' : ''}`}>
                    <button
                      type="button"
                      className="battle-roster-candidate-main"
                      draggable={!hasHumanPlayer && participantCount < participantMaximum}
                      aria-pressed={hasHumanPlayer}
                      disabled={(hasHumanPlayer && participantCount <= 1) || (!hasHumanPlayer && participantCount >= participantMaximum)}
                      onClick={toggleHumanParticipant}
                      onDragStart={(event) => beginCandidateDrag(event, 'player')}
                      onDragEnd={clearInteraction}
                    >
                      <span className="battle-roster-candidate-avatar">
                        <b>{opponentsText.playerMark}</b>
                      </span>
                      <span>
                        <strong>{opponentsText.player}</strong>
                      </span>
                    </button>
                    <aside className="battle-roster-candidate-tooltip" role="tooltip">
                      <strong>{opponentsText.player}</strong>
                      <span>{opponentsText.playerDescription}</span>
                    </aside>
                  </article>
                  {aiProfileIds.map((profileId) => {
                    const copy = opponentsText.profiles[profileId]
                    const selectedCount = opponentProfileIds.filter((candidate) => candidate === profileId).length
                    return (
                      <article key={profileId} className={`battle-roster-candidate${selectedCount > 0 ? ' selected' : ''}`}>
                        <button
                          type="button"
                          className="battle-roster-candidate-main"
                          draggable={participantCount < participantMaximum}
                          disabled={participantCount >= participantMaximum}
                          aria-label={`${opponentsText.addOpponent}: ${copy.name}`}
                          onClick={() => addOpponent(profileId)}
                          onDragStart={(event) => beginCandidateDrag(event, profileId)}
                          onDragEnd={clearInteraction}
                        >
                          <span className="battle-roster-candidate-avatar">
                            <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[profileId]}`} alt="" />
                          </span>
                          <span>
                            <strong>{copy.name}</strong>
                          </span>
                        </button>
                        <aside className="battle-roster-candidate-tooltip" role="tooltip">
                          <strong>{copy.name}</strong>
                          <span>{copy.role}</span>
                          <p>{copy.strategy}</p>
                          <em>{copy.toolkit}</em>
                        </aside>
                        {selectedCount > 0 && <em aria-label={`${text.selectedCount}: ${selectedCount}`}>{selectedCount}</em>}
                      </article>
                    )
                  })}
                </div>
              </section>
              <div
                className={`battle-war-table-stage seats-${participantCount}${draggingSeatRegion !== null || draggingCandidate !== null ? ' is-dragging' : ''}${draggingCandidate !== null ? ' is-roster-drop' : ''}`}
                onClick={() => setSelectedSeatRegion(null)}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = draggingCandidate !== null ? 'copy' : 'move'
                  if (draggingCandidate !== null) setDragIntent('invite')
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dropCandidate(event)) return
                  const source = Number(event.dataTransfer.getData('text/plain'))
                  if (Number.isInteger(source)) leaveAlliance(source)
                }}
              >
                <div className="battle-table-surface" aria-hidden="true">
                  <span />
                  <i />
                  <b />
                </div>
                {dragIntent && (
                  <aside className={`battle-drag-intent ${dragIntent}`} aria-live="polite">
                    <i aria-hidden="true" />
                    {dragIntent === 'invite'
                      ? text.dragInvite
                      : dragIntent === 'alliance'
                        ? text.dragAlliance
                        : dragIntent === 'swap'
                          ? text.dragSwap
                          : text.dragSeparate}
                  </aside>
                )}
                {selectedSeat && draggingSeatRegion === null && draggingCandidate === null && (
                  <aside className="battle-alliance-panel" onClick={(event) => event.stopPropagation()}>
                    <header>
                      <span>{text.allianceFor}</span>
                      <strong>{selectedSeat.name}</strong>
                      <button
                        type="button"
                        aria-label={text.clearSelection}
                        title={text.clearSelection}
                        onClick={() => setSelectedSeatRegion(null)}
                      >
                        ×
                      </button>
                    </header>
                    <div>
                      {orderedBattleSeats
                        .filter((seat) => seat.regionIndex !== selectedSeat.regionIndex)
                        .map((seat) => {
                          const allied = seat.teamId === selectedSeat.teamId
                          return (
                            <button
                              key={`${seat.kind}-${seat.regionIndex}`}
                              type="button"
                              className={allied ? 'allied' : ''}
                              disabled={allied}
                              onClick={() => joinAlliance(selectedSeat.regionIndex, seat.regionIndex)}
                              title={allied ? text.alreadyAllied : `${text.allyWith}: ${seat.name}`}
                            >
                              <span className="battle-alliance-panel-avatar">
                                {seat.profileId ? (
                                  <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[seat.profileId]}`} alt="" />
                                ) : (
                                  <b>{opponentsText.playerMark}</b>
                                )}
                              </span>
                              <span>
                                <small>{allied ? text.alreadyAllied : text.allyWith}</small>
                                <strong>{seat.name}</strong>
                              </span>
                            </button>
                          )
                        })}
                    </div>
                    {battleSeats.some((seat) => seat.regionIndex !== selectedSeat.regionIndex && seat.teamId === selectedSeat.teamId) && (
                      <button type="button" className="battle-alliance-leave" onClick={() => leaveAlliance(selectedSeat.regionIndex)}>
                        {text.dragSeparate}
                      </button>
                    )}
                    {participantCount > 1 && (
                      <button type="button" className="battle-participant-remove" onClick={() => removeParticipant(selectedSeat)}>
                        {opponentsText.removeOpponent}: {selectedSeat.name}
                      </button>
                    )}
                  </aside>
                )}
                {allianceConnections.length > 0 && (
                  <svg className="battle-alliance-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    {allianceConnections.map((connection) => (
                      <line
                        key={connection.key}
                        x1={connection.first.x}
                        y1={connection.first.y}
                        x2={connection.second.x}
                        y2={connection.second.y}
                        style={{ stroke: connection.color }}
                      />
                    ))}
                  </svg>
                )}
                {orderedBattleSeats.map((seat) => {
                  const position = seatPositions[seat.regionIndex]
                  if (!position) return null
                  const regionColor = preparedScenario?.regions[seat.regionIndex]?.color ?? REGION_COLORS[seat.regionIndex]
                  const seatStyle = {
                    '--seat-x': `${position.x}%`,
                    '--seat-y': `${position.y}%`,
                    '--region-color': regionColor,
                  } as CSSProperties
                  const allies = battleSeats
                    .filter((candidate) => candidate !== seat && candidate.teamId === seat.teamId)
                    .map((candidate) => candidate.name)
                  return (
                    <div
                      key={`${seat.kind}-${seat.regionIndex}-${seat.profileId ?? 'player'}`}
                      className={`battle-region-slot${position.y < 30 ? ' top-seat' : ''}${selectedSeatRegion !== null && selectedSeatRegion !== seat.regionIndex ? ' available-target' : ''}${dropTargetRegion === seat.regionIndex ? ' drop-target' : ''}`}
                      style={seatStyle}
                      onDragEnter={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        if (draggingCandidate !== null) {
                          setDragIntent('invite')
                          return
                        }
                        setDropTargetRegion(seat.regionIndex)
                        setDragIntent('swap')
                      }}
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        event.dataTransfer.dropEffect = draggingCandidate !== null ? 'copy' : 'move'
                      }}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                          setDropTargetRegion((current) => (current === seat.regionIndex ? null : current))
                          setDragIntent(draggingCandidate !== null ? 'invite' : 'separate')
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        if (dropCandidate(event)) return
                        const source = Number(event.dataTransfer.getData('text/plain'))
                        if (Number.isInteger(source)) moveParticipant(source, seat.regionIndex)
                      }}
                    >
                      <span className="battle-region-slot-number" aria-hidden="true">
                        {seat.regionIndex + 1}
                      </span>
                      <BattleParticipantToken
                        seat={seat}
                        regionColor={regionColor}
                        allies={allies}
                        selected={selectedSeatRegion === seat.regionIndex}
                        dragging={draggingSeatRegion === seat.regionIndex}
                        allianceTarget={allianceTargetRegion === seat.regionIndex}
                        text={opponentsText}
                        onSelect={() => selectParticipant(seat.regionIndex)}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', String(seat.regionIndex))
                          setDraggingSeatRegion(seat.regionIndex)
                          setSelectedSeatRegion(seat.regionIndex)
                          setDragIntent('separate')
                        }}
                        onDragEnd={clearInteraction}
                        onAllianceDragEnter={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          if (draggingCandidate !== null) {
                            setDragIntent('invite')
                            return
                          }
                          if (draggingSeatRegion !== seat.regionIndex) {
                            setAllianceTargetRegion(seat.regionIndex)
                            setDragIntent('alliance')
                          }
                        }}
                        onAllianceDragLeave={(event) => {
                          event.stopPropagation()
                          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                            setAllianceTargetRegion((current) => (current === seat.regionIndex ? null : current))
                            setDragIntent(draggingCandidate !== null ? 'invite' : 'swap')
                          }
                        }}
                        onAllianceDrop={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          if (dropCandidate(event)) return
                          const source = Number(event.dataTransfer.getData('text/plain'))
                          if (Number.isInteger(source)) joinAlliance(source, seat.regionIndex)
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          </section>

          <aside className="battle-map-sidebar">
            <section className="battle-map-overview" aria-label={selectedDefinition.name}>
              <header>
                <span>{text.chooseMap}</span>
                <strong>{selectedDefinition.name}</strong>
              </header>
              <div className="battle-map-overview-canvas">
                <BattleMapPreview
                  cacheKey={selectedMap}
                  settings={selectedDefinition.settings}
                  manualGrid={selectedDefinition.manualGrid}
                  large
                  scenario={preparedScenario}
                  participants={battleSeats}
                  playerMark={opponentsText.playerMark}
                  regionLabel={opponentsText.region}
                  allianceLabel={opponentsText.alliance}
                  selectedRegionIndex={selectedSeatRegion}
                  draggingRegionIndex={draggingSeatRegion}
                  onParticipantSelect={selectParticipant}
                  onParticipantDragStart={(regionIndex) => {
                    setDraggingSeatRegion(regionIndex)
                    setSelectedSeatRegion(regionIndex)
                    setDragIntent('separate')
                  }}
                  onParticipantDragEnd={clearInteraction}
                  onParticipantDrop={moveParticipant}
                />
              </div>
              {isPreparing && (
                <div className="showcase-region-loader" role="status">
                  <span aria-hidden="true" />
                  {text.starting}
                </div>
              )}
              {workerFailed && (
                <p className="showcase-region-error" role="alert">
                  {text.workerError}{' '}
                  <button type="button" onClick={() => setRetryKey((current) => current + 1)}>
                    {text.retry}
                  </button>
                </p>
              )}
              {preparedResult && !preparedResult.ok && (
                <p className="showcase-region-error" role="alert">
                  {preparedResult.reason === 'unviable-starts' ? text.mapUnviable : text.mapError}
                </p>
              )}
            </section>

            <section className="map-library battle-setup-library" aria-label={text.chooseMap}>
              {storageFeedback && (
                <p className="map-storage-feedback" role="alert">
                  {storageFeedback}
                </p>
              )}
              <div className="map-library-scroll">
                <div className="map-library-group">
                  <h3>{text.builtInMaps}</h3>
                  <div className="map-choice-list">
                    {mapPresets.map((preset) => {
                      const selection = presetSelection(preset.id)
                      const copy = text.presets[preset.id]
                      return (
                        <MapChoice
                          key={selection}
                          name={copy.name}
                          selected={selectedMap === selection}
                          preview={<BattleMapPreview cacheKey={selection} settings={preset.settings} manualGrid={defaultPreviewGrid} />}
                          onSelect={() => onMapChange(selection)}
                        />
                      )
                    })}
                  </div>
                </div>
                <div className="map-library-separator" aria-hidden="true" />
                <div className="map-library-group">
                  <h3>{text.myMaps}</h3>
                  <div className="map-choice-list">
                    {savedMaps.map((map) => {
                      const selection = savedSelection(map.id)
                      return (
                        <MapChoice
                          key={selection}
                          name={map.name}
                          selected={selectedMap === selection}
                          preview={<BattleMapPreview cacheKey={selection} settings={map.settings} manualGrid={map.manualGrid} />}
                          onSelect={() => onMapChange(selection)}
                          onDelete={() => setPendingDelete(map)}
                          deleteLabel={text.deleteSavedMap}
                        />
                      )
                    })}
                    <button
                      type="button"
                      className="create-map-choice"
                      aria-label={`${text.customMap}. ${text.customMapDescription} ${text.openGenerator}`}
                      onClick={onOpenGenerator}
                    >
                      <i aria-hidden="true">+</i>
                      <span>
                        <strong>{text.customMap}</strong>
                        <small>{text.openGenerator}</small>
                      </span>
                    </button>
                  </div>
                </div>
              </div>
              <div className="battle-setup-utility">{utilityControls}</div>
            </section>
          </aside>
        </div>
      </section>
      {pendingDelete && (
        <ConfirmDialog
          title={`${confirmationText.deleteMapTitle} «${pendingDelete.name}»`}
          description={confirmationText.deleteMapDescription}
          cancelLabel={confirmationText.cancel}
          confirmLabel={confirmationText.deleteMapAction}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            onDeleteSavedMap(pendingDelete.id)
            setPendingDelete(null)
          }}
        />
      )}
    </main>
  )
}
