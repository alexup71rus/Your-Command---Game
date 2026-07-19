import { useCallback, useRef, useState } from 'react'
import { gameConfig } from '../config/game'

export type SoundEffect = 'map' | 'tab' | 'context' | 'action' | 'attack' | 'dismiss' | 'enable'

const clampVolume = (volume: number) => Math.max(0, Math.min(100, Math.round(volume)))

function readStoredNumber(key: string, fallback: number, legacyKey?: string) {
  let stored: string | null
  let raw: string | null
  try {
    stored = window.localStorage.getItem(key)
    raw = stored ?? (legacyKey ? window.localStorage.getItem(legacyKey) : null)
  } catch {
    return fallback
  }
  if (raw === null) return fallback
  const saved = Number(raw)
  if (!Number.isFinite(saved)) return fallback
  const normalized = clampVolume(saved)
  if (stored === null) {
    try { window.localStorage.setItem(key, String(normalized)) } catch { /* Use the migrated value for this session. */ }
  }
  return normalized
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
  return readStoredNumber(gameConfig.audio.volumeStorageKey, gameConfig.audio.defaultVolume, gameConfig.audio.legacyVolumeStorageKey)
}

export function useSoundEffects() {
  const [volume, setVolumeState] = useState(readInitialVolume)
  const volumeRef = useRef(volume)
  const lastAudibleVolume = useRef(
    readStoredNumber(gameConfig.audio.lastVolumeStorageKey, gameConfig.audio.defaultVolume, gameConfig.audio.legacyLastVolumeStorageKey),
  )
  const audioContextRef = useRef<AudioContext | null>(null)

  const playTone = useCallback((frequency: number, duration: number, level: number, delay = 0, type: OscillatorType = 'sine', endRatio = 0.82) => {
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
    oscillator.frequency.exponentialRampToValueAtTime(frequency * endRatio, start + duration)
    const audibleLevel = Math.min(0.22, level * gameConfig.audio.gainMultiplier * volumeRef.current / 100)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(audibleLevel, start + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start(start)
    oscillator.stop(start + duration + 0.02)
  }, [])

  const playNoise = useCallback((duration: number, level: number, delay = 0, cutoff = 1_200) => {
    const AudioContextClass = window.AudioContext
    if (!AudioContextClass) return
    const audioContext = audioContextRef.current ?? new AudioContextClass()
    audioContextRef.current = audioContext
    if (audioContext.state === 'suspended') void audioContext.resume()

    const start = audioContext.currentTime + delay
    const buffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * duration), audioContext.sampleRate)
    const samples = buffer.getChannelData(0)
    let seed = 0x6d2b79f5
    for (let index = 0; index < samples.length; index += 1) {
      seed = Math.imul(seed ^ seed >>> 15, 1 | seed)
      seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed)
      samples[index] = ((seed ^ seed >>> 14) >>> 0) / 2_147_483_648 - 1
    }
    const source = audioContext.createBufferSource()
    const filter = audioContext.createBiquadFilter()
    const gain = audioContext.createGain()
    source.buffer = buffer
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(cutoff, start)
    const audibleLevel = Math.min(0.18, level * gameConfig.audio.gainMultiplier * volumeRef.current / 100)
    gain.gain.setValueAtTime(audibleLevel, start)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    source.connect(filter)
    filter.connect(gain)
    gain.connect(audioContext.destination)
    source.start(start)
    source.stop(start + duration + 0.01)
  }, [])

  const play = useCallback((effect: SoundEffect, force = false) => {
    if (volumeRef.current === 0 && !force) return
    switch (effect) {
      case 'map': playNoise(0.045, 0.012, 0, 900); playTone(178, 0.07, 0.028, 0, 'triangle', 0.7); break
      case 'tab': playTone(360, 0.08, 0.034, 0, 'sine', 1.04); playTone(540, 0.11, 0.024, 0.018, 'triangle', 0.92); break
      case 'context': playTone(220, 0.12, 0.036, 0, 'triangle', 1.18); playTone(330, 0.15, 0.025, 0.025, 'sine', 1.08); break
      case 'action': playNoise(0.055, 0.012, 0, 1_500); playTone(285, 0.085, 0.036, 0, 'triangle', 0.88); playTone(570, 0.07, 0.016, 0.012, 'sine', 0.9); break
      case 'attack': playNoise(0.18, 0.065, 0, 750); playTone(96, 0.2, 0.065, 0, 'sawtooth', 0.58); playTone(148, 0.1, 0.03, 0.018, 'triangle', 0.72); break
      case 'dismiss': playTone(205, 0.1, 0.03, 0, 'triangle', 0.62); playTone(128, 0.13, 0.018, 0.02, 'sine', 0.75); break
      case 'enable': playTone(294, 0.12, 0.034, 0, 'sine', 1.02); playTone(440, 0.16, 0.028, 0.045, 'sine', 1.01); playTone(588, 0.2, 0.018, 0.09, 'triangle', 0.96); break
    }
  }, [playNoise, playTone])

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
