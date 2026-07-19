import { useCallback, useState } from 'react'
import { gameConfig } from '../config/game'

function readInitialGridVisibility() {
  try {
    const stored = window.localStorage.getItem(gameConfig.display.gridStorageKey)
    if (stored === 'true') return true
    if (stored === 'false') return false
  } catch {
    // Use the configured default when storage is unavailable.
  }
  return gameConfig.display.showGridByDefault
}

export function useMapGrid() {
  const [visible, setVisibleState] = useState(readInitialGridVisibility)

  const setVisible = useCallback((nextVisible: boolean) => {
    setVisibleState(nextVisible)
    try {
      window.localStorage.setItem(gameConfig.display.gridStorageKey, String(nextVisible))
    } catch {
      // Keep the preference for this session if storage is unavailable.
    }
  }, [])

  return { visible, setVisible }
}
