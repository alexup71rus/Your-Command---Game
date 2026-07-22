import { describe, expect, it } from 'vitest'
import { buildingKinds, troopKinds } from './rules'
import { aiParticipantDisplayName, aiProfileDisplayName, loadLocale } from './localization'
import type { MatchParticipant } from '../game/scenario'

describe('lazy locale loading', () => {
  it('loads locale modules independently', async () => {
    const ru = await loadLocale('ru')
    const en = await loadLocale('en')

    expect(ru.settings.title).toBe('Настройки')
    expect(en.settings.title).toBe('Settings')
    expect(ru.tabs.map((tab) => tab.id)).toEqual(en.tabs.map((tab) => tab.id))
    buildingKinds.forEach((kind) => {
      expect(ru.game.buildingNames[kind]).not.toHaveLength(0)
      expect(ru.game.buildingDescriptions[kind]).not.toHaveLength(0)
      expect(en.game.buildingNames[kind]).not.toHaveLength(0)
      expect(en.game.buildingDescriptions[kind]).not.toHaveLength(0)
    })
    troopKinds.forEach((kind) => {
      expect(ru.game.troopNames[kind]).not.toHaveLength(0)
      expect(ru.game.troopDescriptions[kind]).not.toHaveLength(0)
      expect(en.game.troopNames[kind]).not.toHaveLength(0)
      expect(en.game.troopDescriptions[kind]).not.toHaveLength(0)
    })
    expect(JSON.stringify(ru)).not.toContain('undefined')
    expect(JSON.stringify(en)).not.toContain('undefined')
  })

  it('adds distinct localized epithets only to seated AI rulers', async () => {
    const ru = await loadLocale('ru')
    const participants: MatchParticipant[] = [
      { id: 'ai-radomir-1', kind: 'ai', profileId: 'radomir', regionId: 'region-0', color: '#aaa' },
      { id: 'ai-radomir-2', kind: 'ai', profileId: 'radomir', regionId: 'region-1', color: '#bbb' },
    ]
    expect(ru.opponents.profiles.radomir.name).toBe('Радомир')
    expect(aiProfileDisplayName(ru.opponents, 'radomir', 0)).toBe('Радомир Рассудительный')
    expect(aiParticipantDisplayName(ru.opponents, participants, 'ai-radomir-2')).toBe('Радомир Мудрый')
  })
})
