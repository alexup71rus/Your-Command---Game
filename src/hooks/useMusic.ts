import { useCallback, useEffect, useRef, useState } from 'react'
import { gameConfig } from '../config/game'

export type MusicScene = keyof typeof gameConfig.audio.musicTracks

const musicScenes = Object.keys(gameConfig.audio.musicTracks) as MusicScene[]
const clampVolume = (volume: number) => Math.max(0, Math.min(100, Math.round(volume)))

function readInitialMusicVolume() {
  try {
    const stored = window.localStorage.getItem(gameConfig.audio.musicVolumeStorageKey)
    if (stored !== null) {
      const volume = Number(stored)
      if (Number.isFinite(volume)) return clampVolume(volume)
    }
  } catch {
    // Use the configured default when storage is unavailable.
  }
  return gameConfig.audio.musicDefaultVolume
}

export function useMusic(scene: MusicScene, enabled: boolean) {
  const [volume, setVolumeState] = useState(readInitialMusicVolume)
  const tracksRef = useRef<Record<MusicScene, HTMLAudioElement> | null>(null)
  const sceneRef = useRef(scene)
  const enabledRef = useRef(enabled)
  const volumeRef = useRef(volume)
  const unlockedRef = useRef(false)
  const activeSceneRef = useRef<MusicScene | null>(null)
  const fadeFrameRef = useRef<number | null>(null)
  const transitionIdRef = useRef(0)

  const stopAll = useCallback(() => {
    transitionIdRef.current += 1
    if (fadeFrameRef.current !== null) window.cancelAnimationFrame(fadeFrameRef.current)
    fadeFrameRef.current = null
    activeSceneRef.current = null
    musicScenes.forEach((candidate) => {
      const track = tracksRef.current?.[candidate]
      if (!track) return
      track.volume = 0
      track.pause()
    })
  }, [])

  const transitionTo = useCallback((nextScene: MusicScene) => {
    const tracks = tracksRef.current
    if (!tracks || !unlockedRef.current || !enabledRef.current || volumeRef.current === 0) {
      stopAll()
      return
    }
    const target = tracks[nextScene]
    const transitionId = ++transitionIdRef.current
    if (fadeFrameRef.current !== null) window.cancelAnimationFrame(fadeFrameRef.current)
    const targetVolume = volumeRef.current / 100
    if (activeSceneRef.current === nextScene && !target.paused) {
      target.volume = targetVolume
      musicScenes.forEach((candidate) => {
        if (candidate === nextScene) return
        tracks[candidate].volume = 0
        tracks[candidate].pause()
      })
      fadeFrameRef.current = null
      return
    }
    const initialVolumes = Object.fromEntries(musicScenes.map((candidate) => [candidate, tracks[candidate].volume])) as Record<MusicScene, number>
    const startedAt = performance.now()
    activeSceneRef.current = nextScene
    void target.play().catch(() => undefined)

    const step = (now: number) => {
      if (transitionId !== transitionIdRef.current) return
      const progress = Math.min(1, (now - startedAt) / gameConfig.audio.musicCrossfadeMs)
      const eased = progress * progress * (3 - 2 * progress)
      musicScenes.forEach((candidate) => {
        const desired = candidate === nextScene ? targetVolume : 0
        tracks[candidate].volume = Math.max(0, Math.min(1, initialVolumes[candidate] + (desired - initialVolumes[candidate]) * eased))
      })
      if (progress < 1) {
        fadeFrameRef.current = window.requestAnimationFrame(step)
        return
      }
      fadeFrameRef.current = null
      musicScenes.forEach((candidate) => { if (candidate !== nextScene) tracks[candidate].pause() })
    }
    fadeFrameRef.current = window.requestAnimationFrame(step)
  }, [stopAll])

  useEffect(() => {
    const tracks = Object.fromEntries(musicScenes.map((candidate) => {
      const track = new Audio(`${import.meta.env.BASE_URL}${gameConfig.audio.musicTracks[candidate]}`)
      track.loop = true
      track.preload = candidate === 'menu' ? 'auto' : 'metadata'
      track.volume = 0
      return [candidate, track]
    })) as Record<MusicScene, HTMLAudioElement>
    tracksRef.current = tracks

    const unlock = () => {
      unlockedRef.current = true
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
      transitionTo(sceneRef.current)
    }
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('keydown', unlock, true)

    return () => {
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
      stopAll()
      tracksRef.current = null
    }
  }, [stopAll, transitionTo])

  useEffect(() => {
    sceneRef.current = scene
    enabledRef.current = enabled
    volumeRef.current = volume
    if (!enabled) stopAll()
    else if (unlockedRef.current) transitionTo(scene)
  }, [enabled, scene, stopAll, transitionTo, volume])

  const setVolume = useCallback((nextVolume: number) => {
    const normalized = clampVolume(nextVolume)
    volumeRef.current = normalized
    setVolumeState(normalized)
    try {
      window.localStorage.setItem(gameConfig.audio.musicVolumeStorageKey, String(normalized))
    } catch {
      // Keep the volume for this session if storage is unavailable.
    }
  }, [])

  return { volume, setVolume }
}
