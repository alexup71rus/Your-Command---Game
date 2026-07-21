import { useCallback, useState } from 'react'
import { gameConfig } from '../config/game'

function readInitialAutoCamera() {
  try {
    const stored = window.localStorage.getItem(gameConfig.display.autoCameraStorageKey)
    if (stored === 'true') return true
    if (stored === 'false') return false
  } catch {
    // Use the configured default when storage is unavailable.
  }
  return gameConfig.display.autoCameraByDefault
}

export function useAutoCamera() {
  const [enabled, setEnabledState] = useState(readInitialAutoCamera)

  const setEnabled = useCallback((nextEnabled: boolean) => {
    setEnabledState(nextEnabled)
    try {
      window.localStorage.setItem(gameConfig.display.autoCameraStorageKey, String(nextEnabled))
    } catch {
      // Keep the preference for this session if storage is unavailable.
    }
  }, [])

  return { enabled, setEnabled }
}
