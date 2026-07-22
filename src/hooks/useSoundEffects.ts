import { useCallback, useEffect, useRef, useState } from 'react'
import { gameConfig } from '../config/game'

export type SoundEffect = 'map' | 'tab' | 'context' | 'action' | 'attack' | 'dismiss' | 'enable' | 'hover' | 'primary-hover'

interface ToneOptions {
  frequency: number
  endFrequency?: number
  duration: number
  level: number
  delay?: number
  type?: OscillatorType
  attack?: number
  cutoff?: number
}

interface NoiseOptions {
  duration: number
  level: number
  delay?: number
  frequency: number
  filter?: BiquadFilterType
  resonance?: number
}

const MIN_GAIN = 0.0001
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

function readInitialEnabled() {
  try {
    const current = window.localStorage.getItem(gameConfig.audio.enabledStorageKey)
    if (current !== null) return current !== 'false'
    const legacy = window.localStorage.getItem(gameConfig.audio.legacyEnabledStorageKey)
    return legacy !== null
      ? legacy !== 'false'
      : readStoredNumber(gameConfig.audio.volumeStorageKey, gameConfig.audio.defaultVolume, gameConfig.audio.legacyVolumeStorageKey) > 0
  } catch {
    return true
  }
}

function readInitialVolume() {
  const storedVolume = readStoredNumber(gameConfig.audio.volumeStorageKey, gameConfig.audio.defaultVolume, gameConfig.audio.legacyVolumeStorageKey)
  try {
    const hasIndependentMute = window.localStorage.getItem(gameConfig.audio.enabledStorageKey) !== null
    if (!hasIndependentMute && storedVolume === 0) {
      return Math.max(1, readStoredNumber(gameConfig.audio.lastVolumeStorageKey, gameConfig.audio.defaultVolume, gameConfig.audio.legacyLastVolumeStorageKey))
    }
  } catch {
    // Keep the stored volume when storage cannot be inspected.
  }
  return storedVolume
}

