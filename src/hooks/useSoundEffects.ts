import { useCallback, useRef, useState } from 'react'
import { gameConfig } from '../config/game'

export type SoundEffect = 'map' | 'tab' | 'context' | 'action' | 'dismiss' | 'enable'

function readSoundPreference() {
  try {
    const saved = window.localStorage.getItem(gameConfig.audio.storageKey)
    return saved === null ? gameConfig.audio.defaultEnabled : saved === 'true'
  } catch {
    return gameConfig.audio.defaultEnabled
  }
}

export function useSoundEffects() {
  const [enabled, setEnabled] = useState(readSoundPreference)
  const audioContextRef = useRef<AudioContext | null>(null)

  const playTone = useCallback((frequency: number, duration: number, volume: number, delay = 0) => {
    const AudioContextClass = window.AudioContext
    if (!AudioContextClass) return

    const audioContext = audioContextRef.current ?? new AudioContextClass()
    audioContextRef.current = audioContext
    if (audioContext.state === 'suspended') void audioContext.resume()

    const start = audioContext.currentTime + delay
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(frequency, start)
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.82, start + duration)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start(start)
    oscillator.stop(start + duration + 0.02)
  }, [])

  const play = useCallback((effect: SoundEffect, force = false) => {
    if (!enabled && !force) return

    const variation = 0.97 + Math.random() * 0.06
    switch (effect) {
      case 'map':
        playTone(190 * variation, 0.075, 0.035)
        playTone(285 * variation, 0.055, 0.018, 0.012)
        break
      case 'tab':
        playTone(430 * variation, 0.09, 0.032)
        playTone(645 * variation, 0.11, 0.02, 0.025)
        break
      case 'context':
        playTone(260 * variation, 0.12, 0.036)
        playTone(520 * variation, 0.16, 0.024, 0.035)
        break
      case 'action':
        playTone(350 * variation, 0.08, 0.03)
        break
      case 'dismiss':
        playTone(170 * variation, 0.07, 0.022)
        break
      case 'enable':
        playTone(330, 0.1, 0.03)
        playTone(495, 0.13, 0.025, 0.045)
        break
    }
  }, [enabled, playTone])

  const toggle = useCallback(() => {
    setEnabled((current) => {
      const next = !current
      try {
        window.localStorage.setItem(gameConfig.audio.storageKey, String(next))
      } catch {
        // The preference remains active for this session if storage is unavailable.
      }
      if (next) play('enable', true)
      return next
    })
  }, [play])

  return { enabled, play, toggle }
}
