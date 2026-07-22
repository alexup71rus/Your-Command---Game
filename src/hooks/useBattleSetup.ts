import { useCallback, useMemo, useState } from 'react'
import { gameConfig, maximumParticipantsForMapSize } from '../config/game'
import { mapSizeForSelection, profilesForSetup, teamsForSetup } from '../game/battleSetup'
import {
  createSavedMap,
  defaultMapSelection,
  loadSavedMapsResult,
  persistSavedMaps,
  savedSelection,
  type MapSelection,
  type SavedMapDraft,
} from '../game/savedMaps'
import type { AiProfileId } from '../game/scenario'

interface BattleSetupMessages {
  mapSaveFailed: string
  mapDeleteFailed: string
}

export function useBattleSetup(messages?: BattleSetupMessages) {
  const [selectedMap, setSelectedMap] = useState<MapSelection>(defaultMapSelection)
  const [initialSavedMaps] = useState(loadSavedMapsResult)
  const [savedMaps, setSavedMaps] = useState(initialSavedMaps.maps)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [hasHumanPlayer, setHasHumanPlayer] = useState(true)
  const [opponentProfileIds, setOpponentProfileIds] = useState<AiProfileId[]>(['radomir'])
  const [participantTeamIds, setParticipantTeamIds] = useState<number[]>([1, 2])
  const [humanRegionIndex, setHumanRegionIndex] = useState(0)

  const participantCount = opponentProfileIds.length + Number(hasHumanPlayer)
  const normalizedHumanRegionIndex = Math.min(humanRegionIndex, Math.max(0, participantCount - 1))
  const participantMaximum = gameConfig.match.maxParticipants
  const selectedMapSize = useMemo(() => mapSizeForSelection(selectedMap, savedMaps), [savedMaps, selectedMap])
  const selectedMapParticipantLimit = maximumParticipantsForMapSize(selectedMapSize)

  const constrainParticipants = useCallback(
    (limit: number) => {
      const nextProfiles = profilesForSetup(hasHumanPlayer, opponentProfileIds, limit)
      setOpponentProfileIds(nextProfiles)
      setParticipantTeamIds((current) => teamsForSetup(current, nextProfiles.length + Number(hasHumanPlayer)))
    },
    [hasHumanPlayer, opponentProfileIds],
  )

  const selectMap = useCallback(
    (selection: MapSelection) => {
      setSelectedMap(selection)
      constrainParticipants(maximumParticipantsForMapSize(mapSizeForSelection(selection, savedMaps)))
    },
    [constrainParticipants, savedMaps],
  )

  const saveGeneratedMap = useCallback(
    (draft: SavedMapDraft) => {
      const savedMap = createSavedMap(draft.name, draft.settings, draft.manualGrid)
      const next = [...savedMaps, savedMap]
      const persisted = persistSavedMaps(next)
      if (!persisted.ok) {
        setFeedback(messages?.mapSaveFailed ?? null)
        return false
      }
      setSavedMaps(next)
      setFeedback(null)
      setSelectedMap(savedSelection(savedMap.id))
      constrainParticipants(maximumParticipantsForMapSize(draft.settings.mapSize))
      return true
    },
    [constrainParticipants, messages?.mapSaveFailed, savedMaps],
  )

  const deleteSavedMap = useCallback(
    (id: string) => {
      const next = savedMaps.filter((map) => map.id !== id)
      const persisted = persistSavedMaps(next)
      if (!persisted.ok) {
        setFeedback(messages?.mapDeleteFailed ?? null)
        return
      }
      setSavedMaps(next)
      setFeedback(null)
      setSelectedMap((current) => (current === savedSelection(id) ? defaultMapSelection : current))
    },
    [messages?.mapDeleteFailed, savedMaps],
  )

  const changeParticipantCount = useCallback(
    (count: number) => {
      const normalized = Math.max(gameConfig.match.minParticipants, Math.min(participantMaximum, Math.round(count)))
      const nextProfiles = profilesForSetup(hasHumanPlayer, opponentProfileIds, participantMaximum, normalized)
      setOpponentProfileIds(nextProfiles)
      setParticipantTeamIds((current) => teamsForSetup(current, nextProfiles.length + Number(hasHumanPlayer)))
    },
    [hasHumanPlayer, opponentProfileIds, participantMaximum],
  )

  const changeRoster = useCallback(
    (nextHasHumanPlayer: boolean, profiles: AiProfileId[], teamIds: number[]) => {
      const allowed = profilesForSetup(nextHasHumanPlayer, profiles, selectedMapParticipantLimit)
      setHasHumanPlayer(nextHasHumanPlayer)
      setOpponentProfileIds(allowed)
      setParticipantTeamIds(teamsForSetup(teamIds, allowed.length + Number(nextHasHumanPlayer)))
    },
    [selectedMapParticipantLimit],
  )

  const changeArrangement = useCallback((nextHumanRegionIndex: number, profiles: AiProfileId[], teamIds: number[]) => {
    setHumanRegionIndex(nextHumanRegionIndex)
    setOpponentProfileIds(profiles)
    setParticipantTeamIds(teamIds)
  }, [])

  const restoreHumanRoster = useCallback((profiles: AiProfileId[], teamIds: number[]) => {
    setHasHumanPlayer(true)
    setHumanRegionIndex(0)
    setOpponentProfileIds(profiles)
    setParticipantTeamIds(teamIds)
  }, [])

  return {
    selectedMap,
    savedMaps,
    feedback,
    savedMapsReadFailed: !initialSavedMaps.ok,
    hasHumanPlayer,
    opponentProfileIds,
    participantTeamIds,
    participantCount,
    normalizedHumanRegionIndex,
    participantMaximum,
    selectedMapParticipantLimit,
    constrainParticipants,
    selectMap,
    saveGeneratedMap,
    deleteSavedMap,
    changeParticipantCount,
    changeRoster,
    changeArrangement,
    restoreHumanRoster,
  }
}
