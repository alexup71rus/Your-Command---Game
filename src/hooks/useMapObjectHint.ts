import { useCallback, useEffect, useRef, useState } from 'react'
import type { MapObjectHoverRequest } from '../components/GridCanvas'

function describesSameObject(first: MapObjectHoverRequest, second: MapObjectHoverRequest) {
  return (
    first.ownerId === second.ownerId &&
    first.object.type === second.object.type &&
    (first.object.type !== 'building' || second.object.type !== 'building' || first.object.kind === second.object.kind) &&
    first.column === second.column &&
    first.row === second.row
  )
}

export function useMapObjectHint(active: boolean) {
  const [hoveredMapObject, setHoveredMapObject] = useState<MapObjectHoverRequest | null>(null)
  const showTimer = useRef<number | null>(null)
  const hideTimer = useRef<number | null>(null)
  const pendingObject = useRef<MapObjectHoverRequest | null>(null)
  const visibleObject = useRef<MapObjectHoverRequest | null>(null)

  const clearTimers = useCallback(() => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current)
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    showTimer.current = null
    hideTimer.current = null
  }, [])

  const showObjectOwner = useCallback(
    (request: MapObjectHoverRequest | null) => {
      pendingObject.current = request
      clearTimers()
      if (!request) {
        hideTimer.current = window.setTimeout(() => {
          visibleObject.current = null
          setHoveredMapObject(null)
          hideTimer.current = null
        }, 80)
        return
      }
      if (visibleObject.current && !describesSameObject(visibleObject.current, request)) {
        visibleObject.current = null
        setHoveredMapObject(null)
      }
      showTimer.current = window.setTimeout(() => {
        showTimer.current = null
        if (pendingObject.current !== request) return
        visibleObject.current = request
        setHoveredMapObject(request)
      }, 180)
    },
    [clearTimers],
  )

  useEffect(() => {
    if (active) return clearTimers
    pendingObject.current = null
    visibleObject.current = null
    clearTimers()
    const resetTimer = window.setTimeout(() => setHoveredMapObject(null), 0)
    return () => {
      window.clearTimeout(resetTimer)
      clearTimers()
    }
  }, [active, clearTimers])

  return { hoveredMapObject, showObjectOwner }
}
