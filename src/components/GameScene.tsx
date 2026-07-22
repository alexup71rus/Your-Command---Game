import type { ComponentProps, PointerEventHandler, ReactNode } from 'react'
import { ClickEffects, type ClickBurst } from './ClickEffects'
import { FoundingPanel } from './FoundingPanel'
import { GameCommandDock } from './GameCommandDock'
import { GameContextMenu } from './GameContextMenu'
import { GameHud } from './GameHud'
import { GameOutcomeModal } from './GameOutcomeModal'
import { GridCanvas } from './GridCanvas'
import { MapOwnerHint } from './MapOwnerHint'

interface GameSceneProps {
  className: string
  map: ComponentProps<typeof GridCanvas>
  bursts: ClickBurst[]
  hud?: ComponentProps<typeof GameHud>
  commandDock?: ComponentProps<typeof GameCommandDock>
  ownerHint?: ComponentProps<typeof MapOwnerHint>
  navigationHint?: string
  founding?: ComponentProps<typeof FoundingPanel>
  contextMenu?: ComponentProps<typeof GameContextMenu>
  outcome?: ComponentProps<typeof GameOutcomeModal>
  utilityControls: ReactNode
  overlays: ReactNode
  onPointerDown: PointerEventHandler<HTMLElement>
  onPointerOver: PointerEventHandler<HTMLElement>
}

export function GameScene({
  className,
  map,
  bursts,
  hud,
  commandDock,
  ownerHint,
  navigationHint,
  founding,
  contextMenu,
  outcome,
  utilityControls,
  overlays,
  onPointerDown,
  onPointerOver,
}: GameSceneProps) {
  return (
    <main className={className} onPointerDownCapture={onPointerDown} onPointerOverCapture={onPointerOver}>
      <GridCanvas {...map} />
      <ClickEffects bursts={bursts} />
      {hud && (
        <>
          <GameHud {...hud} />
          {commandDock && <GameCommandDock {...commandDock} />}
          {ownerHint ? (
            <MapOwnerHint {...ownerHint} />
          ) : (
            navigationHint && (
              <div className="map-hint" aria-live="polite">
                <span className="mouse-symbol" />
                {navigationHint}
              </div>
            )
          )}
        </>
      )}
      {founding && <FoundingPanel {...founding} />}
      {utilityControls}
      {contextMenu && <GameContextMenu {...contextMenu} />}
      {outcome && <GameOutcomeModal {...outcome} />}
      {overlays}
    </main>
  )
}
