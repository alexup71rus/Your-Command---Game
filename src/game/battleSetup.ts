import { gameConfig } from '../config/game'
import { aiProfileIds } from './ai/model'
import { mapPresets } from './presets'
import type { MapSelection, SavedMapDefinition } from './savedMaps'
import type { AiProfileId } from './scenario'

export function profilesForSetup(
  hasHumanPlayer: boolean,
  profiles: AiProfileId[],
  participantLimit: number,
  requestedParticipants?: number,
) {
  const maximum = participantLimit - Number(hasHumanPlayer)
  const minimum = hasHumanPlayer ? 0 : 1
  const requested = requestedParticipants === undefined ? profiles.length : requestedParticipants - Number(hasHumanPlayer)
  const count = Math.max(minimum, Math.min(maximum, requested))
  const next = profiles.slice(0, count)
  while (next.length < count) next.push(aiProfileIds[next.length % aiProfileIds.length])
  return next
}

export function teamsForSetup(teams: number[], participantCount: number) {
  const next = teams.slice(0, participantCount)
  while (next.length < participantCount) next.push(next.length + 1)
  return next
}

export function mapSizeForSelection(selection: MapSelection, savedMaps: SavedMapDefinition[]) {
  const preset = mapPresets.find((candidate) => selection === `preset:${candidate.id}`)
  if (preset) return preset.settings.mapSize
  const savedId = selection.startsWith('saved:') ? selection.slice('saved:'.length) : ''
  return savedMaps.find((candidate) => candidate.id === savedId)?.settings.mapSize ?? gameConfig.generator.defaultMapSize
}
