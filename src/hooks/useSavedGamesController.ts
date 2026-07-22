import { useCallback, useEffect, useState } from 'react'
import type { LocaleDictionary } from '../config/localization'
import type { MatchState } from '../game/match'
import { deleteSavedGame, listSavedGames, loadSavedGame, saveGame, type SavedGameSummary } from '../game/savedGames'
import type { SoundEffect } from './useSoundEffects'

interface SavedGamesControllerOptions {
  match: MatchState | null
  canSave: boolean
  messages?: LocaleDictionary['savedGames']
  onLoadMatch: (match: MatchState) => void
  playSound: (effect: SoundEffect) => void
}

export function useSavedGamesController({ match, canSave, messages, onLoadMatch, playSound }: SavedGamesControllerOptions) {
  const [saves, setSaves] = useState<SavedGameSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [readFailed, setReadFailed] = useState(false)

  useEffect(() => {
    listSavedGames()
      .then((loadedSaves) => {
        setSaves(loadedSaves)
        setReadFailed(false)
      })
      .catch(() => {
        setSaves([])
        setReadFailed(true)
      })
  }, [])

  const saveCurrentGame = useCallback(async () => {
    if (!match || !canSave || busy) return
    setBusy(true)
    setFeedback(null)
    try {
      const saved = await saveGame(match)
      setSaves((current) => [saved, ...current])
      setFeedback(messages?.saved ?? null)
      playSound('action')
    } catch {
      setFeedback(messages?.saveFailed ?? null)
      playSound('dismiss')
    } finally {
      setBusy(false)
    }
  }, [busy, canSave, match, messages, playSound])

  const loadGame = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      setFeedback(null)
      try {
        const saved = await loadSavedGame(id)
        onLoadMatch(saved.match)
        playSound('action')
      } catch {
        setFeedback(messages?.loadFailed ?? null)
        playSound('dismiss')
      } finally {
        setBusy(false)
      }
    },
    [busy, messages, onLoadMatch, playSound],
  )

  const removeSavedGame = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      setFeedback(null)
      try {
        await deleteSavedGame(id)
        setSaves((current) => current.filter((save) => save.id !== id))
      } catch {
        setFeedback(messages?.deleteFailed ?? messages?.loadFailed ?? null)
        playSound('dismiss')
      } finally {
        setBusy(false)
      }
    },
    [busy, messages, playSound],
  )

  return {
    saves,
    busy,
    feedback,
    readFailed,
    setFeedback,
    saveCurrentGame,
    loadGame,
    removeSavedGame,
  }
}
