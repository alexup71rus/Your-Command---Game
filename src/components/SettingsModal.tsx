import { useState, type CSSProperties } from 'react'
import { supportedLocales, type Locale, type LocaleDictionary } from '../config/localization'
import { SoundIcon } from './InterfaceIcons'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { ModalCloseButton } from './ui/ModalCloseButton'
import { useModalFocus } from '../hooks/useModalFocus'

interface SettingsModalProps {
  locale: Locale
  text: LocaleDictionary
  soundEnabled: boolean
  volume: number
  musicVolume: number
  showGrid: boolean
  autoCamera: boolean
  onClose: () => void
  onLocaleChange: (locale: Locale) => void
  onSoundToggle: () => void
  onVolumeChange: (volume: number) => void
  onEffectsPreview: () => void
  onMusicVolumeChange: (volume: number) => void
  onShowGridChange: (visible: boolean) => void
  onAutoCameraChange: (enabled: boolean) => void
  onReturnToMenu?: () => void
  onOpenSavedGames?: () => void
}

const localeNames: Record<Locale, string> = {
  ru: 'Русский',
  en: 'English',
}

const rangeStyle = (value: number) => ({ '--settings-fill': `${value}%` }) as CSSProperties

export function SettingsModal({
  locale,
  text,
  soundEnabled,
  volume,
  musicVolume,
  showGrid,
  autoCamera,
  onClose,
  onLocaleChange,
  onSoundToggle,
  onVolumeChange,
  onEffectsPreview,
  onMusicVolumeChange,
  onShowGridChange,
  onAutoCameraChange,
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
        className={`settings-modal${onReturnToMenu ? ' in-game' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div><span className="settings-kicker">ESC</span><h2 id="settings-title">{text.settings.title}</h2></div>
          <ModalCloseButton label={text.settings.close} onClick={onClose} data-modal-autofocus />
        </header>

        <div className="settings-content">
          <div className="settings-columns">
            <section className="settings-section settings-audio-section" aria-labelledby="settings-audio-title">
              <header className="settings-section-header">
                <div>
                  <h3 id="settings-audio-title">{text.sound.title}</h3>
                  <p>{text.sound.description}</p>
                </div>
                <button
                  type="button"
                  className={`settings-sound-toggle${soundEnabled ? ' active' : ''}`}
                  onClick={onSoundToggle}
                  aria-label={soundEnabled ? text.sound.disable : text.sound.enable}
                  aria-pressed={soundEnabled}
                >
                  <SoundIcon muted={!soundEnabled} />
                  {soundEnabled ? text.sound.enabled : text.sound.disabled}
                </button>
              </header>

              <div className="settings-mixer">
                <label className="settings-volume-row">
                  <span>{text.sound.effectsTitle}</span>
                  <output>{volume}%</output>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={volume}
                    style={rangeStyle(volume)}
                    aria-label={text.sound.effectsVolume}
                    onChange={(event) => onVolumeChange(Number(event.target.value))}
                    onPointerUp={onEffectsPreview}
                    onKeyUp={onEffectsPreview}
                  />
                </label>
                <label className="settings-volume-row">
                  <span>{text.sound.musicTitle}</span>
                  <output>{musicVolume}%</output>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={musicVolume}
                    style={rangeStyle(musicVolume)}
                    aria-label={text.sound.musicVolume}
                    onChange={(event) => onMusicVolumeChange(Number(event.target.value))}
                  />
                </label>
              </div>
            </section>

            <section className="settings-section settings-gameplay-section" aria-labelledby="settings-gameplay-title">
              <header className="settings-section-header">
                <div><h3 id="settings-gameplay-title">{text.settings.gameplayTitle}</h3></div>
              </header>
              <div className="settings-control-list">
                <div className="settings-control-row">
                  <div className="settings-control-copy"><strong>{text.settings.language}</strong><small>{text.settings.languageDescription}</small></div>
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
                </div>

                <div className="settings-control-row">
                  <div className="settings-control-copy"><strong>{text.settings.grid}</strong><small>{text.settings.gridDescription}</small></div>
                  <button
                    type="button"
                    className={`settings-grid-toggle${showGrid ? ' active' : ''}`}
                    aria-pressed={showGrid}
                    onClick={() => onShowGridChange(!showGrid)}
                  >
                    <span className="grid-toggle-icon" aria-hidden="true" />
                    {showGrid ? text.settings.gridEnabled : text.settings.gridDisabled}
                  </button>
                </div>

                <div className="settings-control-row">
                  <div className="settings-control-copy"><strong>{text.settings.autoCamera}</strong><small>{text.settings.autoCameraDescription}</small></div>
                  <button
                    type="button"
                    className={`settings-camera-toggle${autoCamera ? ' active' : ''}`}
                    aria-pressed={autoCamera}
                    onClick={() => onAutoCameraChange(!autoCamera)}
                  >
                    <span className="camera-toggle-icon" aria-hidden="true" />
                    {autoCamera ? text.settings.autoCameraEnabled : text.settings.autoCameraDisabled}
                  </button>
                </div>
              </div>
            </section>
          </div>

          {onReturnToMenu && (
            <footer className="settings-session-bar">
              <strong>{text.settings.sessionTitle}</strong>
              <div>
                {onOpenSavedGames && <button type="button" className="settings-save-button" title={text.settings.saveGameDescription} onClick={onOpenSavedGames}>{text.settings.saveGame}</button>}
                <button type="button" className="settings-main-menu-button danger" title={text.settings.mainMenuDescription} onClick={() => setConfirmingExit(true)}>{text.settings.mainMenu}</button>
              </div>
            </footer>
          )}
        </div>
      </section>
      {confirmingExit && onReturnToMenu && <ConfirmDialog title={text.confirmation.leaveTitle} description={text.confirmation.leaveDescription} cancelLabel={text.confirmation.cancel} confirmLabel={text.confirmation.leaveAction} onCancel={() => setConfirmingExit(false)} onConfirm={onReturnToMenu} />}
    </div>
  )
}
