import { SoundIcon } from './InterfaceIcons'

interface UtilityControlsProps {
  settingsLabel: string
  settingsHint: string
  soundEnabled: boolean
  soundEnableLabel: string
  soundDisableLabel: string
  onOpenSettings: () => void
  onToggleSound: () => void
}

export function UtilityControls({ settingsLabel, settingsHint, soundEnabled, soundEnableLabel, soundDisableLabel, onOpenSettings, onToggleSound }: UtilityControlsProps) {
  const soundLabel = soundEnabled ? soundDisableLabel : soundEnableLabel
  return (
    <div className="map-tools">
      <button type="button" className="menu-toggle" onClick={onOpenSettings} aria-label={settingsLabel}><kbd>Esc</kbd><span>{settingsHint}</span></button>
      <button type="button" className="sound-toggle" aria-label={soundLabel} title={soundLabel} aria-pressed={soundEnabled} onClick={onToggleSound}><SoundIcon muted={!soundEnabled} /></button>
    </div>
  )
}
