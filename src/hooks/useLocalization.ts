import { useCallback, useEffect, useState } from 'react'
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
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale)
  const [text, setText] = useState<LocaleDictionary | null>(null)

  useEffect(() => {
    let active = true
    void loadLocale(locale).then((dictionary) => {
      if (active) setText(dictionary)
    })
    return () => { active = false }
  }, [locale])

  const setLocale = useCallback((nextLocale: Locale) => {
    try {
      window.localStorage.setItem(localeStorageKey, nextLocale)
    } catch {
      // Keep the language for this session if storage is unavailable.
    }
    setLocaleState(nextLocale)
  }, [])

  return { locale, setLocale, text }
}
