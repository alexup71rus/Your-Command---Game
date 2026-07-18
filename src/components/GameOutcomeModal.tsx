import type { LocaleDictionary } from '../config/localization'

export function GameOutcomeModal({ text, onContinue }: { text: LocaleDictionary['game']; onContinue: () => void }) {
  return <div className="outcome-backdrop"><section className="outcome-modal" role="dialog" aria-modal="true" aria-labelledby="outcome-title"><span className="outcome-mark" aria-hidden="true">✦</span><h2 id="outcome-title">{text.victoryTitle}</h2><p>{text.victoryDescription}</p><button type="button" onClick={onContinue}>{text.continue}</button></section></div>
}
