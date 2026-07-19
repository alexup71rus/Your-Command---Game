import { useState } from 'react'
import { supportedLocales, type Locale, type LocaleDictionary } from '../config/localization'
import { CloseIcon, SoundIcon } from './InterfaceIcons'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { useModalFocus } from '../hooks/useModalFocus'

interface SettingsModalProps {
  locale: Locale
  text: LocaleDictionary
  soundEnabled: boolean
  volume: number
  onClose: () => void
  onLocaleChange: (locale: Locale) => void
  onSoundToggle: () => void
  onVolumeChange: (volume: number) => void
  onReturnToMenu?: () => void
  onOpenSavedGames?: () => void
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
  onReturnToMenu,
  onOpenSavedGames,
}: SettingsModalProps) {
  const [confirmingExit, setConfirmingExit] = useState(false)
  const modalRef = useModalFocus<HTMLElement>()
  return (
    <div className="settings-backdrop" onPointerDown={onClose}>
      <section
        ref={modalRef}
        tabIndex={-1}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div><span className="settings-kicker">ESC</span><h2 id="settings-title">{text.settings.title}</h2></div>
          <button type="button" className="settings-close" onClick={onClose} aria-label={text.settings.close} data-modal-autofocus><CloseIcon /></button>
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

          {onReturnToMenu && onOpenSavedGames && (
            <section className="settings-card settings-save-card">
              <div className="settings-card-copy"><h3>{text.settings.saveGame}</h3><p>{text.settings.saveGameDescription}</p></div>
              <button type="button" className="settings-save-button" onClick={onOpenSavedGames}>{text.settings.saveGame}</button>
            </section>
          )}

          {onReturnToMenu && (
            <section className="settings-card settings-main-menu-card">
              <div className="settings-card-copy"><h3>{text.settings.mainMenu}</h3><p>{text.settings.mainMenuDescription}</p></div>
              <button type="button" className="settings-main-menu-button danger" onClick={() => setConfirmingExit(true)}>{text.settings.mainMenu}</button>
            </section>
          )}
        </div>
      </section>
      {confirmingExit && onReturnToMenu && <ConfirmDialog title={text.confirmation.leaveTitle} description={text.confirmation.leaveDescription} cancelLabel={text.confirmation.cancel} confirmLabel={text.confirmation.leaveAction} onCancel={() => setConfirmingExit(false)} onConfirm={onReturnToMenu} />}
    </div>
  )
}
