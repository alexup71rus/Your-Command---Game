import type { LocaleDictionary } from '../config/localization'
import { UtilityControls } from './UtilityControls'

interface LocalizationFallbackProps {
  failed: boolean
  onRetry: () => void
}

export function LocalizationFallback({ failed, onRetry }: LocalizationFallbackProps) {
  if (!failed) return <main className="game-shell loading-shell" aria-busy="true" />
  return (
    <main className="game-shell localization-error" role="alert">
      <section>
        <h1>Не удалось загрузить интерфейс</h1>
        <p>Проверьте файлы приложения и попробуйте ещё раз.</p>
        <button type="button" onClick={onRetry}>
          Повторить
        </button>
      </section>
    </main>
  )
}

interface AppUtilityControlsProps {
  text: LocaleDictionary
  soundEnabled: boolean
  onOpenSettings: () => void
  onToggleSound: () => void
}

export function AppUtilityControls({ text, soundEnabled, onOpenSettings, onToggleSound }: AppUtilityControlsProps) {
  return (
    <UtilityControls
      settingsLabel={text.settings.title}
      settingsHint={text.interface.settingsHint}
      soundEnabled={soundEnabled}
      soundEnableLabel={text.sound.enable}
      soundDisableLabel={text.sound.disable}
      onOpenSettings={onOpenSettings}
      onToggleSound={onToggleSound}
    />
  )
}
