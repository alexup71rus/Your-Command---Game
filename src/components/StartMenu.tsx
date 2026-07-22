import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { aiAvatarPaths } from '../config/ai'
import { aiProfileDisplayName, type LocaleDictionary } from '../config/localization'
import { aiProfileIds } from '../game/ai/model'
import { createManualHeightGrid, generateMap, type GeneratorSettings, type ManualHeightGrid } from '../game/generator'
import { clearMapObjects, type GameMap } from '../game/map'
import { mapPresets } from '../game/presets'
import { presetSelection, savedSelection, type MapSelection, type SavedMapDefinition } from '../game/savedMaps'
import { REGION_COLORS, type AiProfileId, type MapScenario, type ScenarioResult } from '../game/scenario'
import { calculateScenarioInWorker } from '../game/scenarioWorkerClient'
import { ConfirmDialog } from './ui/ConfirmDialog'

const previewCache = new Map<string, GameMap>()
const defaultPreviewGrid = createManualHeightGrid()

interface BattleSeatPreview {
  kind: 'player' | 'ai'
  name: string
  regionIndex: number
  teamId: number
  profileId?: AiProfileId
  opponentIndex?: number
}

const tableSeatPositions = {
  1: [{ x: 50, y: 50 }],
  2: [{ x: 21, y: 50 }, { x: 79, y: 50 }],
  3: [{ x: 50, y: 19 }, { x: 22, y: 72 }, { x: 78, y: 72 }],
  4: [{ x: 50, y: 17 }, { x: 84, y: 50 }, { x: 50, y: 83 }, { x: 16, y: 50 }],
} as const

function previewMapFor(cacheKey: string, settings: GeneratorSettings, manualGrid: ManualHeightGrid) {
  const cached = previewCache.get(cacheKey)
  if (cached) return cached
  const map = generateMap(settings, manualGrid)
  previewCache.set(cacheKey, map)
  return map
}

interface MapPreviewProps {
  cacheKey: string
  settings: GeneratorSettings
  manualGrid: ManualHeightGrid
  large?: boolean
  scenario?: MapScenario | null
  participants?: BattleSeatPreview[]
  playerMark?: string
  regionLabel?: string
  allianceLabel?: string
  selectedRegionIndex?: number | null
  draggingRegionIndex?: number | null
  onParticipantSelect?: (regionIndex: number) => void
  onParticipantDragStart?: (regionIndex: number) => void
  onParticipantDragEnd?: () => void
  onParticipantDrop?: (fromRegionIndex: number, toRegionIndex: number) => void
}

