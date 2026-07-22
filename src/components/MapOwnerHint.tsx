import { aiAvatarPaths } from '../config/ai'
import type { MatchParticipant } from '../game/scenario'

interface MapOwnerHintProps {
  participant: MatchParticipant
  ownerName: string
  objectName: string
  playerMark: string
}

export function MapOwnerHint({ participant, ownerName, objectName, playerMark }: MapOwnerHintProps) {
  return (
    <div className="map-hint map-owner-hint" role="status" aria-live="polite">
      <span
        className="map-owner-avatar"
        style={{ borderColor: participant.color, boxShadow: `0 0 0 1px ${participant.color}66, 0 0 14px ${participant.color}88` }}
        aria-hidden="true"
      >
        {participant.profileId ? (
          <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[participant.profileId]}`} alt="" />
        ) : (
          <b>{playerMark}</b>
        )}
      </span>
      <span>
        <small>{objectName}</small>
        <strong>{ownerName}</strong>
      </span>
    </div>
  )
}
