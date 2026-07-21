import { useState } from 'react'
import type { Locale, LocaleDictionary } from '../config/localization'
import type { SavedGameSummary } from '../game/savedGames'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { ModalCloseButton } from './ui/ModalCloseButton'
import { useModalFocus } from '../hooks/useModalFocus'

interface SavedGamesModalProps {
  locale: Locale
  text: LocaleDictionary
  saves: SavedGameSummary[]
  showSaveAction: boolean
  canSave: boolean
  busy: boolean
  feedback: string | null
  onClose: () => void
  onSave: () => void
  onLoad: (id: string) => void
  onDelete: (id: string) => void
}

export function SavedGamesModal({ locale, text, saves, showSaveAction, canSave, busy, feedback, onClose, onSave, onLoad, onDelete }: SavedGamesModalProps) {
  const [pendingDelete, setPendingDelete] = useState<SavedGameSummary | null>(null)
  const modalRef = useModalFocus<HTMLElement>()
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div className="settings-backdrop" onPointerDown={onClose}>
      <section ref={modalRef} tabIndex={-1} className="settings-modal saved-games-modal" role="dialog" aria-modal="true" aria-labelledby="saved-games-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div><span className="settings-kicker">{text.savedGames.kicker}</span><h2 id="saved-games-title">{text.savedGames.title}</h2></div>
          <ModalCloseButton label={text.savedGames.close} onClick={onClose} data-modal-autofocus={!showSaveAction && saves.length === 0 ? true : undefined} />
        </header>
        <div className="saved-games-content" aria-busy={busy}>
          {showSaveAction && <section className="save-current-panel">
            <div><h3>{text.savedGames.saveCurrent}</h3><p>{canSave ? text.savedGames.saveCurrentDescription : text.savedGames.saveUnavailable}</p></div>
            <button type="button" className="save-current-game" disabled={busy || !canSave} onClick={onSave} data-modal-autofocus={canSave ? true : undefined}><span aria-hidden="true">＋</span>{text.savedGames.save}</button>
          </section>}
          <section className="saved-slots-section" aria-labelledby="saved-slots-title">
            <header className="saved-slots-heading"><div><h3 id="saved-slots-title">{text.savedGames.loadSection}</h3><p>{text.savedGames.loadSectionDescription}</p></div><span aria-label={`${text.savedGames.slots}: ${saves.length}`}>{saves.length}</span></header>
            {feedback && <p className="saved-game-feedback" role="status">{feedback}</p>}
            {saves.length === 0 ? <p className="saved-games-empty">{text.savedGames.empty}</p> : (
              <div className="saved-game-list">
              {saves.map((save, index) => <article className="saved-game-row" key={save.id}>
                <div className="saved-game-copy"><div><strong>{save.mapName}</strong>{index === 0 && <small>{text.savedGames.latest}</small>}</div><span>{text.savedGames.turn} {save.turn} · {text.savedGames.updated} {formatter.format(save.updatedAt)}</span></div>
                <button type="button" className="saved-game-load" disabled={busy} onClick={() => onLoad(save.id)} data-modal-autofocus={!showSaveAction && index === 0 ? true : undefined}>{text.savedGames.load}</button>
                <button type="button" className="saved-game-delete danger" disabled={busy} onClick={() => setPendingDelete(save)} aria-label={`${text.savedGames.remove}: ${save.name}`}>×</button>
              </article>)}
              </div>
            )}
          </section>
        </div>
      </section>
      {pendingDelete && <ConfirmDialog title={text.savedGames.deleteTitle} description={text.savedGames.deleteDescription} cancelLabel={text.confirmation.cancel} confirmLabel={text.savedGames.remove} onCancel={() => setPendingDelete(null)} onConfirm={() => { onDelete(pendingDelete.id); setPendingDelete(null) }} />}
    </div>
  )
}
