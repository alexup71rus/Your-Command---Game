import { describe, expect, it, vi } from 'vitest'
import type { LocaleDictionary } from '../config/localization'
import { loadLocaleWithFallback, type LoadedLocale } from './useLocalization'

const dictionary = (localeName: string) => ({ localeName }) as LocaleDictionary

describe('loadLocaleWithFallback', () => {
  it('loads the requested locale without marking a fallback', async () => {
    const loader = vi.fn(async (locale: 'ru' | 'en') => dictionary(locale))
    await expect(loadLocaleWithFallback('en', null, loader)).resolves.toEqual({
      dictionary: { localeName: 'en' }, locale: 'en', usedFallback: false,
    })
  })

  it('keeps the previous dictionary when a locale chunk fails', async () => {
    const previous: LoadedLocale = { dictionary: dictionary('Русский'), locale: 'ru', usedFallback: false }
    const loader = vi.fn(async () => { throw new Error('chunk failed') })
    await expect(loadLocaleWithFallback('en', previous, loader)).resolves.toEqual({ ...previous, usedFallback: true })
  })

  it('falls back to Russian when the first locale cannot be loaded', async () => {
    const loader = vi.fn(async (locale: 'ru' | 'en') => {
      if (locale === 'en') throw new Error('chunk failed')
      return dictionary('Русский')
    })
    await expect(loadLocaleWithFallback('en', null, loader)).resolves.toEqual({
      dictionary: { localeName: 'Русский' }, locale: 'ru', usedFallback: true,
    })
  })
})
