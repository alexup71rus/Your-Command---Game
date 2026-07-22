import type { ComponentProps } from 'react'
import { MapGeneratorModal } from './MapGeneratorModal'
import { SavedGamesModal } from './SavedGamesModal'
import { SettingsModal } from './SettingsModal'
import { ConfirmDialog } from './ui/ConfirmDialog'

interface AppOverlaysProps {
  generator?: ComponentProps<typeof MapGeneratorModal>
  settings?: ComponentProps<typeof SettingsModal>
  savedGames?: ComponentProps<typeof SavedGamesModal>
  loadConfirmation?: ComponentProps<typeof ConfirmDialog>
}

export function AppOverlays({ generator, settings, savedGames, loadConfirmation }: AppOverlaysProps) {
  return (
    <>
      {generator && <MapGeneratorModal {...generator} />}
      {settings && <SettingsModal {...settings} />}
      {savedGames && <SavedGamesModal {...savedGames} />}
      {loadConfirmation && <ConfirmDialog {...loadConfirmation} />}
    </>
  )
}
