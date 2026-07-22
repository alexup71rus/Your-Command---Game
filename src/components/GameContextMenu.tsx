import type { LocaleDictionary } from '../config/localization'
import type { MapObject } from '../game/map'
import { squadSize } from '../game/match'
import type { CellPosition } from '../game/scenario'
import type { MapContextRequest } from './GridCanvas'

export interface GameContextMenuState extends MapContextRequest {
  left: number
  top: number
}

interface GameContextMenuProps {
  state: GameContextMenuState
  object: MapObject | null
  owned: boolean
  canOfferAutoMove: boolean
  hasObjectAction: boolean
  refundText: string | null
  text: LocaleDictionary
  onClose: () => void
  onStartAutoMove: () => void
  onStartSplit: (position: CellPosition) => void
  onStartMerge: (position: CellPosition) => void
  onRemoveObject: () => void
}

export function GameContextMenu({
  state,
  object,
  owned,
  canOfferAutoMove,
  hasObjectAction,
  refundText,
  text,
  onClose,
  onStartAutoMove,
  onStartSplit,
  onStartMerge,
  onRemoveObject,
}: GameContextMenuProps) {
  return (
    <div className="context-backdrop" onPointerDown={onClose} role="presentation">
      <section
        className="context-menu"
        style={{ left: state.left, top: state.top }}
        role="menu"
        aria-label={text.contextMenu.title}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="context-menu-heading">
          <span>{text.contextMenu.title}</span>
          <small>
            {text.contextMenu.cell} {state.column + 1}:{state.row + 1}
          </small>
        </div>
        {canOfferAutoMove && (
          <button type="button" role="menuitem" onClick={onStartAutoMove}>
            {text.contextMenu.goHere}
          </button>
        )}
        {object?.type === 'squad' && owned && squadSize(object) > 1 && (
          <button type="button" role="menuitem" onClick={() => onStartSplit(state)}>
            {text.contextMenu.splitSquad}
          </button>
        )}
        {object?.type === 'squad' && owned && (
          <button type="button" role="menuitem" onClick={() => onStartMerge(state)}>
            {text.contextMenu.mergeSquads}
          </button>
        )}
        {object?.type === 'squad' && owned && (
          <button type="button" role="menuitem" className="danger" onClick={onRemoveObject}>
            {text.contextMenu.dismissSquad}
          </button>
        )}
        {object?.type === 'building' && owned && (
          <div className="context-demolition">
            <button type="button" role="menuitem" className="danger" onClick={onRemoveObject}>
              {text.contextMenu.removeObject}
            </button>
            <small>{refundText}</small>
          </div>
        )}
        {!canOfferAutoMove && !hasObjectAction && <p className="context-menu-empty">{text.game.selectCell}</p>}
      </section>
    </div>
  )
}
