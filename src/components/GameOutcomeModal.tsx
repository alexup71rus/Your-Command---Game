import type { LocaleDictionary } from '../config/localization'
import { useModalFocus } from '../hooks/useModalFocus'

export function GameOutcomeModal({ text, outcome, spectatorWinner, onContinue }: { text: LocaleDictionary['game']; outcome: 'won' | 'lost'; spectatorWinner?: string; onContinue: () => void }) {
  const modalRef = useModalFocus<HTMLElement>()
  const title = spectatorWinner ? text.spectatorVictoryTitle : outcome === 'won' ? text.victoryTitle : text.defeatTitle
  const description = spectatorWinner ? text.spectatorVictoryDescription.replace('{winner}', spectatorWinner) : outcome === 'won' ? text.victoryDescription : text.defeatDescription
  return <div className="outcome-backdrop"><section ref={modalRef} tabIndex={-1} className={`outcome-modal ${outcome}`} role="dialog" aria-modal="true" aria-labelledby="outcome-title"><span className="outcome-mark" aria-hidden="true">{outcome === 'won' ? '✦' : '◇'}</span><h2 id="outcome-title">{title}</h2><p>{description}</p><button type="button" onClick={onContinue} data-modal-autofocus>{text.continue}</button></section></div>
}
