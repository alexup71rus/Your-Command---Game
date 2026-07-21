import { useState, type CSSProperties } from 'react'
import { aiAvatarPaths } from '../config/ai'
import { aiProfileDisplayName, type LocaleDictionary } from '../config/localization'
import { aiProfileIds } from '../game/ai/model'
import { REGION_COLORS, type AiProfileId } from '../game/scenario'
import { useModalFocus } from '../hooks/useModalFocus'
import { CloseIcon } from './InterfaceIcons'
import { ModalCloseButton } from './ui/ModalCloseButton'

interface OpponentSetupModalProps {
  text: LocaleDictionary['opponents']
  hasHumanPlayer: boolean
  selected: AiProfileId[]
  selectedTeamIds: number[]
  onClose: () => void
  onConfirm: (hasHumanPlayer: boolean, profiles: AiProfileId[], teamIds: number[]) => void
  maxParticipants: number
}

function normalizedProfiles(hasHumanPlayer: boolean, profiles: AiProfileId[], maxParticipants: number) {
  const next = profiles.slice(0, maxParticipants - Number(hasHumanPlayer))
  if (!hasHumanPlayer && next.length === 0) next.push(aiProfileIds[0])
  return next
}

function normalizedTeams(teamIds: number[], participantCount: number) {
  const next = teamIds.slice(0, participantCount)
  while (next.length < participantCount) next.push(next.length + 1)
  return next
}

const seatPositions = {
  1: [{ x: 50, y: 78 }],
  2: [{ x: 50, y: 82 }, { x: 50, y: 18 }],
  3: [{ x: 50, y: 84 }, { x: 22, y: 27 }, { x: 78, y: 27 }],
  4: [{ x: 50, y: 84 }, { x: 18, y: 50 }, { x: 50, y: 16 }, { x: 82, y: 50 }],
} as const