function MapPreview({ cacheKey, settings, manualGrid, large = false, scenario, participants = [], playerMark, regionLabel, allianceLabel, selectedRegionIndex, draggingRegionIndex, onParticipantSelect, onParticipantDragStart, onParticipantDragEnd, onParticipantDrop }: MapPreviewProps) {
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
    if (!scenario) return
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
    if (participants.length === 0) scenario.regions.forEach((region) => {
      const x = (region.center.column + 0.5) * cellWidth
      const y = (region.center.row + 0.5) * cellHeight
      context.fillStyle = region.color
      context.beginPath(); context.arc(x, y, 9, 0, Math.PI * 2); context.fill()
      context.fillStyle = '#121712'; context.font = '700 10px system-ui'; context.textAlign = 'center'; context.textBaseline = 'middle'
      context.fillText(String(region.index + 1), x, y + 0.5)
    })
  }, [cacheKey, large, manualGrid, participants, scenario, settings])

  const columns = scenario?.cells[0]?.length ?? 1
  const rows = scenario?.cells.length ?? 1
  const interactive = Boolean(onParticipantSelect && onParticipantDrop)
  return (
    <span className={`preset-map-preview${large ? ' large' : ''}`} aria-hidden={large ? undefined : 'true'}>
      <canvas ref={canvasRef} />
      {large && scenario && participants.length > 0 && <span className="battle-map-markers">
        {scenario.regions.map((region) => {
          const participant = participants.find((candidate) => candidate.regionIndex === region.index)
          if (!participant) return null
          const markerStyle = {
            '--marker-x': `${(region.center.column + 0.5) / columns * 100}%`,
            '--marker-y': `${(region.center.row + 0.5) / rows * 100}%`,
            '--marker-color': region.color,
          } as CSSProperties
          const markerContent = <span className="battle-map-marker-portrait">{participant.profileId ? <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[participant.profileId]}`} alt="" /> : <b>{playerMark}</b>}<i>{region.index + 1}</i></span>
          if (!interactive) return <span key={region.id} className="battle-map-marker" style={markerStyle} title={`${participant.name} · ${allianceLabel} ${participant.teamId}`}>{markerContent}</span>
          return <button
            key={region.id}
            type="button"
            draggable
            className={`battle-map-marker${participant.kind === 'player' ? ' player' : ''}${selectedRegionIndex === region.index ? ' selected' : ''}${draggingRegionIndex === region.index ? ' dragging' : ''}`}
            style={markerStyle}
            title={`${participant.name} · ${regionLabel} ${region.index + 1} · ${allianceLabel} ${participant.teamId}`}
            aria-label={`${participant.name}. ${regionLabel} ${region.index + 1}. ${allianceLabel} ${participant.teamId}`}
            aria-pressed={selectedRegionIndex === region.index}
            onClick={() => onParticipantSelect?.(region.index)}
            onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(region.index)); onParticipantDragStart?.(region.index) }}
            onDragEnd={onParticipantDragEnd}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
            onDrop={(event) => { event.preventDefault(); const source = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(source)) onParticipantDrop?.(source, region.index) }}
          >{markerContent}</button>
        })}
      </span>}
    </span>
  )
}

function MapChoice({ name, selected, preview, onSelect, onDelete, deleteLabel }: { name: string; selected: boolean; preview: ReactNode; onSelect: () => void; onDelete?: () => void; deleteLabel?: string }) {
  return (
    <article className={`map-choice${selected ? ' selected' : ''}`}>
      <button type="button" className="map-choice-main" onClick={onSelect} aria-pressed={selected}>{preview}<span className="map-choice-copy"><strong>{name}</strong></span></button>
      {onDelete && <button type="button" className="saved-map-delete danger" onClick={onDelete} aria-label={`${deleteLabel}: ${name}`} title={`${deleteLabel}: ${name}`}>×</button>}
    </article>
  )
}

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

function ParticipantToken({ seat, regionColor, allies, selected, dragging, allianceTarget, text, onSelect, onDragStart, onDragEnd, onAllianceDragEnter, onAllianceDragLeave, onAllianceDrop }: { seat: BattleSeatPreview; regionColor: string; allies: string[]; selected: boolean; dragging: boolean; allianceTarget: boolean; text: LocaleDictionary['opponents']; onSelect: () => void; onDragStart: (event: DragEvent<HTMLButtonElement>) => void; onDragEnd: () => void; onAllianceDragEnter: (event: DragEvent<HTMLButtonElement>) => void; onAllianceDragLeave: (event: DragEvent<HTMLButtonElement>) => void; onAllianceDrop: (event: DragEvent<HTMLButtonElement>) => void }) {
  const teamColor = REGION_COLORS[(seat.teamId - 1) % REGION_COLORS.length]
  const tokenStyle = { '--region-color': regionColor, '--team-color': teamColor } as CSSProperties
  const tooltipId = `battle-participant-${seat.kind}-${seat.regionIndex}-${seat.profileId ?? 'player'}`
  return <div className="battle-participant-token-shell" style={tokenStyle}>
    <button
      type="button"
      draggable
      className={`battle-participant-token${seat.kind === 'player' ? ' player' : ''}${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${allianceTarget ? ' alliance-target' : ''}`}
      aria-label={`${seat.name}. ${text.region} ${seat.regionIndex + 1}. ${text.alliance} ${seat.teamId}${allies.length > 0 ? `. ${text.allies}: ${allies.join(', ')}` : ''}`}
      aria-pressed={selected}
      aria-describedby={tooltipId}
      onClick={(event) => { event.stopPropagation(); onSelect() }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragEnter={onAllianceDragEnter}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move' }}
      onDragLeave={onAllianceDragLeave}
      onDrop={onAllianceDrop}
    >
      <span className="battle-participant-portrait">{seat.profileId ? <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[seat.profileId]}`} alt="" /> : <b>{text.playerMark}</b>}</span>
      <i className="battle-participant-alliance" aria-label={`${text.alliance} ${seat.teamId}`}>{seat.teamId}</i>
    </button>
    <aside className="battle-participant-tooltip" id={tooltipId} role="tooltip">
      <strong>{seat.name}</strong>
      <span>{text.region} {seat.regionIndex + 1}</span>
      <small>{allies.length > 0 ? `${text.allies}: ${allies.join(', ')}` : `${text.alliance} ${seat.teamId}`}</small>
    </aside>
  </div>
}

export function StartMenu({ text, opponentsText, confirmationText, selectedMap, savedMaps, participantCount, opponentProfileIds, participantTeamIds, hasHumanPlayer, humanRegionIndex, participantMaximum, onMapChange, onDeleteSavedMap, onRosterChange, onArrangementChange, onOpenGenerator, onStart, hasSavedGames, onOpenSavedGames, onBack, storageFeedback, utilityControls }: StartMenuProps) {
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
    const map = clearMapObjects(previewMapFor(selectedMap, selectedDefinition.settings, selectedDefinition.manualGrid))
    calculateScenarioInWorker(map, participantCount, selectedDefinition.settings.seed, controller.signal)
      .then((result) => {
        setWorkerErrorKey(null)
        if (result.ok) setPrepared({ key: preparationKey, result: { ok: true, scenario: { ...result.scenario, id: selectedDefinition.id, name: selectedDefinition.name } } })
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
    onArrangementChange(nextHumanRegion, orderedAi.map((seat) => seat.profileId), [
      ...(player ? [player.teamId] : []),
      ...orderedAi.map((seat) => seat.teamId),
    ])
    clearInteraction()
  }

  const moveParticipant = (sourceRegionIndex: number, targetRegionIndex: number) => {
    if (sourceRegionIndex === targetRegionIndex) {
      clearInteraction()
      return
    }
    applyArrangement(battleSeats.map((seat) => {
      if (seat.regionIndex === sourceRegionIndex) return { ...seat, regionIndex: targetRegionIndex }
      if (seat.regionIndex === targetRegionIndex) return { ...seat, regionIndex: sourceRegionIndex }
      return seat
    }))
  }

  const joinAlliance = (sourceRegionIndex: number, targetRegionIndex: number) => {
    const target = battleSeats.find((seat) => seat.regionIndex === targetRegionIndex)
    if (!target || sourceRegionIndex === targetRegionIndex) {
      clearInteraction()
      return
    }
    applyArrangement(battleSeats.map((seat) => seat.regionIndex === sourceRegionIndex ? { ...seat, teamId: target.teamId } : seat))
  }

  const leaveAlliance = (sourceRegionIndex: number) => {
    const usedByOthers = new Set(battleSeats.filter((seat) => seat.regionIndex !== sourceRegionIndex).map((seat) => seat.teamId))
    const ownTeamId = Array.from({ length: participantCount }, (_, index) => index + 1).find((teamId) => !usedByOthers.has(teamId))
    if (!ownTeamId) {
      clearInteraction()
      return
    }
    applyArrangement(battleSeats.map((seat) => seat.regionIndex === sourceRegionIndex ? { ...seat, teamId: ownTeamId } : seat))
  }

  const nextUnusedTeam = (teamIds: number[]) => (
    Array.from({ length: participantMaximum }, (_, index) => index + 1).find((teamId) => !teamIds.includes(teamId)) ?? 1
  )

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
    setSelectedSeatRegion((current) => current === regionIndex ? null : regionIndex)
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

  const allianceConnections = orderedBattleSeats.flatMap((seat, index) => orderedBattleSeats.slice(index + 1).flatMap((other) => {
    if (seat.teamId !== other.teamId) return []
    const first = seatPositions[seat.regionIndex]
    const second = seatPositions[other.regionIndex]
    if (!first || !second) return []
    return [{ key: `${seat.regionIndex}-${other.regionIndex}`, first, second, color: REGION_COLORS[(seat.teamId - 1) % REGION_COLORS.length] }]
  }))
  const selectedSeat = selectedSeatRegion === null ? null : battleSeats.find((seat) => seat.regionIndex === selectedSeatRegion) ?? null
  const headerSeat = selectedSeat ?? battleSeats.find((seat) => seat.kind === 'player') ?? orderedBattleSeats[0]
  const headerRegionColor = headerSeat ? preparedScenario?.regions[headerSeat.regionIndex]?.color ?? REGION_COLORS[headerSeat.regionIndex] : REGION_COLORS[0]
  const headerTeamColor = headerSeat ? REGION_COLORS[(headerSeat.teamId - 1) % REGION_COLORS.length] : REGION_COLORS[0]
  const headerSeatStyle = { '--region-color': headerRegionColor, '--team-color': headerTeamColor } as CSSProperties

  return (
    <main className="start-screen battle-setup-screen">
      <img className="start-hero-art" src={`${import.meta.env.BASE_URL}assets/start-menu-hero.webp`} alt="" aria-hidden="true" fetchPriority="high" />
      <div className="start-atmosphere" aria-hidden="true" />
      <section className="start-menu battle-setup-menu" aria-label={text.battleTitle}>
        <header className="battle-setup-toolbar">
          <button type="button" className="menu-back-button" onClick={onBack}><span aria-hidden="true">←</span>{text.backToModes}</button>
          <div className="battle-setup-actions">
            {hasSavedGames && <button type="button" className="load-game-button" onClick={onOpenSavedGames}>{text.loadGame}</button>}
            <button type="button" className="start-match-button" disabled={!preparedResult?.ok} onClick={() => { if (preparedResult?.ok) onStart(preparedResult.scenario) }}>{isPreparing ? text.starting : hasHumanPlayer ? text.start : text.watch}<span aria-hidden="true">{isPreparing ? '…' : '→'}</span></button>
          </div>
        </header>

        <div className="battle-setup-layout">
          <section className={`battle-war-table${draggingCandidate !== null ? ' is-candidate-dragging' : ''}`} aria-labelledby="battle-table-title">
            <header className="battle-war-table-header">
              <h2 id="battle-table-title">{text.arrangementTitle}</h2>
              {headerSeat && <div className="battle-table-summary" style={headerSeatStyle} aria-label={`${headerSeat.name}: ${opponentsText.region} ${headerSeat.regionIndex + 1}, ${opponentsText.alliance} ${headerSeat.teamId}`}>
                <span className="battle-table-summary-avatar" aria-hidden="true">{headerSeat.profileId ? <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[headerSeat.profileId]}`} alt="" /> : <b>{opponentsText.playerMark}</b>}</span>
                <strong>{headerSeat.name}</strong>
                <span className="battle-table-summary-region"><i aria-hidden="true" />{opponentsText.region} {headerSeat.regionIndex + 1}</span>
                <span className="battle-table-summary-alliance"><i aria-hidden="true">{headerSeat.teamId}</i>{opponentsText.alliance}</span>
              </div>}
            </header>
            <div className="battle-table-body">
            <section className="battle-roster-rail" aria-label={opponentsText.choose}>
              <header>
                <strong>{participantCount} / {participantMaximum}</strong>
              </header>
              <div className="battle-roster-candidates">
                <article className={`battle-roster-candidate human${hasHumanPlayer ? ' selected' : ''}`}>
                  <button type="button" className="battle-roster-candidate-main" draggable={!hasHumanPlayer && participantCount < participantMaximum} aria-pressed={hasHumanPlayer} disabled={(hasHumanPlayer && participantCount <= 1) || (!hasHumanPlayer && participantCount >= participantMaximum)} onClick={toggleHumanParticipant} onDragStart={(event) => beginCandidateDrag(event, 'player')} onDragEnd={clearInteraction}>
                    <span className="battle-roster-candidate-avatar"><b>{opponentsText.playerMark}</b></span>
                    <span><strong>{opponentsText.player}</strong></span>
                  </button>
                  <aside className="battle-roster-candidate-tooltip" role="tooltip"><strong>{opponentsText.player}</strong><span>{opponentsText.playerDescription}</span></aside>
                </article>
                {aiProfileIds.map((profileId) => {
                  const copy = opponentsText.profiles[profileId]
                  const selectedCount = opponentProfileIds.filter((candidate) => candidate === profileId).length
                  return <article key={profileId} className={`battle-roster-candidate${selectedCount > 0 ? ' selected' : ''}`}>
                    <button type="button" className="battle-roster-candidate-main" draggable={participantCount < participantMaximum} disabled={participantCount >= participantMaximum} aria-label={`${opponentsText.addOpponent}: ${copy.name}`} onClick={() => addOpponent(profileId)} onDragStart={(event) => beginCandidateDrag(event, profileId)} onDragEnd={clearInteraction}>
                      <span className="battle-roster-candidate-avatar"><img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[profileId]}`} alt="" /></span>
                      <span><strong>{copy.name}</strong></span>
                    </button>
                    <aside className="battle-roster-candidate-tooltip" role="tooltip"><strong>{copy.name}</strong><span>{copy.role}</span><p>{copy.strategy}</p><em>{copy.toolkit}</em></aside>
                    {selectedCount > 0 && <em aria-label={`${text.selectedCount}: ${selectedCount}`}>{selectedCount}</em>}
                  </article>
                })}
              </div>
            </section>
            <div
              className={`battle-war-table-stage seats-${participantCount}${draggingSeatRegion !== null || draggingCandidate !== null ? ' is-dragging' : ''}${draggingCandidate !== null ? ' is-roster-drop' : ''}`}
              onClick={() => setSelectedSeatRegion(null)}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = draggingCandidate !== null ? 'copy' : 'move'; if (draggingCandidate !== null) setDragIntent('invite') }}
              onDrop={(event) => { event.preventDefault(); if (dropCandidate(event)) return; const source = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(source)) leaveAlliance(source) }}
            >
              <div className="battle-table-surface" aria-hidden="true"><span /><i /><b /></div>
              {dragIntent && <aside className={`battle-drag-intent ${dragIntent}`} aria-live="polite"><i aria-hidden="true" />{dragIntent === 'invite' ? text.dragInvite : dragIntent === 'alliance' ? text.dragAlliance : dragIntent === 'swap' ? text.dragSwap : text.dragSeparate}</aside>}
              {selectedSeat && draggingSeatRegion === null && draggingCandidate === null && <aside className="battle-alliance-panel" onClick={(event) => event.stopPropagation()}>
                <header><span>{text.allianceFor}</span><strong>{selectedSeat.name}</strong><button type="button" aria-label={text.clearSelection} title={text.clearSelection} onClick={() => setSelectedSeatRegion(null)}>×</button></header>
                <div>
                  {orderedBattleSeats.filter((seat) => seat.regionIndex !== selectedSeat.regionIndex).map((seat) => {
                    const allied = seat.teamId === selectedSeat.teamId
                    return <button key={`${seat.kind}-${seat.regionIndex}`} type="button" className={allied ? 'allied' : ''} disabled={allied} onClick={() => joinAlliance(selectedSeat.regionIndex, seat.regionIndex)} title={allied ? text.alreadyAllied : `${text.allyWith}: ${seat.name}`}>
                      <span className="battle-alliance-panel-avatar">{seat.profileId ? <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[seat.profileId]}`} alt="" /> : <b>{opponentsText.playerMark}</b>}</span>
                      <span><small>{allied ? text.alreadyAllied : text.allyWith}</small><strong>{seat.name}</strong></span>
                    </button>
                  })}
                </div>
                {battleSeats.some((seat) => seat.regionIndex !== selectedSeat.regionIndex && seat.teamId === selectedSeat.teamId) && <button type="button" className="battle-alliance-leave" onClick={() => leaveAlliance(selectedSeat.regionIndex)}>{text.dragSeparate}</button>}
                {participantCount > 1 && <button type="button" className="battle-participant-remove" onClick={() => removeParticipant(selectedSeat)}>{opponentsText.removeOpponent}: {selectedSeat.name}</button>}
              </aside>}
              {allianceConnections.length > 0 && <svg className="battle-alliance-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                {allianceConnections.map((connection) => <line key={connection.key} x1={connection.first.x} y1={connection.first.y} x2={connection.second.x} y2={connection.second.y} style={{ stroke: connection.color }} />)}
              </svg>}
              {orderedBattleSeats.map((seat) => {
                const position = seatPositions[seat.regionIndex]
                if (!position) return null
                const regionColor = preparedScenario?.regions[seat.regionIndex]?.color ?? REGION_COLORS[seat.regionIndex]
                const seatStyle = { '--seat-x': `${position.x}%`, '--seat-y': `${position.y}%`, '--region-color': regionColor } as CSSProperties
                const allies = battleSeats.filter((candidate) => candidate !== seat && candidate.teamId === seat.teamId).map((candidate) => candidate.name)
                return <div
                  key={`${seat.kind}-${seat.regionIndex}-${seat.profileId ?? 'player'}`}
                  className={`battle-region-slot${position.y < 30 ? ' top-seat' : ''}${selectedSeatRegion !== null && selectedSeatRegion !== seat.regionIndex ? ' available-target' : ''}${dropTargetRegion === seat.regionIndex ? ' drop-target' : ''}`}
                  style={seatStyle}
                  onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); if (draggingCandidate !== null) { setDragIntent('invite'); return } setDropTargetRegion(seat.regionIndex); setDragIntent('swap') }}
                  onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = draggingCandidate !== null ? 'copy' : 'move' }}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDropTargetRegion((current) => current === seat.regionIndex ? null : current); setDragIntent(draggingCandidate !== null ? 'invite' : 'separate') } }}
                  onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (dropCandidate(event)) return; const source = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(source)) moveParticipant(source, seat.regionIndex) }}
                >
                  <span className="battle-region-slot-number" aria-hidden="true">{seat.regionIndex + 1}</span>
                  <ParticipantToken
                    seat={seat}
                    regionColor={regionColor}
                    allies={allies}
                    selected={selectedSeatRegion === seat.regionIndex}
                    dragging={draggingSeatRegion === seat.regionIndex}
                    allianceTarget={allianceTargetRegion === seat.regionIndex}
                    text={opponentsText}
                    onSelect={() => selectParticipant(seat.regionIndex)}
                    onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(seat.regionIndex)); setDraggingSeatRegion(seat.regionIndex); setSelectedSeatRegion(seat.regionIndex); setDragIntent('separate') }}
                    onDragEnd={clearInteraction}
                    onAllianceDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); if (draggingCandidate !== null) { setDragIntent('invite'); return } if (draggingSeatRegion !== seat.regionIndex) { setAllianceTargetRegion(seat.regionIndex); setDragIntent('alliance') } }}
                    onAllianceDragLeave={(event) => { event.stopPropagation(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setAllianceTargetRegion((current) => current === seat.regionIndex ? null : current); setDragIntent(draggingCandidate !== null ? 'invite' : 'swap') } }}
                    onAllianceDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (dropCandidate(event)) return; const source = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(source)) joinAlliance(source, seat.regionIndex) }}
                  />
                </div>
              })}
            </div>
            </div>
          </section>

          <aside className="battle-map-sidebar">
            <section className="battle-map-overview" aria-label={selectedDefinition.name}>
              <header><span>{text.chooseMap}</span><strong>{selectedDefinition.name}</strong></header>
              <div className="battle-map-overview-canvas">
                <MapPreview cacheKey={selectedMap} settings={selectedDefinition.settings} manualGrid={selectedDefinition.manualGrid} large scenario={preparedScenario} participants={battleSeats} playerMark={opponentsText.playerMark} regionLabel={opponentsText.region} allianceLabel={opponentsText.alliance} selectedRegionIndex={selectedSeatRegion} draggingRegionIndex={draggingSeatRegion} onParticipantSelect={selectParticipant} onParticipantDragStart={(regionIndex) => { setDraggingSeatRegion(regionIndex); setSelectedSeatRegion(regionIndex); setDragIntent('separate') }} onParticipantDragEnd={clearInteraction} onParticipantDrop={moveParticipant} />
              </div>
              {isPreparing && <div className="showcase-region-loader" role="status"><span aria-hidden="true" />{text.starting}</div>}
              {workerFailed && <p className="showcase-region-error" role="alert">{text.workerError} <button type="button" onClick={() => setRetryKey((current) => current + 1)}>{text.retry}</button></p>}
              {preparedResult && !preparedResult.ok && <p className="showcase-region-error" role="alert">{preparedResult.reason === 'unviable-starts' ? text.mapUnviable : text.mapError}</p>}
            </section>

            <section className="map-library battle-setup-library" aria-label={text.chooseMap}>
              {storageFeedback && <p className="map-storage-feedback" role="alert">{storageFeedback}</p>}
              <div className="map-library-scroll">
                <div className="map-library-group"><h3>{text.builtInMaps}</h3><div className="map-choice-list">
                  {mapPresets.map((preset) => {
                    const selection = presetSelection(preset.id)
                    const copy = text.presets[preset.id]
                    return <MapChoice key={selection} name={copy.name} selected={selectedMap === selection} preview={<MapPreview cacheKey={selection} settings={preset.settings} manualGrid={defaultPreviewGrid} />} onSelect={() => onMapChange(selection)} />
                  })}
                </div></div>
                <div className="map-library-separator" aria-hidden="true" />
                <div className="map-library-group"><h3>{text.myMaps}</h3><div className="map-choice-list">
                  {savedMaps.map((map) => {
                    const selection = savedSelection(map.id)
                    return <MapChoice key={selection} name={map.name} selected={selectedMap === selection} preview={<MapPreview cacheKey={selection} settings={map.settings} manualGrid={map.manualGrid} />} onSelect={() => onMapChange(selection)} onDelete={() => setPendingDelete(map)} deleteLabel={text.deleteSavedMap} />
                  })}
                  <button type="button" className="create-map-choice" aria-label={`${text.customMap}. ${text.customMapDescription} ${text.openGenerator}`} onClick={onOpenGenerator}><i aria-hidden="true">+</i><span><strong>{text.customMap}</strong><small>{text.openGenerator}</small></span></button>
                </div></div>
              </div>
              <div className="battle-setup-utility">{utilityControls}</div>
            </section>
          </aside>
        </div>
      </section>
      {pendingDelete && <ConfirmDialog title={`${confirmationText.deleteMapTitle} «${pendingDelete.name}»`} description={confirmationText.deleteMapDescription} cancelLabel={confirmationText.cancel} confirmLabel={confirmationText.deleteMapAction} onCancel={() => setPendingDelete(null)} onConfirm={() => { onDeleteSavedMap(pendingDelete.id); setPendingDelete(null) }} />}
    </main>
  )
}
