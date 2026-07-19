import { useCallback, useEffect, useRef, useState } from 'react'
import { gameConfig } from '../config/game'

export type NavigationSkill = 'move' | 'zoom'

export function navigationHintDelay(learned: Record<NavigationSkill, boolean>) {
  return learned.move && learned.zoom
    ? gameConfig.navigationHint.masteredDelayMs
    : gameConfig.navigationHint.partialDelayMs
}

function wasHintSeen() {
  let current: string | null
  let saved: string | null
  try {
    current = window.localStorage.getItem(gameConfig.navigationHint.storageKey)
    saved = current ?? window.localStorage.getItem(gameConfig.navigationHint.legacyStorageKey)
  } catch {
    return false
  }
  if (current === null && saved === 'true') {
    try { window.localStorage.setItem(gameConfig.navigationHint.storageKey, 'true') } catch { /* Keep the migrated state for this session. */ }
  }
  return saved === 'true'
}

export function useNavigationHint() {
  const [visible, setVisible] = useState(() => !wasHintSeen())
  const visibleRef = useRef(visible)
  const learned = useRef({ move: false, zoom: false })
  const timer = useRef<number | null>(null)

  const dismiss = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    setVisible(false)
    visibleRef.current = false
    try {
      window.localStorage.setItem(gameConfig.navigationHint.storageKey, 'true')
    } catch {
      // Dismiss only for this session if storage is unavailable.
    }
  }, [])

  const markLearned = useCallback((skill: NavigationSkill) => {
    if (!visibleRef.current || learned.current[skill]) return
    learned.current[skill] = true
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(dismiss, navigationHintDelay(learned.current))
  }, [dismiss])

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])

  return { visible, markLearned }
}
