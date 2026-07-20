import type { LocaleDictionary } from '../config/localization'
import { useModalFocus } from '../hooks/useModalFocus'

export function GameOutcomeModal({ text, outcome, onContinue }: { text: LocaleDictionary['game']; outcome: 'won' | 'lost'; onContinue: () => void }) {
  const modalRef = useModalFocus<HTMLElement>()
  return <div className="outcome-backdrop"><section ref={modalRef} tabIndex={-1} className={`outcome-modal ${outcome}`} role="dialog" aria-modal="true" aria-labelledby="outcome-title"><span className="outcome-mark" aria-hidden="true">{outcome === 'won' ? '✦' : '◇'}</span><h2 id="outcome-title">{outcome === 'won' ? text.victoryTitle : text.defeatTitle}</h2><p>{outcome === 'won' ? text.victoryDescription : text.defeatDescription}</p><button type="button" onClick={onContinue} data-modal-autofocus>{text.continue}</button></section></div>
}
