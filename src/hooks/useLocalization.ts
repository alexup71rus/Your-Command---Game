import { useCallback, useEffect, useRef, useState } from 'react'
import {
  defaultLocale,
  isLocale,
  loadLocale,
  localeStorageKey,
  type Locale,
  type LocaleDictionary,
} from '../config/localization'

function readInitialLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(localeStorageKey)
    if (isLocale(saved)) return saved
  } catch {
    // Use browser preference when storage is unavailable.
  }
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : defaultLocale
}

export function useLocalization() {
  const [requestedLocale, setRequestedLocale] = useState<Locale>(readInitialLocale)
  const [loaded, setLoaded] = useState<LoadedLocale | null>(null)
  const loadedRef = useRef<LoadedLocale | null>(null)
  const [status, setStatus] = useState<LocalizationStatus>('loading')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let active = true
    void loadLocaleWithFallback(requestedLocale, loadedRef.current).then((result) => {
      if (!active) return
      loadedRef.current = result
      setLoaded(result)
      setStatus(result.usedFallback ? 'error' : 'ready')
    }).catch(() => { if (active) setStatus('error') })
    return () => { active = false }
  }, [requestedLocale, retryKey])

  useEffect(() => {
    document.documentElement.lang = loaded?.locale ?? requestedLocale
  }, [loaded?.locale, requestedLocale])

  const setLocale = useCallback((nextLocale: Locale) => {
    try {
      window.localStorage.setItem(localeStorageKey, nextLocale)
    } catch {
      // Keep the language for this session if storage is unavailable.
    }
    setStatus('loading')
    setRequestedLocale(nextLocale)
    setRetryKey((current) => current + 1)
  }, [])

  const retry = useCallback(() => {
    setStatus('loading')
    setRetryKey((current) => current + 1)
  }, [])

  return { locale: loaded?.locale ?? requestedLocale, setLocale, text: loaded?.dictionary ?? null, status, retry, resolvedLocale: loaded?.locale ?? null }
}

export type LocalizationStatus = 'loading' | 'ready' | 'error'

export interface LoadedLocale {
  dictionary: LocaleDictionary
  locale: Locale
  usedFallback: boolean
}

export async function loadLocaleWithFallback(
  locale: Locale,
  previous: LoadedLocale | null,
  loader: typeof loadLocale = loadLocale,
): Promise<LoadedLocale> {
  try {
    return { dictionary: await loader(locale), locale, usedFallback: false }
  } catch {
    if (previous) return { ...previous, usedFallback: true }
    if (locale !== defaultLocale) {
      return { dictionary: await loader(defaultLocale), locale: defaultLocale, usedFallback: true }
    }
    throw new Error(`Unable to load locale: ${locale}`)
  }
}
