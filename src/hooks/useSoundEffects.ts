import { useCallback, useRef, useState } from 'react'
import { gameConfig } from '../config/game'

export type SoundEffect = 'map' | 'tab' | 'context' | 'action' | 'attack' | 'dismiss' | 'enable'

const clampVolume = (volume: number) => Math.max(0, Math.min(100, Math.round(volume)))

function readStoredNumber(key: string, fallback: number) {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    const saved = Number(raw)
    return Number.isFinite(saved) ? clampVolume(saved) : fallback
  } catch {
    return fallback
  }
}

function readInitialVolume() {
  try {
    if (window.localStorage.getItem(gameConfig.audio.volumeStorageKey) === null) {
      const legacyEnabled = window.localStorage.getItem(gameConfig.audio.legacyEnabledStorageKey)
      if (legacyEnabled === 'false') return 0
    }
  } catch {
    // Fall through to the configured value.
  }
  return readStoredNumber(gameConfig.audio.volumeStorageKey, gameConfig.audio.defaultVolume)
}

export function useSoundEffects() {
  const [volume, setVolumeState] = useState(readInitialVolume)
  const volumeRef = useRef(volume)
  const lastAudibleVolume = useRef(
    readStoredNumber(gameConfig.audio.lastVolumeStorageKey, gameConfig.audio.defaultVolume),
  )
  const audioContextRef = useRef<AudioContext | null>(null)

  const playTone = useCallback((frequency: number, duration: number, level: number, delay = 0, type: OscillatorType = 'triangle') => {
    const AudioContextClass = window.AudioContext
    if (!AudioContextClass) return

    const audioContext = audioContextRef.current ?? new AudioContextClass()
    audioContextRef.current = audioContext
    if (audioContext.state === 'suspended') void audioContext.resume()

    const start = audioContext.currentTime + delay
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, start)
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.82, start + duration)
    const audibleLevel = Math.min(0.22, level * gameConfig.audio.gainMultiplier * volumeRef.current / 100)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(audibleLevel, start + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start(start)
    oscillator.stop(start + duration + 0.02)
  }, [])

  const play = useCallback((effect: SoundEffect, force = false) => {
    if (volumeRef.current === 0 && !force) return
    switch (effect) {
      case 'map': playTone(190, 0.09, 0.045); playTone(285, 0.07, 0.028, 0.012); break
      case 'tab': playTone(430, 0.1, 0.044); playTone(645, 0.12, 0.03, 0.025); break
      case 'context': playTone(260, 0.13, 0.05); playTone(520, 0.17, 0.034, 0.035); break
      case 'action': playTone(350, 0.09, 0.045); break
      case 'attack': playTone(118, 0.16, 0.07, 0, 'square'); playTone(72, 0.22, 0.055, 0.025, 'sawtooth'); break
      case 'dismiss': playTone(170, 0.08, 0.035); break
      case 'enable': playTone(330, 0.1, 0.05); playTone(495, 0.14, 0.04, 0.045); break
    }
  }, [playTone])

  const setVolume = useCallback((nextVolume: number) => {
    const normalized = clampVolume(nextVolume)
    volumeRef.current = normalized
    setVolumeState(normalized)
    try {
      window.localStorage.setItem(gameConfig.audio.volumeStorageKey, String(normalized))
      if (normalized > 0) {
        lastAudibleVolume.current = normalized
        window.localStorage.setItem(gameConfig.audio.lastVolumeStorageKey, String(normalized))
      }
    } catch {
      // Keep the volume for this session if storage is unavailable.
    }
  }, [])

  const toggle = useCallback(() => {
    if (volume > 0) {
      setVolume(0)
    } else {
      const restored = Math.max(1, lastAudibleVolume.current)
      setVolume(restored)
      window.setTimeout(() => play('enable', true), 0)
    }
  }, [play, setVolume, volume])

  return { enabled: volume > 0, volume, play, setVolume, toggle }
}
