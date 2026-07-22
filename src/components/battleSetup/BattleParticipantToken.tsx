import type { CSSProperties, DragEvent } from 'react'
import { aiAvatarPaths } from '../../config/ai'
import type { LocaleDictionary } from '../../config/localization'
import { REGION_COLORS } from '../../game/scenario'
import type { BattleSeatPreview } from './battleMapPreviewModel'

interface BattleParticipantTokenProps {
  seat: BattleSeatPreview
  regionColor: string
  allies: string[]
  selected: boolean
  dragging: boolean
  allianceTarget: boolean
  text: LocaleDictionary['opponents']
  onSelect: () => void
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd: () => void
  onAllianceDragEnter: (event: DragEvent<HTMLButtonElement>) => void
  onAllianceDragLeave: (event: DragEvent<HTMLButtonElement>) => void
  onAllianceDrop: (event: DragEvent<HTMLButtonElement>) => void
}

export function BattleParticipantToken({
  seat,
  regionColor,
  allies,
  selected,
  dragging,
  allianceTarget,
  text,
  onSelect,
  onDragStart,
  onDragEnd,
  onAllianceDragEnter,
  onAllianceDragLeave,
  onAllianceDrop,
}: BattleParticipantTokenProps) {
  const teamColor = REGION_COLORS[(seat.teamId - 1) % REGION_COLORS.length]
  const tokenStyle = { '--region-color': regionColor, '--team-color': teamColor } as CSSProperties
  const tooltipId = `battle-participant-${seat.kind}-${seat.regionIndex}-${seat.profileId ?? 'player'}`
  return (
    <div className="battle-participant-token-shell" style={tokenStyle}>
      <button
        type="button"
        draggable
        className={`battle-participant-token${seat.kind === 'player' ? ' player' : ''}${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${allianceTarget ? ' alliance-target' : ''}`}
        aria-label={`${seat.name}. ${text.region} ${seat.regionIndex + 1}. ${text.alliance} ${seat.teamId}${allies.length > 0 ? `. ${text.allies}: ${allies.join(', ')}` : ''}`}
        aria-pressed={selected}
        aria-describedby={tooltipId}
        onClick={(event) => {
          event.stopPropagation()
          onSelect()
        }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragEnter={onAllianceDragEnter}
        onDragOver={(event) => {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDragLeave={onAllianceDragLeave}
        onDrop={onAllianceDrop}
      >
        <span className="battle-participant-portrait">
          {seat.profileId ? <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[seat.profileId]}`} alt="" /> : <b>{text.playerMark}</b>}
        </span>
        <i className="battle-participant-alliance" aria-label={`${text.alliance} ${seat.teamId}`}>
          {seat.teamId}
        </i>
      </button>
      <aside className="battle-participant-tooltip" id={tooltipId} role="tooltip">
        <strong>{seat.name}</strong>
        <span>
          {text.region} {seat.regionIndex + 1}
        </span>
        <small>{allies.length > 0 ? `${text.allies}: ${allies.join(', ')}` : `${text.alliance} ${seat.teamId}`}</small>
      </aside>
    </div>
  )
}