export function useSoundEffects() {
  const [enabled, setEnabledState] = useState(readInitialEnabled)
  const [volume, setVolumeState] = useState(readInitialVolume)
  const enabledRef = useRef(enabled)
  const volumeRef = useRef(volume)
  const audioContextRef = useRef<AudioContext | null>(null)
  const noiseSeedRef = useRef(0x6d2b79f5)

  useEffect(() => {
    try { window.localStorage.setItem(gameConfig.audio.enabledStorageKey, String(enabled)) } catch { /* Keep the state for this session. */ }
  }, [enabled])

  const getAudioContext = useCallback(() => {
    const AudioContextClass = window.AudioContext
    if (!AudioContextClass) return null
    const audioContext = audioContextRef.current ?? new AudioContextClass()
    audioContextRef.current = audioContext
    if (audioContext.state === 'suspended') void audioContext.resume()
    return audioContext
  }, [])

  const scaledLevel = useCallback((level: number, maximum: number) => (
    Math.min(maximum, level * gameConfig.audio.gainMultiplier * volumeRef.current / 100)
  ), [])

  const playTone = useCallback(({ frequency, endFrequency = frequency * .78, duration, level, delay = 0, type = 'sine', attack = .004, cutoff }: ToneOptions) => {
    const audioContext = getAudioContext()
    if (!audioContext) return
    const audibleLevel = scaledLevel(level, .2)
    if (audibleLevel <= MIN_GAIN) return
    const start = audioContext.currentTime + delay
    const end = start + duration
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), start)
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), end)
    gain.gain.setValueAtTime(MIN_GAIN, start)
    gain.gain.exponentialRampToValueAtTime(audibleLevel, start + Math.min(attack, duration * .35))
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, end)
    if (cutoff) {
      const filter = audioContext.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(cutoff, start)
      oscillator.connect(filter)
      filter.connect(gain)
    } else oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start(start)
    oscillator.stop(end + .02)
  }, [getAudioContext, scaledLevel])

  const playNoise = useCallback(({ duration, level, delay = 0, frequency, filter = 'lowpass', resonance = .8 }: NoiseOptions) => {
    const audioContext = getAudioContext()
    if (!audioContext) return
    const audibleLevel = scaledLevel(level, .16)
    if (audibleLevel <= MIN_GAIN) return
    const start = audioContext.currentTime + delay
    const buffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * duration), audioContext.sampleRate)
    const samples = buffer.getChannelData(0)
    let seed = noiseSeedRef.current = (noiseSeedRef.current + 0x9e3779b9) >>> 0
    for (let index = 0; index < samples.length; index += 1) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      samples[index] = (seed >>> 0) / 2_147_483_648 - 1
    }
    const source = audioContext.createBufferSource()
    const toneFilter = audioContext.createBiquadFilter()
    const gain = audioContext.createGain()
    source.buffer = buffer
    toneFilter.type = filter
    toneFilter.frequency.setValueAtTime(frequency, start)
    toneFilter.Q.setValueAtTime(resonance, start)
    gain.gain.setValueAtTime(audibleLevel, start)
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, start + duration)
    source.connect(toneFilter)
    toneFilter.connect(gain)
    gain.connect(audioContext.destination)
    source.start(start)
    source.stop(start + duration + .01)
  }, [getAudioContext, scaledLevel])

  const playChime = useCallback((frequency: number, duration: number, level: number, delay = 0) => {
    playTone({ frequency, endFrequency: frequency * .99, duration, level, delay, type: 'sine', attack: .002 })
    playTone({ frequency: frequency * 2.02, endFrequency: frequency * 2, duration: duration * .52, level: level * .2, delay: delay + .002, type: 'sine', attack: .001 })
  }, [playTone])

  const play = useCallback((effect: SoundEffect, force = false) => {
    if ((!enabledRef.current && !force) || volumeRef.current === 0) return
    switch (effect) {
      case 'hover':
        playChime(680, .09, .005)
        break
      case 'primary-hover':
        playTone({ frequency: 104, endFrequency: 66, duration: .11, level: .019, type: 'sine', cutoff: 300 })
        playChime(430, .12, .007, .012)
        break
      case 'map':
        playTone({ frequency: 132, endFrequency: 78, duration: .08, level: .022, type: 'triangle', cutoff: 390 })
        break
      case 'tab':
        playChime(560, .13, .009)
        break
      case 'context':
        playChime(420, .15, .01)
        break
      case 'action':
        playTone({ frequency: 122, endFrequency: 64, duration: .11, level: .027, type: 'triangle', cutoff: 400 })
        break
      case 'attack':
        playTone({ frequency: 76, endFrequency: 34, duration: .24, level: .058, type: 'sine', attack: .002, cutoff: 240 })
        playNoise({ duration: .14, level: .026, frequency: 480, filter: 'lowpass' })
        break
      case 'dismiss':
        playTone({ frequency: 164, endFrequency: 76, duration: .13, level: .022, type: 'triangle', cutoff: 360 })
        break
      case 'enable':
        playTone({ frequency: 430, endFrequency: 426, duration: .18, level: .011, type: 'sine', attack: .002 })
        playTone({ frequency: 560, endFrequency: 554, duration: .22, level: .01, delay: .065, type: 'sine', attack: .002 })
        break
    }
  }, [playChime, playNoise, playTone])

  const setVolume = useCallback((nextVolume: number) => {
    const normalized = clampVolume(nextVolume)
    volumeRef.current = normalized
    setVolumeState(normalized)
    try {
      window.localStorage.setItem(gameConfig.audio.volumeStorageKey, String(normalized))
      if (normalized > 0) window.localStorage.setItem(gameConfig.audio.lastVolumeStorageKey, String(normalized))
    } catch {
      // Keep the volume for this session if storage is unavailable.
    }
  }, [])

  const toggle = useCallback(() => {
    const nextEnabled = !enabledRef.current
    enabledRef.current = nextEnabled
    setEnabledState(nextEnabled)
    try { window.localStorage.setItem(gameConfig.audio.enabledStorageKey, String(nextEnabled)) } catch { /* Keep the state for this session. */ }
    if (nextEnabled) window.setTimeout(() => play('enable', true), 0)
  }, [play])

  return { enabled, volume, play, setVolume, toggle }
}
