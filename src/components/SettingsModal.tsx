import { supportedLocales, type Locale, type LocaleDictionary } from '../config/localization'
import { CloseIcon, SoundIcon } from './InterfaceIcons'

interface SettingsModalProps {
  locale: Locale
  text: LocaleDictionary
  soundEnabled: boolean
  volume: number
  onClose: () => void
  onLocaleChange: (locale: Locale) => void
  onSoundToggle: () => void
  onVolumeChange: (volume: number) => void
}

const localeNames: Record<Locale, string> = {
  ru: 'Русский',
  en: 'English',
}

export function SettingsModal({
  locale,
  text,
  soundEnabled,
  volume,
  onClose,
  onLocaleChange,
  onSoundToggle,
  onVolumeChange,
}: SettingsModalProps) {
  return (
    <div className="settings-backdrop" onPointerDown={onClose}>
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div><span className="settings-kicker">ESC</span><h2 id="settings-title">{text.settings.title}</h2></div>
          <button type="button" className="settings-close" onClick={onClose} aria-label={text.settings.close}><CloseIcon /></button>
        </header>

        <div className="settings-content">
          <section className="settings-card">
            <div className="settings-card-copy">
              <h3>{text.settings.language}</h3>
              <p>{text.settings.languageDescription}</p>
            </div>
            <div className="language-options" role="group" aria-label={text.settings.language}>
              {supportedLocales.map((availableLocale) => (
                <button
                  type="button"
                  key={availableLocale}
                  className={locale === availableLocale ? 'active' : ''}
                  aria-pressed={locale === availableLocale}
                  onClick={() => onLocaleChange(availableLocale)}
                >
                  {localeNames[availableLocale]}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-card sound-settings-card">
            <div className="settings-card-copy">
              <h3>{text.sound.title}</h3>
              <p>{text.sound.description}</p>
            </div>
            <div className="volume-control">
              <button
                type="button"
                className="settings-sound-toggle"
                onClick={onSoundToggle}
                aria-label={soundEnabled ? text.sound.disable : text.sound.enable}
                aria-pressed={soundEnabled}
              >
                <SoundIcon muted={!soundEnabled} />
                {soundEnabled ? text.sound.enabled : text.sound.disabled}
              </button>
              <label>
                <span>{volume}%</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={volume}
                  aria-label={text.sound.title}
                  onChange={(event) => onVolumeChange(Number(event.target.value))}
                />
              </label>
            </div>
          </section>
        </div>
      </section>
    </div>
  )
}
