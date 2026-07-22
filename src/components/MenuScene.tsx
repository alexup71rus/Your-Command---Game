import type { ComponentProps, PointerEventHandler, ReactNode } from 'react'
import type { LocaleDictionary } from '../config/localization'
import { ClickEffects, type ClickBurst } from './ClickEffects'
import { MainMenu } from './MainMenu'
import { StartMenu } from './StartMenu'

export type MenuPage = 'welcome' | 'modes' | 'battle-setup'

interface MenuSceneProps {
  page: MenuPage
  text: LocaleDictionary['mainMenu']
  utilityControls: ReactNode
  battleSetup: ComponentProps<typeof StartMenu>
  bursts: ClickBurst[]
  overlays: ReactNode
  onContinue: () => void
  onBack: () => void
  onSelectBattle: () => void
  onPointerDown: PointerEventHandler<HTMLDivElement>
  onPointerOver: PointerEventHandler<HTMLDivElement>
}

export function MenuScene({
  page,
  text,
  utilityControls,
  battleSetup,
  bursts,
  overlays,
  onContinue,
  onBack,
  onSelectBattle,
  onPointerDown,
  onPointerOver,
}: MenuSceneProps) {
  return (
    <div className="start-shell" onPointerDownCapture={onPointerDown} onPointerOverCapture={onPointerOver}>
      {page === 'battle-setup' ? (
        <StartMenu {...battleSetup} />
      ) : (
        <MainMenu
          screen={page}
          text={text}
          utilityControls={utilityControls}
          onContinue={onContinue}
          onBack={onBack}
          onSelectBattle={onSelectBattle}
        />
      )}
      <ClickEffects bursts={bursts} />
      {overlays}
    </div>
  )
}
