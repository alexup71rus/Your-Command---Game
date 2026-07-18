import { describe, expect, it } from 'vitest'
import { loadLocale } from './localization'

describe('lazy locale loading', () => {
  it('loads locale modules independently', async () => {
    const ru = await loadLocale('ru')
    const en = await loadLocale('en')

    expect(ru.settings.title).toBe('Настройки')
    expect(en.settings.title).toBe('Settings')
    expect(ru.tabs.map((tab) => tab.id)).toEqual(en.tabs.map((tab) => tab.id))
  })
})
