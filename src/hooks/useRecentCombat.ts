import { useCallback, useEffect, useRef, useState } from 'react'
import { gameConfig } from '../config/game'

export function useRecentCombat() {
  const [recentCombat, setRecentCombat] = useState(false)
  const timer = useRef<number | null>(null)

  const clearRecentCombat = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    setRecentCombat(false)
  }, [])

  const markRecentCombat = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    setRecentCombat(true)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setRecentCombat(false)
    }, gameConfig.audio.combatMusicHoldMs)
  }, [])

  useEffect(() => clearRecentCombat, [clearRecentCombat])

  return { recentCombat, markRecentCombat, clearRecentCombat }
}
