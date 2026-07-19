import type { LocaleDictionary } from '../config/localization'
import { useModalFocus } from '../hooks/useModalFocus'

export function GameOutcomeModal({ text, onContinue }: { text: LocaleDictionary['game']; onContinue: () => void }) {
  const modalRef = useModalFocus<HTMLElement>()
  return <div className="outcome-backdrop"><section ref={modalRef} tabIndex={-1} className="outcome-modal" role="dialog" aria-modal="true" aria-labelledby="outcome-title"><span className="outcome-mark" aria-hidden="true">✦</span><h2 id="outcome-title">{text.victoryTitle}</h2><p>{text.victoryDescription}</p><button type="button" onClick={onContinue} data-modal-autofocus>{text.continue}</button></section></div>
}