export function OpponentSetupModal({ text, hasHumanPlayer, selected, selectedTeamIds, onClose, onConfirm, maxParticipants }: OpponentSetupModalProps) {
  const modalRef = useModalFocus<HTMLElement>()
  const [draftHasHumanPlayer, setDraftHasHumanPlayer] = useState(hasHumanPlayer)
  const [draft, setDraft] = useState<AiProfileId[]>(() => normalizedProfiles(hasHumanPlayer, selected, maxParticipants))
  const participantTotal = draft.length + Number(draftHasHumanPlayer)
  const [draftTeamIds, setDraftTeamIds] = useState<number[]>(() => normalizedTeams(selectedTeamIds, participantTotal))

  const nextUnusedTeam = (teams: number[]) => (
    Array.from({ length: maxParticipants }, (_, index) => index + 1).find((teamId) => !teams.includes(teamId)) ?? 1
  )

  const toggleHumanPlayer = () => {
    if (draftHasHumanPlayer) {
      if (participantTotal <= 1) return
      setDraftHasHumanPlayer(false)
      setDraftTeamIds((current) => current.slice(1))
      return
    }
    if (participantTotal >= maxParticipants) return
    setDraftHasHumanPlayer(true)
    setDraftTeamIds((current) => [nextUnusedTeam(current), ...current])
  }
  const add = (profileId: AiProfileId) => {
    if (participantTotal >= maxParticipants) return
    setDraft((current) => [...current, profileId])
    setDraftTeamIds((current) => [...current, nextUnusedTeam(current)])
  }
  const remove = (draftIndex: number) => {
    if (participantTotal <= 1) return
    setDraft((current) => current.filter((_, index) => index !== draftIndex))
    const teamIndex = draftIndex + Number(draftHasHumanPlayer)
    setDraftTeamIds((current) => current.filter((_, index) => index !== teamIndex))
  }
  const cycleTeam = (seatIndex: number) => {
    setDraftTeamIds((current) => current.map((teamId, index) => (
      index === seatIndex ? teamId % maxParticipants + 1 : teamId
    )))
  }

  const seats = [
    ...(draftHasHumanPlayer ? [{ kind: 'player' as const, teamId: draftTeamIds[0] ?? 1 }] : []),
    ...draft.map((profileId, draftIndex) => ({
      kind: 'ai' as const,
      profileId,
      draftIndex,
      teamId: draftTeamIds[draftIndex + Number(draftHasHumanPlayer)] ?? draftIndex + 1,
      occurrence: draft.slice(0, draftIndex).filter((candidate) => candidate === profileId).length,
    })),
  ]

  return (
    <div className="settings-backdrop opponent-setup-backdrop" onPointerDown={onClose}>
      <section
        ref={modalRef}
        tabIndex={-1}
        className="settings-modal opponent-setup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="opponent-setup-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header opponent-setup-header">
          <div><span className="settings-kicker">{text.kicker}</span><h2 id="opponent-setup-title">{text.title}</h2><p>{text.description}</p></div>
          <ModalCloseButton label={text.close} onClick={onClose} data-modal-autofocus />
        </header>

        <div className="opponent-setup-content">
          <div className="round-table-layout" aria-label={text.selected}>
            <div className="round-table" aria-hidden="true"><span /><strong>{text.selected}</strong></div>
            {seats.map((seat, index) => {
              const position = seatPositions[seats.length as keyof typeof seatPositions][index]
              const seatStyle = {
                '--seat-x': `${position.x}%`,
                '--seat-y': `${position.y}%`,
                '--seat-color': REGION_COLORS[index],
                '--team-color': REGION_COLORS[(seat.teamId - 1) % REGION_COLORS.length],
              } as CSSProperties
              if (seat.kind === 'player') {
                return <article key="player" className="round-table-seat player-seat" style={seatStyle}><div className="player-seat-mark">{text.playerMark}<i aria-label={`${text.region} ${index + 1}`}>{index + 1}</i></div><span><strong>{text.player}</strong></span><button type="button" className="round-table-team" aria-label={`${text.changeAlliance}: ${text.player}, ${text.alliance} ${seat.teamId}`} title={`${text.alliance} ${seat.teamId}`} onClick={() => cycleTeam(index)}><b>{seat.teamId}</b></button><button type="button" className="round-table-remove" disabled={participantTotal <= 1} aria-label={`${text.removeOpponent}: ${text.player}`} onClick={toggleHumanPlayer}><CloseIcon /></button></article>
              }
              const rulerName = aiProfileDisplayName(text, seat.profileId, seat.occurrence)
              return <article key={`${seat.profileId}-${seat.draftIndex}`} className="round-table-seat opponent-seat" style={seatStyle}><span className="round-table-avatar"><img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[seat.profileId]}`} alt="" /><i aria-label={`${text.region} ${index + 1}`}>{index + 1}</i></span><span><strong>{rulerName}</strong></span><button type="button" className="round-table-team" aria-label={`${text.changeAlliance}: ${rulerName}, ${text.alliance} ${seat.teamId}`} title={`${text.alliance} ${seat.teamId}`} onClick={() => cycleTeam(index)}><b>{seat.teamId}</b></button><button type="button" className="round-table-remove" disabled={participantTotal <= 1} aria-label={`${text.removeOpponent}: ${rulerName}`} onClick={() => remove(seat.draftIndex)}><CloseIcon /></button></article>
            })}
          </div>

          <section className="opponent-roster" aria-labelledby="opponent-roster-title">
            <div className="opponent-roster-heading"><div><h3 id="opponent-roster-title">{text.choose}</h3><p>{text.mapCapacity.replace('{count}', String(maxParticipants))}</p></div><span>{participantTotal} / {maxParticipants}</span></div>
            <div className="opponent-roster-grid">
              <div className="opponent-card-shell player-card-shell">
                <button type="button" className={`opponent-card player-candidate-card${draftHasHumanPlayer ? ' selected' : ''}`} aria-pressed={draftHasHumanPlayer} disabled={!draftHasHumanPlayer && participantTotal >= maxParticipants} onClick={toggleHumanPlayer}>
                  <span className="opponent-portrait player-candidate-portrait"><b>{text.playerMark}</b></span>
                  <span className="opponent-card-copy"><strong>{text.player}</strong><small>{text.playerDescription}</small></span>
                </button>
              </div>
              {aiProfileIds.map((profileId) => {
                const copy = text.profiles[profileId]
                const tooltipId = `opponent-biography-${profileId}`
                return <div className="opponent-card-shell" key={profileId}>
                  <button type="button" className="opponent-card" aria-label={`${text.addOpponent}: ${copy.name}`} aria-describedby={tooltipId} disabled={participantTotal >= maxParticipants} onClick={() => add(profileId)}>
                    <span className="opponent-portrait"><img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[profileId]}`} alt="" /></span>
                    <span className="opponent-card-copy"><strong>{copy.name}</strong><small>{copy.role}</small></span>
                  </button>
                  <aside className="opponent-biography" id={tooltipId} role="tooltip">
                    <span>{text.biography}</span><strong>{copy.name}</strong><small>{copy.role}</small><p>{copy.strategy}</p><em>{copy.toolkit}</em>
                  </aside>
                </div>
              })}
            </div>
          </section>
        </div>

        <footer className="opponent-setup-footer">
          <span>{text.regionBinding}</span>
          <button type="button" className="primary" onClick={() => onConfirm(draftHasHumanPlayer, draft, draftTeamIds)}>{text.confirm}<b aria-hidden="true">→</b></button>
        </footer>
      </section>
    </div>
  )
}
